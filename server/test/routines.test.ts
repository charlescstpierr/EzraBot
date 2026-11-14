import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { DEFAULT_POLICY } from '../src/admission.js';
import type { AdmissionPolicy } from '../src/admission-protocol.js';
import { loadMascots, type EngineOutcome } from '../src/domain.js';
import type { Engine, RunInput } from '../src/engine.js';
import type { CommandOf, DispatchOutcome, EngineStatus, RoutineView } from '../src/protocol.js';
import type { MissionOrigin } from '../src/routines.js';
import { openStore, type Store } from '../src/store.js';
import { createWorker } from '../src/worker.js';
import { startFakeHoncho } from './fixtures/fake-honcho.js';
import { BOT, startMemory } from './fixtures/memory-app.js';

const mascots = loadMascots(new URL('../../assets/mascots.json', import.meta.url));
const rid = () => randomUUID();
const READY: EngineStatus = { state: 'ready', account: 'chatgpt', models: [{ id: 'fake', displayName: 'Fake', isDefault: true, efforts: ['low'], defaultEffort: 'low', speeds: [] }] };
const answered = (reply: string, deliverable: { title: string; body: string } | null = null): EngineOutcome =>
  ({ kind: 'succeeded', reply: { reply, deliverable }, used: { model: 'fake', effort: 'low', speed: 'standard' }, threadId: 'thread', turnId: 'turn' });

/** One injected clock for the store and the tick; tests move it by hand. */
function space(options: { path?: string; policy?: AdmissionPolicy; missions?: () => readonly MissionOrigin[]; at?: string } = {}) {
  const path = options.path ?? join(mkdtempSync(join(tmpdir(), 'mino-routines-')), 'mino.sqlite');
  const clock = { at: Date.parse(options.at ?? '2026-11-16T12:00:00Z') };
  const now = () => new Date(clock.at).toISOString();
  const store = openStore({ path, mascots, now, ...(options.policy ? { policy: options.policy } : {}), ...(options.missions ? { missions: options.missions } : {}) });
  return { path, store, clock, set: (iso: string) => { clock.at = Date.parse(iso); }, now };
}

function ok(outcome: DispatchOutcome) {
  assert.equal(outcome.ok, true, outcome.ok ? '' : `${outcome.code}: ${outcome.message}`);
  if (!outcome.ok) throw new Error('refused');
  return outcome.result;
}
const refused = (outcome: DispatchOutcome) => {
  assert.equal(outcome.ok, false, 'refused');
  return outcome.ok ? { code: '', message: '' } : outcome;
};

type Fields = Omit<CommandOf<'routine.create'>, 'type' | 'requestId'>;
const DAILY: Fields = { botId: 'nova', text: 'Fais le point du matin.', time: '08:30', weekdays: [1, 2, 3, 4, 5, 6, 7], zone: 'America/Toronto', endsOn: '2026-12-31', cap: 30 };

function create(store: Store, fields: Partial<Fields> = {}): string {
  const result = ok(store.dispatch({ type: 'routine.create', requestId: rid(), ...DAILY, ...fields }));
  assert.equal(result.kind, 'routine');
  return result.kind === 'routine' ? result.routineId : '';
}
function activate(store: Store, routineId: string): void {
  ok(store.dispatch({ type: 'routine.activate', requestId: rid(), routineId, expectedRevision: routineOf(store, routineId).revision }));
}
const routineOf = (store: Store, routineId: string): RoutineView => {
  const found = store.view().routines.find(routine => routine.id === routineId);
  assert(found, 'routine exists');
  return found;
};
const routineRequests = (store: Store) => store.view().messages.filter(message => message.trigger?.kind === 'routine');

function rows(path: string, sql: string): unknown[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(sql).all().map(row => ({ ...row }));
  } finally {
    db.close();
  }
}

