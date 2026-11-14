import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HonchoRecallResultSchema, HonchoScopeSchema, HonchoSourceSchema, selectHonchoRecall,
} from '../src/honcho-contract.js';

const binding = { projectId: 'project-a', workspaceId: 'workspace-a', generation: 1 };
function original(sourceId: string, text = 'Budget de 500 dollars.') {
  return { kind: 'authorized', projectId: 'project-a', sourceId, revision: 1,
    origin: { kind: 'message', threadId: 'thread-a', messageId: sourceId }, text };
}
function fixture() {
  const excludedSourceIds: string[] = [];
  return {
    scope: { kind: 'active', ...binding },
    request: { ...binding, query: 'Quel budget ?', maxItems: 3, maxChars: 100 },
    response: { kind: 'references', ...binding, references: [{ sourceId: 'old', revision: 1 }] },
    sources: [original('old')], excludedSourceIds,
  };
}

function selected(input: unknown) {
  const result = selectHonchoRecall(input);
  assert.equal(result.kind, 'selected');
  if (result.kind !== 'selected') throw new Error('Rappel refusé');
  assert.equal(HonchoRecallResultSchema.safeParse(result).success, true);
  return result;
}

test('le rappel cite le texte original autorisé et sa provenance locale', () => {
  const input = fixture();
  const before = structuredClone(input);
  const result = selected(input);
  assert.deepEqual(result.items, [{ projectId: 'project-a', sourceId: 'old', revision: 1,
    origin: { kind: 'message', threadId: 'thread-a', messageId: 'old' }, text: 'Budget de 500 dollars.', truncated: false }]);
  assert.deepEqual(input, before);
});

test('les références sans original, hors projet, exclues ou de mauvaise révision ne donnent aucun texte', () => {
  const input = fixture();
  input.response.references = ['missing', 'foreign', 'excluded', 'revision', 'good'].map(sourceId => ({ sourceId, revision: 1 }));
  input.sources = [
    { ...original('foreign', 'SECRET_SYNTHETIQUE_B'), projectId: 'project-b' },
    original('excluded'), { ...original('revision'), revision: 2 }, original('good', 'Autorisé'),
  ];
  const result = selected({ ...input, excludedSourceIds: ['excluded'] });
  assert.deepEqual(result.items.map(item => item.text), ['Autorisé']);
});

test('une correction garde les sources valides et la nouvelle déclaration, sans fermer la portée', () => {
  const input = fixture();
  const corrected = { kind: 'corrected', projectId: 'project-a', sourceId: 'old', revision: 1, replacedBy: 'new' };
  const declaration = { kind: 'authorized', projectId: 'project-a', sourceId: 'new', revision: 1,
    origin: { kind: 'declaration', declarationId: 'declaration-new' }, text: 'Budget de 350 dollars.' };
  input.response.references = ['old', 'new', 'valid'].map(sourceId => ({ sourceId, revision: 1 }));
  const result = selected({ ...input, sources: [corrected, declaration, original('valid', 'Préférence inchangée.')] });
  assert.deepEqual(result.items.map(item => item.sourceId), ['new', 'valid']);
  assert.equal(result.items[0]?.text, 'Budget de 350 dollars.');
});

test('une génération changée après récupération refuse le résultat avant publication', () => {
  const input = fixture();
  assert.equal(selected(input).items.length, 1);
  assert.deepEqual(selectHonchoRecall({ ...input, scope: { ...input.scope, generation: 2 } }),
    { kind: 'refused', reason: 'stale_generation' });
  assert.deepEqual(selectHonchoRecall({ ...input, response: { ...input.response, generation: 0 } }),
    { kind: 'refused', reason: 'stale_generation' });
});

test('le projet et le workspace doivent correspondre à la requête et à la réponse', () => {
  for (const field of ['request', 'response']) {
    for (const mismatch of [{ projectId: 'project-b' }, { workspaceId: 'workspace-b' }]) {
      const input = fixture();
      const result = selectHonchoRecall({ ...input, [field]: { ...input[field === 'request' ? 'request' : 'response'], ...mismatch } });
      assert.deepEqual(result, { kind: 'refused', reason: 'binding_mismatch' });
    }
  }
});

test('retrait demandé, retrait incertain et reset en attente suspendent tout rappel', () => {
  for (const state of [
    { kind: 'withdrawal_pending' },
    { kind: 'withdrawal_unverified', reason: 'ACK reçu sans preuve de retrait' },
    { kind: 'reset_pending', nextWorkspaceId: 'workspace-empty' },
  ]) {
    assert.deepEqual(selectHonchoRecall({ ...fixture(), scope: { ...binding, ...state } }),
      { kind: 'refused', reason: 'scope_suspended' });
  }
  assert.equal(HonchoScopeSchema.safeParse({ kind: 'reset_pending', ...binding, nextWorkspaceId: 'workspace-a' }).success, false);
});

test('une source marquée exclue est écartée même sans entrée dans la liste des exclusions', () => {
  const input = fixture();
  assert.deepEqual(selected({ ...input, sources: [{ kind: 'excluded', projectId: 'project-a', sourceId: 'old', revision: 1 }] }).items, []);
});

test('le nombre et le total de caractères sont bornés et les doublons ne consomment pas le rappel', () => {
  const input = fixture();
  input.sources = [original('old', '12345'), original('second', 'abcdef'), original('third', 'omission')];
  input.response.references = ['old', 'old', 'second', 'third'].map(sourceId => ({ sourceId, revision: 1 }));
  input.request.maxChars = 8;
  const result = selected(input);
  assert.deepEqual(result.items.map(item => [item.text, item.truncated]), [['12345', false], ['abc', true]]);
  input.request.maxItems = 1;
  assert.deepEqual(selected(input).items.map(item => item.sourceId), ['old']);
});

test('le bornage ne coupe pas une paire UTF-16', () => {
  const input = fixture();
  input.sources = [original('old', 'A😀B')];
  input.request.maxChars = 2;
  assert.equal(selected(input).items[0]?.text, 'A');
  input.sources = [original('old', '😀')];
  input.request.maxChars = 1;
  assert.deepEqual(selected(input).items, []);
});

test('une réponse libre, une origine inventée et des bornes invalides échouent à la frontière', () => {
  const input = fixture();
  const invalid = [
    { ...input, response: { ...input.response, text: 'Synthèse non sourcée' } },
    { ...input, sources: [{ ...original('old'), origin: { kind: 'inferred' } }] },
    ...[0, -1, 4001, 1.5].map(maxChars => ({ ...input, request: { ...input.request, maxChars } })),
    { ...input, request: { ...input.request, maxItems: 11 } },
    { ...input, response: { ...input.response, references: Array.from({ length: 101 }, () => ({ sourceId: 'old', revision: 1 })) } },
  ];
  for (const value of invalid) assert.deepEqual(selectHonchoRecall(value), { kind: 'refused', reason: 'invalid_input' });
  assert.equal(HonchoSourceSchema.safeParse({ ...original('old'), kind: 'excluded' }).success, false);
});

test('des identifiants locaux ambigus ferment le rappel et une indisponibilité reste explicite', () => {
  const input = fixture();
  assert.deepEqual(selectHonchoRecall({ ...input, sources: [...input.sources, original('old', 'Autre texte')] }),
    { kind: 'refused', reason: 'ambiguous_sources' });
  assert.deepEqual(selectHonchoRecall({ ...input, response: { kind: 'unavailable', reason: 'Hors ligne' } }),
    { kind: 'refused', reason: 'unavailable' });
});
