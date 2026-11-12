import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../', import.meta.url);
const port = Number(process.env.MINO_PORT ?? 4396);
const base = `http://127.0.0.1:${port}`;
const out = process.env.MINO_EVIDENCE_OUT ?? new URL('docs/evidence/real-usage.json', root).pathname;
const dataDir = mkdtempSync(join(tmpdir(), 'mino-usage-'));
const lateWaitMs = Number(process.env.MINO_USAGE_WAIT_MS ?? 15_000);

const server = spawn(process.execPath, ['dist/src/main.js'], {
  cwd: root, env: { ...process.env, MINO_DATA_DIR: dataDir, MINO_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.resume();
const exited = new Promise(resolve => server.once('exit', resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(read, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await delay(200);
  }
}
const view = async () => (await fetch(`${base}/api/view`)).json();

try {
  await new Promise((resolve, reject) => {
    server.stdout.on('data', chunk => { if (String(chunk).includes('"event":"ready"')) resolve(); });
    server.once('exit', code => reject(new Error(`Serveur arrêté (code ${code})`)));
  });
  const csrf = /name="mino-csrf" content="([0-9a-f]+)"/.exec(await (await fetch(base)).text())?.[1];
  assert(csrf, 'jeton de session');
  const sent = await (await fetch(`${base}/api/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, 'x-mino-csrf': csrf },
    body: JSON.stringify({ type: 'message.send', requestId: `verify-usage-${Date.now()}`, botId: 'mino', attachments: [], text: 'Réponds en une phrase : quelle couleur obtient-on en mélangeant du bleu et du jaune ?' }),
  })).json();
  assert(sent.ok, sent.message);
  const workId = sent.result.workId;
  const finished = await until(async () => {
    const current = await view();
    const work = current.works.find(w => w.id === workId);
    return work && ['review', 'done', 'failed'].includes(work.state) ? { current, work } : null;
  }, 'réponse', 240_000);
  assert(finished, 'le travail se termine');
  const late = await until(async () => (await view()).works.find(w => w.id === workId)?.attempt?.usage ?? null, 'usage', lateWaitMs);
  const attempt = (await view()).works.find(w => w.id === workId).attempt;
  const reply = finished.current.messages.find(m => m.role === 'assistant' && m.workId === workId);
  const usage = attempt.usage;
  const evidence = {
    checkedAt: new Date().toISOString(),
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    engine: process.env.MINO_CODEX_BIN ? 'MINO_CODEX_BIN (not the real Codex)' : 'codex on PATH',
    dataDir,
    reply: reply?.text ?? null,
    state: finished.work.state,
    error: attempt.error,
    used: reply?.stamp ? { model: reply.stamp.model, effort: reply.stamp.effort, speed: reply.stamp.speed } : null,
    sameThreadAndTurn: Boolean(reply?.stamp && reply.stamp.threadId === attempt.threadId && reply.stamp.turnId === attempt.turnId),
    plan: attempt.plan,
    usage: usage ? { total: usage.total, last: usage.last, modelContextWindow: usage.modelContextWindow } : null,
    usageArrived: usage ? (usage.receivedAt <= attempt.finishedAt ? 'before or with the recorded result' : 'after the recorded result') : `not reported within ${lateWaitMs} ms after the result`,
    seenWhileWaiting: Boolean(late),
    note: 'Counts are what Codex reported for this one call. They are not a price, and one call does not measure a saving.',
  };
  assert.notEqual(finished.work.state, 'failed', `échec moteur : ${attempt.error}`);
  assert(reply?.text.toLocaleLowerCase('fr').includes('vert'), 'la réponse réelle doit répondre à la question');
  await new Promise(resolve => { server.kill('SIGTERM'); exited.then(resolve); });
  const restarted = spawn(process.execPath, ['dist/src/main.js'], {
    cwd: root, env: { ...process.env, MINO_DATA_DIR: dataDir, MINO_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  restarted.stderr.resume();
  const restartedExit = new Promise(resolve => restarted.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Redémarrage indisponible')), 10000);
      restarted.stdout.on('data', chunk => {
        if (String(chunk).includes('"event":"ready"')) { clearTimeout(timer); resolve(); }
      });
      restarted.once('exit', () => { clearTimeout(timer); reject(new Error('Arrêt avant redémarrage')); });
    });
    const restored = await view();
    const restoredWork = restored.works.find(w => w.id === workId);
    assert.equal(restored.messages.find(m => m.id === reply.id)?.text, reply.text);
    assert.equal(restoredWork?.state, finished.work.state);
    assert.deepEqual(restoredWork?.attempt?.usage, usage);
    evidence.restart = { responseKept: true, stateKept: true, usageKept: usage ? true : null };
  } finally {
    restarted.kill('SIGTERM');
    await restartedExit;
  }
  writeFileSync(out, JSON.stringify(evidence, null, 2) + '\n');
  process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
} catch {
  writeFileSync(out, JSON.stringify({ checkedAt: new Date().toISOString(), passed: false, note: 'Le parcours a échoué. Aucune preuve de réussite actuelle.', engine: process.env.MINO_CODEX_BIN ? 'MINO_CODEX_BIN (not the real Codex)' : 'codex on PATH' }, null, 2) + '\n');
  throw new Error('Le parcours de consommation a échoué. Voir la preuve sans secret.');
} finally {
  server.kill('SIGTERM');
  await exited;
}
