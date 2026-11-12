import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAgentEngine, type AgentEngineOptions } from '../src/agent-engine.js';
import { createAgentRoutes } from '../src/agent-http.js';
import { createAgentWorker } from '../src/agent-worker.js';
import { openMissions, titleOf } from '../src/missions.js';
import { checkProjectPath, parseCheckCommand } from '../src/project-guard.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-agent-server.js', import.meta.url));

function gitRepo(path: string) {
  mkdirSync(path, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: path });
  writeFileSync(join(path, 'README.md'), 'site\n');
  execFileSync('git', ['add', '.'], { cwd: path });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: path });
}

function sandbox() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mino-missions-')));
  const home = join(base, 'home');
  const project = join(home, 'projets', 'site');
  const dataDir = join(base, 'mino', 'data');
  mkdirSync(dataDir, { recursive: true });
  gitRepo(project);
  return { base, home, project, dataDir, minoRoot: join(base, 'mino'), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const ended = (status: string) => !['queued', 'running', 'stopping'].includes(status);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function harness(scenario: string, box = sandbox(), dbName = 'missions.sqlite', requestTimeoutMs?: number, extra: Partial<AgentEngineOptions> = {}) {
  const missions = openMissions({ path: join(box.dataDir, dbName), minoRoot: box.minoRoot, dataDir: box.dataDir, home: box.home });
  const engine = createAgentEngine({ command: process.execPath, args: [fixture, scenario], tmpDir: join(box.dataDir, 'agent-tmp'), clientVersion: 'test', interruptGraceMs: 300, ...(requestTimeoutMs ? { requestTimeoutMs } : {}), ...extra });
  const worker = createAgentWorker({ missions, engine });
  let n = 0;
  const say = (command: Record<string, unknown>) => {
    const outcome = missions.dispatch({ requestId: `req-${scenario}-${++n}-xxxx`, ...command });
    worker.sync();
    return outcome;
  };
  const addProject = (checkCommand = '') => {
    const outcome = say({ type: 'project.add', path: box.project, checkCommand });
    assert.ok(outcome.ok, JSON.stringify(outcome));
    return outcome.id;
  };
  const settle = async (missionId: string, done: (status: string) => boolean) => {
    for (let i = 0; i < 400; i += 1) {
      const status = missions.detail(missionId)?.status ?? '';
      if (done(status)) {
        if (ended(status)) await worker.idle();
        return missions.detail(missionId);
      }
      await pause(10);
    }
    throw new Error(`mission bloquée: ${missions.detail(missionId)?.status}`);
  };
  const attemptIn = async (missionId: string, state: string) => {
    for (let i = 0; i < 400; i += 1) {
      const attempt = missions.detail(missionId)?.attempts.at(-1);
      if (attempt?.state === state) return missions.detail(missionId);
      await pause(10);
    }
    throw new Error(`essai jamais ${state}: ${missions.detail(missionId)?.attempts.at(-1)?.state}`);
  };
  const close = async () => { await worker.close(); await engine.close(); missions.close(); };
  return { box, missions, engine, worker, say, addProject, settle, attemptIn, close };
}

test('a project folder must be a real, precise, writable folder away from Mino, its data and private settings', () => {
  const box = sandbox();
  try {
    const guard = { minoRoot: box.minoRoot, dataDir: box.dataDir, home: box.home };
    assert.equal(checkProjectPath(box.project, guard).ok, true);
    assert.equal(checkProjectPath('projets/site', guard).ok, false, 'relative path refused');
    assert.equal(checkProjectPath(box.home, guard).ok, false, 'whole home refused');
    assert.equal(checkProjectPath(box.base, guard).ok, false, 'ancestor of home refused');
    assert.equal(checkProjectPath(box.minoRoot, guard).ok, false, 'Mino itself refused');
    mkdirSync(join(box.home, '.codex', 'x'), { recursive: true });
    assert.equal(checkProjectPath(join(box.home, '.codex', 'x'), guard).ok, false, 'Codex account folder refused');
    symlinkSync(box.project, join(box.home, 'lien'));
    assert.equal(checkProjectPath(join(box.home, 'lien'), guard).ok, false, 'symlink refused');
    assert.equal(checkProjectPath(join(box.home, 'absent'), guard).ok, false, 'missing folder refused');
    assert.deepEqual(parseCheckCommand('npm test'), { ok: true, argv: ['npm', 'test'] });
    assert.equal(parseCheckCommand('npm test && curl x').ok, false, 'no shell syntax');
    assert.equal(titleOf('Le test échoue. Corrige sum.js.'), 'Le test échoue.');
    assert.equal(titleOf('Ajoute une page de contact avec un formulaire accessible, une validation côté client et un message de confirmation'), 'Ajoute une page de contact avec un formulaire accessible, une…');
  } finally { box.cleanup(); }
});

test('a mission runs a real executor turn in the chosen folder, keeps its thread, events, observed change and check, then can be accepted', async () => {
  const h = harness('edit');
  try {
    const projectId = h.addProject('true');
    const created = h.say({ type: 'mission.create', projectId, goal: 'Écrire result.txt', model: null, effort: null });
    assert.ok(created.ok);
    const mission = await h.settle(created.id, s => s === 'review');
    assert.ok(mission);
    const [attempt] = mission.attempts;
    assert.equal(attempt?.state, 'completed');
    assert.equal(attempt?.threadId, 'thread-1');
    assert.equal(mission.threadId, 'thread-1');
    assert.equal(attempt?.model, 'fake-sol');
    assert.match(attempt?.finalText ?? '', /OBJECTIF_V1/);
    assert.deepEqual(attempt?.usage, { input: 150, cachedInput: 0, output: 20, reasoningOutput: 0, total: 170 }, 'usage summed over the turn');
    assert.ok(mission.events.some(e => e.kind === 'command' && e.data.exitCode === 0));
    assert.ok(mission.events.some(e => e.kind === 'file_change'));
    assert.equal(readFileSync(join(h.box.project, 'result.txt'), 'utf8').startsWith('fait'), true);
    assert.deepEqual(attempt?.observed?.changedDuringAttempt, ['?? result.txt'], 'Mino observes the new file itself');
    assert.equal(attempt?.check?.exitCode, 0);
    assert.equal(mission.can.accept, attempt?.id);
    const accepted = h.say({ type: 'mission.accept', missionId: created.id, attemptId: attempt?.id ?? '' });
    assert.ok(accepted.ok);
    assert.equal(h.missions.detail(created.id)?.status, 'accepted');
  } finally { await h.close(); h.box.cleanup(); }
});

test('a failed check blocks acceptance; a goal changed after the result keeps the old output but refuses it, and continuing resumes the same thread with the new version', async () => {
  const h = harness('edit');
  try {
    const projectId = h.addProject('false');
    const created = h.say({ type: 'mission.create', projectId, goal: 'Version un', model: null, effort: null });
    assert.ok(created.ok);
    let mission = await h.settle(created.id, s => s === 'review');
    const first = mission?.attempts[0];
    assert.equal(first?.check?.exitCode, 1);
    assert.equal(mission?.can.accept, null, 'failed check is not acceptable');
    assert.ok(h.say({ type: 'mission.revise', missionId: created.id, goal: 'Version deux', start: false }).ok);
    mission = h.missions.detail(created.id);
    assert.equal(mission?.status, 'outdated');
    assert.equal(mission?.goals.length, 2);
    const stale = h.say({ type: 'mission.accept', missionId: created.id, attemptId: first?.id ?? '' });
    assert.equal(stale.ok, false);
    assert.equal(!stale.ok && stale.code, 'stale');
    assert.ok(h.say({ type: 'mission.continue', missionId: created.id, note: 'garde le style' }).ok);
    mission = await h.settle(created.id, s => s === 'review');
    const second = mission?.attempts[1];
    assert.equal(second?.kind, 'continue');
    assert.equal(second?.goalRev, 2);
    assert.equal(second?.threadId, 'thread-1', 'same native session');
    assert.match(second?.finalText ?? '', /OBJECTIF_V2/);
    assert.match(mission?.attempts[0]?.finalText ?? '', /OBJECTIF_V1/, 'old output kept');
  } finally { await h.close(); h.box.cleanup(); }
});

test('stopping waits for Codex to confirm; a harness that never confirms leaves an unknown result, and resuming asks to inspect before acting', async () => {
  const confirmed = harness('hang');
  try {
    const projectId = confirmed.addProject();
    const created = confirmed.say({ type: 'mission.create', projectId, goal: 'Long travail', model: null, effort: null });
    assert.ok(created.ok);
    await confirmed.settle(created.id, s => s === 'running');
    for (let i = 0; i < 200 && !confirmed.missions.detail(created.id)?.events.some(e => e.kind === 'command_started'); i += 1) await new Promise(r => setTimeout(r, 10));
    assert.ok(confirmed.say({ type: 'mission.stop', missionId: created.id }).ok);
    assert.equal(confirmed.missions.detail(created.id)?.status, 'stopping', 'stop is asked, not yet confirmed');
    const stopped = await confirmed.settle(created.id, s => s === 'stopped');
    assert.match(stopped?.attempts[0]?.errorMessage ?? '', /confirmé par Codex/);
    assert.ok(stopped?.events.some(e => e.kind === 'command_started'));
  } finally { await confirmed.close(); confirmed.box.cleanup(); }

  const deaf = harness('deaf');
  try {
    const projectId = deaf.addProject();
    const created = deaf.say({ type: 'mission.create', projectId, goal: 'Long travail', model: null, effort: null });
    assert.ok(created.ok);
    await deaf.settle(created.id, s => s === 'running');
    for (let i = 0; i < 200 && !deaf.missions.detail(created.id)?.events.some(e => e.kind === 'command_started'); i += 1) await new Promise(r => setTimeout(r, 10));
    assert.ok(deaf.say({ type: 'mission.stop', missionId: created.id }).ok);
    const unknown = await deaf.settle(created.id, s => s === 'interrupted');
    assert.match(unknown?.attempts[0]?.errorMessage ?? '', /n’a pas confirmé/);
    assert.equal(unknown?.can.resume, true);
    assert.equal(unknown?.can.continue, false, 'no blind continue after an unknown result');
  } finally { await deaf.close(); deaf.box.cleanup(); }
});

test('a server stop mid-attempt survives restart as an unknown result, never restarts on its own, and the explicit resume reuses the session', async () => {
  const box = sandbox();
  const first = harness('exit-mid', box);
  const projectId = first.addProject();
  const created = first.say({ type: 'mission.create', projectId, goal: 'Travail', model: null, effort: null });
  assert.ok(created.ok);
  const lost = await first.settle(created.id, s => s === 'interrupted');
  assert.match(lost?.attempts[0]?.errorMessage ?? '', /inconnu/);
  await first.close();

  const second = harness('edit', box);
  try {
    assert.equal(second.missions.recoverInterrupted(), 0);
    const reopened = second.missions.detail(created.id);
    assert.equal(reopened?.status, 'interrupted');
    assert.equal(reopened?.threadId, 'thread-1');
    second.worker.kick();
    await second.worker.idle();
    assert.equal(second.missions.detail(created.id)?.attempts.length, 1, 'nothing restarted by itself');
    assert.ok(second.say({ type: 'mission.resume', missionId: created.id }).ok);
    const resumed = await second.settle(created.id, s => s === 'review');
    assert.equal(resumed?.attempts[1]?.kind, 'resume');
    assert.equal(resumed?.attempts[1]?.threadId, 'thread-1');
    assert.match(resumed?.attempts[1]?.finalText ?? '', /INSPECTION_DEMANDEE/, 'the resume prompt asks to inspect the folder first');
  } finally { await second.close(); box.cleanup(); }
});

test('a crash while the registry marks an attempt running is recovered as interrupted on the next open', () => {
  const box = sandbox();
  try {
    const one = openMissions({ path: join(box.dataDir, 'm.sqlite'), minoRoot: box.minoRoot, dataDir: box.dataDir, home: box.home });
    const p = one.dispatch({ type: 'project.add', requestId: 'req-crash-1', path: box.project });
    assert.ok(p.ok);
    const m = one.dispatch({ type: 'mission.create', requestId: 'req-crash-2', projectId: p.id, goal: 'X', model: null, effort: null });
    assert.ok(m.ok);
    assert.ok(one.claimNext());
    one.close();
    const two = openMissions({ path: join(box.dataDir, 'm.sqlite'), minoRoot: box.minoRoot, dataDir: box.dataDir, home: box.home });
    assert.equal(two.recoverInterrupted(), 1);
    assert.equal(two.detail(m.id)?.status, 'interrupted');
    assert.equal(two.claimNext(), null);
    two.close();
  } finally { box.cleanup(); }
});

test('budget, idempotent commands and a refused sandbox are enforced by the registry, not by the page', async () => {
  const h = harness('wide-sandbox');
  try {
    const projectId = h.addProject();
    const replay = h.missions.dispatch({ type: 'project.add', requestId: 'req-wide-sandbox-1-xxxx', path: h.box.project, checkCommand: '' });
    assert.ok(replay.ok && replay.replayed && replay.id === projectId, 'same request replays');
    const clash = h.missions.dispatch({ type: 'project.archive', requestId: 'req-wide-sandbox-1-xxxx', projectId });
    assert.equal(!clash.ok && clash.code, 'duplicate');
    const created = h.say({ type: 'mission.create', projectId, goal: 'Essai', model: null, effort: null });
    assert.ok(created.ok);
    const refused = await h.settle(created.id, s => s === 'failed');
    assert.equal(refused?.attempts[0]?.errorCode, 'sandbox_mismatch');
    assert.match(refused?.attempts[0]?.errorMessage ?? '', /Aucune action/);
    assert.equal(refused?.events.length, 0);
    assert.ok(h.say({ type: 'mission.resume', missionId: created.id }).ok);
    await h.settle(created.id, s => s === 'failed' && (h.missions.detail(created.id)?.attempts.length ?? 0) === 2);
    assert.ok(h.say({ type: 'mission.resume', missionId: created.id }).ok);
    await h.settle(created.id, s => s === 'failed' && (h.missions.detail(created.id)?.attempts.length ?? 0) === 3);
    const over = h.say({ type: 'mission.resume', missionId: created.id });
    assert.equal(!over.ok && over.code, 'budget');
    const revise = { type: 'mission.revise', requestId: 'req-revise-over-budget', missionId: created.id, goal: 'Essai, version deux', start: true };
    const refusedRevision = h.missions.dispatch(revise);
    assert.equal(!refusedRevision.ok && refusedRevision.code, 'budget');
    assert.doesNotMatch(!refusedRevision.ok ? refusedRevision.message : '', /enregistré/, 'a refusal never claims the goal was saved');
    assert.equal(h.missions.detail(created.id)?.goalRev, 1, 'the registry keeps the previous goal');
    assert.equal(h.missions.detail(created.id)?.goals.length, 1);
    assert.ok(h.say({ type: 'mission.budget', missionId: created.id }).ok);
    assert.equal(h.missions.detail(created.id)?.maxAttempts, 5);
    assert.equal(h.missions.detail(created.id)?.can.resume, true);
    const retried = h.missions.dispatch(revise);
    assert.ok(retried.ok && !retried.replayed, 'the refused request left nothing behind, so the same request now runs');
    assert.equal(h.missions.detail(created.id)?.goalRev, 2);
  } finally { await h.close(); h.box.cleanup(); }
});

test('approvals are declined and recorded, and a tool outside the allowed set stops the turn', async () => {
  const asked = harness('approval');
  try {
    const projectId = asked.addProject();
    const created = asked.say({ type: 'mission.create', projectId, goal: 'Réseau', model: null, effort: null });
    assert.ok(created.ok);
    const done = await asked.settle(created.id, s => s === 'review');
    const declined = done?.events.find(e => e.kind === 'approval_declined');
    assert.equal(declined?.data.method, 'item/commandExecution/requestApproval');
    assert.equal(declined?.data.command, 'curl https://example.com');
  } finally { await asked.close(); asked.box.cleanup(); }

  const tool = harness('mcp');
  try {
    const projectId = tool.addProject();
    const created = tool.say({ type: 'mission.create', projectId, goal: 'Outil', model: null, effort: null });
    assert.ok(created.ok);
    const blocked = await tool.settle(created.id, s => s === 'failed' || s === 'stopped' || s === 'interrupted');
    assert.ok(blocked?.events.some(e => e.kind === 'blocked_tool' && e.data.type === 'mcpToolCall'));
    assert.notEqual(blocked?.status, 'review');
  } finally { await tool.close(); tool.box.cleanup(); }
});

test('a paired device can follow and steer missions but cannot hand a folder to Mino', async () => {
  const h = harness('edit');
  const routes = createAgentRoutes({ missions: h.missions, worker: h.worker, engine: h.engine, longPollMs: 50 });
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const scope = url.pathname.startsWith('/m/') ? 'device' : 'pc';
    void routes.handle(req, res, url, scope).then(handled => { if (!handled) { res.writeHead(404); res.end(); } });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const phoneAdd = await post('/m/agents/commands', { type: 'project.add', requestId: 'req-phone-add', path: h.box.project });
    assert.equal(phoneAdd.status, 403);
    const pcAdd = await post('/api/agents/commands', { type: 'project.add', requestId: 'req-pc-add-1', path: h.box.project });
    const added = await pcAdd.json() as { ok: boolean; id: string };
    assert.ok(added.ok);
    const phoneMission = await post('/m/agents/commands', { type: 'mission.create', requestId: 'req-phone-msn', projectId: added.id, goal: 'Depuis le téléphone', model: null, effort: null });
    const createdMission = await phoneMission.json() as { ok: boolean; id: string; view: { missions: unknown[] } };
    assert.ok(createdMission.ok);
    await h.settle(createdMission.id, s => s === 'review');
    const detail = await (await fetch(`${base}/m/agents/missions/${createdMission.id}`)).json() as { mission: { status: string }; project: { name: string } };
    assert.equal(detail.mission.status, 'review');
    assert.equal(detail.project.name, 'site');
    const invalid = await post('/m/agents/commands', { type: 'shell', command: 'rm -rf /' });
    assert.equal(invalid.status, 422);
  } finally {
    server.close();
    await h.close();
    h.box.cleanup();
  }
});

