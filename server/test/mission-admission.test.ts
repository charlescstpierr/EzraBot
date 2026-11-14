import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_POLICY } from '../src/admission.js';
import type { AdmissionPolicy } from '../src/admission-protocol.js';
import { createAgentEngine } from '../src/agent-engine.js';
import type { ObservedView } from '../src/agent-protocol.js';
import { createAgentWorker } from '../src/agent-worker.js';
import { loadMascots } from '../src/domain.js';
import { openMissions, type AttemptClaim, type Missions } from '../src/missions.js';
import { openStore, type Store } from '../src/store.js';

const mascots = loadMascots(new URL('../../assets/mascots.json', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/fake-agent-server.js', import.meta.url));
const rid = () => randomUUID();
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const CODEX_ONLY = (callsPerDay: number): AdmissionPolicy => ({ ...DEFAULT_POLICY, budgets: { ...DEFAULT_POLICY.budgets, codex: { callsPerDay } } });
const OBSERVED: ObservedView = { git: true, head: null, status: [], diffStat: '', at: '2026-11-14T00:00:00.000Z', error: null, changedDuringAttempt: [] };

function sandbox() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mino-mission-admission-')));
  const home = join(base, 'home');
  const project = join(home, 'projets', 'site');
  const dataDir = join(base, 'mino', 'data');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: project });
  writeFileSync(join(project, 'README.md'), 'site\n');
  execFileSync('git', ['add', '.'], { cwd: project });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: project });
  return { base, home, project, dataDir, minoRoot: join(base, 'mino'), chatDb: join(dataDir, 'mino.sqlite'), missionsDb: join(dataDir, 'missions.sqlite') };
}
type Box = ReturnType<typeof sandbox>;

/** Both registries of one data folder, as `main.ts` opens them: the chat store first, the missions on its admission. */
function registries(box: Box, policy: AdmissionPolicy = DEFAULT_POLICY) {
  const store = openStore({ path: box.chatDb, mascots, policy });
  store.recoverInterrupted();
  const missions = openMissions({ path: box.missionsDb, minoRoot: box.minoRoot, dataDir: box.dataDir, home: box.home, admission: store.admission });
  missions.recoverInterrupted();
  return { store, missions, close() { missions.close(); store.close(); } };
}

function created(missions: Missions, box: Box): string {
  const project = missions.dispatch({ type: 'project.add', requestId: rid(), path: box.project, checkCommand: '' });
  assert.equal(project.ok, true, JSON.stringify(project));
  const mission = missions.dispatch({ type: 'mission.create', requestId: rid(), projectId: project.ok ? project.id : '', goal: 'Ajoute une page contact.', model: null, effort: null });
  assert.equal(mission.ok, true, JSON.stringify(mission));
  return mission.ok ? mission.id : '';
}
const claimed = (missions: Missions): AttemptClaim => {
  const claim = missions.claimNext();
  assert(claim, 'a queued attempt is claimable');
  return claim;
};
const lastAttempt = (missions: Missions, missionId: string) => {
  const attempt = missions.detail(missionId)?.attempts.at(-1);
  assert(attempt);
  return attempt;
};
const codexCalls = (store: Store) => store.admission.usage().find(entry => entry.budget === 'codex')?.calls;
const reservations = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare('SELECT capability, target_id, target_revision, source_kind, state FROM reservations ORDER BY rowid').all().map(row => ({ ...row }));
  } finally {
    db.close();
  }
};

/** The real agent worker and engine over the fake App Server, with every request it receives written to a file. */
function realWorker(box: Box, missions: Missions) {
  const probe = join(box.dataDir, 'rpc.log');
  process.env.MINO_TEST_RPC_PROBE = probe;
  const engine = createAgentEngine({ command: process.execPath, args: [fixture, 'edit'], tmpDir: join(box.dataDir, 'agent-tmp'), clientVersion: 'test', interruptGraceMs: 300 });
  const worker = createAgentWorker({ missions, engine });
  return {
    worker,
    received: (method: string) => (existsSync(probe) ? readFileSync(probe, 'utf8').split('\n').filter(line => line === method).length : 0),
    async ended(missionId: string) {
      for (let i = 0; i < 600; i += 1) {
        if (!['queued', 'running', 'verifying', 'stopping'].includes(lastAttempt(missions, missionId).state)) break;
        await pause(10);
      }
      await worker.idle();
      return lastAttempt(missions, missionId);
    },
    async close() {
      await worker.close();
      await engine.close();
      delete process.env.MINO_TEST_RPC_PROBE;
    },
  };
}

