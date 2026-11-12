import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url);
const port = Number(process.env.MINO_PORT ?? 4391);
const dataDir = mkdtempSync(join(tmpdir(), 'mino-verify-'));
const base = `http://127.0.0.1:${port}`;
const evidence = { checkedAt: new Date().toISOString(), sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), dataDir: 'temporaire', steps: [] };
const step = (name, details = {}) => {
  evidence.steps.push({ name, ...details });
  process.stdout.write(`✓ ${name}\n`);
};

function startServer(env = {}) {
  const child = spawn(process.execPath, ['dist/src/main.js'], {
    cwd: root, env: { ...process.env, MINO_DATA_DIR: dataDir, MINO_PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { if (String(chunk).includes('"event":"ready"')) resolve(); });
    child.once('exit', code => reject(new Error(`Le serveur s’est arrêté (code ${code}) : ${stderr.trim()}`)));
  });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal, stderr })));
  return { child, ready, exited };
}

function http(method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text: data, json: () => JSON.parse(data) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function session() {
  const page = await http('GET', '/');
  assert.equal(page.status, 200);
  const token = /name="mino-csrf" content="([0-9a-f]+)"/.exec(page.text)?.[1];
  assert(token, 'jeton anti-CSRF injecté dans la page');
  return token;
}

async function command(token, value) {
  const res = await http('POST', '/api/commands', {
    body: JSON.stringify(value),
    headers: { 'content-type': 'application/json', origin: base, 'x-mino-csrf': token },
  });
  return { status: res.status, ...res.json() };
}

async function view() {
  return (await http('GET', '/api/view')).json();
}

async function waitFor(predicate, label, timeoutMs = 240_000) {
  const stages = new Set();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await view();
    for (const work of current.works) if (work.attempt?.stage) stages.add(work.attempt.stage);
    const found = predicate(current);
    if (found) return { current, found, stages: [...stages] };
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Délai dépassé : ${label}`);
}

const workOf = (current, id) => current.works.find(work => work.id === id);
let server = startServer();
try {
  await server.ready;
  step('serveur lancé sur 127.0.0.1', { port });

  assert.equal((await http('GET', '/', { headers: { host: `evil.example:${port}` } })).status, 421);
  const token = await session();
  const noOrigin = await http('POST', '/api/commands', { body: '{}', headers: { 'content-type': 'application/json', 'x-mino-csrf': token } });
  assert.equal(noOrigin.status, 403);
  const badToken = await http('POST', '/api/commands', { body: '{}', headers: { 'content-type': 'application/json', origin: base, 'x-mino-csrf': 'faux' } });
  assert.equal(badToken.status, 403);
  step('hôte étranger, origine absente et jeton faux refusés');

  const catalog = (await http('GET', '/api/catalog')).json();
  assert.equal(catalog.state, 'ready', `Codex prêt (${catalog.message ?? ''})`);
  step('catalogue Codex lu', { models: catalog.models.map(model => model.id) });

  const second = startServer({ MINO_PORT: String(port + 1) });
  second.ready.catch(() => {});
  const refused = await second.exited;
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /Une autre instance de Mino/);
  step('seconde instance sur les mêmes données refusée');

  const send = {
    type: 'message.send', requestId: 'verify-real-message-1', botId: 'mino', attachments: [],
    text: 'Rédige un message de trois phrases pour inviter Léa à un café samedi matin.',
  };
  const accepted = await command(token, send);
  assert.equal(accepted.ok, true);
  const replay = await command(token, send);
  assert.equal(replay.replayed, true);
  assert.equal(replay.result.workId, accepted.result.workId);
  const workId = accepted.result.workId;
  step('demande acceptée une seule fois malgré le rejeu', { workId });

  const answered = await waitFor(current => {
    const work = workOf(current, workId);
    return work && ['review', 'done', 'failed'].includes(work.state) ? work : null;
  }, 'réponse Codex');
  assert.notEqual(answered.found.state, 'failed', `Échec moteur : ${answered.found.attempt?.error}`);
  const reply = answered.current.messages.find(message => message.role === 'assistant' && message.workId === workId);
  assert(reply?.stamp?.model && reply.stamp.threadId && reply.stamp.turnId, 'réponse avec modèle, fil et tour');
  step('vraie réponse Codex enregistrée', {
    state: answered.found.state,
    stagesSeen: answered.stages,
    model: reply.stamp.model,
    effort: reply.stamp.effort,
    speed: reply.stamp.speed,
    threadId: reply.stamp.threadId,
    turnId: reply.stamp.turnId,
    replyExcerpt: reply.text.slice(0, 140),
    versions: answered.found.versions.length,
  });

  const slow = await command(token, {
    type: 'message.send', requestId: 'verify-real-message-2', botId: 'atlas', attachments: [],
    text: 'Explique en au moins 1200 mots comment fonctionne une file d’attente durable, avec des exemples concrets de panne et de reprise.',
  });
  const slowId = slow.result.workId;
  const active = await waitFor(current => {
    const work = workOf(current, slowId);
    return work?.state === 'running' && ['thinking', 'writing'].includes(work.attempt?.stage) ? work : null;
  }, 'tour Codex actif');
  server.child.kill('SIGKILL');
  await server.exited;
  step('serveur tué par SIGKILL pendant un tour Codex actif', { workId: slowId, stageAtKill: active.found.attempt.stage });

  server = startServer();
  await server.ready;
  const restarted = await view();
  const interrupted = workOf(restarted, slowId);
  assert.equal(interrupted.state, 'failed');
  assert.match(interrupted.attempt.error, /arrêté pendant cet appel/);
  const kept = workOf(restarted, workId);
  assert.equal(kept.state, answered.found.state);
  assert(restarted.messages.some(message => message.id === reply.id && message.text === reply.text), 'réponse conservée après redémarrage');
  step('après redémarrage : réponse conservée, appel interrompu visible', { interruptedState: interrupted.state, attempts: interrupted.attempts });

  const token2 = await session();
  const retry = await command(token2, { type: 'work.retry', requestId: 'verify-real-retry-1', workId: slowId });
  assert.equal(retry.ok, true);
  const retried = await waitFor(current => {
    const work = workOf(current, slowId);
    return work && ['review', 'done', 'failed'].includes(work.state) ? work : null;
  }, 'relance');
  assert.notEqual(retried.found.state, 'failed', `Échec moteur : ${retried.found.attempt?.error}`);
  const retryReply = retried.current.messages.find(message => message.role === 'assistant' && message.workId === slowId);
  step('relance manuelle terminée', { state: retried.found.state, attempts: retried.found.attempts, threadId: retryReply?.stamp?.threadId, turnId: retryReply?.stamp?.turnId });

  server.child.kill('SIGTERM');
  await server.exited;
  server = startServer();
  await server.ready;
  const final = await view();
  assert.equal(workOf(final, slowId).state, retried.found.state);
  assert.equal(final.messages.length, retried.current.messages.length);
  step('second redémarrage : historique identique', { messages: final.messages.length, works: final.works.length });
} finally {
  server.child.kill('SIGTERM');
  await server.exited;
}

evidence.completedAt = new Date().toISOString();
writeFileSync(new URL('docs/evidence/real-loop.json', root), JSON.stringify(evidence, null, 2) + '\n');
process.stdout.write('Preuve écrite dans docs/evidence/real-loop.json\n');
