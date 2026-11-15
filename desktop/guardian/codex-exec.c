/*
 * ezrabot-codex: starts the Codex executable named by EZRABOT_CODEX with the arguments it was given,
 * after closing every descriptor above 2. The Electron runtime that hosts the server leaves some of its
 * own descriptors inheritable; none of them may reach Codex or the programs Codex runs.
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

int main(int argc, char **argv) {
  (void)argc;
  const char *value = getenv("EZRABOT_CODEX");
  if (!value || value[0] != '/') {
    fprintf(stderr, "ezrabot-codex: EZRABOT_CODEX must name an absolute path\n");
    return 127;
  }
  char *target = strdup(value);
  if (!target || unsetenv("EZRABOT_CODEX") != 0) return 127;
  if (syscall(SYS_close_range, 3, ~0U, 0) != 0) return 127;
  argv[0] = target;
  execv(target, argv);
  perror("ezrabot-codex: exec");
  return 127;
}
