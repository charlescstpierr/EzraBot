/*
 * ezrabot-guardian: the single owner of the EzraBot server's life as an operating-system process tree.
 *
 * It holds a private lock, starts one runtime, and becomes a Linux child subreaper, so every
 * descendant that loses its parent, even after setsid or a double fork, is reparented here. On a stop
 * request, an end of its control input, a signal, or the runtime's own exit, it terminates the runtime,
 * then every remaining descendant, and waits until it has no child left. Only then does it write a
 * clean receipt. It never reads what the runtime does: no URL, no budget, no work.
 *
 * Usage: ezrabot-guardian --lock FILE --receipt FILE
 *                         [--coop-ms N] [--term-ms N] [--kill-ms N] -- RUNTIME [ARG...]
 *
 * Files the tree creates are private: the umask is 077.
 * Descriptors: 0 control lines ("stop"), 1 event lines (JSON), 2 log, 3 passed to the runtime as is.
 * Exit codes: 0 clean, 2 unconfirmed, 64 usage, 70 internal, 75 lock busy, 76 previous stop unconfirmed.
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/prctl.h>
#include <sys/signalfd.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define MAX_OWNED 4096
#define START_LEN 24

typedef struct { pid_t pid; char start[START_LEN]; } identity;

static identity owned[MAX_OWNED];
static size_t owned_count;
static int owned_overflow;
static const char *receipt_path;
static identity self;

static long long now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static void emit(const char *format, ...) {
  char line[1024];
  va_list args;
  va_start(args, format);
  int n = vsnprintf(line, sizeof line - 1, format, args);
  va_end(args);
  if (n < 0) return;
  if ((size_t)n > sizeof line - 2) n = sizeof line - 2;
  line[n++] = '\n';
  for (int off = 0; off < n;) {
    ssize_t w = write(1, line + off, (size_t)(n - off));
    if (w < 0 && errno == EINTR) continue;
    if (w <= 0) return;
    off += (int)w;
  }
}

/* Field 22 of /proc/PID/stat, with the parent PID and state. Returns 0 when the entry was read. */
static int read_stat(pid_t pid, pid_t *ppid, char *state, char start[START_LEN]) {
  char path[64], buf[2048];
  snprintf(path, sizeof path, "/proc/%d/stat", (int)pid);
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  ssize_t n = read(fd, buf, sizeof buf - 1);
  close(fd);
  if (n <= 0) return -1;
  buf[n] = 0;
  char *p = strrchr(buf, ')');
  if (!p || p[1] != ' ') return -1;
  p += 2;
  char *fields[20];
  int count = 0;
  for (char *tok = strtok(p, " "); tok && count < 20; tok = strtok(NULL, " ")) fields[count++] = tok;
  if (count < 20) return -1;
  if (state) *state = fields[0][0];
  if (ppid) *ppid = (pid_t)strtol(fields[1], NULL, 10);
  if (start) {
    if (strlen(fields[19]) >= START_LEN) return -1;
    strcpy(start, fields[19]);
  }
  return 0;
}

static int write_all(int fd, const char *data, size_t len) {
  while (len) {
    ssize_t w = write(fd, data, len);
    if (w < 0 && errno == EINTR) continue;
    if (w <= 0) return -1;
    data += w;
    len -= (size_t)w;
  }
  return 0;
}

/* The receipt is replaced atomically, so a reader sees either the previous or the new one, never a mix. */
static int write_receipt(const char *state) {
  char tmp[PATH_MAX], text[64];
  if (snprintf(tmp, sizeof tmp, "%s.tmp", receipt_path) >= (int)sizeof tmp) return -1;
  int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) return -1;
  int bad = 0;
  snprintf(text, sizeof text, "ezrabot-guardian-receipt 1\nstate %s\n", state);
  bad |= write_all(fd, text, strlen(text));
  snprintf(text, sizeof text, "guardian %d %s\n", (int)self.pid, self.start);
  bad |= write_all(fd, text, strlen(text));
  for (size_t i = 0; i < owned_count && !bad; i++) {
    snprintf(text, sizeof text, "owned %d %s\n", (int)owned[i].pid, owned[i].start);
    bad |= write_all(fd, text, strlen(text));
  }
  if (owned_overflow) bad |= write_all(fd, "overflow\n", 9);
  bad |= fsync(fd);
  bad |= close(fd);
  if (bad || rename(tmp, receipt_path) != 0) return -1;
  char dir[PATH_MAX];
  snprintf(dir, sizeof dir, "%s", receipt_path);
  char *slash = strrchr(dir, '/');
  if (slash) {
    if (slash == dir) slash[1] = 0; else *slash = 0;
    int dfd = open(dir, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (dfd >= 0) { fsync(dfd); close(dfd); }
  }
  return 0;
}

