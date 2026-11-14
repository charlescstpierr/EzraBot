import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, mock } from 'node:test';
import { engineFailure, loadMascots, type EngineOutcome } from '../src/domain.js';
import type { CommandResult, DispatchOutcome, StoreView } from '../src/protocol.js';
import { managedBackupPaths, openStore, type Claim, type DispatchContext, type Store } from '../src/store.js';

const mascots = loadMascots(new URL('../../assets/mascots.json', import.meta.url));
const rid = () => randomUUID();
const tempPath = () => join(mkdtempSync(join(tmpdir(), 'mino-delete-')), 'mino.sqlite');
const open = (path: string) => openStore({ path, mascots });

function ok(outcome: DispatchOutcome): CommandResult {
  assert.equal(outcome.ok, true, outcome.ok ? '' : `${outcome.code}: ${outcome.message}`);
  if (!outcome.ok) throw new Error('refused');
  return outcome.result;
}

function refused(outcome: DispatchOutcome): string {
  assert.equal(outcome.ok, false, 'refused');
  return outcome.ok ? '' : outcome.code;
}

function claim(store: Store): Claim {
  const next = store.claimNextJob();
  assert(next, 'a pending job is claimable');
  return next;
}

const reply = (text: string, deliverable: { title: string; body: string } | null = null): EngineOutcome => ({
  kind: 'succeeded', reply: { reply: text, deliverable }, used: { model: 'gpt-test', effort: 'low', speed: 'standard' }, threadId: 't', turnId: 'u',
});

function send(store: Store, botId: string, text: string, mentions: { botId: string; tag: string }[] = [], attachments: { name: string; text: string }[] = []) {
  let at = 0;
  const spans = mentions.map(({ botId: id, tag }) => {
    const start = text.indexOf(tag, at);
    at = start + tag.length;
    return { botId: id, start, end: at };
  });
  const command = { type: 'message.send', requestId: rid(), botId, text, attachments, ...(spans.length ? { mentions: spans } : {}) };
  const result = ok(store.dispatch(command));
  assert(result.kind === 'message');
  return { command, ...result };
}

function publish(store: Store, workId: string): void {
  const view = store.view();
  const versionId = view.works.find(w => w.id === workId)?.versions.at(-1)?.id ?? '';
  const proposal = ok(store.dispatch({ type: 'publication.propose', requestId: rid(), workId, versionId, destination: 'carnet' }));
  assert(proposal.kind === 'proposal');
  ok(store.dispatch({ type: 'publication.approve', requestId: rid(), proposalId: proposal.proposalId, action: 'publish', destination: 'carnet', versionId, payloadSha256: proposal.payloadSha256 }));
}

function deleteCommand(view: StoreView, botId: string, requestId = rid()) {
  const bot = view.bots.find(b => b.id === botId);
  assert(bot, `${botId} is live`);
  return { type: 'bot.delete', requestId, botId, confirmName: bot.name, expected: bot.deletion };
}

const NO_WORKER: DispatchContext = { activeWorkIds: [] };

