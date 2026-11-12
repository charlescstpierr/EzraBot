import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';

// Coordinated missions with real Codex, through Mino's HTTP API, on throwaway data and throwaway git repos.
// Usage: node tools/verify-coordination-real.mjs <build-root> [ca1|ca2|all]   (build-root from tools/build-isolated.sh; never the served dist)
const build = resolve(process.argv[2] ?? '.');
const only = process.argv[3] ?? 'all';
const repoRoot = new URL('../', import.meta.url);
const port = Number(process.env.MINO_PORT ?? 4396);
const base = `http://127.0.0.1:${port}`;
const codexBin = process.env.MINO_CODEX_BIN ?? 'codex';
const home = homedir();
const dataDir = mkdtempSync(join(tmpdir(), 'mino-coord-data-'));
mkdirSync(join(home, '.cache'), { recursive: true });
const projects = [];
const REQUEST = 'Ajoute une fonction slugify avec tests, puis documente-la dans le README.';
const V1 = 'Crée NOTES.md avec trois idées de noms pour le projet, puis ajoute capitalize.js qui met en majuscule la première lettre, avec un test node:test.';
const V2 = 'OBJECTIF V2 : ajoute seulement capitalize.js avec son test node:test. Pas de NOTES.md.';
const hide = value => {
  let text = JSON.stringify(value).replaceAll(dataDir, '<données>');
  for (const p of projects) text = text.replaceAll(p, '<projet>');
  return JSON.parse(text.replaceAll(home, '~'));
};
const codexPath = realpathSync(execFileSync('sh', ['-c', `command -v ${codexBin}`], { encoding: 'utf8' }).trim());
const evidence = {
  checkedAt: new Date().toISOString(),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
  codex: execFileSync(codexBin, ['--version'], { encoding: 'utf8' }).trim(),
  codexSha256: createHash('sha256').update(readFileSync(codexPath)).digest('hex'),
  data: 'dossier temporaire, effacé à la fin', projects: 'dépôts git temporaires, effacés à la fin',
  modelTurns: { chat: 0, lead: 0, step: 0 }, rpcWithoutTurn: { threadResume: 0 }, nudges: [], steps: [], limits: [],
};
const step = (name, details = {}) => { evidence.steps.push(hide({ name, ...details })); process.stdout.write(`✓ ${name}\n`); };

function newProject(label) {
  const path = realpathSync(mkdtempSync(join(home, '.cache', `mino-coord-${label}-`)));
  projects.push(path);
  writeFileSync(join(path, 'package.json'), '{"type":"module","scripts":{"test":"node --test"}}\n');
  writeFileSync(join(path, 'README.md'), '# Démo\n\nPetit projet de démonstration.\n');
  writeFileSync(join(path, 'base.test.js'), "import test from 'node:test';\ntest('base', () => {});\n");
  execFileSync('git', ['init', '-q'], { cwd: path });
  execFileSync('git', ['add', '.'], { cwd: path });
  execFileSync('git', ['-c', 'user.email=verify@mino.local', '-c', 'user.name=verify', 'commit', '-qm', 'init'], { cwd: path });
  return path;
}

