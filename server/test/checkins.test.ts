import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_POLICY } from '../src/admission.js';
import type { AdmissionPolicy } from '../src/admission-protocol.js';
import { checkinInterval } from '../src/checkins.js';
import { OPINION_SCHEMA } from '../src/context.js';
import { engineFailure, loadMascots } from '../src/domain.js';
import { createCodexEngine, type Engine, type RunInput } from '../src/engine.js';
import type { DispatchOutcome, EngineReply, EngineStatus, StoreView } from '../src/protocol.js';
import type { MissionOrigin } from '../src/routines.js';
import { openStore, type Store } from '../src/store.js';
import { createWorker, type Worker } from '../src/worker.js';

const mascots = loadMascots(new URL('../../assets/mascots.json', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/fake-app-server.js', import.meta.url));
const rid = () => randomUUID();
const T0 = Date.parse('2026-11-16T12:00:00.000Z');
const MINUTE = 60_000;
const READY: EngineStatus = { state: 'ready', account: 'chatgpt', models: [{ id: 'fake', displayName: 'Fake', isDefault: true, efforts: ['low'], defaultEffort: 'low', speeds: [] }] };
const CODEX = (callsPerDay: number): AdmissionPolicy => ({ ...DEFAULT_POLICY, budgets: { ...DEFAULT_POLICY.budgets, codex: { callsPerDay } } });

type Hooks = { beforeThread?: () => void; beforeTurn?: () => void; whileRunning?: (input: RunInput) => void; reply?: EngineReply };
type Call = { input: string; base: string; schema: unknown; tools: number; checkin: boolean; thread: boolean; turn: boolean };

/** An engine that keeps Codex's order: the thread opens after `prepare`, the turn starts after `depart`, both in the same tick. */
function scriptedEngine() {
  const calls: Call[] = [];
  const checkinHooks: Hooks[] = [];
  const humanHooks: Hooks[] = [];
  const engine: Engine = {
    status: () => READY, catalog: async () => READY, close: async () => {}, onUsage: () => () => {},
    run: async input => {
      const call: Call = { input: input.turn.input, base: input.turn.baseInstructions, schema: input.turn.outputSchema, tools: input.tools?.specs.length ?? 0,
        checkin: input.turn.baseInstructions.startsWith('Tu es le bot principal de l’application locale Mino.'), thread: false, turn: false };
      calls.push(call);
      const hooks = (call.checkin ? checkinHooks : humanHooks).shift() ?? {};
      await Promise.resolve();
      hooks.beforeThread?.();
      const prepared = input.prepare?.() ?? { ok: true };
      if (!prepared.ok) return engineFailure('admission_refused', prepared.reason);
      call.thread = true;
      input.onThread(`thread-${calls.length}`);
      await Promise.resolve();
      hooks.beforeTurn?.();
      const departure = input.depart();
      if (!departure.ok) return engineFailure('admission_refused', departure.reason);
      call.turn = true;
      input.onTurn(`turn-${calls.length}`);
      hooks.whileRunning?.(input);
      if (input.signal.aborted) return { kind: 'cancelled' };
      return { kind: 'succeeded', reply: hooks.reply ?? { reply: call.checkin ? 'Du nouveau : [f1].' : 'Réponse humaine.', deliverable: null },
        used: { model: 'fake', effort: 'low', speed: 'standard' }, threadId: `thread-${calls.length}`, turnId: `turn-${calls.length}` };
    },
  };
  return { engine, calls, checkinHooks, humanHooks };
}

type Space = ReturnType<typeof space>;
function space(options: { path?: string; at?: number; policy?: AdmissionPolicy; missions?: MissionOrigin[]; serviceTools?: boolean } = {}) {
  const path = options.path ?? join(mkdtempSync(join(tmpdir(), 'mino-checkins-')), 'mino.sqlite');
  const clock = { at: options.at ?? T0 };
  const missions = options.missions ?? [];
  const store = openStore({ path, mascots, now: () => new Date(clock.at).toISOString(), missions: () => missions,
    ...(options.policy ? { policy: options.policy } : {}), ...(options.serviceTools ? { serviceTools: true } : {}) });
  const scripted = scriptedEngine();
  const worker = createWorker({ store, engines: { chat: scripted.engine, doc: scripted.engine } });
  return {
    path, clock, missions, store, worker, ...scripted,
    checkinCalls: () => scripted.calls.filter(call => call.checkin),
    async close() { await worker.close(); store.close(); },
  };
}

function ok(outcome: DispatchOutcome) {
  assert.equal(outcome.ok, true, outcome.ok ? '' : `${outcome.code}: ${outcome.message}`);
  if (!outcome.ok) throw new Error('refused');
  return outcome.result;
}
function refused(outcome: DispatchOutcome, code: string) {
  assert.equal(outcome.ok, false, 'refused');
  if (outcome.ok) throw new Error('accepted');
  assert.equal(outcome.code, code, outcome.message);
  return outcome.message;
}
const minutes = (s: Space, n: number) => { s.clock.at += n * MINUTE; };
const at = (s: Space, n: number) => { s.clock.at = T0 + n * MINUTE; };
const send = (s: Space, text: string, botId = 'mino') => ok(s.store.dispatch({ type: 'message.send', requestId: rid(), botId, text, attachments: [] }));
const say = (s: Space, text: string, botId = 'mino') => ok(s.store.dispatch({ type: 'message.say', requestId: rid(), botId, text, attachments: [] }));
const checkin = (s: Space): StoreView['checkin'] => s.store.view().checkin;
const activate = (s: Space) => ok(s.store.dispatch({ type: 'checkin.activate', requestId: rid(), expectedRevision: checkin(s).revision }));
async function settle(s: Space) {
  s.worker.kick();
  await s.worker.idle();
}
/** One clock tick of the server: at most one decision, then the worker runs what it admitted. */
async function tick(s: Space) {
  const admitted = s.store.tickCheckins();
  if (admitted) s.worker.kick();
  await s.worker.idle();
  return admitted;
}
/** The person asks Mino something and gets a reply, then leaves for longer than the quiet window. */
async function askedAndLeft(s: Space, text = 'Prépare la liste') {
  const sent = send(s, text);
  await settle(s);
  minutes(s, 16);
  return sent;
}
const workState = (s: Space, workId: string | null) => s.store.view().works.find(work => work.id === workId)?.state;

test('check-ins are off by default: hours of ticks after a finished request decide nothing and call nothing', async () => {
  const s = space();
  try {
    await askedAndLeft(s);
    for (let i = 0; i < 20; i += 1) { minutes(s, 45); await tick(s); }
    assert.equal(checkin(s).state, 'off');
    assert.deepEqual(checkin(s).recent, []);
    assert.equal(s.checkinCalls().length, 0);
  } finally { await s.close(); }
});

test('activation is explicit, explains the shared budget and model, and the first check is one interval later, never at the click', async () => {
  const s = space();
  try {
    await askedAndLeft(s);
    const view = checkin(s);
    assert.deepEqual(view.budget, { capability: 'codex.chat', budget: 'codex', callsPerDay: 1000 });
    assert.deepEqual(view.model, { model: null, effort: null, speed: 'standard' });
    activate(s);
    assert.equal(checkin(s).state, 'active');
    assert.equal(checkin(s).nextAt, new Date(s.clock.at + 30 * MINUTE).toISOString());
    assert.equal(await tick(s), false, 'nothing at the click');
    minutes(s, 29);
    assert.equal(await tick(s), false);
    assert.deepEqual(checkin(s).recent, [], 'old finished replies are the baseline, not facts');
    minutes(s, 1);
    await tick(s);
    assert.equal(checkin(s).last?.outcome, 'silent');
    assert.equal(s.checkinCalls().length, 0);
    refused(s.store.dispatch({ type: 'checkin.activate', requestId: rid(), expectedRevision: checkin(s).revision }), 'invalid_transition');
  } finally { await s.close(); }

  const none = space({ policy: { budgets: {}, capabilities: {} } });
  try {
    assert.equal(checkin(none).budget, null);
    assert.match(refused(none.store.dispatch({ type: 'checkin.activate', requestId: rid(), expectedRevision: 1 }), 'invalid_transition'), /aucun plafond/);
    refused(none.store.dispatch({ type: 'checkin.activate', requestId: rid(), expectedRevision: 9 }), 'stale_base');
  } finally { await none.close(); }
});

test('a new fact gives one check-in, published with its facts consumed; the same fact is never reported twice', async () => {
  const s = space();
  try {
    activate(s);
    const asked = await askedAndLeft(s, 'TEXTE_DEMANDE_PRIVEE');
    at(s, 30);
    assert.equal(await tick(s), true);
    const published = checkin(s).last;
    assert.equal(published?.outcome, 'admitted');
    assert.equal(published?.delivery, 'published');
    assert.deepEqual(published?.facts.map(fact => [fact.ref, fact.kind, fact.state, fact.workId]), [['f1', 'reply', 'published', asked.kind === 'message' ? asked.workId : '']]);
    assert.equal(s.checkinCalls().length, 1);
    assert.equal(s.checkinCalls()[0]?.turn, true);
    const reply = s.store.view().messages.find(message => message.role === 'assistant' && message.workId === published?.workId);
    assert.equal(reply?.text, 'Du nouveau : [f1].');
    assert.equal(checkin(s).silentStreak, 0);
    for (let i = 0; i < 6; i += 1) { s.clock.at = Date.parse(checkin(s).nextAt ?? ''); await tick(s); }
    assert.equal(s.checkinCalls().length, 1, 'the reported reply never comes back');
    assert.deepEqual(checkin(s).recent.map(decision => decision.outcome), ['silent', 'silent', 'silent', 'silent', 'silent']);
  } finally { await s.close(); }
});

test('three checks without a fact double the interval up to eight hours; quiet does not count; the backoff survives a restart', async () => {
  const s = space();
  let path = s.path;
  try {
    activate(s);
    assert.deepEqual([1, 2, 3, 6, 9, 12, 15, 30].map(checkinInterval), [30, 30, 60, 120, 240, 480, 480, 480]);
    for (const expected of [30, 30, 60]) {
      s.clock.at = Date.parse(checkin(s).nextAt ?? '');
      await tick(s);
      assert.equal(checkin(s).last?.outcome, 'silent');
      assert.equal(checkin(s).nextAt, new Date(s.clock.at + expected * MINUTE).toISOString());
    }
    assert.equal(checkin(s).silentStreak, 3);
    assert.equal(checkin(s).intervalMinutes, 60);
    path = s.path;
  } finally { await s.close(); }
  const again = space({ path, at: T0 + 90 * MINUTE });
  try {
    assert.equal(checkin(again).silentStreak, 3, 'the streak is durable');
    assert.equal(checkin(again).nextAt, new Date(T0 + 150 * MINUTE).toISOString());
    assert.equal(await tick(again), false);
    assert.equal(checkin(again).recent.length, 3, 'a restart before the due time decides nothing');
    at(again, 140);
    ok(again.store.dispatch({ type: 'message.send', requestId: rid(), botId: 'atlas', text: 'Une question', attachments: [] }));
    await settle(again);
    at(again, 150);
    await tick(again);
    assert.equal(checkin(again).last?.outcome, 'quiet');
    assert.equal(checkin(again).silentStreak, 3, 'a quiet decision is not a silence');
    assert.equal(checkin(again).nextAt, new Date(T0 + 155 * MINUTE).toISOString(), 'the next check is when the quiet window ends');
    assert.equal(again.checkinCalls().length, 0);
  } finally { await again.close(); }
});

test('both composer commands are the person, in any thread; a dictation, a routine and an event request are not', async () => {
  for (const speak of [send, say]) {
    const s = space();
    try {
      activate(s);
      await askedAndLeft(s);
      at(s, 25);
      speak(s, 'Bonjour Pixel', 'pixel');
      await settle(s);
      at(s, 30);
      await tick(s);
      assert.equal(checkin(s).last?.outcome, 'quiet', speak.name);
      assert.equal(checkin(s).quietUntil, new Date(T0 + 40 * MINUTE).toISOString());
      assert.equal(s.checkinCalls().length, 0);
    } finally { await s.close(); }
  }
  const s = space();
  try {
    activate(s);
    await askedAndLeft(s);
    at(s, 25);
    assert.equal(s.store.admit({ botId: 'pixel', text: 'Dictée', origin: { kind: 'voice', callId: 'appel_1', utteranceId: 'u1' } }).ok, true);
    assert.equal(s.store.admit({ botId: 'pixel', text: 'Routine', origin: { kind: 'routine', routineId: 'r_1', occurrence: '2026-11-16' } }).ok, true);
    await settle(s);
    at(s, 30);
    await tick(s);
    assert.equal(checkin(s).last?.outcome, 'admitted', 'automatic requests are no human activity');
  } finally { await s.close(); }
});

test('a person who writes after the decision stops the check-in before its claim, its thread and its turn: zero model call', async () => {
  const windows: [string, (s: Space) => void][] = [
    ['before the claim', s => { send(s, 'Je suis là'); }],
    ['before thread/start', s => { s.checkinHooks.push({ beforeThread: () => { say(s, 'Je suis là'); } }); }],
    ['before turn/start', s => { s.checkinHooks.push({ beforeTurn: () => { send(s, 'Je suis là'); } }); }],
  ];
  for (const [name, interrupt] of windows) {
    const s = space();
    try {
      activate(s);
      await askedAndLeft(s);
      at(s, 30);
      assert.equal(s.store.tickCheckins(), true);
      interrupt(s);
      await settle(s);
      const decision = checkin(s).recent.find(d => d.outcome === 'admitted');
      assert.equal(decision?.delivery, 'released', name);
      assert(decision?.facts.every(fact => fact.state === 'released'), name);
      assert.equal(s.checkinCalls().filter(call => call.turn).length, 0, `${name}: no turn/start`);
      if (name !== 'before turn/start') assert.equal(s.checkinCalls().filter(call => call.thread).length, 0, `${name}: no thread/start`);
      assert.equal(s.store.admission.usage().find(entry => entry.budget === 'codex')?.calls, s.calls.filter(call => call.turn).length, `${name}: only departed calls count`);
      assert.equal(checkin(s).held, null);
      assert.equal(checkin(s).quietUntil, new Date(T0 + 45 * MINUTE).toISOString());
      assert.equal(checkin(s).nextAt, new Date(T0 + 60 * MINUTE).toISOString(), `${name}: the facts wait for the next check, after the quiet window`);
      at(s, 60);
      await tick(s);
      assert.equal(checkin(s).last?.delivery, 'published', `${name}: the released fact comes back once the person is quiet`);
    } finally { await s.close(); }
  }
});

test('a call that already left stays counted, is never published, and holds the check-ins until the person confirms on the PC', async () => {
  const s = space();
  try {
    activate(s);
    await askedAndLeft(s);
    at(s, 30);
    s.checkinHooks.push({ whileRunning: () => { send(s, 'Je reviens'); s.worker.sync(); } });
    await tick(s);
    await settle(s);
    const decision = checkin(s).recent.find(d => d.outcome === 'admitted');
    assert.equal(decision?.delivery, 'held');
    assert.deepEqual(checkin(s).held, { window: decision?.window, departed: true, reason: 'departed_unpublished' });
    assert.equal(s.store.view().messages.filter(message => message.role === 'assistant' && message.workId === decision?.workId).length, 0, 'no late publication');
    assert.equal(checkin(s).departures.used, 1, 'the departed call is counted');
    at(s, 200);
    await tick(s);
    assert.equal(checkin(s).recent.length, 1, 'held: no new decision, no resend');
    ok(s.store.dispatch({ type: 'checkin.pause', requestId: rid() }));
    refused(s.store.dispatch({ type: 'checkin.resume', requestId: rid(), expectedRevision: checkin(s).revision }), 'stale_base');
    refused(s.store.dispatch({ type: 'checkin.resume', requestId: rid(), expectedRevision: checkin(s).revision, confirmWindow: 'w99' }), 'stale_base');
    ok(s.store.dispatch({ type: 'checkin.resume', requestId: rid(), expectedRevision: checkin(s).revision, confirmWindow: decision?.window }));
    const confirmed = checkin(s).recent.find(d => d.window === decision?.window);
    assert.equal(confirmed?.delivery, 'waived');
    assert(confirmed?.facts.every(fact => fact.state === 'waived'), 'the old facts are given up, never claimed delivered');
    assert.equal(checkin(s).departures.used, 1, 'a resume never resets the departures');
    at(s, 300);
    await tick(s);
    assert.equal(checkin(s).last?.outcome, 'silent', 'the given-up fact is not sent again');
    assert.equal(s.checkinCalls().length, 1);
  } finally { await s.close(); }
});

test('an unknown departure after a restart holds; a budget refusal at the decision or at the claim holds without any call', async () => {
  const s = space();
  try {
    activate(s);
    await askedAndLeft(s);
    at(s, 30);
    s.checkinHooks.push({ whileRunning: () => { s.store.recoverInterrupted(); } });
    await tick(s);
    at(s, 31);
    await tick(s);
    assert.deepEqual(checkin(s).held && { departed: checkin(s).held?.departed, reason: checkin(s).held?.reason }, { departed: true, reason: 'departed_unpublished' });
    const work = s.store.view().works.find(w => w.id === checkin(s).last?.workId);
    assert.equal(work?.state, 'failed');
    assert.equal(work?.next.kind, 'none', 'a check-in is never offered a retry');
    assert.match(refused(s.store.dispatch({ type: 'work.retry', requestId: rid(), workId: work?.id ?? '' }), 'invalid_transition'), /bilan ne se relance pas/);
  } finally { await s.close(); }

  const exhausted = space({ policy: CODEX(1) });
  try {
    activate(exhausted);
    await askedAndLeft(exhausted);
    at(exhausted, 30);
    await tick(exhausted);
    assert.equal(checkin(exhausted).last?.outcome, 'refused');
    assert.equal(checkin(exhausted).last?.reason, 'budget_exhausted');
    assert.equal(checkin(exhausted).held?.departed, false);
    assert.equal(exhausted.checkinCalls().length, 0);
  } finally { await exhausted.close(); }

  const raced = space({ policy: CODEX(2) });
  try {
    activate(raced);
    await askedAndLeft(raced);
    at(raced, 30);
    assert.equal(raced.store.tickCheckins(), true);
    assert.equal(raced.store.admission.reserve({ capability: 'codex.chat', source: { kind: 'human', id: 'ailleurs' }, target: { kind: 'chat', id: 'ailleurs' } }).ok, true);
    await settle(raced);
    assert.deepEqual(checkin(raced).held && { departed: checkin(raced).held?.departed, reason: checkin(raced).held?.reason }, { departed: false, reason: 'refused_before_departure' });
    assert.equal(raced.checkinCalls().length, 0);
    ok(raced.store.dispatch({ type: 'checkin.resume', requestId: rid(), expectedRevision: checkin(raced).revision, confirmWindow: checkin(raced).held?.window }));
    assert.equal(checkin(raced).recent.find(d => d.outcome === 'admitted')?.delivery, 'released', 'a refused check-in left nothing: its facts are free again');
  } finally { await raced.close(); }
});

test('a long sleep decides once, a clock moved back decides nothing, and two departures a day are the ceiling', async () => {
  const s = space();
  try {
    activate(s);
    at(s, 30);
    await tick(s);
    at(s, 30 + 600);
    await tick(s);
    await tick(s);
    assert.equal(checkin(s).recent.length, 2, 'ten hours late: one decision, not twenty');
    assert.equal(checkin(s).nextAt, new Date(s.clock.at + 30 * MINUTE).toISOString(), 'the next check counts from the decision');
    const decided = checkin(s).recent.length;
    s.clock.at -= 300 * MINUTE;
    for (let i = 0; i < 12; i += 1) { minutes(s, 20); await tick(s); }
    assert.equal(checkin(s).recent.length, decided, 'behind the last durable instant, nothing is decided');
  } finally { await s.close(); }

  const capped = space();
  try {
    activate(capped);
    for (const n of [1, 2]) {
      await askedAndLeft(capped, `Demande ${n}`);
      capped.clock.at = Math.max(capped.clock.at, Date.parse(checkin(capped).nextAt ?? ''));
      await tick(capped);
      assert.equal(checkin(capped).last?.delivery, 'published');
    }
    const firstDeparture = checkin(capped).recent.find(d => d.window === 'w1')?.decidedAt ?? checkin(capped).recent.at(-1)?.decidedAt ?? '';
    await askedAndLeft(capped, 'Demande 3');
    capped.clock.at = Math.max(capped.clock.at, Date.parse(checkin(capped).nextAt ?? ''));
    await tick(capped);
    assert.equal(checkin(capped).last?.outcome, 'deferred');
    assert.equal(checkin(capped).departures.used, 2);
    assert(Date.parse(checkin(capped).nextAt ?? '') >= Date.parse(firstDeparture) + 24 * 60 * MINUTE - MINUTE);
    assert.equal(capped.checkinCalls().length, 2);
  } finally { await capped.close(); }
});

test('facts are grouped by three, a revised decision and a new mission episode are new facts, an edit is not an end', async () => {
  const s = space();
  try {
    activate(s);
    for (let i = 1; i <= 4; i += 1) send(s, `Demande ${i}`);
    await settle(s);
    minutes(s, 31);
    await tick(s);
    assert.deepEqual(checkin(s).last?.facts.map(fact => fact.ref), ['f1', 'f2', 'f3']);
    minutes(s, 31);
    await tick(s);
    assert.deepEqual(checkin(s).last?.facts.map(fact => [fact.ref, fact.kind]), [['f1', 'reply']]);
    assert.equal(s.checkinCalls().length, 2);
    assert.match(s.checkinCalls()[0]?.input ?? '', /\[f1\] Une réponse demandée dans ce fil est terminée\.\n\[f2\][^\n]*\n\[f3\]/);

    const nextDay = () => { s.clock.at = Math.max(s.clock.at, Date.parse(checkin(s).nextAt ?? '')) + 24 * 60 * MINUTE; };
    nextDay();
    s.humanHooks.push({ reply: { reply: 'Voici le plan.', deliverable: { title: 'Plan', body: 'Corps du plan' } } });
    const asked = send(s, 'Rédige un plan');
    await settle(s);
    const workId = asked.kind === 'message' ? asked.workId : '';
    const work = () => s.store.view().works.find(w => w.id === workId);
    const first = work()?.versions[0];
    assert(first);
    ok(s.store.dispatch({ type: 'publication.propose', requestId: rid(), destination: 'carnet', workId, versionId: first.id }));
    minutes(s, 16);
    s.clock.at = Math.max(s.clock.at, Date.parse(checkin(s).nextAt ?? ''));
    await tick(s);
    assert.deepEqual(checkin(s).last?.facts.map(fact => fact.kind).sort(), ['publication', 'version']);
    const edited = ok(s.store.dispatch({ type: 'version.edit', requestId: rid(), workId, baseVersionId: first.id, title: 'Plan', body: 'Corps modifié' }));
    const versionId = edited.kind === 'version' ? edited.versionId : '';
    ok(s.store.dispatch({ type: 'publication.propose', requestId: rid(), destination: 'carnet', workId, versionId }));
    nextDay();
    await tick(s);
    assert.deepEqual(checkin(s).last?.facts.map(fact => fact.kind), ['publication'], 'the new proposal is a new fact; the manual edit is not a result');

    const reply = s.store.view().messages.find(message => message.role === 'assistant' && message.workId === workId);
    assert(reply);
    s.missions.push({ missionId: 'msn_1', originMessageId: reply.id, status: 'interrupted', interruptions: ['a1'], goalRev: 2, latestAttemptId: 'a1', updatedAt: new Date(s.clock.at).toISOString() });
    nextDay();
    await tick(s);
    assert.deepEqual(checkin(s).last?.facts.map(fact => [fact.kind, fact.missionId]), [['mission', 'msn_1']]);
    s.clock.at = Date.parse(checkin(s).nextAt ?? '');
    await tick(s);
    assert.equal(checkin(s).last?.outcome, 'silent', 'the same interruption is one fact');
    s.missions[0] = { ...s.missions[0]!, interruptions: ['a1', 'a2'], latestAttemptId: 'a2', updatedAt: new Date(s.clock.at).toISOString() };
    nextDay();
    await tick(s);
    assert.deepEqual(checkin(s).last?.facts.map(fact => fact.kind), ['mission'], 'a second interruption of the same goal is a new episode');
  } finally { await s.close(); }
});

test('the check-in turn carries kinds and opaque references only, has no tool, and ignores what a malicious engine returns', async () => {
  const s = space({ serviceTools: true });
  try {
    ok(s.store.dispatch({ type: 'bot.update', requestId: rid(), botId: 'mino', instructions: 'CONSIGNE_PRIVEE' }));
    ok(s.store.dispatch({ type: 'memory.create', requestId: rid(), botId: 'mino', text: 'SOUVENIR_PRIVE' }));
    activate(s);
    s.humanHooks.push({ reply: { reply: 'REPONSE_PRIVEE', deliverable: null } });
    await askedAndLeft(s, 'DEMANDE_PRIVEE');
    at(s, 30);
    s.checkinHooks.push({ reply: { reply: 'Du nouveau [f1].', deliverable: { title: 'Piège', body: 'Livrable' }, handoff: { goal: 'Mission cachée', coordinated: false, why: 'x' }, connection: { service: 'gmail' } } });
    assert.equal(s.store.tickCheckins(), true);
    assert.deepEqual(s.store.planRecall(), { kind: 'none' }, 'no Honcho search is planned for a check-in');
    s.worker.kick();
    await s.worker.idle();
    const [call] = s.checkinCalls();
    assert(call);
    for (const secret of ['CONSIGNE_PRIVEE', 'SOUVENIR_PRIVE', 'DEMANDE_PRIVEE', 'REPONSE_PRIVEE', 'Mino,']) {
      assert(!call.input.includes(secret) && !call.base.includes(secret), secret);
    }
    assert.deepEqual(call.schema, OPINION_SCHEMA);
    assert.equal(call.tools, 0);
    const decision = checkin(s).last;
    assert.equal(decision?.delivery, 'published');
    const view = s.store.view();
    const reply = view.messages.find(message => message.role === 'assistant' && message.workId === decision?.workId);
    assert.equal(reply?.text, 'Du nouveau [f1].');
    assert.equal(reply?.handoff, null);
    const work = view.works.find(w => w.id === decision?.workId);
    assert.equal(work?.state, 'done');
    assert.deepEqual(work?.versions, []);
    assert.deepEqual(work?.proposals, []);
    const attempt = view.works.find(w => w.id === decision?.workId)?.attempt;
    assert.equal(attempt?.plan?.policyVersion, 13);
    assert.deepEqual([attempt?.plan?.exchanges, attempt?.plan?.memory.count], [{ full: 0, brief: 0, omitted: 0 }, 0]);
  } finally { await s.close(); }
});

test('check-in commands never touch proposals, rights, receipts or permits, and the public admission refuses a check-in', async () => {
  const s = space();
  try {
    s.humanHooks.push({ reply: { reply: 'Voici.', deliverable: { title: 'Plan', body: 'Corps' } } });
    const asked = send(s, 'Rédige');
    await settle(s);
    const workId = asked.kind === 'message' ? asked.workId : '';
    const version = s.store.view().works.find(w => w.id === workId)?.versions[0];
    ok(s.store.dispatch({ type: 'publication.propose', requestId: rid(), destination: 'carnet', workId, versionId: version?.id ?? '' }));
    const snapshot = () => JSON.stringify([s.store.view().works.map(w => [w.id, w.state, w.proposals, w.versions.length]), s.store.view().carnet, s.store.admission.usage(), s.store.tools.grantsFor('mino')]);
    const before = snapshot();
    activate(s);
    ok(s.store.dispatch({ type: 'checkin.pause', requestId: rid() }));
    ok(s.store.dispatch({ type: 'checkin.resume', requestId: rid(), expectedRevision: checkin(s).revision }));
    assert.equal(snapshot(), before);
    const forged = s.store.admit({ botId: 'mino', text: 'Bilan forgé', origin: { kind: 'checkin', windowKey: 'w1' } });
    assert.deepEqual([forged.ok, forged.ok ? '' : forged.code], [false, 'invalid_command']);
  } finally { await s.close(); }
  const raw = new DatabaseSync(s.path);
  try {
    raw.exec(`INSERT INTO messages(id, bot_id, role, text, created_at) VALUES ('m_raw', 'mino', 'user', 'x', '2026-11-16T12:00:00.000Z')`);
    assert.throws(() => raw.exec(`INSERT INTO origins(message_id, bot_id, kind, occurrence, fingerprint, created_at) VALUES ('m_raw', 'mino', 'checkin', 'w7', '', 'now')`), /comes only from its decision/);
    assert.equal(raw.prepare('PRAGMA user_version').get()?.user_version, 14);
  } finally { raw.close(); }
});

/** A routine of Nova finishes in Nova's thread: a metadata fact, gone once Nova is deleted. */
async function novaRoutineDone(s: Space) {
  assert.equal(s.store.admit({ botId: 'nova', text: 'Routine du matin', origin: { kind: 'routine', routineId: 'r_matin', occurrence: '2026-11-16' } }).ok, true);
  await settle(s);
}
const deleteNova = (s: Space) => {
  const nova = s.store.view().bots.find(bot => bot.id === 'nova');
  assert(nova);
  ok(s.store.dispatch({ type: 'bot.delete', requestId: rid(), botId: 'nova', confirmName: nova.name, expected: nova.deletion }));
};

test('a source withdrawn before the selection, the claim, the turn or the publication leaves nothing behind', async () => {
  const before = space();
  try {
    activate(before);
    await novaRoutineDone(before);
    deleteNova(before);
    at(before, 30);
    await tick(before);
    assert.equal(checkin(before).last?.outcome, 'silent', 'a deleted source is never selected');
  } finally { await before.close(); }

  const windows: [string, (s: Space) => void, 'released' | 'held'][] = [
    ['before the claim', s => deleteNova(s), 'released'],
    ['before turn/start', s => { s.checkinHooks.push({ beforeTurn: () => deleteNova(s) }); }, 'released'],
    ['before the publication', s => { s.checkinHooks.push({ whileRunning: () => { deleteNova(s); s.worker.sync(); } }); }, 'held'],
  ];
  for (const [name, withdraw, delivery] of windows) {
    const s = space();
    try {
      activate(s);
      await novaRoutineDone(s);
      at(s, 30);
      assert.equal(s.store.tickCheckins(), true, name);
      assert.deepEqual(checkin(s).last?.facts.map(fact => fact.kind), ['automatic_done']);
      withdraw(s);
      await settle(s);
      const decision = checkin(s).recent.find(d => d.outcome === 'admitted');
      assert.equal(decision?.delivery, delivery, name);
      assert.equal(s.store.view().messages.filter(message => message.role === 'assistant' && message.workId === decision?.workId).length, 0, `${name}: nothing published`);
      assert(decision?.facts.every(fact => fact.state === 'withdrawn' && fact.workId === null), `${name}: the fact no longer links anywhere`);
      if (delivery === 'released') assert.equal(s.checkinCalls().filter(call => call.turn).length, 0, `${name}: no turn/start`);
    } finally { await s.close(); }
  }
});

test('a reply composed from a published check-in inherits its withdrawal, without any Honcho scope for Mino', async () => {
  const s = space();
  try {
    activate(s);
    await novaRoutineDone(s);
    at(s, 30);
    await tick(s);
    const published = checkin(s).last;
    assert.equal(published?.delivery, 'published');
    assert.equal(s.store.view().bots.find(bot => bot.id === 'mino')?.memoryScope, null);
    s.humanHooks.push({ whileRunning: input => { assert.match(input.turn.input, /Bilan automatique/, 'the check-in is in this context'); deleteNova(s); s.worker.sync(); } });
    const asked = send(s, 'Et alors ?');
    await settle(s);
    const workId = asked.kind === 'message' ? asked.workId : '';
    assert.equal(workState(s, workId), 'failed', 'the running reply was stopped and not published');
    assert.equal(s.store.view().messages.filter(message => message.role === 'assistant' && message.workId === workId).length, 0);
    assert.equal(checkin(s).recent.find(d => d.window === published?.window)?.withdrawn, true);
    assert.equal(s.store.view().messages.filter(message => message.workId === published?.workId).length, 0, 'the withdrawn check-in is hidden from the thread');
    send(s, 'Encore une question');
    await settle(s);
    const last = s.calls.at(-1);
    assert(last && !last.checkin);
    assert.doesNotMatch(last.input, /Bilan automatique/, 'later contexts no longer read it');
  } finally { await s.close(); }
});

test('deleting Mino turns check-ins off and clears what was held; no other bot named Mino inherits them', async () => {
  const s = space();
  try {
    activate(s);
    await askedAndLeft(s);
    at(s, 30);
    s.checkinHooks.push({ whileRunning: () => { s.store.recoverInterrupted(); } });
    await tick(s);
    at(s, 31);
    await tick(s);
    assert(checkin(s).held);
    const mino = s.store.view().bots.find(bot => bot.id === 'mino');
    assert(mino);
    ok(s.store.dispatch({ type: 'bot.delete', requestId: rid(), botId: 'mino', confirmName: mino.name, expected: mino.deletion }));
    assert.equal(checkin(s).state, 'off');
    assert.equal(checkin(s).held, null);
    assert.equal(checkin(s).model, null);
    assert(checkin(s).recent.every(d => d.messageId === null && d.workId === null), 'the erased requests are no longer referenced');
    ok(s.store.dispatch({ type: 'bot.create', requestId: rid(), name: 'Mino', title: '', shape: 'sprout', color: '#336699' }));
    assert.match(refused(s.store.dispatch({ type: 'checkin.activate', requestId: rid(), expectedRevision: checkin(s).revision }), 'not_found'), /Mino a été supprimé/);
  } finally { await s.close(); }
});

test('on the real engine over the fake App Server, only a due check with a fact and a quiet person opens a thread and a turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mino-checkins-real-'));
  const probe = join(dir, 'rpc.log');
  process.env.MINO_TEST_RPC_PROBE = probe;
  const engineFor = (scenario: string) => createCodexEngine({ command: process.execPath, args: [fixture, scenario], workDir: mkdtempSync(join(dir, 'cwd-')), clientVersion: 'test', requestTimeoutMs: 2000, interruptGraceMs: 300 });
  const engines = { chat: engineFor('reply'), doc: engineFor('deliverable') };
  const clock = { at: T0 };
  const store: Store = openStore({ path: join(dir, 'mino.sqlite'), mascots, now: () => new Date(clock.at).toISOString() });
  const worker: Worker = createWorker({ store, engines });
  const count = (method: string) => (existsSync(probe) ? readFileSync(probe, 'utf8').split('\n').filter(line => line === method).length : 0);
  const counts = () => [count('thread/start'), count('turn/start')];
  const step = async (minutesFromStart: number) => { clock.at = T0 + minutesFromStart * MINUTE; if (store.tickCheckins()) worker.kick(); await worker.idle(); };
  try {
    ok(store.dispatch({ type: 'checkin.activate', requestId: rid(), expectedRevision: 1 }));
    await step(30);
    assert.deepEqual(counts(), [0, 0], 'no fact: silent, no call');
    clock.at = T0 + 50 * MINUTE;
    ok(store.dispatch({ type: 'message.send', requestId: rid(), botId: 'mino', text: 'Bonjour', attachments: [] }));
    worker.kick();
    await worker.idle();
    assert.deepEqual(counts(), [1, 1], 'the person’s own request');
    await step(61);
    assert.equal(store.view().checkin.last?.outcome, 'quiet');
    assert.deepEqual(counts(), [1, 1], 'a recent person: no call');
    await step(76);
    assert.equal(store.view().checkin.last?.delivery, 'published');
    assert.deepEqual(counts(), [2, 2], 'one fact: one thread, one turn');
    for (const later of [110, 150, 240, 400]) await step(later);
    assert.deepEqual(counts(), [2, 2], 'the same fact never calls again');
  } finally {
    await worker.close();
    store.close();
    delete process.env.MINO_TEST_RPC_PROBE;
    await Promise.all([engines.chat.close(), engines.doc.close()]);
  }
});

