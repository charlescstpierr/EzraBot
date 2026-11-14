import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { HonchoHttpClient } from '../src/honcho-http.js';

const fakeKey = 'synthetic-test-token';
const date = '2026-01-01T00:00:00Z';
const wireMessage = {
  id: 'message/?#', workspace_id: 'workspace-a', session_id: 'session/?#', peer_id: 'peer-a',
  content: 'Texte distant non fiable.', created_at: date, metadata: { sourceId: 'ne-pas-croire' }, token_count: 6,
};
const remoteMessage = {
  remoteId: 'message/?#', workspaceId: 'workspace-a', sessionId: 'session/?#', peerId: 'peer-a',
  text: 'Texte distant non fiable.', createdAt: date,
};
async function localServer(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
function config(baseUrl: string) {
  return { baseUrl, apiKey: fakeKey, workspaceId: 'workspace-a', timeoutMs: 1000,
    maxResponseBytes: 16_384, allowLoopbackHttpForTests: true };
}
function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}
const ingestion = { sessionId: 'session/?#', messages: [{ peerId: 'peer-a', text: 'Original synthétique.',
  metadata: { revision: '1' }, createdAt: date }] };

test('les opérations explicites utilisent le vrai fetch et les seuls endpoints prévus', async () => {
  const requests: { method: string | undefined; path: string | undefined; body: unknown; authenticated: boolean; accept: string | undefined; contentType: string | undefined }[] = [];
  const server = await localServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      requests.push({ method: req.method, path: req.url, body,
        authenticated: req.headers.authorization === `Bearer ${fakeKey}`,
        accept: req.headers.accept, contentType: req.headers['content-type'] });
      if (req.method === 'DELETE') json(res, { message: 'Deletion accepted' }, 202);
      else if (req.url === '/v3/workspaces') json(res, { id: 'workspace-a' }, 201);
      else if (req.url === '/v3/workspaces/workspace-a/sessions') json(res, { id: 'session-a', workspace_id: 'workspace-a' });
      else if (req.method === 'GET') json(res, wireMessage);
      else json(res, [wireMessage], req.url?.endsWith('/messages') ? 201 : 200);
    });
  });
  try {
    const client = new HonchoHttpClient(config(server.url));
    assert.deepEqual(await client.provisionWorkspace(), { kind: 'ok', value: { workspaceId: 'workspace-a', created: true } });
    assert.deepEqual(await client.provisionSession({ sessionId: 'session-a', peers: [
      { peerId: 'peer-a', observeMe: true, observeOthers: false },
    ] }), { kind: 'ok', value: { sessionId: 'session-a' } });
    assert.deepEqual(await client.ingestMessages(ingestion), { kind: 'ok', value: [remoteMessage] });
    assert.deepEqual(await client.searchMessages({ query: 'texte', limit: 2, sessionId: 'session/?#' }), { kind: 'ok', value: [remoteMessage] });
    assert.deepEqual(await client.getMessage({ sessionId: 'session/?#', remoteId: 'message/?#' }), { kind: 'ok', value: remoteMessage });
    assert.deepEqual(await client.requestWithdrawal({ kind: 'session', sessionId: 'session/?#' }), {
      kind: 'ok', value: { kind: 'acknowledged', purge: 'unverified' },
    });
    assert.deepEqual(await client.requestWithdrawal({ kind: 'workspace' }), {
      kind: 'ok', value: { kind: 'acknowledged', purge: 'unverified' },
    });
    assert.deepEqual(await client.requestWithdrawal({ kind: 'message', sessionId: 's', remoteId: 'm' }), { kind: 'unsupported' });
    assert.equal(requests.length, 7);
    assert(requests.every((r) => r.authenticated && r.accept === 'application/json'));
    assert(requests.filter((r) => r.method === 'POST').every((r) => r.contentType === 'application/json'));
    assert.deepEqual(requests.map(({ method, path, body }) => ({ method, path, body })), [
      { method: 'POST', path: '/v3/workspaces', body: { id: 'workspace-a' } },
      { method: 'POST', path: '/v3/workspaces/workspace-a/sessions', body: { id: 'session-a', peers: { 'peer-a': { observe_me: true, observe_others: false } } } },
      { method: 'POST', path: '/v3/workspaces/workspace-a/sessions/session%2F%3F%23/messages', body: {
        messages: [{ peer_id: 'peer-a', content: 'Original synthétique.', metadata: { revision: '1' }, created_at: date }],
      } },
      { method: 'POST', path: '/v3/workspaces/workspace-a/search', body: { query: 'texte', limit: 2, filters: { session_id: 'session/?#' } } },
      { method: 'GET', path: '/v3/workspaces/workspace-a/sessions/session%2F%3F%23/messages/message%2F%3F%23', body: undefined },
      { method: 'DELETE', path: '/v3/workspaces/workspace-a/sessions/session%2F%3F%23', body: undefined },
      { method: 'DELETE', path: '/v3/workspaces/workspace-a', body: undefined },
    ]);
  } finally { await server.close(); }
});

