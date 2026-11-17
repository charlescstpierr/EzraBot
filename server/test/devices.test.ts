import { mkdtempSync } from './fixtures/temp.js';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { z } from 'zod';
import { openDevices } from '../src/devices.js';
import { createDeviceServer } from '../src/device-http.js';
import { createHttpServer } from '../src/http.js';
import { loadMascots } from '../src/domain.js';
import type { Engine } from '../src/engine.js';
import { MobileSnapshotSchema, MobileReplySchema, PairStatusSchema, phoneCheckinActions, phoneRoutineActions, phoneSubscriptionActions } from '../src/mobile-protocol.js';
import { openStore } from '../src/store.js';
import { createWorker } from '../src/worker.js';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
async function port(): Promise<number> {
  const probe = createServer(); await new Promise<void>(r => probe.listen(0, '127.0.0.1', r)); const address = probe.address();
  await new Promise<void>(r => probe.close(() => r())); if (!address || typeof address === 'string') throw new Error('Missing port'); return address.port;
}
const closeServer = async (server: Server) => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); };
async function fixture(memory?: { workspacePrefix: string }, events?: { transport: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'mino-device-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
  const cert = readFileSync(join(dir, 'cert.pem'), 'utf8'); const key = readFileSync(join(dir, 'key.pem'), 'utf8');
  const store = openStore({ path: join(dir, 'app.sqlite'), mascots: loadMascots(join(root, 'assets/mascots.json')), ...(memory ? { memory } : {}), ...(events ? { events } : {}) });
  const engine: Engine = {
    status: () => ({ state: 'ready', account: 'chatgpt', models: [{ id: 'test', displayName: 'Test', isDefault: true, efforts: ['low'], defaultEffort: 'low', speeds: [] }] }),
    catalog: async () => engine.status(), close: async () => {}, onUsage: () => () => {},
    run: async input => { const id = randomUUID(); input.onThread('thread_' + id); input.onTurn('turn_' + id); const departure = input.depart(); if (!departure.ok) return { kind: 'failed', code: 'admission_refused', message: departure.reason }; return { kind: 'succeeded', reply: { reply: 'Réponse de contrôle', deliverable: { title: 'Plan Boréal', body: 'Budget 8 000 €' } }, used: { model: 'test', effort: 'low', speed: 'standard' }, threadId: 'thread_' + id, turnId: 'turn_' + id }; },
  };
  const worker = createWorker({ store, engines: { chat: engine, doc: engine } });
  const devicePort = await port(); const localPort = await port();
  const url = `https://127.0.0.1:${devicePort}`; const localUrl = `http://127.0.0.1:${localPort}`;
  const devices = openDevices({ path: join(dir, 'devices.sqlite'), spaceId: store.view().spaceId, publicUrl: url });
  const server = createDeviceServer({ store, worker, engine, devices, publicUrl: url, cert, key, longPollMs: 300 });
  const local = createHttpServer({ store, worker, engine, devices, port: localPort, root, csrfToken: 'local-test-token' });
  await Promise.all([new Promise<void>(r => server.listen(devicePort, '127.0.0.1', r)), new Promise<void>(r => local.listen(localPort, '127.0.0.1', r))]);
  const credential = { deviceId: randomUUID(), deviceName: 'Téléphone de test', deviceToken: randomBytes(32).toString('hex') };
  const auth = { authorization: `Bearer ${credential.deviceToken}`, 'x-mino-space': store.view().spaceId };
  function call(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown; headers: import('node:http').IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const req = request(url + path, { ca: cert, servername: 'localhost', method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, timeout: 2500 }, res => {
        let text = ''; res.on('data', chunk => { text += String(chunk); }); res.on('end', () => { try { const value: unknown = JSON.parse(text); resolve({ status: res.statusCode ?? 0, body: value, headers: res.headers }); } catch (error) { reject(error); } });
      }); req.on('error', reject); req.on('timeout', () => req.destroy(new Error('TLS request timed out'))); if (body !== undefined) req.write(JSON.stringify(body)); req.end();
    });
  }
  async function pair() {
    const grant = devices.createGrant();
    const claim = { pairingId: grant.pairingId, secret: grant.secret, ...credential };
    const pending = PairStatusSchema.parse((await call('/m/pair/claim', claim)).body);
    devices.approve(grant.pairingId, credential.deviceId, pending.confirmCode);
    return { grant, claim, pending };
  }
  return { dir, store, engine, worker, devices, call, auth, credential, pair, localUrl, cert, key, url, async close() { await closeServer(server); await closeServer(local); await worker.close(); store.close(); devices.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('TLS device routes require PC confirmation, refuse foreign browser origins and preserve the local CSRF boundary', async () => {
  const f = await fixture();
  try {
    for (const path of ['/m/view', '/m/catalog', '/m/pair/status', '/m/not-a-route']) assert.equal((await f.call(path)).status, 401);
    assert.equal((await f.call('/api/view')).status, 404);
    const grant = f.devices.createGrant(); const claim = { pairingId: grant.pairingId, secret: grant.secret, ...f.credential };
    const pending = PairStatusSchema.parse((await f.call('/m/pair/claim', claim)).body);
    assert.equal(pending.state, 'pending');
    assert.equal((await f.call('/m/view', undefined, f.auth)).status, 403);
    assert.equal((await fetch(f.localUrl + '/api/devices/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pairingId: grant.pairingId, deviceId: f.credential.deviceId, confirmCode: pending.confirmCode }) })).status, 403);
    assert.equal((await fetch(f.localUrl + '/api/devices/approve', { method: 'POST', headers: { 'content-type': 'application/json', origin: f.localUrl, 'x-mino-csrf': 'local-test-token' }, body: JSON.stringify({ pairingId: grant.pairingId, deviceId: f.credential.deviceId, confirmCode: pending.confirmCode }) })).status, 200);
    assert.equal(PairStatusSchema.parse((await f.call('/m/pair/status', undefined, f.auth)).body).state, 'active');
    assert.equal(PairStatusSchema.parse((await f.call('/m/pair/claim', claim)).body).state, 'active');
    assert.equal((await f.call('/m/view', undefined, { ...f.auth, origin: 'https://untrusted.invalid' })).status, 403);
    assert.equal((await f.call('/m/view', undefined, { ...f.auth, host: 'untrusted.invalid' })).status, 421);
    assert.equal((await f.call('/m/view', undefined, { ...f.auth, 'x-mino-space': 'another-space' })).status, 409);
    assert.equal((await f.call('/m/view', undefined, f.auth)).headers['access-control-allow-origin'], undefined);
    assert.equal((await fetch(f.localUrl + '/m/view', { headers: f.auth })).status, 404);
  } finally { await f.close(); }
});

test('native commands keep receipts, natural tasks, exact approval, and revocation stops an already open poll', async () => {
  const f = await fixture();
  try {
    const { grant } = await f.pair();
    const command = { type: 'message.say', requestId: 'mobile-boreal-1', botId: 'mino', text: 'Prépare le plan du café Boréal', attachments: [] };
    const first = MobileReplySchema.parse((await f.call('/m/commands', command, f.auth)).body);
    assert.equal(first.ok, true);
    const replay = MobileReplySchema.parse((await f.call('/m/commands', command, f.auth)).body);
    assert.equal(replay.ok && replay.replayed, true);
    const different = MobileReplySchema.parse((await f.call('/m/commands', { ...command, text: 'Autre demande' }, f.auth)).body);
    assert.equal(!different.ok && different.code, 'request_conflict');
    assert.equal(f.store.view().messages.filter(m => m.role === 'user').length, 1);
    assert.equal(f.store.view().tasks.length, 1);
    for (let n = 0; n < 100 && !f.store.view().works[0]?.versions.length; n++) await new Promise(r => setTimeout(r, 10));
    const work = f.store.view().works[0]; const version = work?.versions[0]; assert.ok(work && version);
    const proposed = MobileReplySchema.parse((await f.call('/m/commands', { type: 'publication.propose', requestId: 'mobile-propose-1', workId: work.id, versionId: version.id, destination: 'carnet' }, f.auth)).body);
    assert.equal(proposed.ok, true);
    const proposal = f.store.view().works[0]?.proposals[0]; assert.ok(proposal);
    const approve = { type: 'publication.approve', requestId: 'mobile-approve-1', proposalId: proposal.id, action: proposal.action, destination: proposal.destination, versionId: proposal.versionId, payloadSha256: proposal.payloadSha256 };
    assert.equal((await f.call('/m/commands', { ...approve, payloadSha256: '0'.repeat(64) }, f.auth)).status, 409);
    const approved = MobileReplySchema.parse((await f.call('/m/commands', approve, f.auth)).body); assert.equal(approved.ok, true);
    await f.call('/m/commands', approve, f.auth); assert.equal(f.store.view().carnet.length, 1);
    assert.equal((await f.call('/m/commands', { type: 'storage.purge', requestId: 'mobile-purge-1' }, f.auth)).status, 403);
    const snapshot = MobileSnapshotSchema.parse((await f.call('/m/view', undefined, f.auth)).body);
    const waiting = f.call(`/m/view?after=${snapshot.rev}`, undefined, f.auth);
    await new Promise(r => setTimeout(r, 40)); f.devices.revoke(f.credential.deviceId);
    assert.equal((await waiting).status, 401);
    assert.equal((await f.call('/m/view', undefined, f.auth)).status, 401);
    const bytes = readFileSync(join(f.dir, 'devices.sqlite'));
    assert.equal(bytes.includes(Buffer.from(f.credential.deviceToken)), false);
    assert.equal(bytes.includes(Buffer.from(grant.secret)), false);
  } finally { await f.close(); }
});

test('pair expiry, single claimant, persistent revocation and database identity are enforced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mino-auth-')); const path = join(dir, 'devices.sqlite'); let now = 1_800_000_000_000;
  let devices = openDevices({ path, spaceId: 'space-a', publicUrl: 'https://mino.example:4319', now: () => now });
  try {
    const grant = devices.createGrant(); const claim = { pairingId: grant.pairingId, secret: grant.secret, deviceId: randomUUID(), deviceName: 'iPhone', deviceToken: randomBytes(32).toString('hex') };
    const pending = devices.claim(claim); assert.deepEqual(devices.claim(claim), pending);
    assert.throws(() => devices.claim({ ...claim, deviceId: randomUUID() }));
    assert.throws(() => devices.approve(grant.pairingId, claim.deviceId, 'wrong'));
    now += 300_001; assert.throws(() => devices.approve(grant.pairingId, claim.deviceId, pending.confirmCode));
    const fresh = devices.createGrant(); const valid = { ...claim, pairingId: fresh.pairingId, secret: fresh.secret, deviceId: randomUUID(), deviceToken: randomBytes(32).toString('hex') };
    const next = devices.claim(valid); devices.approve(fresh.pairingId, valid.deviceId, next.confirmCode);
    devices.close(); devices = openDevices({ path, spaceId: 'space-a', publicUrl: 'https://mino.example:4319', now: () => now });
    assert.equal(devices.authenticate(valid.deviceToken, 'space-a').state, 'active');
    devices.close(); devices = openDevices({ path, spaceId: 'space-b', publicUrl: 'https://mino.example:4319', now: () => now });
    assert.throws(() => devices.authenticate(valid.deviceToken, 'space-a'), error => error instanceof Error && 'code' in error && error.code === 'space_mismatch');
    devices.close(); devices = openDevices({ path, spaceId: 'space-a', publicUrl: 'https://mino.example:4319', now: () => now });
    devices.revoke(valid.deviceId);
    devices.close(); devices = openDevices({ path, spaceId: 'space-a', publicUrl: 'https://mino.example:4319', now: () => now });
    assert.throws(() => devices.authenticate(valid.deviceToken, 'space-a'));
    assert.equal(z.array(z.object({ state: z.string() })).parse(devices.list()).at(-1)?.state, 'expired');
  } finally { devices.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('gateway rejects insecure TLS configuration and limits pairing attempts without disclosing state', async () => {
  const f = await fixture();
  try {
    const options = { store: f.store, worker: f.worker, engine: f.engine, devices: f.devices, publicUrl: f.url, cert: f.cert, key: f.key };
    assert.throws(() => createDeviceServer({ ...options, publicUrl: f.url.replace('https:', 'http:') }));
    assert.throws(() => createDeviceServer({ ...options, publicUrl: 'https://different.invalid:4319' }));
    assert.throws(() => createDeviceServer({ ...options, cert: '' }));
    assert.throws(() => createDeviceServer({ ...options, key: '' }));
    for (let n = 0; n < 30; n++) assert.equal((await f.call('/m/pair/claim', {})).status, 422);
    assert.equal((await f.call('/m/pair/claim', {})).status, 429);
    assert.equal(f.store.view().messages.length, 0);
  } finally { await f.close(); }
});

test('a large snapshot cannot hide the receipt of a committed command', async () => {
  const f = await fixture();
  try {
    await f.pair();
    f.store.dispatch({ type: 'message.say', requestId: 'large-seed-1', botId: 'mino', text: 'Bonjour', attachments: [] });
    const original = f.store.view;
    const seed = original().messages[0]; assert.ok(seed);
    const history = Array.from({ length: 650 }, (_, n) => ({ ...seed, id: `historic-${n}`, text: 'X'.repeat(20_000) }));
    f.store.view = () => ({ ...original(), messages: [...original().messages, ...history] });
    const command = { type: 'message.say', requestId: 'large-committed-1', botId: 'mino', text: 'Bonjour encore', attachments: [] };
    const first = MobileReplySchema.parse((await f.call('/m/commands', command, f.auth)).body);
    const second = MobileReplySchema.parse((await f.call('/m/commands', command, f.auth)).body);
    assert.equal(first.ok, true); assert.equal(second.ok && second.replayed, true);
    assert.equal(original().messages.filter(m => m.role === 'user').length, 2);
  } finally { await f.close(); }
});

test('a paired device cannot grant, approve, refuse or retry a service action, nor prepare one from a document version, and its snapshot carries no tools field', async () => {
  const f = await fixture();
  try {
    await f.pair();
    for (const command of [
      { type: 'tools.grant', requestId: 'mobile-tools-1', botId: 'mino', accountId: 'ca_synthetique_a', toolSlugs: ['GMAIL_SEND_EMAIL'] },
      { type: 'tools.approve', requestId: 'mobile-tools-2', proposalId: 'tp_1', fingerprint: 'a'.repeat(64) },
      { type: 'tools.refuse', requestId: 'mobile-tools-3', proposalId: 'tp_1' },
      { type: 'tools.revoke', requestId: 'mobile-tools-4', botId: 'mino', grantId: 'tg_1' },
      { type: 'tools.report.retry', requestId: 'mobile-tools-5', executionId: 'tx_1' },
    ]) {
      const refused = await f.call('/m/commands', command, f.auth);
      assert.deepEqual([refused.status, z.object({ code: z.string() }).parse(refused.body).code], [422, 'invalid_command'], command.type);
    }
    const sourced = await f.call('/m/commands', { type: 'message.send', requestId: 'mobile-source-1', botId: 'mino', text: 'Envoie cette version', attachments: [], source: { workId: 'w_1', versionId: 'v_1' } }, f.auth);
    assert.deepEqual([sourced.status, z.object({ code: z.string() }).parse(sourced.body).code], [403, 'command_refused'], 'an action from a document version is prepared on the PC only');
    for (const path of ['/m/tools/commands', '/m/tools/catalog', '/api/tools/catalog']) assert.equal((await f.call(path, undefined, f.auth)).status, 404, path);
    assert.equal((await f.call('/m/tools/commands', { type: 'tools.refuse', requestId: 'mobile-tools-6', proposalId: 'tp_1' }, f.auth)).status, 404);
    const snapshot = z.record(z.string(), z.unknown()).parse((await f.call('/m/view', undefined, f.auth)).body);
    assert.equal('tools' in snapshot, false);
    MobileSnapshotSchema.parse(snapshot);
  } finally { await f.close(); }
});

test('a paired device sees the Honcho state of a character and gets a clear refusal for every memory command', async () => {
  const f = await fixture({ workspacePrefix: 'ezra-essai' });
  try {
    await f.pair();
    const enabled = f.store.memory.apply({ type: 'memory.enable', requestId: 'pc-enable-0001', botId: 'nova', label: 'Projet synthétique', acknowledged: true });
    assert.equal(enabled.ok, true);
    const snapshot = MobileSnapshotSchema.parse((await f.call('/m/view', undefined, f.auth)).body);
    assert.deepEqual(snapshot.bots.map(bot => [bot.id, bot.memoryScope ?? null]).filter(([, scope]) => scope), [['nova', { label: 'Projet synthétique', state: 'preparing' }]]);
    for (const command of [
      { type: 'memory.declare', requestId: 'mobile-declare-1', botId: 'nova', text: 'Déclaration depuis le téléphone' },
      { type: 'memory.forget', requestId: 'mobile-forget-01', botId: 'nova', confirmLabel: 'Projet synthétique' },
      { type: 'memory.enable', requestId: 'mobile-enable-01', botId: 'atlas', label: 'Autre projet', acknowledged: true },
    ]) {
      const refused = await f.call('/m/commands', command, f.auth);
      assert.deepEqual([refused.status, refused.body], [403, { ok: false, code: 'command_refused', message: 'La mémoire Honcho d’un personnage se gère sur l’ordinateur.' }]);
    }
    const local = MobileReplySchema.parse((await f.call('/m/commands', { type: 'memory.create', requestId: 'mobile-memory-1', botId: 'nova', text: 'Souvenir local parallèle' }, f.auth)).body);
    assert.equal(!local.ok && local.code, 'invalid_transition');
    assert.match(local.ok ? '' : local.message, /mémoire Honcho/);
    assert.deepEqual(f.store.memory.view().scopes.map(scope => [scope.botId, scope.state, scope.declarations.length]), [['nova', 'preparing', 0]]);
    const other = MobileReplySchema.parse((await f.call('/m/commands', { type: 'memory.create', requestId: 'mobile-memory-2', botId: 'atlas', text: 'Souvenir local d’un personnage sans projet' }, f.auth)).body);
    assert.equal(other.ok, true, 'a character without a Honcho project keeps its local memories');
  } finally { await f.close(); }
});

test('a paired phone reads routines and can only pause or plainly resume them; every other routine command stays on the PC, and revocation stops it', async () => {
  const f = await fixture();
  try {
    await f.pair();
    const created = f.store.dispatch({ type: 'routine.create', requestId: 'pc-routine-1', botId: 'nova', text: 'Point du matin', time: '08:30', weekdays: [1, 2, 3, 4, 5], zone: 'America/Toronto', endsOn: new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10), cap: 10 });
    assert(created.ok && created.result.kind === 'routine');
    const routineId = created.result.routineId;
    const seen = () => f.store.view().routines.find(r => r.id === routineId);
    const viewed = MobileSnapshotSchema.parse((await f.call('/m/view', undefined, f.auth)).body).routines?.find(r => r.id === routineId);
    assert.deepEqual(viewed && [viewed.text, viewed.state, viewed.upcoming.length > 0], ['Point du matin', 'inactive', true]);
    assert.deepEqual(phoneRoutineActions({ state: 'inactive' }), [], 'an inactive routine shows no phone button');
    const fields = { text: 'Autre', time: '09:00', weekdays: [1], zone: 'UTC', endsOn: viewed?.endsOn ?? '', cap: 3 };
    for (const command of [
      { type: 'routine.create', requestId: 'phone-routine-create', botId: 'nova', ...fields },
      { type: 'routine.update', requestId: 'phone-routine-update', routineId, expectedRevision: 1, ...fields },
      { type: 'routine.activate', requestId: 'phone-routine-activate', routineId, expectedRevision: 1 },
      { type: 'routine.delete', requestId: 'phone-routine-delete', routineId },
      { type: 'routine.resume', requestId: 'phone-routine-confirm', routineId, confirmBlocker: 'call:res_1' },
    ]) {
      const refused = await f.call('/m/commands', command, f.auth);
      assert.deepEqual([refused.status, (refused.body as { code?: string }).code], [403, 'command_refused'], command.type);
    }
    assert.equal(seen()?.revision, 1, 'nothing changed from the phone');
    const activated = f.store.dispatch({ type: 'routine.activate', requestId: 'pc-routine-activate', routineId, expectedRevision: 1 });
    assert.equal(activated.ok, true);
    assert.deepEqual(phoneRoutineActions({ state: 'active' }), ['pause']);
    const paused = MobileReplySchema.parse((await f.call('/m/commands', { type: 'routine.pause', requestId: 'phone-routine-pause', routineId }, f.auth)).body);
    assert.equal(paused.ok && paused.view.routines?.find(r => r.id === routineId)?.state, 'paused');
    assert.deepEqual(phoneRoutineActions({ state: 'paused' }), ['resume']);
    const resumed = MobileReplySchema.parse((await f.call('/m/commands', { type: 'routine.resume', requestId: 'phone-routine-resume', routineId }, f.auth)).body);
    assert.equal(resumed.ok && resumed.view.routines?.find(r => r.id === routineId)?.state, 'active');
    f.devices.revoke(f.credential.deviceId);
    assert.equal((await f.call('/m/commands', { type: 'routine.pause', requestId: 'phone-routine-pause-2', routineId }, f.auth)).status, 401);
    assert.equal(seen()?.state, 'active', 'a revoked phone paused nothing');
  } finally { await f.close(); }
});

test('a paired phone sees subscriptions without their instruction and may only pause one; a revoked phone pauses nothing', async () => {
  const f = await fixture(undefined, { transport: 'projet-essai' });
  try {
    await f.pair();
    f.store.tools.observeAccount({ id: 'ca_1', toolkit: 'github', alias: 'Compte travail', status: 'ACTIVE' });
    const created = f.store.dispatch({ type: 'subscription.create', requestId: 'pc-sub-1', botId: 'nova', accountId: 'ca_1', triggerId: 'ti_1', triggerSlug: 'GITHUB_ISSUE_ADDED_EVENT', text: 'Consigne privée', fields: ['title'], perDay: 20 });
    assert(created.ok && created.result.kind === 'subscription');
    const subscriptionId = created.result.subscriptionId;
    const seen = () => f.store.view().events.subscriptions.find(sub => sub.id === subscriptionId);
    const viewed = await f.call('/m/view', undefined, f.auth);
    assert.equal(MobileSnapshotSchema.parse(viewed.body).events?.subscriptions[0]?.state, 'inactive');
    assert.doesNotMatch(JSON.stringify((viewed.body as { events?: unknown }).events), /Consigne privée|"fields"|ti_1/, 'the phone never receives the instruction, fields or trigger id');
    const scope = { text: 'Autre', fields: [], perDay: 5 };
    for (const command of [
      { type: 'subscription.create', requestId: 'phone-sub-create', botId: 'nova', accountId: 'ca_1', triggerId: 'ti_2', triggerSlug: 'GITHUB_ISSUE_ADDED_EVENT', ...scope },
      { type: 'subscription.update', requestId: 'phone-sub-update', subscriptionId, expectedRevision: 1, ...scope },
      { type: 'subscription.activate', requestId: 'phone-sub-activate', subscriptionId, expectedRevision: 1 },
      { type: 'subscription.resume', requestId: 'phone-sub-resume', subscriptionId, expectedRevision: 1 },
      { type: 'subscription.revoke', requestId: 'phone-sub-revoke', subscriptionId },
    ]) {
      const refused = await f.call('/m/commands', command, f.auth);
      assert.deepEqual([refused.status, (refused.body as { code?: string }).code], [403, 'command_refused'], command.type);
    }
    const extra = await f.call('/m/commands', { type: 'subscription.pause', requestId: 'phone-sub-extra', subscriptionId, state: 'active' }, f.auth);
    assert.equal(extra.status, 422, 'an extra field is refused');
    assert.deepEqual([seen()?.revision, seen()?.state], [1, 'inactive'], 'nothing changed from the phone');
    assert(f.store.dispatch({ type: 'subscription.activate', requestId: 'pc-sub-activate', subscriptionId, expectedRevision: 1 }).ok);
    assert.deepEqual(phoneSubscriptionActions({ state: 'active' }), ['pause']);
    const paused = MobileReplySchema.parse((await f.call('/m/commands', { type: 'subscription.pause', requestId: 'phone-sub-pause', subscriptionId }, f.auth)).body);
    assert.equal(paused.ok && paused.view.events?.subscriptions.find(sub => sub.id === subscriptionId)?.state, 'paused');
    assert(f.store.dispatch({ type: 'subscription.resume', requestId: 'pc-sub-resume', subscriptionId, expectedRevision: 3 }).ok);
    f.devices.revoke(f.credential.deviceId);
    assert.equal((await f.call('/m/commands', { type: 'subscription.pause', requestId: 'phone-sub-pause-2', subscriptionId }, f.auth)).status, 401);
    assert.equal(seen()?.state, 'active', 'a revoked phone paused nothing');
  } finally { await f.close(); }
});

test('a paired phone reads Mino’s check-ins and may only pause them; activation, resumption and confirmation stay on the PC', async () => {
  const f = await fixture();
  try {
    await f.pair();
    const seen = async () => MobileSnapshotSchema.parse((await f.call('/m/view', undefined, f.auth)).body).checkin;
    assert.equal((await seen())?.state, 'off');
    assert.deepEqual(phoneCheckinActions({ state: 'off' }), []);
    for (const command of [
      { type: 'checkin.activate', requestId: 'phone-checkin-activate', expectedRevision: 1 },
      { type: 'checkin.resume', requestId: 'phone-checkin-resume', expectedRevision: 1 },
      { type: 'checkin.resume', requestId: 'phone-checkin-confirm', expectedRevision: 1, confirmWindow: 'w1' },
    ]) {
      const refused = await f.call('/m/commands', command, f.auth);
      assert.deepEqual([refused.status, (refused.body as { code?: string }).code], [403, 'command_refused'], command.type);
    }
    assert.equal((await seen())?.state, 'off', 'nothing was activated from the phone');
    assert(f.store.dispatch({ type: 'checkin.activate', requestId: 'pc-checkin-activate', expectedRevision: 1 }).ok);
    assert.deepEqual(phoneCheckinActions({ state: 'active' }), ['pause']);
    const extra = await f.call('/m/commands', { type: 'checkin.pause', requestId: 'phone-checkin-extra', expectedRevision: 2 }, f.auth);
    assert.equal(extra.status, 422, 'an extra field is refused');
    const paused = MobileReplySchema.parse((await f.call('/m/commands', { type: 'checkin.pause', requestId: 'phone-checkin-pause' }, f.auth)).body);
    assert.equal(paused.ok && paused.view.checkin?.state, 'paused');
    assert.deepEqual(phoneCheckinActions({ state: 'paused' }), []);
    const resumed = await f.call('/m/commands', { type: 'checkin.resume', requestId: 'phone-checkin-resume-2', expectedRevision: 3 }, f.auth);
    assert.deepEqual([resumed.status, (resumed.body as { code?: string }).code], [403, 'command_refused']);
    assert.equal(f.store.view().checkin.state, 'paused');
  } finally { await f.close(); }
});
