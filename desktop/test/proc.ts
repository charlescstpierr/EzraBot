import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export type Identity = { pid: number; start: string };

function stat(pid: number): { state: string; ppid: number; start: string } | undefined {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '').split(' ');
    return { state: fields[0] ?? '', ppid: Number(fields[1]), start: fields[19] ?? '' };
  } catch {
    return undefined;
  }
}

/** The start time of a live process, or undefined when it ended (a zombie runs nothing). */
export function startOf(pid: number): string | undefined {
  const s = stat(pid);
  return s && s.state !== 'Z' ? s.start : undefined;
}

export const parentOf = (pid: number) => stat(pid)?.ppid;

export function ancestorsOf(pid: number): number[] {
  const out: number[] = [];
  for (let p = parentOf(pid); p && p > 0; p = parentOf(p)) out.push(p);
  return out;
}

/** Whether another process could take the lock right now. */
export function flockFree(path: string): boolean {
  const result = spawnSync('flock', ['--nonblock', '--conflict-exit-code', '99', path, 'true']);
  if (result.status !== 0 && result.status !== 99) throw new Error(`flock failed: ${result.stderr}`);
  return result.status === 0;
}
