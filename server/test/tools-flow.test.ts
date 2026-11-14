import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MobileSnapshotSchema } from '../src/mobile-protocol.js';
import { CommandSchema } from '../src/protocol.js';
import { openStore } from '../src/store.js';
import type { LiveFacts } from '../src/tool-ledger.js';
import { ACCOUNT_A, SEND_EMAIL, createFakeProvider } from './fixtures/fake-composio.js';
import { find, mascots, rid, start } from './fixtures/tools-app.js';

test('from a chat message to a real bot report: connect, grant, propose, approve exactly, send once, report in the same thread', async () => {
  const app = await start();
  assert(app.provider);
  try {
    const first = await app.view();
    assert.deepEqual([first.tools.status.state, first.tools.accounts, first.tools.grants], ['ready', [], {}]);

    const catalog = await app.tools('catalog', await app.read('catalog'));
    assert.deepEqual(catalog.services.map(s => [s.toolkit, s.connectable]), [['gmail', true], ['slack', true], ['notion', false]]);
    assert.match(catalog.services[2]?.reason ?? '', /OAuth 2/);

    const linkResponse = await app.post('/api/tools/link', { serviceId: 'ac_synthetique_gmail', alias: 'Courriel en attente' });
    assert.equal(linkResponse.headers.get('cache-control'), 'no-store');
    const link = await app.tools('link', linkResponse);
    assert.match(link.redirectUrl, /^https:\/\/connexion-synthetique\.invalid\//);
    const pending = await app.view();
    assert.deepEqual(pending.tools.links.map(l => l.state), ['pending']);
    assert.doesNotMatch(JSON.stringify(pending), /connexion-synthetique/, 'the connection address is never part of a snapshot');

    const callback = await fetch(`${app.base}/api/tools/callback?link=${link.linkId}&status=success&connected_account_id=ca_force`);
    assert.equal(callback.status, 200);
    assert.doesNotMatch(await callback.text(), /ca_force|success/);
    const afterCallback = await app.view();
    assert.deepEqual(afterCallback.tools.accounts.map(a => a.status), ['INITIATED'], 'a callback parameter never activates an account');
    assert.deepEqual(afterCallback.tools.links.map(l => l.state), ['pending']);

    const accountId = afterCallback.tools.accounts[0]?.id ?? '';
    const refusedGrant = await app.command({ type: 'tools.grant', botId: 'nova', accountId, toolSlugs: ['GMAIL_SEND_EMAIL'] });
    assert.deepEqual([refusedGrant.status, (await refusedGrant.json() as { code: string }).code], [409, 'tool_unavailable']);

    const linked = app.provider.accounts.get(accountId);
    assert(linked);
    linked.status = 'ACTIVE';
    const checked = await app.tools('checked', await app.post(`/api/tools/links/${link.linkId}/check`, {}));
    assert.equal(checked.link.state, 'active');
    assert.deepEqual((await app.view()).tools.accounts.map(a => [a.alias, a.status]), [['Courriel en attente', 'ACTIVE']]);

    const available = await app.tools('available', await app.read(`available?accountId=${accountId}`));
    assert.deepEqual(available.tools.map(t => [t.slug, t.grantable]), [['GMAIL_SEND_EMAIL', true], ['GMAIL_FETCH_EMAILS', true], ['GMAIL_LIST_LABELS', false]]);
    assert.match(available.tools[2]?.reason ?? '', /version/);
    assert.deepEqual((await app.view()).tools.grants, {}, 'listing actions grants nothing');

    assert.equal((await app.command({ type: 'tools.grant', botId: 'nova', accountId, toolSlugs: ['GMAIL_SEND_EMAIL'] })).status, 200);
    assert.deepEqual((await app.view()).tools.grants.nova?.map(g => [g.toolSlug, g.accountAlias, g.version]), [['GMAIL_SEND_EMAIL', 'Courriel en attente', SEND_EMAIL.version]]);

    const open = await app.proposal('Envoie le bilan du mois');
    assert.equal(app.provider.sent.length, 0, 'a proposal by the model sends nothing');
    assert.deepEqual([open.state, open.botId, open.threadBotId, open.toolkit, open.accountId, open.toolSlug, open.execution], ['open', 'nova', 'nova', 'gmail', accountId, 'GMAIL_SEND_EMAIL', null]);
    assert.deepEqual(open.arguments, { to: 'personne@exemple.invalid', subject: 'Envoie le bilan du mois', body: 'Texte synthétique du faux moteur.' });
    const proposed = (await app.view()).messages.find(m => m.id === open.messageId);
    assert.match(proposed?.text ?? '', new RegExp(`Réponse de l’outil \\(true, 1 réponse\\) : Proposition ${open.id} enregistrée`), 'the model replied after the real answer of the tool call');

    const wrong = await app.command({ type: 'tools.approve', proposalId: open.id, fingerprint: 'f'.repeat(64) });
    assert.deepEqual([wrong.status, (await wrong.json() as { code: string }).code], [409, 'approval_mismatch']);
    assert.equal(app.provider.sent.length, 0);

    const requestId = rid();
    const worksBefore = (await app.view()).works.length;
    assert.equal((await app.approve(open, requestId)).status, 200);
    const done = await app.until(v => find(v, open.id).execution?.report === 'done', 'the report is recorded');
    assert.equal(app.provider.sent.length, 1, 'one approval, one send');
    assert.deepEqual(app.provider.sent[0]?.args, open.arguments);
    assert.deepEqual([app.provider.sent[0]?.pin.accountId, app.provider.sent[0]?.pin.toolSlug, app.provider.sent[0]?.pin.version], [accountId, 'GMAIL_SEND_EMAIL', SEND_EMAIL.version]);
    const execution = find(done, open.id).execution;
    assert.deepEqual([execution?.state, execution?.logId], ['completed', 'log_synthetique_1']);
    assert.deepEqual(done.messages.filter(m => m.workId === open.workId && m.role === 'assistant').map(m => m.text).at(-1), 'Compte rendu : l’action est dans l’état completed.');
    assert.equal(done.works.length, worksBefore, 'the report reuses the work');
    assert.equal(done.works.find(w => w.id === open.workId)?.state, 'done');

    const replay = await app.approve(open, requestId);
    assert.deepEqual([replay.status, (await replay.json() as { replayed: boolean }).replayed], [200, true]);
    const again = await app.approve(open);
    assert.deepEqual([again.status, (await again.json() as { code: string }).code], [409, 'proposal_closed']);
    await app.desk.idle();
    assert.equal(app.provider.sent.length, 1, 'repeated decisions never send again');

    const exposed = JSON.stringify(await app.view());
    assert.doesNotMatch(exposed, /jeton-synthetique|connexion-synthetique/, 'no redirect address and no sensitive result field reaches the browser');
    assert.equal(exposed.includes(app.store.tools.ownerId), false, 'the provider identity of the space stays on the server');
    assert.deepEqual([...new Set(app.logs.flatMap(entry => Object.keys(entry)))].sort(), ['action', 'code', 'event', 'ok'], 'logs carry categories only');
  } finally {
    await app.stop();
  }
});

test('tool routes are PC-only: wrong origin or token is refused, and the synced command contract and the mobile snapshot know nothing of tools', async () => {
  const app = await start();
  try {
    await app.connect();
    const open = await app.proposal('Envoie une note');
    const body = { type: 'tools.approve', requestId: rid(), proposalId: open.id, fingerprint: open.fingerprint };
    assert.equal((await app.post('/api/tools/commands', body, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await app.post('/api/tools/commands', body, { 'x-mino-csrf': 'x'.repeat(64) })).status, 403);
    assert.equal((await app.post('/api/tools/link', { serviceId: 'ac_synthetique_gmail', alias: 'X' }, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await app.read('commands')).status, 404);
    const reads = app.provider?.reads;
    for (const route of ['catalog', `available?accountId=${open.accountId}`]) {
      assert.equal((await fetch(`${app.base}/api/tools/${route}`)).status, 403, 'a read that calls the provider needs the session token');
    }
    assert.equal(app.provider?.reads, reads, 'a refused read never reaches the provider');
    assert.equal((await app.post('/api/tools/commands', { ...body, extra: true })).status, 422);
    const viaChatRoute = await app.post('/api/commands', body);
    assert.deepEqual([viaChatRoute.status, (await viaChatRoute.json() as { code: string }).code], [422, 'invalid_command'], 'the ordinary command route does not approve');
    assert.equal(find(await app.view(), open.id).state, 'open');
    assert.equal(app.provider?.sent.length, 0);

    for (const type of ['tools.grant', 'tools.revoke', 'tools.approve', 'tools.refuse', 'tools.report.retry']) {
      assert.equal(CommandSchema.safeParse({ ...body, type }).success, false, `${type} is not a synced command`);
    }
    const mobile = MobileSnapshotSchema.parse({ ...(await app.view()), schemaVersion: 1 });
    assert.equal('tools' in mobile, false);
    assert.doesNotMatch(JSON.stringify(mobile), /GMAIL_SEND_EMAIL.*fingerprint|Courriel de test/);
  } finally {
    await app.stop();
  }
});

test('without a provider key the view says so, every tools route refuses, and a bot with stored rights gets no tool', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mino-tools-nokey-'));
  const path = join(dir, 'mino.sqlite');
  const seeded = openStore({ path, mascots, serviceTools: true });
  const live: LiveFacts = { account: ACCOUNT_A, tools: [SEND_EMAIL] };
  assert.equal(seeded.tools.apply({ type: 'tools.grant', requestId: rid(), botId: 'nova', accountId: ACCOUNT_A.id, toolSlugs: ['GMAIL_SEND_EMAIL'] }, live).ok, true);
  seeded.close();

  const app = await start({ path, provider: null });
  try {
    assert.equal((await app.view()).tools.status.state, 'missing_key');
    for (const response of [
      await app.read('catalog'),
      await app.post('/api/tools/link', { serviceId: 'ac_synthetique_gmail', alias: 'X' }),
      await app.command({ type: 'tools.grant', botId: 'nova', accountId: ACCOUNT_A.id, toolSlugs: ['GMAIL_SEND_EMAIL'] }),
    ]) {
      assert.equal(response.status, 503);
      const body = await response.json() as { code: string; message: string };
      assert.equal(body.code, 'provider_unavailable');
      assert.match(body.message, /Aucune clé Composio/);
    }
    await app.say('Envoie le bilan');
    const answered = await app.until(v => v.works.at(-1)?.state === 'done', 'an ordinary reply');
    assert.equal(answered.messages.at(-1)?.text, 'Bonjour depuis le faux moteur.');
    assert.deepEqual(answered.tools.proposals, []);
  } finally {
    await app.stop();
  }
});

test('a source turn that fails after proposing shows no card and can never be approved', async () => {
  const app = await start({ scenario: 'tool-call-then-fail' });
  try {
    await app.connect();
    await app.say('Envoie le bilan');
    const failed = await app.until(v => v.works.at(-1)?.state === 'failed', 'the turn fails');
    assert.deepEqual(failed.tools.proposals, []);
    assert.equal(app.store.tools.nextApproved(), null);
    assert.equal(app.provider?.sent.length, 0);
  } finally {
    await app.stop();
  }
});

test('an ambiguous send stays unknown, is reported as unknown, and nothing can send it again', async () => {
  const app = await start();
  assert(app.provider);
  try {
    await app.connect();
    const open = await app.proposal('Envoi au résultat inconnu');
    assert.equal((await app.approve(open)).status, 200);
    const reported = await app.until(v => find(v, open.id).execution?.report === 'done', 'the unknown outcome is reported');
    const execution = find(reported, open.id).execution;
    assert(execution);
    assert.deepEqual([execution.state, execution.category, execution.summary], ['unknown', 'timeout', null]);
    const work = reported.works.find(w => w.id === open.workId);
    assert.equal(work?.next.kind, 'new_request');
    assert.deepEqual(work?.lastFact, { kind: 'execution', id: execution.id, state: 'unknown', logId: execution.logId, at: execution.updatedAt });
    assert.equal(reported.messages.filter(m => m.workId === open.workId).at(-1)?.text, 'Compte rendu : l’action est dans l’état unknown.');
    const retry = await app.command({ type: 'tools.report.retry', executionId: execution.id });
    assert.deepEqual([retry.status, (await retry.json() as { code: string }).code], [409, 'invalid_transition']);
    const workRetry = await app.post('/api/commands', { type: 'work.retry', requestId: rid(), workId: open.workId });
    assert.equal(workRetry.status, 409);
    app.desk.kick();
    await app.desk.idle();
    assert.equal(app.provider.sent.length, 1);
  } finally {
    await app.stop();
  }
});

test('a failed report is retried from the PC as a summary only: still one send', async () => {
  const app = await start();
  assert(app.provider);
  try {
    await app.connect();
    const open = await app.proposal('Envoi avec rapport fragile');
    assert.equal((await app.approve(open)).status, 200);
    const failed = await app.until(v => find(v, open.id).execution?.report === 'failed', 'the first report fails');
    const execution = find(failed, open.id).execution;
    assert(execution);
    assert.equal(execution.state, 'completed');
    assert.equal(failed.works.find(w => w.id === open.workId)?.state, 'done', 'a failed report does not fail the answered work');
    assert.equal((await app.command({ type: 'tools.report.retry', executionId: execution.id })).status, 200);
    const done = await app.until(v => find(v, open.id).execution?.report === 'done', 'the retried report succeeds');
    assert.equal(done.messages.filter(m => m.workId === open.workId).at(-1)?.text, 'Compte rendu : l’action est dans l’état completed.');
    assert.equal(app.provider.sent.length, 1);
  } finally {
    await app.stop();
  }
});

test('a right revoked after approval and before the send voids it: nothing leaves', async () => {
  const app = await start();
  assert(app.provider);
  try {
    const accountId = await app.connect();
    const open = await app.proposal('Envoie le bilan');
    const account = app.provider.accounts.get(accountId);
    assert(account);
    // The approval is committed as the route does, but the desk has not been woken yet: the instant between decision and send.
    assert.equal(app.store.tools.apply({ type: 'tools.approve', requestId: rid(), proposalId: open.id, fingerprint: open.fingerprint }, { account, tools: [SEND_EMAIL] }).ok, true);
    const grantId = (await app.view()).tools.grants.nova?.[0]?.id ?? '';
    assert.equal((await app.command({ type: 'tools.revoke', botId: 'nova', grantId })).status, 200);
    await app.desk.idle();
    const voided = find(await app.view(), open.id).execution;
    assert.deepEqual([voided?.state, voided?.category, voided?.report], ['voided', 'grant_changed', 'none']);
    assert.equal(app.provider.sent.length, 0);
    assert.deepEqual((await app.view()).tools.grants, {});
  } finally {
    await app.stop();
  }
});

test('a stale provider schema at approval, or at the send itself, closes the action without sending', async () => {
  const app = await start();
  assert(app.provider);
  try {
    const accountId = await app.connect();
    const first = await app.proposal('Premier envoi');
    app.provider.tools = app.provider.tools.map(tool => tool.slug === 'GMAIL_SEND_EMAIL' ? { ...tool, version: '20270101_00' } : tool);
    const stale = await app.approve(first);
    assert.deepEqual((await stale.json() as { result: { decision: string; staleReason: string } }).result, { kind: 'decision', proposalId: first.id, decision: 'stale', executionId: null, staleReason: 'schema_changed' });
    assert.equal(app.provider.sent.length, 0);

    app.provider.tools = app.provider.tools.map(tool => tool.slug === 'GMAIL_SEND_EMAIL' ? SEND_EMAIL : tool);
    assert.equal((await app.command({ type: 'tools.grant', botId: 'nova', accountId, toolSlugs: ['GMAIL_SEND_EMAIL'] })).status, 200);
    const second = await app.proposal('Second envoi');
    const account = app.provider.accounts.get(accountId);
    assert(account);
    assert.equal(app.store.tools.apply({ type: 'tools.approve', requestId: rid(), proposalId: second.id, fingerprint: second.fingerprint }, { account, tools: [SEND_EMAIL] }).ok, true);
    app.provider.tools = app.provider.tools.map(tool => tool.slug === 'GMAIL_SEND_EMAIL' ? { ...tool, inputSchema: { type: 'object', properties: {} } } : tool);
    app.desk.kick();
    await app.desk.idle();
    const execution = find(await app.view(), second.id).execution;
    assert.deepEqual([execution?.state, execution?.category], ['voided', 'schema_changed']);
    assert.equal(app.provider.sent.length, 0, 'the session that would execute no longer matches the approval');

    account.status = 'EXPIRED';
    app.provider.tools = app.provider.tools.map(tool => tool.slug === 'GMAIL_SEND_EMAIL' ? SEND_EMAIL : tool);
    const third = await app.proposal('Troisième envoi');
    const expired = await app.approve(third);
    assert.equal((await expired.json() as { result: { staleReason: string } }).result.staleReason, 'account_inactive');
    assert.equal(app.provider.sent.length, 0);
  } finally {
    await app.stop();
  }
});

test('a crash while sending is unknown after restart and never resent; an approval not yet consumed is sent once after restart', async () => {
  const provider = createFakeProvider();
  const first = await start({ provider });
  await first.connect();
  const sending = await first.proposal('Envoi interrompu');
  provider.outcome = () => new Promise(() => {});
  assert.equal((await first.approve(sending)).status, 200);
  await first.until(v => find(v, sending.id).execution?.state === 'dispatching', 'the permit is consumed');
  assert.equal(provider.sent.length, 1);
  const waiting = await first.proposal('Envoi approuvé juste avant l’arrêt');
  const account = provider.accounts.get(waiting.accountId);
  assert(account);
  assert.equal(first.store.tools.apply({ type: 'tools.approve', requestId: rid(), proposalId: waiting.id, fingerprint: waiting.fingerprint }, { account, tools: [SEND_EMAIL] }).ok, true);
  await first.stop();

  provider.outcome = null;
  const second = await start({ provider, path: first.path });
  try {
    second.desk.kick();
    second.worker.kick();
    const recovered = await second.until(v => find(v, sending.id).execution?.report === 'done' && find(v, waiting.id).execution?.report === 'done', 'both receipts are reported after restart');
    assert.deepEqual([find(recovered, sending.id).execution?.state, find(recovered, sending.id).execution?.category], ['unknown', 'interrupted']);
    assert.equal(find(recovered, waiting.id).execution?.state, 'completed');
    assert.deepEqual(provider.sent.map(s => s.args.subject), ['Envoi interrompu', 'Envoi approuvé juste avant l’arrêt'], 'each approval reached the provider once, across the restart');
  } finally {
    await second.stop();
  }
});

test('a later message leaves an open proposal untouched, and the document lane works without any tool', async () => {
  const app = await start();
  assert(app.provider);
  try {
    await app.connect();
    const first = await app.proposal('Premier courriel');
    const second = await app.proposal('Second courriel');
    assert.notEqual(first.workId, second.workId);
    assert.equal(find(await app.view(), first.id).state, 'open');
    assert.equal((await app.approve(first)).status, 200);
    const done = await app.until(v => find(v, first.id).execution?.report === 'done', 'the first receipt is reported');
    assert.equal(done.messages.filter(m => m.workId === first.workId && m.role === 'assistant').length, 2, 'the report belongs to the work that proposed');
    assert.equal(find(done, second.id).state, 'open');
    const refused = await app.command({ type: 'tools.refuse', proposalId: second.id });
    assert.equal(refused.status, 200);
    assert.equal(app.provider.sent.length, 1);

    const document = await app.post('/api/commands', { type: 'message.send', requestId: rid(), botId: 'nova', text: 'Rédige une invitation', attachments: [], document: { reviewerBotId: null } });
    assert.equal(document.status, 200);
    const written = await app.until(v => v.tasks.at(-1)?.status === 'finished', 'the document task finishes');
    assert.equal(written.works.find(w => w.taskId === written.tasks.at(-1)?.id)?.versions.length, 1, 'the document engine ran with no tool offered');
    assert.equal(written.tools.proposals.length, 2);
  } finally {
    await app.stop();
  }
});
