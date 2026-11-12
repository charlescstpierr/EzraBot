import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserAccess } from '../src/browser';
import { scope } from '../src/controller';

const session = { kind: 'cookie' as const, url: 'https://pc.example:4319', spaceId: 'space', deviceId: '9d6ec9ba-f35f-4b3b-b9f1-a0ae9e517004' };
function cache() {
  const values = new Map<string, string>();
  return { values, read: async (key: string) => values.get(key) ?? null,
    write: async (key: string, value: string) => { values.set(key, value); },
    remove: async (key: string) => { values.delete(key); } };
}
function response(state = 'active') {
  return new Response(JSON.stringify({ state, session, confirmCode: '271828', expiresAt: '2027-01-01T00:00:00Z' }));
}
test('browser bootstrap stores only public identity and retains scoped drafts while offline', async () => {
  const c = cache();
  const access = createBrowserAccess(c, session.url, async (_url, init) => {
    assert.equal(init?.credentials, 'same-origin');
    assert.equal(new Headers(init?.headers).get('X-Mino-Web'), '1');
    return response();
  });
  const raw = await access.readSecret();
  assert.deepEqual(JSON.parse(raw ?? '{}'), { session, claim: null });
  assert.ok(![...c.values.values()].some((v) => v.includes('token')));
  await c.write(scope(session), 'brouillon conservé');
  const offline = createBrowserAccess(c, session.url, async () => { throw Error('offline'); });
  assert.equal(await offline.readSecret(), raw);
  assert.equal(await c.read(scope(session)), 'brouillon conservé');
});
test('confirmed revocation erases public identity and the scoped cache before boot', async () => {
  const c = cache();
  const first = createBrowserAccess(c, session.url, async () => response());
  await first.readSecret(); await c.write(scope(session), 'ancien historique');
  const revoked = createBrowserAccess(c, session.url, async () => new Response(JSON.stringify({ state: 'unpaired' })));
  assert.equal(await revoked.readSecret(), null);
  assert.equal(c.values.size, 0);
});
test('foreign session metadata and native tokens cannot be saved as a browser credential', async () => {
  const c = cache();
  const access = createBrowserAccess(c, 'https://another.example', async () => response());
  await assert.rejects(() => access.readSecret(), /autre ordinateur/);
  await assert.rejects(() => access.writeSecret(JSON.stringify({ session: { ...session, token: 'a'.repeat(64) }, claim: null })));
  assert.equal(c.values.size, 0);
});
test('browser claim uses a JSON request and a refused admission stays visible', async () => {
  const c = cache();
  const access = createBrowserAccess(c, session.url, async (url, init) => {
    assert.equal(url, '/m/browser/claim');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { deviceName: 'Mon iPhone' });
    return new Response(JSON.stringify({ code: 'browser_window_closed', message: 'Autorise Safari sur le PC.' }), { status: 403 });
  });
  await assert.rejects(() => access.claim('Mon iPhone'), /Autorise Safari/);
  assert.equal(c.values.size, 0);
});
test('a failed browser logout does not silently erase the local identity', async () => {
  const c = cache(); let offline = false;
  const access = createBrowserAccess(c, session.url, async (url) => {
    if (url === '/m/browser/logout' && offline) throw Error('offline');
    return response();
  });
  const before = await access.readSecret(); offline = true;
  await assert.rejects(() => access.forget(), /offline/);
  assert.ok([...c.values.values()].includes(before ?? ''));
});