static int is_owned(pid_t pid, const char *start) {
  for (size_t i = 0; i < owned_count; i++)
    if (owned[i].pid == pid && strcmp(owned[i].start, start) == 0) return 1;
  return 0;
}

/* Records an identity before any wait or signal that concerns it. Returns 1 when it was new. */
static int record(pid_t pid, const char *start) {
  if (is_owned(pid, start)) return 0;
  if (owned_count == MAX_OWNED) { owned_overflow = 1; return 0; }
  owned[owned_count].pid = pid;
  snprintf(owned[owned_count].start, START_LEN, "%s", start);
  owned_count++;
  return 1;
}

/* Previous receipt: 1 clean, 0 none, -1 anything else (running, unconfirmed, unreadable, foreign). */
static int previous_receipt(void) {
  int fd = open(receipt_path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return errno == ENOENT ? 0 : -1;
  char buf[256];
  ssize_t n = read(fd, buf, sizeof buf - 1);
  close(fd);
  if (n <= 0) return -1;
  buf[n] = 0;
  return strncmp(buf, "ezrabot-guardian-receipt 1\nstate clean\n", 39) == 0 ? 1 : -1;
}

static int pidfd_open_(pid_t pid) { return (int)syscall(SYS_pidfd_open, pid, 0); }
static int pidfd_signal(int pidfd, int sig) { return (int)syscall(SYS_pidfd_send_signal, pidfd, sig, NULL, 0); }

/*
 * Signals one identity. The pidfd is opened first, then the start time is read again: when it still
 * matches, the pidfd designates that very process, and a reused PID can never receive the signal.
 */
static void signal_identity(const identity *id, int sig) {
  int pidfd = pidfd_open_(id->pid);
  if (pidfd < 0) return;
  char start[START_LEN];
  char state;
  if (read_stat(id->pid, NULL, &state, start) == 0 && strcmp(start, id->start) == 0 && state != 'Z') pidfd_signal(pidfd, sig);
  close(pidfd);
}

typedef struct { pid_t pid; pid_t ppid; char start[START_LEN]; char state; } proc_entry;

/* Every live descendant of this guardian, found by parent links in /proc; new ones are recorded first. */
static size_t scan_descendants(identity *out, size_t cap) {
  static proc_entry all[65536];
  size_t total = 0;
  DIR *d = opendir("/proc");
  if (!d) return 0;
  for (struct dirent *e; (e = readdir(d)) && total < sizeof all / sizeof all[0];) {
    char *end;
    long pid = strtol(e->d_name, &end, 10);
    if (*end || pid <= 0) continue;
    proc_entry *p = &all[total];
    if (read_stat((pid_t)pid, &p->ppid, &p->state, p->start) != 0) continue;
    p->pid = (pid_t)pid;
    total++;
  }
  closedir(d);
  size_t found = 0;
  static pid_t queue[65536];
  size_t head = 0, tail = 0;
  queue[tail++] = self.pid;
  while (head < tail) {
    pid_t parent = queue[head++];
    for (size_t i = 0; i < total; i++) {
      if (all[i].ppid != parent) continue;
      if (tail < sizeof queue / sizeof queue[0]) queue[tail++] = all[i].pid;
      if (all[i].state == 'Z') continue;
      if (found < cap) { out[found].pid = all[i].pid; snprintf(out[found].start, START_LEN, "%s", all[i].start); found++; }
    }
  }
  return found;
}

static pid_t runtime_pid;
static int runtime_exited;
static int runtime_code = -1, runtime_signal = 0;

/* Reaps every child that ended. Returns 1 when no child is left at all (ECHILD). */
static int reap_children(void) {
  for (;;) {
    siginfo_t info;
    memset(&info, 0, sizeof info);
    if (waitid(P_ALL, 0, &info, WEXITED | WNOHANG) != 0) {
      if (errno == EINTR) continue;
      return errno == ECHILD;
    }
    if (info.si_pid == 0) return 0;
    if (info.si_pid == runtime_pid && !runtime_exited) {
      runtime_exited = 1;
      if (info.si_code == CLD_EXITED) runtime_code = info.si_status; else runtime_signal = info.si_status;
      emit("{\"event\":\"exited\",\"pid\":%d,\"code\":%d,\"signal\":%d}", (int)runtime_pid, runtime_code, runtime_signal);
    }
  }
}

static void wait_until(long long deadline, int sfd, int (*done)(void)) {
  while (!done()) {
    long long left = deadline - now_ms();
    if (left <= 0) return;
    struct pollfd p = { .fd = sfd, .events = POLLIN };
    if (poll(&p, 1, left > 50 ? 50 : (int)left) > 0) {
      struct signalfd_siginfo si;
      while (read(sfd, &si, sizeof si) == sizeof si) {}
    }
  }
}

static int runtime_done(void) { reap_children(); return runtime_exited; }
static int tree_done(void) { return reap_children(); }

static void signal_tree(int sig) {
  static identity found[MAX_OWNED];
  size_t n = scan_descendants(found, MAX_OWNED);
  int fresh = 0;
  for (size_t i = 0; i < n; i++) fresh |= record(found[i].pid, found[i].start);
  if (fresh && write_receipt("stopping") != 0) emit("{\"event\":\"receipt-error\",\"errno\":%d}", errno);
  for (size_t i = 0; i < n; i++) signal_identity(&found[i], sig);
}

/* Stops the runtime, then every descendant, and tells whether the tree is confirmed empty. */
static int stop_tree(int sfd, long long coop_ms, long long term_ms, long long kill_ms) {
  if (!runtime_exited) {
    identity rt = owned[0];
    signal_identity(&rt, SIGTERM);
    wait_until(now_ms() + coop_ms, sfd, runtime_done);
  }
  long long term_until = now_ms() + term_ms;
  while (!tree_done() && now_ms() < term_until) {
    signal_tree(SIGTERM);
    wait_until(now_ms() + 100 < term_until ? now_ms() + 100 : term_until, sfd, tree_done);
  }
  long long kill_until = now_ms() + kill_ms;
  while (!tree_done() && now_ms() < kill_until) {
    signal_tree(SIGKILL);
    wait_until(now_ms() + 50 < kill_until ? now_ms() + 50 : kill_until, sfd, tree_done);
  }
  return tree_done();
}

static long long parse_ms(const char *value) {
  char *end;
  long long v = strtoll(value, &end, 10);
  if (*end || v < 0 || v > 600000) { fprintf(stderr, "ezrabot-guardian: invalid duration %s\n", value); exit(64); }
  return v;
}

int main(int argc, char **argv) {
  const char *lock_path = NULL;
  long long coop_ms = 10000, term_ms = 2000, kill_ms = 3000;
  int i = 1;
  for (; i < argc; i++) {
    if (strcmp(argv[i], "--") == 0) { i++; break; }
    if (strcmp(argv[i], "--lock") == 0 && i + 1 < argc) lock_path = argv[++i];
    else if (strcmp(argv[i], "--receipt") == 0 && i + 1 < argc) receipt_path = argv[++i];
    else if (strcmp(argv[i], "--coop-ms") == 0 && i + 1 < argc) coop_ms = parse_ms(argv[++i]);
    else if (strcmp(argv[i], "--term-ms") == 0 && i + 1 < argc) term_ms = parse_ms(argv[++i]);
    else if (strcmp(argv[i], "--kill-ms") == 0 && i + 1 < argc) kill_ms = parse_ms(argv[++i]);
    else { fprintf(stderr, "ezrabot-guardian: unknown argument %s\n", argv[i]); return 64; }
  }
  if (!lock_path || !receipt_path || i >= argc || argv[i][0] != '/') {
    fprintf(stderr, "ezrabot-guardian: --lock, --receipt and an absolute runtime path are required\n");
    return 64;
  }
  char **runtime_argv = &argv[i];

  for (int fd = 0; fd <= 3; fd++)
    if (fcntl(fd, F_GETFD) < 0 && open("/dev/null", fd == 0 ? O_RDONLY : O_WRONLY) != fd) return 70;
  signal(SIGPIPE, SIG_IGN);
  self.pid = getpid();
  if (read_stat(self.pid, NULL, NULL, self.start) != 0) return 70;

  int lock = open(lock_path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (lock < 0) { emit("{\"event\":\"error\",\"step\":\"lock-open\",\"errno\":%d}", errno); return 70; }
  if (flock(lock, LOCK_EX | LOCK_NB) != 0) {
    if (errno == EWOULDBLOCK) { emit("{\"event\":\"busy\"}"); return 75; }
    emit("{\"event\":\"error\",\"step\":\"lock\",\"errno\":%d}", errno);
    return 70;
  }

  /* A receipt that is not clean means a tree may still run unowned; nothing starts over it. */
  if (previous_receipt() < 0) { emit("{\"event\":\"previous-unconfirmed\"}"); return 76; }

  umask(077);
  if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0) { emit("{\"event\":\"error\",\"step\":\"subreaper\",\"errno\":%d}", errno); return 70; }

  sigset_t mask, old;
  sigemptyset(&mask);
  sigaddset(&mask, SIGCHLD);
  sigaddset(&mask, SIGTERM);
  sigaddset(&mask, SIGINT);
  sigaddset(&mask, SIGHUP);
  sigprocmask(SIG_BLOCK, &mask, &old);
  int sfd = signalfd(-1, &mask, SFD_NONBLOCK | SFD_CLOEXEC);
  if (sfd < 0) return 70;

  if (write_receipt("running") != 0) { emit("{\"event\":\"error\",\"step\":\"receipt\",\"errno\":%d}", errno); return 70; }

  int devnull = open("/dev/null", O_RDONLY | O_CLOEXEC);
  pid_t child = fork();
  if (child < 0) { emit("{\"event\":\"error\",\"step\":\"fork\",\"errno\":%d}", errno); write_receipt("clean"); return 70; }
  if (child == 0) {
    sigprocmask(SIG_SETMASK, &old, NULL);
    signal(SIGPIPE, SIG_DFL);
    if (dup2(devnull, 0) < 0 || dup2(2, 1) < 0 || fcntl(3, F_SETFD, 0) < 0) _exit(127);
    syscall(SYS_close_range, 4, ~0U, 0);
    execv(runtime_argv[0], runtime_argv);
    dprintf(2, "ezrabot-guardian: exec %s: %s\n", runtime_argv[0], strerror(errno));
    _exit(127);
  }
  close(devnull);
  close(3);
  runtime_pid = child;
  char start[START_LEN];
  if (read_stat(child, NULL, NULL, start) != 0) snprintf(start, sizeof start, "unknown");
  record(child, start);
  if (write_receipt("running") != 0) emit("{\"event\":\"receipt-error\",\"errno\":%d}", errno);
  emit("{\"event\":\"spawned\",\"guardian\":%d,\"guardianStart\":\"%s\",\"pid\":%d,\"start\":\"%s\"}", (int)self.pid, self.start, (int)child, start);

  const char *reason = NULL;
  char input[256];
  size_t input_len = 0;
  int input_open = 1;
  while (!reason) {
    struct pollfd fds[2] = { { .fd = sfd, .events = POLLIN }, { .fd = 0, .events = POLLIN } };
    if (poll(fds, input_open ? 2 : 1, -1) < 0 && errno != EINTR) { reason = "poll-error"; break; }
    if (fds[0].revents & POLLIN) {
      struct signalfd_siginfo si;
      while (read(sfd, &si, sizeof si) == sizeof si) {
        if (si.ssi_signo == SIGTERM || si.ssi_signo == SIGINT || si.ssi_signo == SIGHUP) reason = "signal";
      }
      reap_children();
      if (runtime_exited && !reason) reason = "runtime-exited";
    }
    if (input_open && fds[1].revents & (POLLIN | POLLHUP | POLLERR | POLLNVAL)) {
      ssize_t n = read(0, input + input_len, sizeof input - 1 - input_len);
      if (n <= 0) { if (n == 0 || errno != EINTR) { input_open = 0; if (!reason) reason = "control-closed"; } }
      else {
        input_len += (size_t)n;
        input[input_len] = 0;
        char *nl;
        while ((nl = strchr(input, '\n'))) {
          *nl = 0;
          if (strcmp(input, "stop") == 0 && !reason) reason = "stop";
          memmove(input, nl + 1, input_len - (size_t)(nl + 1 - input) + 1);
          input_len = strlen(input);
        }
        if (input_len == sizeof input - 1) input_len = 0;
      }
    }
  }

  emit("{\"event\":\"stopping\",\"reason\":\"%s\"}", reason);
  if (write_receipt("stopping") != 0) emit("{\"event\":\"receipt-error\",\"errno\":%d}", errno);
  int clean = stop_tree(sfd, coop_ms, term_ms, kill_ms) && !owned_overflow;
  static identity left[MAX_OWNED];
  size_t left_n = clean ? 0 : scan_descendants(left, MAX_OWNED);
  if (write_receipt(clean ? "clean" : "unconfirmed") != 0) { clean = 0; emit("{\"event\":\"receipt-error\",\"errno\":%d}", errno); }
  char list[512] = "";
  size_t used = 0;
  for (size_t k = 0; k < left_n && used + 40 < sizeof list; k++)
    used += (size_t)snprintf(list + used, sizeof list - used, "%s{\"pid\":%d,\"start\":\"%s\"}", k ? "," : "", (int)left[k].pid, left[k].start);
  emit("{\"event\":\"cleanup\",\"result\":\"%s\",\"owned\":%zu,\"left\":[%s],\"runtimeCode\":%d,\"runtimeSignal\":%d}",
       clean ? "clean" : "unconfirmed", owned_count, list, runtime_code, runtime_signal);
  return clean ? 0 : 2;
}
