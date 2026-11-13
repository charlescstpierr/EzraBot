import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
import { MobileSnapshotSchema, MobileReplySchema, PairStatusSchema } from '../src/mobile-protocol.js';
import { openStore } from '../src/store.js';
import { createWorker } from '../src/worker.js';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
async function port(): Promise<number> {
  const probe = createServer(); await new Promise<void>(r => probe.listen(0, '127.0.0.1', r)); const address = probe.address();
  await new Promise<void>(r => probe.close(() => r())); if (!address || typeof address === 'string') throw new Error('Missing port'); return address.port;
}
const closeServer = async (server: Server) => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); };
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mino-device-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
  const cert = readFileSync(join(dir, 'cert.pem'), 'utf8'); const key = readFileSync(join(dir, 'key.pem'), 'utf8');
  const store = openStore({ path: join(dir, 'app.sqlite'), mascots: loadMascots(join(root, 'assets/mascots.json')) });
  const engine: Engine = {
    status: () => ({ state: 'ready', account: 'chatgpt', models: [{ id: 'test', displayName: 'Test', isDefault: true, efforts: ['low'], defaultEffort: 'low', speeds: [] }] }),
    catalog: async () => engine.status(), close: async () => {}, onUsage: () => () => {},
    run: async input => { const id = randomUUID(); input.onThread('thread_' + id); input.onTurn('turn_' + id); return { kind: 'succeeded', reply: { reply: 'Réponse de contrôle', deliverable: { title: 'Plan Boréal', body: 'Budget 8 000 €' } }, used: { model: 'test', effort: 'low', speed: 'standard' }, threadId: 'thread_' + id, turnId: 'turn_' + id }; },
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

test('a paired device cannot grant, approve, refuse or retry a service action, and its snapshot carries no tools field', async () => {
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
    for (const path of ['/m/tools/commands', '/m/tools/catalog', '/api/tools/catalog']) assert.equal((await f.call(path, undefined, f.auth)).status, 404, path);
    assert.equal((await f.call('/m/tools/commands', { type: 'tools.refuse', requestId: 'mobile-tools-6', proposalId: 'tp_1' }, f.auth)).status, 404);
    const snapshot = z.record(z.string(), z.unknown()).parse((await f.call('/m/view', undefined, f.auth)).body);
    assert.equal('tools' in snapshot, false);
    MobileSnapshotSchema.parse(snapshot);
  } finally { await f.close(); }
});

test('paired commands accept image-only batches above the old ceiling and protect their bytes', async () => {
  const f = await fixture();
  try {
    await f.pair();
    const bytes = Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMioAAAAASUVORK5CYII=', 'base64'), Buffer.alloc(300 * 1024)]);
    const file = {kind:'image',name:'test.png',mimeType:'image/png',base64:bytes.toString('base64'),relativePath:'dossier/test.png'};
    const command = {type:'message.send',requestId:randomUUID(),botId:'mino',text:'',attachments:[file]};
    const accepted = await f.call('/m/commands', command, f.auth); assert.equal(accepted.status,200);
    const view = MobileSnapshotSchema.parse((await f.call('/m/view', undefined, f.auth)).body);
    const id = view.messages.find(message=>message.role==='user')?.attachments[0]?.id; assert(id);
    assert(!JSON.stringify(view).includes(file.base64));
    assert.equal((await f.call(`/m/attachments/${id}`)).status,401);
    const image = await new Promise<Buffer>((resolve,reject)=>{
      const req=request(f.url+`/m/attachments/${id}`, {ca:f.cert,servername:'localhost',headers:f.auth},res=>{
        assert.equal(res.statusCode,200);assert.equal(res.headers['content-type'],'image/png');
        const parts:Buffer[]=[];res.on('data',chunk=>parts.push(Buffer.from(chunk)));res.on('end',()=>resolve(Buffer.concat(parts)));
      });req.on('error',reject);req.end();
    });
    assert.deepEqual(image,bytes);
    assert.equal((await f.call('/m/commands',{...command,requestId:randomUUID(),attachments:[{...file,relativePath:'../interdit.png'}]},f.auth)).status,422);
  } finally {await f.close();}
});
