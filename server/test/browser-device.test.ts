import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createBrowserStatic } from '../src/browser-static.js';
import { createDeviceServer } from '../src/device-http.js';
import { openDevices } from '../src/devices.js';
import { loadMascots } from '../src/domain.js';
import type { Engine } from '../src/engine.js';
import { createHttpServer } from '../src/http.js';
import { MobileSnapshotSchema, PairStatusSchema } from '../src/mobile-protocol.js';
import { openStore } from '../src/store.js';
import { createBrowserAdmission } from '../src/web-admission.js';
import { createWorker } from '../src/worker.js';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const sessionSchema = z.strictObject({ state: z.enum(['pending', 'active']), session: z.strictObject({ kind: z.literal('cookie'), url: z.url(), spaceId: z.string(), deviceId: z.uuid() }), confirmCode: z.string().regex(/^\d{6}$/), expiresAt: z.string() });
async function freePort() {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  await new Promise<void>(done => server.close(() => done()));
  if (!address || typeof address === 'string') throw new Error('Missing port');
  return address.port;
}
async function closeServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
}
type Reply = { status: number; text: string; headers: IncomingHttpHeaders; body: unknown };
function cookieFrom(reply: Reply): string {
  const cookie = reply.headers['set-cookie']?.[0]?.split(';')[0];
  assert.ok(cookie);
  return cookie;
}
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mino-browser-'));
  const staticDir = join(dir, 'client');
  mkdirSync(join(staticDir, '_expo/static/js/web'), { recursive: true });
  mkdirSync(join(staticDir, '_expo/static/js/ios'), { recursive: true });
  mkdirSync(join(staticDir, 'assets/icons'), { recursive: true });
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><style>body{margin:0}</style><div id="root"></div><script src="/_expo/static/js/web/index-test.js" defer></script>');
  writeFileSync(join(staticDir, '_expo/static/js/web/index-test.js'), 'document.title="Mino";');
  writeFileSync(join(staticDir, '_expo/static/js/ios/index-test.hbc'), 'native-private');
  writeFileSync(join(staticDir, '_expo/static/js/web/index-test.js.map'), 'source-private');
  writeFileSync(join(staticDir, 'metadata.json'), 'metadata-private');
  writeFileSync(join(staticDir, 'favicon.ico'), 'icon');
  writeFileSync(join(staticDir, 'assets/icons/mino.png'), 'png');
  writeFileSync(join(staticDir, 'assets/metadata.json'), 'asset-private');
  writeFileSync(join(staticDir, 'device-admin.js'), 'admin-private');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
  const cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
  const key = readFileSync(join(dir, 'key.pem'), 'utf8');
  const devicePort = await freePort();
  let localPort = await freePort();
  while (localPort === devicePort) localPort = await freePort();
  const url = `https://127.0.0.1:${devicePort}`;
  const localUrl = `http://127.0.0.1:${localPort}`;
  let now = Date.now();
  const store = openStore({ path: join(dir, 'app.sqlite'), mascots: loadMascots(join(root, 'assets/mascots.json')) });
  const engine: Engine = {
    status: () => ({ state: 'unavailable', message: 'Test sans modèle' }), catalog: async () => engine.status(),
    close: async () => {}, onUsage: () => () => {}, run: async () => { throw new Error('No model calls in browser access tests'); },
  };
  const worker = createWorker({ store, engines: { chat: engine, doc: engine } });
  const devicePath = join(dir, 'devices.sqlite');
  let devices = openDevices({ path: devicePath, spaceId: store.view().spaceId, publicUrl: url, now: () => now });
  let admission = createBrowserAdmission(devices, () => now);
  const servers = () => ({
    server: createDeviceServer({ store, engine, worker, devices, publicUrl: url, cert, key, browserClientDir: staticDir, browserAdmission: admission, longPollMs: 1000, allowedOrigins: ['https://allowed.invalid'] }),
    local: createHttpServer({ store, engine, worker, devices, port: localPort, root, csrfToken: 'browser-csrf', browserAdmission: admission }),
  });
  let { server, local } = servers();
  async function listen() {
    await Promise.all([new Promise<void>(done => server.listen(devicePort, '127.0.0.1', done)), new Promise<void>(done => local.listen(localPort, '127.0.0.1', done))]);
  }
  await listen();
  function call(path: string, body?: unknown, headers: Record<string, string | string[]> = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: devicePort, path, ca: cert, servername: 'localhost', method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, timeout: 3000 }, res => {
        let text = '';
        res.on('data', chunk => { text += String(chunk); });
        res.on('end', () => { let data: unknown = text; try { data = JSON.parse(text); } catch {} resolve({ status: res.statusCode ?? 0, text, body: data, headers: res.headers }); });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('Browser request timed out')));
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  }
  const web = (cookie?: string) => ({ 'x-mino-web': '1', 'sec-fetch-site': 'same-origin', origin: url, ...(cookie ? { cookie } : {}) });
  async function admin(path: string, body: unknown = {}, extra: Record<string, string> = {}) {
    return fetch(localUrl + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: localUrl, 'x-mino-csrf': 'browser-csrf', ...extra }, body: JSON.stringify(body) });
  }
  async function claim() {
    assert.equal((await admin('/api/devices/browser-window')).status, 200);
    const reply = await call('/m/browser/claim', { deviceName: '  Safari de test  ' }, web());
    assert.equal(reply.status, 200);
    return { reply, cookie: cookieFrom(reply), session: sessionSchema.parse(reply.body) };
  }
  function approve(deviceId: string) {
    const device = devices.list().find(device => device.id === deviceId);
    assert.ok(device);
    devices.approve(device.pairingId, device.id, device.confirmCode);
  }
  return { dir, staticDir, call, web, admin, claim, approve, url, localUrl, store, engine,
    get devices() { return devices; }, get admission() { return admission; },
    advance(ms: number) { now += ms; },
    async restart() {
      await Promise.all([closeServer(server), closeServer(local)]);
      devices.close();
      devices = openDevices({ path: devicePath, spaceId: store.view().spaceId, publicUrl: url, now: () => now });
      admission = createBrowserAdmission(devices, () => now);
      ({ server, local } = servers());
      await listen();
    },
    async close() { await Promise.all([closeServer(server), closeServer(local)]); await worker.close(); store.close(); devices.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('Safari admission is PC gated, single use, cookie only and retryable before and after approval', async () => {
  const f = await fixture();
  try {
    assert.deepEqual((await f.call('/m/browser/session', undefined, f.web())).body, { state: 'unpaired' });
    assert.equal((await f.call('/m/browser/claim', { deviceName: 'Safari' }, f.web())).status, 403);
    assert.equal((await f.admin('/api/devices/browser-window', {}, { origin: 'https://foreign.invalid' })).status, 403);
    assert.equal((await f.admin('/api/devices/browser-window', {}, { 'x-mino-csrf': 'wrong' })).status, 403);
    const opened = await f.admin('/api/devices/browser-window');
    assert.equal(opened.status, 200);
    for (const deviceName of ['', '   ', 'x'.repeat(51)]) assert.equal((await f.call('/m/browser/claim', { deviceName }, f.web())).status, 422);
    assert.notEqual(f.admission.expiresAt(), null);
    const { reply, cookie, session } = await f.claim();
    assert.equal(session.state, 'pending');
    assert.equal(f.devices.list()[0]?.name, 'Safari de test');
    const set = reply.headers['set-cookie']?.[0] ?? '';
    for (const flag of ['__Host-mino-device=', 'Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=']) assert.ok(set.includes(flag));
    assert.ok(!set.includes('Domain='));
    const initialAge = Number(/Max-Age=(\d+)/.exec(set)?.[1]);
    assert.ok(initialAge >= 29 * 86_400 && initialAge <= 30 * 86_400);
    const token = cookie.slice(cookie.indexOf('=') + 1);
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.equal(reply.text.includes(token), false);
    assert.equal(reply.text.includes('pairingId'), false);
    assert.equal((await f.call('/m/browser/claim', { deviceName: 'Other Safari' }, f.web())).status, 403);
    const retry = await f.call('/m/browser/claim', { deviceName: 'Safari' }, f.web(cookie));
    assert.deepEqual(retry.body, reply.body);
    assert.equal(f.devices.list().length, 1);
    for (const path of ['/m/view', '/m/catalog']) {
      const pending = await f.call(path, undefined, f.web(cookie));
      assert.equal(pending.status, 403);
      assert.ok(!pending.text.includes('spaceId'));
    }
    const invalidApproval = await f.admin('/api/devices/approve', { pairingId: f.devices.list()[0]?.pairingId, deviceId: session.session.deviceId, confirmCode: session.confirmCode === '000000' ? '000001' : '000000' });
    assert.equal(invalidApproval.status, 409);
    const listed = f.devices.list()[0]; assert.ok(listed);
    assert.equal((await f.admin('/api/devices/approve', { pairingId: listed.pairingId, deviceId: listed.id, confirmCode: listed.confirmCode })).status, 200);
    const status = await f.call('/m/pair/status', undefined, f.web(cookie));
    assert.equal(PairStatusSchema.parse(status.body).state, 'active');
    assert.ok(Number(/Max-Age=(\d+)/.exec(status.headers['set-cookie']?.[0] ?? '')?.[1]) > 29 * 24 * 60 * 60);
    assert.equal(MobileSnapshotSchema.parse((await f.call('/m/view', undefined, f.web(cookie))).body).spaceId, f.store.view().spaceId);
    assert.equal(sessionSchema.parse((await f.call('/m/browser/session', undefined, f.web(cookie))).body).state, 'active');
    const bytes = readFileSync(join(f.dir, 'devices.sqlite'));
    assert.equal(bytes.includes(Buffer.from(token)), false);
    assert.equal((await f.call('/m/commands', { type: 'storage.purge', requestId: 'browser-purge-1' }, f.web(cookie))).status, 403);
    assert.equal((await f.call('/m/commands', { type: 'bot.select', requestId: 'browser-select-1', botId: 'mino' }, f.web(cookie))).status, 403);
  } finally { await f.close(); }
});

test('Safari sessions survive reload and DB reopen, while restart closes the admission window', async () => {
  const f = await fixture();
  try {
    const { cookie, session } = await f.claim();
    f.approve(session.session.deviceId);
    const active = await f.call('/m/browser/session', undefined, f.web(cookie));
    assert.equal(sessionSchema.parse(active.body).state, 'active');
    await f.admin('/api/devices/browser-window');
    await f.restart();
    assert.equal(sessionSchema.parse((await f.call('/m/browser/session', undefined, f.web(cookie))).body).state, 'active');
    assert.equal((await f.call('/m/browser/claim', { deviceName: 'New Safari' }, f.web())).status, 403);
    const snapshot = MobileSnapshotSchema.parse((await f.call('/m/view', undefined, f.web(cookie))).body);
    const poll = f.call(`/m/view?after=${snapshot.rev}`, undefined, f.web(cookie));
    await new Promise(done => setTimeout(done, 40));
    f.devices.revoke(session.session.deviceId);
    assert.equal((await poll).status, 401);
    const revoked = await f.call('/m/browser/session', undefined, f.web(cookie));
    assert.deepEqual(revoked.body, { state: 'unpaired' });
    assert.ok((revoked.headers['set-cookie']?.[0] ?? '').includes('Max-Age=0'));
    await f.restart();
    assert.deepEqual((await f.call('/m/browser/session', undefined, f.web(cookie))).body, { state: 'unpaired' });
  } finally { await f.close(); }
});

test('Safari window expiry, stale cookies and logout do not require a fresh grant', async () => {
  const f = await fixture();
  try {
    await f.admin('/api/devices/browser-window'); f.advance(120_001);
    assert.equal((await f.call('/m/browser/claim', { deviceName: 'Late' }, f.web())).status, 403);
    const first = await f.claim();
    f.advance(300_001);
    const expired = await f.call('/m/browser/session', undefined, f.web(first.cookie));
    assert.deepEqual(expired.body, { state: 'unpaired' });
    assert.ok((expired.headers['set-cookie']?.[0] ?? '').includes('Max-Age=0'));
    const invalid = await f.call('/m/browser/session', undefined, f.web('__Host-mino-device=bad'));
    assert.deepEqual(invalid.body, { state: 'unpaired' });
    assert.ok((invalid.headers['set-cookie']?.[0] ?? '').includes('Max-Age=0'));
    const second = await f.claim(); f.approve(second.session.session.deviceId);
    const logout = await f.call('/m/browser/logout', {}, f.web(second.cookie));
    assert.equal(logout.status, 200); assert.ok((logout.headers['set-cookie']?.[0] ?? '').includes('Max-Age=0'));
    assert.equal((await f.call('/m/view', undefined, f.web(second.cookie))).status, 401);
    await f.admin('/api/devices/browser-window');
    const retry = await f.call('/m/browser/claim', { deviceName: 'Nouvel accès' }, f.web(second.cookie));
    assert.equal(retry.status, 200);
    assert.notEqual(sessionSchema.parse(retry.body).session.deviceId, second.session.session.deviceId);
    assert.equal((await f.call('/m/browser/logout', {}, f.web(second.cookie))).status, 200);
    assert.equal((await f.call('/m/browser/logout', {}, f.web())).status, 200);
    assert.equal(f.devices.list().find(device => device.id === second.session.session.deviceId)?.state, 'revoked');
  } finally { await f.close(); }
});

test('Safari APIs reject cross site requests, absent headers, duplicate credentials and wrong Host', async () => {
  const f = await fixture();
  try {
    const { cookie, session } = await f.claim(); f.approve(session.session.deviceId);
    const auth = f.web(cookie);
    for (const origin of ['', 'null', 'https://foreign.invalid', 'https://allowed.invalid']) {
      assert.equal((await f.call('/m/browser/logout', {}, { ...auth, origin })).status, 403);
      assert.equal((await f.call('/m/commands', {}, { ...auth, origin })).status, 403);
    }
    const { origin: _origin, ...noOrigin } = auth;
    assert.equal((await f.call('/m/browser/claim', { deviceName: 'Safari' }, noOrigin)).status, 403);
    assert.equal((await f.call('/m/browser/logout', {}, noOrigin)).status, 403);
    for (const site of ['cross-site', 'same-site', 'none']) assert.equal((await f.call('/m/view', undefined, { ...auth, 'sec-fetch-site': site })).status, 403);
    const { 'x-mino-web': _header, ...noHeader } = auth;
    assert.equal((await f.call('/m/view', undefined, noHeader)).status, 403);
    assert.equal((await f.call('/m/browser/session', undefined, noHeader)).status, 403);
    assert.equal((await f.call('/m/view', undefined, { ...auth, authorization: `Bearer ${randomBytes(32).toString('hex')}` })).status, 400);
    assert.equal((await f.call('/m/view', undefined, { ...auth, cookie: `${cookie}; ${cookie}` })).status, 400);
    assert.equal((await f.call('/m/view', undefined, { ...auth, cookie: [cookie, cookie] })).status, 400);
    assert.equal((await f.call('/m/view', undefined, { authorization: ['Bearer invalid', 'Bearer duplicate'], 'x-mino-space': f.store.view().spaceId })).status, 400);
    assert.equal((await f.call('/m/view', undefined, { ...auth, host: 'foreign.invalid' })).status, 421);
    assert.equal((await f.call('/m/view', undefined, auth)).headers['access-control-allow-origin'], undefined);
    assert.equal((await fetch(f.localUrl + '/m/browser/session')).status, 404);
  } finally { await f.close(); }
});

test('the public Safari shell exposes only the web export and rejects traversal and symlinks', async () => {
  const f = await fixture();
  try {
    for (const path of ['/', '/index.html', '/favicon.ico', '/_expo/static/js/web/index-test.js', '/assets/icons/mino.png']) {
      const result = await f.call(path);
      assert.equal(result.status, 200, path);
      assert.equal(result.headers['set-cookie'], undefined);
      assert.ok(result.headers['content-security-policy']?.includes("script-src 'self'"));
      assert.ok(result.headers['content-security-policy']?.includes("frame-ancestors 'none'"));
      assert.ok(!result.text.includes(f.store.view().spaceId));
    }
    symlinkSync(join(f.dir, 'devices.sqlite'), join(f.staticDir, 'assets/leak.png'));
    symlinkSync(join(f.staticDir, 'assets/icons'), join(f.staticDir, 'assets/linked'));
    for (const path of ['/metadata.json', '/_expo/static/js/ios/index-test.hbc', '/_expo/static/js/web/index-test.js.map', '/device-admin.js', '/api/devices', '/api/view', '/devices', '/assets/metadata.json', '/devices.sqlite', '/assets/leak.png', '/assets/linked/mino.png', '/assets/../../devices.sqlite', '/assets/%2e%2e/%2e%2e/devices.sqlite', '/assets%2fleak.png', '/assets\\leak.png', '//index.html']) assert.equal((await f.call(path)).status, 404, path);
    const alias = join(f.dir, 'client-link'); symlinkSync(f.staticDir, alias);
    assert.throws(() => createBrowserStatic(alias));
  } finally { await f.close(); }
});

test('browser grants preserve pending native pairings and native bearer access', async () => {
  const f = await fixture();
  try {
    const native = f.devices.createGrant();
    const credential = { pairingId: native.pairingId, secret: native.secret, deviceId: randomUUID(), deviceName: 'Native', deviceToken: randomBytes(32).toString('hex') };
    const pending = f.devices.claim(credential);
    for (let i = 0; i < 4; i++) await f.claim();
    for (let i = 0; i < 4; i++) { f.advance(1); f.devices.createGrant(); }
    f.devices.approve(native.pairingId, credential.deviceId, pending.confirmCode);
    assert.equal((await f.call('/m/view', undefined, { authorization: `Bearer ${credential.deviceToken}`, 'x-mino-space': f.store.view().spaceId })).status, 200);
    assert.equal(readFileSync(join(f.dir, 'devices.sqlite')).includes(Buffer.from(native.secret)), false);
    assert.equal(readFileSync(join(f.dir, 'devices.sqlite')).includes(Buffer.from(credential.deviceToken)), false);
  } finally { await f.close(); }
});

test('later native grants cannot invalidate a Safari device waiting for PC confirmation', async () => {
  const f = await fixture();
  try {
    const { session } = await f.claim();
    for (let i = 0; i < 4; i++) { f.advance(1); f.devices.createGrant(); }
    assert.doesNotThrow(() => f.approve(session.session.deviceId));
  } finally { await f.close(); }
});

test('approval survives a sleeping browser while unapproved admission still expires after five minutes', async () => {
  const f = await fixture();
  try {
    const first = await f.claim();
    const age = Number(/Max-Age=(\d+)/.exec(first.reply.headers['set-cookie']?.[0] ?? '')?.[1]);
    assert.ok(age > 3600, 'cookie must survive a phone sleeping longer than five minutes');
    f.advance(4 * 60_000);
    f.approve(first.session.session.deviceId);
    f.advance(6 * 60_000);
    const resumed = await f.call('/m/browser/session', undefined, f.web(first.cookie));
    assert.equal(sessionSchema.parse(resumed.body).state, 'active');
    const expiresAt = sessionSchema.parse(resumed.body).expiresAt;
    f.advance(60_000);
    assert.equal(sessionSchema.parse((await f.call('/m/browser/session', undefined, f.web(first.cookie))).body).expiresAt, expiresAt);
    const second = await f.claim();
    f.advance(5 * 60_000 + 1);
    assert.deepEqual((await f.call('/m/browser/session', undefined, f.web(second.cookie))).body, { state: 'unpaired' });
    assert.equal((await f.call('/m/view', undefined, f.web(second.cookie))).status, 401);
  } finally { await f.close(); }
});

test('paired creation refuses an unavailable explicit model without creating a bot', async () => {
  const f = await fixture();
  try {
    const { cookie, session } = await f.claim();
    f.approve(session.session.deviceId);
    const command = { type: 'bot.create', requestId: 'device-create-model', name: 'Mobile modèle', title: '', shape: 'sprout', color: '#8de343' };
    const count = f.store.view().bots.length;
    const refused = await f.call('/m/commands', { ...command, model: 'fake-sol' }, f.web(cookie));
    assert.equal(refused.status, 409);
    assert.equal(f.store.view().bots.length, count);
    assert.equal((await f.call('/m/commands', command, f.web(cookie))).status, 200);
    assert.equal(f.store.view().bots.length, count + 1);
    assert.deepEqual(f.store.view().bots.find(b => b.name === command.name)?.choice, { model: null, effort: null, speed: 'standard' });
  } finally { await f.close(); }
});

test('paired creation checks a level and a speed against the catalogue even without a model, and replays with the catalogue gone', async () => {
  const f = await fixture();
  try {
    const { cookie, session } = await f.claim();
    f.approve(session.session.deviceId);
    const offline = f.engine.catalog;
    f.engine.catalog = async () => ({ state: 'ready', account: 'chatgpt', models: [{ id: 'fake', displayName: 'Fake', isDefault: true, efforts: ['low', 'max'], defaultEffort: 'low', speeds: [{ id: 'priority', name: 'Fast', description: '' }] }] });
    const command = { type: 'bot.create', requestId: 'device-create-choice', name: 'Mobile réglé', title: '', shape: 'sprout', color: '#8de343' };
    const count = f.store.view().bots.length;
    for (const choice of [{ effort: 'ultra' }, { speed: 'turbo' }, { model: 'fake', effort: 'high' }]) {
      const refused = await f.call('/m/commands', { ...command, ...choice }, f.web(cookie));
      assert.equal(refused.status, 422, JSON.stringify(choice));
    }
    assert.equal(f.store.view().bots.length, count);
    const chosen = { ...command, effort: 'max', speed: 'priority' };
    assert.equal((await f.call('/m/commands', chosen, f.web(cookie))).status, 200);
    assert.deepEqual(f.store.view().bots.find(b => b.name === command.name)?.choice, { model: null, effort: 'max', speed: 'priority' });
    f.engine.catalog = offline;
    const replay = await f.call('/m/commands', chosen, f.web(cookie));
    assert.equal(replay.status, 200);
    assert.equal(z.object({ replayed: z.boolean() }).parse(replay.body).replayed, true);
    assert.equal((await f.call('/m/commands', { ...chosen, effort: 'low' }, f.web(cookie))).status, 409);
    assert.equal(f.store.view().bots.length, count + 1);
  } finally { await f.close(); }
});
