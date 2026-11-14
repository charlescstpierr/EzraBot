import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { ConnectionView, PcView } from '../src/tools-protocol.js';
import { SERVICES } from './fixtures/fake-composio.js';
import { start } from './fixtures/tools-app.js';

// The whole chain with real parts: SQLite store, worker, local HTTP, the chat engine speaking to a fake App Server process,
// and the action desk speaking to a fake provider. Every account, service and address is synthetic.

type App = Awaited<ReturnType<typeof start>>;

const PROVIDER_HOST = 'connexion-synthetique.invalid';

/** The bot answers a request that names a service, and its proposal appears. */
async function proposed(app: App, text: string, botId = 'nova'): Promise<ConnectionView> {
  const before = (await app.view()).tools.connections.length;
  await app.say(text, botId);
  const view = await app.until(v => v.tools.connections.length > before, `a connection request for « ${text} »`);
  const request = view.tools.connections.at(-1);
  assert(request);
  return request;
}

const startLink = (app: App, request: ConnectionView, after: string | null, alias = 'Courriel de test') =>
  app.post(`/api/tools/connections/${request.id}/link`, { alias, after });
const requestOf = (view: PcView, id: string) => {
  const found = view.tools.connections.find(candidate => candidate.id === id);
  assert(found);
  return found;
};
const refusal = async (response: Response) => {
  const body = await response.json() as { ok: boolean; code?: string; message?: string };
  assert.equal(body.ok, false);
  return [response.status, body.code];
};

test('a bot without a right proposes a connection; the person starts it, only a provider reading connects it, and no right is given', async () => {
  const app = await start();
  try {
    assert(app.provider);
    const request = await proposed(app, 'Lis mes derniers courriels Gmail');
    assert.equal(app.provider.reads, 0, 'the proposal alone never calls the provider');
    assert.equal(app.provider.started, 0);
    const view = await app.view();
    const message = view.messages.find(candidate => candidate.id === request.messageId);
    assert.deepEqual([request.botId, request.toolkit, request.link, message?.role, message?.botId], ['nova', 'gmail', null, 'assistant', 'nova']);
    assert.deepEqual([view.tools.accounts, view.tools.links, view.tools.grants], [[], [], {}]);

    const link = await app.tools('link', await startLink(app, request, null));
    assert.equal(new URL(link.redirectUrl).protocol, 'https:');
    assert.equal(app.provider.started, 1);
    const started = requestOf(await app.view(), request.id);
    assert.deepEqual([started.link?.id, started.link?.state], [link.linkId, 'pending'], 'the fake account is already ACTIVE, yet nothing says connected before a reading');
    assert.equal((await app.view()).tools.accounts.length, 0);

    const checked = await app.tools('checked', await app.post(`/api/tools/links/${link.linkId}/check`, {}));
    assert.equal(checked.link.state, 'active');
    const connected = await app.view();
    assert.equal(requestOf(connected, request.id).link?.state, 'active');
    assert.deepEqual(connected.tools.accounts.map(account => [account.alias, account.status]), [['Courriel de test', 'ACTIVE']]);
    assert.deepEqual(connected.tools.grants, {}, 'connecting an account grants nothing');
    assert.deepEqual(app.store.tools.grantsFor('nova'), []);
    assert.equal(connected.works.filter(work => work.state === 'pending' || work.state === 'running').length, 0, 'a connection starts no turn');
    assert.equal(app.provider.sent.length, 0);

    const works = connected.works.length;
    await app.say('Bonjour');
    const after = await app.until(v => v.works.length > works && v.works.every(work => work.state !== 'pending' && work.state !== 'running'), 'the next turn ends');
    assert.equal(after.tools.proposals.length, 0, 'the bot still has no action to propose');
    assert.deepEqual(app.logs.filter(entry => entry.action.startsWith('connection')), [{ event: 'tools', action: 'connection.link', ok: true }]);
  } finally {
    await app.stop();
  }
});

