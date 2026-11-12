import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RemoteError, scope, type Transport } from '../src/controller';
import { createMissionsClient, missionDrafts } from '../src/missions/client';
import { backTarget, budgetLine, coordinationActions, decisionOutcome, draftKey, group, leadSays, lines, minoSays, plain } from '../src/missions/present';
import type { AgentEventView, AttemptView, DecisionView, MissionDetail } from '../src/generated/agent-protocol';

const session = { kind: 'cookie' as const, url: 'https://pc.example:4319', spaceId: 'space', deviceId: '9d6ec9ba-f35f-4b3b-b9f1-a0ae9e517004' };
const storage = { readSecret: async () => JSON.stringify({ session, claim: null }) };

test('mission commands travel on the paired session with a fresh request id, and a refusal keeps the PC message', async () => {
  const calls: { path: string; body?: string }[] = [];
  const transport: Transport = async (s, path, body) => {
    assert.deepEqual(s, session);
    calls.push({ path, ...(body === undefined ? {} : { body }) });
    if (path === '/m/agents/commands' && body?.includes('mission.budget')) throw new RemoteError(409, 'budget', 'Le plafond de 10 tentatives par mission est atteint.');
    return { ok: true, id: 'msn_1' };
  };
  const client = createMissionsClient(storage, transport, () => 'req-fixed-0001');
  assert.deepEqual(await client.send({ type: 'mission.stop', missionId: 'msn_1' }), { ok: true, id: 'msn_1' });
  assert.equal(JSON.parse(calls[0]?.body ?? '{}').requestId, 'req-fixed-0001');
  assert.deepEqual(await client.send({ type: 'mission.budget', missionId: 'msn_1' }), { ok: false, message: 'Le plafond de 10 tentatives par mission est atteint.' });
  await client.view(7);
  assert.equal(calls.at(-1)?.path, '/m/agents/view?after=7');
});

test('a lost reply is not reported as a refusal or a success', async () => {
  const client = createMissionsClient(storage, async () => { throw new TypeError('Failed to fetch'); }, () => 'req-fixed-0002');
  const result = await client.send({ type: 'mission.resume', missionId: 'msn_1' });
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.message, /peut-être arrivée/);
});

const event = (seq: number, kind: AgentEventView['kind'], data: Record<string, unknown>, attemptId = 'att_1'): AgentEventView => ({ id: `e${seq}`, attemptId, seq, at: '2026-11-07T00:00:00Z', kind, data });

test('the executor thread shows commands, results and file changes, and a command never seen ending stays unfinished', () => {
  const events = [
    event(1, 'command_started', { itemId: 'c1', command: "/bin/bash -lc 'node --test'", cwd: '/p' }),
    event(2, 'command', { itemId: 'c1', command: "/bin/bash -lc 'node --test'", status: 'completed', exitCode: 0 }),
    event(3, 'file_change', { status: 'completed', changes: [{ path: '/home/x/site/src/sum.js', kind: 'update', diff: '' }] }),
    event(4, 'command_started', { itemId: 'c2', command: "/bin/bash -lc 'npm run build'", cwd: '/p' }),
    event(5, 'approval_declined', { method: 'item/commandExecution/requestApproval', command: 'curl x', reason: null }),
    event(6, 'agent_message', { text: 'Autre essai' }, 'att_2'),
  ];
  const shown = lines(events, 'att_1', true);
  assert.deepEqual(shown.map(l => [l.icon, l.text, l.detail]), [
    ['✓', 'node --test', undefined],
    ['✎', 'src/sum.js', undefined],
    ['?', 'npm run build', 'Commencée, fin non observée'],
    ['⊘', 'Autorisation refusée par Mino', 'curl x'],
  ]);
  assert.equal(lines(events, 'att_1', false).find(l => l.text === 'npm run build')?.detail, 'En cours');
});

