import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { childEnv } from '../src/child-env.js';
import { loadMascots, type EngineOutcome } from '../src/domain.js';
import { createCodexEngine, type Engine, type RunInput } from '../src/engine.js';
import { EventIngressConfigError, createEventIngress, takeEventIngressConfig, verifyDelivery, type VerifiedDelivery } from '../src/event-ingress.js';
import { composeEventRequest } from '../src/events.js';
import type { CommandOf, DispatchOutcome, EngineStatus, SubscriptionView } from '../src/protocol.js';
import { openStore, type Store } from '../src/store.js';
import { createActionDesk } from '../src/tool-desk.js';
import { createWorker } from '../src/worker.js';
import { createFakeProvider } from './fixtures/fake-composio.js';
import { startFakeHoncho } from './fixtures/fake-honcho.js';
import { BOT, startMemory } from './fixtures/memory-app.js';
import { distinct, eventBody, signHeaders, type EventInput } from './fixtures/signed-event.js';
import { tempDir } from './fixtures/temp.js';

const mascots = loadMascots(new URL('../../assets/mascots.json', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/fake-app-server.js', import.meta.url));
const TRANSPORT = 'projet-essai';
const SECRET = 'whsec_synthetique_courant_0001';
const PREVIOUS = 'whsec_synthetique_ancien_0002';
const ACCOUNT = 'ca_synthetique';
const rid = () => randomUUID();
const READY: EngineStatus = { state: 'ready', account: 'chatgpt', models: [{ id: 'fake', displayName: 'Fake', isDefault: true, efforts: ['low'], defaultEffort: 'low', speeds: [] }] };
const answered = (reply: string, extra: Record<string, unknown> = {}): EngineOutcome =>
  ({ kind: 'succeeded', reply: { reply, deliverable: null, ...extra }, used: { model: 'fake', effort: 'low', speed: 'standard' }, threadId: 'thread', turnId: 'turn' }) as EngineOutcome;

function space(options: { path?: string; transport?: string | null; serviceTools?: boolean } = {}) {
  const path = options.path ?? join(tempDir('mino-events-'), 'mino.sqlite');
  const transport = options.transport === undefined ? TRANSPORT : options.transport;
  const store = openStore({ path, mascots, ...(options.serviceTools ? { serviceTools: true } : {}), ...(transport ? { events: { transport } } : {}) });
  return { path, store };
}
const account = (store: Store, status: 'ACTIVE' | 'EXPIRED' | 'INITIATED' = 'ACTIVE', id = ACCOUNT) =>
  store.tools.observeAccount({ id, toolkit: 'github', alias: 'Compte travail', status });

function ok(outcome: DispatchOutcome) {
  assert.equal(outcome.ok, true, outcome.ok ? '' : `${outcome.code}: ${outcome.message}`);
  if (!outcome.ok) throw new Error('refused');
  return outcome.result;
}
const refusal = (outcome: DispatchOutcome) => (outcome.ok ? 'accepted' : outcome.code);

type Create = Omit<CommandOf<'subscription.create'>, 'type' | 'requestId'>;
const BASE: Create = { botId: 'nova', accountId: ACCOUNT, triggerId: 'ti_synthetique', triggerSlug: 'GITHUB_ISSUE_ADDED_EVENT', text: 'Résume ce ticket en trois lignes.', fields: ['title'], perDay: 20 };
const subscriptionOf = (store: Store, id: string): SubscriptionView => {
  const found = store.view().events.subscriptions.find(sub => sub.id === id);
  assert(found, 'subscription exists');
  return found;
};
function create(store: Store, fields: Partial<Create> = {}): string {
  const result = ok(store.dispatch({ type: 'subscription.create', requestId: rid(), ...BASE, ...fields }));
  assert.equal(result.kind, 'subscription');
  return result.kind === 'subscription' ? result.subscriptionId : '';
}
function subscribe(store: Store, fields: Partial<Create> = {}): string {
  const id = create(store, fields);
  ok(store.dispatch({ type: 'subscription.activate', requestId: rid(), subscriptionId: id, expectedRevision: subscriptionOf(store, id).revision }));
  return id;
}
const move = (store: Store, id: string, type: 'subscription.pause' | 'subscription.revoke') => ok(store.dispatch({ type, requestId: rid(), subscriptionId: id }));

/** Signs and authenticates one event the way the listener does, without HTTP. */
function delivered(store: Store, input: EventInput = {}): VerifiedDelivery {
  const { id, body } = eventBody(store.tools.ownerId, input);
  const verified = verifyDelivery(body, distinct(signHeaders(SECRET, id, body)), { transport: TRANSPORT, secrets: [Buffer.from(SECRET)] }, Date.now(), store.tools.ownerId);
  assert.equal(verified.kind, 'verified');
  if (verified.kind !== 'verified') throw new Error('not verified');
  return verified.delivery;
}
function admitted(store: Store, input: EventInput = {}): string {
  const outcome = store.receiveEvent(delivered(store, input));
  assert.deepEqual([outcome.status, 'outcome' in outcome ? outcome.outcome : null], ['new', 'admitted']);
  return outcome.status === 'new' && outcome.outcome === 'admitted' && outcome.workId ? outcome.workId : '';
}

type Reply = { status: number; body: string };
/** The real listener on a free loopback port. `send` writes exact bytes and may repeat a header. */
async function listen(store: Store, secrets: readonly string[] = [SECRET]) {
  let wakes = 0;
  const server: Server = createEventIngress({
    config: { transport: TRANSPORT, secrets: secrets.map(value => Buffer.from(value)), port: 0, bind: '127.0.0.1' },
    ownerId: store.tools.ownerId, receive: delivery => store.receiveEvent(delivery), wake: () => { wakes += 1; },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const send = (headers: Record<string, string | string[]>, body: Buffer, options: { path?: string; method?: string } = {}) => new Promise<Reply>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: options.path ?? '/events/composio', method: options.method ?? 'POST', headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
  const post = (input: EventInput = {}, secret = SECRET, timestamp?: number) => {
    const { id, body } = eventBody(store.tools.ownerId, input);
    return send(signHeaders(secret, id, body, timestamp), body);
  };
  return { port, send, post, wakes: () => wakes, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

function rows(path: string, sql: string): Record<string, unknown>[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(sql).all().map(row => ({ ...row }));
  } finally {
    db.close();
  }
}
const eventWorks = (store: Store) => {
  const view = store.view();
  const requests = new Set(view.messages.filter(m => m.trigger?.kind === 'event').map(m => m.id));
  return view.works.filter(w => requests.has(w.requestMessageId));
};

/** An engine that takes its permit, then waits; the test decides when and how the call ends. */
function heldEngine() {
  const waiting: { resolve: (outcome: EngineOutcome) => void; input: RunInput }[] = [];
  let runs = 0;
  const engine: Engine = {
    status: () => READY, catalog: async () => READY, close: async () => {}, onUsage: () => () => {},
    run: async (input: RunInput) => {
      runs += 1;
      input.onThread('thread');
      const departure = input.depart();
      if (!departure.ok) return { kind: 'failed', code: 'admission_refused', message: departure.reason };
      input.onTurn('turn');
      return new Promise<EngineOutcome>(resolve => {
        const entry = { resolve, input };
        waiting.push(entry);
        input.signal.addEventListener('abort', () => {
          waiting.splice(waiting.indexOf(entry), 1);
          resolve({ kind: 'cancelled' });
        }, { once: true });
      });
    },
  };
  return {
    engine,
    finish: (outcome: EngineOutcome) => waiting.shift()?.resolve(outcome),
    running: () => waiting.length,
    runs: () => runs,
    input: () => waiting[0]?.input,
  };
}
const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 500; i += 1) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`condition never met: ${what}`);
};

test('only a delivery signed over its exact bytes, by the current or previous secret, inside 300 s and in V3, reaches the store', async () => {
  const s = space();
  account(s.store);
  subscribe(s.store);
  const ingress = await listen(s.store, [SECRET, PREVIOUS]);
  const owner = s.store.tools.ownerId;
  const signedWith = (input: EventInput, change: (headers: Record<string, string>, body: Buffer) => [Record<string, string | string[]>, Buffer]) => {
    const { id, body } = eventBody(owner, input);
    const [headers, bytes] = change(signHeaders(SECRET, id, body), body);
    return ingress.send(headers, bytes);
  };
  try {
    assert.equal((await ingress.post()).status, 200);
    assert.equal(s.store.view().events.receipts, 1);
    const flipped = (headers: Record<string, string>, body: Buffer): [Record<string, string>, Buffer] => {
      const copy = Buffer.from(body);
      copy[copy.indexOf('Ticket')] = 't'.charCodeAt(0);
      return [headers, copy];
    };
    const now = Math.floor(Date.now() / 1000);
    const cases: [string, () => Promise<Reply>, number][] = [
      ['one flipped body byte', () => signedWith({}, flipped), 401],
      ['an unknown secret', () => ingress.post({}, 'whsec_inconnu_0000000000'), 401],
      ['a signature that is not base64 HMAC', () => signedWith({}, (h, b) => [{ ...h, 'webhook-signature': 'v1,pas-une-signature' }, b]), 401],
      ['only a v2 scheme', () => signedWith({}, (h, b) => [{ ...h, 'webhook-signature': h['webhook-signature']?.replace('v1,', 'v2,') ?? '' }, b]), 401],
      ['no signature header', () => signedWith({}, (h, b) => { const { 'webhook-signature': _gone, ...rest } = h; return [rest, b]; }), 400],
      ['two webhook-id headers', () => signedWith({}, (h, b) => [{ ...h, 'webhook-id': [h['webhook-id'] ?? '', 'msg_autre'] }, b]), 400],
      ['version V2', () => signedWith({}, (h, b) => [{ ...h, 'x-composio-webhook-version': 'V2' }, b]), 400],
      ['301 s in the past', () => ingress.post({}, SECRET, now - 301), 400],
      ['301 s in the future', () => ingress.post({}, SECRET, now + 301), 400],
      ['a timestamp that is not decimal seconds', () => {
        const { id, body } = eventBody(owner);
        return ingress.send({ ...signHeaders(SECRET, id, body), 'webhook-timestamp': '1.7e9' }, body);
      }, 400],
      ['a header id that differs from the body id', () => {
        const { body } = eventBody(owner, { id: 'msg_corps' });
        return ingress.send(signHeaders(SECRET, 'msg_entete', body), body);
      }, 400],
      ['an event id outside the key alphabet', () => ingress.post({ id: 'msg/1' }), 400],
      ['another provider user', () => ingress.post({ userId: 'user-autre' }), 400],
      ['no provider user', () => ingress.post({ userId: null }), 400],
      ['a type outside the provider', () => ingress.post({ type: 'autre.message' }), 400],
      ['a body over 64 KiB', () => ingress.post({ data: { title: 'x'.repeat(64 * 1024) } }), 413],
      ['a GET', () => ingress.send({}, Buffer.alloc(0), { method: 'GET' }), 405],
      ['another path', () => ingress.send({}, Buffer.alloc(0), { path: '/api/view' }), 404],
    ];
    for (const [what, send, status] of cases) assert.equal((await send()).status, status, what);
    assert.equal((await ingress.post({ type: 'composio.connected_account.expired' })).status, 200, 'another provider notice is acknowledged');
    assert.equal(s.store.view().events.receipts, 1, 'no rejected or other delivery left a receipt');
    assert.equal(eventWorks(s.store).length, 1);
    assert.equal((await ingress.post({}, PREVIOUS)).status, 200, 'the previous secret still authenticates');
    assert.equal(eventWorks(s.store).length, 2);
  } finally {
    await ingress.close();
    s.store.close();
  }
});

test('an authenticated event for a trigger no subscription names is acknowledged, counted and leaves no receipt', async () => {
  const s = space();
  account(s.store);
  subscribe(s.store);
  const ingress = await listen(s.store);
  try {
    assert.equal((await ingress.post({ triggerId: 'ti_inconnu' })).status, 200);
    assert.equal((await ingress.post({ triggerId: 'ti_inconnu' })).status, 200);
    const events = s.store.view().events;
    assert.deepEqual([events.receipts, events.ignored.n, eventWorks(s.store).length], [0, 2, 0]);
  } finally {
    await ingress.close();
    s.store.close();
  }
});

test('twelve concurrent copies, a lost acknowledgement and a restart give one work; another body under the same id changes nothing', async () => {
  const s = space();
  account(s.store);
  const subscriptionId = subscribe(s.store);
  let ingress = await listen(s.store);
  const { id, body } = eventBody(s.store.tools.ownerId);
  const headers = signHeaders(SECRET, id, body);
  try {
    const replies = await Promise.all(Array.from({ length: 12 }, () => ingress.send(headers, body)));
    assert.deepEqual(replies.map(reply => reply.status), Array(12).fill(200));
    const works = eventWorks(s.store);
    assert.equal(works.length, 1);
    const workId = works[0]?.id;
    assert.equal(ingress.wakes(), 12, 'every admitted copy wakes the worker again');

    const changed = eventBody(s.store.tools.ownerId, { id, data: { title: 'Autre contenu' } });
    assert.equal((await ingress.send(signHeaders(SECRET, id, changed.body), changed.body)).status, 409);
    const last = subscriptionOf(s.store, subscriptionId).last;
    assert.deepEqual([last?.conflicts, last?.workId, eventWorks(s.store).length], [1, workId, 1]);
    assert.doesNotMatch(s.store.view().messages.find(m => m.trigger?.kind === 'event')?.text ?? '', /Autre contenu/);

    const lost = eventBody(s.store.tools.ownerId);
    const first = s.store.receiveEvent(delivered(s.store, { id: lost.id }));
    assert.equal(first.status, 'new', 'committed, but the acknowledgement never reached the provider');
    const wakes = ingress.wakes();
    const retried = await ingress.send(signHeaders(SECRET, lost.id, lost.body), lost.body);
    assert.equal(retried.status, 200);
    assert.equal(ingress.wakes(), wakes + 1, 'the retry wakes the worker for the committed work');
    assert.equal(eventWorks(s.store).length, 2);

    await ingress.close();
    s.store.close();
    const reopened = space({ path: s.path });
    s.store = reopened.store;
    ingress = await listen(s.store);
    assert.equal((await ingress.send(signHeaders(SECRET, id, body), body)).status, 200);
    assert.deepEqual([eventWorks(s.store).length, subscriptionOf(s.store, subscriptionId).recent.find(r => r.webhookId === id)?.workId], [2, workId]);
  } finally {
    await ingress.close();
    s.store.close();
  }
});

test('a failure before commit leaves no request, origin, work or receipt, and the retry admits once', async () => {
  const s = space();
  account(s.store);
  subscribe(s.store);
  s.store.close();
  const db = new DatabaseSync(s.path);
  db.exec(`CREATE TRIGGER test_crash AFTER INSERT ON event_receipts WHEN NEW.webhook_id = 'msg_crash' BEGIN SELECT RAISE(ABORT, 'crash'); END;`);
  db.close();
  let store = space({ path: s.path }).store;
  let ingress = await listen(store);
  const { body } = eventBody(store.tools.ownerId, { id: 'msg_crash' });
  const headers = signHeaders(SECRET, 'msg_crash', body);
  try {
    assert.equal((await ingress.send(headers, body)).status, 500);
    assert.equal(eventWorks(store).length, 0);
    await ingress.close();
    store.close();
    for (const table of ['messages', 'origins', 'works', 'event_receipts']) assert.deepEqual(rows(s.path, `SELECT COUNT(*) AS n FROM ${table}`), [{ n: 0 }], table);
    const fix = new DatabaseSync(s.path);
    fix.exec('DROP TRIGGER test_crash');
    fix.close();
    store = space({ path: s.path }).store;
    ingress = await listen(store);
    assert.equal((await ingress.send(headers, body)).status, 200);
    assert.equal((await ingress.send(headers, body)).status, 200);
    assert.equal(eventWorks(store).length, 1);
  } finally {
    await ingress.close();
    store.close();
  }
});

test('at 10 000 kept identities a new id gets 503 and leaves no row, while every stored id still resolves', async () => {
  const s = space();
  account(s.store);
  const subscriptionId = subscribe(s.store);
  const first = delivered(s.store);
  admitted(s.store, { id: first.webhookId });
  s.store.close();
  const db = new DatabaseSync(s.path);
  db.exec('BEGIN');
  const insert = db.prepare(`INSERT INTO event_receipts(transport, webhook_id, subscription_id, revision, body_sha256, received_at, outcome, reason)
    VALUES (?, ?, ?, 2, 'aa', '2026-01-01T00:00:00.000Z', 'refused', 'per_day')`);
  for (let i = 1; i < 10_000; i += 1) insert.run(TRANSPORT, `msg_rempli_${i}`, subscriptionId);
  db.exec('COMMIT');
  db.close();
  const store = space({ path: s.path }).store;
  const ingress = await listen(store);
  try {
    assert.equal((await ingress.post()).status, 503);
    assert.equal((await ingress.post({ triggerId: 'ti_inconnu' })).status, 200, 'an unknown trigger is still only counted');
    const { body } = eventBody(store.tools.ownerId, { id: first.webhookId });
    assert.equal((await ingress.send(signHeaders(SECRET, first.webhookId, body), body)).status, 200, 'a stored id still resolves');
    const events = store.view().events;
    assert.deepEqual([events.receipts, events.unavailable.n, eventWorks(store).length], [10_000, 1, 1]);
  } finally {
    await ingress.close();
    store.close();
  }
  assert.deepEqual(rows(s.path, 'SELECT COUNT(*) AS n FROM event_receipts'), [{ n: 10_000 }]);
});

test('a known subscription refuses durably, answers 200 and creates no work: state, account, trigger type, daily quota and backlog', () => {
  const s = space();
  try {
    account(s.store);
    account(s.store, 'EXPIRED', 'ca_expire');
    const paused = subscribe(s.store, { triggerId: 'ti_pause' });
    move(s.store, paused, 'subscription.pause');
    const revoked = subscribe(s.store, { triggerId: 'ti_revoque' });
    move(s.store, revoked, 'subscription.revoke');
    create(s.store, { triggerId: 'ti_inactif' });
    const expired = create(s.store, { triggerId: 'ti_expire', accountId: 'ca_expire' });
    const quota = subscribe(s.store, { triggerId: 'ti_quota', perDay: 1 });
    const backlog = subscribe(s.store, { triggerId: 'ti_file', perDay: 10 });
    const reasonOf = (input: EventInput) => {
      const outcome = s.store.receiveEvent(delivered(s.store, input));
      return outcome.status === 'new' && outcome.outcome === 'refused' ? outcome.reason : `${outcome.status}`;
    };
    assert.equal(reasonOf({ triggerId: 'ti_pause' }), 'paused');
    assert.equal(reasonOf({ triggerId: 'ti_revoque' }), 'revoked');
    assert.equal(reasonOf({ triggerId: 'ti_inactif' }), 'inactive');
    assert.equal(subscriptionOf(s.store, expired).state, 'inactive');
    assert.equal(reasonOf({ triggerId: 'ti_quota', accountId: 'ca_autre' }), 'account_mismatch');
    assert.equal(reasonOf({ triggerId: 'ti_quota', slug: 'GITHUB_COMMIT_EVENT' }), 'trigger_mismatch');
    admitted(s.store, { triggerId: 'ti_quota' });
    assert.equal(reasonOf({ triggerId: 'ti_quota' }), 'per_day');
    for (let i = 0; i < 3; i += 1) admitted(s.store, { triggerId: 'ti_file' });
    assert.equal(reasonOf({ triggerId: 'ti_file' }), 'backlog');
    account(s.store, 'EXPIRED');
    assert.equal(reasonOf({ triggerId: 'ti_file' }), 'account_inactive');
    assert.equal(eventWorks(s.store).length, 4);
    account(s.store);
    const refusedOnce = delivered(s.store, { triggerId: 'ti_pause' });
    assert.equal(s.store.receiveEvent(refusedOnce).status, 'new');
    ok(s.store.dispatch({ type: 'subscription.resume', requestId: rid(), subscriptionId: paused, expectedRevision: subscriptionOf(s.store, paused).revision }));
    const again = s.store.receiveEvent(refusedOnce);
    assert.deepEqual([again.status, 'reason' in again ? again.reason : null], ['duplicate', 'paused'], 'the same event keeps its first decision after a resume');
    assert.equal(subscriptionOf(s.store, quota).today.refused, 3, 'wrong account, wrong trigger type and quota');
    assert.equal(subscriptionOf(s.store, backlog).open, 3);
  } finally {
    s.store.close();
  }
});

test('pause, revoke or a moved account stop an event request at every step before it leaves, and never publish', async () => {
  const s = space();
  account(s.store);
  const subscriptionId = subscribe(s.store, { perDay: 50 });
  const held = heldEngine();
  const worker = createWorker({ store: s.store, engines: { chat: held.engine, doc: held.engine } });
  const pause = () => move(s.store, subscriptionId, 'subscription.pause');
  const resume = () => ok(s.store.dispatch({ type: 'subscription.resume', requestId: rid(), subscriptionId, expectedRevision: subscriptionOf(s.store, subscriptionId).revision }));
  const stateOf = (workId: string) => s.store.view().works.find(w => w.id === workId);
  const replies = () => s.store.view().messages.filter(m => m.role === 'assistant').length;
  try {
    const pending = admitted(s.store);
    pause();
    assert.equal(stateOf(pending)?.state, 'cancelled', 'pause cancels a pending event request in its own transaction');
    worker.kick();
    await worker.idle();
    assert.equal(held.runs(), 0);
    resume();

    const beforeClaim = admitted(s.store);
    account(s.store, 'EXPIRED');
    assert.equal(s.store.claimNext('chat'), null, 'no claim once the account is no longer active');
    assert.equal(stateOf(beforeClaim)?.state, 'cancelled');
    account(s.store, 'ACTIVE');

    const beforeDeparture = admitted(s.store);
    const claim = s.store.claimNext('chat');
    assert(claim && claim.workId === beforeDeparture);
    pause();
    const departure = s.store.depart(claim);
    assert.equal(departure.ok, false);
    assert.match(departure.ok ? '' : departure.reason, /abonnement de cet événement/);
    assert.equal(s.store.finishJob(claim, answered('Ne doit pas paraître.')).kind, 'recorded');
    assert.deepEqual([stateOf(beforeDeparture)?.state, stateOf(beforeDeparture)?.attempt?.error], ['failed', 'L’abonnement de cet événement a été mis en pause, révoqué ou modifié, ou sa réception n’est plus configurée. Mino n’a rien lancé ni publié.']);
    resume();

    const running = admitted(s.store);
    worker.kick();
    await until(() => held.running() === 1, 'the event call runs');
    pause();
    worker.sync();
    await worker.idle();
    assert.deepEqual([stateOf(running)?.state, held.running()], ['failed', 0], 'a running call is stopped and records no reply');
    resume();

    const finishing = admitted(s.store);
    worker.kick();
    await until(() => held.running() === 1, 'the last event call runs');
    move(s.store, subscriptionId, 'subscription.revoke');
    held.finish(answered('Réponse arrivée après la révocation.', { deliverable: { title: 'Livrable tardif', body: 'Corps tardif' } }));
    await worker.idle();
    assert.equal(stateOf(finishing)?.state, 'failed');
    assert.equal(stateOf(finishing)?.versions.length, 0, 'no version after the revocation');
    assert.equal(replies(), 0, 'no reply was ever published');
    assert.equal(held.runs(), 2, 'only the two calls that departed before the change ran');

    const retry = s.store.dispatch({ type: 'work.retry', requestId: rid(), workId: running });
    assert.equal(refusal(retry), 'invalid_transition');
    assert.match(retry.ok ? '' : retry.message, /Rien n’est relancé/);
    const human = ok(s.store.dispatch({ type: 'message.send', requestId: rid(), botId: 'nova', text: 'Relance toi-même ce ticket.', attachments: [] }));
    assert.equal(human.kind, 'message', 'a new request of the person is still admitted');
  } finally {
    held.finish(answered('fin'));
    await worker.close();
    s.store.close();
  }
  const reservations = rows(s.path, `SELECT r.state FROM reservations r JOIN origins o ON o.message_id = r.source_id WHERE o.kind = 'event' ORDER BY r.rowid`).map(r => r.state);
  assert.deepEqual(reservations.filter(state => state !== 'released'), ['settled', 'settled'], 'the two permits that left stay used');
});

test('an event turn is offered no service tool, connection or mission handoff, whatever the engine sends back', async () => {
  const s = space({ serviceTools: true });
  account(s.store);
  subscribe(s.store, { botId: 'mino', triggerId: 'ti_mino' });
  const held = heldEngine();
  const desk = createActionDesk({ store: s.store, provider: createFakeProvider(), port: 9, wake: () => {} });
  const worker = createWorker({ store: s.store, engines: { chat: held.engine, doc: held.engine }, tools: desk });
  try {
    const workId = admitted(s.store, { triggerId: 'ti_mino' });
    worker.kick();
    await until(() => held.running() === 1, 'the event call runs');
    assert.equal(held.input()?.tools, undefined, 'no tool is offered');
    assert.doesNotMatch(JSON.stringify(held.input()?.turn.outputSchema), /handoff|connection/, 'the output schema asks for neither');
    held.finish(answered('Je propose une mission.', {
      handoff: { goal: 'Ouvrir une mission', coordinated: false, why: 'Le moteur le tente.' },
      connection: { service: 'gmail' },
      deliverable: { title: 'Résumé', body: 'Trois lignes.' },
    }));
    await worker.idle();
    const view = s.store.view();
    const work = view.works.find(w => w.id === workId);
    assert.deepEqual([work?.state, work?.versions.length], ['review', 1], 'a proposed deliverable is kept for the person');
    assert.equal(view.messages.find(m => m.role === 'assistant')?.handoff, null, 'no mission handoff');
    assert.equal(desk.view().connections.length, 0, 'no connection offer');
  } finally {
    await worker.close();
    await desk.close();
    s.store.close();
  }
});

test('a call to a tool the event turn was never offered is refused by the server, and nothing is proposed', async () => {
  const s = space({ serviceTools: true });
  account(s.store);
  subscribe(s.store);
  const dir = dirname(s.path);
  const chat = createCodexEngine({ command: process.execPath, args: [fixture, 'tool-call-unoffered'], workDir: dir, clientVersion: 'test', dynamicTools: true, turnTimeoutMs: 5000, requestTimeoutMs: 2000, interruptGraceMs: 300 });
  const desk = createActionDesk({ store: s.store, provider: createFakeProvider(), port: 9, wake: () => {} });
  const worker = createWorker({ store: s.store, engines: { chat, doc: chat }, tools: desk });
  try {
    const workId = admitted(s.store);
    worker.kick();
    await until(() => ['failed', 'done', 'review'].includes(s.store.view().works.find(w => w.id === workId)?.state ?? ''), 'the event call ends');
    await worker.idle();
    const work = s.store.view().works.find(w => w.id === workId);
    assert.equal(work?.state, 'failed');
    assert.match(work?.attempt?.error ?? '', /tenté d’utiliser un outil\. Mino l’a bloqué/);
    assert.equal(desk.view().proposals.length, 0);
  } finally {
    await worker.close();
    await desk.close();
    await chat.close();
    s.store.close();
  }
  assert.deepEqual(rows(s.path, 'SELECT COUNT(*) AS n FROM tool_proposals'), [{ n: 0 }]);
});

test('an event request is never searched in Honcho nor exported, and the person’s shared requests stay as they were', async () => {
  const honcho = await startFakeHoncho();
  const app = await startMemory({ honcho, events: { transport: TRANSPORT } });
  const searches = () => honcho.requests.filter(r => r.path.endsWith('/search')).length;
  try {
    await app.enable();
    await app.ask('Je préfère le thé vert le matin.');
    await app.synced();
    const [workspace = ''] = [...honcho.workspaces.keys()];
    const exported = honcho.messages(workspace).map(m => m.content);
    const searched = searches();
    account(app.store);
    subscribe(app.store, { botId: BOT, fields: ['title'] });
    const workId = admitted(app.store, { data: { title: 'Préférences du matin' } });
    app.worker.kick();
    await app.until(v => v.works.find(w => w.id === workId)?.state === 'done', 'the event request is answered');
    assert.match(app.turn().input, /événement de service/);
    await app.quiet();
    await app.synced();
    assert.equal(searches(), searched, 'no search for the event request');
    assert.deepEqual(honcho.messages(workspace).map(m => m.content), exported, 'nothing of the event was exported');
    await app.ask('Et pour le soir ?');
    assert.equal(searches(), searched + 1, 'the next request of the person is searched as before');
  } finally {
    await app.stop();
    await honcho.close();
  }
});

test('deleting the bot erases instruction, fields, digests and command fingerprints, keeps identities, and a replay creates nothing', async () => {
  const s = space();
  account(s.store);
  const subscriptionId = subscribe(s.store, { text: 'Consigne privée canari-7f3a9c.' });
  const event = delivered(s.store, { data: { title: 'Titre privé canari-b41e2d' } });
  const workId = admitted(s.store, { id: event.webhookId, data: { title: 'Titre privé canari-b41e2d' } });
  const held = heldEngine();
  const worker = createWorker({ store: s.store, engines: { chat: held.engine, doc: held.engine } });
  try {
    worker.kick();
    await until(() => held.running() === 1, 'the event call runs');
    held.finish(answered('Réponse canari-b41e2d.'));
    await worker.idle();
    assert.equal(s.store.view().works.find(w => w.id === workId)?.state, 'done');
    const nova = s.store.view().bots.find(bot => bot.id === 'nova');
    assert(nova);
    assert.equal(nova.deletion.subscriptions, 1);
    ok(s.store.dispatch({ type: 'bot.delete', requestId: rid(), botId: 'nova', confirmName: nova.name, expected: nova.deletion }));
    const sub = subscriptionOf(s.store, subscriptionId);
    assert.deepEqual([sub.state, sub.text, sub.fields, sub.last?.workId, sub.last?.retired], ['revoked', '', [], null, true]);
    const replay = s.store.receiveEvent(event);
    assert.deepEqual([replay.status, 'workId' in replay ? replay.workId : 'none'], ['duplicate', null], 'a replay after the erasure creates nothing');
    const fresh = s.store.receiveEvent(delivered(s.store));
    assert.deepEqual([fresh.status, 'reason' in fresh ? fresh.reason : null], ['new', 'revoked']);
  } finally {
    await worker.close();
    s.store.close();
  }
  assert.deepEqual(rows(s.path, `SELECT state, text, fields FROM event_subscriptions`), [{ state: 'revoked', text: '', fields: '[]' }]);
  assert.deepEqual(rows(s.path, `SELECT COUNT(*) AS n FROM event_receipts WHERE body_sha256 IS NOT NULL OR message_id IS NOT NULL`), [{ n: 0 }]);
  assert.deepEqual(rows(s.path, `SELECT COUNT(*) AS n FROM commands WHERE type LIKE 'subscription.%' AND fingerprint <> ''`), [{ n: 0 }]);
  assert.deepEqual(rows(s.path, 'PRAGMA foreign_key_check'), []);
  assert.deepEqual(rows(s.path, 'PRAGMA integrity_check'), [{ integrity_check: 'ok' }]);
  const bytes = ['', '-wal'].map(suffix => { try { return readFileSync(s.path + suffix); } catch { return Buffer.alloc(0); } });
  for (const canary of ['canari-7f3a9c', 'canari-b41e2d', event.bodySha256]) {
    assert(bytes.every(file => !file.includes(Buffer.from(canary))), `${canary.slice(0, 13)} is gone from the database files`);
  }
});

test('subscription commands: inactive at creation, activation needs the transport and an active account, stale or frozen edits are refused', () => {
  const off = space({ transport: null });
  try {
    account(off.store);
    assert.equal(refusal(off.store.dispatch({ type: 'subscription.create', requestId: rid(), ...BASE })), 'invalid_transition');
  } finally {
    off.store.close();
  }
  const s = space();
  try {
    assert.equal(refusal(s.store.dispatch({ type: 'subscription.create', requestId: rid(), ...BASE })), 'not_found', 'an unknown account');
    account(s.store, 'INITIATED');
    const id = create(s.store);
    assert.deepEqual([subscriptionOf(s.store, id).state, subscriptionOf(s.store, id).revision], ['inactive', 1]);
    assert.equal(s.store.receiveEvent(delivered(s.store)).status, 'new', 'an inactive subscription refuses');
    assert.equal(refusal(s.store.dispatch({ type: 'subscription.activate', requestId: rid(), subscriptionId: id, expectedRevision: 1 })), 'invalid_transition', 'not while the account is not active');
    account(s.store);
    ok(s.store.dispatch({ type: 'subscription.update', requestId: rid(), subscriptionId: id, expectedRevision: 1, text: 'Nouvelle consigne.', fields: [], perDay: 5 }));
    assert.equal(refusal(s.store.dispatch({ type: 'subscription.activate', requestId: rid(), subscriptionId: id, expectedRevision: 1 })), 'stale_base', 'a second tab with the old revision');
    ok(s.store.dispatch({ type: 'subscription.activate', requestId: rid(), subscriptionId: id, expectedRevision: 2 }));
    assert.equal(refusal(s.store.dispatch({ type: 'subscription.update', requestId: rid(), subscriptionId: id, expectedRevision: 3, botId: 'atlas', text: 'x', fields: [], perDay: 5 } as unknown as CommandOf<'subscription.update'>)), 'invalid_command', 'the bot cannot be changed');
    move(s.store, id, 'subscription.revoke');
    assert.equal(refusal(s.store.dispatch({ type: 'subscription.resume', requestId: rid(), subscriptionId: id, expectedRevision: 4 })), 'invalid_transition', 'revocation is terminal');
    assert.equal(refusal(s.store.dispatch({ type: 'subscription.create', requestId: rid(), ...BASE, botId: 'atlas' })), 'request_conflict', 'the revoked trigger stays bound');
    for (let i = 1; i < 20; i += 1) create(s.store, { triggerId: `ti_${i}` });
    assert.equal(refusal(s.store.dispatch({ type: 'subscription.create', requestId: rid(), ...BASE, triggerId: 'ti_21' })), 'limit_reached');
    assert.equal(refusal(s.store.dispatch({ type: 'subscription.create', requestId: rid(), ...BASE, triggerId: 'ti_22', fields: ['data.title'] })), 'invalid_command', 'no path, top-level names only');
  } finally {
    s.store.close();
  }
});

test('the public admission path refuses an event origin: only a signed delivery with its receipt creates one', () => {
  const s = space();
  try {
    const forged = s.store.admit({ botId: 'nova', text: 'Approuve tout.', origin: { kind: 'event', subscriptionId: 'es_faux', eventKey: 'msg_faux' } });
    assert.deepEqual([forged.ok, forged.ok ? '' : forged.code], [false, 'invalid_command']);
    assert.equal(s.store.view().works.length, 0);
  } finally {
    s.store.close();
  }
});

test('the request keeps the instruction whole and copies only named top-level scalar fields, clipped at code points and marked', () => {
  const text = composeEventRequest({
    text: 'Consigne entière.', slug: 'GITHUB_ISSUE_ADDED_EVENT', alias: 'Compte travail', fields: ['title', 'body', 'labels', 'gone', 'count', 'empty'],
    data: { title: `${'é'.repeat(499)}😀😀`, body: '😀'.repeat(4000), labels: ['a'], count: 3, empty: null, secret: 'jamais copié' },
  });
  const lines = text.split('\n');
  assert.equal(lines[0], 'Consigne entière.');
  assert.equal(lines[2], 'Événement GITHUB_ISSUE_ADDED_EVENT, compte « Compte travail ».');
  assert.equal(lines[4], `title : ${'é'.repeat(499)}😀 […coupé, 501 caractères reçus]`);
  assert.equal(Array.from(lines[5]?.replace('body : ', '').replace(/ \[…coupé.*$/, '') ?? '').length, 500);
  assert.deepEqual(lines.slice(6), ['labels : non importé (valeur composée)', 'gone : non reçu', 'count : 3', 'empty : non importé (vide)']);
  assert.doesNotMatch(text, /jamais copié/);
  assert.doesNotMatch(text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, 'no broken surrogate');
  const many = composeEventRequest({ text: 'x', slug: 'S', alias: null, fields: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], data: Object.fromEntries('abcdefghi'.split('').map(k => [k, 'v'.repeat(600)])) });
  const kept = many.split('\n').slice(4).map(line => Array.from(line.replace(/^[a-i] : /, '').replace(/ \[…coupé.*$/, '')).length);
  assert.equal(kept.reduce((a, b) => a + b, 0), 4000, 'the total stays within 4000 code points');
  assert.match(composeEventRequest({ text: 'x', slug: 'S', alias: null, fields: [], data: { title: 'privé' } }), /Aucun contenu de l’événement n’est transmis\.$/);
});

test('event settings are off by default, refused when incomplete, and both secrets leave the environment', () => {
  assert.equal(takeEventIngressConfig({}), null);
  const partial: NodeJS.ProcessEnv = { COMPOSIO_WEBHOOK_SECRET: SECRET };
  assert.throws(() => takeEventIngressConfig(partial), EventIngressConfigError);
  assert.equal(partial.COMPOSIO_WEBHOOK_SECRET, undefined, 'removed even when refused');
  assert.throws(() => takeEventIngressConfig({ MINO_EVENTS_TRANSPORT: TRANSPORT, MINO_EVENTS_PORT: '4400', COMPOSIO_WEBHOOK_SECRET: 'court' }), EventIngressConfigError);
  assert.throws(() => takeEventIngressConfig({ MINO_EVENTS_TRANSPORT: TRANSPORT, MINO_EVENTS_PORT: '4400', COMPOSIO_WEBHOOK_SECRET: SECRET, MINO_EVENTS_BIND: 'localhost' }), EventIngressConfigError);
  const env: NodeJS.ProcessEnv = { MINO_EVENTS_TRANSPORT: TRANSPORT, MINO_EVENTS_PORT: '4400', COMPOSIO_WEBHOOK_SECRET: SECRET, COMPOSIO_WEBHOOK_SECRET_PREVIOUS: PREVIOUS, PATH: '/bin' };
  const config = takeEventIngressConfig(env);
  assert.deepEqual([config?.transport, config?.port, config?.bind, config?.secrets.map(secret => secret.toString())], [TRANSPORT, 4400, '127.0.0.1', [SECRET, PREVIOUS]]);
  assert.deepEqual(Object.keys(env).sort(), ['MINO_EVENTS_PORT', 'MINO_EVENTS_TRANSPORT', 'PATH']);
  assert.deepEqual(Object.keys(childEnv({ COMPOSIO_WEBHOOK_SECRET: SECRET, COMPOSIO_WEBHOOK_SECRET_PREVIOUS: PREVIOUS, PATH: '/bin' })), ['PATH']);
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

async function startCompiled(dataDir: string, env: Record<string, string>) {
  const port = await freePort();
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/main.js', import.meta.url))], {
    env: { PATH: process.env.PATH, MINO_PORT: String(port), MINO_DATA_DIR: dataDir, MINO_CODEX_BIN: '/bin/false', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const wanted = env.MINO_EVENTS_PORT ? '"event":"events-ready"' : '"event":"ready"';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Server startup timed out: ' + output)), 10_000);
    const exited = (code: number | null) => { clearTimeout(timer); reject(Error(`Server exited ${code}: ${output}`)); };
    child.once('exit', exited);
    const read = (data: unknown) => {
      output += String(data);
      if (output.includes(wanted) && output.includes('"event":"ready"')) { clearTimeout(timer); child.off('exit', exited); resolve(); }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
  });
  return {
    port, output: () => output,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const done = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await done;
    },
  };
}

test('the compiled server restarts with active, paused and revoked subscriptions, with reception on and then off', async () => {
  const s = space();
  account(s.store);
  const active = subscribe(s.store, { triggerId: 'ti_actif' });
  move(s.store, subscribe(s.store, { triggerId: 'ti_pause' }), 'subscription.pause');
  move(s.store, subscribe(s.store, { triggerId: 'ti_revoque' }), 'subscription.revoke');
  const owner = s.store.tools.ownerId;
  s.store.close();
  const eventsPort = await freePort();
  const on = await startCompiled(dirname(s.path), { MINO_EVENTS_TRANSPORT: TRANSPORT, MINO_EVENTS_PORT: String(eventsPort), COMPOSIO_WEBHOOK_SECRET: SECRET });
  try {
    const { id, body } = eventBody(owner, { triggerId: 'ti_actif' });
    const reply = await fetch(`http://127.0.0.1:${eventsPort}/events/composio`, { method: 'POST', headers: signHeaders(SECRET, id, body), body });
    assert.equal(reply.status, 200);
    const view = await (await fetch(`http://127.0.0.1:${on.port}/api/view`)).json() as { events: { reception: { state: string }; subscriptions: SubscriptionView[] } };
    assert.equal(view.events.reception.state, 'configured');
    assert.deepEqual(view.events.subscriptions.map(sub => sub.state), ['active', 'paused', 'revoked']);
    assert.equal(view.events.subscriptions.find(sub => sub.id === active)?.last?.outcome, 'admitted');
    assert.equal((await fetch(`http://127.0.0.1:${eventsPort}/api/view`)).status, 404, 'the event listener serves nothing of the PC');
    assert.doesNotMatch(on.output(), new RegExp(SECRET), 'the secret is never logged');
  } finally {
    await on.stop();
  }
  const off = await startCompiled(dirname(s.path), {});
  try {
    const view = await (await fetch(`http://127.0.0.1:${off.port}/api/view`)).json() as { events: { reception: { state: string }; subscriptions: SubscriptionView[] } };
    assert.deepEqual([view.events.reception.state, view.events.subscriptions.length], ['off', 3]);
    await assert.rejects(fetch(`http://127.0.0.1:${eventsPort}/events/composio`, { method: 'POST' }), 'nothing listens without configuration');
  } finally {
    await off.stop();
  }
  const bytes = ['', '-wal'].map(suffix => { try { return readFileSync(s.path + suffix); } catch { return Buffer.alloc(0); } });
  assert(bytes.every(file => !file.includes(Buffer.from(SECRET))), 'the secret never reaches the database');
});