test('the same gesture from two tabs reaches the provider once, a stale repeat starts nothing, and a deliberate new start replaces the link', async () => {
  const app = await start();
  let release = () => {};
  try {
    assert(app.provider);
    const request = await proposed(app, 'Lis mes courriels gmail');
    app.provider.gate = new Promise<void>(resolve => { release = resolve; });
    const first = startLink(app, request, null);
    const second = startLink(app, request, null);
    const neither = new Promise<never>((_, reject) => { setTimeout(() => reject(new Error('neither start was refused while the other was in flight')), 2_000).unref(); });
    assert.deepEqual(await refusal(await Promise.race([first, second, neither])), [409, 'busy'], 'the second tab is refused while the first start is in flight');
    release();
    app.provider.gate = null;
    const settled = await Promise.all([first, second]);
    const accepted = settled.filter(response => response.status === 200);
    assert.equal(accepted.length, 1);
    assert.equal(app.provider.started, 1, 'one start reached the provider');
    const link = await app.tools('link', accepted[0] ?? new Response());

    assert.deepEqual(await refusal(await startLink(app, request, null)), [409, 'busy'], 'a card that still shows no link is stale');
    assert.deepEqual(await refusal(await startLink(app, request, 'tl_autre')), [409, 'busy']);
    assert.equal(app.provider.started, 1);
    assert.equal(requestOf(await app.view(), request.id).link?.id, link.linkId);

    const again = await app.tools('link', await startLink(app, request, link.linkId, 'Courriel refus'));
    assert.notEqual(again.linkId, link.linkId);
    assert.equal(app.provider.started, 2);
    await app.tools('checked', await app.post(`/api/tools/links/${again.linkId}/check`, {}));
    const view = await app.view();
    assert.deepEqual([requestOf(view, request.id).link?.id, requestOf(view, request.id).link?.state], [again.linkId, 'failed'], 'the card follows the newest link, as the provider reports it');
    assert.equal(app.store.tools.link(link.linkId)?.state, 'pending', 'the earlier link is untouched');
  } finally {
    release();
    await app.stop();
  }
});

test('a provider failure, an unknown service, an unconnectable one and an ambiguous one leave the request as it was and startable again', async () => {
  const app = await start();
  try {
    assert(app.provider);
    const gmail = await proposed(app, 'Lis mes courriels gmail');
    app.provider.failing = 'unavailable';
    assert.deepEqual(await refusal(await startLink(app, gmail, null)), [503, 'provider_unavailable']);
    app.provider.failing = null;
    assert.equal(requestOf(await app.view(), gmail.id).link, null);

    const unknown = await proposed(app, 'Regarde mon agenda');
    assert.equal(unknown.toolkit, 'agenda');
    assert.deepEqual(await refusal(await startLink(app, unknown, null)), [409, 'tool_unavailable'], 'the name the bot wrote selects nothing outside this server’s catalogue');
    const keyOnly = await proposed(app, 'Ouvre mes notes Notion');
    assert.equal(keyOnly.toolkit, 'notion', 'the name is normalised to the catalogue form');
    assert.deepEqual(await refusal(await startLink(app, keyOnly, null)), [409, 'tool_unavailable']);

    const gmailService = SERVICES.find(service => service.toolkit === 'gmail');
    assert(gmailService);
    app.provider.services = [...SERVICES, { ...gmailService, id: 'ac_synthetique_gmail_2', name: 'Courriel bis (synthétique)' }];
    assert.deepEqual(await refusal(await startLink(app, gmail, null)), [409, 'tool_unavailable'], 'the server never picks one of several configurations');
    assert.equal(app.provider.started, 0, 'no refused start reached the provider');
    app.provider.services = [...SERVICES];

    assert.deepEqual(await refusal(await startLink(app, { ...gmail, id: 'tc_absente' }, null)), [404, 'not_found']);
    assert.deepEqual(await refusal(await app.post(`/api/tools/connections/${gmail.id}/link`, { alias: 'x', after: null, serviceId: 'ac_synthetique_slack' })), [422, 'invalid_command']);
    const link = await app.tools('link', await startLink(app, gmail, null));
    assert.equal(requestOf(await app.view(), gmail.id).link?.id, link.linkId, 'after the failures the same request starts normally');
    assert.equal(app.provider.started, 1);
  } finally {
    await app.stop();
  }
});

