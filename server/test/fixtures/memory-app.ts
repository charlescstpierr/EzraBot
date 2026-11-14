import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_POLICY } from '../../src/admission.js';
import { loadMascots } from '../../src/domain.js';
import { createCodexEngine } from '../../src/engine.js';
import { createHttpServer } from '../../src/http.js';
import { createMemoryDesk, type MemoryDesk, type MemoryEvent } from '../../src/memory-desk.js';
import { withMemoryCapabilities } from '../../src/memory-ledger.js';
import { MemoryCommandSchema, type ScopeView } from '../../src/memory-protocol.js';
import { openStore } from '../../src/store.js';
import type { PcView } from '../../src/tools-protocol.js';
import { createWorker } from '../../src/worker.js';
import type { FakeHoncho } from './fake-honcho.js';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const fixture = fileURLToPath(new URL('./fake-app-server.js', import.meta.url));
const mascots = loadMascots(join(root, 'assets/mascots.json'));
const CSRF = 'c'.repeat(64);
export const PREFIX = 'ezra-essai';
export const BOT = 'nova';

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const address = probe.address();
  await new Promise<void>(r => probe.close(() => r()));
  return typeof address === 'object' && address ? address.port : 0;
}

type Options = {
  /** Null: the server has no Honcho configuration at all. */
  honcho: FakeHoncho | null;
  /** Calls per day of the `honcho` budget. Null: the server declares no such budget. */
  budget?: number | null;
  scenario?: string;
  path?: string;
  timeoutMs?: number;
};

