import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MobileSnapshotSchema, phoneRoutineActions } from '../src/generated/mobile-protocol';
import { ROUTINE_STATES } from '../src/generated/protocol';

test('the phone shows pause for an active or held routine, resume only for a paused one, and nothing else', () => {
  const shown = Object.fromEntries(ROUTINE_STATES.map(state => [state, phoneRoutineActions({ state })]));
  assert.deepEqual(shown, { inactive: [], active: ['pause'], paused: ['resume'], held: ['pause'], ended: [] });
});

test('a snapshot from a PC without routines still parses, and a routine keeps its skipped dates', () => {
  const base = {
    schemaVersion: 1, rev: 1, spaceId: 's', erasure: 'complete', purged: { botIds: [], workIds: [] }, bots: [], messages: [], works: [], tasks: [], carnet: [],
    engine: { state: 'starting' },
  };
  assert.equal(MobileSnapshotSchema.parse(base).routines, undefined);
  const routine = {
    id: 'r_1', botId: 'nova', revision: 2, text: 'Point', time: '02:30', weekdays: [7], zone: 'America/Toronto', endsOn: '2026-03-31', cap: 3, admitted: 0,
    state: 'active', endedBecause: null, heldOn: null, upcoming: [{ kind: 'missing', date: '2026-03-08' }], last: null, createdAt: 'x', updatedAt: 'x',
  };
  assert.deepEqual(MobileSnapshotSchema.parse({ ...base, routines: [routine] }).routines?.[0]?.upcoming, [{ kind: 'missing', date: '2026-03-08' }]);
});
