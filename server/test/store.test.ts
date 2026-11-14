import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { engineFailure, loadMascots, type EngineOutcome } from '../src/domain.js';
import type { CommandResult, DispatchOutcome, StoreView } from '../src/protocol.js';
import { openStore, StoreLockedError, type Claim, type Store } from '../src/store.js';

const mascots = loadMascots(new URL('../../assets/mascots.json', import.meta.url));

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'mino-store-')), 'mino.sqlite');
}

function open(path = tempPath()): { store: Store; path: string } {
  return { store: openStore({ path, mascots }), path };
}

const rid = () => randomUUID();

function ok(outcome: DispatchOutcome): CommandResult {
  assert.equal(outcome.ok, true, outcome.ok ? '' : `${outcome.code}: ${outcome.message}`);
  if (!outcome.ok) throw new Error('refused');
  return outcome.result;
}

function refused(outcome: DispatchOutcome): string {
  assert.equal(outcome.ok, false);
  return outcome.ok ? '' : outcome.code;
}

function send(store: Store, text: string, botId = 'mino', requestId = rid()): string {
  const result = ok(store.dispatch({ type: 'message.send', requestId, botId, text, attachments: [] }));
  assert.equal(result.kind, 'message');
  return result.kind === 'message' ? result.workId : '';
}

function claim(store: Store): Claim {
  const next = store.claimNextJob();
  assert(next, 'a pending job is claimable');
  return next;
}

const reply = (text: string, deliverable: { title: string; body: string } | null = null): EngineOutcome => ({
  kind: 'succeeded',
  reply: { reply: text, deliverable },
  used: { model: 'gpt-test', effort: 'low', speed: 'standard' },
  threadId: 'thread-1',
  turnId: 'turn-1',
});

function work(view: StoreView, workId: string) {
  const found = view.works.find(w => w.id === workId);
  assert(found, 'work exists');
  return found;
}

function withDeliverable(store: Store, body = 'Corps v1'): { workId: string; v1: string } {
  const workId = send(store, 'Rédige une invitation');
  store.finishJob(claim(store), reply('Voici.', { title: 'Invitation', body }));
  const v1 = work(store.view(), workId).versions[0]?.id ?? '';
  return { workId, v1 };
}

function propose(store: Store, workId: string, versionId: string): { proposalId: string; payloadSha256: string } {
  const result = ok(store.dispatch({ type: 'publication.propose', requestId: rid(), workId, versionId, destination: 'carnet' }));
  assert.equal(result.kind, 'proposal');
  return result.kind === 'proposal' ? result : { proposalId: '', payloadSha256: '' };
}

test('messages, results and versions survive a restart, and a second instance is refused', () => {
  const first = open();
  const workId = send(first.store, 'Rédige une invitation');
  first.store.finishJob(claim(first.store), reply('Voici une invitation.', { title: 'Invitation', body: 'Viens samedi.' }));
  assert.throws(() => openStore({ path: first.path, mascots }), StoreLockedError);
  const before = first.store.view();
  first.store.close();

  const second = open(first.path);
  const after = second.store.view();
  assert.deepEqual(after.messages, before.messages);
  assert.equal(work(after, workId).state, 'review');
  assert.deepEqual(work(after, workId).versions.map(v => [v.n, v.title, v.body]), [[1, 'Invitation', 'Viens samedi.']]);
  const answer = after.messages.find(m => m.role === 'assistant');
  assert.deepEqual(answer?.stamp, { model: 'gpt-test', effort: 'low', speed: 'standard', threadId: 'thread-1', turnId: 'turn-1' });
  second.store.close();
});

test('a call left running at shutdown becomes a visible interrupted failure that only a manual retry restarts', () => {
  const first = open();
  const workId = send(first.store, 'Bonjour');
  const queued = send(first.store, 'Encore une');
  claim(first.store);
  first.store.close();

  const second = open(first.path);
  assert.equal(second.store.recoverInterrupted(), 1);
  const recovered = second.store.view();
  assert.equal(work(recovered, workId).state, 'failed');
  assert.equal(work(recovered, workId).next.kind, 'retry');
  assert.equal(work(recovered, workId).lastFact.kind, 'none');
  const requestMessageId = work(recovered, workId).requestMessageId;
  assert.match(work(recovered, workId).attempt?.error ?? '', /arrêté pendant cet appel/);
  assert.equal(work(recovered, queued).state, 'pending');
  const queuedClaim = claim(second.store);
  assert.equal(queuedClaim.workId, queued, 'the queued request still runs, the interrupted one does not');
  second.store.finishJob(queuedClaim, reply('ok'));
  ok(second.store.dispatch({ type: 'work.retry', requestId: rid(), workId }));
  const retried = claim(second.store);
  assert.equal(retried.workId, workId);
  assert.equal(retried.n, 2);
  assert.equal(work(second.store.view(), workId).requestMessageId, requestMessageId);
  assert.equal(work(second.store.view(), workId).threadBotId, 'mino');
  second.store.close();
});

test('engine failures are recorded as failed work with no reply message', () => {
  const { store } = open();
  const workId = send(store, 'Bonjour');
  store.finishJob(claim(store), engineFailure('usage_limit'));
  const view = store.view();
  assert.equal(work(view, workId).state, 'failed');
  assert.match(work(view, workId).attempt?.error ?? '', /limite d’utilisation/);
  assert.equal(view.messages.filter(m => m.role === 'assistant').length, 0);
  store.close();
});

