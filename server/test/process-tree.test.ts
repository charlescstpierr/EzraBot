import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { census, liveness, reap } from '../src/process-tree.js';

/** A listing laid out like /proc, so that its failures can be produced without touching the real one. */
function fakeProc() {
  const root = mkdtempSync(join(tmpdir(), 'mino-proc-'));
  const add = (pid: number, ppid: number, start: string, state = 'S') => {
    mkdirSync(join(root, String(pid)), { recursive: true });
    const fields = [state, String(ppid), ...Array<string>(17).fill('0'), start];
    writeFileSync(join(root, String(pid), 'stat'), `${pid} (a b) c) ${fields.join(' ')} 0 0\n`);
  };
  return { root, add, cleanup: () => { chmodSync(root, 0o700); rmSync(root, { recursive: true, force: true }); } };
}

const asRoot = process.getuid?.() === 0;

test('a process that ended between the listing and the read is absent; a listing that cannot be read proves nothing', { skip: asRoot && 'root reads unreadable files' }, () => {
  const proc = fakeProc();
  try {
    proc.add(4194400, 900, '11');
    proc.add(4194401, 4194400, '12');
    proc.add(4194402, 1, '13');
    mkdirSync(join(proc.root, '4194403'));
    assert.deepEqual(census(900, proc.root), { kind: 'seen', procs: [{ pid: 4194400, start: '11' }, { pid: 4194401, start: '12' }] }, 'a vanished entry is a normal absence');
    assert.equal(liveness({ pid: 4194403, start: '1' }, proc.root), 'gone');
    assert.equal(liveness({ pid: 4194400, start: '99' }, proc.root), 'gone', 'the same PID with another start time is another process');
    proc.add(4194404, 900, '14', 'Z');
    assert.equal(liveness({ pid: 4194404, start: '14' }, proc.root), 'gone', 'a zombie runs nothing');

    chmodSync(join(proc.root, '4194402', 'stat'), 0o000);
    assert.equal(census(900, proc.root).kind, 'unknown', 'one unreadable entry may hide a descendant');
    assert.equal(liveness({ pid: 4194402, start: '13' }, proc.root), 'unknown');

    writeFileSync(join(proc.root, '4194401', 'stat'), 'garbage');
    assert.equal(liveness({ pid: 4194401, start: '12' }, proc.root), 'unknown', 'an unreadable format is not an absence');

    chmodSync(proc.root, 0o000);
    assert.equal(census(900, proc.root).kind, 'unknown', 'an unreadable listing is not an empty one');
    assert.equal(census(900, join(proc.root, 'missing')).kind, 'unknown', 'a missing listing is not an empty one');
  } finally { proc.cleanup(); }
});

test('reaping confirms an end only from complete listings', async () => {
  const proc = fakeProc();
  try {
    proc.add(4194500, 900, '21');
    const stuck = await reap([census(900, proc.root)], proc.root, 200);
    assert.equal(stuck.verdict, 'running', 'a process still listed with its identity is not stopped');
    assert.deepEqual(stuck.left, [{ pid: 4194500, start: '21' }]);
    rmSync(join(proc.root, '4194500'), { recursive: true });
    assert.deepEqual(await reap([census(900, proc.root)], proc.root, 200), { verdict: 'gone', left: [] });
    assert.equal((await reap([{ kind: 'seen', procs: [] }, { kind: 'unknown', reason: 'test' }], proc.root, 200)).verdict, 'unknown', 'nothing seen in a blind listing is not nothing running');
  } finally { proc.cleanup(); }
});

test('on the real /proc, a child of this process is listed, killed and confirmed ended', async () => {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  const exit = new Promise<string | null>(resolve => child.once('exit', (_, signal) => resolve(signal)));
  try {
    await new Promise(resolve => child.once('spawn', resolve));
    const seen = census(process.pid);
    assert.equal(seen.kind, 'seen');
    assert.ok(seen.kind === 'seen' && seen.procs.some(p => p.pid === child.pid), 'the child is listed');
    const result = await reap([seen]);
    assert.equal(result.verdict, 'gone');
    assert.equal(await exit, 'SIGKILL');
  } finally { child.kill('SIGKILL'); }
});
