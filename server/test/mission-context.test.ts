import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { composeContext, type ContextSource } from '../src/context.js';
import { loadMascots } from '../src/domain.js';
import { buildMissionChatContext } from '../src/mission-context.js';
import { openMissions } from '../src/missions.js';
import { openStore } from '../src/store.js';

const source = (extra: Partial<ContextSource>): ContextSource => ({ bot: { name: 'Mino', title: '', instructions: '', replyStyle: 'normal', contextSize: 'standard' }, memories: [], exchanges: [], request: { text: 'Où en est ma mission ?', attachments: [] }, ...extra });

test('mission facts are private to Mino’s own chat, hashed and bounded, and not instructions or actions', () => {
  const facts = { state: 'available' as const, observedAt: '2026-11-07T00:00:00Z', projects: [], projectsOmitted: 0, omitted: 0, missions: [] };
  const first = composeContext(source({ orchestrator: true, missions: facts }));
  assert.match(first.turn.input, /Registre des missions sur le PC/);
  assert.match(first.turn.baseInstructions, /aucun outil d’action/);
  assert.match(first.turn.baseInstructions, /ne prétends jamais avoir arrêté/);
  assert.notEqual(first.sha256, composeContext(source({ orchestrator: true, missions: { state: 'unavailable' } })).sha256);
  assert.doesNotMatch(composeContext(source({ missions: facts })).turn.input, /Registre des missions/);
});

test('Mino receives current registry facts at claim, before the persisted context hash is made; Nova does not', () => {
  const base = mkdtempSync(join(tmpdir(), 'mino-chat-facts-'));
  const mascots = loadMascots(new URL('../../assets/mascots.json', import.meta.url));
  let unavailable = false, reads = 0;
  const store = openStore({ path: join(base, 'chat.sqlite'), mascots, missionContext: () => { reads++; return unavailable ? { state: 'unavailable' } : { state: 'available', observedAt: '2026-11-07T00:00:00Z', projects: [], projectsOmitted: 0, omitted: 0, missions: [] }; } });
  let closed = false;
  try {
    assert.ok(store.dispatch({ type: 'message.send', requestId: randomUUID(), botId: 'mino', text: 'Un statut ?', attachments: [] }).ok);
    unavailable = true;
    const claim = store.claimNextJob(); assert.ok(claim);
    assert.match(claim.turn.input, /"state":"unavailable"/);
    assert.equal(reads, 1);
    const view = store.view().works.find(w => w.id === claim.workId);
    assert.ok(view?.attempt?.plan, 'the recorded attempt carries the composed context plan');
    assert.equal(view?.attempt?.plan?.policyVersion, 9);
    const bot = store.view().bots.find(b => b.id === 'mino'); assert.ok(bot);
    const expected = composeContext({ bot, memories: [], exchanges: [], request: { text: 'Un statut ?', attachments: [] }, orchestrator: true, missions: { state: 'unavailable' } });
    assert.deepEqual(claim.turn, expected.turn);
    store.finishJob(claim, { kind: 'failed', code: 'engine_exited', message: 'fixture' });
    assert.ok(store.dispatch({ type: 'message.send', requestId: randomUUID(), botId: 'nova', text: 'Bonjour', attachments: [] }).ok);
    const other = store.claimNextJob(); assert.ok(other);
    assert.doesNotMatch(other.turn.input, /Registre des missions/);
    assert.equal(reads, 1);
    store.close(); closed = true;
    const db = new DatabaseSync(join(base, 'chat.sqlite'), { readOnly: true });
    try { assert.equal(db.prepare('SELECT context_sha256 FROM attempts WHERE id=?').get(claim.attemptId)?.context_sha256, expected.sha256); }
    finally { db.close(); }
  } finally { if (!closed) store.close(); rmSync(base, { recursive: true, force: true }); }
});

test('registry projection and origin binding survive reopen; identical confirmations share a mission while changed goals do not', () => {
  const base = mkdtempSync(join(tmpdir(), 'mino-chat-registry-'));
  const project = join(base, 'project'), data = join(base, 'data');
  mkdirSync(project); mkdirSync(data);
  const options = { path: join(data, 'missions.sqlite'), minoRoot: join(base, 'app'), dataDir: data };
  let missions = openMissions(options);
  const deps = { bot: () => null, origin: () => ({ text: 'Demande exacte' }) };
  const send = (command: Record<string, unknown>) => missions.dispatch({ requestId: randomUUID(), ...command }, deps);
  try {
    const p = send({ type: 'project.add', path: project, name: 'Produit' }); assert.ok(p.ok);
    const empty = buildMissionChatContext(missions);
    assert.equal(empty.state, 'available');
    if (empty.state === 'available') assert.deepEqual(empty.projects, [{ id: p.id, name: 'Produit' }], 'Mino knows the allowed project even before its first mission');
    const command = { type: 'mission.create', projectId: p.id, goal: 'Ajoute la fonction.', model: null, effort: null, origin: { messageId: 'msg_proposal_001' } };
    const one = send(command), two = send(command); assert.ok(one.ok && two.ok);
    assert.equal(one.id, two.id);
    assert.equal(missions.view().queue.length, 1, 'two independent request identities do not reserve two executions');
    missions.close(); missions = openMissions(options);
    assert.equal(missions.view().missions[0]?.originMessageId, 'msg_proposal_001');
    const again = send(command); assert.ok(again.ok); assert.equal(again.id, one.id);
    const changed = send({ ...command, goal: 'Une autre amélioration.' }); assert.ok(changed.ok); assert.notEqual(changed.id, one.id);
    for (let i = 0; i < 4; i++) assert.ok(send({ ...command, goal: 'Autre ' + i, origin: undefined }).ok);
    const facts = buildMissionChatContext(missions);
    assert.equal(facts.state, 'available');
    if (facts.state === 'available') { assert.equal(facts.missions.length, 3); assert.equal(facts.omitted, 3); }
    assert.ok(JSON.stringify(facts).length < 8_000);
    assert.equal(JSON.stringify(facts).includes(project), false, 'raw project paths are not added to the conversation');
    assert.deepEqual(buildMissionChatContext({ view: () => { throw new Error('db failed'); }, detail: () => null }), { state: 'unavailable' });
  } finally { missions.close(); rmSync(base, { recursive: true, force: true }); }
});
