import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { OUTPUT_SCHEMA } from '../src/context.js';
import { loadMascots, type UsageObservation } from '../src/domain.js';
import { createCodexEngine, type Engine } from '../src/engine.js';
import type { StoreView } from '../src/protocol.js';
import { openStore, type Store } from '../src/store.js';
import { createWorker } from '../src/worker.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-app-server.js', import.meta.url));
const mascots = loadMascots(new URL('../../assets/mascots.json', import.meta.url));

function engineFor(scenario: string): Engine {
  return createCodexEngine({
    command: process.execPath, args: [fixture, scenario], workDir: mkdtempSync(join(tmpdir(), 'mino-usage-')),
    clientVersion: 'test', turnTimeoutMs: 5000, requestTimeoutMs: 2000, interruptGraceMs: 500,
  });
}

async function eventually<T>(read: () => T | null | undefined, label: string): Promise<T> {
  for (let i = 0; i < 300; i += 1) {
    const value = read();
    if (value !== null && value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`never happened: ${label}`);
}

function app(scenario: string): { store: Store; stop: () => Promise<void>; send: (text: string) => string; cancel: (workId: string) => void } {
  const store = openStore({ path: join(mkdtempSync(join(tmpdir(), 'mino-usage-')), 'mino.sqlite'), mascots });
  const engine = engineFor(scenario);
  const worker = createWorker({ store, engines: { chat: engine, doc: engine } });
  return {
    store,
    cancel(workId) {
      assert(store.dispatch({ type: 'work.cancel', requestId: crypto.randomUUID(), workId }).ok);
      worker.cancel(workId);
    },
    send(text) {
      const sent = store.dispatch({ type: 'message.send', requestId: crypto.randomUUID(), botId: 'mino', text, attachments: [] });
      assert(sent.ok && sent.result.kind === 'message');
      worker.kick();
      return sent.result.workId;
    },
    async stop() {
      await worker.close();
      await engine.close();
      store.close();
    },
  };
}

const attempt = (view: StoreView, workId: string) => view.works.find(w => w.id === workId)?.attempt ?? null;

test('the engine reports parsed usage for its thread before it starts the turn, and drops malformed notifications', async () => {
  const engine = engineFor('usage-noise');
  const events: string[] = [];
  const seen: UsageObservation[] = [];
  engine.onUsage(observation => {
    events.push('usage');
    seen.push(observation);
  });
  try {
    const outcome = await engine.run({
      turn: { baseInstructions: 'x', input: 'y', outputSchema: OUTPUT_SCHEMA },
      choice: { model: null, effort: null, speed: 'standard' }, signal: new AbortController().signal,
      depart: () => ({ ok: true }), onStage: () => {}, onThread: id => events.push(`thread:${id}`), onTurn: id => events.push(`turn:${id}`),
    });
    assert.equal(outcome.kind, 'succeeded');
    if (outcome.kind !== 'succeeded') return;
    assert.equal(events[0], `thread:${outcome.threadId}`, 'the thread is bound before anything else');
    assert.deepEqual(seen.map(o => [o.threadId === outcome.threadId ? 'same' : o.threadId, o.turnId === outcome.turnId ? 'same' : o.turnId, o.usage.total.total]),
      [['same', 'same', 3300], ['thread-elsewhere', 'same', 9900], ['same', 'turn-elsewhere', 9900]]);
    assert.equal(seen[0]?.usage.total.cacheWriteInput, 0, 'an absent cache-write count takes the protocol default');
    assert.equal(seen[0]?.usage.modelContextWindow, null, 'an absent context window stays unknown');
  } finally {
    await engine.close();
  }
});

test('usage sent after turn/completed still reaches the finished attempt, with no wait inside the call', async () => {
  const mino = app('usage-after');
  try {
    const workId = mino.send('Bonjour');
    const done = await eventually(() => {
      const view = mino.store.view();
      return view.works.find(w => w.id === workId && w.state === 'done') ? view : null;
    }, 'reply recorded');
    assert.equal(attempt(done, workId)?.usage, null, 'the reply is recorded before the late usage arrives');
    const usage = await eventually(() => attempt(mino.store.view(), workId)?.usage, 'late usage');
    assert.deepEqual([usage.total.input, usage.total.cachedInput, usage.total.output, usage.total.reasoningOutput, usage.total.total], [2000, 1000, 200, 100, 2200]);
    const view = mino.store.view();
    const stamp = view.messages.find(m => m.role === 'assistant')?.stamp;
    assert.deepEqual([attempt(view, workId)?.state, attempt(view, workId)?.threadId], ['succeeded', stamp?.threadId]);
  } finally {
    await mino.stop();
  }
});

test('usage before completion and after a failure is kept, and a call without usage stays unreported', async () => {
  for (const [scenario, state, total] of [['usage-before', 'done', 1320], ['usage-failed', 'failed', 550], ['no-usage', 'done', null]] as const) {
    const mino = app(scenario);
    try {
      const workId = mino.send('Bonjour');
      const view = await eventually(() => {
        const current = mino.store.view();
        return current.works.find(w => w.id === workId && w.state === state) ? current : null;
      }, `${scenario} finished`);
      assert.equal(attempt(view, workId)?.usage?.total.total ?? null, total, scenario);
    } finally {
      await mino.stop();
    }
  }
});

test('a cancelled call keeps the usage Codex reports after the interruption, and stays cancelled', async () => {
  const mino = app('slow');
  try {
    const workId = mino.send('Réponds lentement');
    await eventually(() => attempt(mino.store.view(), workId)?.threadId, 'thread bound');
    mino.cancel(workId);
    const usage = await eventually(() => attempt(mino.store.view(), workId)?.usage, 'usage after interruption');
    assert.equal(usage.total.total, 770);
    const view = mino.store.view();
    assert.deepEqual([view.works[0]?.state, attempt(view, workId)?.state], ['cancelled', 'cancelled']);
    assert.equal(view.messages.filter(m => m.role === 'assistant').length, 0);
  } finally {
    await mino.stop();
  }
});


test('usage from another turn before turn/start replies cannot replace the real response identity or its counters', async () => {
  const mino = app('usage-before-wrong-turn');
  try {
    const workId = mino.send('Bonjour');
    const view = await eventually(() => {
      const current = mino.store.view();
      return current.works.find(w => w.id === workId && w.state === 'done') ? current : null;
    }, 'real turn finished');
    const finished = attempt(view, workId);
    assert.notEqual(finished?.turnId, 'turn-elsewhere');
    assert.equal(finished?.usage?.total.total, 1320);
    assert.equal(view.messages.find(m => m.role === 'assistant')?.stamp?.turnId, finished?.turnId);
  } finally {
    await mino.stop();
  }
});