test('a mission turn and a chat call share one ceiling: the mission uses the last call, the chat is refused', async () => {
  const box = sandbox();
  const { store, missions, close } = registries(box, CODEX_ONLY(1));
  const real = realWorker(box, missions);
  try {
    const missionId = created(missions, box);
    real.worker.kick();
    const attempt = await real.ended(missionId);
    assert.equal(attempt.state, 'completed');
    assert.equal(real.received('turn/start'), 1);
    assert.equal(codexCalls(store), 1);

    assert.equal(store.dispatch({ type: 'message.send', requestId: rid(), botId: 'nova', text: 'Bonjour', attachments: [] }).ok, true);
    assert.equal(store.claimNext('chat'), null);
    assert.match(store.view().works[0]?.attempt?.error ?? '', /Plafond d’appels du jour atteint pour « codex » : 1 sur 1/);
  } finally {
    await real.close();
    close();
    rmSync(box.base, { recursive: true, force: true });
  }
});

test('when the chat used the last call, the mission attempt fails before its start and Codex receives no turn', async () => {
  const box = sandbox();
  const { store, missions, close } = registries(box, CODEX_ONLY(1));
  const real = realWorker(box, missions);
  try {
    assert.equal(store.dispatch({ type: 'message.send', requestId: rid(), botId: 'nova', text: 'Bonjour', attachments: [] }).ok, true);
    const chat = store.claimNext('chat');
    assert(chat);
    const missionId = created(missions, box);
    real.worker.kick();
    const attempt = await real.ended(missionId);
    assert.equal(attempt.state, 'failed');
    assert.match(attempt.errorMessage ?? '', /Tentative non démarrée : Plafond d’appels du jour atteint pour « codex » : 1 sur 1\. Aucun appel n’est parti/);
    assert.equal(attempt.startedAt, null);
    assert.equal(real.received('thread/start') + real.received('turn/start'), 0);
    assert.equal(codexCalls(store), 1, 'only the chat call holds a slot');
  } finally {
    await real.close();
    close();
    rmSync(box.base, { recursive: true, force: true });
  }
});

test('a goal revised between the claim and the departure stops the mission turn on the old goal', async () => {
  const box = sandbox();
  const { store, missions, close } = registries(box);
  const real = realWorker(box, missions);
  try {
    const missionId = created(missions, box);
    real.worker.kick();
    assert.equal(lastAttempt(missions, missionId).state, 'running', 'claimed and reserved, Codex is still starting');
    assert.equal(missions.dispatch({ type: 'mission.revise', requestId: rid(), missionId, goal: 'Plutôt une page tarifs.', start: false }).ok, true);
    const attempt = await real.ended(missionId);
    assert.equal(attempt.state, 'failed');
    assert.match(attempt.errorMessage ?? '', /L’objectif a changé entre la réservation et le départ.*Aucune action n’a été lancée/);
    assert.equal(real.received('thread/start'), 1, 'the engine went as far as the last point before the turn');
    assert.equal(real.received('turn/start'), 0);
    assert.equal(codexCalls(store), 0, 'the unused permit freed its slot');
  } finally {
    await real.close();
    close();
  }
  assert.deepEqual(reservations(box.chatDb).map(row => [row.capability, row.target_revision, row.source_kind, row.state]), [['codex.mission', '1', 'human', 'released']]);
  rmSync(box.base, { recursive: true, force: true });
});

test('a stop asked before the departure refuses the permit, and a permit is given once', () => {
  const box = sandbox();
  const { store, missions, close } = registries(box);
  try {
    const stopped = created(missions, box);
    const first = claimed(missions);
    assert.equal(missions.dispatch({ type: 'mission.stop', requestId: rid(), missionId: stopped }).ok, true);
    const refused = missions.depart(first);
    assert.match(refused.ok ? '' : refused.reason, /arrêtée avant son départ/);
    assert.equal(missions.finish(first, { kind: 'stopped', threadId: null, turnId: null }), 'stopped');
    assert.equal(codexCalls(store), 0);

    assert.equal(missions.dispatch({ type: 'mission.resume', requestId: rid(), missionId: stopped }).ok, true);
    const second = claimed(missions);
    assert.deepEqual(missions.depart(second), { ok: true });
    const twice = missions.depart(second);
    assert.match(twice.ok ? '' : twice.reason, /Le permis de cet appel a déjà servi/);
    assert.equal(missions.finish(second, { kind: 'interrupted', message: 'Codex n’a pas confirmé la fin.' }), 'interrupted');
    assert.equal(codexCalls(store), 1, 'an unknown result keeps its slot');
  } finally {
    close();
  }
  assert.deepEqual(reservations(box.chatDb).map(row => row.state), ['released', 'unknown']);
  rmSync(box.base, { recursive: true, force: true });
});