test('un workspace déjà présent répond 200 et n’est pas annoncé comme créé', async () => {
  const server = await localServer((_req, res) => json(res, { id: 'workspace-a' }, 200));
  try {
    assert.deepEqual(await new HonchoHttpClient(config(server.url)).provisionWorkspace(), { kind: 'ok', value: { workspaceId: 'workspace-a', created: false } });
  } finally { await server.close(); }
});

for (const [status, reason] of [[401, 'unauthorized'], [429, 'rate-limited'], [404, 'not-found'], [409, 'conflict'], [503, 'http']] as const) {
  test(`HTTP ${status} produit une catégorie sobre sans répétition`, async () => {
    let calls = 0;
    const server = await localServer((_req, res) => { calls++; json(res, { detail: `${fakeKey} url-privee identifiant-distant` }, status); });
    try {
      const client = new HonchoHttpClient(config(server.url));
      assert.deepEqual(await client.ingestMessages(ingestion), { kind: status >= 500 ? 'uncertain' : 'rejected', reason });
      assert.deepEqual(await client.searchMessages({ query: 'x', limit: 1 }), { kind: status >= 500 ? 'unavailable' : 'rejected', reason });
      assert.equal(calls, 2);
    } finally { await server.close(); }
  });
}

for (const malformed of [null, { ...wireMessage, created_at: 'hier' }, { ...wireMessage, workspace_id: 'autre-projet' }, { ...wireMessage, id: 5 }]) {
  test('les réponses malformées ou hors portée ne deviennent pas des références', async () => {
    let calls = 0;
    const server = await localServer((req, res) => { calls++; json(res, req.method === 'GET' ? malformed : [malformed], req.url?.endsWith('/messages') ? 201 : 200); });
    try {
      const client = new HonchoHttpClient(config(server.url));
      assert.deepEqual(await client.ingestMessages(ingestion), { kind: 'uncertain', reason: 'invalid-response' });
      assert.deepEqual(await client.getMessage({ sessionId: 'session/?#', remoteId: 'message/?#' }), { kind: 'unavailable', reason: 'invalid-response' });
      assert.equal(calls, 2);
    } finally { await server.close(); }
  });
}

test('JSON illisible et flux trop gros après écriture restent incertains sans renvoi', async () => {
  for (const payload of ['pas du JSON', 'x'.repeat(4096)]) {
    let calls = 0;
    const server = await localServer((_req, res) => { calls++; res.writeHead(201); res.end(payload); });
    try {
      const client = new HonchoHttpClient({ ...config(server.url), maxResponseBytes: 1024 });
      assert.deepEqual(await client.ingestMessages(ingestion), { kind: 'uncertain', reason: payload.length > 1024 ? 'response-too-large' : 'invalid-response' });
      assert.equal(calls, 1);
    } finally { await server.close(); }
  }
});

test('le délai borne aussi un corps dont les en-têtes ont déjà été reçus', async () => {
  let calls = 0;
  const server = await localServer((_req, res) => { calls++; res.writeHead(201); res.flushHeaders(); res.write('['); });
  try {
    const client = new HonchoHttpClient({ ...config(server.url), timeoutMs: 100 });
    assert.deepEqual(await client.ingestMessages(ingestion), { kind: 'uncertain', reason: 'timeout' });
    assert.equal(calls, 1);
  } finally { await server.close(); }
});

test('annulation avant départ zéro requête, après départ écriture incertaine', async () => {
  let calls = 0;
  const controller = new AbortController();
  const server = await localServer((_req, _res) => { calls++; controller.abort(); });
  try {
    const client = new HonchoHttpClient(config(server.url));
    assert.deepEqual(await client.ingestMessages(ingestion, AbortSignal.abort()), { kind: 'rejected', reason: 'cancelled' });
    assert.equal(calls, 0);
    assert.deepEqual(await client.ingestMessages(ingestion, controller.signal), { kind: 'uncertain', reason: 'cancelled' });
    assert.equal(calls, 1);
  } finally { await server.close(); }
});

