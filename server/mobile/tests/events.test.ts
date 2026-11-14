import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MobileSnapshotSchema, phoneSubscriptionActions } from '../src/generated/mobile-protocol';
import { SUBSCRIPTION_STATES } from '../src/generated/protocol';

test('the phone shows only pause, for an active subscription, and its snapshot carries no instruction, field or event id', () => {
  const shown = Object.fromEntries(SUBSCRIPTION_STATES.map(state => [state, phoneSubscriptionActions({ state })]));
  assert.deepEqual(shown, { inactive: [], active: ['pause'], paused: [], revoked: [] });
  const base = {
    schemaVersion: 1, rev: 1, spaceId: 's', erasure: 'complete', purged: { botIds: [], workIds: [] }, bots: [], messages: [], works: [], tasks: [], carnet: [],
    engine: { state: 'starting' },
  };
  assert.equal(MobileSnapshotSchema.parse(base).events, undefined, 'a PC without events still parses');
  const receipt = { webhookId: 'msg_1', receivedAt: 'x', revision: 2, outcome: 'refused', reason: 'per_day', workId: null, conflicts: 0, retired: false };
  const parsed = MobileSnapshotSchema.parse({ ...base, events: {
    reception: { state: 'configured', transport: 'projet' }, receipts: 1, ignored: { n: 0, lastAt: null }, unavailable: { n: 0, lastAt: null },
    subscriptions: [{ id: 'es_1', botId: 'nova', transport: 'projet', triggerId: 'ti_1', triggerSlug: 'GITHUB_ISSUE_ADDED_EVENT', accountId: 'ca_1',
      account: { alias: 'Travail', toolkit: 'github', status: 'ACTIVE', checkedAt: 'x' }, revision: 2, state: 'active', text: 'Consigne privée',
      fields: ['title'], perDay: 20, today: { admitted: 0, refused: 1 }, open: 0, last: receipt, recent: [receipt], createdAt: 'x', updatedAt: 'x' }],
  } });
  const [sub] = parsed.events?.subscriptions ?? [];
  assert.doesNotMatch(JSON.stringify(parsed.events), /Consigne privée|title|msg_1|ti_1/);
  assert.deepEqual(sub?.last, { receivedAt: 'x', outcome: 'refused', reason: 'per_day', workId: null });
});
