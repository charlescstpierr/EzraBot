import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadMascots, type EngineOutcome, type UsageObservation } from '../src/domain.js';
import { createCodexEngine, type Engine, type RunInput } from '../src/engine.js';
import { createHttpServer } from '../src/http.js';
import { DiagnosticsSchema, type AppView, type EngineStatus, type TaskView } from '../src/protocol.js';
import { openStore } from '../src/store.js';
import { createWorker } from '../src/worker.js';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const READY: EngineStatus = { state: 'ready', account: 'chatgpt', models: [{ id: 'fake', displayName: 'Fake', isDefault: true, efforts: ['low'], defaultEffort: 'low', speeds: [] }] };
const used = { model: 'fake', effort: 'low', speed: 'standard' };

type Gate = { open: () => void; wait: Promise<void> };
const gate = (): Gate => {
  let open = () => {};
  const wait = new Promise<void>(resolve => { open = resolve; });
  return { open, wait };
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function scripted(name: string): Engine & { inputs: string[]; next: ((input: RunInput, ids: { threadId: string; turnId: string }) => Promise<EngineOutcome>)[] } {
  const usage = new Set<(observation: UsageObservation) => void>();
  let calls = 0;
  const engine = {
    inputs: [] as string[],
    next: [] as ((input: RunInput, ids: { threadId: string; turnId: string }) => Promise<EngineOutcome>)[],
    status: () => READY,
    catalog: async () => READY,
    close: async () => {},
    onUsage: (listener: (observation: UsageObservation) => void) => { usage.add(listener); return () => usage.delete(listener); },
    run: async (input: RunInput): Promise<EngineOutcome> => {
      calls += 1;
      const ids = { threadId: `${name}-thread-${calls}`, turnId: `${name}-turn-${calls}` };
      engine.inputs.push(input.turn.input);
      input.onThread(ids.threadId);
      input.onTurn(ids.turnId);
      input.onStage('writing');
      const script = engine.next.shift();
      if (!script) return { kind: 'failed', code: 'turn_failed', message: 'no script' };
      return script(input, ids);
    },
  };
  return engine;
}

function streamed(reply: string, deliverable: { title: string; body: string } | null, release: Promise<void>, pieces = 4) {
  return async (input: RunInput, ids: { threadId: string; turnId: string }): Promise<EngineOutcome> => {
    const full = JSON.stringify({ reply, deliverable });
    for (let i = 1; i <= pieces; i += 1) {
      input.onText?.({ ...ids, itemId: 'item', text: full.slice(0, Math.floor(full.length * i / (pieces + 1))), final: false });
      await sleep(40);
    }
    await release;
    if (input.signal.aborted) return { kind: 'cancelled' };
    input.onText?.({ ...ids, itemId: 'item', text: full, final: true });
    return { kind: 'succeeded', reply: { reply, deliverable }, used, ...ids };
  };
}

async function start() {
  const probe = createServer();
  await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const address = probe.address();
  await new Promise<void>(r => probe.close(() => r()));
  const port = typeof address === 'object' && address ? address.port : 0;
  const store = openStore({ path: join(mkdtempSync(join(tmpdir(), 'mino-bg-')), 'mino.sqlite'), mascots: loadMascots(join(root, 'assets/mascots.json')) });
  const chat = scripted('chat');
  const doc = scripted('doc');
  const worker = createWorker({ store, engines: { chat, doc }, progressIntervalMs: 15 });
  const server: Server = createHttpServer({ store, worker, engine: chat, port, root, csrfToken: 'b'.repeat(64), longPollMs: 50 });
  await new Promise<void>(r => server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${port}`;
  let n = 0;
  const post = async (body: Record<string, unknown>) => {
    const response = await fetch(`${base}/api/commands`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-mino-csrf': 'b'.repeat(64) },
      body: JSON.stringify({ requestId: `request-${++n}-xxxxxxxx`, ...body }),
    });
    return { status: response.status, body: await response.json() as { ok: boolean; result?: Record<string, unknown>; code?: string } };
  };
  const view = async (): Promise<AppView> => (await (await fetch(`${base}/api/view`)).json()) as AppView;
  const until = async <T>(read: (v: AppView) => T | undefined | false): Promise<T> => {
    for (let i = 0; i < 400; i += 1) {
      const found = read(await view());
      if (found) return found;
      await sleep(10);
    }
    throw new Error('condition never met');
  };
  const diagnostics = async () => DiagnosticsSchema.parse(await (await fetch(`${base}/api/diagnostics`)).json());
  const stop = async () => {
    await worker.close();
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
    store.close();
  };
  return { post, view, until, diagnostics, stop, chat, doc };
}

const taskOf = (view: AppView, id: string): TaskView | undefined => view.tasks.find(t => t.id === id);

test('over HTTP: the chat answers during a relay, progress persists in several received states, B reads A and A reads B', async () => {
  const app = await start();
  try {
    const draftDone = gate();
    const chatDone = gate();
    app.doc.next.push(streamed('Brouillon prêt REPLY_A.', { title: 'Note', body: 'CANARI_CORPS ' + 'ligne\n'.repeat(30) }, draftDone.wait));
    app.doc.next.push(streamed('Avis : ajoute la date AVIS_B.', null, Promise.resolve()));
    app.doc.next.push(streamed('Date ajoutée.', { title: 'Note', body: 'CANARI_CORPS final daté' }, Promise.resolve()));
    app.chat.next.push(async (_input, ids) => {
      await chatDone.wait;
      return { kind: 'succeeded', reply: { reply: 'Le document avance, Pixel le relira.', deliverable: null }, used, ...ids };
    });

    const sent = await app.post({ type: 'message.send', botId: 'mino', text: 'Rédige la note de rentrée CANARI_DEMANDE', attachments: [], document: { reviewerBotId: 'pixel' } });
    assert.equal(sent.status, 200);
    const taskId = String(sent.body.result?.taskId);
    const chat = await app.post({ type: 'message.send', botId: 'mino', text: 'Tu en es où ?', attachments: [] });
    assert.equal(chat.status, 200);

    const diagnostics = await (async () => {
      for (let i = 0; i < 200; i += 1) {
        const d = await app.diagnostics();
        if (d.activeWorkIds.length === 2) return d;
        await sleep(10);
      }
      throw new Error('two lanes never ran together');
    })();
    const text = JSON.stringify(diagnostics);
    assert.doesNotMatch(text, /CANARI|REPLY_A|Rédige|ligne/);
    chatDone.open();

    const bodies = new Set<string>();
    const answered = await app.until(v => {
      const progress = taskOf(v, taskId)?.progress;
      if (progress?.body) bodies.add(progress.body);
      return bodies.size >= 2 && v.messages.some(m => m.text === 'Le document avance, Pixel le relira.') && v;
    });
    assert.equal(taskOf(answered, taskId)?.status, 'running', 'the chat reply arrived before the document finished');
    assert.equal(taskOf(answered, taskId)?.calls.length, 1);

    const info = await app.post({ type: 'task.intent', taskId, intent: { kind: 'add_info', text: 'Mentionner la cantine' } });
    assert.equal(info.status, 200);
    assert.equal(taskOf(await app.view(), taskId)?.events[0]?.delivery.state, 'waiting');
    draftDone.open();

    const finished = await app.until(v => taskOf(v, taskId)?.status === 'finished' && v);
    const finalTask = taskOf(finished, taskId);
    assert.deepEqual(finalTask?.calls.map(c => [c.step, c.botId, c.state]), [['draft', 'mino', 'succeeded'], ['review', 'pixel', 'succeeded'], ['synthesis', 'mino', 'succeeded']]);
    assert.match(app.doc.inputs[1] ?? '', /Brouillon prêt REPLY_A\.[\s\S]*Mentionner la cantine|Mentionner la cantine[\s\S]*Brouillon prêt REPLY_A\./);
    assert.match(app.doc.inputs[2] ?? '', /Avis de Pixel :\nAvis : ajoute la date AVIS_B\./);
    assert.equal(finalTask?.events[0]?.delivery.state, 'sent');
    const work = finished.works.find(w => w.id === finalTask?.authorWorkId);
    assert.deepEqual(work?.versions.map(v => v.body), ['CANARI_CORPS ' + 'ligne\n'.repeat(30), 'CANARI_CORPS final daté']);

    const after = await app.diagnostics();
    assert.deepEqual(after.activeWorkIds, []);
    const actors = after.attempts.filter(a => [finalTask?.authorWorkId, finalTask?.reviewWorkId].includes(a.workId)).map(a => [a.actorBotId, a.threadBotId]);
    assert.deepEqual(actors, [['mino', 'mino'], ['pixel', 'mino'], ['mino', 'mino']]);
    assert.doesNotMatch(JSON.stringify(after), /CANARI|AVIS_B|REPLY_A|cantine/);
  } finally {
    await app.stop();
  }
});

test('over HTTP: cancelling a task stops its physical call, and deletion waits for that call to return', async () => {
  const app = await start();
  try {
    let aborted = false;
    const returned = gate();
    app.doc.next.push(async (input, ids) => {
      input.onText?.({ ...ids, itemId: 'i', text: '{"reply":"partiel', final: false });
      await new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve()));
      aborted = true;
      await returned.wait;
      return { kind: 'succeeded', reply: { reply: 'tardif', deliverable: { title: 'T', body: 'TARDIF' } }, used, ...ids };
    });
    const sent = await app.post({ type: 'message.send', botId: 'nova', text: 'Rédige', attachments: [], document: { reviewerBotId: null } });
    const taskId = String(sent.body.result?.taskId);
    await app.until(v => taskOf(v, taskId)?.status === 'running');
    const cancelled = await app.post({ type: 'task.intent', taskId, intent: { kind: 'cancel' } });
    assert.equal(cancelled.status, 200);
    await app.until(() => aborted);
    const view = await app.view();
    assert.equal(taskOf(view, taskId)?.status, 'cancelled');
    assert.deepEqual((await app.diagnostics()).activeWorkIds, [taskOf(view, taskId)?.authorWorkId]);
    const nova = view.bots.find(b => b.id === 'nova');
    const busy = await app.post({ type: 'bot.delete', botId: 'nova', confirmName: 'Nova', expected: nova?.deletion });
    assert.equal(busy.status, 409);
    assert.equal(busy.body.code, 'busy');
    returned.open();
    const quiet = await (async () => {
      for (let i = 0; i < 200; i += 1) {
        if ((await app.diagnostics()).activeWorkIds.length === 0) return true;
        await sleep(10);
      }
      return false;
    })();
    assert(quiet);
    const late = await app.view();
    assert.equal(late.messages.some(m => m.text === 'tardif'), false);
    assert.equal(late.works.find(w => w.id === taskOf(late, taskId)?.authorWorkId)?.versions.length, 0);
    const deleted = await app.post({ type: 'bot.delete', botId: 'nova', confirmName: 'Nova', expected: late.bots.find(b => b.id === 'nova')?.deletion });
    assert.equal(deleted.status, 200);
  } finally {
    await app.stop();
  }
});

test('with the real adapter, official deltas become persisted states, and a cut answer stays partial and unvalidated', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/fake-app-server.js', import.meta.url));
  for (const scenario of ['stream', 'stream-cut'] as const) {
    const store = openStore({ path: join(mkdtempSync(join(tmpdir(), 'mino-real-')), 'mino.sqlite'), mascots: loadMascots(join(root, 'assets/mascots.json')) });
    const engineFor = () => createCodexEngine({ command: process.execPath, args: [fixture, scenario], workDir: mkdtempSync(join(tmpdir(), 'mino-cwd-')), clientVersion: 'test', requestTimeoutMs: 2000, interruptGraceMs: 300 });
    const engines = { chat: engineFor(), doc: engineFor() };
    const worker = createWorker({ store, engines, progressIntervalMs: 10 });
    try {
      const sent = store.dispatch({ type: 'message.send', requestId: `real-${scenario}-request`, botId: 'mino', text: 'Plan', attachments: [], document: { reviewerBotId: null } });
      assert(sent.ok && sent.result.kind === 'message');
      const taskId = sent.result.kind === 'message' ? sent.result.taskId ?? '' : '';
      const bodies = new Set<string>();
      const unsubscribe = store.onChange(() => {
        const body = store.view().tasks.find(t => t.id === taskId)?.progress?.body;
        if (body) bodies.add(body);
      });
      worker.kick();
      await worker.idle();
      unsubscribe();
      const task = store.view().tasks.find(t => t.id === taskId);
      const work = store.view().works.find(w => w.id === task?.authorWorkId);
      for (const body of bodies) assert.doesNotMatch(body, /BRUIT/);
      if (scenario === 'stream') {
        assert(bodies.size >= 2, `several received states (${bodies.size})`);
        assert.equal(task?.status, 'finished');
        const final = work?.versions[0]?.body ?? '';
        for (const body of bodies) assert(final.startsWith(body), 'every state is a prefix of the validated version');
      } else {
        assert.equal(task?.status, 'stopped');
        assert.equal(work?.versions.length, 0, 'an invalid answer is never repaired into a version');
        assert.equal(task?.progress?.attemptState, 'failed');
        assert.equal(task?.progress?.complete, true);
        assert(task?.progress?.body?.startsWith('# Plan'), 'the partial text stays visible as received');
      }
    } finally {
      await worker.close();
      await Promise.all([engines.chat.close(), engines.doc.close()]);
      store.close();
    }
  }
});