const attempt = (over: Partial<AttemptView>): AttemptView => ({
  id: 'att_1', n: 1, kind: 'start', goalRev: 1, state: 'completed', sandbox: 'workspace-write', threadId: 't', turnId: 'u', model: 'm', effort: null, note: null,
  createdAt: '', startedAt: '', endedAt: '', errorCode: null, errorMessage: null, finalText: 'ok', usage: null, checkCommand: null, check: null, observed: null, input: null, trigger: null, ...over,
});
const mission = (over: Partial<MissionDetail>): MissionDetail => ({
  id: 'msn_1', projectId: 'prj', title: 'T', status: 'review', goalRev: 1, attemptsUsed: 1, maxAttempts: 3, threadId: 't', acceptedAttemptId: null, originMessageId: null, createdAt: '', updatedAt: '',
  goals: [], attempts: [attempt({})], events: [], eventsOmitted: 0, live: null, acceptBlocked: null,
  can: { stop: false, resume: false, continue: true, revise: true, review: true, accept: null, budget: true },
  mode: 'direct', parentId: null, lead: null, waiting: null, tree: null,
  children: [], decisions: [], origin: null, parent: null, tokens: { total: 0, unknownAttempts: 0 }, synthesis: null, ...over,
});

test('Mino only claims what was observed: a failing check, a replaced goal and an unknown result each say so', () => {
  assert.match(minoSays(mission({ attempts: [attempt({ check: { command: ['npm', 'test'], exitCode: 1, output: '', at: '', error: null } })] }), 'site'), /contrôle échoue/);
  assert.match(minoSays(mission({ status: 'outdated', goalRev: 2 }), 'site'), /version 1, pas à la version 2/);
  assert.match(minoSays(mission({ status: 'interrupted', attempts: [attempt({ state: 'interrupted' })] }), 'site'), /sans confirmation/);
  const order = group([
    { ...mission({ status: 'accepted' }), id: 'a' }, { ...mission({ status: 'running' }), id: 'b' }, { ...mission({ status: 'interrupted' }), id: 'c' },
  ]);
  assert.deepEqual(order.map(g => [g.title, g.items.map(i => i.id)]), [['À regarder', ['c']], ['En cours', ['b']], ['Terminées', ['a']]]);
});

test('executor reports read as plain text', () => {
  assert.equal(plain('- `sum.js` corrigé : **a + b**.\n## Tests\n- `node --test` réussit.'), '• sum.js corrigé : a + b.\nTests\n• node --test réussit.');
});

const nova = { botId: 'nova', name: 'Nova', shape: 'radish', color: '#ff2b76' };
const coordinated = (over: Partial<MissionDetail>): MissionDetail => mission({
  mode: 'coordinated', lead: nova, status: 'waiting', tree: { used: 5, max: 8 }, tokens: { total: 41200, unknownAttempts: 1 },
  can: { stop: true, resume: true, continue: true, revise: true, review: false, accept: null, budget: true }, ...over,
});

test('a coordinated mission shows its shared budget, its usage and the attempts without usage', () => {
  assert.equal(budgetLine(coordinated({})), `5 / 8 essais · ${(41200).toLocaleString('fr-FR')} jetons (non fournie pour 1 essai)`);
  assert.equal(budgetLine(mission({})), '', 'a direct mission keeps its own counter');
});

test('the buttons of a coordinated mission follow exactly what the PC admits', () => {
  assert.deepEqual(coordinationActions(coordinated({})).map(a => a.label), ['Arrêter tout', 'Préciser au responsable', 'Réveiller le responsable', 'Modifier l’objectif']);
  const spent = coordinated({ tree: { used: 8, max: 8 }, can: { stop: false, resume: false, continue: false, revise: true, review: false, accept: null, budget: true } });
  assert.deepEqual(coordinationActions(spent).map(a => a.id), ['revise', 'budget']);
  const ready = coordinated({ status: 'review', can: { stop: true, resume: false, continue: false, revise: true, review: false, accept: 'att_final', budget: false } });
  assert.equal(coordinationActions(ready)[0]?.label, 'Valider la synthèse');
  assert.deepEqual(coordinationActions(coordinated({ status: 'accepted', can: { stop: false, resume: false, continue: false, revise: true, review: false, accept: null, budget: true } })), []);
});

