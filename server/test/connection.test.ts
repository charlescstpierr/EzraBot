import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { toolkitOf } from '../src/connection.js';
import { CONNECTING_MINO_OUTPUT_SCHEMA, CONNECTING_OUTPUT_SCHEMA, MINO_OUTPUT_SCHEMA, OPINION_SCHEMA, OUTPUT_SCHEMA, composeContext, type ContextSource } from '../src/context.js';
import { loadMascots, parseEngineReply, type EngineOutcome } from '../src/domain.js';
import { openStore, type Claim, type Store } from '../src/store.js';
import type { LiveFacts } from '../src/tool-ledger.js';
import { ACCOUNT_A, SEND_EMAIL } from './fixtures/fake-composio.js';

const mascots = loadMascots(new URL('../../assets/mascots.json', import.meta.url));
const tempPath = () => join(mkdtempSync(join(tmpdir(), 'mino-connection-')), 'mino.sqlite');
const rid = () => randomUUID();
const LIVE: LiveFacts = { account: ACCOUNT_A, tools: [SEND_EMAIL] };
const SLACK_ACCOUNT = { id: 'ca_synthetique_slack', toolkit: 'slack', alias: 'Messagerie synthétique', status: 'ACTIVE' } as const;

const reply = (service: string | null, deliverable: { title: string; body: string } | null = null): EngineOutcome => ({
  kind: 'succeeded', reply: { reply: 'Réponse synthétique.', deliverable, connection: service === null ? null : { service } },
  used: { model: 'gpt-test', effort: 'low', speed: 'standard' }, threadId: 'thread-1', turnId: 'turn-1',
});

function claimFor(store: Store, botId = 'nova', text = 'Lis mes courriels'): Claim {
  const sent = store.dispatch({ type: 'message.send', requestId: rid(), botId, text, attachments: [] });
  assert.equal(sent.ok, true);
  const claim = store.claimNext('chat');
  assert(claim, 'the message is claimable');
  return claim;
}

function turn(store: Store, service: string | null, botId = 'nova'): Claim {
  const claim = claimFor(store, botId);
  assert.equal(store.finishJob(claim, reply(service)).kind, 'recorded');
  return claim;
}

const requests = (store: Store) => store.tools.view({ state: 'ready' }).connections;
const replyOf = (store: Store, claim: Claim) => store.view().messages.find(message => message.workId === claim.workId && message.role === 'assistant');

test('a chat reply that names a service records one connection request under that reply, with no link, account, right or second copy', () => {
  const store = openStore({ path: tempPath(), mascots, serviceTools: true });
  try {
    const claim = claimFor(store);
    assert.equal(claim.turn.outputSchema, CONNECTING_OUTPUT_SCHEMA, 'the turn may propose a connection');
    assert.match(claim.turn.baseInstructions, /`connection` : null, sauf si la demande exige un service externe/);
    assert.match(claim.turn.baseInstructions, /Tu n’as ni outil ni accès externe/, 'a bot without a right still has no tool');
    assert.deepEqual(claim.toolGrants, []);

    assert.equal(store.finishJob(claim, reply('  Gmail ')).kind, 'recorded');
    const message = replyOf(store, claim);
    assert(message);
    const [request, ...others] = requests(store);
    assert.deepEqual(others, []);
    assert.deepEqual({ ...request, id: '', createdAt: '' }, { id: '', botId: 'nova', messageId: message.id, toolkit: 'gmail', link: null, createdAt: '' });
    assert.match(request?.id ?? '', /^tc_/);
    const shared = JSON.stringify(store.view());
    assert(request && !shared.includes(request.id) && !('connection' in message), 'the view a phone is built from carries the reply text and nothing of the request');

    assert.equal(store.finishJob(claim, reply('slack')).kind, 'stale', 'a second end of the same turn is refused');
    assert.deepEqual(requests(store).map(r => r.toolkit), ['gmail']);
    const tools = store.tools.view({ state: 'ready' });
    assert.deepEqual([tools.accounts, tools.links, tools.grants, tools.proposals], [[], [], {}, []], 'proposing connects nothing and grants nothing');
    assert.deepEqual(store.tools.grantsFor('nova'), []);
  } finally {
    store.close();
  }
});

test('a name that cannot be a catalogue identifier records nothing and the reply is kept', () => {
  assert.deepEqual(['Gmail', ' google_calendar ', 'one-drive'].map(toolkitOf), ['gmail', 'google_calendar', 'one-drive']);
  const store = openStore({ path: tempPath(), mascots, serviceTools: true });
  try {
    for (const service of ['COMPOSIO_MANAGE_CONNECTIONS', 'composio_search', 'deux mots', '', '../gmail', 'https://exemple.invalid/x', 'g'.repeat(64), 'gmail;drop']) {
      const claim = turn(store, service);
      assert(replyOf(store, claim), `the reply of « ${service} » is recorded`);
    }
    assert.deepEqual(requests(store), []);
  } finally {
    store.close();
  }
});