/** Nova owns a private thread with a guest, a file, versions and a publication, and answers as a guest in three other threads. */
function richSpace(store: Store) {
  ok(store.dispatch({ type: 'bot.update', requestId: rid(), botId: 'nova', instructions: 'CANARY_INSTRUCTIONS' }));
  ok(store.dispatch({ type: 'bot.configure', requestId: rid(), botId: 'nova', model: 'gpt-canary', effort: 'high', speed: 'standard' }));
  const memory = ok(store.dispatch({ type: 'memory.create', requestId: rid(), botId: 'nova', text: 'CANARY_MEMORY' }));
  const own = send(store, 'nova', 'CANARY_REQUEST', [], [{ name: 'canary.txt', text: 'CANARY_FILE' }]);
  store.finishJob(claim(store), reply('CANARY_REPLY', { title: 'CANARY_TITLE', body: 'CANARY_BODY' }));
  const v1 = store.view().works.find(w => w.id === own.workId)?.versions[0]?.id ?? '';
  ok(store.dispatch({ type: 'version.edit', requestId: rid(), workId: own.workId, baseVersionId: v1, title: 'CANARY_TITLE', body: 'CANARY_EDIT' }));
  publish(store, own.workId);
  const guestInNova = send(store, 'nova', '@Pixel CANARY_GUEST_ASK', [{ botId: 'pixel', tag: '@Pixel' }]);
  store.finishJob(claim(store), reply('CANARY_GUEST_IN_NOVA'));

  const shared = send(store, 'mino', '@Nova @Pixel KEEP_ASK', [{ botId: 'nova', tag: '@Nova' }, { botId: 'pixel', tag: '@Pixel' }]);
  const novaGuest = claim(store);
  assert.equal(novaGuest.botId, 'nova');
  store.finishJob(novaGuest, reply('KEEP_NOVA_REPLY', { title: 'KEEP_TITLE', body: 'KEEP_BODY' }));
  store.finishJob(claim(store), reply('KEEP_PIXEL_REPLY'));
  publish(store, shared.workId);
  send(store, 'atlas', '@Nova KEEP_FAIL', [{ botId: 'nova', tag: '@Nova' }], [{ name: 'keep.txt', text: 'KEEP_FILE' }]);
  const failing = claim(store);
  store.finishJob(failing, engineFailure('usage_limit'));
  const pending = send(store, 'pixel', '@Nova KEEP_PENDING', [{ botId: 'nova', tag: '@Nova' }]);
  return { memory, own, guestInNova, shared, novaGuestWorkId: novaGuest.workId, failedWorkId: failing.workId, pendingWorkId: pending.workId };
}

const OTHER_TABLES = ['messages', 'attachments', 'message_mentions', 'works', 'versions', 'proposals', 'decisions', 'publications'] as const;

function rowsOutside(path: string, threadOf: string): Record<string, unknown[]> {
  const db = new DatabaseSync(path);
  try {
    const inThread = `SELECT id FROM messages WHERE bot_id = '${threadOf}' AND role = 'user'`;
    const worksIn = `SELECT id FROM works WHERE request_message_id IN (${inThread})`;
    const filters: Record<(typeof OTHER_TABLES)[number], string> = {
      messages: `id NOT IN (${inThread}) AND (attempt_id IS NULL OR attempt_id NOT IN (SELECT id FROM attempts WHERE work_id IN (${worksIn})))`,
      attachments: `message_id NOT IN (${inThread})`,
      message_mentions: `message_id NOT IN (${inThread})`,
      works: `id NOT IN (${worksIn})`,
      versions: `work_id NOT IN (${worksIn})`,
      proposals: `work_id NOT IN (${worksIn})`,
      decisions: `proposal_id IN (SELECT id FROM proposals WHERE work_id NOT IN (${worksIn}))`,
      publications: `work_id NOT IN (${worksIn})`,
    };
    return Object.fromEntries(OTHER_TABLES.map(t => [t, db.prepare(`SELECT * FROM ${t} WHERE ${filters[t]} ORDER BY rowid`).all()]));
  } finally {
    db.close();
  }
}

function fileText(path: string): string {
  return [path, path + '-wal'].filter(existsSync).map(file => readFileSync(file).toString('latin1')).join('');
}

