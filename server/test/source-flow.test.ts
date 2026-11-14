import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { z } from 'zod';
import { DEFAULT_POLICY } from '../src/admission.js';
import type { PcView, ToolProposalView } from '../src/tools-protocol.js';
import { SEND_EMAIL, createFakeProvider } from './fixtures/fake-composio.js';
import { find, rid, start } from './fixtures/tools-app.js';

// From a saved document version to a service action, with the same real parts as tools-flow.test.ts:
// SQLite store, worker, local HTTP, both engines speaking to a fake App Server, and the desk speaking to a fake provider.
// The fake chat engine copies the version it was given into the body of the action. Everything is synthetic.

type App = Awaited<ReturnType<typeof start>>;
type Source = { workId: string; versionId: string };

const V1 = 'Viens samedi.';

const code = async (response: Response): Promise<string> => z.object({ code: z.string() }).parse(await response.json()).code;

const versionsOf = (view: PcView, workId: string) => view.works.find(work => work.id === workId)?.versions ?? [];

/** A document written by the real document lane. Its first version is the fake engine's text. */
async function document(app: App) {
  const tasks = (await app.view()).tasks.length;
  const sent = await app.post('/api/commands', { type: 'message.send', requestId: rid(), botId: 'nova', text: 'Rédige une invitation', attachments: [], document: { reviewerBotId: null } });
  assert.equal(sent.status, 200);
  const written = await app.until(v => v.tasks.length > tasks && v.tasks.at(-1)?.status === 'finished', 'the document task finishes');
  const task = written.tasks.at(-1);
  assert(task);
  const first = versionsOf(written, task.authorWorkId)[0];
  assert(first);
  assert.equal(first.body, V1);
  return { taskId: task.id, workId: task.authorWorkId, v1: first.id };
}

/** The person saves a new version in the editor. */
async function edit(app: App, doc: { taskId: string; workId: string }, body: string): Promise<string> {
  const head = versionsOf(await app.view(), doc.workId).at(-1);
  assert(head);
  const saved = await app.post('/api/commands', { type: 'task.edit', requestId: rid(), taskId: doc.taskId, baseVersionId: head.id, title: 'Invitation', body });
  assert.equal(saved.status, 200, await saved.clone().text());
  const now = versionsOf(await app.view(), doc.workId).at(-1);
  assert(now);
  assert.equal(now.body, body);
  return now.id;
}

const ask = (app: App, source: Source, text: string, extra: Record<string, unknown> = {}) =>
  app.post('/api/commands', { type: 'message.send', requestId: rid(), botId: 'nova', text, attachments: [], source, ...extra });

/** The person prepares an action from this version, and the bot proposes one. */
async function prepared(app: App, source: Source, text = 'Envoie cette version'): Promise<ToolProposalView> {
  const before = (await app.view()).tools.proposals.length;
  const sent = await ask(app, source, text);
  assert.equal(sent.status, 200, await sent.clone().text());
  const found = (await app.until(v => v.tools.proposals.length > before, `a proposal for « ${text} »`)).tools.proposals.at(-1);
  assert(found);
  return found;
}

/** The approval is committed as the route commits it, without waking the desk: the instant between the decision and the send. */
function approveQuietly(app: App, proposal: ToolProposalView): void {
  const account = app.provider?.accounts.get(proposal.accountId);
  assert(account);
  assert.equal(app.store.tools.apply({ type: 'tools.approve', requestId: rid(), proposalId: proposal.id, fingerprint: proposal.fingerprint }, { account, tools: [SEND_EMAIL] }).ok, true);
}

async function drained(app: App): Promise<PcView> {
  app.desk.kick();
  await app.desk.idle();
  return app.view();
}

test('a saved version chosen in the reader becomes the source of one exact action: nothing leaves before the approval, one send after, reported in the same thread', async () => {
  const app = await start();
  assert(app.provider);
  try {
    const doc = await document(app);
    await app.connect();
    const open = await prepared(app, { workId: doc.workId, versionId: doc.v1 });

    assert.deepEqual([open.state, open.botId, open.threadBotId, open.toolSlug], ['open', 'nova', 'nova', 'GMAIL_SEND_EMAIL']);
    assert.deepEqual(open.source && [open.source.workId, open.source.versionId, open.source.versionN, open.source.headN, open.source.title, open.source.state],
      [doc.workId, doc.v1, 1, 1, 'Invitation', 'holds']);
    assert.match(open.source?.contentSha256 ?? '', /^[0-9a-f]{64}$/);
    assert.equal(open.arguments.body, V1, 'the turn received the chosen version, complete');
    const before = await app.view();
    const request = before.messages.find(m => m.workId === open.workId && m.role === 'user');
    assert.deepEqual(before.tools.sources.map(s => s.messageId), [request?.id], 'the request shows the version it was prepared from');
    assert.equal(app.provider.sent.length, 0, 'preparing sends nothing');

    assert.equal((await app.approve(open)).status, 200);
    const done = await app.until(v => find(v, open.id).execution?.report === 'done', 'the receipt is reported');
    assert.equal(find(done, open.id).execution?.state, 'completed');
    assert.equal(app.provider.sent.length, 1, 'one approval, one send');
    assert.deepEqual(app.provider.sent[0]?.args, open.arguments);
    assert.equal(done.messages.filter(m => m.workId === open.workId && m.role === 'assistant' && m.threadBotId === 'nova').length, 2, 'the proposal and its report are in the thread of the document');

    await edit(app, doc, 'Viens dimanche.');
    const after = await app.view();
    assert.deepEqual([find(after, open.id).state, find(after, open.id).execution?.state], ['approved', 'completed'], 'a later version changes nothing of an action already sent');
    assert.equal(find(after, open.id).source?.state, 'changed', 'and the card says the document moved on since');
    assert.equal(app.provider.sent.length, 1);
  } finally {
    await app.stop();
  }
});