test('the engine reply accepts a proposal, its absence and null, and refuses any extra field in it', () => {
  const base = { reply: 'Bonjour.', deliverable: null };
  assert.deepEqual(parseEngineReply(JSON.stringify(base)), base);
  assert.deepEqual(parseEngineReply(JSON.stringify({ ...base, connection: null })), { ...base, connection: null });
  assert.deepEqual(parseEngineReply(JSON.stringify({ ...base, connection: { service: 'gmail' } }))?.connection, { service: 'gmail' });
  assert.equal(parseEngineReply(JSON.stringify({ ...base, connection: { service: 'gmail', accountId: 'ca_1' } })), null);
  assert.equal(parseEngineReply(JSON.stringify({ ...base, connection: { service: 'gmail', redirectUrl: 'https://exemple.invalid' } })), null);
  assert.equal(parseEngineReply(JSON.stringify({ ...base, connection: 'gmail' })), null);
});

test('without a provider key, in a receipt turn and in a document turn, a proposal is neither offered nor recorded', () => {
  const keyless = openStore({ path: tempPath(), mascots });
  try {
    const claim = claimFor(keyless);
    assert.equal(claim.turn.outputSchema, OUTPUT_SCHEMA);
    assert.doesNotMatch(claim.turn.baseInstructions, /connection/);
    assert.equal(keyless.finishJob(claim, reply('gmail')).kind, 'recorded');
    assert.deepEqual(requests(keyless), []);
  } finally {
    keyless.close();
  }

  const store = openStore({ path: tempPath(), mascots, serviceTools: true });
  try {
    assert.equal(store.tools.apply({ type: 'tools.grant', requestId: rid(), botId: 'nova', accountId: ACCOUNT_A.id, toolSlugs: ['GMAIL_SEND_EMAIL'] }, LIVE).ok, true);
    const proposing = claimFor(store);
    assert.equal(proposing.turn.outputSchema, CONNECTING_OUTPUT_SCHEMA, 'a bot with rights may still propose another service');
    assert.equal(store.tools.propose(proposing, { callId: 'call-1', tool: 'GMAIL_SEND_EMAIL', arguments: { to: 'personne@exemple.invalid', subject: 'Bonjour', body: 'Texte.' } }).success, true);
    store.finishJob(proposing, reply(null));
    const proposal = store.tools.view({ state: 'ready' }).proposals.at(-1);
    assert(proposal);
    const approved = store.tools.apply({ type: 'tools.approve', requestId: rid(), proposalId: proposal.id, fingerprint: proposal.fingerprint }, LIVE);
    assert(approved.ok && approved.result.kind === 'decision' && approved.result.executionId);
    const permit = store.tools.claimDispatch(approved.result.executionId, { kind: 'found', account: ACCOUNT_A });
    assert(permit);
    store.tools.settle(permit, { kind: 'completed', data: {}, error: null, logId: 'log_1' });

    const report = store.claimNext('chat');
    assert.equal(report?.purpose.kind, 'receipt');
    assert(report);
    assert.equal(report.turn.outputSchema, OPINION_SCHEMA);
    assert.doesNotMatch(report.turn.baseInstructions, /`connection`/);
    assert.equal(store.finishJob(report, reply('slack')).kind, 'recorded');

    const asked = store.dispatch({ type: 'message.send', requestId: rid(), botId: 'nova', text: 'Rédige une invitation', attachments: [], document: { reviewerBotId: null } });
    assert.equal(asked.ok, true);
    const draft = store.claimNext('doc');
    assert(draft);
    assert.doesNotMatch(draft.turn.baseInstructions, /`connection`/);
    assert.equal(store.finishJob(draft, reply('slack', { title: 'Invitation', body: 'Viens samedi.' })).kind, 'recorded');
    assert.deepEqual(requests(store), [], 'neither the receipt nor the document turn recorded a request');
  } finally {
    store.close();
  }
});