test('a new routine is inactive; activation asks nothing for a slot already passed today, and the next slot is admitted once', () => {
  const s = space({ at: '2026-11-16T13:32:00Z' });
  try {
    const routineId = create(s.store);
    assert.equal(routineOf(s.store, routineId).state, 'inactive');
    assert.equal(s.store.tickRoutines('2026-11-16T00:00:00Z'), 0, 'inactive asks nothing');
    const stale = refused(s.store.dispatch({ type: 'routine.activate', requestId: rid(), routineId, expectedRevision: 2 }));
    assert.equal(stale.code, 'stale_base');
    activate(s.store, routineId);
    assert.equal(s.store.tickRoutines('2026-11-16T00:00:00Z'), 0, '08:30 today passed two minutes before activation');
    assert.deepEqual(routineOf(s.store, routineId).upcoming[0], { kind: 'due', date: '2026-11-17', at: '2026-11-17T13:30:00.000Z', offsetMinutes: -300, repeated: false });

    s.set('2026-11-17T13:31:00Z');
    assert.equal(s.store.tickRoutines('2026-11-16T00:00:00Z'), 1);
    assert.equal(s.store.tickRoutines('2026-11-16T00:00:00Z'), 0, 'a second tick at the same instant adds nothing');
    const [request] = routineRequests(s.store);
    assert.deepEqual(request && { text: request.text, botId: request.botId, trigger: request.trigger }, { text: DAILY.text, botId: 'nova', trigger: { kind: 'routine', routineId, date: '2026-11-17' } });
    const routine = routineOf(s.store, routineId);
    assert.equal(routine.admitted, 1);
    assert.deepEqual(routine.last && routine.last.outcome === 'admitted' && [routine.last.date, routine.last.revision, routine.last.slotAt], ['2026-11-17', 1, '2026-11-17T13:30:00.000Z']);
    assert.equal(s.store.view().works.find(work => work.requestMessageId === request?.id)?.state, 'pending');
  } finally {
    s.store.close();
  }
});

test('reopening the data after a committed admission finds the same work and never admits that date again', () => {
  const s = space({ at: '2026-11-16T12:00:00Z' });
  const routineId = create(s.store);
  activate(s.store, routineId);
  s.set('2026-11-16T13:30:30Z');
  assert.equal(s.store.tickRoutines('2026-11-16T12:00:00Z'), 1);
  s.store.close();
  const again = space({ path: s.path, at: '2026-11-16T13:31:00Z' });
  try {
    assert.equal(again.store.recoverInterrupted(), 0);
    assert.equal(again.store.tickRoutines('2026-11-16T13:31:00Z'), 0);
    assert.equal(routineRequests(again.store).length, 1);
    assert.equal(again.store.view().works.filter(work => work.state === 'pending').length, 1, 'the pending work waits for the worker, once');
  } finally {
    again.store.close();
  }
});