test('observing a repository never runs the fsmonitor program its settings name', async () => {
  const h = harness('edit');
  try {
    const marker = join(h.box.base, 'hook-ran-outside-the-project');
    const hook = join(h.box.project, '.git', 'benign-hook.sh');
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(hook, 0o755);
    execFileSync('git', ['config', 'core.fsmonitor', hook], { cwd: h.box.project });
    const projectId = h.addProject();
    const created = h.say({ type: 'mission.create', projectId, goal: 'Écrire result.txt', model: null, effort: null });
    assert.ok(created.ok);
    const mission = await h.settle(created.id, s => s === 'review');
    assert.deepEqual(mission?.attempts[0]?.observed?.changedDuringAttempt, ['?? result.txt'], 'the observation still works');
    assert.equal(existsSync(marker), false, 'the hook did not run');
  } finally { await h.close(); h.box.cleanup(); }
});

test('late turn notifications cannot release an ambiguous run before its connection has closed', async () => {
  const h = harness('turn-late-close', sandbox(), 'missions.sqlite', 300);
  try {
    const run = h.engine.run({
      cwd: h.box.project, sandbox: 'workspace-write', threadId: null, model: null, effort: null,
      developerInstructions: '', input: 'Travail', signal: new AbortController().signal,
      onThread() {}, onTurn() {}, onEvent() {}, onActivity() {}, onUsage() {},
    });
    for (let i = 0; i < 400 && !existsSync(join(h.box.project, 'connection-closing.txt')); i += 1) await pause(5);
    assert.equal(existsSync(join(h.box.project, 'connection-closing.txt')), true, 'the fake server entered delayed shutdown');
    const catalog = h.engine.catalog().then(result => {
      assert.equal(existsSync(join(h.box.project, 'old-connection-closed.txt')), true, 'catalog waits for the closing connection too');
      assert.equal(result.ok, true);
    });
    const outcome = await run;
    assert.equal(existsSync(join(h.box.project, 'old-connection-closed.txt')), true, `the old process exited before run resolved: ${JSON.stringify(outcome)}`);
    assert.equal(outcome.kind, 'interrupted', 'late completion cannot turn an unknown result into success');
    await catalog;
    const check = await h.engine.exec({ cwd: h.box.project, argv: ['true'], sandbox: 'read-only', signal: new AbortController().signal });
    assert.equal(check.kind, 'exited', 'the next command uses a fresh connection');
    assert.equal(existsSync(join(h.box.project, 'request-during-close.txt')), false, 'no command reused the closing connection');
  } finally { await h.close(); h.box.cleanup(); }
});