/** The real store, worker, desk and HTTP server, in front of a fake Honcho and the fake App Server. */
export async function startMemory(options: Options) {
  const dir = mkdtempSync(join(tmpdir(), 'mino-memory-flow-'));
  const path = options.path ?? join(dir, 'mino.sqlite');
  const probe = join(dir, 'turn.json');
  const rpc = join(dir, 'rpc.log');
  const gate = join(dir, 'gate');
  process.env.MINO_TEST_BOUNDARY_PROBE = probe;
  process.env.MINO_TEST_RPC_PROBE = rpc;
  process.env.MINO_TEST_GATE = gate;
  const childEnvNames = join(dir, 'env.json');
  process.env.MINO_TEST_ENV_PROBE = childEnvNames;
  const budget = options.budget === undefined ? 500 : options.budget;
  const declared = { ...DEFAULT_POLICY, budgets: { ...DEFAULT_POLICY.budgets, ...(budget === null ? {} : { honcho: { callsPerDay: budget } }) } };
  const store = openStore({
    path, mascots, policy: options.honcho ? withMemoryCapabilities(declared) : declared,
    ...(options.honcho ? { memory: { workspacePrefix: PREFIX } } : {}),
  });
  const engineOptions = { command: process.execPath, workDir: dir, clientVersion: 'test', turnTimeoutMs: 5000, requestTimeoutMs: 2000, interruptGraceMs: 300 };
  const chat = createCodexEngine({ ...engineOptions, args: [fixture, options.scenario ?? 'reply'] });
  const doc = createCodexEngine({ ...engineOptions, args: [fixture, 'deliverable'] });
  const logs: MemoryEvent[] = [];
  const desk: MemoryDesk | null = options.honcho ? createMemoryDesk({
    store, config: { baseUrl: options.honcho.url, apiKey: options.honcho.key, workspacePrefix: PREFIX, timeoutMs: options.timeoutMs ?? 2000 },
    allowLoopbackHttpForTests: true, log: entry => logs.push(entry), closeGraceMs: 50,
  }) : null;
  const worker = createWorker({ store, engines: { chat, doc }, ...(desk ? { memory: desk } : {}) });
  // As the server does once it listens: what a restart left waiting is looked at again.
  desk?.kick();
  const port = await freePort();
  const server: Server = createHttpServer({ store, worker, engine: chat, port, root, csrfToken: CSRF, longPollMs: 50 });
  await new Promise<void>(r => server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${port}`;
  const post = (route: string, body: unknown) => fetch(`${base}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-mino-csrf': CSRF }, body: JSON.stringify(body),
  });
  const view = async (): Promise<PcView> => (await (await fetch(`${base}/api/view`)).json()) as PcView;
  const until = async (check: (v: PcView) => boolean, what: string): Promise<PcView> => {
    for (let i = 0; i < 500; i += 1) {
      const current = await view();
      if (check(current)) return current;
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error(`condition never met: ${what}`);
  };
  const scopeOf = (v: PcView, botId = BOT): ScopeView => {
    const scope = v.memory.scopes.find(candidate => candidate.botId === botId);
    assert(scope, `a memory scope for ${botId}`);
    return scope;
  };
  /** One PC memory command. Returns the HTTP status and the parsed answer. */
  const memory = async (command: Record<string, unknown>) => {
    const response = await post('/api/memory/commands', { requestId: randomUUID(), botId: BOT, ...command });
    return { status: response.status, body: (await response.json()) as { ok: boolean; code?: string; message?: string } };
  };
  const accepted = async (command: Record<string, unknown>) => {
    const sent = await memory(command);
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
  };
  /** Enables the project of a character and waits until its new workspace and both sessions are confirmed. */
  const enable = async (botId = BOT, label = 'Projet synthétique') => {
    await accepted({ type: 'memory.enable', botId, label, acknowledged: true });
    await until(v => scopeOf(v, botId).state === 'active', `the scope of ${botId} is active`);
  };
  const say = async (text: string, botId = BOT): Promise<string> => {
    const response = await post('/api/commands', { type: 'message.send', requestId: randomUUID(), botId, text, attachments: [] });
    const body = (await response.json()) as { result?: { messageId: string; workId: string } };
    assert.equal(response.status, 200, JSON.stringify(body));
    return body.result?.workId ?? '';
  };
  /** Sends one request and waits for the end of its work. */
  const ask = async (text: string, botId = BOT) => {
    const workId = await say(text, botId);
    const done = await until(v => ['done', 'review', 'failed', 'cancelled'].includes(v.works.find(w => w.id === workId)?.state ?? ''), `the work of « ${text} » ends`);
    const work = done.works.find(w => w.id === workId);
    assert(work);
    return { work, reply: done.messages.find(m => m.workId === workId && m.role === 'assistant') ?? null };
  };
  /** Waits until every source of a character has its remote copy read again. */
  const synced = (botId = BOT) => until(v => {
    const scope = scopeOf(v, botId);
    return scope.messages.pending === 0 && scope.declarations.every(d => d.sync !== 'pending');
  }, `every source of ${botId} is settled`);
  const quiet = async () => {
    for (let i = 0; i < 3; i += 1) {
      await desk?.idle();
      await worker.idle();
    }
  };
  const stop = async () => {
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
    await Promise.all([worker.close(), desk?.close()]);
    await Promise.all([chat.close(), doc.close()]);
    store.recoverInterrupted();
    store.close();
  };
  return {
    base, dir, path, store, desk, worker, chat, logs, post, view, until, scopeOf, memory, accepted, enable, say, ask, synced, quiet, stop,
    /** The exact text of the last turn the fake App Server received. */
    turn(): { base: string; input: string } {
      const recorded = JSON.parse(readFileSync(probe, 'utf8')) as { thread: { baseInstructions: string }; turn: { input: { text: string }[] } };
      return { base: recorded.thread.baseInstructions, input: recorded.turn.input[0]?.text ?? '' };
    },
    /** How many turns the fake App Server was asked to start. */
    turnsStarted: () => existsSync(rpc) ? readFileSync(rpc, 'utf8').split('\n').filter(line => line === 'turn/start').length : 0,
    openGate: () => writeFileSync(gate, ''),
    /** Names of provider variables the engine child process received. */
    childEnv: (): string[] => JSON.parse(readFileSync(childEnvNames, 'utf8')) as string[],
    /** Applies one memory command on the store, without the HTTP route that also wakes the worker. */
    apply(command: Record<string, unknown>) {
      const outcome = store.memory.apply(MemoryCommandSchema.parse({ requestId: randomUUID(), botId: BOT, ...command }));
      assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.message);
    },
    /** Records one request of the person on the store, without waking the worker. */
    send(text: string, extra: Record<string, unknown> = {}) {
      const outcome = store.dispatch({ type: 'message.send', requestId: randomUUID(), botId: BOT, text, attachments: [], ...extra });
      assert(outcome.ok && outcome.result.kind === 'message', outcome.ok ? '' : outcome.message);
      return outcome.result;
    },
  };
}