test('an older version chosen on purpose stays the source: the card names it and the head of that moment, and the action carries its text, not the latest', async () => {
  const app = await start();
  assert(app.provider);
  try {
    const doc = await document(app);
    const v2 = await edit(app, doc, 'Viens dimanche.');
    await app.connect();

    const old = await prepared(app, { workId: doc.workId, versionId: doc.v1 }, 'Envoie la première version');
    assert.deepEqual(old.source && [old.source.versionId, old.source.versionN, old.source.headN, old.source.state], [doc.v1, 1, 2, 'holds']);
    assert.equal(old.arguments.body, V1, 'version 1 is not replaced by the head');

    const head = await prepared(app, { workId: doc.workId, versionId: v2 }, 'Envoie la version actuelle');
    assert.deepEqual(head.source && [head.source.versionId, head.source.versionN, head.source.headN], [v2, 2, 2]);
    assert.equal(head.arguments.body, 'Viens dimanche.');
    assert.notEqual(old.fingerprint, head.fingerprint);

    assert.equal((await app.approve(old)).status, 200);
    await app.until(v => find(v, old.id).execution?.state === 'completed', 'the older version is sent');
    assert.deepEqual(app.provider.sent.map(s => s.args.body), [V1]);

    await edit(app, doc, 'Viens lundi.');
    const moved = await app.view();
    assert.deepEqual([find(moved, head.id).state, find(moved, head.id).staleReason], ['stale', 'source_changed'], 'a third version closes what was prepared under the second');
    assert.equal(app.provider.sent.length, 1);
  } finally {
    await app.stop();
  }
});

test('a new version or a withdrawn right after the preparation closes the open action: approving it sends nothing', async () => {
  const app = await start();
  assert(app.provider);
  try {
    const doc = await document(app);
    await app.connect();

    const edited = await prepared(app, { workId: doc.workId, versionId: doc.v1 }, 'Avant une modification');
    const v2 = await edit(app, doc, 'Viens dimanche.');
    const stale = find(await app.view(), edited.id);
    assert.deepEqual([stale.state, stale.staleReason, stale.source?.state, stale.execution], ['stale', 'source_changed', 'changed', null]);
    const refused = await app.approve(edited);
    assert.deepEqual([refused.status, await code(refused)], [409, 'proposal_closed']);

    const revoked = await prepared(app, { workId: doc.workId, versionId: v2 }, 'Avant un retrait de droit');
    const grantId = (await app.view()).tools.grants.nova?.[0]?.id ?? '';
    assert.equal((await app.command({ type: 'tools.revoke', botId: 'nova', grantId })).status, 200);
    assert.deepEqual([find(await app.view(), revoked.id).state, find(await app.view(), revoked.id).staleReason], ['stale', 'grant_changed']);
    assert.equal((await app.approve(revoked)).status, 409);

    await drained(app);
    assert.equal(app.provider.sent.length, 0);
  } finally {
    await app.stop();
  }
});

test('a new version or a withdrawn right after the approval and before the send voids the action: nothing leaves', async () => {
  const app = await start();
  assert(app.provider);
  try {
    const doc = await document(app);
    await app.connect();

    const edited = await prepared(app, { workId: doc.workId, versionId: doc.v1 }, 'Approuvée puis document modifié');
    approveQuietly(app, edited);
    const v2 = await edit(app, doc, 'Viens dimanche.');
    const first = find(await drained(app), edited.id).execution;
    assert.deepEqual([first?.state, first?.category, first?.report], ['voided', 'source_changed', 'none']);

    const revoked = await prepared(app, { workId: doc.workId, versionId: v2 }, 'Approuvée puis droit retiré');
    approveQuietly(app, revoked);
    const grantId = (await app.view()).tools.grants.nova?.[0]?.id ?? '';
    assert.equal((await app.command({ type: 'tools.revoke', botId: 'nova', grantId })).status, 200);
    const second = find(await drained(app), revoked.id).execution;
    assert.deepEqual([second?.state, second?.category, second?.report], ['voided', 'grant_changed', 'none']);

    assert.equal(app.provider.sent.length, 0);
    assert.deepEqual(app.store.admission.usage().find(row => row.budget === 'composio')?.calls, 0, 'a voided action took no place in the budget');
  } finally {
    await app.stop();
  }
});