for (const scenario of ['turn-silent', 'turn-garbled']) {
  test(`a turn/start without a readable acknowledgement (${scenario}) is an unknown result, and the executor process ends before the queue moves on`, async () => {
    const h = harness(scenario, sandbox(), 'missions.sqlite', 300);
    try {
      const projectId = h.addProject();
      const created = h.say({ type: 'mission.create', projectId, goal: 'Travail', model: null, effort: null });
      assert.ok(created.ok);
      const mission = await h.settle(created.id, ended);
      const attempt = mission?.attempts[0];
      assert.equal(mission?.status, 'interrupted');
      assert.equal(attempt?.errorCode, 'unknown_result');
      assert.doesNotMatch(attempt?.errorMessage ?? '', /Aucune action/);
      assert.ok(existsSync(join(h.box.project, 'effect.txt')), 'the unacknowledged turn did act');
      assert.ok(attempt?.observed, 'Mino observed the folder');
      assert.equal(mission?.can.resume, true);
      assert.equal(mission?.can.continue, false);
      assert.match(attempt?.errorMessage ?? '', /relevés sous Codex sont arrêtés/, 'the tools under Codex were listed before closing it');
      await pause(1700);
      assert.equal(existsSync(join(h.box.project, 'alive-after.txt')), false, 'the executor process was ended');
      assert.equal(existsSync(join(h.box.project, 'tool-after.txt')), false, 'the tool the turn started was ended too');
    } finally { await h.close(); h.box.cleanup(); }
  });
}

