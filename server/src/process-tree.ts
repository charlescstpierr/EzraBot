import { readdirSync, readFileSync } from 'node:fs';

/** A PID is reused by the system; its start time (field 22 of /proc/PID/stat) tells two lives apart. */
export type Proc = { pid: number; start: string };

/**
 * What Mino read from /proc. `unknown` means the listing could not be read in full: the absence of a
 * process from it then proves nothing.
 */
export type Census = { kind: 'seen'; procs: Proc[] } | { kind: 'unknown'; reason: string };

/** `gone`: confirmed ended. `running`: still seen with the same identity. `unknown`: Mino could not tell. */
export type Liveness = 'gone' | 'running' | 'unknown';

type Stat = { state: string; ppid: number; start: string };

const errorCode = (error: unknown) => error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;

/** A process that ended between the listing and the read is gone; any other failure leaves it unknown. */
function readStat(root: string, pid: number): Stat | 'gone' | 'unknown' {
  let text: string;
  try { text = readFileSync(`${root}/${pid}/stat`, 'utf8'); } catch (error) {
    const code = errorCode(error);
    return code === 'ENOENT' || code === 'ESRCH' ? 'gone' : 'unknown';
  }
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(' ');
  const ppid = Number(fields[1]);
  const start = fields[19] ?? '';
  if (!fields[0] || !Number.isInteger(ppid) || !/^\d+$/.test(start)) return 'unknown';
  return { state: fields[0], ppid, start };
}

/** Every process under `rootPid`. */
export function census(rootPid: number, root = '/proc'): Census {
  let names: string[];
  try { names = readdirSync(root); } catch { return { kind: 'unknown', reason: `${root} est illisible` }; }
  const children = new Map<number, Proc[]>();
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const stat = readStat(root, Number(name));
    if (stat === 'gone') continue;
    if (stat === 'unknown') return { kind: 'unknown', reason: `${root}/${name} est illisible` };
    const list = children.get(stat.ppid) ?? [];
    list.push({ pid: Number(name), start: stat.start });
    children.set(stat.ppid, list);
  }
  const procs: Proc[] = [];
  for (let queue = [rootPid]; queue.length;) {
    for (const child of children.get(queue.shift() ?? -1) ?? []) { procs.push(child); queue.push(child.pid); }
  }
  return { kind: 'seen', procs };
}

export function liveness(p: Proc, root = '/proc'): Liveness {
  const stat = readStat(root, p.pid);
  if (stat === 'gone' || stat === 'unknown') return stat;
  return stat.start !== p.start || stat.state === 'Z' ? 'gone' : 'running';
}

/**
 * Kills every process the censuses saw that still runs with the same identity, then waits for them to end.
 * `left` lists those not confirmed gone. The verdict is `gone` only when every census was complete and
 * every process seen is confirmed ended.
 */
export async function reap(censuses: Census[], root = '/proc', waitMs = 2000): Promise<{ verdict: Liveness; left: Proc[] }> {
  const procs = new Map<string, Proc>();
  for (const c of censuses) if (c.kind === 'seen') for (const p of c.procs) procs.set(`${p.pid}:${p.start}`, p);
  const list = [...procs.values()];
  for (const p of list) if (liveness(p, root) === 'running') { try { process.kill(p.pid, 'SIGKILL'); } catch { /* checked below */ } }
  let states = list.map(p => liveness(p, root));
  for (const until = Date.now() + waitMs; states.includes('running') && Date.now() < until;) {
    await new Promise(resolve => setTimeout(resolve, 50));
    states = list.map(p => liveness(p, root));
  }
  const left = list.filter((_, i) => states[i] !== 'gone');
  const blind = censuses.some(c => c.kind === 'unknown');
  return { verdict: states.includes('running') ? 'running' : blind || left.length ? 'unknown' : 'gone', left };
}