test('composing a turn offers the field only to an ordinary chat request, and Mino keeps its handoff beside it', () => {
  const source: ContextSource = {
    bot: { name: 'Nova', title: '', instructions: '', replyStyle: 'normal', contextSize: 'standard' },
    memories: [], exchanges: [], request: { text: 'Lis mes courriels', attachments: [] },
  };
  const plain = composeContext(source);
  const offered = composeContext({ ...source, connections: true });
  assert.equal(plain.turn.outputSchema, OUTPUT_SCHEMA);
  assert.equal(offered.turn.outputSchema, CONNECTING_OUTPUT_SCHEMA);
  assert.deepEqual(CONNECTING_OUTPUT_SCHEMA.required, ['reply', 'deliverable', 'connection']);
  assert.notEqual(plain.sha256, offered.sha256);
  assert.equal(plain.turn.input, offered.turn.input, 'no account, catalogue or link ever reaches the input');

  const mino = composeContext({ ...source, orchestrator: true, connections: true });
  assert.equal(mino.turn.outputSchema, CONNECTING_MINO_OUTPUT_SCHEMA);
  assert.deepEqual(CONNECTING_MINO_OUTPUT_SCHEMA.required, ['reply', 'deliverable', 'handoff', 'connection']);
  assert.equal(composeContext({ ...source, orchestrator: true }).turn.outputSchema, MINO_OUTPUT_SCHEMA);

  const receipt = composeContext({ ...source, connections: true, receipt: {
    priorReply: 'Je propose.', toolkit: 'gmail', accountAlias: 'Compte', toolSlug: 'GMAIL_SEND_EMAIL', version: '1', arguments: '{}', state: 'completed', category: null, logId: null, summary: null,
  } });
  assert.equal(receipt.turn.outputSchema, OPINION_SCHEMA);
  assert.doesNotMatch(receipt.turn.baseInstructions, /`connection`/);
});

test('a request shows the link the person started and follows only what the provider reported for it; connecting grants nothing', () => {
  const store = openStore({ path: tempPath(), mascots, serviceTools: true });
  try {
    turn(store, 'gmail');
    const [request] = requests(store);
    assert(request);

    store.tools.recordLink({ linkId: 'tl_1', toolkit: 'gmail', accountId: ACCOUNT_A.id, connectionId: request.id });
    assert.deepEqual(requests(store)[0]?.link, { id: 'tl_1', toolkit: 'gmail', accountId: ACCOUNT_A.id, state: 'pending', createdAt: requests(store)[0]?.link?.createdAt },
      'a started link is pending until the provider is read');

    store.tools.observeAccount({ ...ACCOUNT_A, status: 'INITIATED' });
    assert.equal(requests(store)[0]?.link?.state, 'pending');
    store.tools.observeAccount(ACCOUNT_A);
    assert.equal(requests(store)[0]?.link?.state, 'active');
    assert.deepEqual([store.tools.grantsFor('nova'), store.tools.view({ state: 'ready' }).grants], [[], {}], 'a connected account gives the bot no right');

    const next = claimFor(store);
    assert.deepEqual(next.toolGrants, [], 'the next turn still has no tool');
    assert.match(next.turn.baseInstructions, /Tu n’as ni outil ni accès externe/);
    const sent = next.turn.baseInstructions + next.turn.input;
    for (const secret of [ACCOUNT_A.id, ACCOUNT_A.alias, 'tl_1', request.id]) assert(!sent.includes(secret), `${secret} never reaches the model`);
    store.finishJob(next, reply(null));

    store.tools.recordLink({ linkId: 'tl_2', toolkit: 'gmail', accountId: 'ca_synthetique_b', connectionId: request.id });
    assert.deepEqual([requests(store)[0]?.link?.id, requests(store)[0]?.link?.state], ['tl_2', 'pending'], 'a new start replaces the link shown and starts pending');
    store.tools.observeAccount({ id: 'ca_synthetique_b', toolkit: 'gmail', alias: 'Compte B', status: 'FAILED' });
    assert.equal(requests(store)[0]?.link?.state, 'failed');

    store.tools.observeAccount(SLACK_ACCOUNT);
    assert.throws(() => store.tools.recordLink({ linkId: 'tl_3', toolkit: 'slack', accountId: SLACK_ACCOUNT.id, connectionId: request.id }), /only takes a link of its own service/);
    assert.equal(store.tools.link('tl_3'), null, 'the refused attachment leaves no link behind');
    assert.equal(requests(store)[0]?.link?.id, 'tl_2');

    store.tools.recordLink({ linkId: 'tl_4', toolkit: 'gmail', accountId: ACCOUNT_A.id, connectionId: 'tc_absente' });
    assert.equal(store.tools.link('tl_4')?.state, 'pending', 'a link whose request is gone is still kept for the preferences');
    assert.deepEqual(store.tools.view({ state: 'missing_key' }).connections, [], 'without a key no card is served');
  } finally {
    store.close();
  }
});