test('deleting a bot erases its thread, guests and memory, keeps its guest contributions elsewhere exactly, and only then reports success', () => {
  const path = tempPath();
  let store = open(path);
  const space = richSpace(store);
  store.close();
  const before = rowsOutside(path, 'nova');
  assert(existsSync(path + '.pre-v2'), 'a managed backup exists before the deletion');
  store = open(path);
  const shown = store.view();
  const nova = shown.bots.find(b => b.id === 'nova');
  assert.deepEqual(nova?.deletion, { messages: 4, files: 1, deliverables: 1, publications: 1, memories: 1, waiting: 1, keptReplies: 1, keptDeliverables: 1, keptMentions: 3, tasks: 0 });
  const otherWorks = shown.works.filter(w => w.threadBotId !== 'nova');
  const command = deleteCommand(shown, 'nova');

  const result = ok(store.dispatch(command, NO_WORKER));
  assert.deepEqual(result, { kind: 'botDeleted', botId: 'nova', nextBotId: 'mino', erased: true });
  const after = store.view();
  assert.deepEqual(after.bots.map(b => b.id), ['mino', 'pixel', 'atlas']);
  assert.deepEqual(after.retiredBotIds, ['nova']);
  const erasedWorks = shown.works.filter(w => w.threadBotId === 'nova').map(w => w.id).sort();
  assert.equal(erasedWorks.length, 2, 'Nova’s own work and Pixel’s guest work in Nova’s thread');
  assert.deepEqual(after.purged, { botIds: ['nova'], workIds: erasedWorks });
  assert.equal(after.erasure, 'complete');
  assert(after.messages.every(m => m.threadBotId !== 'nova'));
  assert.deepEqual(after.messages, shown.messages.filter(m => m.threadBotId !== 'nova'), 'other threads keep every message, its signer and its mentions');
  assert.deepEqual(after.carnet, shown.carnet.filter(p => p.threadBotId !== 'nova'));
  const strip = (w: StoreView['works'][number]) => ({
    ...w,
    next: w.botId === 'nova' ? null : w.next,
    ...(w.id === space.pendingWorkId ? { state: null, updatedAt: null } : {}),
    attempt: w.botId === 'nova' && w.attempt ? { ...w.attempt, plan: null } : w.attempt,
  });
  assert.deepEqual(after.works.map(strip), otherWorks.map(strip));
  assert(after.works.filter(w => w.botId === 'nova').every(w => w.next.kind === 'none'), 'deleted actors no longer offer retry');
  assert.equal(after.works.find(w => w.id === space.pendingWorkId)?.state, 'cancelled', 'a waiting guest call never runs');
  assert.equal(after.works.find(w => w.id === space.novaGuestWorkId)?.attempt?.plan, null, 'its kept attempt no longer describes its memory or settings');
  const pixelShared = after.works.find(w => w.requestMessageId === space.shared.messageId && w.botId === 'pixel');
  assert.notEqual(pixelShared?.attempt?.plan, null, 'other actors keep their plans');
  store.close();

  const kept = rowsOutside(path, 'nova');
  const pendingRow = (rows: unknown[]) => rows.map(row => {
    const record = row as Record<string, unknown>;
    return record.id === space.pendingWorkId ? { ...record, state: null, updated_at: null } : record;
  });
  assert.deepEqual({ ...kept, works: pendingRow(kept.works ?? []) }, { ...before, works: pendingRow(before.works ?? []) }, 'other threads are identical row for row');
  const db = new DatabaseSync(path);
  try {
    const witness = db.prepare('SELECT * FROM bots WHERE id = ?').get('nova');
    assert.equal(witness?.name, 'Bot supprimé');
    assert.equal(witness?.title, '');
    assert.equal(witness?.instructions, '');
    assert.equal(witness?.model, null);
    assert.equal(witness?.shape, '');
    assert(Number(witness?.position) < 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE bot_id = 'nova'`).get()?.n, 0);
    assert.deepEqual(db.prepare(`SELECT memory_ids, context_sha256, context_plan FROM attempts a JOIN works w ON w.id = a.work_id WHERE w.bot_id = 'nova'`).all()
      .map(row => ({ ...row })), [{ memory_ids: '[]', context_sha256: '', context_plan: null }, { memory_ids: '[]', context_sha256: '', context_plan: null }]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM purge_target').get()?.n, 0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    const journal = JSON.stringify(db.prepare('SELECT * FROM commands').all());
    assert.doesNotMatch(journal, /CANARY|"Nova"/);
    for (const id of [space.own.messageId, space.own.workId, space.guestInNova.messageId, space.memory.kind === 'memory' ? space.memory.memoryId : '']) {
      const rows = db.prepare(`SELECT type, fingerprint FROM commands WHERE result LIKE ?`).all(`%${id}%`);
      assert(rows.length > 0 && rows.every(row => row.fingerprint === ''), `receipts citing ${id} are neutralized`);
    }
    const deletion = db.prepare(`SELECT fingerprint FROM commands WHERE type = 'bot.delete'`).get();
    const key = String(db.prepare(`SELECT value FROM meta WHERE key = 'hmac_key'`).get()?.value);
    const byBotOnly = createHmac('sha256', key).update(JSON.stringify({ botId: 'nova', type: 'bot.delete' })).digest('hex');
    assert.equal(deletion?.fingerprint, byBotOnly, 'neither the typed name nor the counters are fingerprinted');
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 11);
  } finally {
    db.close();
  }
  for (const file of managedBackupPaths(path)) assert.equal(existsSync(file), false, `${file} is removed`);
  assert.doesNotMatch(fileText(path), /CANARY/, 'no erased text is left in the database file or its journal');
  assert.equal(existsSync(path + '-wal') ? statSync(path + '-wal').size : 0, 0);

  store = open(path);
  try {
    const restarted = store.view();
    assert.deepEqual({ ...restarted, rev: 0 }, { ...after, rev: 0 }, 'a restart shows the same state and seeds nothing');
    assert.deepEqual(store.dispatch(command, NO_WORKER), { ok: true, replayed: true, result }, 'replaying the deletion converges');
    assert.deepEqual(ok(store.dispatch({ ...command, requestId: rid() }, NO_WORKER)), result, 'deleting it again converges');
    assert.equal(refused(store.dispatch(space.own.command)), 'request_conflict', 'an erased message cannot be replayed back');
    assert.equal(refused(store.dispatch({ type: 'message.send', requestId: rid(), botId: 'nova', text: 'Bonjour', attachments: [] })), 'not_found');
    assert.equal(refused(store.dispatch({ ...space.shared.command, requestId: rid() })), 'not_found', 'an old tag cannot invite the witness again');
    assert.equal(refused(store.dispatch({ type: 'work.retry', requestId: rid(), workId: space.failedWorkId })), 'not_found');
    assert.equal(refused(store.dispatch({ type: 'work.retry', requestId: rid(), workId: space.pendingWorkId })), 'not_found');
    assert.equal(refused(store.dispatch({ type: 'bot.select', requestId: rid(), botId: 'nova' })), 'not_found');
    assert.equal(refused(store.dispatch({ type: 'bot.update', requestId: rid(), botId: 'nova', name: 'Nova' })), 'not_found');
    assert.equal(refused(store.dispatch({ type: 'memory.create', requestId: rid(), botId: 'nova', text: 'retour' })), 'not_found');
    assert.deepEqual({ ...store.view(), rev: 0 }, { ...after, rev: 0 }, 'refusals change nothing');
    send(store, 'mino', 'SUITE');
    const next = claim(store);
    assert.match(next.turn.input, /Bot supprimé : KEEP_NOVA_REPLY/, 'the kept reply still informs the thread, signed by the witness');
    assert.doesNotMatch(next.turn.input, /CANARY/);
    for (let i = 0; i < 17; i += 1) ok(store.dispatch({ type: 'bot.create', requestId: rid(), name: `B${i}`, title: '', shape: 'sprout', color: '#000000' }));
    assert.equal(refused(store.dispatch({ type: 'bot.create', requestId: rid(), name: 'Trop', title: '', shape: 'sprout', color: '#000000' })), 'limit_reached', 'twenty live bots, the witness not counted');
  } finally {
    store.close();
  }
});

test('a confirmation with another name or outdated counters is refused and erases nothing', () => {
  const store = open(tempPath());
  try {
    send(store, 'nova', 'Bonjour');
    const view = store.view();
    const command = deleteCommand(view, 'nova');
    assert.equal(refused(store.dispatch({ ...command, confirmName: 'nova' })), 'stale_base');
    assert.equal(refused(store.dispatch({ ...command, expected: { ...command.expected, messages: 0 } })), 'stale_base');
    send(store, 'nova', 'Encore');
    assert.equal(refused(store.dispatch(command)), 'stale_base', 'the scope grew after the confirmation was shown');
    assert.deepEqual(store.view().bots.map(b => b.id), ['mino', 'pixel', 'atlas', 'nova']);
    ok(store.dispatch(deleteCommand(store.view(), 'nova')));
  } finally {
    store.close();
  }
});

test('a deletion is refused while a call by the bot or in its thread runs or is stopping, and unrelated calls continue', () => {
  const store = open(tempPath());
  try {
    send(store, 'nova', 'Toi');
    const own = claim(store);
    assert.equal(refused(store.dispatch(deleteCommand(store.view(), 'nova'), NO_WORKER)), 'busy', 'the store sees its running attempt');
    ok(store.dispatch({ type: 'work.cancel', requestId: rid(), workId: own.workId }));
    assert.equal(store.view().works.find(w => w.id === own.workId)?.state, 'cancelled');
    assert.equal(refused(store.dispatch(deleteCommand(store.view(), 'nova'), { activeWorkIds: [own.workId] })), 'busy', 'cancelled but the engine has not returned');
    assert.equal(store.finishJob(own, reply('tard')).kind, 'stale');

    send(store, 'nova', '@Pixel invité', [{ botId: 'pixel', tag: '@Pixel' }]);
    const guest = claim(store);
    assert.equal(guest.botId, 'pixel');
    assert.equal(refused(store.dispatch(deleteCommand(store.view(), 'nova'), { activeWorkIds: [guest.workId] })), 'busy', 'a guest call in its thread');
    store.finishJob(guest, reply('ok'));

    send(store, 'mino', '@Nova aide', [{ botId: 'nova', tag: '@Nova' }]);
    const asGuest = claim(store);
    assert.equal(refused(store.dispatch(deleteCommand(store.view(), 'nova'), { activeWorkIds: [asGuest.workId] })), 'busy', 'its own call in another thread');
    store.finishJob(asGuest, reply('ok'));

    send(store, 'atlas', 'Sans rapport');
    const unrelated = claim(store);
    send(store, 'nova', 'En attente');
    const deleted = ok(store.dispatch(deleteCommand(store.view(), 'nova'), { activeWorkIds: [unrelated.workId] }));
    assert.equal(deleted.kind === 'botDeleted' && deleted.erased, true);
    assert.equal(store.finishJob(unrelated, reply('Atlas répond')).kind, 'recorded');
    assert.equal(store.claimNextJob(), null, 'its waiting request is gone with its thread');
  } finally {
    store.close();
  }
});

test('the last bot can be deleted, nothing is reseeded after a restart, and a new bot never revives an old one', () => {
  const path = tempPath();
  let store = open(path);
  for (const id of ['mino', 'pixel', 'atlas', 'nova']) ok(store.dispatch(deleteCommand(store.view(), id)));
  let view = store.view();
  assert.deepEqual(view.bots, []);
  assert.equal(view.activeBotId, '');
  assert.deepEqual(view.retiredBotIds, [], 'bots never referenced elsewhere leave no witness');
  assert.equal(refused(store.dispatch({ type: 'message.send', requestId: rid(), botId: 'mino', text: 'x', attachments: [] })), 'not_found');
  store.close();
  store = open(path);
  assert.deepEqual(store.view().bots, [], 'the initialized marker prevents reseeding');
  const created = ok(store.dispatch({ type: 'bot.create', requestId: rid(), name: 'Mino', title: '', shape: 'sprout', color: '#000000' }));
  assert(created.kind === 'bot' && created.botId !== 'mino');
  store.close();
  store = open(path);
  try {
    view = store.view();
    assert.deepEqual(view.bots.map(b => b.id), [created.kind === 'bot' ? created.botId : '']);
    assert.equal(view.activeBotId, view.bots[0]?.id);
    assert.equal(refused(store.dispatch({ type: 'bot.select', requestId: rid(), botId: 'mino' })), 'not_found');
    assert.deepEqual(view.bots[0]?.memories, []);
  } finally {
    store.close();
  }
});

test('a cleanup failure is reported, retried on request, and resumed before serving after a restart', () => {
  const path = tempPath();
  let store = open(path);
  const backup = path + '.pre-v2';
  const block = () => {
    rmSync(backup, { recursive: true, force: true });
    mkdirSync(backup);
    writeFileSync(join(backup, 'occupé'), 'x');
  };
  block();
  send(store, 'pixel', 'PRIVATE_PIXEL');
  store.finishJob(claim(store), reply('PRIVATE_PIXEL_REPLY'));
  const first = ok(store.dispatch(deleteCommand(store.view(), 'pixel')));
  assert.deepEqual(first, { kind: 'botDeleted', botId: 'pixel', nextBotId: 'mino', erased: false }, 'never reported as erased before the cleanup');
  assert.equal(store.view().erasure, 'incomplete');
  assert.deepEqual(store.view().bots.map(b => b.id), ['mino', 'atlas', 'nova'], 'the logical deletion is committed');
  assert.deepEqual(ok(store.dispatch({ type: 'storage.purge', requestId: rid() })), { kind: 'purge', erased: false });
  rmSync(backup, { recursive: true });
  assert.deepEqual(ok(store.dispatch({ type: 'storage.purge', requestId: rid() })), { kind: 'purge', erased: true });
  assert.equal(store.view().erasure, 'complete');
  assert.doesNotMatch(fileText(path), /PRIVATE_PIXEL/);

  block();
  ok(store.dispatch(deleteCommand(store.view(), 'atlas')));
  assert.equal(store.view().erasure, 'incomplete');
  store.close();
  rmSync(backup, { recursive: true });
  writeFileSync(backup, 'ancienne sauvegarde');
  store = open(path);
  try {
    assert.equal(store.view().erasure, 'complete', 'the pending cleanup ran while opening');
    assert.equal(existsSync(backup), false);
    assert.deepEqual(ok(store.dispatch({ type: 'storage.purge', requestId: rid() })), { kind: 'purge', erased: true }, 'nothing left to do');
  } finally {
    store.close();
  }
});

test('the delete guards only let through rows listed for the current deletion, and an old schema cannot reinstate the old rules', () => {
  const path = tempPath();
  let store = open(path);
  richSpace(store);
  ok(store.dispatch(deleteCommand(store.view(), 'nova')));
  store.close();
  const v2Schema = /const SCHEMA = `([\s\S]*?)`;/.exec(readFileSync(new URL('../../src/store.ts', import.meta.url), 'utf8'))?.[1] ?? '';
  assert.match(v2Schema, /CREATE TRIGGER IF NOT EXISTS messages_kept/);
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys=ON');
    db.exec(readFileSync(new URL('../../test/fixtures/schema-v0.sql', import.meta.url), 'utf8'));
    db.exec(v2Schema);
    const kept = db.prepare(`SELECT id FROM messages WHERE bot_id = 'nova'`).get()?.id;
    assert.equal(typeof kept, 'string');
    db.prepare('INSERT INTO purge_target VALUES (?, ?)').run('messages', String(kept));
    assert.throws(() => db.exec(`DELETE FROM messages WHERE role = 'assistant'`), /messages are immutable/, 'one listed row does not open the table');
    assert.throws(() => db.exec(`DELETE FROM messages WHERE bot_id = 'pixel' AND role = 'user'`), /immutable/);
    assert.throws(() => db.exec(`DELETE FROM purge_target; INSERT INTO purge_target VALUES ('works', 'other'); DELETE FROM works WHERE bot_id = 'nova'`), /works are kept/);
    for (const [table, message] of [['versions', /immutable/], ['proposals', /kept/], ['decisions', /immutable/], ['publications', /immutable/], ['attempts', /kept/], ['attachments', /kept/], ['message_mentions', /immutable/], ['bots', /kept/]] as const) {
      assert.throws(() => db.exec(`DELETE FROM ${table}`), message, table);
    }
    assert.throws(() => db.exec(`UPDATE bots SET deleted_at = NULL, name = 'Nova' WHERE id = 'nova'`), /cannot change/);
    assert.throws(() => db.exec(`UPDATE works SET state = 'pending' WHERE bot_id = 'nova'`), /bot is deleted/);
    assert.throws(() => db.exec(`INSERT INTO memories(id, bot_id, text, created_at, updated_at) VALUES ('m', 'nova', 'x', 'n', 'n')`), /bot is deleted/);
    db.exec('DELETE FROM purge_target');
    for (const name of ['messages_kept', 'mentions_kept', 'versions_kept', 'proposals_kept', 'decisions_kept', 'publications_kept']) {
      assert.match(String(db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name)?.sql), /purge_target/, `${name} keeps its keyed exception`);
    }
  } finally {
    db.close();
  }
  store = open(path);
  try {
    const result = ok(store.dispatch(deleteCommand(store.view(), 'mino')));
    assert.equal(result.kind === 'botDeleted' && result.erased, true, 'a later deletion still works through the keyed exception');
    assert.equal(store.view().messages.filter(m => m.botId === 'nova').length, 0, 'Nova’s kept reply lived in Mino’s thread and goes with it');
    assert.deepEqual(store.view().retiredBotIds, ['nova'], 'Mino was never named elsewhere, so it leaves no witness; Nova still signs other threads');
  } finally {
    store.close();
  }
});


test('an anonymous witness disappears when the last thread retaining its guest contribution is erased', () => {
  const store = open(tempPath());
  send(store, 'nova', '@Pixel SHARED', [{botId:'pixel',tag:'@Pixel'}]);
  store.finishJob(claim(store), reply('A guest answer'));
  ok(store.dispatch(deleteCommand(store.view(), 'pixel')));
  assert(store.view().retiredBotIds.includes('pixel'));
  ok(store.dispatch(deleteCommand(store.view(), 'nova')));
  assert.deepEqual(store.view().retiredBotIds, []);
  store.close();
});

test('a previously accepted retry of a retained guest work is refused after the actor is deleted', () => {
  const store = open(tempPath());
  const sent = send(store, 'mino', '@Nova SHARED', [{botId:'nova',tag:'@Nova'}]);
  store.finishJob(claim(store), engineFailure('usage_limit'));
  const retry = {type:'work.retry',requestId:rid(),workId:sent.workId};
  ok(store.dispatch(retry));
  ok(store.dispatch(deleteCommand(store.view(), 'nova')));
  assert.equal(refused(store.dispatch(retry)), 'request_conflict');
  assert.equal(store.view().works.find(w=>w.id===sent.workId)?.state, 'cancelled');
  assert.equal(store.claimNextJob(), null);
  store.close();
});

test('a checkpoint error after erased content is already flushed does not report an unfinished deletion', () => {
  const store = open(tempPath());
  send(store, 'nova', 'PRIVATE');
  store.finishJob(claim(store), reply('PRIVATE_REPLY'));
  const original = DatabaseSync.prototype.prepare;
  let checkpoints = 0;
  let restoreCheckpoint = () => {};
  const mocked = mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
    const statement = original.call(this, sql);
    if (sql === 'PRAGMA wal_checkpoint(TRUNCATE)') {
      const get = statement.get.bind(statement);
      const checkpoint = mock.method(statement, 'get', () => {
        if (++checkpoints === 2) throw new Error('Injected checkpoint I/O failure');
        return get();
      });
      restoreCheckpoint = () => checkpoint.mock.restore();
    }
    return statement;
  });
  try {
    const result = ok(store.dispatch(deleteCommand(store.view(), 'nova')));
    assert(result.kind === 'botDeleted' && result.erased);
    assert.equal(checkpoints, 2);
    assert.equal(store.view().erasure, 'complete');
    assert(!store.view().messages.some(m=>m.threadBotId==='nova'));
  } finally {
    restoreCheckpoint();
    mocked.mock.restore();
    store.close();
  }
});