test('the lead says why it waits, and a refused decision says what Mino refused', () => {
  assert.equal(leadSays(coordinated({ waiting: 'Question du responsable : quel dossier ?' })), 'Question du responsable : quel dossier ?');
  assert.equal(minoSays(coordinated({ waiting: 'Budget commun atteint' }), 'site'), 'Budget commun atteint');
  const refused: DecisionView = { id: 'd', n: 2, attemptId: 'a', attemptN: 2, goalRev: 1, kind: 'finish', decision: null, raw: '{}', outcome: 'refused', refusal: 'une étape n’est pas citée', childId: null, createdAt: '' };
  assert.equal(decisionOutcome(refused), 'Refusée par Mino : une étape n’est pas citée');
  assert.match(leadSays(coordinated({ status: 'review', synthesis: { decisionId: 'd', summary: 's', limits: '', evidence: [], final: attempt({ kind: 'final', checkCommand: null }) } })), /Aucun contrôle n’est configuré/);
});

test('a step goes back to its coordinated mission; a mission without parent goes back to the list', () => {
  const step = mission({ parentId: 'msn_root', parent: { id: 'msn_root', title: 'Slugify', lead: nova, decisionN: 1, current: true } });
  assert.deepEqual(backTarget(step), { kind: 'mission', id: 'msn_root' });
  assert.deepEqual(backTarget(mission({})), { kind: 'list' });
});

test('a mission goal draft survives closing the sheet and never touches the chat drafts', async () => {
  const kept = new Map<string, string>([[scope(session), JSON.stringify({ drafts: { mino: { text: 'brouillon du chat' } } })]]);
  const store = { read: async (k: string) => kept.get(k) ?? null, write: async (k: string, v: string) => { kept.set(k, v); }, remove: async (k: string) => { kept.delete(k); } };
  const drafts = missionDrafts(store, 'space-one');
  const key = draftKey('m_proposal');
  await drafts.save(key, 'Ajoute slugify, puis le README.');
  const otherSpace = missionDrafts(store, 'space-two');
  assert.equal(await otherSpace.load(key), null, 'another PC space cannot read this draft');
  await otherSpace.save(key, 'Autre projet');
  assert.equal(await drafts.load(key), 'Ajoute slugify, puis le README.');
  const reopened = missionDrafts(store, 'space-one');
  assert.equal(await reopened.load(key), 'Ajoute slugify, puis le README.', 'found again after the sheet closed');
  assert.equal(await reopened.load(draftKey(null)), null, 'one draft per proposal');
  await reopened.clear(key);
  assert.equal(await reopened.load(key), null);
  assert.equal(kept.get(scope(session)), JSON.stringify({ drafts: { mino: { text: 'brouillon du chat' } } }), 'the chat draft is unchanged');
  const broken = missionDrafts({ read: async () => { throw new Error('x'); }, write: async () => { throw new Error('x'); }, remove: async () => { throw new Error('x'); } }, 'space-one');
  assert.equal(await broken.load(key), null, 'a storage failure never blocks the form');
  await broken.save(key, 'x');
});


test('a handoff retains its request identity after a lost answer and another tap', async () => {
  const requests: string[] = [];
  let n = 0;
  const client = createMissionsClient(storage, async (_session, _path, body) => {
    requests.push(JSON.parse(body ?? '{}').requestId);
    if (requests.length === 1) throw new TypeError('lost answer');
    return { ok: true, id: 'mission_existing' };
  }, () => `fresh-request-${++n}`);
  const command = { type: 'mission.create' as const, projectId: 'project_1', goal: 'Contact', model: null, effort: null, origin: { messageId: 'msg_proposal_1' } };
  assert.equal((await client.send(command)).ok, false);
  assert.deepEqual(await client.send(command), { ok: true, id: 'mission_existing' });
  assert.equal(requests[0], requests[1], 'the server receipt is replayed rather than creating a second mission');
  assert.equal((await client.send({ ...command, goal: 'Contact et adresse', projectId: 'project_2' })).ok, true);
  assert.notEqual(requests[1], requests[2], 'a deliberately changed request has its own identity');
  await client.send(command);
  assert.equal(requests[0], requests[3], 'the original request still replays its receipt');
});