test('the approval and the last check before the send read the source again: a frozen version whose text no longer matches, or that is gone, is never sent', async () => {
  const provider = createFakeProvider();
  const first = await start({ provider });
  const altered = await document(first);
  const lost = await document(first);
  const undecided = await document(first);
  await first.connect();
  const changed = await prepared(first, { workId: altered.workId, versionId: altered.v1 }, 'Texte modifié sous l’approbation');
  const missing = await prepared(first, { workId: lost.workId, versionId: lost.v1 }, 'Source disparue sous l’approbation');
  const open = await prepared(first, { workId: undecided.workId, versionId: undecided.v1 }, 'Texte modifié avant l’approbation');
  approveQuietly(first, changed);
  approveQuietly(first, missing);
  await first.stop();

  // What no command of Mino can do: the triggers and the foreign key that protect a saved version and a frozen source are removed by hand.
  const db = new DatabaseSync(first.path);
  assert.throws(() => db.prepare('DELETE FROM message_sources WHERE version_id = ?').run(lost.v1), /sources are kept/);
  db.exec('PRAGMA foreign_keys=OFF; DROP TRIGGER versions_immutable; DROP TRIGGER message_sources_kept;');
  for (const versionId of [altered.v1, undecided.v1]) db.prepare('UPDATE versions SET body = ? WHERE id = ?').run('Texte changé hors de Mino.', versionId);
  db.prepare('DELETE FROM message_sources WHERE version_id = ?').run(lost.v1);
  db.close();

  const second = await start({ provider, path: first.path });
  try {
    const decided = await second.approve(open);
    assert.equal(decided.status, 200);
    assert.deepEqual(z.object({ result: z.object({ decision: z.string(), staleReason: z.string().nullable() }) }).parse(await decided.json()).result, { decision: 'stale', staleReason: 'source_changed' });
    const view = await drained(second);
    assert.equal(find(view, open.id).execution, null);
    for (const proposal of [changed, missing]) {
      const execution = find(view, proposal.id).execution;
      assert.deepEqual([execution?.state, execution?.category], ['voided', 'source_changed'], proposal.arguments.subject as string);
    }
    assert.equal(provider.sent.length, 0);
  } finally {
    await second.stop();
  }
});

test('with the service budget spent, an approved action prepared from a version is voided and never sent', async () => {
  const app = await start({ policy: { ...DEFAULT_POLICY, budgets: { ...DEFAULT_POLICY.budgets, composio: { callsPerDay: 0 } } } });
  assert(app.provider);
  try {
    const doc = await document(app);
    await app.connect();
    const open = await prepared(app, { workId: doc.workId, versionId: doc.v1 });
    assert.equal((await app.approve(open)).status, 200);
    const voided = await app.until(v => find(v, open.id).execution?.state === 'voided', 'the action is voided');
    assert.equal(find(voided, open.id).execution?.category, 'budget');
    assert.equal(app.provider.sent.length, 0);
  } finally {
    await app.stop();
  }
});

test('a crash while sending an action prepared from a version is unknown after restart and never sent again, even once the document changes; a timeout is unknown after one send', async () => {
  const provider = createFakeProvider();
  const first = await start({ provider });
  const doc = await document(first);
  await first.connect();
  const sending = await prepared(first, { workId: doc.workId, versionId: doc.v1 }, 'Envoi interrompu');
  provider.outcome = () => new Promise(() => {});
  assert.equal((await first.approve(sending)).status, 200);
  await first.until(v => find(v, sending.id).execution?.state === 'dispatching', 'the permit is consumed');
  assert.equal(provider.sent.length, 1);
  await first.stop();

  provider.outcome = null;
  const second = await start({ provider, path: first.path });
  try {
    second.desk.kick();
    second.worker.kick();
    const recovered = await second.until(v => find(v, sending.id).execution?.report === 'done', 'the unknown receipt is reported after restart');
    assert.deepEqual([find(recovered, sending.id).execution?.state, find(recovered, sending.id).execution?.category], ['unknown', 'interrupted']);

    const v2 = await edit(second, doc, 'Viens dimanche.');
    const again = await second.approve(sending);
    assert.deepEqual([again.status, await code(again)], [409, 'proposal_closed']);
    assert.equal(find(await drained(second), sending.id).execution?.state, 'unknown', 'an unknown result is never turned into a new send');
    assert.equal(provider.sent.length, 1);

    const late = await prepared(second, { workId: doc.workId, versionId: v2 }, 'Résultat inconnu');
    assert.equal((await second.approve(late)).status, 200);
    const timed = await second.until(v => find(v, late.id).execution?.report === 'done', 'the timeout is reported');
    assert.deepEqual([find(timed, late.id).execution?.state, find(timed, late.id).execution?.category], ['unknown', 'timeout']);
    assert.deepEqual(provider.sent.map(s => s.args.subject), ['Envoi interrompu', 'Résultat inconnu'], 'each approval reached the provider once');
  } finally {
    await second.stop();
  }
});