test('the check is part of the attempt: Mino observes after it, and only then is the result available', async () => {
  const h = harness('edit');
  try {
    const projectId = h.addProject('make-report');
    const created = h.say({ type: 'mission.create', projectId, goal: 'Écrire result.txt', model: null, effort: null });
    assert.ok(created.ok);
    const mission = await h.settle(created.id, s => s === 'review');
    const attempt = mission?.attempts[0];
    assert.equal(attempt?.check?.exitCode, 0);
    assert.ok(attempt?.observed?.status.includes('?? report.txt'), 'what the check wrote is in the observation');
    assert.equal(mission?.can.accept, attempt?.id);
  } finally { await h.close(); h.box.cleanup(); }
});

test('a running check can be stopped and the stop is confirmed; an unconfirmed stop is an unknown result; closing Mino does not wait for it', async () => {
  const h = harness('edit');
  try {
    const projectId = h.addProject('slow');
    const created = h.say({ type: 'mission.create', projectId, goal: 'Écrire result.txt', model: null, effort: null });
    assert.ok(created.ok);
    const checking = await h.attemptIn(created.id, 'verifying');
    assert.equal(checking?.status, 'running', 'the mission is still at work while Mino checks');
    assert.equal(checking?.can.stop, true);
    assert.equal(checking?.can.accept, null, 'nothing to accept before the check ends');
    assert.match(checking?.attempts[0]?.finalText ?? '', /OBJECTIF_V1/, 'the executor report is kept');
    assert.ok(h.say({ type: 'mission.stop', missionId: created.id }).ok);
    const stopped = await h.settle(created.id, s => s === 'stopped');
    const attempt = stopped?.attempts[0];
    assert.match(attempt?.errorMessage ?? '', /pendant le contrôle/);
    assert.equal(attempt?.check?.error, 'Contrôle arrêté avant sa fin.');
    assert.ok(attempt?.observed, 'observed after the check ended');
    assert.equal(stopped?.can.accept, null);
    assert.equal(stopped?.can.resume, true);
    await pause(1300);
    assert.equal(existsSync(join(h.box.project, 'late-check.txt')), false, 'the stopped check did not finish its work');
  } finally { await h.close(); h.box.cleanup(); }

  const deaf = harness('deaf-check');
  try {
    const projectId = deaf.addProject('slow');
    const created = deaf.say({ type: 'mission.create', projectId, goal: 'Écrire result.txt', model: null, effort: null });
    assert.ok(created.ok);
    await deaf.attemptIn(created.id, 'verifying');
    assert.ok(deaf.say({ type: 'mission.stop', missionId: created.id }).ok);
    const unknown = await deaf.settle(created.id, s => s === 'interrupted');
    assert.equal(unknown?.attempts[0]?.errorCode, 'unknown_result');
    assert.match(unknown?.attempts[0]?.errorMessage ?? '', /n’a pas confirmé/);
  } finally { await deaf.close(); deaf.box.cleanup(); }

  const closing = harness('deaf-check');
  try {
    const projectId = closing.addProject('slow');
    const created = closing.say({ type: 'mission.create', projectId, goal: 'Écrire result.txt', model: null, effort: null });
    assert.ok(created.ok);
    await closing.attemptIn(created.id, 'verifying');
    const started = Date.now();
    await closing.worker.close();
    assert.ok(Date.now() - started < 3000, `close waited ${Date.now() - started} ms`);
  } finally { await closing.close(); closing.box.cleanup(); }
});