test('a reused command id returns the first acceptance, and a different payload under it is refused', () => {
  const { store } = open();
  const requestId = rid();
  const first = store.dispatch({ type: 'message.send', requestId, botId: 'mino', text: 'Bonjour', attachments: [] });
  const again = store.dispatch({ type: 'message.send', requestId, botId: 'mino', text: 'Bonjour', attachments: [] });
  assert.deepEqual(again, { ...first, replayed: true });
  assert.equal(refused(store.dispatch({ type: 'message.send', requestId, botId: 'mino', text: 'Autre chose', attachments: [] })), 'request_conflict');
  assert.equal(refused(store.dispatch({ type: 'work.cancel', requestId, workId: 'w_x' })), 'request_conflict');
  assert.equal(store.view().works.length, 1);
  store.close();
});

test('memory is per bot, editable, deletable for later calls, and leaves no text in the command journal', () => {
  const { store, path } = open();
  const created = ok(store.dispatch({ type: 'memory.create', requestId: rid(), botId: 'mino', text: 'Réponses courtes' }));
  ok(store.dispatch({ type: 'memory.create', requestId: rid(), botId: 'pixel', text: 'Aime le violet' }));
  const memoryId = created.kind === 'memory' ? created.memoryId : '';
  assert.equal(refused(store.dispatch({ type: 'memory.update', requestId: rid(), botId: 'pixel', memoryId, text: 'pirate' })), 'not_found');
  assert.equal(refused(store.dispatch({ type: 'memory.delete', requestId: rid(), botId: 'pixel', memoryId })), 'not_found');
  ok(store.dispatch({ type: 'memory.update', requestId: rid(), botId: 'mino', memoryId, text: 'Réponses très courtes' }));

  send(store, 'Question pour Pixel', 'pixel');
  const pixelClaim = claim(store);
  assert.match(pixelClaim.turn.input, /- Aime le violet/);
  assert.doesNotMatch(pixelClaim.turn.input, /courtes/);
  store.finishJob(pixelClaim, reply('Réponse de Pixel'));

  send(store, 'Première question');
  const withMemory = claim(store);
  assert.match(withMemory.turn.input, /- Réponses très courtes/);
  assert.doesNotMatch(withMemory.turn.input, /violet|Pixel|Échanges précédents/, 'Mino does not see what Pixel was told');
  store.finishJob(withMemory, reply('Première réponse'));

  ok(store.dispatch({ type: 'memory.delete', requestId: rid(), botId: 'mino', memoryId }));
  send(store, 'Deuxième question');
  const afterDelete = claim(store);
  assert.doesNotMatch(afterDelete.turn.input, /courtes|Mémoire de/);
  assert.match(afterDelete.turn.input, /Personne : Première question\nMino : Première réponse/, 'older messages are unchanged by the deletion');
  assert.deepEqual(store.view().bots.find(b => b.id === 'mino')?.memories, []);
  store.close();

  const db = new DatabaseSync(path);
  const journal = JSON.stringify(db.prepare('SELECT * FROM commands').all());
  db.close();
  assert.doesNotMatch(journal, /courtes|violet|pirate/);
});

