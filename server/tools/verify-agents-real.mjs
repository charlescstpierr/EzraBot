import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

// Real Codex executor run through Mino's HTTP API, on throwaway data and a throwaway git repo.
// Usage: node tools/verify-agents-real.mjs <build-root>   (build-root from tools/build-isolated.sh; never the served dist)
const build = resolve(process.argv[2] ?? '.');
const repoRoot = new URL('../', import.meta.url);
const port = Number(process.env.MINO_PORT ?? 4398);
const base = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), 'mino-agents-data-'));
mkdirSync(join(homedir(), '.cache'), { recursive: true });
const project = realpathSync(mkdtempSync(join(homedir(), '.cache', 'mino-agents-project-')));
const home = homedir();
const hide = value => JSON.parse(JSON.stringify(value).replaceAll(project, '<projet>').replaceAll(dataDir, '<données>').replaceAll(home, '~'));
const evidence = {
  checkedAt: new Date().toISOString(),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
  codex: execFileSync(process.env.MINO_CODEX_BIN ?? 'codex', ['--version'], { encoding: 'utf8' }).trim(),
  data: 'dossier temporaire, effacé à la fin', project: 'dépôt git temporaire, effacé à la fin', steps: [],
};
const step = (name, details = {}) => { evidence.steps.push(hide({ name, ...details })); process.stdout.write(`✓ ${name}\n`); };