test('a write that fails inside the tick leaves neither a decision nor a request; the next tick admits once', () => {
  for (const table of ['routine_occurrences', 'works', 'origins']) {
    const s = space({ at: '2026-11-16T12:00:00Z' });
    const routineId = create(s.store);
    activate(s.store, routineId);
    s.store.close();
    const db = new DatabaseSync(s.path);
    db.exec(`CREATE TRIGGER fail_once BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);
    db.close();
    const crashing = space({ path: s.path, at: '2026-11-16T13:31:00Z' });
    assert.throws(() => crashing.store.tickRoutines('2026-11-16T12:00:00Z'), /disk full/);
    crashing.store.close();
    assert.deepEqual(rows(s.path, 'SELECT COUNT(*) AS n FROM routine_occurrences'), [{ n: 0 }], `${table}: no decision`);
    assert.deepEqual(rows(s.path, `SELECT COUNT(*) AS n FROM messages`), [{ n: 0 }], `${table}: no request`);
    const repaired = new DatabaseSync(s.path);
    repaired.exec('DROP TRIGGER fail_once');
    repaired.close();
    const next = space({ path: s.path, at: '2026-11-16T13:32:00Z' });
    try {
      assert.equal(next.store.tickRoutines('2026-11-16T12:00:00Z'), 1, `${table}: admitted once after the failure`);
      assert.equal(next.store.tickRoutines('2026-11-16T12:00:00Z'), 0);
    } finally {
      next.store.close();
    }
  }
});

test('a slot more than five minutes late is skipped and the next day is admitted on time', () => {
  const s = space({ at: '2026-11-16T12:00:00Z' });
  try {
    const routineId = create(s.store);
    activate(s.store, routineId);
    s.set('2026-11-16T13:35:01Z');
    assert.equal(s.store.tickRoutines('2026-11-16T12:00:00Z'), 0);
    const last = routineOf(s.store, routineId).last;
    assert.deepEqual(last && last.outcome === 'skipped' && [last.date, last.reason], ['2026-11-16', 'late']);
    s.set('2026-11-17T13:35:00Z');
    assert.equal(s.store.tickRoutines('2026-11-16T12:00:00Z'), 1, 'exactly five minutes late is still admitted');
  } finally {
    s.store.close();
  }
});

test('after a stop of ten days the restart admits nothing, writes one skipped date, and the next future slot is admitted', () => {
  const s = space({ at: '2026-11-16T12:00:00Z' });
  try {
    const routineId = create(s.store);
    activate(s.store, routineId);
    s.set('2026-11-26T13:32:00Z');
    assert.equal(s.store.tickRoutines('2026-11-26T13:32:00Z'), 0, 'a slot two minutes before the restart is not taken');
    const decided = s.store.view().routines[0]?.last;
    assert.deepEqual(decided && decided.outcome === 'skipped' && [decided.date, decided.reason], ['2026-11-16', 'offline']);
    assert.equal(routineRequests(s.store).length, 0);
    s.set('2026-11-27T13:30:00Z');
    assert.equal(s.store.tickRoutines('2026-11-26T13:32:00Z'), 1);
    assert.equal(routineRequests(s.store).length, 1);
  } finally {
    s.store.close();
  }
});

test('Toronto in March: the missing 02:30 admits nothing that day; the 9th is admitted at 06:30Z', () => {
  const s = space({ at: '2026-03-07T12:00:00Z' });
  try {
    const routineId = create(s.store, { time: '02:30', endsOn: '2026-03-31' });
    activate(s.store, routineId);
    assert.deepEqual(routineOf(s.store, routineId).upcoming.slice(0, 2), [{ kind: 'missing', date: '2026-03-08' }, { kind: 'due', date: '2026-03-09', at: '2026-03-09T06:30:00.000Z', offsetMinutes: -240, repeated: false }]);
    for (const at of ['2026-03-08T07:00:00Z', '2026-03-08T07:30:00Z', '2026-03-08T08:30:00Z']) {
      s.set(at);
      assert.equal(s.store.tickRoutines('2026-03-07T12:00:00Z'), 0, at);
    }
    s.set('2026-03-09T06:30:00Z');
    assert.equal(s.store.tickRoutines('2026-03-07T12:00:00Z'), 1);
    assert.deepEqual(routineRequests(s.store).map(m => m.trigger), [{ kind: 'routine', routineId, date: '2026-03-09' }]);
  } finally {
    s.store.close();
  }
});

test('Toronto in November: 01:30 is admitted at its first instant and never at the second', () => {
  const s = space({ at: '2026-10-31T12:00:00Z' });
  try {
    const routineId = create(s.store, { time: '01:30', endsOn: '2026-11-30' });
    activate(s.store, routineId);
    assert.deepEqual(routineOf(s.store, routineId).upcoming[0], { kind: 'due', date: '2026-11-01', at: '2026-11-01T05:30:00.000Z', offsetMinutes: -240, repeated: true });
    s.set('2026-11-01T05:31:00Z');
    assert.equal(s.store.tickRoutines('2026-10-31T12:00:00Z'), 1);
    s.set('2026-11-01T06:31:00Z');
    assert.equal(s.store.tickRoutines('2026-10-31T12:00:00Z'), 0, 'the repeated 01:30 is not a second slot');
    assert.equal(routineOf(s.store, routineId).upcoming[0]?.date, '2026-11-02');
  } finally {
    s.store.close();
  }
});

test('an edit never admits a date again, and a zone change cannot bring two admissions closer than sixty minutes', () => {
  const s = space({ at: '2026-11-16T12:00:00Z' });
  try {
    const routineId = create(s.store);
    activate(s.store, routineId);
    s.set('2026-11-16T13:30:00Z');
    assert.equal(s.store.tickRoutines('2026-11-16T12:00:00Z'), 1);
    const update = (fields: Partial<Fields>, expectedRevision: number) => {
      const { botId: _botId, ...rest } = { ...DAILY, ...fields };
      return s.store.dispatch({ type: 'routine.update', requestId: rid(), routineId, expectedRevision, ...rest });
    };
    ok(update({ time: '09:00', text: 'Nouveau texte.' }, 1));
    assert.equal(refused(update({ time: '09:30' }, 1)).code, 'stale_base');
    s.set('2026-11-16T14:00:30Z');
    assert.equal(s.store.tickRoutines('2026-11-16T12:00:00Z'), 0, 'the 16th is already decided');
    // Kiritimati is already on the 17th: a fresh date, five minutes after the last admission.
    ok(update({ zone: 'Pacific/Kiritimati', time: '04:06' }, 2));
    s.set('2026-11-16T14:06:00Z');
    assert.equal(s.store.tickRoutines('2026-11-16T12:00:00Z'), 0);
    const last = routineOf(s.store, routineId).last;
    assert.deepEqual(last && last.outcome === 'skipped' && [last.date, last.reason, last.revision], ['2026-11-17', 'cooldown', 3]);
    assert.equal(routineOf(s.store, routineId).admitted, 1, 'an edit keeps the count');
  } finally {
    s.store.close();
  }
});

test('a clock set back never reopens a slot, and two ticks after it admit nothing more', () => {
  const s = space({ at: '2026-11-16T12:00:00Z' });
  try {
    const routineId = create(s.store);
    activate(s.store, routineId);
    s.set('2026-11-16T13:31:00Z');
    assert.equal(s.store.tickRoutines('2026-11-16T12:00:00Z'), 1);
    s.set('2026-11-16T11:00:00Z');
    assert.equal(s.store.tickRoutines('2026-11-16T12:00:00Z'), 0);
    s.set('2026-11-16T13:31:00Z');
    assert.equal(s.store.tickRoutines('2026-11-16T12:00:00Z'), 0);
    assert.equal(s.store.tickRoutines('2026-11-16T12:00:00Z'), 0);
    assert.equal(routineOf(s.store, routineId).admitted, 1);
  } finally {
    s.store.close();
  }
});

test('pause stops the next admissions; resume only looks forward, even five minutes after a slot', () => {
  const s = space({ at: '2026-11-16T12:00:00Z' });
  try {
    const routineId = create(s.store);
    activate(s.store, routineId);
    ok(s.store.dispatch({ type: 'routine.pause', requestId: rid(), routineId }));
    s.set('2026-11-16T13:31:00Z');
    assert.equal(s.store.tickRoutines('2026-11-16T12:00:00Z'), 0);
    s.set('2026-11-16T13:33:00Z');
    ok(s.store.dispatch({ type: 'routine.resume', requestId: rid(), routineId }));
    assert.equal(s.store.tickRoutines('2026-11-16T12:00:00Z'), 0, 'the slot three minutes ago stays skipped');
    assert.equal(routineOf(s.store, routineId).upcoming[0]?.date, '2026-11-17');
    s.set('2026-11-17T13:30:00Z');
    assert.equal(s.store.tickRoutines('2026-11-16T12:00:00Z'), 1);
  } finally {
    s.store.close();
  }
});

/** A chat engine that keeps each call open until the test ends it. */
function heldEngine() {
  const waiting: ((outcome: EngineOutcome) => void)[] = [];
  const engine: Engine = {
    status: () => READY, catalog: async () => READY, close: async () => {}, onUsage: () => () => {},
    run: async (input: RunInput) => {
      input.onThread('thread');
      const departure = input.depart();
      if (!departure.ok) return { kind: 'failed', code: 'admission_refused', message: departure.reason };
      input.onTurn('turn');
      return new Promise<EngineOutcome>(resolve => waiting.push(resolve));
    },
  };
  return { engine, finish: (outcome: EngineOutcome) => waiting.shift()?.(outcome), running: () => waiting.length };
}

test('a slow previous request skips the next dates without piling them up; once it ends the next date is admitted', async () => {
  const s = space({ at: '2026-11-16T12:00:00Z' });
  const held = heldEngine();
  const worker = createWorker({ store: s.store, engines: { chat: held.engine, doc: held.engine } });
  try {
    const routineId = create(s.store);
    activate(s.store, routineId);
    s.set('2026-11-16T13:30:00Z');
    assert.equal(s.store.tickRoutines('2026-11-16T12:00:00Z'), 1);
    worker.kick();
    while (!held.running()) await new Promise(resolve => setTimeout(resolve, 5));
    for (const day of ['17', '18']) {
      s.set(`2026-11-${day}T13:30:00Z`);
      assert.equal(s.store.tickRoutines('2026-11-16T12:00:00Z'), 0);
      const last = routineOf(s.store, routineId).last;
      assert.deepEqual(last && last.outcome === 'skipped' && [last.date, last.reason, last.blocker?.startsWith('work:')], [`2026-11-${day}`, 'previous_open', true]);
    }
    held.finish(answered('Point fait.'));
    await worker.idle();
    s.set('2026-11-19T13:30:00Z');
    assert.equal(s.store.tickRoutines('2026-11-16T12:00:00Z'), 1, 'one admission, not three');
    assert.equal(routineRequests(s.store).length, 2);
  } finally {
    held.finish(answered('fin'));
    await worker.close();
    s.store.close();
  }
});

test('a reply awaiting validation or an open publication holds the next date back', async () => {
  const s = space({ at: '2026-11-16T12:00:00Z' });
  const held = heldEngine();
  const worker = createWorker({ store: s.store, engines: { chat: held.engine, doc: held.engine } });
  try {
    const routineId = create(s.store);
    activate(s.store, routineId);
    s.set('2026-11-16T13:30:00Z');
    s.store.tickRoutines('2026-11-16T12:00:00Z');
    worker.kick();
    while (!held.running()) await new Promise(resolve => setTimeout(resolve, 5));
    held.finish(answered('Voici le point.', { title: 'Point', body: 'Corps' }));
    await worker.idle();
    const work = s.store.view().works.find(w => w.state === 'review');
    assert(work, 'the reply waits for validation');
    s.set('2026-11-17T13:30:00Z');
    assert.equal(s.store.tickRoutines('2026-11-16T12:00:00Z'), 0);
    const version = work.versions[0];
    assert(version);
    ok(s.store.dispatch({ type: 'publication.propose', requestId: rid(), workId: work.id, versionId: version.id, destination: 'carnet' }));
    ok(s.store.dispatch({ type: 'work.accept', requestId: rid(), workId: work.id }));
    s.set('2026-11-18T13:30:00Z');
    assert.equal(s.store.tickRoutines('2026-11-16T12:00:00Z'), 0);
    const last = routineOf(s.store, routineId).last;
    assert.deepEqual(last && last.outcome === 'skipped' && last.blocker?.split(':')[0], 'publication');
  } finally {
    await worker.close();
    s.store.close();
  }
});

test('a call that left without a recorded end holds the routine until the person confirms that exact call, and nothing old changes', () => {
  const s = space({ at: '2026-11-16T12:00:00Z' });
  try {
    const routineId = create(s.store);
    activate(s.store, routineId);
    s.set('2026-11-16T13:30:00Z');
    s.store.tickRoutines('2026-11-16T12:00:00Z');
    const claim = s.store.claimNext('chat');
    assert(claim);
    assert.equal(s.store.depart(claim).ok, true);
    s.store.recoverInterrupted();
    const before = s.store.view().works;
    s.set('2026-11-17T13:30:00Z');
    assert.equal(s.store.tickRoutines('2026-11-16T12:00:00Z'), 0);
    const held = routineOf(s.store, routineId);
    assert.equal(held.state, 'held');
    const heldOn = held.heldOn;
    assert(heldOn);
    assert(heldOn.key.startsWith('call:'));
    assert.equal(refused(s.store.dispatch({ type: 'routine.resume', requestId: rid(), routineId })).code, 'stale_base');
    assert.equal(refused(s.store.dispatch({ type: 'routine.resume', requestId: rid(), routineId, confirmBlocker: 'call:autre' })).code, 'stale_base');
    s.set('2026-11-18T13:29:00Z');
    s.store.tickRoutines('2026-11-16T12:00:00Z');
    assert.equal(routineOf(s.store, routineId).state, 'held', 'no tick confirms for the person');
    ok(s.store.dispatch({ type: 'routine.resume', requestId: rid(), routineId, confirmBlocker: heldOn.key }));
    s.set('2026-11-18T13:30:00Z');
    assert.equal(s.store.tickRoutines('2026-11-16T12:00:00Z'), 1, 'only a future date, once confirmed');
    assert.deepEqual(s.store.view().works.filter(w => before.some(b => b.id === w.id)).map(w => [w.id, w.state]), before.map(w => [w.id, w.state]), 'the old work is untouched');
    s.store.close();
    assert.deepEqual(rows(s.path, `SELECT state FROM reservations ORDER BY rowid`), [{ state: 'unknown' }], 'the unknown reservation stays unknown and nothing reserved for the new request yet');
  } finally {
    try { s.store.close(); } catch { /* closed above */ }
  }
});

test('a budget refusal is final for its date; the next fresh day admits a new request and never retries the old one', async () => {
  const s = space({ at: '2026-11-16T12:00:00Z', policy: { ...DEFAULT_POLICY, budgets: { ...DEFAULT_POLICY.budgets, codex: { callsPerDay: 0 } } } });
  const held = heldEngine();
  const worker = createWorker({ store: s.store, engines: { chat: held.engine, doc: held.engine } });
  try {
    const routineId = create(s.store);
    activate(s.store, routineId);
    s.set('2026-11-16T13:30:00Z');
    s.store.tickRoutines('2026-11-16T12:00:00Z');
    worker.kick();
    await worker.idle();
    const [first] = s.store.view().works;
    assert.equal(first?.state, 'failed');
    assert.equal(first?.attempt?.error && /Plafond/.test(first.attempt.error), true);
    s.set('2026-11-17T13:30:00Z');
    assert.equal(s.store.tickRoutines('2026-11-16T12:00:00Z'), 1, 'the next day is a new occurrence');
    assert.equal(s.store.view().works.find(w => w.id === first?.id)?.state, 'failed', 'the old work is not queued again');
    assert.equal(s.store.view().works.length, 2);
  } finally {
    await worker.close();
    s.store.close();
  }
});

test('a mission opened from a routine reply holds the next date while it runs, and an interrupted one asks for confirmation', async () => {
  const missions: MissionOrigin[] = [];
  const s = space({ at: '2026-11-16T12:00:00Z', missions: () => missions });
  const held = heldEngine();
  const worker = createWorker({ store: s.store, engines: { chat: held.engine, doc: held.engine } });
  try {
    const routineId = create(s.store, { botId: 'mino' });
    activate(s.store, routineId);
    s.set('2026-11-16T13:30:00Z');
    s.store.tickRoutines('2026-11-16T12:00:00Z');
    worker.kick();
    while (!held.running()) await new Promise(resolve => setTimeout(resolve, 5));
    held.finish(answered('Je propose une mission.'));
    await worker.idle();
    const reply = s.store.view().messages.find(m => m.role === 'assistant');
    assert(reply);
    missions.push({ missionId: 'msn_1', originMessageId: reply.id, status: 'running' });
    s.set('2026-11-17T13:30:00Z');
    assert.equal(s.store.tickRoutines('2026-11-16T12:00:00Z'), 0);
    const open = routineOf(s.store, routineId).last;
    assert.deepEqual(open && open.outcome === 'skipped' && [open.reason, open.blocker], ['previous_open', 'mission:msn_1']);
    missions[0] = { missionId: 'msn_1', originMessageId: reply.id, status: 'interrupted' };
    s.set('2026-11-18T13:30:00Z');
    assert.equal(s.store.tickRoutines('2026-11-16T12:00:00Z'), 0);
    assert.equal(routineOf(s.store, routineId).heldOn?.key, 'mission:msn_1');
    missions[0] = { missionId: 'msn_1', originMessageId: reply.id, status: 'accepted' };
    ok(s.store.dispatch({ type: 'routine.pause', requestId: rid(), routineId }));
    ok(s.store.dispatch({ type: 'routine.resume', requestId: rid(), routineId }));
    s.set('2026-11-19T13:30:00Z');
    assert.equal(s.store.tickRoutines('2026-11-16T12:00:00Z'), 1, 'an accepted mission no longer holds the routine');
  } finally {
    await worker.close();
    s.store.close();
  }
});

test('the lifetime cap ends the routine; an edit can neither reset the count nor lower the cap under it', () => {
  const s = space({ at: '2026-11-16T12:00:00Z' });
  try {
    const routineId = create(s.store, { cap: 2 });
    activate(s.store, routineId);
    s.set('2026-11-16T13:30:00Z');
    s.store.tickRoutines('2026-11-16T12:00:00Z');
    s.store.dispatch({ type: 'work.cancel', requestId: rid(), workId: s.store.view().works[0]?.id ?? '' });
    const { botId: _botId, ...fields } = DAILY;
    assert.equal(refused(s.store.dispatch({ type: 'routine.update', requestId: rid(), routineId, expectedRevision: 1, ...fields, cap: 1 })).code, 'limit_reached');
    ok(s.store.dispatch({ type: 'routine.update', requestId: rid(), routineId, expectedRevision: 1, ...fields, cap: 2, text: 'Autre texte' }));
    assert.equal(routineOf(s.store, routineId).admitted, 1);
    s.set('2026-11-17T13:30:00Z');
    assert.equal(s.store.tickRoutines('2026-11-16T12:00:00Z'), 1);
    const routine = routineOf(s.store, routineId);
    assert.deepEqual([routine.state, routine.endedBecause, routine.upcoming], ['ended', 'cap', []]);
    s.set('2026-11-18T13:30:00Z');
    assert.equal(s.store.tickRoutines('2026-11-16T12:00:00Z'), 0);
    assert.equal(refused(s.store.dispatch({ type: 'routine.resume', requestId: rid(), routineId })).code, 'invalid_transition');
  } finally {
    s.store.close();
  }
});

test('a midnight routine in UTC admits on its own date, and the end date ends it', () => {
  const s = space({ at: '2026-11-16T12:00:00Z' });
  try {
    const routineId = create(s.store, { zone: 'UTC', time: '00:00', endsOn: '2026-11-17' });
    activate(s.store, routineId);
    s.set('2026-11-17T00:00:30Z');
    assert.equal(s.store.tickRoutines('2026-11-16T12:00:00Z'), 1);
    assert.deepEqual(routineRequests(s.store).map(m => m.trigger), [{ kind: 'routine', routineId, date: '2026-11-17' }]);
    s.set('2026-11-18T00:00:30Z');
    s.store.tickRoutines('2026-11-16T12:00:00Z');
    assert.deepEqual([routineOf(s.store, routineId).state, routineOf(s.store, routineId).endedBecause], ['ended', 'end_date']);
  } finally {
    s.store.close();
  }
});

test('invalid schedules are refused with the reason: fixed offsets, a past or far end date, an unknown character', () => {
  const s = space({ at: '2026-11-16T12:00:00Z' });
  try {
    for (const [fields, pattern] of [
      [{ zone: 'Etc/GMT+5' }, /fuseau horaire nommé/],
      [{ zone: '+05:00' }, /fuseau horaire nommé/],
      [{ endsOn: '2026-11-15' }, /date de fin est passée/],
      [{ endsOn: '2027-11-18' }, /366 jours/],
      [{ endsOn: '2026-02-30' }, /n’existe pas/],
    ] as const) {
      assert.match(refused(s.store.dispatch({ type: 'routine.create', requestId: rid(), ...DAILY, ...fields })).message, pattern);
    }
    assert.equal(refused(s.store.dispatch({ type: 'routine.create', requestId: rid(), ...DAILY, botId: 'absent' })).code, 'not_found');
    for (const bad of [{ weekdays: [1, 1] }, { weekdays: [] }, { cap: 0 }, { cap: 367 }, { time: '24:00' }]) {
      assert.equal(refused(s.store.dispatch({ type: 'routine.create', requestId: rid(), ...DAILY, ...bad })).code, 'invalid_command');
    }
    ok(s.store.dispatch({ type: 'routine.create', requestId: rid(), ...DAILY, zone: 'UTC', endsOn: '2027-11-17' }));
  } finally {
    s.store.close();
  }
});

test('routines never write a proposal, a decision, an action or a reservation, whatever the command', async () => {
  const s = space({ at: '2026-11-16T12:00:00Z' });
  const held = heldEngine();
  const worker = createWorker({ store: s.store, engines: { chat: held.engine, doc: held.engine } });
  const approvals = `SELECT 'p' AS t, id, state, payload_sha256 AS x FROM proposals UNION ALL SELECT 'd', id, decision, payload_sha256 FROM decisions
    UNION ALL SELECT 'pub', id, '', payload_sha256 FROM publications UNION ALL SELECT 'tp', id, state, fingerprint FROM tool_proposals
    UNION ALL SELECT 'te', id, state, report FROM tool_executions UNION ALL SELECT 'r', id, state, source_id FROM reservations ORDER BY 1, 2`;
  try {
    ok(s.store.dispatch({ type: 'message.send', requestId: rid(), botId: 'pixel', text: 'Écris une note.', attachments: [] }));
    worker.kick();
    while (!held.running()) await new Promise(resolve => setTimeout(resolve, 5));
    held.finish(answered('Note.', { title: 'Note', body: 'Corps' }));
    await worker.idle();
    const work = s.store.view().works[0];
    assert(work?.versions[0]);
    ok(s.store.dispatch({ type: 'publication.propose', requestId: rid(), workId: work.id, versionId: work.versions[0].id, destination: 'carnet' }));
    s.store.close();
    const before = rows(s.path, approvals);
    assert.equal(before.length, 2, 'one open proposal and one settled reservation');
    const t = space({ path: s.path, at: '2026-11-16T12:00:00Z' });
    try {
      const routineId = create(t.store, { botId: 'pixel' });
      const { botId: _botId, ...fields } = DAILY;
      const steps: [string, () => void][] = [
        ['activate', () => activate(t.store, routineId)],
        ['tick', () => { t.set('2026-11-16T13:30:00Z'); assert.equal(t.store.tickRoutines('2026-11-16T12:00:00Z'), 0, 'the earlier proposal is not the routine’s'); }],
        ['edit', () => ok(t.store.dispatch({ type: 'routine.update', requestId: rid(), routineId, expectedRevision: 1, ...fields, time: '09:00' }))],
        ['pause', () => ok(t.store.dispatch({ type: 'routine.pause', requestId: rid(), routineId }))],
        ['resume', () => ok(t.store.dispatch({ type: 'routine.resume', requestId: rid(), routineId }))],
        ['delete', () => ok(t.store.dispatch({ type: 'routine.delete', requestId: rid(), routineId }))],
      ];
      for (const [name, run] of steps) {
        run();
        t.store.close();
        assert.deepEqual(rows(s.path, approvals), before, `${name}: approvals and reservations unchanged`);
        const reopened = space({ path: s.path, at: new Date(t.clock.at).toISOString() });
        Object.assign(t, { store: reopened.store });
      }
    } finally {
      t.store.close();
    }
  } finally {
    await worker.close();
  }
});

test('deleting a character erases its routines and their private texts; another character keeps its own', () => {
  const s = space({ at: '2026-11-16T12:00:00Z' });
  const secret = 'Texte privé de routine 7f3a9c';
  const routineId = create(s.store, { text: secret });
  activate(s.store, routineId);
  ok(s.store.dispatch({ type: 'routine.update', requestId: rid(), routineId, expectedRevision: 1, ...(({ botId: _b, ...f }) => f)(DAILY), text: `${secret} révisé` }));
  const kept = create(s.store, { botId: 'pixel', text: 'Routine de Pixel' });
  s.set('2026-11-16T13:30:00Z');
  assert.equal(s.store.tickRoutines('2026-11-16T12:00:00Z'), 1);
  const nova = s.store.view().bots.find(bot => bot.id === 'nova');
  assert.equal(nova?.deletion.routines, 1);
  const deleted = s.store.dispatch({ type: 'bot.delete', requestId: rid(), botId: 'nova', confirmName: 'Nova', expected: nova?.deletion ?? DAILY as never });
  assert.equal(ok(deleted).kind, 'botDeleted');
  assert.deepEqual(s.store.view().routines.map(r => r.id), [kept]);
  s.store.close();
  for (const table of ['routines', 'routine_revisions', 'routine_occurrences', 'routine_acks', 'purge_target']) {
    const remaining = rows(s.path, `SELECT COUNT(*) AS n FROM ${table}`);
    assert.deepEqual(remaining, [{ n: table === 'routines' || table === 'routine_revisions' ? 1 : 0 }], table);
  }
  const bytes = ['', '-wal'].map(suffix => { try { return readFileSync(s.path + suffix); } catch { return Buffer.alloc(0); } });
  assert(bytes.every(file => !file.includes(Buffer.from('7f3a9c'))), 'the private text is gone from the database files');
});

test('a routine request is never searched in Honcho nor exported; the shared history stays allowed until the person forgets it', async () => {
  const honcho = await startFakeHoncho();
  const shift = { ms: 0 };
  const app = await startMemory({ honcho, now: () => new Date(Date.now() + shift.ms).toISOString() });
  const searches = () => honcho.requests.filter(r => r.path.endsWith('/search')).length;
  try {
    const since = new Date().toISOString();
    await app.enable();
    await app.ask('Je préfère le thé vert le matin.');
    await app.synced();
    const [workspace = ''] = [...honcho.workspaces.keys()];
    const exported = honcho.messages(workspace).map(m => m.content);
    assert.equal(exported.some(text => text.includes('thé vert')), true, 'the person’s own request was shared');
    const searched = searches();

    const slot = new Date(Date.now() + 2 * 60_000);
    const time = slot.toISOString().slice(11, 16);
    const routineId = create(app.store, { botId: BOT, zone: 'UTC', time, endsOn: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10), text: 'Résume mes préférences du matin.' });
    activate(app.store, routineId);
    shift.ms = 3 * 60_000;
    assert.equal(app.store.tickRoutines(since), 1);
    app.worker.kick();
    const first = await app.until(v => v.works.some(w => w.state === 'done' && v.messages.some(m => m.id === w.requestMessageId && m.trigger?.kind === 'routine')), 'the routine request is answered');
    const answered = first.works.find(w => first.messages.some(m => m.id === w.requestMessageId && m.trigger?.kind === 'routine'));
    assert.equal(answered?.attempt?.plan?.memory.recall?.state, 'unavailable', 'no recall for a request the person did not type');
    assert.match(app.turn().input, /Je préfère le thé vert le matin\./, 'the earlier shared exchange stays in the history');
    assert.match(app.turn().input, /routine programmée/);
    await app.quiet();
    await app.synced();
    assert.equal(searches(), searched, 'no search for the routine request');
    assert.deepEqual(honcho.messages(workspace).map(m => m.content), exported, 'nothing of the routine was exported');

    await app.accepted({ type: 'memory.forget', confirmLabel: 'Projet synthétique' });
    await app.until(v => app.scopeOf(v).state === 'withdrawal_unverified', 'the withdrawal ends');
    shift.ms = 3 * 60_000 + 86_400_000;
    assert.equal(app.store.tickRoutines(since), 1);
    app.worker.kick();
    await app.until(v => v.works.filter(w => w.state === 'done').length === 3, 'the second routine request is answered');
    assert.doesNotMatch(app.turn().input, /thé vert/, 'the forgotten exchange is no longer in the history');
    assert.equal(searches(), searched);
  } finally {
    await app.stop();
    await honcho.close();
  }
});
