import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// One real Mino chat turn; the mission record/check is seeded without an executor or private data.
const build = resolve(process.argv[2]);
const [{ openMissions }, { openStore }, { loadMascots }, { buildMissionChatContext }, { createCodexEngine }] = await Promise.all(
  ['missions', 'store', 'domain', 'mission-context', 'engine'].map(name => import(join(build, 'dist/src', name + '.js'))));
const base = mkdtempSync(join(tmpdir(), 'mino-status-real-'));
const project = join(base, 'project'), data = join(base, 'data'), cwd = join(base, 'codex');
for (const dir of [project, data, cwd]) mkdirSync(dir);
const store = openStore({ path: join(data, 'chat.sqlite'), mascots: loadMascots(join(build, 'assets/mascots.json')), missionContext: () => buildMissionChatContext(missions) });
const missions = openMissions({ path: join(data, 'missions.sqlite'), minoRoot: build, dataDir: data, admission: store.admission });
const engine = createCodexEngine({ command: 'codex', workDir: cwd, clientVersion: 'verify-mino-status' });
const send = command => missions.dispatch({ requestId: randomUUID(), ...command });
const evidence = { modelCalls: 1, executorCalls: 0, missionRecord: 'controlled SQLite seed', privateDataUsed: false };
try {
  const p = send({ type: 'project.add', path: project, name: 'Projet de vérification', checkCommand: 'false' }); assert.ok(p.ok);
  const m = send({ type: 'mission.create', projectId: p.id, goal: 'Corriger le calcul.', model: null, effort: null }); assert.ok(m.ok);
  const c = missions.claimNext(); assert.ok(c);
  missions.bindThread(c, 'controlled-session', 'controlled', 'low'); missions.bindTurn(c, 'controlled-turn');
  missions.finish(c, { kind: 'completed', finalText: 'Modification proposée.', threadId: 'controlled-session', turnId: 'controlled-turn' });
  missions.verified(c, { end: 'done', observed: { git: false, head: null, status: [], diffStat: '', changedDuringAttempt: [], at: new Date().toISOString(), error: null }, check: { command: ['false'], exitCode: 1, output: 'private-command-output-not-transmitted', error: null, at: new Date().toISOString() } });
  assert.ok(store.dispatch({ type: 'message.send', requestId: randomUUID(), botId: 'mino', text: 'Quel est le résultat du contrôle enregistré pour « Projet de vérification » ? Réponds avec la commande et son code de sortie. Ne crée pas de nouvelle mission.', attachments: [] }).ok);
  const claim = store.claimNextJob(); assert.ok(claim);
  assert.ok(claim.turn.input.includes('"exitCode":1'));
  assert.ok(!claim.turn.input.includes('private-command-output-not-transmitted'));
  const out = await engine.run({ turn: claim.turn, choice: claim.choice, signal: AbortSignal.timeout(180_000),
    depart: () => store.depart(claim), onThread: id => store.bindThread(claim, id), onTurn: id => store.bindTurn(claim, id), onStage: stage => store.setStage(claim, stage) });
  assert.equal(out.kind, 'succeeded', out.kind === 'failed' ? out.message : out.kind);
  assert.match(out.reply.reply, /false/i); assert.match(out.reply.reply, /\b1\b/); assert.equal(out.reply.handoff, null);
  store.finishJob(claim, out);
  Object.assign(evidence, { result: 'passed', reply: out.reply.reply, used: out.used, noNewMission: missions.view().missions.length === 1, contextContainsRegisteredCheck: true, rawCommandOutputExcluded: true });
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await engine.close(); store.close(); missions.close(); rmSync(base, { recursive: true, force: true });
  evidence.cleaned = true;
  writeFileSync(resolve(process.argv[3] ?? 'mino-status-real.json'), JSON.stringify(evidence, null, 2) + '\n');
}