test('a crash during the check leaves an unknown result that never restarts on its own', () => {
  const box = sandbox();
  try {
    const one = openMissions({ path: join(box.dataDir, 'm.sqlite'), minoRoot: box.minoRoot, dataDir: box.dataDir, home: box.home });
    const p = one.dispatch({ type: 'project.add', requestId: 'req-crash-check-1', path: box.project, checkCommand: 'npm test' });
    assert.ok(p.ok);
    const m = one.dispatch({ type: 'mission.create', requestId: 'req-crash-check-2', projectId: p.id, goal: 'X', model: null, effort: null });
    assert.ok(m.ok);
    const claim = one.claimNext();
    assert.ok(claim);
    assert.equal(one.finish(claim, { kind: 'completed', finalText: 'fait', threadId: 't', turnId: 'u' }), 'verifying');
    one.close();
    const two = openMissions({ path: join(box.dataDir, 'm.sqlite'), minoRoot: box.minoRoot, dataDir: box.dataDir, home: box.home });
    assert.equal(two.recoverInterrupted(), 1);
    const after = two.detail(m.id);
    assert.equal(after?.status, 'interrupted');
    assert.equal(after?.can.accept, null);
    assert.equal(two.claimNext(), null, 'nothing restarts');
    two.close();
  } finally { box.cleanup(); }
});