test('versions are immutable, edits guard their base, and restore stays inside its work as version n+1', () => {
  const { store, path } = open();
  const a = withDeliverable(store, 'A1');
  const b = withDeliverable(store, 'B1');
  const edited = ok(store.dispatch({ type: 'version.edit', requestId: rid(), workId: a.workId, baseVersionId: a.v1, title: 'Invitation', body: 'A2' }));
  assert.deepEqual(edited.kind === 'version' ? edited.n : 0, 2);
  assert.equal(refused(store.dispatch({ type: 'version.edit', requestId: rid(), workId: a.workId, baseVersionId: a.v1, title: 'Invitation', body: 'A3 from a stale tab' })), 'stale_base');
  assert.equal(refused(store.dispatch({ type: 'version.restore', requestId: rid(), workId: a.workId, versionId: b.v1 })), 'cross_work');
  ok(store.dispatch({ type: 'version.restore', requestId: rid(), workId: a.workId, versionId: a.v1 }));
  const versions = work(store.view(), a.workId).versions;
  assert.deepEqual(versions.map(v => [v.n, v.body, v.source, v.restoredFromN]), [[1, 'A1', 'result', null], [2, 'A2', 'edit', null], [3, 'A1', 'restore', 1]]);
  store.close();

  const db = new DatabaseSync(path);
  assert.throws(() => db.prepare('UPDATE versions SET body = ? WHERE id = ?').run('changed', a.v1), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM versions WHERE id = ?').run(a.v1), /immutable/);
  assert.throws(() => db.prepare(`INSERT INTO versions(id, work_id, n, title, body, source, restored_from, attempt_id, created_at) VALUES ('x', ?, 9, 't', 'b', 'restore', ?, NULL, 'now')`).run(a.workId, b.v1), /crosses works/);
  db.close();
});

test('an approval is refused when its action, destination, version or hash differ, or after an edit or restore', () => {
  const { store } = open();
  const { workId, v1 } = withDeliverable(store);
  const shown = propose(store, workId, v1);
  const exact = { type: 'publication.approve', proposalId: shown.proposalId, action: 'publish', destination: 'carnet', versionId: v1, payloadSha256: shown.payloadSha256 } as const;
  assert.equal(refused(store.dispatch({ ...exact, requestId: rid(), action: 'send' })), 'approval_mismatch');
  assert.equal(refused(store.dispatch({ ...exact, requestId: rid(), destination: 'courriel' })), 'approval_mismatch');
  assert.equal(refused(store.dispatch({ ...exact, requestId: rid(), payloadSha256: '0'.repeat(64) })), 'approval_mismatch');
  assert.equal(refused(store.dispatch({ ...exact, requestId: rid(), versionId: 'v_other' })), 'approval_mismatch');

  ok(store.dispatch({ type: 'version.edit', requestId: rid(), workId, baseVersionId: v1, title: 'Invitation', body: 'Corps v2' }));
  assert.equal(refused(store.dispatch({ ...exact, requestId: rid() })), 'proposal_closed');
  assert.equal(work(store.view(), workId).proposals[0]?.staleReason, 'edited');

  const v2 = work(store.view(), workId).versions[1]?.id ?? '';
  const second = propose(store, workId, v2);
  ok(store.dispatch({ type: 'version.restore', requestId: rid(), workId, versionId: v1 }));
  assert.equal(refused(store.dispatch({ ...exact, proposalId: second.proposalId, versionId: v2, payloadSha256: second.payloadSha256, requestId: rid() })), 'proposal_closed');
  assert.equal(work(store.view(), workId).proposals[1]?.staleReason, 'restored');
  assert.deepEqual(store.view().carnet, []);
  store.close();
});

test('a rejection is final and publishes nothing', () => {
  const { store } = open();
  const { workId, v1 } = withDeliverable(store);
  const shown = propose(store, workId, v1);
  ok(store.dispatch({ type: 'publication.reject', requestId: rid(), proposalId: shown.proposalId }));
  assert.equal(refused(store.dispatch({ type: 'publication.approve', requestId: rid(), proposalId: shown.proposalId, action: 'publish', destination: 'carnet', versionId: v1, payloadSha256: shown.payloadSha256 })), 'proposal_closed');
  assert.deepEqual(store.view().carnet, []);
  store.close();
});

test('a replayed approval publishes once, and the published copy outlives a later restore', () => {
  const { store } = open();
  const { workId, v1 } = withDeliverable(store, 'Texte publié');
  ok(store.dispatch({ type: 'version.edit', requestId: rid(), workId, baseVersionId: v1, title: 'Invitation', body: 'Texte publié, révisé' }));
  const v2 = work(store.view(), workId).versions[1]?.id ?? '';
  const shown = propose(store, workId, v2);
  const approval = { type: 'publication.approve', requestId: rid(), proposalId: shown.proposalId, action: 'publish', destination: 'carnet', versionId: v2, payloadSha256: shown.payloadSha256 } as const;
  const first = ok(store.dispatch(approval));
  const replay = store.dispatch(approval);
  assert.deepEqual(replay, { ok: true, replayed: true, result: first });
  assert.equal(refused(store.dispatch({ ...approval, requestId: rid() })), 'proposal_closed');
  assert.equal(work(store.view(), workId).state, 'done');

  ok(store.dispatch({ type: 'version.restore', requestId: rid(), workId, versionId: v1 }));
  const after = store.view();
  assert.equal(after.carnet.length, 1);
  assert.deepEqual([after.carnet[0]?.body, after.carnet[0]?.versionN, after.carnet[0]?.payloadSha256], ['Texte publié, révisé', 2, shown.payloadSha256]);
  assert.equal(work(after, workId).versions.at(-1)?.body, 'Texte publié');
  assert.equal(work(after, workId).proposals[0]?.state, 'approved');
  store.close();
});

test('a late result cannot revive a cancelled job or overwrite a newer attempt', () => {
  const { store } = open();
  const workId = send(store, 'Bonjour');
  const first = claim(store);
  ok(store.dispatch({ type: 'work.cancel', requestId: rid(), workId }));
  assert.deepEqual(store.finishJob(first, reply('Trop tard')), { kind: 'stale' });
  assert.equal(work(store.view(), workId).state, 'cancelled');

  ok(store.dispatch({ type: 'work.retry', requestId: rid(), workId }));
  const second = claim(store);
  assert.deepEqual(store.finishJob(first, reply('Toujours trop tard')), { kind: 'stale' });
  assert.deepEqual(store.finishJob(second, reply('À l’heure')), { kind: 'recorded', state: 'done' });
  assert.deepEqual(store.view().messages.filter(m => m.role === 'assistant').map(m => m.text), ['À l’heure']);
  store.close();
});

test('an exact proposal cannot change its payload and a publication must match its immutable version', () => {
  const { store, path } = open();
  const { workId, v1 } = withDeliverable(store, 'Texte exact');
  const shown = propose(store, workId, v1);
  ok(store.dispatch({ type: 'publication.approve', requestId: rid(), proposalId: shown.proposalId, payloadSha256: shown.payloadSha256, action: 'publish', destination: 'carnet', versionId: v1 }));
  store.close();
  const db = new DatabaseSync(path);
  try {
    assert.throws(() => db.prepare('UPDATE proposals SET destination = ? WHERE id = ?').run('ailleurs', shown.proposalId), /closed|immutable/);
    assert.throws(() => db.prepare('DELETE FROM proposals WHERE id = ?').run(shown.proposalId), /kept/);
    assert.throws(() => db.exec(`INSERT INTO publications(id, proposal_id, decision_id, work_id, version_id, destination, title, body, payload_sha256, created_at)
      SELECT 'invalid-copy', proposal_id, decision_id, work_id, version_id, destination, title, 'Autre texte', payload_sha256, created_at FROM publications`), /differs/);
  } finally {
    db.close();
  }
});

test('a queued follow-up receives the preceding completed reply and deliverable even when its message was sent first', () => {
  const { store } = open();
  try {
    send(store, 'Rédige une invitation');
    const first = claim(store);
    const followUpId = send(store, 'Rends-la plus courte');
    send(store, 'Une demande plus tardive');
    send(store, 'Un autre bot', 'pixel');
    store.finishJob(first, reply('Voici le premier texte.', { title: 'Invitation', body: 'CONTENU_A_CONSERVER' }));
    const followUp = claim(store);
    assert.equal(followUp.workId, followUpId);
    assert.match(followUp.turn.input, /Personne : Rédige une invitation\nMino : Voici le premier texte\./);
    assert.match(followUp.turn.input, /CONTENU_A_CONSERVER/);
    assert.doesNotMatch(followUp.turn.input + followUp.turn.baseInstructions, /Une demande plus tardive|Un autre bot/);
  } finally {
    store.close();
  }
});

test('forgetting a memory removes its command verifier and cannot replay it back into existence', () => {
  const { store, path } = open();
  const create = { type: 'memory.create', requestId: rid(), botId: 'mino', text: 'Souvenir privé court' };
  const made = ok(store.dispatch(create));
  assert.equal(made.kind, 'memory');
  if (made.kind !== 'memory') throw new Error('missing memory');
  send(store, 'Bonjour');
  claim(store);
  ok(store.dispatch({ type: 'memory.delete', requestId: rid(), botId: 'mino', memoryId: made.memoryId }));
  assert.equal(refused(store.dispatch(create)), 'request_conflict');
  assert.equal(store.view().bots.find(b => b.id === 'mino')?.memories.length, 0);
  store.close();
  const db = new DatabaseSync(path);
  try {
    assert.equal(db.prepare('SELECT fingerprint FROM commands WHERE request_id = ?').get(create.requestId)?.fingerprint, '');
    assert.equal(db.prepare('SELECT context_sha256 FROM attempts').get()?.context_sha256, '');
  }
  finally { db.close(); }
});

test('the revision after restart is newer than every view exposed by the previous process', () => {
  const first = open();
  send(first.store, 'Bonjour');
  const prior = first.store.view().rev;
  first.store.close();
  const second = open(first.path);
  try { assert(second.store.view().rev > prior); }
  finally { second.store.close(); }
});

test('SQL cannot attach a work or reply to another bot owner', () => {
  const { store, path } = open();
  const workId = send(store, 'Bonjour');
  const active = claim(store);
  const requestId = store.view().works[0]?.requestMessageId;
  assert(requestId);
  store.close();
  const db = new DatabaseSync(path);
  try {
    assert.throws(() => db.prepare("INSERT INTO works(id,bot_id,request_message_id,state,title,created_at,updated_at) VALUES ('wrong','pixel',?,'pending','x','now','now')").run(requestId), /owner mismatch/);
    assert.throws(() => db.prepare('UPDATE works SET bot_id = ? WHERE id = ?').run('pixel', workId), /immutable/);
    assert.throws(() => db.prepare("INSERT INTO messages(id,bot_id,role,text,attempt_id,created_at) VALUES ('wrong-reply','pixel','assistant','x',?,'now')").run(active.attemptId), /owner mismatch/);
  } finally { db.close(); }
});

test('bot instructions and reply settings survive a restart and only reach that bot’s calls', () => {
  const first = open();
  ok(first.store.dispatch({ type: 'bot.update', requestId: rid(), botId: 'mino', instructions: 'CONSIGNE_PROPRE_A_MINO', replyStyle: 'detailed', contextSize: 'long' }));
  first.store.close();
  const second = open(first.path);
  try {
    const bots = second.store.view().bots;
    const mino = bots.find(b => b.id === 'mino');
    assert.deepEqual([mino?.instructions, mino?.replyStyle, mino?.contextSize], ['CONSIGNE_PROPRE_A_MINO', 'detailed', 'long']);
    assert.deepEqual(mino?.choice, { model: null, effort: null, speed: 'standard' }, 'model, effort and speed are untouched');
    const pixel = bots.find(b => b.id === 'pixel');
    assert.deepEqual([pixel?.instructions, pixel?.replyStyle, pixel?.contextSize], ['', 'concise', 'short']);

    send(second.store, 'Bonjour Pixel', 'pixel');
    const pixelClaim = claim(second.store);
    assert.doesNotMatch(pixelClaim.turn.baseInstructions + pixelClaim.turn.input, /CONSIGNE_PROPRE_A_MINO/);
    assert.match(pixelClaim.turn.baseInstructions, /concis/);
    second.store.finishJob(pixelClaim, reply('ok'));

    send(second.store, 'Bonjour Mino');
    const minoClaim = claim(second.store);
    assert.match(minoClaim.turn.baseInstructions, /CONSIGNE_PROPRE_A_MINO/);
    assert.match(minoClaim.turn.baseInstructions, /détaillé/);
    assert.doesNotMatch(minoClaim.turn.input, /Bonjour Pixel/);
  } finally {
    second.store.close();
  }
});

test('each attempt records the plan and hash of the text it sent, and a retry with other settings gets another hash', () => {
  const { store, path } = open();
  try {
    const workId = send(store, 'Rédige un mot ' + 'é'.repeat(30));
    const first = claim(store);
    const plan = work(store.view(), workId).attempt?.plan;
    assert.equal(plan?.inputChars, Array.from(first.turn.input).length);
    assert.equal(plan?.baseChars, Array.from(first.turn.baseInstructions).length);
    assert.equal(plan?.utf8Bytes, Buffer.byteLength(first.turn.baseInstructions) + Buffer.byteLength(first.turn.input));
    store.finishJob(first, engineFailure('overloaded'));
    ok(store.dispatch({ type: 'work.retry', requestId: rid(), workId }));
    const same = claim(store);
    assert.deepEqual(same.turn, first.turn);
    store.finishJob(same, engineFailure('overloaded'));
    ok(store.dispatch({ type: 'bot.update', requestId: rid(), botId: 'mino', instructions: 'Sois bref.' }));
    ok(store.dispatch({ type: 'work.retry', requestId: rid(), workId }));
    claim(store);
  } finally {
    store.close();
  }
  const db = new DatabaseSync(path);
  try {
    const hashes = db.prepare('SELECT context_sha256 AS h FROM attempts ORDER BY n').all().map(row => String(row.h));
    assert.equal(hashes.length, 3);
    assert.match(hashes[0] ?? '', /^[0-9a-f]{64}$/);
    assert.equal(hashes[1], hashes[0], 'same text, same hash');
    assert.notEqual(hashes[2], hashes[0], 'new instructions, new hash');
  } finally { db.close(); }
});

test('the memory total is capped when writing, without dropping any earlier memory', () => {
  const { store } = open();
  try {
    for (let i = 0; i < 8; i += 1) ok(store.dispatch({ type: 'memory.create', requestId: rid(), botId: 'mino', text: `${i}`.padEnd(500, 'x') }));
    assert.equal(refused(store.dispatch({ type: 'memory.create', requestId: rid(), botId: 'mino', text: 'y' })), 'limit_reached');
    const mino = store.view().bots.find(b => b.id === 'mino');
    assert.equal(mino?.memories.length, 8);
    assert.equal(mino?.memoryChars, 4000);
    ok(store.dispatch({ type: 'memory.create', requestId: rid(), botId: 'pixel', text: 'Pixel a sa propre mémoire' }));
  } finally {
    store.close();
  }
});

function legacyDatabase(): string {
  const path = tempPath();
  const db = new DatabaseSync(path);
  db.exec(readFileSync(new URL('../../test/fixtures/schema-v0.sql', import.meta.url), 'utf8'));
  db.exec(`INSERT INTO bots VALUES ('mino', 0, 'Mino', 'ancien titre', 'sprout', '#123456', 'sprout', '#123456', 'gpt-ancien', 'high', 'priority', '2026-01-01');
    INSERT INTO meta VALUES ('active_bot_id', 'mino');
    INSERT INTO messages(id, bot_id, role, text, attempt_id, created_at) VALUES ('m1', 'mino', 'user', 'ANCIENNE_DEMANDE', NULL, '2026-01-01');
    INSERT INTO attachments(message_id, name, text) VALUES ('m1', 'vieux.txt', 'contenu');
    INSERT INTO works VALUES ('w1', 'mino', 'm1', 'done', 'Ancienne demande', '2026-01-01', '2026-01-01');
    INSERT INTO attempts(id, work_id, n, state, stage, requested_model, requested_effort, requested_speed, model, effort, speed, thread_id, turn_id, context_sha256, memory_ids, error_code, error_text, started_at, finished_at)
      VALUES ('a1', 'w1', 1, 'succeeded', NULL, 'gpt-ancien', 'high', 'priority', 'gpt-ancien', 'high', 'priority', 't1', 'u1', 'ancien', '[]', NULL, NULL, '2026-01-01', '2026-01-01');
    INSERT INTO messages(id, bot_id, role, text, attempt_id, created_at) VALUES ('m2', 'mino', 'assistant', 'ANCIENNE_REPONSE', 'a1', '2026-01-01');`);
  const memory = db.prepare(`INSERT INTO memories(id, bot_id, text, created_at, updated_at) VALUES (?, 'mino', ?, '2026-01-01', '2026-01-01')`);
  for (let i = 0; i < 10; i += 1) memory.run(`old-${i}`, `SOUVENIR_${i}`.padEnd(500, 'x'));
  db.close();
  return path;
}

test('an existing database upgrades in place: data kept, old bots become concise and short, old attempts report nothing', () => {
  const path = legacyDatabase();
  for (const round of [1, 2]) {
    const { store } = open(path);
    try {
      const view = store.view();
      const mino = view.bots.find(b => b.id === 'mino');
      assert.deepEqual(mino?.choice, { model: 'gpt-ancien', effort: 'high', speed: 'priority' }, `round ${round}: model setting kept`);
      assert.deepEqual([mino?.title, mino?.instructions, mino?.replyStyle, mino?.contextSize], ['ancien titre', '', 'concise', 'short']);
      assert.equal(mino?.memories.length, 10, 'memories over the new cap are all kept');
      assert.equal(mino?.memoryChars, 5000);
      assert.deepEqual(view.messages.map(m => m.text), ['ANCIENNE_DEMANDE', 'ANCIENNE_REPONSE']);
      assert.deepEqual(view.messages[0]?.attachments, [{ name: 'vieux.txt', chars: 7 }]);
      const old = work(view, 'w1');
      assert.equal(old.state, 'done');
      assert.equal(old.attempt?.plan, null);
      assert.equal(old.attempt?.usage, null, 'no usage is invented for old attempts');
    } finally {
      store.close();
    }
  }
  const { store } = open(path);
  try {
    assert.equal(refused(store.dispatch({ type: 'memory.create', requestId: rid(), botId: 'mino', text: 'encore' })), 'limit_reached');
    assert.equal(refused(store.dispatch({ type: 'memory.update', requestId: rid(), botId: 'mino', memoryId: 'old-0', text: 'x'.repeat(500) + 'y' })), 'invalid_command');
    ok(store.dispatch({ type: 'memory.update', requestId: rid(), botId: 'mino', memoryId: 'old-0', text: 'SOUVENIR_0 raccourci' }));
    assert.equal(refused(store.dispatch({ type: 'memory.update', requestId: rid(), botId: 'mino', memoryId: 'old-0', text: 'SOUVENIR_0 raccourci, puis rallongé' })), 'limit_reached');
    const workId = send(store, 'Nouvelle demande');
    const next = claim(store);
    for (let i = 0; i < 10; i += 1) assert.match(next.turn.input, new RegExp(`- SOUVENIR_${i}`));
    assert.match(next.turn.input, /Personne : ANCIENNE_DEMANDE\n\(fichier joint : vieux\.txt, 7 caractères, non renvoyé\)\nMino : ANCIENNE_REPONSE/);
    assert.equal(work(store.view(), workId).attempt?.plan?.memory.overBudget, true);
    assert.deepEqual(next.choice, { model: 'gpt-ancien', effort: 'high', speed: 'priority' });
  } finally {
    store.close();
  }
});

const counts = (total: number) => ({ input: total, cachedInput: 0, cacheWriteInput: 0, output: 0, reasoningOutput: 0, total });
const observed = (threadId: string, turnId: string, total: number, last = total) => ({ threadId, turnId, usage: { last: counts(last), total: counts(total), modelContextWindow: 1000 } });

test('usage is kept per attempt: replays and older snapshots never double count, and other threads or turns are ignored', () => {
  const { store } = open();
  try {
    const workId = send(store, 'Bonjour');
    const running = claim(store);
    assert.equal(work(store.view(), workId).attempt?.usage, null, 'nothing reported yet');
    store.bindThread(running, 'thread-a');
    store.observeUsage(observed('thread-a', 'turn-a', 100));
    store.bindTurn(running, 'turn-a');
    store.observeUsage(observed('thread-a', 'turn-a', 300, 200));
    store.observeUsage(observed('thread-a', 'turn-a', 300, 200));
    store.observeUsage(observed('thread-a', 'turn-a', 100));
    store.observeUsage(observed('thread-b', 'turn-a', 999));
    store.observeUsage(observed('thread-a', 'turn-b', 999));
    store.finishJob(running, reply('ok'));
    const usage = work(store.view(), workId).attempt?.usage;
    assert.deepEqual([usage?.total.total, usage?.last.total, usage?.modelContextWindow], [300, 200, 1000]);
    const stamp = store.view().messages.find(m => m.role === 'assistant')?.stamp;
    assert.deepEqual([stamp?.threadId, stamp?.turnId], ['thread-a', 'turn-a']);
  } finally {
    store.close();
  }
});

test('usage arriving after a success, a failure or a cancellation is recorded without reopening the attempt and survives a restart', () => {
  const first = open();
  const outcomes: (EngineOutcome | null)[] = [reply('ok'), engineFailure('overloaded'), null];
  const works = outcomes.map((outcome, i) => {
    const workId = send(first.store, `Demande ${i}`);
    const running = claim(first.store);
    first.store.bindThread(running, `thread-${i}`);
    first.store.bindTurn(running, `turn-${i}`);
    if (outcome) first.store.finishJob(running, outcome);
    else ok(first.store.dispatch({ type: 'work.cancel', requestId: rid(), workId }));
    first.store.observeUsage(observed(`thread-${i}`, `turn-${i}`, 50 + i));
    return workId;
  });
  const before = first.store.view();
  first.store.close();
  const second = open(first.path);
  try {
    const after = second.store.view();
    assert.deepEqual(works.map(id => work(after, id).state), ['done', 'failed', 'cancelled']);
    assert.deepEqual(works.map(id => work(after, id).attempt?.state), ['succeeded', 'failed', 'cancelled']);
    assert.deepEqual(works.map(id => work(after, id).attempt?.usage?.total.total), [50, 51, 52]);
    assert.deepEqual(works.map(id => work(after, id).attempt?.usage), works.map(id => work(before, id).attempt?.usage));
    assert.equal(second.store.claimNextJob(), null, 'nothing was put back in the queue');
  } finally {
    second.store.close();
  }
});

test('a retry runs on its own thread, so a late snapshot from the first attempt never lands on it', () => {
  const { store } = open();
  try {
    const workId = send(store, 'Bonjour');
    const firstAttempt = claim(store);
    store.bindThread(firstAttempt, 'thread-1');
    store.finishJob(firstAttempt, engineFailure('overloaded'));
    ok(store.dispatch({ type: 'work.retry', requestId: rid(), workId }));
    const retry = claim(store);
    store.bindThread(retry, 'thread-2');
    store.bindThread(retry, 'thread-1');
    store.observeUsage(observed('thread-1', 'turn-1', 70));
    assert.equal(work(store.view(), workId).attempt?.usage, null, 'the retry has reported nothing');
    store.observeUsage(observed('thread-2', 'turn-2', 80));
    assert.equal(work(store.view(), workId).attempt?.usage?.total.total, 80);
  } finally {
    store.close();
  }
});

test('explicit guests fan out atomically, deduplicate, replay, and stay in the originating thread', () => {
  const { store } = open();
  try {
    const guests = store.view().bots.filter(b => b.id !== 'mino').slice(0, 2);
    assert.equal(guests.length, 2);
    const [a, b] = guests;
    assert(a && b);
    const text = '@A @B @A';
    const command = { type: 'message.send', requestId: rid(), botId: 'mino', text, attachments: [], mentions: [
      { botId: a.id, start: 0, end: 2 }, { botId: b.id, start: 3, end: 5 }, { botId: a.id, start: 6, end: 8 },
    ] };
    ok(store.dispatch(command));
    assert.equal(store.dispatch(command).ok, true);
    assert.equal(store.view().messages.length, 1);
    assert.deepEqual(store.view().works.map(w => [w.botId, w.threadBotId]), [[a.id, 'mino'], [b.id, 'mino']]);
    const first = claim(store);
    assert.equal(first.botId, a.id);
    store.finishJob(first, reply('SISTER_SECRET @Mino', { title: 'Guest result', body: 'guest body' }));
    const second = claim(store);
    assert.equal(second.botId, b.id);
    assert.doesNotMatch(second.turn.input, /SISTER_SECRET/);
    store.finishJob(second, reply('Second guest'));
    assert.equal(store.claimNextJob(), null, 'AI text never invites another bot');
    assert(store.view().messages.every(m => m.threadBotId === 'mino'));
    assert.equal(store.view().messages.filter(m => m.role === 'user').length, 1);
    assert.doesNotMatch(store.exportThread(a.id).content, /SISTER_SECRET/);
    assert.match(store.exportThread('mino').content, /SISTER_SECRET/);
    const before = store.view();
    assert.equal(refused(store.dispatch({ ...command, requestId: rid(), mentions: [{ botId: 'missing', start: 0, end: 2 }] })), 'not_found');
    assert.equal(refused(store.dispatch({ ...command, requestId: rid(), mentions: [{ botId: a.id, start: 1, end: 2 }] })), 'invalid_command');
    assert.deepEqual(store.view(), before);
  } finally { store.close(); }
});

test('guest context groups a request once, excludes private threads and owner memory, and uses executor instructions', () => {
  const { store } = open();
  try {
    const guest = store.view().bots.find(b => b.id !== 'mino'); assert(guest);
    ok(store.dispatch({ type: 'bot.update', requestId: rid(), botId: guest.id, instructions: 'GUEST_INSTRUCTIONS' }));
    ok(store.dispatch({ type: 'memory.create', requestId: rid(), botId: 'mino', text: 'OWNER_MEMORY' }));
    ok(store.dispatch({ type: 'memory.create', requestId: rid(), botId: guest.id, text: 'GUEST_MEMORY' }));
    send(store, 'GUEST_PRIVATE_THREAD', guest.id); store.finishJob(claim(store), reply('PRIVATE_REPLY'));
    send(store, 'ORIGIN_HISTORY'); store.finishJob(claim(store), reply('OWNER_RESPONSE'));
    const mentioned = (text: string) => ok(store.dispatch({ type: 'message.send', requestId: rid(), botId: 'mino', text, attachments: [], mentions: [{ botId: guest.id, start: 0, end: 2 }, { botId: 'mino', start: 3, end: 5 }] }));
    mentioned('@G @M SHARED_REQUEST');
    const a = claim(store);
    assert.match(a.turn.baseInstructions, /GUEST_INSTRUCTIONS/);
    assert.match(a.turn.input, /GUEST_MEMORY/);
    assert.match(a.turn.input, /ORIGIN_HISTORY[\s\S]*OWNER_RESPONSE/);
    assert.doesNotMatch(a.turn.input, /GUEST_PRIVATE_THREAD|PRIVATE_REPLY|OWNER_MEMORY/);
    store.finishJob(a, reply('GUEST_RESPONSE'));
    const b = claim(store); assert.doesNotMatch(b.turn.input, /GUEST_RESPONSE/);
    store.finishJob(b, reply('OTHER_RESPONSE'));
    mentioned('@G @M FOLLOW_UP');
    const c = claim(store);
    assert.equal(c.turn.input.split('Personne : @G @M SHARED_REQUEST').length, 2);
    assert.match(c.turn.input, /GUEST_RESPONSE[\s\S]*OTHER_RESPONSE/);
    assert.doesNotMatch(c.turn.input, /OWNER_MEMORY|GUEST_PRIVATE_THREAD|PRIVATE_REPLY/);
  } finally { store.close(); }
});

test('v1 migration preserves real links, HMAC replay and immutable history, and an old schema cannot reinstate owner-only routing', () => {
  const path = tempPath();
  let db = new DatabaseSync(path);
  const oldSchema = readFileSync(new URL('../../test/fixtures/schema-v0.sql', import.meta.url), 'utf8');
  db.exec(oldSchema);
  db.exec(`ALTER TABLE bots ADD COLUMN instructions TEXT NOT NULL DEFAULT '';
    ALTER TABLE bots ADD COLUMN reply_style TEXT NOT NULL DEFAULT 'concise';
    ALTER TABLE bots ADD COLUMN context_size TEXT NOT NULL DEFAULT 'short';
    ALTER TABLE attempts ADD COLUMN context_plan TEXT;
    ALTER TABLE attempts ADD COLUMN usage TEXT;
    PRAGMA user_version=1;
    INSERT INTO bots(id,position,name,title,shape,color,default_shape,default_color,speed,created_at) VALUES
    ('mino',0,'Mino','','sprout','#123456','sprout','#123456','standard','old'),
    ('pixel',1,'Pixel','','sprout','#123456','sprout','#123456','standard','old');
    INSERT INTO meta VALUES('hmac_key','legacy-key');
    INSERT INTO messages(id,bot_id,role,text,created_at) VALUES('m-old','mino','user','Original','old');
    INSERT INTO works VALUES('w-old','mino','m-old','done','Titre','old','old');
    INSERT INTO attempts(id,work_id,n,state,requested_speed,context_sha256,memory_ids,started_at,finished_at)
    VALUES('a-old','w-old',1,'succeeded','standard','','["deleted-memory"]','old','old');
    INSERT INTO messages(id,bot_id,role,text,attempt_id,created_at) VALUES('r-old','mino','assistant','Réponse','a-old','old');
    INSERT INTO versions VALUES('v-old','w-old',1,'Titre','Corps','result',NULL,'a-old','old');
    INSERT INTO proposals(id,work_id,version_id,action,destination,payload_sha256,state,created_at,closed_at)
    VALUES('p-old','w-old','v-old','publish','carnet','hash','approved','old','old');
    INSERT INTO decisions VALUES('d-old','p-old','approved','hash','old');
    INSERT INTO publications(id,proposal_id,decision_id,work_id,version_id,destination,title,body,payload_sha256,created_at)
    VALUES('pub-old','p-old','d-old','w-old','v-old','carnet','Titre','Corps','hash','old');
    INSERT INTO messages(id,bot_id,role,text,created_at) VALUES('m-running','mino','user','Interrupted','old');
    INSERT INTO works VALUES('w-running','mino','m-running','running','Running','old','old');
    INSERT INTO attempts(id,work_id,n,state,requested_speed,context_sha256,memory_ids,started_at)
    VALUES('a-running','w-running',1,'running','standard','','["deleted-memory"]','old');`);
  const payload = { attachments: [], botId: 'mino', text: 'Original', type: 'message.send' };
  const fingerprint = createHmac('sha256', 'legacy-key').update(JSON.stringify(payload)).digest('hex');
  const result = { kind: 'message', messageId: 'm-old', workId: 'w-old' };
  db.prepare('INSERT INTO commands VALUES(?,?,?,?,?)').run('old-request', 'message.send', fingerprint, JSON.stringify(result), 'old');
  const tables = ['messages', 'works', 'attempts', 'versions', 'proposals', 'decisions', 'publications', 'commands'];
  const before = tables.map(table => db.prepare(`SELECT * FROM ${table}`).all());
  db.close();
  const store = openStore({ path, mascots });
  assert.deepEqual(store.dispatch({ ...payload, requestId: 'old-request' }), { ok: true, replayed: true, result });
  assert.equal(store.view().carnet[0]?.threadBotId, 'mino');
  store.close();
  db = new DatabaseSync(path);
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 12);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  const project = (rows: Record<string, unknown>[], like: Record<string, unknown>[]) => rows.map((row, i) => Object.fromEntries(Object.keys(like[i] ?? {}).map(key => [key, row[key]])));
  assert.deepEqual(tables.map((table, i) => project(db.prepare(`SELECT * FROM ${table}`).all(), before[i] ?? [])), before.map(rows => project(rows, rows)));
  assert.deepEqual(db.prepare(`SELECT lane, step, continued FROM attempts ORDER BY rowid`).all().map(row => ({ ...row })), [
    { lane: 'chat', step: null, continued: 0 }, { lane: 'chat', step: null, continued: 0 }]);
  assert.equal(statSync(path + '.pre-v2').mode & 0o777, 0o600);
  assert.throws(() => db.prepare('INSERT INTO message_mentions VALUES(?,?,?,?,?)').run('m-old', 0, 'pixel', 0, 2), /precede works/);
  assert.throws(() => db.prepare('INSERT INTO message_mentions VALUES(?,?,?,?,?)').run('r-old', 0, 'pixel', 0, 2), /user request/);
  db.exec(oldSchema); // old binaries do this before refusing user_version=2
  db.close();
  const reopened = openStore({ path, mascots });
  assert.equal(reopened.recoverInterrupted(), 1);
  ok(reopened.dispatch({ type: 'message.send', requestId: rid(), botId: 'mino', text: '@Pixel', attachments: [], mentions: [{ botId: 'pixel', start: 0, end: 6 }] }));
  const guest = claim(reopened); assert.equal(guest.botId, 'pixel');
  reopened.close();
});
