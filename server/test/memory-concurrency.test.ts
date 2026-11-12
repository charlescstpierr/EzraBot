import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadMascots } from '../src/domain.js';
import type { DispatchOutcome } from '../src/protocol.js';
import { openStore, type Store } from '../src/store.js';

const mascots = loadMascots(new URL('../../assets/mascots.json', import.meta.url));
const BOT = 'mino';

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'mino-memory-')), 'mino.sqlite');
}

function open(path = tempPath(), now?: () => string): Store {
  return openStore(now ? { path, mascots, now } : { path, mascots });
}

function remember(store: Store, text: string): string {
  const outcome = store.dispatch({ type: 'memory.create', requestId: randomUUID(), botId: BOT, text });
  assert.equal(outcome.ok, true);
  assert(outcome.ok && outcome.result.kind === 'memory');
  return outcome.result.memoryId;
}

function memory(store: Store, memoryId: string): { text: string; updatedAt: string } {
  const found = store.view().bots.find(bot => bot.id === BOT)?.memories.find(m => m.id === memoryId);
  assert(found, 'the memory is in the view');
  return { text: found.text, updatedAt: found.updatedAt };
}

function save(store: Store, memoryId: string, text: string, baseUpdatedAt?: string, requestId = randomUUID()): DispatchOutcome {
  return store.dispatch({
    type: 'memory.update', requestId, botId: BOT, memoryId, text,
    ...(baseUpdatedAt === undefined ? {} : { baseUpdatedAt }),
  });
}

function accepted(outcome: DispatchOutcome): boolean {
  assert.equal(outcome.ok, true, outcome.ok ? '' : `${outcome.code}: ${outcome.message}`);
  return outcome.ok && outcome.replayed;
}

function refusal(outcome: DispatchOutcome): string {
  assert.equal(outcome.ok, false, 'the command is refused');
  return outcome.ok ? '' : outcome.code;
}

test('a save from the base its editor opened is written and moves the memory to a later updatedAt', () => {
  const store = open();
  try {
    const memoryId = remember(store, 'Préfère le thé');
    const opened = memory(store, memoryId);
    assert.equal(accepted(save(store, memoryId, 'Préfère le café', opened.updatedAt)), false);
    const saved = memory(store, memoryId);
    assert.equal(saved.text, 'Préfère le café');
    assert(Date.parse(saved.updatedAt) > Date.parse(opened.updatedAt), `${saved.updatedAt} is later than ${opened.updatedAt}`);
  } finally {
    store.close();
  }
});

test('an editor holding an older base is refused with stale_base and the newer text stays', () => {
  const store = open();
  try {
    const memoryId = remember(store, 'Préfère le thé');
    const opened = memory(store, memoryId);
    accepted(save(store, memoryId, 'Texte du premier éditeur', opened.updatedAt));
    const before = store.view();
    assert.equal(refusal(save(store, memoryId, 'Texte du second éditeur', opened.updatedAt)), 'stale_base');
    assert.deepEqual(store.view(), before, 'the refused save changes nothing, not even the view revision');
    assert.equal(memory(store, memoryId).text, 'Texte du premier éditeur');
    accepted(save(store, memoryId, 'Reprise explicite', memory(store, memoryId).updatedAt));
    assert.equal(memory(store, memoryId).text, 'Reprise explicite');
  } finally {
    store.close();
  }
});

test('a client that sends no base still writes over a memory that changed since it read it', () => {
  const store = open();
  try {
    const memoryId = remember(store, 'Préfère le thé');
    accepted(save(store, memoryId, 'Écrit par un autre onglet', memory(store, memoryId).updatedAt));
    assert.equal(accepted(save(store, memoryId, 'Écrit par un ancien client')), false);
    assert.equal(memory(store, memoryId).text, 'Écrit par un ancien client');
  } finally {
    store.close();
  }
});

test('retrying a written save with the same requestId is replayed, not judged against the base it moved', () => {
  const store = open();
  try {
    const memoryId = remember(store, 'Préfère le thé');
    const opened = memory(store, memoryId);
    const requestId = randomUUID();
    assert.equal(accepted(save(store, memoryId, 'Préfère le café', opened.updatedAt, requestId)), false);
    const saved = store.view();
    assert.equal(accepted(save(store, memoryId, 'Préfère le café', opened.updatedAt, requestId)), true);
    assert.deepEqual(store.view(), saved, 'the replay writes nothing');
  } finally {
    store.close();
  }
});

test('saves within one millisecond, or after the clock steps back, never give a memory an updatedAt it already had', () => {
  let clock = '2026-03-04T05:06:07.008Z';
  const store = open(tempPath(), () => clock);
  try {
    const memoryId = remember(store, 'Un');
    const seen = [memory(store, memoryId).updatedAt];
    for (const text of ['Deux', 'Trois']) {
      accepted(save(store, memoryId, text, seen.at(-1)));
      seen.push(memory(store, memoryId).updatedAt);
    }
    clock = '2026-03-04T04:00:00.000Z';
    accepted(save(store, memoryId, 'Quatre', seen.at(-1)));
    seen.push(memory(store, memoryId).updatedAt);

    const instants = seen.map(at => Date.parse(at));
    for (let i = 1; i < instants.length; i += 1) {
      assert(instants[i]! > instants[i - 1]!, `${seen[i]} is later than ${seen[i - 1]}`);
    }
    for (const stale of seen.slice(0, -1)) {
      assert.equal(refusal(save(store, memoryId, 'Écrasement', stale)), 'stale_base', `${stale} no longer opens an edit`);
    }
    assert.equal(memory(store, memoryId).text, 'Quatre');
  } finally {
    store.close();
  }
});

test('after a restart the stored updatedAt is still the only base accepted, and the next one is later', () => {
  const path = tempPath();
  const clock = () => '2026-03-04T05:06:07.008Z';
  const first = open(path, clock);
  const memoryId = remember(first, 'Préfère le thé');
  const opened = memory(first, memoryId);
  accepted(save(first, memoryId, 'Sauvé avant l’arrêt', opened.updatedAt));
  const stored = memory(first, memoryId);
  first.close();

  const second = open(path, clock);
  try {
    assert.deepEqual(memory(second, memoryId), stored);
    assert.equal(refusal(save(second, memoryId, 'Ancien éditeur', opened.updatedAt)), 'stale_base');
    assert.equal(memory(second, memoryId).text, 'Sauvé avant l’arrêt');
    accepted(save(second, memoryId, 'Sauvé après le redémarrage', stored.updatedAt));
    const after = memory(second, memoryId);
    assert.equal(after.text, 'Sauvé après le redémarrage');
    assert(Date.parse(after.updatedAt) > Date.parse(stored.updatedAt), `${after.updatedAt} is later than ${stored.updatedAt}`);
  } finally {
    second.close();
  }
});

test('a base that is not a timestamp the server could have sent is an invalid command and writes nothing', () => {
  const store = open();
  try {
    const memoryId = remember(store, 'Préfère le thé');
    const before = store.view();
    for (const base of ['', 'hier', '2026-03-04', '2026-03-04T05:06:07Z', '2026-03-04T05:06:07.008+01:00', 1772600767008, null]) {
      const outcome = store.dispatch({ type: 'memory.update', requestId: randomUUID(), botId: BOT, memoryId, text: 'Écrasement', baseUpdatedAt: base });
      assert.equal(refusal(outcome), 'invalid_command', `${JSON.stringify(base)} is rejected`);
    }
    assert.deepEqual(store.view(), before);
  } finally {
    store.close();
  }
});
