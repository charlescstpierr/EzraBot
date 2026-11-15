import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, openSync, readFileSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ancestorsOf, flockFree, parentOf, startOf, type Identity } from './proc.js';

const GUARDIAN = fileURLToPath(new URL('../ezrabot-guardian', import.meta.url));
const TREE = fileURLToPath(new URL('./fixtures/tree.js', import.meta.url));

type Event = Record<string, unknown> & { event: string };
type Run = {
  child: ChildProcess;
  dir: string;
  lock: string;
  receipt: string;
  report: string;
  events: Event[];
  next(kind: string, ms?: number): Promise<Event>;
  ready: Promise<string>;
  exit: Promise<number | null>;
};

function guardian(scenario: string, options: { dir?: string; flags?: string[] } = {}): Run {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'ezg-'));
  const lock = join(dir, 'guardian.lock');
  const receipt = join(dir, 'guardian.receipt');
  const report = join(dir, `report-${Date.now()}-${Math.random()}.jsonl`);
  const child = spawn(GUARDIAN, ['--lock', lock, '--receipt', receipt, ...(options.flags ?? []), '--', process.execPath, TREE, scenario, report],
    { stdio: ['pipe', 'pipe', 'inherit', 'pipe'] });
  const events: Event[] = [];
  const waiters: Array<() => void> = [];
  createInterface({ input: child.stdout! }).on('line', line => { events.push(JSON.parse(line) as Event); waiters.splice(0).forEach(w => w()); });
  const next = (kind: string, ms = 15000) => new Promise<Event>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${kind} event; saw ${JSON.stringify(events)}`)), ms);
    const check = () => { const e = events.find(x => x.event === kind); if (e) { clearTimeout(timer); resolve(e); } else waiters.push(check); };
    check();
  });
  const ready = new Promise<string>(resolve => { let text = ''; const pipe = child.stdio[3] as NodeJS.ReadableStream; pipe.on('data', c => { text += c; }); pipe.on('end', () => resolve(text)); pipe.on('error', () => resolve(text)); });
  const exit = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
  return { child, dir, lock, receipt, report, events, next, ready, exit };
}

const reported = (run: Run) => existsSync(run.report)
  ? readFileSync(run.report, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Identity & { role: string; fds?: string[] })
  : [];

async function waitFor<T>(what: string, probe: () => T | undefined, ms = 10000): Promise<T> {
  for (const until = Date.now() + ms; Date.now() < until; await new Promise(r => setTimeout(r, 25))) {
    const value = probe();
    if (value !== undefined) return value;
  }
  throw new Error(`timed out waiting for ${what}`);
}

const alive = (id: Identity) => startOf(id.pid) === id.start;
const identities = (run: Run) => reported(run).filter(r => r.role !== 'fds');

/** Identities this test created itself and that outlived a killed guardian: only those are signalled, by exact identity. */
function cleanupOwn(ids: Identity[]): void {
  for (const id of ids) if (alive(id)) process.kill(id.pid, 'SIGKILL');
}

test('a stop reaps the runtime, a worker, a late child and a setsid double fork, and reports clean', async () => {
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
  const outside: Identity = { pid: bystander.pid!, start: startOf(bystander.pid!)! };
  const run = guardian('late');
  const spawned = await run.next('spawned');
  const ready = JSON.parse(await run.ready) as { kind: string; pid: number };
  assert.equal(ready.pid, spawned.pid, 'ready comes from the very process the guardian started');
  await waitFor('late child and daemon', () => identities(run).some(r => r.role === 'late') && identities(run).some(r => r.role === 'daemon') ? true : undefined);
  const tree = identities(run);
  const daemon = tree.find(r => r.role === 'daemon')!;
  assert.equal(parentOf(daemon.pid), Number(spawned.guardian), 'the setsid daemon was adopted by the guardian');
  run.child.stdin!.end('stop\n');
  const cleanup = await run.next('cleanup');
  assert.equal(cleanup.result, 'clean');
  assert.equal(await run.exit, 0);
  for (const id of tree) assert.equal(alive(id), false, `${JSON.stringify(id)} is gone`);
  assert.ok(Number(cleanup.owned) >= tree.length, 'every identity was recorded before it was signalled');
  assert.equal(alive(outside), true, 'a process outside the guardian tree is never signalled');
  assert.match(readFileSync(run.receipt, 'utf8'), /^ezrabot-guardian-receipt 1\nstate clean\n/);
  bystander.kill('SIGKILL');
});

test('the lock descriptor never reaches the started image, and a second guardian on the same lock starts nothing', async () => {
  const run = guardian('serve');
  await run.next('spawned');
  const fds = await waitFor('fd report', () => reported(run).find(r => r.role === 'fds')?.fds);
  assert.ok(fds.length > 0, 'the started image listed its own descriptors');
  assert.equal(fds.some(target => target === run.lock), false, `lock is close-on-exec: ${fds.join(' ')}`);
  assert.equal(flockFree(run.lock), false, 'the living guardian holds the lock');
  const second = guardian('serve', { dir: run.dir });
  assert.equal((await second.next('busy')).event, 'busy');
  assert.equal(await second.exit, 75);
  assert.equal(second.events.some(e => e.event === 'spawned'), false);
  run.child.stdin!.end();
  assert.equal((await run.next('cleanup')).result, 'clean', 'the end of the control input is a stop');
  assert.equal(await run.exit, 0);
});

test('a killed guardian leaves an unconfirmed state that a free lock does not hide', async () => {
  const run = guardian('late');
  const spawned = await run.next('spawned');
  await waitFor('tree', () => identities(run).some(r => r.role === 'late') && identities(run).some(r => r.role === 'daemon') ? true : undefined);
  const tree = identities(run);
  run.child.kill('SIGKILL');
  await run.exit;
  try {
    assert.equal(alive({ pid: Number(spawned.pid), start: String(spawned.start) }), true, 'the runtime outlives its killed guardian');
    assert.equal(flockFree(run.lock), true, 'the lock is free although the tree still runs');
    assert.match(readFileSync(run.receipt, 'utf8'), /state running/, 'no clean receipt was invented');
    const mine = ancestorsOf(process.pid);
    const inTree = new Set(tree.map(id => id.pid));
    for (const id of tree.filter(alive)) {
      const ppid = parentOf(id.pid)!;
      assert.ok(inTree.has(ppid) || mine.includes(ppid), `${id.pid} has parent ${ppid}: an orphan must be adopted by this test's own subreaper, not by systemd; run through npm test`);
    }
    assert.ok(mine.includes(parentOf(Number(spawned.pid))!), 'the orphaned runtime went to the outer test guardian');
    const receiptBefore = readFileSync(run.receipt, 'utf8');
    for (let attempt = 0; attempt < 2; attempt++) {
      const next = guardian('serve', { dir: run.dir });
      assert.equal((await next.next('previous-unconfirmed')).event, 'previous-unconfirmed');
      assert.equal(await next.exit, 76);
      assert.equal(next.events.some(e => e.event === 'spawned'), false, 'nothing starts over an unconfirmed stop');
      assert.equal(readFileSync(run.receipt, 'utf8'), receiptBefore, 'a refused launch writes no new attestation');
      assert.equal(existsSync(next.report), false, 'no runtime ran');
    }
    assert.equal(alive({ pid: Number(spawned.pid), start: String(spawned.start) }), true, 'the old tree still runs while every launch is refused');
  } finally {
    cleanupOwn(tree);
    rmSync(run.dir, { recursive: true, force: true });
  }
});