function startServer() {
  const child = spawn(process.execPath, [join(build, 'dist/src/main.js')], {
    cwd: build, env: { ...process.env, MINO_DATA_DIR: dataDir, MINO_PORT: String(port), MINO_DEVICE_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { out += chunk; });
  const ready = new Promise((ok, ko) => {
    child.stdout.on('data', chunk => { if (String(chunk).includes('"event":"ready"')) ok(); });
    child.once('exit', code => ko(new Error(`serveur arrêté (${code}) : ${out.slice(-2000)}`)));
  });
  const exited = new Promise(done => child.once('exit', (code, signal) => done({ code, signal })));
  return { child, ready, exited };
}

function http(method, path, { body, headers = {} } = {}) {
  return new Promise((ok, ko) => {
    const req = request(`${base}${path}`, { method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => ok({ status: res.statusCode, json: () => JSON.parse(data), text: data }));
    });
    req.on('error', ko);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

let token = '';
async function session() {
  const page = await http('GET', '/');
  token = /name="mino-csrf" content="([0-9a-f]+)"/.exec(page.text)?.[1] ?? '';
  assert(token, 'jeton anti-CSRF');
}
const post = async (path, command) => {
  const res = await http('POST', path, { body: JSON.stringify({ requestId: `verify-${randomUUID()}`, ...command }), headers: { 'content-type': 'application/json', origin: base, 'x-mino-csrf': token } });
  return { status: res.status, ...res.json() };
};
const send = command => post('/api/agents/commands', command);
const detail = async id => (await http('GET', `/api/agents/missions/${id}`)).json().mission;
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(read, predicate, label, timeoutMs) {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`${label} : délai dépassé (${JSON.stringify(value?.status ?? value).slice(0, 300)})`);
    await pause(1500);
  }
}
const ended = status => !['queued', 'running', 'stopping'].includes(status);
async function tree(id) {
  const root = await detail(id);
  const children = await Promise.all(root.children.map(c => detail(c.id)));
  return { root, children };
}
function countTurns({ root, children }) {
  evidence.modelTurns.lead += root.attempts.filter(a => a.kind === 'lead' && a.turnId).length;
  evidence.modelTurns.step += children.flatMap(c => c.attempts).filter(a => a.turnId).length;
}

/** Reopens native sessions with `thread/resume` and no turn: no model call, only Codex's own record of each thread. */
async function resumeWithoutTurn(threads, cwd) {
  const { AGENT_DISABLED_FEATURES, AGENT_CONFIG_ARGS } = await import(join(build, 'dist/src/agent-engine.js'));
  const tmp = join(dataDir, 'resume-tmp');
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const child = spawn(codexBin, ['app-server', '--listen', 'stdio://', ...AGENT_DISABLED_FEATURES.flatMap(f => ['--disable', f]), ...AGENT_CONFIG_ARGS], { cwd: tmp, env: { ...process.env, TMPDIR: tmp }, stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map();
  const notes = [];
  createInterface({ input: child.stdout }).on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); } else if (message.method) notes.push(message.method);
  });
  let seq = 0;
  const call = (method, params) => new Promise((ok, ko) => {
    const id = ++seq;
    const timer = setTimeout(() => ko(new Error(`${method} sans réponse`)), 30_000);
    pending.set(id, m => { clearTimeout(timer); ok(m); });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  try {
    await call('initialize', { clientInfo: { name: 'mino-verify', title: 'Mino vérification', version: 'verify' }, capabilities: { experimentalApi: false } });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    const out = [];
    for (const threadId of threads) {
      const answer = await call('thread/resume', { threadId, cwd, sandbox: 'read-only', approvalPolicy: 'never', excludeTurns: true, config: { mcp_servers: {}, web_search: 'disabled' } });
      evidence.rpcWithoutTurn.threadResume += 1;
      out.push({ threadId, reopened: answer.result?.thread?.id === threadId, error: answer.error?.message ?? null });
    }
    return { threads: out, turnStarted: notes.includes('turn/started') };
  } finally { child.kill('SIGTERM'); }
}

let server = startServer();
try {
  await server.ready;
  await session();
  const catalog = (await http('GET', '/api/agents/catalog')).json();
  const model = catalog.models.find(m => m.isDefault) ?? catalog.models[0];
  const effort = model.efforts.includes('low') ? 'low' : model.defaultEffort;
  evidence.choice = { model: null, effort };

  if (only === 'all' || only === 'ca1') {
    const project = newProject('ca1');
    const chat = await post('/api/commands', { type: 'message.send', botId: 'mino', text: REQUEST, attachments: [] });
    assert.ok(chat.ok, chat.message);
    const answered = await until(async () => (await http('GET', '/api/view')).json(), v => v.works.some(w => w.id === chat.result.workId && ['done', 'review', 'failed'].includes(w.state)), 'réponse de Mino', 5 * 60_000);
    evidence.modelTurns.chat += 1;
    const minoReply = answered.messages.find(m => m.role === 'assistant' && m.workId === chat.result.workId);
    assert.ok(minoReply, 'Mino a répondu');
    step('Mino reçoit la demande dans son fil et répond avec une proposition structurée, sans rien créer', { reply: minoReply.text.slice(0, 400), handoff: minoReply.handoff, missions: (await (await http('GET', '/api/agents/view')).json()).missions.length });
    if (!minoReply.handoff) evidence.limits.push('Le vrai Mino n’a pas rendu de handoff pour cette demande : la création ci-dessous passe par le formulaire, sans origine.');

    const added = await send({ type: 'project.add', path: project, name: 'demo', checkCommand: 'node --test' });
    assert.ok(added.ok, added.message);
    const forged = await send({ type: 'mission.create', projectId: added.id, goal: REQUEST, model: null, effort, mode: 'coordinated', leadBotId: 'nova', origin: { messageId: answered.messages.find(m => m.role === 'user').id } });
    assert.equal(forged.code, 'not_found', 'a message of the person is not a proposal of Mino');
    const created = await send({
      type: 'mission.create', projectId: added.id, goal: minoReply.handoff?.goal ?? REQUEST, model: null, effort, mode: 'coordinated', leadBotId: 'nova',
      ...(minoReply.handoff ? { origin: { messageId: minoReply.id } } : {}),
    });
    assert.ok(created.ok, created.message);
    step('la personne confie avec un responsable : origine retrouvée par le PC, origine forgée refusée', { forged: forged.code, origin: (await detail(created.id)).origin });

    let root = await until(() => detail(created.id), m => ended(m.status), 'mission coordonnée', 30 * 60_000);
    if (root.status === 'waiting' && root.can.continue) {
      evidence.nudges.push({ waiting: root.waiting });
      assert.ok((await send({ type: 'mission.continue', missionId: created.id, note: 'Décide toi-même la suite, sans autre question.' })).ok);
      root = await until(() => detail(created.id), m => ended(m.status), 'mission coordonnée après précision', 30 * 60_000);
    }
    const t = await tree(created.id);
    countTurns(t);
    root = t.root;
    const delegates = root.decisions.filter(d => d.kind === 'delegate' && d.outcome === 'applied');
    const finish = root.decisions.find(d => d.kind === 'finish' && d.outcome === 'applied');
    step('décisions réelles du responsable enregistrées avec leur texte brut', { status: root.status, waiting: root.waiting, decisions: root.decisions.map(d => ({ n: d.n, kind: d.kind, outcome: d.outcome, refusal: d.refusal, raw: d.raw.slice(0, 600) })) });
    assert.equal(root.status, 'review', root.waiting ?? root.acceptBlocked ?? '');
    assert.ok(delegates.length >= 2, 'au moins deux délégations appliquées');
    assert.ok(finish && finish.raw.length > 0, 'une synthèse appliquée');
    const work = t.children.map(c => c.attempts.find(a => a.kind === 'start'));
    for (let i = 1; i < work.length; i += 1) assert.ok(work[i - 1].endedAt <= work[i].startedAt, 'les étapes ne se chevauchent pas');
    const sessions = [root.threadId, ...t.children.map(c => c.threadId)];
    assert.equal(new Set(sessions).size, sessions.length, 'sessions natives distinctes');
    const inputs = [...root.attempts.filter(a => a.kind === 'lead'), ...t.children.flatMap(c => c.attempts)].filter(a => a.input);
    const originText = root.origin?.text ?? null;
    if (originText) assert.ok(inputs.every(a => a.input.includes(originText)), 'chaque essai a reçu le texte exact de la demande');
    for (const ev of root.synthesis.evidence) assert.equal(ev.check?.exitCode, 0, `contrôle de ${ev.childTitle}`);
    assert.equal(root.synthesis.final.check.exitCode, 0, 'contrôle final du dossier intégré');
    const files = execFileSync('git', ['status', '--porcelain'], { cwd: project, encoding: 'utf8' }).trim().split('\n');
    step('deux étapes réelles, séquentielles, dans des sessions natives distinctes, contrôlées puis contrôle final intégré', {
      leadThread: root.threadId, steps: t.children.map(c => ({ title: c.title, threadId: c.threadId, status: c.status, startedAt: c.attempts[0]?.startedAt, endedAt: c.attempts[0]?.endedAt, check: c.attempts.at(-1)?.check?.exitCode, observed: c.attempts.at(-1)?.observed?.status })),
      finalCheck: root.synthesis.final.check, filesOnDisk: files, exactOriginInEveryInput: originText ? true : 'sans origine', tree: root.tree, tokens: root.tokens,
    });

    const accepted = await send({ type: 'mission.accept', missionId: created.id, attemptId: root.can.accept });
    assert.ok(accepted.ok, accepted.message);
    const after = await tree(created.id);
    const cited = new Set(root.synthesis.evidence.map(e => e.childId));
    assert.equal(after.root.status, 'accepted');
    for (const c of after.children) if (cited.has(c.id)) assert.equal(c.status, 'accepted');
    step('la validation de la synthèse valide la mission et les étapes citées', { root: after.root.status, steps: after.children.map(c => [c.title, c.status]) });

    server.child.kill('SIGTERM');
    await server.exited;
    server = startServer();
    await server.ready;
    await session();
    const reopened = await tree(created.id);
    assert.deepEqual(reopened.root.decisions.map(d => [d.id, d.raw]), after.root.decisions.map(d => [d.id, d.raw]), 'décisions conservées');
    assert.deepEqual([reopened.root.threadId, ...reopened.children.map(c => c.threadId)], sessions, 'identités de session conservées');
    assert.equal(reopened.root.lead.name, 'Nova');
    const resumed = await resumeWithoutTurn(sessions, project);
    assert.ok(resumed.threads.every(r => r.reopened), JSON.stringify(resumed));
    assert.equal(resumed.turnStarted, false);
    step('après redémarrage : décisions, sessions et responsable conservés ; chaque session se rouvre par thread/resume, sans tour', { lead: reopened.root.lead, resume: resumed });
  }

  if (only === 'all' || only === 'ca2') {
    const project = newProject('ca2');
    const added = await send({ type: 'project.add', path: project, name: 'demo2', checkCommand: 'node --test' });
    assert.ok(added.ok, added.message);
    const created = await send({ type: 'mission.create', projectId: added.id, goal: V1, model: null, effort, mode: 'coordinated', leadBotId: 'nova' });
    assert.ok(created.ok, created.message);
    const running = await until(() => detail(created.id), m => m.children.length > 0 && m.status === 'running', 'première étape en cours', 10 * 60_000);
    const childId = running.children[0].id;
    await until(() => detail(childId), c => c.attempts[0]?.state === 'running' && c.attempts[0]?.turnId, 'tour de l’étape démarré', 5 * 60_000);
    const revised = await send({ type: 'mission.revise', missionId: created.id, goal: V2, start: true });
    assert.ok(revised.ok, revised.message);
    const asked = await detail(childId);
    step('objectif changé pendant la première étape : arrêt demandé à l’étape', { stepStatus: asked.status, parentGoalRev: (await detail(created.id)).goalRev });
    const stepEnd = await until(() => detail(childId), c => ended(c.status), 'fin de l’étape arrêtée', 3 * 60_000);
    const outcome = stepEnd.attempts[0];
    step('fin de l’étape telle qu’observée', { state: outcome.state, message: outcome.errorMessage, observed: outcome.observed?.status ?? null });

    if (outcome.state === 'interrupted') {
      await pause(15_000);
      const fenced = await tree(created.id);
      const wake = fenced.root.attempts.find(a => a.trigger === 'rev:2');
      assert.equal(wake?.state, 'stopped', 'le réveil v2 réservé ne démarre pas');
      assert.ok(!fenced.root.attempts.some(a => ['queued', 'running'].includes(a.state)));
      step('étape au résultat inconnu : le réveil v2 déjà réservé est bloqué, rien ne démarre sans reprise', { wake: wake?.errorMessage, status: fenced.root.status, waiting: fenced.root.waiting });
      assert.ok((await send({ type: 'mission.stop', missionId: created.id })).ok);
    } else {
      const lead = await until(() => detail(created.id), m => m.attempts.some(a => a.trigger === 'rev:2' && a.input), 'réveil v2 du responsable', 3 * 60_000);
      const wake = lead.attempts.find(a => a.trigger === 'rev:2');
      assert.ok(wake.input.includes(V2), 'le réveil porte le texte v2 exact');
      assert.ok(!wake.input.includes(V1), 'et pas le texte v1');
      step('le réveil suivant porte le texte v2 exact, pas le v1', { inputExcerpt: wake.input.slice(0, 900) });
      const stop = await send({ type: 'mission.stop', missionId: created.id });
      assert.ok(stop.ok, stop.message);
    }
    const stopped = await until(() => tree(created.id), t => !t.root.attempts.concat(t.children.flatMap(c => c.attempts)).some(a => ['queued', 'running', 'verifying', 'stopping'].includes(a.state)), 'arbre arrêté', 3 * 60_000);
    const used = stopped.root.tree.used;
    await pause(20_000);
    const later = await tree(created.id);
    countTurns(later);
    assert.equal(later.root.tree.used, used, 'le budget utilisé ne bouge plus');
    assert.equal((await (await http('GET', '/api/agents/view')).json()).queue.length, 0, 'file vide');
    assert.equal(later.root.attempts.length, stopped.root.attempts.length, 'aucun réveil après l’arrêt');
    step('« Arrêter tout » : file vide, aucun réveil ensuite, budget figé', {
      status: later.root.status, used, attempts: later.root.attempts.map(a => [a.kind, a.trigger, a.state, a.errorMessage]), steps: later.children.map(c => [c.title, c.status]),
    });
  }
} finally {
  server.child.kill('SIGTERM');
  await server.exited;
  rmSync(dataDir, { recursive: true, force: true });
  for (const p of projects) rmSync(p, { recursive: true, force: true });
  evidence.cleanup = { dataRemoved: !existsSync(dataDir), projectsRemoved: projects.every(p => !existsSync(p)) };
  evidence.limits.push('Une finish citant une étape v1 refusée, les refus de format, de budget, d’étape inconnue et la reprise d’un enfant ancien sont prouvés par test/missions-coordination.test.ts (registre réel, faux Codex), pas par un appel modèle.');
  writeFileSync(new URL(`../docs/evidence/coordination-real${only === 'all' ? '' : `-${only}`}.json`, import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
  process.stdout.write(`Preuve écrite (${evidence.steps.length} étapes)\n`);
}