test('the real engine asks prepare after its last wait and before thread/start: a refusal sends neither thread/start nor turn/start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mino-checkins-prepare-'));
  const probe = join(dir, 'rpc.log');
  process.env.MINO_TEST_RPC_PROBE = probe;
  const engine = createCodexEngine({ command: process.execPath, args: [fixture, 'reply'], workDir: dir, clientVersion: 'test', requestTimeoutMs: 2000, interruptGraceMs: 300 });
  const count = (method: string) => (existsSync(probe) ? readFileSync(probe, 'utf8').split('\n').filter(line => line === method).length : 0);
  const order: string[] = [];
  const input = (prepared: boolean): RunInput => ({
    turn: { baseInstructions: 'Consigne', input: 'Texte', outputSchema: OPINION_SCHEMA }, choice: { model: null, effort: null, speed: 'standard' },
    signal: new AbortController().signal, onStage: () => {}, onThread: () => { order.push('thread'); }, onTurn: () => { order.push('turn'); },
    prepare: () => { order.push('prepare'); return prepared ? { ok: true } : { ok: false, reason: 'La personne a écrit.' }; },
    depart: () => { order.push('depart'); return { ok: true }; },
  });
  try {
    const refusedRun = await engine.run(input(false));
    assert.deepEqual(refusedRun.kind === 'failed' && [refusedRun.code, refusedRun.message], ['admission_refused', 'La personne a écrit.']);
    assert.deepEqual([count('thread/start'), count('turn/start')], [0, 0]);
    assert.deepEqual(order, ['prepare']);
    order.length = 0;
    assert.equal((await engine.run(input(true))).kind, 'succeeded');
    assert.deepEqual([count('thread/start'), count('turn/start')], [1, 1]);
    assert.deepEqual(order, ['prepare', 'thread', 'depart', 'turn'], 'the permit is taken once, after the thread and just before the turn');
  } finally {
    delete process.env.MINO_TEST_RPC_PROBE;
    await engine.close();
  }
});
