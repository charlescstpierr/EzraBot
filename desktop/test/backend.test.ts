import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test, { afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import { launchOwnedBackend, readReceipt, type BackendSpec, type Identity } from '../src/backend.js';
import { serverEnvironment } from '../src/env.js';
import { startOf } from './proc.js';

const GUARDIAN = fileURLToPath(new URL('../ezrabot-guardian', import.meta.url));
const SERVER = fileURLToPath(new URL('../../../server/dist/src/main.js', import.meta.url));
const FAKE_APP_SERVER_PATH = fileURLToPath(new URL('../../../server/dist/test/fixtures/fake-app-server.js', import.meta.url));
const CODEX_EXEC = fileURLToPath(new URL('../ezrabot-codex', import.meta.url));
const HOST = fileURLToPath(new URL('./fixtures/host.js', import.meta.url));
const RUNTIME = process.env.EZRABOT_TEST_RUNTIME ?? process.execPath;
const PORT = 47318;
const ORIGIN = `http://127.0.0.1:${PORT}`;

type Reported = Identity & { role: string; fds?: string[]; env?: string[] };

/** A synthetic home with a fake Codex. The fake reports its own identity and descriptors, and can leave a setsid helper. */
function world(options: { daemon?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ezb-'));
  const dataDir = join(root, 'data');
  const lifecycleDir = join(dataDir, 'lifecycle');
  mkdirSync(lifecycleDir, { recursive: true, mode: 0o700 });
  const report = join(root, 'codex-report.jsonl');
  const codex = join(root, 'codex');
  // Python opens no descriptor of its own before this script runs, so every descriptor above 2 it lists was inherited.
  writeFileSync(codex, `#!/usr/bin/python3 -I
import json, os, sys
def start(pid):
    text = open('/proc/%d/stat' % pid).read()
    return text[text.rindex(')') + 2:].split()[19]
fd_dir = '/proc/self/fd'
names = os.listdir(fd_dir)
fds = []
for name in names:
    try:
        target = os.readlink(fd_dir + '/' + name)
    except OSError:
        continue
    if int(name) > 2 and not target.startswith('/proc/'):
        fds.append(name + ' ' + target)
def note(entry):
    with open(${JSON.stringify(report)}, 'a') as f:
        f.write(json.dumps(entry) + '\\n')
note({'role': 'codex', 'pid': os.getpid(), 'start': start(os.getpid()), 'fds': fds, 'env': sorted(os.environ)})
if ${options.daemon ? 'True' : 'False'}:
    mid = os.fork()
    if mid == 0:
        os.setsid()
        if os.fork() == 0:
            note({'role': 'codex-daemon', 'pid': os.getpid(), 'start': start(os.getpid())})
            os.execv('/bin/sleep', ['sleep', 'infinity'])
        os._exit(0)
    os.waitpid(mid, 0)
os.execv(${JSON.stringify(process.execPath)}, [${JSON.stringify(process.execPath)}, ${JSON.stringify(FAKE_APP_SERVER_PATH)}, 'reply'] + sys.argv[1:])
`);
  chmodSync(codex, 0o700);
  const session = { PATH: '/usr/bin:/bin', HOME: root, LANG: 'fr_CA.UTF-8', TMPDIR: tmpdir(), COMPOSIO_API_KEY: 'synthetic-not-a-key', MINO_BUDGETS: '{}', MINO_DEVICE_URL: 'https://example.invalid', MINO_EVENTS_PORT: '1', HONCHO_API_KEY: 'synthetic' };
  const spec = (overrides: Partial<BackendSpec> = {}): BackendSpec => {
    const generation = randomBytes(16).toString('hex');
    return {
      guardian: GUARDIAN, runtime: RUNTIME, serverEntry: SERVER, lifecycleDir, dataDir, origin: ORIGIN, generation, log: 2, afterUnconfirmed: false,
      env: serverEnvironment(session, { dataDir, port: PORT, codex, codexExec: CODEX_EXEC, generation }), ...overrides,
    };
  };
  const reported = (): Reported[] => existsSync(report) ? readFileSync(report, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Reported) : [];
  return { root, dataDir, lifecycleDir, spec, reported };
}

const alive = (id: Identity) => startOf(id.pid) === id.start;

const launched: Array<{ stop(): Promise<unknown> }> = [];
const hosts: Array<{ kill(signal: NodeJS.Signals): boolean }> = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) host.kill('SIGKILL');
  await Promise.all(launched.splice(0).map(backend => backend.stop()));
});
function launch(spec: BackendSpec) {
  const backend = launchOwnedBackend(spec);
  launched.push(backend);
  return backend;
}