test('after a crash between the two databases, a turn that never left is released and a turn that may have left stays unknown', () => {
  const box = sandbox();
  let open = registries(box, CODEX_ONLY(3));
  const missionId = created(open.missions, box);
  const queued = lastAttempt(open.missions, missionId);
  assert.equal(open.store.admission.reserve({ capability: 'codex.mission', source: { kind: 'human', id: missionId }, target: { kind: 'mission', id: queued.id, revision: '1' } }).ok, true);
  open.close();

  open = registries(box, CODEX_ONLY(3));
  assert.equal(codexCalls(open.store), 0, 'reserved in the chat store, never linked: released');
  assert.equal(lastAttempt(open.missions, missionId).state, 'queued');
  const linked = claimed(open.missions);
  assert.equal(linked.attemptId, queued.id, 'the same attempt is reserved again and starts');
  open.close();

  open = registries(box, CODEX_ONLY(3));
  assert.equal(lastAttempt(open.missions, missionId).state, 'interrupted');
  assert.equal(codexCalls(open.store), 0, 'linked, permit unused: the turn never left');
  assert.equal(open.missions.depart(linked).ok, false, 'a claim of the previous run cannot leave');
  assert.equal(open.missions.dispatch({ type: 'mission.resume', requestId: rid(), missionId }).ok, true);
  const leaving = claimed(open.missions);
  assert.deepEqual(open.missions.depart(leaving), { ok: true });
  open.close();

  open = registries(box, CODEX_ONLY(3));
  assert.equal(lastAttempt(open.missions, missionId).state, 'interrupted');
  assert.equal(codexCalls(open.store), 1, 'permit used, no recorded end: unknown, the slot stays');
  assert.equal(open.missions.claimNext(), null, 'nothing restarts by itself');
  const again = open.store.admission.reserve({ capability: 'codex.mission', source: { kind: 'human', id: missionId }, target: { kind: 'mission', id: leaving.attemptId, revision: '1' } });
  assert.equal(!again.ok && again.code, 'already_departed');
  open.close();
  assert.deepEqual(reservations(box.chatDb).map(row => row.state), ['released', 'released', 'unknown']);
  open = registries(box, CODEX_ONLY(3));
  assert.equal(codexCalls(open.store), 1, 'another restart changes nothing');
  open.close();
  rmSync(box.base, { recursive: true, force: true });
});

test('a used permit whose turn the missions registry recorded as ended is settled from it, never released', () => {
  const box = sandbox();
  let open = registries(box);
  const missionId = created(open.missions, box);
  const claim = claimed(open.missions);
  assert.deepEqual(open.missions.depart(claim), { ok: true });
  open.missions.bindThread(claim, 'thread-1', 'fake', null);
  open.missions.bindTurn(claim, 'turn-1');
  open.close();
  // The end reached missions.sqlite and the chat store lost its own record of it, as after a restored copy.
  const db = new DatabaseSync(box.missionsDb);
  db.prepare(`UPDATE attempts SET state = 'completed', ended_at = ? WHERE id = ?`).run('2026-11-14T00:00:00.000Z', claim.attemptId);
  db.close();

  open = registries(box);
  assert.equal(lastAttempt(open.missions, missionId).state, 'completed');
  assert.equal(codexCalls(open.store), 1);
  open.close();
  assert.deepEqual(reservations(box.chatDb).map(row => row.state), ['settled']);
  rmSync(box.base, { recursive: true, force: true });
});

test('a missions registry restored from before a departure cannot start that attempt a second time', () => {
  const box = sandbox();
  let open = registries(box);
  const missionId = created(open.missions, box);
  open.close();
  const backup = join(box.base, 'missions-before-the-claim.sqlite');
  copyFileSync(box.missionsDb, backup);

  open = registries(box);
  const claim = claimed(open.missions);
  assert.deepEqual(open.missions.depart(claim), { ok: true });
  open.close();
  copyFileSync(backup, box.missionsDb);
  for (const companion of ['-wal', '-shm']) rmSync(box.missionsDb + companion, { force: true });

  open = registries(box);
  assert.equal(lastAttempt(open.missions, missionId).state, 'queued', 'the restored registry believes the attempt never started');
  assert.equal(codexCalls(open.store), 1, 'the chat store knows its permit was used: unknown');
  assert.equal(open.missions.claimNext(), null);
  const attempt = lastAttempt(open.missions, missionId);
  assert.equal(attempt.state, 'failed');
  assert.match(attempt.errorMessage ?? '', /Tentative non démarrée : Cet appel est déjà parti une fois\. Son permis ne se redonne pas/);
  open.close();
  assert.deepEqual(reservations(box.chatDb).map(row => row.state), ['unknown']);
  rmSync(box.base, { recursive: true, force: true });
});

test('a turn that completes is settled when it ends and keeps its slot through Mino’s check', () => {
  const box = sandbox();
  const { store, missions, close } = registries(box);
  try {
    const missionId = created(missions, box);
    const claim = claimed(missions);
    assert.deepEqual(missions.depart(claim), { ok: true });
    assert.equal(missions.finish(claim, { kind: 'completed', finalText: 'Fait.', threadId: 'thread-1', turnId: 'turn-1' }), 'verifying');
    assert.equal(missions.verified(claim, { check: null, observed: OBSERVED, end: 'done' }), 'completed');
    assert.equal(lastAttempt(missions, missionId).state, 'completed');
    assert.equal(codexCalls(store), 1);
  } finally {
    close();
  }
  assert.deepEqual(reservations(box.chatDb).map(row => [row.capability, row.state]), [['codex.mission', 'settled']]);
  rmSync(box.base, { recursive: true, force: true });
});