test('acceptance is held to the check the attempt ran under: a pass under check A does not validate check B, and removing a failed check does not validate', async () => {
  const h = harness('edit');
  try {
    const projectId = h.addProject('true');
    const first = h.say({ type: 'mission.create', projectId, goal: 'Version un', model: null, effort: null });
    assert.ok(first.ok);
    const passed = await h.settle(first.id, s => s === 'review');
    assert.equal(passed?.can.accept, passed?.attempts[0]?.id);
    assert.ok(h.say({ type: 'project.update', projectId, checkCommand: 'false' }).ok);
    const changed = h.missions.detail(first.id);
    assert.equal(changed?.can.accept, null, 'proof under A does not validate B');
    assert.match(changed?.acceptBlocked ?? '', /contrôle du projet a changé/);
    const refused = h.say({ type: 'mission.accept', missionId: first.id, attemptId: passed?.attempts[0]?.id ?? '' });
    assert.equal(!refused.ok && refused.code, 'stale');

    const second = h.say({ type: 'mission.create', projectId, goal: 'Version un', model: null, effort: null });
    assert.ok(second.ok);
    const failedCheck = await h.settle(second.id, s => s === 'review');
    assert.equal(failedCheck?.attempts[0]?.check?.exitCode, 1);
    assert.deepEqual(failedCheck?.attempts[0]?.checkCommand, ['false']);
    assert.ok(h.say({ type: 'project.update', projectId, checkCommand: '' }).ok);
    const removed = h.missions.detail(second.id);
    assert.equal(removed?.can.accept, null, 'removing the check does not validate a failed one');
    const stillRefused = h.say({ type: 'mission.accept', missionId: second.id, attemptId: failedCheck?.attempts[0]?.id ?? '' });
    assert.equal(!stillRefused.ok && stillRefused.code, 'stale');
    assert.ok(h.say({ type: 'project.update', projectId, checkCommand: '' }).ok, 'saving the same setting again');
    assert.ok(h.say({ type: 'mission.continue', missionId: second.id, note: '' }).ok);
    const next = await h.settle(second.id, s => s === 'review' && (h.missions.detail(second.id)?.attempts.length ?? 0) === 2);
    assert.equal(next?.attempts[1]?.checkCommand, null);
    assert.equal(next?.can.accept, next?.attempts[1]?.id, 'a new attempt under the current setting can be accepted');
  } finally { await h.close(); h.box.cleanup(); }
});