async function waitFor<T>(what: string, probe: () => T | undefined, ms = 15000): Promise<T> {
  for (const until = Date.now() + ms; Date.now() < until; await new Promise(r => setTimeout(r, 50))) {
    const value = probe();
    if (value !== undefined) return value;
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function view(): Promise<{ spaceId: string; engine: { state: string } }> {
  const response = await fetch(`${ORIGIN}/api/view`, { headers: { host: `127.0.0.1:${PORT}` } });
  assert.equal(response.status, 200);
  return await response.json() as { spaceId: string; engine: { state: string } };
}

test('the real server, started by its guardian, answers on the fixed origin and leaves nothing behind when stopped', async () => {
  const w = world({ daemon: true });
  const backend = launch(w.spec());
  const start = await backend.started;
  assert.equal(start.kind, 'serving');
  assert.ok(start.kind === 'serving' && alive(start.server));
  const first = await view();
  const helpers = await waitFor('codex and its setsid helper', () => {
    const r = w.reported();
    return r.some(x => x.role === 'codex') && r.some(x => x.role === 'codex-daemon') ? r : undefined;
  });
  const codex = helpers.find(x => x.role === 'codex')!;
  assert.deepEqual(codex.fds, [], `the engine inherits no private descriptor: ${codex.fds?.join(', ')}`);
  for (const name of ['ELECTRON_RUN_AS_NODE', 'MINO_DESKTOP_GENERATION', 'COMPOSIO_API_KEY', 'MINO_BUDGETS', 'MINO_DEVICE_URL', 'MINO_EVENTS_PORT', 'HONCHO_API_KEY', 'EZRABOT_CODEX']) {
    assert.equal(codex.env?.includes(name), false, `${name} never reaches the engine`);
  }
  const end = await backend.stop();
  assert.equal(end.cleanup, 'clean');
  assert.equal(end.code, 0, 'the existing shutdown ran');
  for (const id of [start.kind === 'serving' ? start.server : null, ...helpers].filter(Boolean) as Identity[]) assert.equal(alive(id), false, `${JSON.stringify(id)} is gone`);
  assert.equal(readReceipt(w.lifecycleDir)?.state, 'clean');
  for (const file of ['mino.sqlite', 'missions.sqlite']) assert.equal(statSync(join(w.dataDir, file)).mode & 0o777, 0o600, `${file} is private`);

  const again = launch(w.spec());
  assert.equal((await again.started).kind, 'serving');
  assert.equal((await view()).spaceId, first.spaceId, 'the same data is found after a restart');
  assert.equal((await again.stop()).cleanup, 'clean');
});

test('a foreign listener on the port is refused and left alone', async () => {
  const w = world();
  const foreign = createServer(socket => socket.end());
  await new Promise<void>(resolve => foreign.listen(PORT, '127.0.0.1', resolve));
  try {
    const backend = launch(w.spec());
    assert.deepEqual(await backend.started, { kind: 'failed', reason: 'exited' });
    const end = await backend.ended;
    assert.equal(end.cleanup, 'clean');
    assert.equal(end.code, 1);
    assert.equal(foreign.listening, true, 'the foreign listener still serves');
  } finally {
    await new Promise(resolve => foreign.close(resolve));
  }
});

test('a server killed by the system ends the launch, and its helpers are reaped', async () => {
  const w = world({ daemon: true });
  const backend = launch(w.spec());
  const start = await backend.started;
  assert.ok(start.kind === 'serving');
  const helpers = await waitFor('helpers', () => w.reported().some(x => x.role === 'codex-daemon') ? w.reported() : undefined);
  process.kill(start.server.pid, 'SIGKILL');
  const end = await backend.ended;
  assert.equal(end.signal, 9);
  assert.equal(end.cleanup, 'clean');
  for (const id of helpers) assert.equal(alive(id), false, `${JSON.stringify(id)} is gone`);
});

test('when the desktop process dies, the guardian still stops the server and writes clean', async () => {
  const w = world({ daemon: true });
  const host = spawn(process.execPath, [HOST, JSON.stringify(w.spec())], { stdio: ['ignore', 'pipe', 'inherit'] });
  hosts.push(host);
  const first = await new Promise<string>(resolve => createInterface({ input: host.stdout }).once('line', resolve));
  const start = JSON.parse(first) as { kind: string; server: Identity };
  assert.equal(start.kind, 'serving');
  const helpers = await waitFor('helpers', () => w.reported().some(x => x.role === 'codex-daemon') ? w.reported() : undefined);
  host.kill('SIGKILL');
  await waitFor('clean receipt', () => readReceipt(w.lifecycleDir)?.state === 'clean' ? true : undefined);
  for (const id of [start.server, ...helpers]) assert.equal(alive(id), false, `${JSON.stringify(id)} is gone`);
});

test('a stop requested before readiness wins, and a late ready does not turn into serving', async () => {
  const w = world();
  const backend = launch(w.spec());
  const end = await backend.stop();
  assert.deepEqual(await backend.started, { kind: 'failed', reason: 'stopped' });
  assert.equal(end.cleanup, 'clean');
});

test('a ready message for another address is a channel failure, and the launch is stopped', async () => {
  const w = world();
  const backend = launch(w.spec({ origin: 'http://127.0.0.1:1' }));
  assert.deepEqual(await backend.started, { kind: 'failed', reason: 'channel' });
  assert.equal((await backend.ended).cleanup, 'clean');
});

test('a second launch on the same data while one serves is refused by the lock', async () => {
  const w = world();
  const backend = launch(w.spec());
  assert.equal((await backend.started).kind, 'serving');
  const second = launch(w.spec());
  assert.deepEqual(await second.started, { kind: 'refused', reason: 'busy' });
  assert.equal((await backend.stop()).cleanup, 'clean');
});