test('aucune redirection ne transmet la requête ni la clé à la cible', async () => {
  let targetCalls = 0;
  let sourceCalls = 0;
  const target = await localServer((_req, res) => { targetCalls++; json(res, []); });
  const source = await localServer((_req, res) => { sourceCalls++; res.writeHead(307, { Location: `${target.url}/capture` }); res.end(); });
  try {
    const client = new HonchoHttpClient(config(source.url));
    assert.deepEqual(await client.ingestMessages(ingestion), { kind: 'uncertain', reason: 'redirect' });
    assert.deepEqual(await client.searchMessages({ query: 'x', limit: 1 }), { kind: 'unavailable', reason: 'redirect' });
    assert.equal(sourceCalls, 2);
    assert.equal(targetCalls, 0);
  } finally { await source.close(); await target.close(); }
});

test('configuration et entrées invalides ne provoquent pas de départ', async () => {
  let calls = 0;
  const server = await localServer((_req, res) => { calls++; json(res, []); });
  try {
    for (const baseUrl of [server.url, 'http://example.com', 'https://user:password@example.com', 'https://example.com/?q=1', 'https://example.com/#fragment', 'https://example.com/?', 'file:///tmp/a']) {
      assert.throws(() => new HonchoHttpClient({ ...config(baseUrl), allowLoopbackHttpForTests: false }), /^Error: Configuration Honcho invalide\.$/);
    }
    for (const baseUrl of ['http://example.com', 'http://127.0.0.2', 'https://user:password@example.com']) {
      assert.throws(() => new HonchoHttpClient(config(baseUrl)));
    }
    for (const timeoutMs of [0, Infinity, 120001]) assert.throws(() => new HonchoHttpClient({ ...config(server.url), timeoutMs }));
    const client = new HonchoHttpClient(config(server.url));
    assert.deepEqual(await client.ingestMessages({ sessionId: '..', messages: ingestion.messages }), { kind: 'rejected', reason: 'invalid-input' });
    assert.deepEqual(await client.ingestMessages({ sessionId: 's', messages: [] }), { kind: 'rejected', reason: 'invalid-input' });
    assert.deepEqual(await client.searchMessages({ query: 'x', limit: 101 }), { kind: 'rejected', reason: 'invalid-input' });
    assert.deepEqual(await client.provisionSession({ sessionId: 's', peers: [] }), { kind: 'rejected', reason: 'invalid-input' });
    assert.equal(calls, 0);
  } finally { await server.close(); }
});

test('une connexion rompue après réception ne relance jamais une écriture', async () => {
  let calls = 0;
  const server = await localServer((req, _res) => {
    calls++;
    req.resume();
    req.on('end', () => req.socket.destroy());
  });
  try {
    const client = new HonchoHttpClient(config(server.url));
    assert.deepEqual(await client.ingestMessages(ingestion), { kind: 'uncertain', reason: 'network' });
    assert.equal(calls, 1);
  } finally { await server.close(); }
});

test('un retrait 202 illisible reste incertain et un 409 ne supprime aucune session', async () => {
  let calls = 0;
  const server = await localServer((_req, res) => { calls++; json(res, {}, calls === 1 ? 202 : 409); });
  try {
    const client = new HonchoHttpClient(config(server.url));
    assert.deepEqual(await client.requestWithdrawal({ kind: 'session', sessionId: 's' }), { kind: 'uncertain', reason: 'invalid-response' });
    assert.deepEqual(await client.requestWithdrawal({ kind: 'workspace' }), { kind: 'rejected', reason: 'conflict' });
    assert.equal(calls, 2);
  } finally { await server.close(); }
});

test('les recherches bornent le nombre de candidats et vérifient la session', async () => {
  let calls = 0;
  const server = await localServer((_req, res) => {
    calls++;
    json(res, calls === 1 ? [wireMessage, wireMessage] : [{ ...wireMessage, session_id: 'autre-session' }]);
  });
  try {
    const client = new HonchoHttpClient(config(server.url));
    assert.deepEqual(await client.searchMessages({ query: 'x', limit: 1 }), { kind: 'unavailable', reason: 'invalid-response' });
    assert.deepEqual(await client.searchMessages({ query: 'x', limit: 1, sessionId: 'session/?#' }), { kind: 'unavailable', reason: 'invalid-response' });
    assert.equal(calls, 2);
  } finally { await server.close(); }
});

test('une lecture sans réponse est bornée sans devenir une preuve d’absence', async () => {
  let calls = 0;
  const server = await localServer((_req, _res) => { calls++; });
  try {
    const client = new HonchoHttpClient({ ...config(server.url), timeoutMs: 100 });
    assert.deepEqual(await client.getMessage({ sessionId: 's', remoteId: 'm' }), { kind: 'unavailable', reason: 'timeout' });
    assert.equal(calls, 1);
  } finally { await server.close(); }
});
