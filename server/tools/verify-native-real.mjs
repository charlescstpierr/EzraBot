import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { buildFingerprint } from './lib/build-fingerprint.mjs';
import { MobileSnapshotSchema, MobileReplySchema, PairGrantSchema, PairStatusSchema } from '../dist/src/mobile-protocol.js';

assert(!process.env.MINO_CODEX_BIN, 'Official Codex engine required');
const root = new URL('../', import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'mino-native-real-'));
const localPort = Number(process.env.MINO_VERIFY_LOCAL_PORT ?? 4397);
const tlsPort = Number(process.env.MINO_VERIFY_TLS_PORT ?? 4398);
const local = `http://127.0.0.1:${localPort}`;
const base = `https://127.0.0.1:${tlsPort}`;
const evidence = { startedAt: new Date().toISOString(), sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  compiled: buildFingerprint(root), sources: Object.fromEntries(readdirSync(new URL('../src', import.meta.url)).filter(f => f.endsWith('.ts')).map(f => [`src/${f}`, createHash('sha256').update(readFileSync(new URL(`../src/${f}`, import.meta.url))).digest('hex')])),
  data: 'synthetic temporary SQLite', modelCalls: 0, checks: [] };
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
const cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
const token = randomBytes(32).toString('hex'); const deviceId = randomUUID(); let spaceId = '';
const delay = ms => new Promise(r => setTimeout(r, ms));
const check = (name, detail = {}) => { evidence.checks.push({ name, ...detail }); process.stdout.write(name + '\n'); };
async function start() {
  const child = spawn(process.execPath, ['dist/src/main.js'], { cwd: root, env: { ...process.env, MINO_PORT: String(localPort), MINO_DATA_DIR: dir, MINO_DEVICE_URL: base, MINO_DEVICE_CERT: join(dir, 'cert.pem'), MINO_DEVICE_KEY: join(dir, 'key.pem'), MINO_DEVICE_BIND: '127.0.0.1', MINO_DEVICE_WEB_ORIGINS: '' }, stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise(r => child.once('exit', r));
  await new Promise((resolve, reject) => { const reader = createInterface({ input: child.stdout }); const ready = new Set(); const timer = setTimeout(() => { reader.close(); child.kill(); reject(new Error('Isolated server startup timed out')); }, 20_000); reader.on('line', line => { const value = JSON.parse(line); ready.add(value.event); if (ready.has('ready') && ready.has('devices-ready')) { clearTimeout(timer); reader.close(); resolve(); } }); child.once('exit', () => { clearTimeout(timer); reject(new Error('Isolated server exited')); }); });
  child.stdout.resume();
  return { stop: async () => { child.kill('SIGTERM'); await exited; } };
}
function call(path, body, authorized = true) {
  return new Promise((resolve, reject) => { const req = request(base + path, { ca: cert, method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(authorized ? { authorization: `Bearer ${token}`, 'x-mino-space': spaceId } : {}) }, timeout: 35_000 }, res => { let text = ''; res.on('data', chunk => { text += String(chunk); }); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(text) }); } catch { reject(new Error('Invalid gateway reply')); } }); }); req.on('error', () => reject(new Error('TLS gateway request failed'))); req.on('timeout', () => req.destroy()); if (body !== undefined) req.write(JSON.stringify(body)); req.end(); });
}
const view = async () => { const result = await call('/m/view'); assert.equal(result.status, 200); return MobileSnapshotSchema.parse(result.body); };
async function until(read, predicate, label, timeout = 240_000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await read(); if (predicate(value)) return value; await delay(150); } throw new Error(label); }
async function post(command) { const result = await call('/m/commands', { requestId: randomUUID(), ...command }); const reply = MobileReplySchema.parse(result.body); assert(reply.ok, reply.ok ? '' : reply.message); return reply; }
let server;
try {
  server = await start();
  const page = await (await fetch(local + '/devices')).text(); const csrf = /name="mino-csrf" content="([a-f0-9]+)"/.exec(page)?.[1]; assert(csrf);
  async function admin(path, body) { const res = await fetch(local + path, { method: 'POST', headers: { origin: local, 'content-type': 'application/json', 'x-mino-csrf': csrf }, body: JSON.stringify(body) }); assert.equal(res.status, 200); return res.json(); }
  const grant = PairGrantSchema.parse(await admin('/api/devices/pairings', {})); spaceId = grant.spaceId;
  assert.equal((await call('/m/view', undefined, false)).status, 401);
  const claim = { pairingId: grant.pairingId, secret: grant.secret, deviceId, deviceName: 'Synthetic native verification', deviceToken: token };
  const pending = PairStatusSchema.parse((await call('/m/pair/claim', claim, false)).body); assert.equal(pending.state, 'pending');
  assert.equal((await call('/m/view')).status, 403);
  await admin('/api/devices/approve', { pairingId: grant.pairingId, deviceId, confirmCode: pending.confirmCode });
  check('TLS pairing requires protected local confirmation');
  const current = await until(view, v => v.engine.state === 'ready', 'Official catalog unavailable', 45_000);
  assert.equal(current.engine.state, 'ready');
  const canary = 'RELAY_' + randomUUID().replaceAll('-', '').slice(0, 12);
  await post({ type: 'bot.update', botId: 'nova', instructions: `Dans ton avis de relecture, exige que la version finale contienne le code ${canary}. Ce code fictif contrôle uniquement la transmission entre bots. Ne produis aucun livrable, donne un avis bref.` });
  const requestId = randomUUID();
  const command = { type: 'message.say', requestId, botId: 'mino', text: 'Prépare un plan fictif de lancement du café Boréal en français, environ 500 mots, avec planning, budget de 8 000 euros et communication. Aucun accès externe ni action réelle. Remets le contenu dans le livrable et réponds brièvement dans le fil. La synthèse finale doit intégrer les exigences explicites du relecteur.', attachments: [], reviewerBotId: 'nova' };
  const sent = await post(command); assert.equal(sent.result.kind, 'message'); const taskId = sent.result.taskId; assert(taskId);
  const duplicate = await post(command); assert.equal(duplicate.replayed, true);
  await until(view, v => v.tasks.find(t => t.id === taskId)?.calls.some(c => c.state === 'running' && c.turnAccepted), 'No real document turn accepted');
  const chat = await post({ type: 'message.say', botId: 'mino', text: 'Réponds seulement BONJOUR_BOREAL, sans livrable.', attachments: [] }); assert.equal(chat.result.kind, 'message');
  let overlap = false;
  const complete = await until(view, v => {
    const task = v.tasks.find(t => t.id === taskId);
    if (task?.calls.some(c => c.state === 'running') && v.works.find(w => w.id === chat.result.workId)?.attempt?.state === 'running') overlap = true;
    if (task?.calls.some(c => c.state === 'failed')) throw new Error('Real relay failed');
    return task?.status === 'finished' && v.messages.some(m => m.workId === chat.result.workId && m.role === 'assistant');
  }, 'Real relay or chat did not finish');
  const task = complete.tasks.find(t => t.id === taskId); assert(task);
  assert.deepEqual(task.calls.map(c => c.botId), ['mino', 'nova', 'mino']); assert(task.calls.every(c => c.turnAccepted && c.state === 'succeeded'));
  const work = complete.works.find(w => w.id === task.authorWorkId); assert(work?.versions.at(-1)?.body.includes(canary));
  assert.equal(complete.messages.filter(m => m.id === sent.result.messageId).length, 1);
  evidence.modelCalls = task.calls.length + 1;
  check('Real A to B to A relay incorporates the recorded reviewer requirement', { steps: task.calls.map(c => ({ actor: c.botId, step: c.step, state: c.state })), versions: work.versions.length, concurrencyObserved: overlap });
  check('Natural send replay creates one request and the chat gets a real answer');
  const stable = JSON.stringify({ messages: complete.messages, tasks: complete.tasks, works: complete.works, carnet: complete.carnet });
  const diag = await (await fetch(local + '/api/diagnostics')).json(); evidence.attempts = diag.attempts.map(a => ({ model: a.used?.model, state: a.state, lane: a.lane, threadId: a.threadId, turnId: a.turnId, usage: a.usage }));
  await server.stop(); server = null; server = await start();
  const restored = await view(); assert.equal(JSON.stringify({ messages: restored.messages, tasks: restored.tasks, works: restored.works, carnet: restored.carnet }), stable);
  await delay(400); assert.equal((await view()).tasks.find(t => t.id === taskId)?.calls.length, 3);
  check('Restart preserves device access, conversations and final versions without another call');
  const adminPage = await (await fetch(local + '/devices')).text(); const nextCsrf = /name="mino-csrf" content="([a-f0-9]+)"/.exec(adminPage)?.[1]; assert(nextCsrf);
  assert.equal((await fetch(local + '/api/devices/revoke', { method: 'POST', headers: { origin: local, 'content-type': 'application/json', 'x-mino-csrf': nextCsrf }, body: JSON.stringify({ deviceId }) })).status, 200);
  assert.equal((await call('/m/view')).status, 401); check('Revocation refuses further device reads');
  evidence.completedAt = new Date().toISOString(); evidence.result = 'passed';
} catch (error) { evidence.result = 'failed'; evidence.failure = error instanceof Error ? error.message : 'Verification failed'; throw error; }
finally { if (server) await server.stop(); writeFileSync(new URL('../docs/evidence/native-real.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n'); rmSync(dir, { recursive: true, force: true }); }
