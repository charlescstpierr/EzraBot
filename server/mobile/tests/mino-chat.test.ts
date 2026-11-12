import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultLead, linkedMission, minoCoordinationSays } from '../src/missions/present';

test('proposal lookup uses its durable origin, never the project or goal', () => {
  const missions = [
    { id: 'same-project', originMessageId: 'other', parentId: null },
    { id: 'child', originMessageId: 'proposal', parentId: 'root' },
    { id: 'actual', originMessageId: 'proposal', parentId: null },
  ];
  assert.equal(linkedMission(missions, 'proposal')?.id, 'actual');
  assert.equal(linkedMission(missions, 'unlinked'), undefined);
});

test('the chosen project gets its remembered eligible lead or the first eligible bot', () => {
  const leads = [{ id: 'mino' }, { id: 'nova' }, { id: 'lumi' }];
  assert.equal(defaultLead(leads, 'lumi'), 'lumi');
  assert.equal(defaultLead(leads, 'removed'), 'nova');
  assert.equal(defaultLead(leads, 'mino'), 'nova');
  assert.equal(defaultLead([{ id: 'mino' }], null), '');
});

test('Mino narrates coordinated state without impersonating its lead or claiming unseen checks', () => {
  assert.match(minoCoordinationSays({ status: 'running', waiting: null, acceptBlocked: null, goalRev: 1 }), /Je suis/);
  assert.equal(minoCoordinationSays({ status: 'waiting', waiting: 'Budget commun atteint', acceptBlocked: null, goalRev: 1 }), 'Budget commun atteint');
  assert.match(minoCoordinationSays({ status: 'interrupted', waiting: null, acceptBlocked: null, goalRev: 1 }), /inconnu/);
  assert.match(minoCoordinationSays({ status: 'review', waiting: null, acceptBlocked: 'Les preuves sont périmées.', goalRev: 1 }), /périmées/);
});


test('follow-up drafts survive readers and separate missions/spaces; a reply clears only its sent text', async () => {
  const { createMissionFollowups } = await import('../src/missions/followup-state');
  const a = createMissionFollowups(), otherSpace = createMissionFollowups();
  a.edit('mission-a', { note: 'Précision non envoyée', goal: 'Objectif encore en édition' });
  a.edit('mission-b', { note: 'Autre mission' });
  assert.deepEqual(a.get('mission-a'), { note: 'Précision non envoyée', goal: 'Objectif encore en édition', busy: false, message: '' });
  assert.equal(otherSpace.get('mission-a').note, '');
  a.sentNote('mission-a', 'Précision non envoyée');
  assert.deepEqual(a.get('mission-a'), { note: '', goal: 'Objectif encore en édition', busy: false, message: '' });
  a.edit('mission-a', { note: 'Texte neuf', goal: 'Nouvel objectif non envoyé' });
  a.sentNote('mission-a', 'Ancien texte'); a.sentGoal('mission-a', 'Ancien objectif');
  assert.deepEqual(a.get('mission-a'), { note: 'Texte neuf', goal: 'Nouvel objectif non envoyé', busy: false, message: '' });
  assert.equal(a.get('mission-b').note, 'Autre mission');
  a.edit('mission-a', { goal: null });
  assert.equal(a.get('mission-a').note, 'Texte neuf');
});


test('a pending follow-up belongs to the mission across readers and retains a refusal', async () => {
  const { createMissionFollowups } = await import('../src/missions/followup-state');
  const state = createMissionFollowups();
  state.edit('a', { note: 'Précision en cours' });
  assert.equal(state.begin('a'), true);
  assert.equal(state.get('a').busy, true);
  assert.equal(state.begin('a'), false);
  assert.equal(state.begin('b'), true);
  state.finish('a', 'Refus reçu après repli');
  assert.equal(state.get('a').busy, false);
  assert.equal(state.get('a').message, 'Refus reçu après repli');
  assert.equal(state.get('a').note, 'Précision en cours');
  assert.equal(state.get('b').busy, true);
  assert.equal(state.begin('a'), true);
  assert.equal(state.get('a').message, '');
});