test('a queued attempt whose folder became invalid fails visibly and the queue goes on with the next mission', async () => {
  const h = harness('edit');
  try {
    const other = join(h.box.home, 'projets', 'autre');
    gitRepo(other);
    const a = h.missions.dispatch({ type: 'project.add', requestId: 'req-queue-a', path: h.box.project });
    const b = h.missions.dispatch({ type: 'project.add', requestId: 'req-queue-b', path: other });
    assert.ok(a.ok && b.ok);
    const first = h.missions.dispatch({ type: 'mission.create', requestId: 'req-queue-1', projectId: a.id, goal: 'Dans site', model: null, effort: null });
    const second = h.missions.dispatch({ type: 'mission.create', requestId: 'req-queue-2', projectId: b.id, goal: 'Dans autre', model: null, effort: null });
    assert.ok(first.ok && second.ok);
    renameSync(h.box.project, `${h.box.project}-deplace`);
    let notified = 0;
    h.missions.onChange(() => { notified += 1; });
    h.worker.kick();
    const done = await h.settle(second.id, s => s === 'review');
    assert.equal(done?.attempts[0]?.state, 'completed');
    const refused = h.missions.detail(first.id);
    assert.equal(refused?.status, 'failed');
    assert.equal(refused?.attempts[0]?.errorCode, 'path_refused');
    assert.ok(notified > 0);
  } finally { await h.close(); h.box.cleanup(); }
});

for (const command of ['hold', 'hold-pipe']) test(`an unanswered command (${command}) ends its observed processes before the next command`, async () => {
  const h = harness('edit', sandbox(), 'missions.sqlite', 300);
  try {
    const lost = await h.engine.exec({ cwd: h.box.project, argv: [command], sandbox: 'workspace-write', signal: new AbortController().signal, timeoutMs: 100 });
    assert.equal(lost.kind, 'unknown');
    assert.match(lost.kind === 'unknown' ? lost.message : '', /relevés sous Codex sont arrêtés/);
    const next = await h.engine.exec({ cwd: h.box.project, argv: ['true'], sandbox: 'read-only', signal: new AbortController().signal });
    assert.equal(next.kind, 'exited', 'the next command runs on a fresh connection');
    await pause(1300);
    assert.equal(existsSync(join(h.box.project, 'late-hold.txt')), false, 'the unanswered command did not finish its work');
  } finally { await h.close(); h.box.cleanup(); }
});

test('without a readable process listing, a check Codex answered after the stop is an unknown result, not a confirmed stop', async () => {
  const h = harness('edit', sandbox(), 'missions.sqlite', undefined, { procRoot: join(tmpdir(), `mino-no-proc-${process.pid}-${Date.now()}`) });
  try {
    const projectId = h.addProject('slow');
    const created = h.say({ type: 'mission.create', projectId, goal: 'Écrire result.txt', model: null, effort: null });
    assert.ok(created.ok);
    await h.attemptIn(created.id, 'verifying');
    assert.ok(h.say({ type: 'mission.stop', missionId: created.id }).ok);
    const mission = await h.settle(created.id, ended);
    assert.equal(mission?.status, 'interrupted');
    assert.equal(mission?.attempts[0]?.errorCode, 'unknown_result');
    assert.match(mission?.attempts[0]?.errorMessage ?? '', /n’a pas pu lire la liste des processus/);
    assert.match(mission?.attempts[0]?.errorMessage ?? '', /n’a pas pu vérifier que les outils/);
  } finally { await h.close(); h.box.cleanup(); }
});

for (const stage of ['initial', 'final']) test(`an unknown stop of the ${stage} observation stays unknown after the next observation succeeds`, async () => {
  const h = harness(stage === 'initial' ? 'slow-initial-observe' : 'slow-observe', sandbox(), 'missions.sqlite', undefined, { procRoot: join(tmpdir(), `mino-no-proc-${stage}-${process.pid}-${Date.now()}`) });
  try {
    const projectId = h.addProject('true');
    const created = h.say({ type: 'mission.create', projectId, goal: 'Écrire result.txt', model: null, effort: null });
    assert.ok(created.ok);
    const held = join(h.box.dataDir, 'agent-tmp', 'observing.txt');
    for (let i = 0; i < 400 && !existsSync(held); i += 1) await pause(10);
    assert.ok(existsSync(held));
    assert.ok(h.say({ type: 'mission.stop', missionId: created.id }).ok);
    const result = await h.settle(created.id, ended);
    assert.equal(result?.status, 'interrupted');
    assert.equal(result?.attempts[0]?.state, 'interrupted');
    assert.equal(result?.attempts[0]?.errorCode, 'unknown_result');
    assert.match(result?.attempts[0]?.errorMessage ?? '', /n’a pas pu vérifier que les outils/);
    assert.equal(result?.can.accept, null);
    assert.equal(result?.attempts[0]?.observed?.error, null, 'a later successful observation does not confirm the earlier stop');
    if (stage === 'initial') {
      assert.equal(result?.threadId, null, 'no executor started after the initial observation became unknown');
      assert.equal(existsSync(join(h.box.project, 'result.txt')), false);
    }
  } finally { await h.close(); h.box.cleanup(); }
});

