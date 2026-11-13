import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadMascots } from '../src/domain.js';
import { createCodexEngine, type Engine } from '../src/engine.js';
import { createHttpServer } from '../src/http.js';
import type { AppView, BotChoice, EngineStatus } from '../src/protocol.js';
import { openStore } from '../src/store.js';
import { createWorker } from '../src/worker.js';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const snapshotPath = join(root, 'test/fixtures/engine-catalogue.json');
process.env.MINO_TEST_CATALOG = snapshotPath;

type Listed = { id: string; supportedReasoningEfforts: { reasoningEffort: string }[]; serviceTiers: { id: string }[] };
const listed: Listed[] = JSON.parse(readFileSync(snapshotPath, 'utf8')).models;
const offers = (model: Listed, effort: string) => model.supportedReasoningEfforts.some(e => e.reasoningEffort === effort);
function pick(found: Listed | undefined): Listed {
  assert.ok(found, 'the engine snapshot no longer has the model this test needs');
  return found;
}
const withUltra = pick(listed.find(m => offers(m, 'ultra') && offers(m, 'max') && m.serviceTiers.some(t => t.id === 'priority')));
const withoutUltra = pick(listed.find(m => offers(m, 'max') && !offers(m, 'ultra')));

const OFFLINE: EngineStatus = { state: 'unavailable', message: 'Catalogue coupé pour le test' };

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const address = probe.address();
  await new Promise<void>(r => probe.close(() => r()));
  return typeof address === 'object' && address ? address.port : 0;
}

async function start() {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'mino-choice-'));
  const store = openStore({ path: join(dir, 'mino.sqlite'), mascots: loadMascots(join(root, 'assets/mascots.json')) });
  const codex = createCodexEngine({
    command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/fake-app-server.js', import.meta.url)), 'choice-exact'],
    workDir: dir, clientVersion: 'test', turnTimeoutMs: 5000, requestTimeoutMs: 2000, interruptGraceMs: 500,
  });
  const link = { offline: false };
  const engine: Engine = { ...codex, catalog: async () => link.offline ? OFFLINE : codex.catalog() };
  const worker = createWorker({ store, engines: { chat: engine, doc: engine } });
  const server = createHttpServer({ store, worker, engine, port, root, csrfToken: 'c'.repeat(64) });
  await new Promise<void>(r => server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${port}`;
  let seq = 0;
  const post = async (command: Record<string, unknown>) => {
    const response = await fetch(`${base}/api/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-mino-csrf': 'c'.repeat(64) },
      body: JSON.stringify({ requestId: `choice-${String(seq += 1).padStart(6, '0')}`, ...command }),
    });
    return { status: response.status, body: await response.json() as { ok: boolean; code?: string; replayed?: boolean; result?: { botId?: string } } };
  };
  const view = async (): Promise<AppView> => await (await fetch(`${base}/api/view`)).json() as AppView;
  const create = (name: string, choice: Partial<BotChoice>, extra: Record<string, unknown> = {}) =>
    post({ type: 'bot.create', name, title: '', shape: 'sprout', color: '#8de343', ...choice, ...extra });
  /** What the App Server received in `turn/start` for the next message to this bot. */
  const received = async (botId: string, text: string) => {
    assert.equal((await post({ type: 'message.send', botId, text, attachments: [] })).status, 200);
    for (let i = 0; i < 400; i += 1) {
      const reply = (await view()).messages.filter(m => m.threadBotId === botId && m.role === 'assistant').at(-1);
      const asked = (await view()).messages.filter(m => m.threadBotId === botId && m.role === 'user').at(-1);
      if (reply && asked?.text === text && reply.workId === asked.workId) return { turn: JSON.parse(reply.text) as unknown, stamp: reply.stamp };
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error('the engine never answered');
  };
  const stop = async () => {
    await worker.close();
    await codex.close();
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
    store.close();
  };
  return { post, view, create, received, stop, link };
}

