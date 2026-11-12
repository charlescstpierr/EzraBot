import assert from 'node:assert/strict';
import test from 'node:test';
import { judge, LEAD_OUTPUT_SCHEMA, leadPrompt, parseDecision, STALE_REFUSAL, type Tree, type TreeChild } from '../src/coordination.js';

const wire = (fields: Record<string, unknown>) => JSON.stringify({
  kind: 'delegate', why: 'Première étape séparable.', childId: null, title: null, goal: null, note: null, question: null, summary: null, limits: null, evidence: [], ...fields,
});

const child = (id: string, extra: Partial<TreeChild> = {}): TreeChild => ({
  id, title: `Étape ${id}`, current: true, unknown: false, citable: `att-${id}`, refuses: { continue: null, review: null }, ...extra,
});
const tree = (extra: Partial<Tree> = {}): Tree => ({ goalRev: 1, halted: false, accepted: false, leadGoalRev: 1, busy: false, used: 2, max: 8, children: [], ...extra });

test('the lead schema is strict: every field required, no extra field, null for unused fields', () => {
  assert.equal(LEAD_OUTPUT_SCHEMA.additionalProperties, false);
  assert.deepEqual([...LEAD_OUTPUT_SCHEMA.required].sort(), Object.keys(LEAD_OUTPUT_SCHEMA.properties).sort());
  for (const banned of ['sandbox', 'budget', 'model', 'projectId', 'command', 'accept', 'stop']) assert.equal(banned in LEAD_OUTPUT_SCHEMA.properties, false, banned);
});

test('parseDecision refuses unreadable text, extra fields and fields outside the chosen kind', () => {
  assert.equal(parseDecision('pas du json').ok, false);
  const extra = parseDecision(wire({ title: 'T', goal: 'G', sandbox: 'danger-full-access' }));
  assert.equal(extra.ok, false, 'an extra sandbox field is refused');
  assert.equal(parseDecision(wire({ title: 'T', goal: 'G', budget: 20 })).ok, false, 'an extra budget field is refused');
  const stray = parseDecision(wire({ title: 'T', goal: 'G', question: 'Et ça ?' }));
  assert.ok(!stray.ok && /question/.test(stray.refusal), 'a field of another kind is refused');
  assert.ok(!stray.ok && stray.kind === 'delegate');
  assert.equal(parseDecision(wire({ title: 'T', goal: '   ' })).ok, false, 'an empty goal is refused');
  assert.equal(parseDecision(wire({ kind: 'finish', summary: 'Fait', limits: '', evidence: [] })).ok, false, 'finish needs evidence');
  assert.equal(parseDecision(wire({ kind: 'ask', question: 'Quel dossier ?', evidence: [{ childId: 'a', attemptId: 'b' }] })).ok, false, 'evidence outside finish is refused');
  const ok = parseDecision(wire({ title: 'Fonction slugify', goal: 'Ajoute slugify avec tests.' }));
  assert.deepEqual(ok, { ok: true, decision: { kind: 'delegate', why: 'Première étape séparable.', title: 'Fonction slugify', goal: 'Ajoute slugify avec tests.' } });
});

test('judge refuses a delegate while another attempt is active, past four steps, past the budget, or with an unknown step', () => {
  const delegate = { kind: 'delegate', why: 'x', title: 'T', goal: 'G' } as const;
  assert.equal(judge(tree(), delegate).ok, true);
  assert.equal(judge(tree({ busy: true }), delegate).ok, false);
  assert.equal(judge(tree({ children: ['a', 'b', 'c', 'd'].map(id => child(id)) }), delegate).ok, false);
  assert.equal(judge(tree({ used: 8, max: 8 }), delegate).ok, false);
  const unknown = judge(tree({ children: [child('a', { unknown: true, citable: null })] }), delegate);
  assert.ok(!unknown.ok && /inconnu/.test(unknown.refusal));
  assert.equal(judge(tree({ halted: true }), delegate).ok, false, 'a stopped tree accepts no decision');
});

test('judge refuses a stale lead turn and a finish that cites an old, unchecked or foreign step, or leaves a current step out', () => {
  const finish = (evidence: { childId: string; attemptId: string }[]) => ({ kind: 'finish', why: 'x', summary: 'S', limits: '', evidence } as const);
  const stale = judge(tree({ goalRev: 2, leadGoalRev: 1 }), finish([{ childId: 'a', attemptId: 'att-a' }]));
  assert.deepEqual(stale, { ok: false, refusal: STALE_REFUSAL });
  const two = [child('a'), child('b')];
  assert.equal(judge(tree({ children: two }), finish([{ childId: 'a', attemptId: 'att-a' }, { childId: 'b', attemptId: 'att-b' }])).ok, true);
  assert.equal(judge(tree({ children: two }), finish([{ childId: 'a', attemptId: 'att-a' }])).ok, false, 'a current step cannot be left out');
  assert.equal(judge(tree({ children: [child('a', { current: false })] }), finish([{ childId: 'a', attemptId: 'att-a' }])).ok, false, 'an old step is not evidence');
  assert.equal(judge(tree({ children: [child('a', { citable: null })] }), finish([{ childId: 'a', attemptId: 'att-a' }])).ok, false, 'an unchecked step is not evidence');
  assert.equal(judge(tree({ children: [child('a')] }), finish([{ childId: 'z', attemptId: 'att-z' }])).ok, false, 'a step of another mission is not evidence');
  const old = [child('old', { current: false, citable: null }), child('new')];
  assert.equal(judge(tree({ children: old }), finish([{ childId: 'new', attemptId: 'att-new' }])).ok, true, 'old steps stay visible but need no citation');
});

test('judge passes continue and review through the registry admission of the step', () => {
  const refused = judge(tree({ children: [child('a', { refuses: { continue: 'Reprenez d’abord.', review: null } })] }), { kind: 'continue', why: 'x', childId: 'a', note: 'n' });
  assert.deepEqual(refused, { ok: false, refusal: 'Reprenez d’abord.' });
  assert.equal(judge(tree({ children: [child('a')] }), { kind: 'review', why: 'x', childId: 'a' }).ok, true);
  assert.equal(judge(tree({ children: [child('a', { current: false })] }), { kind: 'review', why: 'x', childId: 'a' }).ok, false);
  assert.equal(judge(tree(), { kind: 'continue', why: 'x', childId: 'nope', note: 'n' }).ok, false);
});

test('the dossier carries the exact goal and origin texts and marks old steps as not citable', () => {
  const prompt = leadPrompt({
    project: { name: 'site', path: '/p', checkCommand: ['npm', 'test'] }, leadName: 'Nova', title: 'Slugify',
    goal: { rev: 2, text: 'Objectif  exact\navec retour' }, origin: 'demande « exacte »',
    accepted: [], notes: [{ rev: 2, text: 'garde le style' }], decisions: [], event: 'test.', budget: { used: 3, max: 8 },
    children: [{ id: 'msn_a', title: 'A', goal: { rev: 1, text: 'consigne', origin: 'lead' }, current: false, state: 'arrêtée', report: null, check: null, citable: null, notes: [] }],
  });
  assert.ok(prompt.includes('Objectif  exact\navec retour'));
  assert.ok(prompt.includes('demande « exacte »'));
  assert.match(prompt, /childId msn_a\) : ancien objectif, non citable/);
  assert.match(prompt, /garde le style/);
});
