import { createServer } from 'node:http';
import { request } from 'node:https';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeviceServer } from '../dist/src/device-http.js';
import { openDevices } from '../dist/src/devices.js';
import { loadMascots } from '../dist/src/domain.js';
import { createHttpServer } from '../dist/src/http.js';
import { openStore } from '../dist/src/store.js';
import { createWorker } from '../dist/src/worker.js';
import { DOCUMENT_SCHEMA, OPINION_SCHEMA } from '../dist/src/context.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), 'mino-native-ui-'));
const bridgePort = Number(process.env.MINO_UI_BRIDGE_PORT ?? 4401);
const localPort = Number(process.env.MINO_UI_LOCAL_PORT ?? 4402);
const tlsPort = Number(process.env.MINO_UI_TLS_PORT ?? 4403);
const base = `https://127.0.0.1:${tlsPort}`;
const bridgeBase = `http://127.0.0.1:${bridgePort}`;
const origins = new Set((process.env.MINO_UI_ORIGINS ?? 'http://localhost:8081,http://127.0.0.1:8081').split(','));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
const cert = readFileSync(join(dir, 'cert.pem'), 'utf8'); const key = readFileSync(join(dir, 'key.pem'), 'utf8');
const store = openStore({ path: join(dir, 'app.sqlite'), mascots: loadMascots(join(root, 'assets/mascots.json')) });
const devices = openDevices({ path: join(dir, 'devices.sqlite'), spaceId: store.view().spaceId, publicUrl: base });
let finish; let held = new Promise(r => { finish = r; }); let failNext = false;
const body = '# Lancement du café Boréal\n\n## Planning\nS1 · Identité et fournisseurs\nS2 · Essais du menu\nS3 · Communication et préouverture\nS4 · Ouverture\n\n## Budget\nÉquipement : 6 000 €\nStock : 1 200 €\nCommunication : 300 €\nRéserve : 500 €\nTotal : 8 000 €\n\n## Communication\nPrésenter le lieu et l’équipe. Préparer trois publications et inviter les voisins à la préouverture.\n\nDonnées fictives de vérification.';
function engine() {
  const status = { state: 'ready', account: 'chatgpt', models: [{ id: 'controlled-fixture', displayName: 'Moteur de vérification', isDefault: true, efforts: ['low', 'medium'], defaultEffort: 'low', speeds: [] }] };
  return { status: () => status, catalog: async () => status, close: async () => {}, onUsage: () => () => {},
    run: async input => {
      const ids = { threadId: randomUUID(), turnId: randomUUID() }; input.onThread(ids.threadId); input.onTurn(ids.turnId); input.onStage('writing');
      if (failNext) { failNext = false; return { kind: 'failed', code: 'turn_failed', message: 'Échec contrôlé de vérification' }; }
      const document = input.turn.outputSchema === DOCUMENT_SCHEMA; const review = input.turn.outputSchema === OPINION_SCHEMA;
      const reply = { reply: document ? 'Je prépare le lancement. Le résultat reste ici pendant que nous discutons.' : review ? 'Je propose de conserver la réserve de 500 € et de confirmer la date de préouverture.' : 'Message reçu dans le moteur contrôlé de vérification.', deliverable: document ? { title: 'Lancement du café Boréal', body } : null };
      if (document) {
        const text = JSON.stringify(reply);
        for (const n of [.25, .48, .72]) { if (input.signal.aborted) return { kind: 'cancelled' }; input.onText?.({ ...ids, itemId: 'fixture-item', text: text.slice(0, Math.floor(text.length * n)), final: false }); await new Promise(r => setTimeout(r, 220)); }
        await new Promise(resolve => { const done = () => { input.signal.removeEventListener('abort', done); resolve(); }; input.signal.addEventListener('abort', done, { once: true }); void held.then(done); if (input.signal.aborted) done(); });
        if (input.signal.aborted) return { kind: 'cancelled' };
        input.onText?.({ ...ids, itemId: 'fixture-item', text, final: true });
      }
      return { kind: 'succeeded', reply, used: { model: 'controlled-fixture', effort: 'low', speed: 'standard' }, ...ids };
    } };
}
const chat = engine(), doc = engine(); const worker = createWorker({ store, engines: { chat, doc } });
const tls = createDeviceServer({ store, worker, engine: chat, devices, publicUrl: base, cert, key, allowedOrigins: [...origins], longPollMs: 800 });
const local = createHttpServer({ store, worker, engine: chat, devices, port: localPort, root, csrfToken: randomBytes(32).toString('hex') });
let grant = devices.createGrant();
const bridge = createServer((req, res) => {
  if (req.headers.host !== new URL(bridgeBase).host || (req.headers.origin && !origins.has(req.headers.origin))) { res.writeHead(403); res.end(); return; }
  if (req.headers.origin) { res.setHeader('access-control-allow-origin', req.headers.origin); res.setHeader('vary', 'Origin'); }
  const url = new URL(req.url ?? '/', bridgeBase);
  if (url.pathname === '/test/grant' && req.method === 'GET') { grant = devices.createGrant(); res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ ...grant, url: bridgeBase })); return; }
  if (url.pathname === '/test/finish' && req.method === 'POST') { finish(); res.end('ok'); return; }
  if (url.pathname === '/test/fail-next' && req.method === 'POST') { failNext = true; res.end('ok'); return; }
  if (url.pathname === '/test/hold' && req.method === 'POST') { held = new Promise(r => { finish = r; }); res.end('ok'); return; }
  if (!url.pathname.startsWith('/m/')) { res.writeHead(404); res.end(); return; }
  const upstream = request(base + url.pathname + url.search, { ca: cert, method: req.method, headers: { ...req.headers, host: new URL(base).host } }, reply => { res.writeHead(reply.statusCode ?? 500, reply.headers); reply.pipe(res); });
  upstream.on('error', () => { if (!res.destroyed && !res.headersSent) { res.writeHead(502); res.end(); } });
  res.on('close', () => upstream.destroy()); req.pipe(upstream);
});
await Promise.all([[tls, tlsPort], [local, localPort], [bridge, bridgePort]].map(([server, port]) => new Promise(r => server.listen(port, '127.0.0.1', r))));
process.stdout.write(JSON.stringify({ event: 'fixture-ready', localPort, bridgePort, tlsPort, model: 'controlled', data: 'temporary synthetic', note: 'HTTP loopback bridge exists only in this test tool. Native HTTPS requirement unchanged.' }) + '\n');
let stopping = false;
async function stop() { if (stopping) return; stopping = true; finish(); for (const server of [bridge, tls, local]) { server.closeAllConnections(); server.close(); } await worker.close(); store.close(); devices.close(); rmSync(dir, { recursive: true, force: true }); process.exit(0); }
process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