test('the database itself keeps a request frozen: its source, its service, its link and its deletion are guarded', () => {
  const path = tempPath();
  const store = openStore({ path, mascots, serviceTools: true });
  turn(store, 'gmail');
  const running = claimFor(store);
  store.tools.recordLink({ linkId: 'tl_gmail', toolkit: 'gmail', accountId: ACCOUNT_A.id });
  store.tools.recordLink({ linkId: 'tl_slack', toolkit: 'slack', accountId: SLACK_ACCOUNT.id });
  const [request] = requests(store);
  assert(request);
  store.close();

  const db = new DatabaseSync(path);
  try {
    const insert = (attemptId: string, workId: string, toolkit: string, linkId: string | null) => db
      .prepare(`INSERT INTO tool_connections(id, bot_id, work_id, attempt_id, toolkit, link_id, created_at) VALUES (?, 'nova', ?, ?, ?, ?, '2026-11-14T00:00:00.000Z')`)
      .run(`tc_${randomUUID()}`, workId, attemptId, toolkit, linkId);
    assert.throws(() => insert(running.attemptId, running.workId, 'gmail', null), /comes from the recorded reply of a chat turn/, 'a running turn has no request');
    const done = db.prepare(`SELECT a.id, a.work_id FROM attempts a WHERE a.state = 'succeeded'`).get();
    assert.throws(() => insert(String(done?.id), String(done?.work_id), 'gmail', null), /UNIQUE constraint failed/, 'one request per turn');
    for (const toolkit of ['Gmail', 'composio_manage', 'deux mots', '']) {
      assert.throws(() => db.prepare('UPDATE tool_connections SET toolkit = ? WHERE id = ?').run(toolkit, request.id), /CHECK constraint failed|only takes a link/);
    }
    assert.throws(() => db.prepare(`UPDATE tool_connections SET toolkit = 'slack' WHERE id = ?`).run(request.id), /only takes a link of its own service/);
    assert.throws(() => db.prepare(`UPDATE tool_connections SET link_id = 'tl_slack' WHERE id = ?`).run(request.id), /only takes a link of its own service/);
    assert.throws(() => db.prepare(`UPDATE tool_connections SET link_id = 'tl_absent' WHERE id = ?`).run(request.id), /only takes a link of its own service|FOREIGN KEY/);
    assert.throws(() => db.prepare(`UPDATE tool_connections SET bot_id = 'mino' WHERE id = ?`).run(request.id), /only takes a link of its own service/);
    assert.equal(db.prepare(`UPDATE tool_connections SET link_id = 'tl_gmail' WHERE id = ?`).run(request.id).changes, 1);
    assert.throws(() => db.prepare(`UPDATE tool_connections SET link_id = NULL WHERE id = ?`).run(request.id), /only takes a link of its own service/, 'a request never forgets its link');
    assert.throws(() => db.prepare('DELETE FROM tool_connections WHERE id = ?').run(request.id), /connection requests are kept/);
  } finally {
    db.close();
  }
});

test('deleting a bot erases its requests and keeps the link and the account of the space', () => {
  const path = tempPath();
  const store = openStore({ path, mascots, serviceTools: true });
  try {
    turn(store, 'gmail');
    turn(store, 'slack', 'mino');
    const [request] = requests(store);
    assert(request);
    store.tools.recordLink({ linkId: 'tl_1', toolkit: 'gmail', accountId: ACCOUNT_A.id, connectionId: request.id });
    store.tools.observeAccount(ACCOUNT_A);

    const nova = store.view().bots.find(bot => bot.id === 'nova');
    assert(nova);
    const deleted = store.dispatch({ type: 'bot.delete', requestId: rid(), botId: 'nova', confirmName: nova.name, expected: nova.deletion });
    assert.equal(deleted.ok, true, deleted.ok ? '' : deleted.message);
    assert.deepEqual(requests(store).map(r => [r.botId, r.toolkit]), [['mino', 'slack']]);
    assert.equal(store.tools.link('tl_1')?.state, 'active');
    assert.equal(store.tools.account(ACCOUNT_A.id)?.status, 'ACTIVE');
  } finally {
    store.close();
  }
  const db = new DatabaseSync(path);
  try {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM tool_connections WHERE bot_id = 'nova'`).get()?.n, 0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});

test('a database of an older version gains the request table with valid links and can record a request', () => {
  const path = tempPath();
  const old = new DatabaseSync(path);
  old.exec(readFileSync(new URL('../../test/fixtures/schema-v6.sql', import.meta.url), 'utf8'));
  assert.equal(old.prepare('PRAGMA user_version').get()?.user_version, 6);
  old.close();

  const store = openStore({ path, mascots, serviceTools: true });
  try {
    turn(store, 'gmail');
    assert.deepEqual(requests(store).map(r => [r.toolkit, r.link]), [['gmail', null]]);
  } finally {
    store.close();
  }
  const db = new DatabaseSync(path);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 12);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    const guards = db.prepare(`SELECT name FROM sqlite_master WHERE tbl_name = 'tool_connections' AND type = 'trigger' ORDER BY name`).all().map(row => String(row.name));
    assert.deepEqual(guards, ['tool_connections_frozen', 'tool_connections_kept', 'tool_connections_source']);
  } finally {
    db.close();
  }
});