test('a process Mino saw and could not confirm ended keeps Codex from starting again until it is gone', async () => {
  const procDir = realpathSync(mkdtempSync(join(tmpdir(), 'mino-fake-proc-')));
  const h = harness(`immortal@${procDir}`, sandbox(), 'missions.sqlite', 300, { procRoot: procDir });
  try {
    const lost = await h.engine.exec({ cwd: h.box.project, argv: ['hold'], sandbox: 'workspace-write', signal: new AbortController().signal, timeoutMs: 100 });
    assert.equal(lost.kind, 'unknown');
    assert.match(lost.kind === 'unknown' ? lost.message : '', /tournent encore/);
    const refused = await h.engine.exec({ cwd: h.box.project, argv: ['true'], sandbox: 'read-only', signal: new AbortController().signal });
    assert.equal(refused.kind, 'refused', 'no new Codex while a seen tool still runs');
    assert.match(refused.kind === 'refused' ? refused.message : '', /ne relance pas Codex/);
    assert.equal(h.engine.status().state, 'unavailable');
    rmSync(join(procDir, '4194999'), { recursive: true });
    const again = await h.engine.exec({ cwd: h.box.project, argv: ['true'], sandbox: 'read-only', signal: new AbortController().signal });
    assert.equal(again.kind, 'exited', 'once it is gone, Codex starts again');
    rmSync(join(procDir, '4194999'), { recursive: true, force: true });
  } finally { await h.close(); h.box.cleanup(); rmSync(procDir, { recursive: true, force: true }); }
});

test('a stop during the observation after the check cuts it; Mino observes again once the attempt is stopped', async () => {
  const h = harness('slow-observe');
  const held = join(h.box.dataDir, 'agent-tmp', 'observing.txt');
  try {
    const projectId = h.addProject('true');
    const created = h.say({ type: 'mission.create', projectId, goal: 'Écrire result.txt', model: null, effort: null });
    assert.ok(created.ok);
    for (let i = 0; i < 400 && !existsSync(held); i += 1) await pause(10);
    assert.ok(existsSync(held), 'the observation after the check is waiting on git');
    const started = Date.now();
    assert.ok(h.say({ type: 'mission.stop', missionId: created.id }).ok);
    const stopped = await h.settle(created.id, s => s === 'stopped');
    assert.ok(Date.now() - started < 2000, `the stop waited ${Date.now() - started} ms for the observation`);
    assert.equal(stopped?.attempts[0]?.check?.exitCode, 0);
    let observed = stopped?.attempts[0]?.observed ?? null;
    for (let i = 0; i < 400 && observed?.error; i += 1) { await pause(10); observed = h.missions.detail(created.id)?.attempts[0]?.observed ?? null; }
    assert.equal(observed?.error, null, 'the later observation completed');
    assert.ok(observed?.status.includes('?? result.txt'), 'the later observation shows the change');
  } finally { await h.close(); h.box.cleanup(); }

  const closing = harness('slow-observe');
  try {
    const projectId = closing.addProject('true');
    const created = closing.say({ type: 'mission.create', projectId, goal: 'Écrire result.txt', model: null, effort: null });
    assert.ok(created.ok);
    const held2 = join(closing.box.dataDir, 'agent-tmp', 'observing.txt');
    for (let i = 0; i < 400 && !existsSync(held2); i += 1) await pause(10);
    const started = Date.now();
    await closing.worker.close();
    assert.ok(Date.now() - started < 3000, `close waited ${Date.now() - started} ms for the observation`);
  } finally { await closing.close(); closing.box.cleanup(); }
});

for (const route of ['commands', 'catalog']) test(`device revocation during pending ${route} is checked at the final boundary`, async () => {
  const h = harness('edit');
  const projectId = h.addProject();
  let revoked = false;
  let signalReady: () => void = () => {};
  const ready = new Promise<void>(r => { signalReady = r; });
  let releaseCatalog: () => void = () => {};
  const catalog = new Promise<void>(r => { releaseCatalog = r; });
  const routes = createAgentRoutes({ missions: h.missions, worker: h.worker, engine: { ...h.engine, catalog: async () => { await catalog; return { ok: true, models: [] }; } } });
  const server = createServer((req, res) => {
    signalReady();
    void routes.handle(req, res, new URL(req.url ?? '/', 'http://test'), 'device', () => {
      if (revoked) throw new Error('revoked');
    }).catch(() => { res.writeHead(403); res.end(); });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const response = new Promise<number>(resolve => {
    const req = request({ hostname: '127.0.0.1', port: address.port, path: `/m/agents/${route}`, method: route === 'commands' ? 'POST' : 'GET', headers: { 'content-type': 'application/json' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    req.flushHeaders();
    void ready.then(() => {
      revoked = true;
      releaseCatalog();
      req.end(route === 'commands' ? JSON.stringify({ type: 'mission.create', requestId: 'revoked-command-0001', projectId, goal: 'Ne doit pas partir', model: null, effort: null }) : undefined);
    });
  });
  try {
    assert.equal(await response, 403);
    assert.equal(h.missions.view().missions.length, 0);
  } finally {
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    await h.close(); h.box.cleanup();
  }
});