test('a runtime that ignores SIGTERM is killed after the cooperative delay', async () => {
  const run = guardian('ignore-term', { flags: ['--coop-ms', '300', '--term-ms', '200', '--kill-ms', '2000'] });
  const spawned = await run.next('spawned');
  await waitFor('fd report', () => reported(run).find(r => r.role === 'fds'));
  const began = Date.now();
  run.child.stdin!.write('stop\n');
  const cleanup = await run.next('cleanup');
  assert.equal(cleanup.result, 'clean');
  assert.equal(cleanup.runtimeSignal, 9);
  assert.ok(Date.now() - began >= 300, 'the cooperative delay was given');
  assert.equal(alive({ pid: Number(spawned.pid), start: String(spawned.start) }), false);
  run.child.stdin!.end();
  assert.equal(await run.exit, 0);
});

test('a deadline never writes clean: a survivor makes the stop unconfirmed', async () => {
  const run = guardian('ignore-term', { flags: ['--coop-ms', '0', '--term-ms', '0', '--kill-ms', '0'] });
  const spawned = await run.next('spawned');
  await waitFor('fd report', () => reported(run).find(r => r.role === 'fds'));
  const runtime = { pid: Number(spawned.pid), start: String(spawned.start) };
  try {
    run.child.stdin!.end('stop\n');
    const cleanup = await run.next('cleanup');
    assert.equal(cleanup.result, 'unconfirmed');
    assert.deepEqual(cleanup.left, [runtime]);
    assert.equal(await run.exit, 2);
    assert.match(readFileSync(run.receipt, 'utf8'), /state unconfirmed/);
  } finally {
    cleanupOwn([runtime]);
  }
});

test('a crashed runtime ends the guardian, which still reaps what the runtime left', async () => {
  const run = guardian('crash');
  await run.next('spawned');
  const exited = await run.next('exited');
  assert.equal(exited.code, 3);
  const cleanup = await run.next('cleanup');
  assert.equal(cleanup.result, 'clean');
  for (const id of identities(run)) assert.equal(alive(id), false, `${JSON.stringify(id)} is gone`);
  run.child.stdin!.end();
  assert.equal(await run.exit, 0);
});

test('a child born while the runtime handles SIGTERM is reaped too', async () => {
  const run = guardian('birth-on-term');
  await run.next('spawned');
  await waitFor('fd report', () => reported(run).find(r => r.role === 'fds'));
  run.child.stdin!.end('stop\n');
  assert.equal((await run.next('cleanup')).result, 'clean');
  const born = identities(run).find(r => r.role === 'born-on-term');
  assert.ok(born, 'a child was born during the stop');
  assert.equal(alive(born), false);
  assert.equal(await run.exit, 0);
});

test('a guardian refuses a lock path that is a symbolic link', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ezg-'));
  closeSync(openSync(join(dir, 'elsewhere'), 'w'));
  const { symlinkSync } = await import('node:fs');
  symlinkSync(join(dir, 'elsewhere'), join(dir, 'guardian.lock'));
  const run = guardian('serve', { dir });
  const error = await run.next('error');
  assert.equal(error.step, 'lock-open');
  assert.equal(await run.exit, 70);
  assert.equal(run.events.some(e => e.event === 'spawned'), false);
});