test('the server refuses a source it cannot freeze and creates nothing; the same request sent twice prepares once', async () => {
  const app = await start();
  assert(app.provider);
  try {
    const doc = await document(app);
    const other = await document(app);
    const source = { workId: doc.workId, versionId: doc.v1 };

    const withoutRight = await ask(app, source, 'Sans droit');
    assert.deepEqual([withoutRight.status, await code(withoutRight)], [409, 'invalid_transition'], 'a bot without a service right prepares nothing');

    await app.connect('nova');
    await app.connect('atlas');
    const messages = (await app.view()).messages.length;
    const refusals: [string, Response, number, string][] = [
      ['a version of another document', await ask(app, { workId: doc.workId, versionId: other.v1 }, 'Autre document'), 409, 'cross_work'],
      ['a version that does not exist', await ask(app, { workId: doc.workId, versionId: 'v_absente' }, 'Version absente'), 404, 'not_found'],
      ['a document of another thread', await app.post('/api/commands', { type: 'message.send', requestId: rid(), botId: 'atlas', text: 'Autre fil', attachments: [], source }), 409, 'cross_work'],
      ['a source with a document task', await ask(app, source, 'Avec document', { document: { reviewerBotId: null } }), 422, 'invalid_command'],
      ['a source with an invited bot', await ask(app, source, '@Atlas regarde', { mentions: [{ botId: 'atlas', start: 0, end: 6 }] }), 422, 'invalid_command'],
      ['a source that carries its own text', await app.post('/api/commands', { type: 'message.send', requestId: rid(), botId: 'nova', text: 'Texte du client', attachments: [], source: { ...source, body: 'Saisie non enregistrée' } }), 422, 'invalid_command'],
      ['a source on the document route', await app.post('/api/commands', { type: 'message.say', requestId: rid(), botId: 'nova', text: 'Autre commande', attachments: [], source }), 422, 'invalid_command'],
    ];
    for (const [what, response, status, refusal] of refusals) assert.deepEqual([response.status, await code(response)], [status, refusal], what);
    const untouched = await app.view();
    assert.deepEqual([untouched.messages.length, untouched.tools.sources.length, untouched.tools.proposals.length], [messages, 0, 0]);

    const requestId = rid();
    const command = { type: 'message.send', requestId, botId: 'nova', text: 'Une seule fois', attachments: [], source };
    assert.equal((await app.post('/api/commands', command)).status, 200);
    const replayed = z.object({ replayed: z.boolean() }).parse(await (await app.post('/api/commands', command)).json());
    assert.equal(replayed.replayed, true);
    const conflict = await app.post('/api/commands', { ...command, source: { workId: other.workId, versionId: other.v1 } });
    assert.deepEqual([conflict.status, await code(conflict)], [409, 'request_conflict'], 'the same request cannot move to another version');
    const once = await app.until(v => v.tools.proposals.length === 1, 'one proposal');
    assert.equal(once.tools.sources.length, 1);
    assert.equal(app.provider.sent.length, 0);
  } finally {
    await app.stop();
  }
});

test('a request without a source keeps its path: it receives no version, and a new document version closes only what was prepared from that document', async () => {
  const app = await start();
  assert(app.provider);
  try {
    const doc = await document(app);
    await app.connect();
    const plain = await app.proposal('Sans version');
    assert.equal(plain.source, null);
    assert.notEqual(plain.arguments.body, V1, 'without a chosen version the turn does not receive it as a source');
    const sourced = await prepared(app, { workId: doc.workId, versionId: doc.v1 });
    await edit(app, doc, 'Viens dimanche.');
    const view = await app.view();
    assert.equal(find(view, plain.id).state, 'open', 'a new version of a document closes only what was prepared from it');
    assert.equal(find(view, sourced.id).state, 'stale');
    assert.equal((await app.approve(plain)).status, 200);
    await app.until(v => find(v, plain.id).execution?.state === 'completed', 'the plain action is sent');
    assert.equal(app.provider.sent.length, 1);
  } finally {
    await app.stop();
  }
});