writeFileSync(join(project, 'package.json'), '{"type":"module","scripts":{"test":"node --test"}}\n');
writeFileSync(join(project, 'sum.js'), 'export const sum = (a, b) => a - b;\n');
writeFileSync(join(project, 'sum.test.js'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sum } from './sum.js';\ntest('sum adds', () => assert.equal(sum(2, 3), 5));\n");
execFileSync('git', ['init', '-q'], { cwd: project });
execFileSync('git', ['add', '.'], { cwd: project });
execFileSync('git', ['-c', 'user.email=verify@mino.local', '-c', 'user.name=verify', 'commit', '-qm', 'init'], { cwd: project });

function startServer() {
  const child = spawn(process.execPath, [join(build, 'dist/src/main.js')], {
    cwd: build, env: { ...process.env, MINO_DATA_DIR: dataDir, MINO_PORT: String(port), MINO_DEVICE_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { out += chunk; });
  const ready = new Promise((ok, ko) => {
    child.stdout.on('data', chunk => { if (String(chunk).includes('"event":"ready"')) ok(); });
    child.once('exit', code => ko(new Error(`serveur arrêté (${code}) : ${out}`)));
  });
  const exited = new Promise(done => child.once('exit', (code, signal) => done({ code, signal, out })));
  return { child, ready, exited, log: () => out };
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
async function send(command) {
  const res = await http('POST', '/api/agents/commands', { body: JSON.stringify({ requestId: `verify-${randomUUID()}`, ...command }), headers: { 'content-type': 'application/json', origin: base, 'x-mino-csrf': token } });
  return { status: res.status, ...res.json() };
}
const detail = async id => (await http('GET', `/api/agents/missions/${id}`)).json().mission;
async function until(id, predicate, label, timeoutMs = 8 * 60_000) {
  const started = Date.now();
  for (;;) {
    const mission = await detail(id);
    if (predicate(mission)) return mission;
    if (Date.now() - started > timeoutMs) throw new Error(`${label} : délai dépassé, état ${mission.status}`);
    await new Promise(r => setTimeout(r, 1000));
  }
}

const { createAgentEngine } = await import(join(build, 'dist/src/agent-engine.js'));
const { observeProject } = await import(join(build, 'dist/src/project-guard.js'));
const probe = createAgentEngine({ command: process.env.MINO_CODEX_BIN ?? 'codex', tmpDir: join(dataDir, 'probe-tmp'), clientVersion: 'verify' });
const outsideHome = join(home, '.cache', `mino-escape-${randomUUID()}`);
const outsideTmp = `/tmp/mino-escape-${randomUUID()}`;
const signal = new AbortController().signal;
const shown = outcome => outcome.kind === 'exited' ? { exitCode: outcome.exitCode, output: `${outcome.stdout}${outcome.stderr}`.trim().slice(0, 160) } : { exitCode: null, output: outcome.kind };
const write = argv => probe.exec({ cwd: project, argv, sandbox: 'workspace-write', signal }).then(shown);
const inside = await write(['touch', join(project, 'inside.txt')]);
const tmpWrite = await write(['touch', outsideTmp]);
const homeWrite = await write(['touch', outsideHome]);
const network = await write(['curl', '-sS', '-m', '5', 'https://example.com']);

const hooked = realpathSync(mkdtempSync(join(home, '.cache', 'mino-agents-hooked-')));
const monitorMark = join(home, '.cache', `mino-fsmonitor-ran-${randomUUID()}`);
const filterMark = join(home, '.cache', `mino-filter-ran-${randomUUID()}`);
execFileSync('git', ['init', '-q'], { cwd: hooked });
writeFileSync(join(hooked, 'a.txt'), 'un\n');
execFileSync('git', ['add', '.'], { cwd: hooked });
execFileSync('git', ['-c', 'user.email=verify@mino.local', '-c', 'user.name=verify', 'commit', '-qm', 'init'], { cwd: hooked });
writeFileSync(join(hooked, '.git', 'monitor.sh'), `#!/bin/sh\ntouch '${monitorMark}'\nexit 1\n`);
chmodSync(join(hooked, '.git', 'monitor.sh'), 0o755);
execFileSync('git', ['config', 'core.fsmonitor', join(hooked, '.git', 'monitor.sh')], { cwd: hooked });
execFileSync('git', ['config', 'filter.probe.clean', `sh -c "touch '${filterMark}'; cat"`], { cwd: hooked });
writeFileSync(join(hooked, '.git', 'info', 'attributes'), '* filter=probe\n');
writeFileSync(join(hooked, 'a.txt'), 'uX\n');
execFileSync('git', ['--no-optional-locks', 'status', '--porcelain'], { cwd: hooked });
const hostRan = { fsmonitor: existsSync(monitorMark), filter: existsSync(filterMark) };
assert.ok(hostRan.fsmonitor && hostRan.filter, 'a plain git status on the host runs both repository programs');
rmSync(monitorMark, { force: true });
rmSync(filterMark, { force: true });
const seen = await observeProject(hooked, null, () => new Date().toISOString(), (argv, env) => probe.exec({ cwd: hooked, argv, env, sandbox: 'read-only', signal }));
const minoRan = { fsmonitor: existsSync(monitorMark), filter: existsSync(filterMark) };
rmSync(hooked, { recursive: true, force: true });
assert.equal(seen.error, null, JSON.stringify(seen));
assert.deepEqual(seen.status, [' M a.txt']);
assert.deepEqual(minoRan, { fsmonitor: false, filter: false }, 'Mino’s observation left nothing outside the sandbox');
step('observation de Mino sur un dépôt piégé : hook fsmonitor neutralisé, filtre git contenu par le bac à sable en lecture seule', { hostGitStatus: hostRan, minoObservation: minoRan, observed: seen.status });

const lateMark = join(project, 'late.txt');
const stopper = new AbortController();
const started = Date.now();
const pending = probe.exec({ cwd: project, argv: ['sh', '-c', `sleep 3; touch '${lateMark}'`], sandbox: 'workspace-write', signal: stopper.signal });
setTimeout(() => stopper.abort(), 500);
const cancelled = await pending;
const answeredMs = Date.now() - started;
await new Promise(r => setTimeout(r, 4000));
assert.equal(cancelled.kind, 'cancelled');
assert.equal(existsSync(lateMark), false, 'the terminated command did not finish its work');
step('arrêt d’une commande de contrôle en cours : Codex confirme, la commande ne termine pas son travail', { outcome: cancelled.kind, answeredMs, lateFileWritten: existsSync(lateMark) });
await probe.close();
assert.equal(inside.exitCode, 0);
assert.ok(existsSync(join(project, 'inside.txt')));
assert.notEqual(tmpWrite.exitCode, 0);
assert.notEqual(homeWrite.exitCode, 0);
assert.notEqual(network.exitCode, 0);
assert.ok(!existsSync(outsideTmp) && !existsSync(outsideHome), 'nothing written outside the project');
rmSync(join(project, 'inside.txt'));
step('bac à sable de l’exécutant, sans appel modèle : écriture dans le projet seulement, réseau coupé', {
  inside: inside.exitCode, tmp: [tmpWrite.exitCode, tmpWrite.output], home: [homeWrite.exitCode, homeWrite.output], network: [network.exitCode, network.output],
});

let server = startServer();
try {
  await server.ready;
  await session();

  const noCsrf = await http('POST', '/api/agents/commands', { body: '{}', headers: { 'content-type': 'application/json', origin: base } });
  assert.equal(noCsrf.status, 403);
  const refusedData = await send({ type: 'project.add', path: dataDir });
  const refusedHome = await send({ type: 'project.add', path: home });
  assert.equal(refusedData.ok, false);
  assert.equal(refusedHome.ok, false);
  step('refus sans jeton local, refus du dossier personnel et des données Mino, sans appel modèle', { csrf: noCsrf.status, data: refusedData.message, home: refusedHome.message });

  const added = await send({ type: 'project.add', path: project, name: 'calcul', checkCommand: 'node --test' });
  assert.ok(added.ok, added.message);
  const created = await send({ type: 'mission.create', projectId: added.id, goal: 'Le test de sum échoue. Corrige sum.js pour que sum additionne, puis lance node --test pour le vérifier.', model: null, effort: 'low' });
  assert.ok(created.ok, created.message);
  const done = await until(created.id, m => !['queued', 'running', 'stopping'].includes(m.status) && m.attempts[0]?.observed && m.attempts[0]?.check, 'première mission');
  const first = done.attempts[0];
  assert.equal(done.status, 'review', JSON.stringify(first));
  const onDisk = readFileSync(join(project, 'sum.js'), 'utf8');
  assert.match(onDisk, /a \+ b/);
  assert.equal(first.check.exitCode, 0);
  assert.ok(first.observed.status.some(line => line.endsWith('sum.js')));
  const ran = done.events.filter(e => e.kind === 'command').map(e => ({ command: e.data.command, exitCode: e.data.exitCode }));
  assert.ok(ran.some(r => /node --test/.test(r.command) && r.exitCode === 0), 'l’exécutant a lancé le test');
  step('vraie mission : fichier corrigé sur disque, test lancé par l’exécutant, contrôle Mino réussi', {
    model: first.model, effort: first.effort, threadId: first.threadId, sumJs: onDisk.trim(), observed: first.observed.status, check: first.check.exitCode, commands: ran, usage: first.usage,
  });

  server.child.kill('SIGTERM');
  await server.exited;
  server = startServer();
  await server.ready;
  await session();
  const reopened = await detail(created.id);
  assert.equal(reopened.status, 'review');
  assert.equal(reopened.threadId, first.threadId);
  assert.equal(reopened.attempts[0].check.exitCode, 0);
  const accepted = await send({ type: 'mission.accept', missionId: created.id, attemptId: reopened.can.accept });
  assert.ok(accepted.ok, accepted.message);
  step('après redémarrage : même session, mêmes preuves, résultat validé', { threadId: reopened.threadId, status: (await detail(created.id)).status });

  const slow = await send({ type: 'mission.create', projectId: added.id, goal: 'Crée le dossier notes. Pour n de 1 à 6, lance une commande séparée « sleep 4 && echo n > notes/n.txt ». Une commande par fichier, dans l’ordre.', model: null, effort: 'low' });
  assert.ok(slow.ok, slow.message);
  await until(slow.id, m => m.events.some(e => e.kind === 'command' && /sleep/.test(String(e.data.command))), 'début de la mission longue');
  server.child.kill('SIGKILL');
  const crash = await server.exited;
  const partial = existsSync(join(project, 'notes')) ? readdirSync(join(project, 'notes')).sort() : [];
  server = startServer();
  await server.ready;
  await session();
  const lost = await until(slow.id, m => m.attempts[0]?.observed, 'observation après arrêt brutal', 30_000);
  assert.equal(lost.status, 'interrupted');
  assert.equal(lost.can.resume, true);
  assert.equal(lost.can.continue, false);
  assert.equal(lost.attempts.length, 1, 'rien ne repart seul');
  step('arrêt brutal du serveur pendant le travail : résultat inconnu, fichiers partiels constatés, aucune relance automatique', {
    signal: crash.signal, filesOnDisk: partial, observed: lost.attempts[0].observed.status, message: lost.attempts[0].errorMessage,
  });

  const resumed = await send({ type: 'mission.resume', missionId: slow.id });
  assert.ok(resumed.ok, resumed.message);
  await until(slow.id, m => m.attempts[1]?.state === 'running' && m.attempts[1]?.turnId, 'reprise démarrée');
  const stop = await send({ type: 'mission.stop', missionId: slow.id });
  assert.ok(stop.ok, stop.message);
  const stopped = await until(slow.id, m => ['stopped', 'interrupted', 'review'].includes(m.status) && m.attempts[1]?.observed, 'arrêt de la reprise', 120_000);
  assert.equal(stopped.attempts[1].threadId, lost.attempts[0].threadId, 'la reprise rouvre la session Codex après le redémarrage');
  const atStop = readdirSync(join(project, 'notes')).sort();
  await new Promise(r => setTimeout(r, 9000));
  const later = readdirSync(join(project, 'notes')).sort();
  assert.equal(stopped.status, 'stopped', stopped.attempts[1].errorMessage);
  assert.deepEqual(later, atStop, 'nothing written after the confirmed stop');
  step('reprise explicite sur la même session Codex, puis arrêt demandé et confirmé, sans écriture après l’arrêt', {
    threadId: stopped.attempts[1].threadId, kind: stopped.attempts[1].kind, state: stopped.attempts[1].state, message: stopped.attempts[1].errorMessage, filesAtStop: atStop, filesNineSecondsLater: later,
  });

} finally {
  server.child.kill('SIGTERM');
  await server.exited;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
}
writeFileSync(new URL('../docs/evidence/agents-real.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
process.stdout.write('Preuve écrite dans docs/evidence/agents-real.json\n');