test('a bot created with a model, a level and a speed sends exactly those to the engine, and so does each later setting', async () => {
  const app = await start();
  try {
    const choice = { model: withUltra.id, effort: 'ultra', speed: 'priority' };
    const created = await app.create('Réglé à la création', choice);
    assert.equal(created.status, 200);
    const botId = created.body.result?.botId ?? '';
    assert.deepEqual((await app.view()).bots.find(b => b.id === botId)?.choice, choice);

    const first = await app.received(botId, 'Premier tour');
    assert.deepEqual(first.turn, { model: withUltra.id, effort: 'ultra', serviceTierForTurn: 'priority' });
    assert.deepEqual({ model: first.stamp?.model, effort: first.stamp?.effort, speed: first.stamp?.speed }, choice);

    assert.equal((await app.post({ type: 'bot.configure', botId, model: withoutUltra.id, effort: 'max', speed: 'standard' })).status, 200);
    assert.deepEqual((await app.received(botId, 'Deuxième tour')).turn, { model: withoutUltra.id, effort: 'max', serviceTierForTurn: 'default' });
  } finally { await app.stop(); }
});

test('a level chosen without a model stays on the default model and reaches the engine as chosen', async () => {
  const app = await start();
  try {
    const created = await app.create('Niveau seul', { effort: 'high' });
    assert.equal(created.status, 200);
    const botId = created.body.result?.botId ?? '';
    assert.deepEqual((await app.view()).bots.find(b => b.id === botId)?.choice, { model: null, effort: 'high', speed: 'standard' });
    assert.deepEqual((await app.received(botId, 'Tour par défaut')).turn, { model: 'fake-sol', effort: 'high', serviceTierForTurn: 'default' });
  } finally { await app.stop(); }
});

test('creation refuses a level or a speed its model does not announce, before any bot exists', async () => {
  const app = await start();
  try {
    const before = (await app.view()).bots.length;
    const refusals: Partial<BotChoice>[] = [
      { model: withoutUltra.id, effort: 'ultra' },
      { model: withUltra.id, effort: 'galactic' },
      { model: withUltra.id, speed: 'turbo' },
      { effort: 'ultra' },
      { model: null, effort: 'medium' },
      { speed: 'turbo' },
    ];
    for (const choice of refusals) {
      const refused = await app.create('Refusé', choice);
      assert.equal(refused.status, 422, JSON.stringify(choice));
      assert.equal(refused.body.code, 'choice_unavailable', JSON.stringify(choice));
    }
    assert.equal((await app.view()).bots.length, before);
    assert.equal((await app.create('Accepté', { model: withoutUltra.id, effort: 'max', speed: 'priority' })).status, 200);
    assert.equal((await app.view()).bots.length, before + 1);
  } finally { await app.stop(); }
});

test('a replayed creation is answered by the journal even with the catalogue gone, and a changed choice conflicts', async () => {
  const app = await start();
  try {
    const before = (await app.view()).bots.length;
    const choice = { model: withUltra.id, effort: 'max', speed: 'priority' };
    const first = await app.create('Réponse perdue', choice, { requestId: 'lost-create-0001' });
    assert.equal(first.status, 200);
    assert.equal(first.body.replayed, false);

    app.link.offline = true;
    const replay = await app.create('Réponse perdue', choice, { requestId: 'lost-create-0001' });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.result?.botId, first.body.result?.botId);
    const changed = await app.create('Réponse perdue', { ...choice, effort: 'high' }, { requestId: 'lost-create-0001' });
    assert.equal(changed.status, 409);
    assert.equal(changed.body.code, 'request_conflict');
    assert.equal((await app.view()).bots.length, before + 1);
    assert.deepEqual((await app.view()).bots.find(b => b.id === first.body.result?.botId)?.choice, choice);

    assert.equal((await app.create('Hors ligne', { effort: 'high' })).status, 422);
    assert.equal((await app.create('Hors ligne', {})).status, 200);
    assert.equal((await app.create('Hors ligne bis', { model: null, effort: null, speed: 'standard' })).status, 200);
    assert.equal((await app.view()).bots.length, before + 3);
  } finally { await app.stop(); }
});