test('a request and its pending link survive a restart, and the check resumes on the same link', async () => {
  const first = await start();
  assert(first.provider);
  const { request, untouched, link } = await (async () => {
    try {
      const request = await proposed(first, 'Lis mes courriels gmail');
      const untouched = await proposed(first, 'Écris sur Slack');
      const link = await first.tools('link', await startLink(first, request, null, 'Courriel attente'));
      await first.tools('checked', await first.post(`/api/tools/links/${link.linkId}/check`, {}));
      assert.equal(requestOf(await first.view(), request.id).link?.state, 'pending', 'the provider still waits for the person');
      return { request, untouched, link };
    } finally {
      await first.stop();
    }
  })();

  const second = await start({ path: first.path, provider: first.provider });
  try {
    const view = await second.view();
    assert.deepEqual([requestOf(view, request.id).link?.id, requestOf(view, request.id).link?.state], [link.linkId, 'pending']);
    assert.equal(requestOf(view, untouched.id).link, null);
    assert.equal(requestOf(view, request.id).messageId, request.messageId);

    const account = first.provider.accounts.get(requestOf(view, request.id).link?.accountId ?? '');
    assert(account);
    account.status = 'ACTIVE';
    const checked = await second.tools('checked', await second.post(`/api/tools/links/${link.linkId}/check`, {}));
    assert.equal(checked.link.state, 'active');
    assert.equal(requestOf(await second.view(), request.id).link?.state, 'active');
    assert.equal(first.provider.started, 1, 'the restart started no connection by itself');
  } finally {
    await second.stop();
  }
});

test('the connection address is kept nowhere, the route is closed to other origins, and without a key nothing is offered', async () => {
  const app = await start();
  try {
    assert(app.provider);
    const request = await proposed(app, 'Lis mes courriels gmail');
    assert.equal((await app.post(`/api/tools/connections/${request.id}/link`, { alias: 'x', after: null }, { origin: 'https://ailleurs.invalid' })).status, 403);
    assert.equal((await app.post(`/api/tools/connections/${request.id}/link`, { alias: 'x', after: null }, { 'x-mino-csrf': 'mauvais' })).status, 403);
    assert.equal((await fetch(`${app.base}/api/tools/connections/${request.id}/link`, { headers: { 'x-mino-csrf': 'c'.repeat(64) } })).status, 404, 'the start is a POST only');
    assert.equal(app.provider.started, 0);

    const link = await app.tools('link', await startLink(app, request, null));
    assert(link.redirectUrl.includes(PROVIDER_HOST), 'the address exists in the reply of the start');
    await app.tools('checked', await app.post(`/api/tools/links/${link.linkId}/check`, {}));
    await app.say('Bonjour après la connexion');
    await app.until(v => v.works.every(work => work.state !== 'pending' && work.state !== 'running'), 'the turn after the connection ends');
    assert(!JSON.stringify(await app.view()).includes(PROVIDER_HOST), 'the PC view never carries the address');
    assert(!JSON.stringify(app.logs).includes(PROVIDER_HOST), 'the desk log never carries the address');
  } finally {
    await app.stop();
  }
  for (const file of [app.path, `${app.path}-wal`]) {
    if (existsSync(file)) assert(!readFileSync(file).includes(PROVIDER_HOST), `${file} never stores the address`);
  }

  const keyless = await start({ provider: null });
  try {
    await keyless.say('Lis mes derniers courriels Gmail');
    const view = await keyless.until(v => v.messages.some(message => message.role === 'assistant'), 'the keyless bot answers');
    assert.deepEqual(view.tools.connections, []);
    assert.equal(view.tools.status.state, 'missing_key');
    assert.deepEqual(await refusal(await keyless.post('/api/tools/connections/tc_absente/link', { alias: 'x', after: null })), [503, 'provider_unavailable']);
  } finally {
    await keyless.stop();
  }
});
