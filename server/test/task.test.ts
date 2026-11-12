import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { engineFailure, loadMascots, type EngineOutcome } from '../src/domain.js';
import type { CommandResult, DispatchOutcome, StoreView, TaskView } from '../src/protocol.js';
import { openStore, type Claim, type Store } from '../src/store.js';

const mascots = loadMascots(new URL('../../assets/mascots.json', import.meta.url));
const rid = () => randomUUID();

function open(): { store: Store; path: string } {
  const path = join(mkdtempSync(join(tmpdir(), 'mino-task-')), 'mino.sqlite');
  return { store: openStore({ path, mascots }), path };
}

function ok(outcome: DispatchOutcome): CommandResult {
  assert.equal(outcome.ok, true, outcome.ok ? '' : `${outcome.code}: ${outcome.message}`);
  if (!outcome.ok) throw new Error('refused');
  return outcome.result;
}

function refused(outcome: DispatchOutcome): string {
  assert.equal(outcome.ok, false, 'refused');
  return outcome.ok ? '' : outcome.code;
}

function request(store: Store, text: string, reviewerBotId: string | null = null, botId = 'mino'): string {
  const result = ok(store.dispatch({ type: 'message.send', requestId: rid(), botId, text, attachments: [], document: { reviewerBotId } }));
  assert(result.kind === 'message' && result.taskId);
  return result.taskId;
}

function task(store: Store, taskId: string): TaskView {
  const found = store.view().tasks.find(t => t.id === taskId);
  assert(found, 'task exists');
  return found;
}

let turns = 0;
function accept(store: Store, claim: Claim): { threadId: string; turnId: string } {
  const ids = { threadId: `thread-${++turns}`, turnId: `turn-${turns}` };
  store.bindThread(claim, ids.threadId);
  store.bindTurn(claim, ids.turnId);
  return ids;
}

function claimDoc(store: Store): Claim {
  const claim = store.claimNext('doc');
  assert(claim, 'a document step is claimable');
  return claim;
}

const used = { model: 'gpt-test', effort: 'low', speed: 'standard' };
const documentReply = (reply: string, title: string, body: string, ids = { threadId: 't', turnId: 'u' }): EngineOutcome =>
  ({ kind: 'succeeded', reply: { reply, deliverable: { title, body } }, used, ...ids });
const opinion = (reply: string, ids = { threadId: 't', turnId: 'u' }): EngineOutcome =>
  ({ kind: 'succeeded', reply: { reply, deliverable: null }, used, ...ids });

function remember(store: Store, botId: string, text: string): void {
  ok(store.dispatch({ type: 'memory.create', requestId: rid(), botId, text }));
}

function intent(store: Store, taskId: string, value: { kind: 'add_info' | 'change_goal'; text: string } | { kind: 'cancel' }): DispatchOutcome {
  return store.dispatch({ type: 'task.intent', requestId: rid(), taskId, intent: value });
}

function authorVersions(view: StoreView, t: TaskView) {
  return view.works.find(w => w.id === t.authorWorkId)?.versions ?? [];
}

test('a solo document is one call on its own lane, shows two received states, and the chat lane answers meanwhile', () => {
  const { store } = open();
  try {
    const taskId = request(store, 'Prépare-moi un plan de déménagement');
    assert.equal(store.claimNext('chat'), null, 'the chat lane never takes a document step');
    const draft = claimDoc(store);
    assert.equal(draft.lane, 'doc');
    assert.equal(store.claimNext('doc'), null, 'one call per lane');
    ok(store.dispatch({ type: 'message.send', requestId: rid(), botId: 'mino', text: 'Où en es-tu ?', attachments: [] }));
    const chat = store.claimNext('chat');
    assert(chat, 'the chat lane runs while the document call is running');
    assert.match(chat.turn.input, /Travaux documentaires de ce fil en cours[\s\S]*Prépare-moi un plan de déménagement/);
    store.finishJob(chat, opinion('Je rédige le plan en parallèle.'));

    const ids = accept(store, draft);
    const full = JSON.stringify({ reply: 'Plan prêt.', deliverable: { title: 'Déménagement', body: '# Plan\n- cartons\n- clés' } });
    const states: string[] = [];
    for (const cut of [15, full.length - 12, full.length]) {
      store.recordProgress(draft, { ...ids, itemId: 'item-1', text: full.slice(0, cut), final: cut === full.length });
      const seen = task(store, taskId).progress;
      assert(seen && '# Plan\n- cartons\n- clés'.startsWith(seen.body ?? '') && 'Plan prêt.'.startsWith(seen.reply));
      states.push(JSON.stringify([seen.reply, seen.title, seen.body]));
    }
    assert.deepEqual(JSON.parse(states[0] ?? ''), ['Plan ', null, null], 'the first state is the reply received so far');
    const progress = task(store, taskId).progress;
    assert.equal(progress?.complete, true);
    assert.equal(progress?.writes, 3);
    assert.equal(new Set(states).size, 3, 'each received state differs');
    store.recordProgress(draft, { threadId: ids.threadId, turnId: 'turn-elsewhere', itemId: 'item-1', text: '{"reply":"intrus', final: false });
    assert.equal(task(store, taskId).progress?.writes, 3, 'text from another turn is ignored');

    assert.equal(store.finishJob(draft, documentReply('Plan prêt.', 'Déménagement', '# Plan\n- cartons\n- clés', ids)).kind, 'recorded');
    const done = task(store, taskId);
    assert.equal(done.status, 'finished');
    assert.equal(done.calls.length, 1);
    assert.equal(done.maxCalls, 1);
    assert.equal(done.reviewWorkId, null);
    assert.equal(done.progress, null, 'a finished call shows its version, not its stream');
    assert.deepEqual(authorVersions(store.view(), done).map(v => [v.n, v.source, v.body]), [[1, 'result', '# Plan\n- cartons\n- clés']]);
    assert.equal(store.claimNext('doc'), null, 'no second call for a solo task');
  } finally {
    store.close();
  }
});

test('a relay hands A’s recorded output to B, then B’s saved opinion to A, with each bot’s own memory only', () => {
  const { store } = open();
  try {
    remember(store, 'mino', 'CANARI_MEMOIRE_MINO');
    remember(store, 'pixel', 'CANARI_MEMOIRE_PIXEL');
    ok(store.dispatch({ type: 'message.send', requestId: rid(), botId: 'pixel', text: 'CANARI_FIL_PRIVE_PIXEL', attachments: [] }));
    const taskId = request(store, 'Rédige la note de rentrée', 'pixel');

    const draft = claimDoc(store);
    assert.equal(draft.botId, 'mino');
    assert.match(draft.turn.input, /CANARI_MEMOIRE_MINO/);
    assert.doesNotMatch(draft.turn.input, /CANARI_MEMOIRE_PIXEL|CANARI_FIL_PRIVE_PIXEL/);
    assert.deepEqual(draft.turn.outputSchema.properties.deliverable, { type: 'object', additionalProperties: false, required: ['title', 'body'], properties: { title: { type: 'string' }, body: { type: 'string' } } });
    store.finishJob(draft, documentReply('Voici le brouillon DRAFT_REPLY.', 'Note', 'Corps DRAFT_BODY'));
    let view = task(store, taskId);
    assert.equal(view.status, 'queued');
    assert.equal(view.handoffs.length, 1);
    assert(view.reviewWorkId, 'the reviewer work is created at the handoff');

    const review = claimDoc(store);
    assert.equal(review.botId, 'pixel');
    assert.equal(review.workId, view.reviewWorkId);
    assert.match(review.turn.input, /Message de Mino avec son document :\nVoici le brouillon DRAFT_REPLY\./);
    assert.match(review.turn.input, /Document actuel « Note », version 1, texte complet :\nCorps DRAFT_BODY/);
    assert.match(review.turn.input, /CANARI_MEMOIRE_PIXEL/);
    assert.doesNotMatch(review.turn.input, /CANARI_MEMOIRE_MINO|CANARI_FIL_PRIVE_PIXEL/);
    assert.match(review.turn.input, /pas votre avis comme une vérification indépendante|ne présente pas ton avis comme une vérification indépendante/);
    assert.deepEqual(review.turn.outputSchema.properties.deliverable, { type: 'null' });
    store.finishJob(review, opinion('Ajoute les horaires OPINION_PIXEL.'));
    view = task(store, taskId);
    const signed = store.view().messages.find(m => m.text.includes('OPINION_PIXEL'));
    assert.equal(signed?.botId, 'pixel');
    assert.equal(signed?.threadBotId, 'mino', 'the opinion is signed by Pixel in Mino’s thread');
    assert.equal(signed?.taskStep, 'review');

    const synthesis = claimDoc(store);
    assert.equal(synthesis.botId, 'mino');
    assert.match(synthesis.turn.input, /Avis de Pixel :\nAjoute les horaires OPINION_PIXEL\./);
    assert.match(synthesis.turn.input, /CANARI_MEMOIRE_MINO/);
    assert.doesNotMatch(synthesis.turn.input, /CANARI_MEMOIRE_PIXEL/);
    store.finishJob(synthesis, documentReply('Horaires ajoutés.', 'Note', 'Corps final avec horaires'));
    view = task(store, taskId);
    assert.equal(view.status, 'finished');
    assert.deepEqual(view.calls.map(c => [c.step, c.botId, c.state]), [['draft', 'mino', 'succeeded'], ['review', 'pixel', 'succeeded'], ['synthesis', 'mino', 'succeeded']]);
    assert.deepEqual(view.handoffs.map(h => [h.fromBotId, h.toStep, h.readBy.map(r => [r.botId, r.step])]),
      [['mino', 'review', [['pixel', 'review']]], ['pixel', 'synthesis', [['mino', 'synthesis']]]]);
    assert(view.handoffs.every(h => h.readBy.every(r => /^[0-9a-f]{64}$/.test(r.contextSha256))), 'each read is tied to the hash of the context that carried it');
    assert.deepEqual(authorVersions(store.view(), view).map(v => v.body), ['Corps DRAFT_BODY', 'Corps final avec horaires']);
    assert.equal(store.claimNext('doc'), null, 'the relay stops after three calls');

  } finally {
    store.close();
  }
});

test('handoffs are transmitted only by an accepted turn, never by a claim or a refused call', () => {
  const { store } = open();
  try {
    const taskId = request(store, 'Rédige le document', 'pixel');
    const draft = claimDoc(store);
    store.finishJob(draft, documentReply('Brouillon enregistré.', 'Note', 'Texte complet'));
    const review = claimDoc(store);
    assert.deepEqual(task(store, taskId).handoffs[0]?.readBy, []);
    store.finishJob(review, engineFailure('rpc_refused'));
    assert.deepEqual(task(store, taskId).handoffs[0]?.readBy, []);
    ok(store.dispatch({ type: 'task.continue', requestId: rid(), taskId }));
    const resumed = claimDoc(store);
    assert.deepEqual(task(store, taskId).handoffs[0]?.readBy, []);
    accept(store, resumed);
    assert.deepEqual(task(store, taskId).handoffs[0]?.readBy.map(r => [r.botId, r.n, r.step]), [['pixel', 2, 'review']]);
  } finally {
    store.close();
  }
});

test('deeply nested provider text preserves the last readable progress instead of crashing the store', () => {
  const { store } = open();
  try {
    const taskId = request(store, 'Rédige un document');
    const claim = claimDoc(store);const ids = accept(store, claim);
    store.recordProgress(claim, { ...ids, itemId: 'nested', text: '{"reply":"ok","deliverable":{"title":"Note","body":"Texte reçu', final: false });
    assert.equal(task(store, taskId).progress?.body, 'Texte reçu');
    store.recordProgress(claim, { ...ids, itemId: 'nested', text: '{"reply":"ok","noise":' + '['.repeat(10_000), final: false });
    assert.equal(task(store, taskId).progress?.body, 'Texte reçu');
    assert.equal(task(store, taskId).progress?.readable, false);
    assert.equal(task(store, taskId).status, 'running');
  } finally {
    store.close();
  }
});

test('a document longer than the short history allowance is supplied complete and reported as complete', () => {
  const { store } = open();
  try {
    const taskId = request(store, 'Rédige une note');
    const body = 'DÉBUT_DU_DOCUMENT\n' + 'contenu complet '.repeat(1000) + '\nFIN_DU_DOCUMENT';
    ok(store.dispatch({ type: 'task.edit', requestId: rid(), taskId, baseVersionId: null, title: 'Document long', body }));
    const claim = claimDoc(store);
    assert(claim.turn.input.includes(body));
    assert.doesNotMatch(claim.turn.input, /caractères omis|Extrait/);
    const plan = store.diagnostics().attempts.find(a => a.workId === claim.workId)?.plan;
    assert.deepEqual(plan?.deliverable, { kind: 'complete', chars: Array.from(body).length });
  } finally {
    store.close();
  }
});

test('a task refuses excess accumulated information without truncating or recording the rejected input', () => {
  const { store } = open();
  try {
    const taskId = request(store, 'Rédige une note');
    ok(intent(store, taskId, { kind: 'add_info', text: 'a'.repeat(6000) }));
    ok(intent(store, taskId, { kind: 'change_goal', text: 'b'.repeat(6000) }));
    assert.equal(refused(intent(store, taskId, { kind: 'add_info', text: 'X' })), 'limit_reached');
    assert.equal(task(store, taskId).events.length, 2);
    const claim = claimDoc(store);
    assert(claim.turn.input.includes('a'.repeat(6000)));
    assert(claim.turn.input.includes('b'.repeat(6000)));
  } finally {
    store.close();
  }
});

test('a review of an older version carries that provenance into synthesis without replacing the human current version', () => {
  const { store } = open();
  try {
    const taskId = request(store, 'Rédige une note', 'pixel');
    store.finishJob(claimDoc(store), documentReply('Brouillon.', 'Note', 'Ancien texte'));
    const review = claimDoc(store);
    const base = authorVersions(store.view(), task(store, taskId)).at(-1);assert(base);
    ok(store.dispatch({ type: 'task.edit', requestId: rid(), taskId, baseVersionId: base.id, title: 'Note', body: 'Texte humain prioritaire' }));
    store.finishJob(review, opinion('Avis portant sur le brouillon initial.'));
    const synthesis = claimDoc(store);
    assert.match(synthesis.turn.input, /Ce message porte sur la version 1\./);
    assert.match(synthesis.turn.input, /sa version 2 ci-dessous est prioritaire/);
    assert.match(synthesis.turn.input, /Document actuel « Note », version 2, texte complet :\nTexte humain prioritaire/);
    assert.equal(authorVersions(store.view(), task(store, taskId)).at(-1)?.body, 'Texte humain prioritaire');
  } finally {
    store.close();
  }
});

test('a reviewer that returns a document instead of an opinion fails explicitly, and a document step without one too', () => {
  const { store } = open();
  try {
    const taskId = request(store, 'Rédige', 'atlas');
    store.finishJob(claimDoc(store), opinion('Pas de document'));
    assert.equal(task(store, taskId).calls[0]?.state, 'failed');
    assert.equal(task(store, taskId).status, 'stopped');
    assert.equal(store.claimNext('doc'), null, 'a failed step is never rerun on its own');
    ok(store.dispatch({ type: 'task.continue', requestId: rid(), taskId }));
    store.finishJob(claimDoc(store), documentReply('ok', 'T', 'B'));
    store.finishJob(claimDoc(store), documentReply('Je réécris', 'T2', 'B2'));
    const view = task(store, taskId);
    assert.deepEqual(view.calls.map(c => [c.step, c.state]), [['draft', 'failed'], ['draft', 'succeeded'], ['review', 'failed']]);
    assert.equal(view.calls[2]?.error, 'La réponse de Codex ne respectait pas le format attendu. Aucune réponse n’a été enregistrée.');
    assert.deepEqual(authorVersions(store.view(), view).map(v => v.body), ['B'], 'the reviewer never writes the document');
  } finally {
    store.close();
  }
});

test('information sent after a call started waits for an identified later pass, and is sent only once a turn is accepted', () => {
  const { store } = open();
  try {
    const taskId = request(store, 'Rédige le compte rendu', 'nova');
    const draft = claimDoc(store);
    accept(store, draft);
    ok(intent(store, taskId, { kind: 'add_info', text: 'Inclure les chiffres 2025' }));
    assert.deepEqual(task(store, taskId).events[0]?.delivery, { state: 'waiting', notSent: 0 }, 'the running call never received it');
    assert.doesNotMatch(draft.turn.input, /chiffres 2025/);
    store.finishJob(draft, documentReply('Fait', 'CR', 'Corps'));

    const review = claimDoc(store);
    assert.match(review.turn.input, /Précisions ajoutées par la personne :\n- Inclure les chiffres 2025/);
    assert.deepEqual(task(store, taskId).events[0]?.delivery, { state: 'prepared', step: 'review', botId: 'nova' }, 'composed, not yet transmitted');
    store.finishJob(review, engineFailure('rpc_refused'));
    assert.deepEqual(task(store, taskId).events[0]?.delivery, { state: 'waiting', notSent: 1 }, 'a call refused before its turn transmitted nothing');

    ok(store.dispatch({ type: 'task.continue', requestId: rid(), taskId }));
    const retry = claimDoc(store);
    assert.equal(retry.botId, 'nova');
    const { turnId } = accept(store, retry);
    assert.deepEqual(task(store, taskId).events[0]?.delivery, { state: 'sent', attemptN: 2, step: 'review', botId: 'nova', turnId });
  } finally {
    store.close();
  }
});

test('a solo task with information left over waits for an explicit pass, bounded to two continuations', () => {
  const { store } = open();
  try {
    const taskId = request(store, 'Rédige');
    store.finishJob(claimDoc(store), documentReply('ok', 'T', 'v1'));
    ok(intent(store, taskId, { kind: 'add_info', text: 'Ajoute une conclusion' }));
    assert.equal(task(store, taskId).status, 'info_waiting');
    assert.equal(store.claimNext('doc'), null);
    ok(store.dispatch({ type: 'task.continue', requestId: rid(), taskId }));
    const revise = claimDoc(store);
    assert.match(revise.turn.input, /Étape : nouvelle passe[\s\S]*Ajoute une conclusion[\s\S]*Document actuel « T », version 1/);
    store.finishJob(revise, documentReply('ok', 'T', 'v2'));
    ok(store.dispatch({ type: 'task.continue', requestId: rid(), taskId }));
    store.finishJob(claimDoc(store), documentReply('ok', 'T', 'v3'));
    assert.equal(refused(store.dispatch({ type: 'task.continue', requestId: rid(), taskId })), 'limit_reached');
    const view = task(store, taskId);
    assert.equal(view.calls.length, 3);
    assert.equal(view.maxCalls, 3);
  } finally {
    store.close();
  }
});

test('the durable call cap refuses any extra attempt, interrupted calls included', () => {
  const { store, path } = open();
  const taskId = request(store, 'Rédige');
  claimDoc(store);
  assert.equal(store.recoverInterrupted(), 1);
  const view = task(store, taskId);
  assert.equal(view.status, 'stopped');
  assert.equal(store.claimNext('doc'), null, 'no automatic rerun after an interruption');
  store.close();
  const db = new DatabaseSync(path);
  try {
    const work = view.authorWorkId;
    assert.throws(() => db.prepare(`INSERT INTO attempts(id, work_id, n, state, requested_speed, context_sha256, memory_ids, started_at, lane, step, task_revision, events_through)
      VALUES ('a-extra', ?, 2, 'failed', 'standard', '', '[]', 'now', 'doc', 'draft', 1, 0)`).run(work), /budget/);
    assert.throws(() => db.prepare(`UPDATE attempts SET task_revision = 9 WHERE work_id = ?`).run(work), /frozen/);
  } finally {
    db.close();
  }
});

test('a goal changed during a call keeps its result as a proposal and stops the old plan until the person continues', () => {
  const { store } = open();
  try {
    const taskId = request(store, 'Rédige une invitation', 'pixel');
    const draft = claimDoc(store);
    ok(intent(store, taskId, { kind: 'change_goal', text: 'Finalement, un faire-part' }));
    store.finishJob(draft, documentReply('Invitation prête', 'Invitation', 'Viens'));
    let view = task(store, taskId);
    assert.equal(view.revision, 2);
    assert.equal(view.status, 'goal_changed');
    assert.deepEqual(view.proposals.map(p => [p.reason, p.state, p.revision]), [['goal_changed', 'open', 1]]);
    assert.deepEqual(authorVersions(store.view(), view), [], 'never promoted');
    assert.equal(view.handoffs.length, 0, 'the old plan does not hand an old-goal draft to the reviewer');
    assert.equal(store.claimNext('doc'), null);
    const proposal = view.proposals[0];
    assert(proposal);
    assert.equal(refused(store.dispatch({ type: 'doc.adopt', requestId: rid(), proposalId: proposal.id, seenVersionId: null, seenRevision: 1 })), 'stale_base');

    ok(store.dispatch({ type: 'task.continue', requestId: rid(), taskId }));
    const revise = claimDoc(store);
    assert.match(revise.turn.input, /Objectif modifié par la personne \(révision 2\)[\s\S]*Finalement, un faire-part/);
    store.finishJob(revise, documentReply('Faire-part prêt', 'Faire-part', 'Nous annonçons'));
    view = task(store, taskId);
    assert.equal(view.status, 'needs_decision', 'the old proposal still waits for a decision');
    ok(store.dispatch({ type: 'doc.dismiss', requestId: rid(), proposalId: proposal.id }));
    const review = claimDoc(store);
    assert.equal(review.botId, 'pixel');
    assert.match(review.turn.input, /Faire-part prêt[\s\S]*Nous annonçons/);
  } finally {
    store.close();
  }
});

test('a human edit before the first version and during the synthesis is never overwritten by a result based on another version', () => {
  const { store } = open();
  try {
    const taskId = request(store, 'Rédige la lettre', 'atlas');
    const draft = claimDoc(store);
    assert.equal(refused(store.dispatch({ type: 'version.edit', requestId: rid(), workId: task(store, taskId).authorWorkId, baseVersionId: 'v_x', title: 'x', body: 'y' })), 'invalid_transition', 'the legacy edit keeps its constraints');
    const human = ok(store.dispatch({ type: 'task.edit', requestId: rid(), taskId, baseVersionId: null, title: 'Lettre', body: 'TEXTE HUMAIN' }));
    assert.equal(human.kind, 'version');
    assert.equal(refused(store.dispatch({ type: 'task.edit', requestId: rid(), taskId, baseVersionId: null, title: 'Lettre', body: 'autre onglet' })), 'stale_base');
    store.finishJob(draft, documentReply('Brouillon', 'Lettre IA', 'TEXTE IA'));
    let view = task(store, taskId);
    assert.deepEqual(authorVersions(store.view(), view).map(v => [v.source, v.body]), [['edit', 'TEXTE HUMAIN']]);
    assert.deepEqual(view.proposals.map(p => [p.reason, p.baseVersionN, p.body]), [['base_moved', null, 'TEXTE IA']]);
    assert.equal(view.status, 'needs_decision');

    const workId = view.authorWorkId;
    const v1 = authorVersions(store.view(), view)[0]?.id ?? '';
    const publication = ok(store.dispatch({ type: 'publication.propose', requestId: rid(), workId, versionId: v1, destination: 'carnet' }));
    assert.equal(publication.kind, 'proposal');
    const proposalId = view.proposals[0]?.id ?? '';
    assert.equal(refused(store.dispatch({ type: 'doc.adopt', requestId: rid(), proposalId, seenVersionId: null, seenRevision: 1 })), 'stale_base');
    const adopted = ok(store.dispatch({ type: 'doc.adopt', requestId: rid(), proposalId, seenVersionId: v1, seenRevision: 1 }));
    assert.equal(adopted.kind, 'docProposal');
    assert.equal(store.view().works.find(w => w.id === workId)?.proposals[0]?.state, 'stale', 'adopting a version closes the old publication proposal');

    const review = claimDoc(store);
    store.finishJob(review, opinion('Raccourcis'));
    const synthesis = claimDoc(store);
    view = task(store, taskId);
    const current = authorVersions(store.view(), view).at(-1);
    ok(store.dispatch({ type: 'task.edit', requestId: rid(), taskId, baseVersionId: current?.id ?? null, title: 'Lettre', body: 'EDITION PENDANT SYNTHESE' }));
    store.finishJob(synthesis, documentReply('Synthèse', 'Lettre', 'SYNTHESE IA'));
    view = task(store, taskId);
    assert.equal(authorVersions(store.view(), view).at(-1)?.body, 'EDITION PENDANT SYNTHESE');
    assert.deepEqual(view.proposals.map(p => [p.reason, p.state]), [['base_moved', 'adopted'], ['base_moved', 'open']]);
  } finally {
    store.close();
  }
});

test('cancelling stops the chain at once; a late reply reactivates nothing and the document stays editable', () => {
  const { store } = open();
  try {
    const taskId = request(store, 'Rédige', 'pixel');
    store.finishJob(claimDoc(store), documentReply('ok', 'T', 'v1'));
    const review = claimDoc(store);
    assert.equal(store.attemptRunning(review.attemptId), true);
    ok(intent(store, taskId, { kind: 'cancel' }));
    assert.equal(store.attemptRunning(review.attemptId), false, 'the worker sees the call must stop');
    assert.equal(store.finishJob(review, opinion('Réponse tardive')).kind, 'stale');
    const view = task(store, taskId);
    assert.equal(view.status, 'cancelled');
    assert.equal(store.view().messages.some(m => m.text === 'Réponse tardive'), false);
    assert.equal(store.claimNext('doc'), null);
    assert.equal(refused(store.dispatch({ type: 'task.continue', requestId: rid(), taskId })), 'invalid_transition');
    assert.equal(refused(intent(store, taskId, { kind: 'add_info', text: 'x' })), 'invalid_transition');
    const v1 = authorVersions(store.view(), view)[0]?.id ?? null;
    ok(store.dispatch({ type: 'task.edit', requestId: rid(), taskId, baseVersionId: v1, title: 'T', body: 'v2 humaine' }));
    assert.deepEqual(view.events.map(e => [e.kind, e.delivery.state]), [['cancel', 'applied']]);
  } finally {
    store.close();
  }
});

test('a reviewer deleted before its step leaves an explicit impossible review, never a silent fallback or a success', () => {
  const { store } = open();
  try {
    const taskId = request(store, 'Rédige', 'nova');
    const draft = claimDoc(store);
    const nova = store.view().bots.find(b => b.id === 'nova');
    assert(nova);
    ok(store.dispatch({ type: 'bot.delete', requestId: rid(), botId: 'nova', confirmName: nova.name, expected: nova.deletion }));
    store.finishJob(draft, documentReply('Brouillon', 'T', 'BROUILLON GARDE'));
    const view = task(store, taskId);
    assert.equal(view.status, 'reviewer_unavailable');
    assert.equal(view.canContinue, false);
    assert.equal(view.reviewWorkId, null);
    assert.equal(store.claimNext('doc'), null);
    assert.equal(refused(store.dispatch({ type: 'task.continue', requestId: rid(), taskId })), 'invalid_transition');
    assert.deepEqual(authorVersions(store.view(), view).map(v => v.body), ['BROUILLON GARDE']);
    assert(store.view().retiredBotIds.includes('nova'), 'the task keeps an anonymous witness of its reviewer');
  } finally {
    store.close();
  }
});

test('deleting the author erases its tasks with their events, handoffs, proposals and progress, refused while a linked call has not returned', () => {
  const { store, path } = open();
  const other = ok(store.dispatch({ type: 'message.send', requestId: rid(), botId: 'pixel', text: 'AUTRE FIL', attachments: [] }));
  assert(other.kind === 'message');
  const taskId = request(store, 'Rédige', 'pixel');
  const draft = claimDoc(store);
  const ids = accept(store, draft);
  store.recordProgress(draft, { ...ids, itemId: 'i', text: '{"reply":"PROGRES', final: false });
  ok(intent(store, taskId, { kind: 'add_info', text: 'PRECISION' }));
  const mino = () => store.view().bots.find(b => b.id === 'mino');
  const deletion = () => ({ type: 'bot.delete', requestId: rid(), botId: 'mino', confirmName: 'Mino', expected: mino()?.deletion });
  assert.equal(mino()?.deletion.tasks, 1);
  assert.equal(refused(store.dispatch(deletion())), 'busy', 'a running document call');
  store.finishJob(draft, documentReply('ok', 'T', 'CORPS'));
  const review = claimDoc(store);
  store.finishJob(review, opinion('AVIS'));
  ok(intent(store, taskId, { kind: 'cancel' }));
  assert.equal(refused(store.dispatch(deletion(), { activeWorkIds: [review.workId] })), 'busy', 'cancelled but its engine run has not returned');
  ok(store.dispatch(deletion(), { activeWorkIds: [] }));
  store.close();
  const db = new DatabaseSync(path);
  try {
    for (const table of ['tasks', 'task_events', 'handoffs', 'attempt_progress', 'doc_proposals']) {
      assert.equal(Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n), 0, table);
    }
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(Number(db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE text = 'AUTRE FIL'`).get()?.n), 1);
    for (const canary of ['PROGRES', 'PRECISION', 'CORPS', 'AVIS']) {
      assert.equal(Number(db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE text LIKE ?`).get(`%${canary}%`)?.n), 0, canary);
    }
  } finally {
    db.close();
  }
});

test('the legacy retry and an early validation cannot bypass the task path', () => {
  const { store } = open();
  try {
    const taskId = request(store, 'Rédige', 'pixel');
    const draft = claimDoc(store);
    store.finishJob(draft, engineFailure('timeout'));
    const workId = task(store, taskId).authorWorkId;
    assert.equal(refused(store.dispatch({ type: 'work.retry', requestId: rid(), workId })), 'invalid_transition');
    ok(store.dispatch({ type: 'task.continue', requestId: rid(), taskId }));
    store.finishJob(claimDoc(store), documentReply('ok', 'T', 'B'));
    assert.equal(refused(store.dispatch({ type: 'work.accept', requestId: rid(), workId })), 'invalid_transition', 'the review is still planned');
    store.finishJob(claimDoc(store), opinion('bien'));
    store.finishJob(claimDoc(store), documentReply('fini', 'T', 'B2'));
    ok(store.dispatch({ type: 'work.accept', requestId: rid(), workId }));
    assert.equal(task(store, taskId).status, 'validated');
    assert.equal(refused(intent(store, taskId, { kind: 'add_info', text: 'x' })), 'invalid_transition');
    assert.equal(refused(store.dispatch({ type: 'message.send', requestId: rid(), botId: 'mino', text: '@Pixel x', attachments: [], mentions: [{ botId: 'pixel', start: 0, end: 6 }], document: { reviewerBotId: null } })), 'invalid_command');
    assert.equal(refused(store.dispatch({ type: 'message.send', requestId: rid(), botId: 'mino', text: 'x', attachments: [], document: { reviewerBotId: 'mino' } })), 'invalid_command');
  } finally {
    store.close();
  }
});

test('after a server stop during a call, the task, its partial text and its intents survive the restart and nothing restarts on its own', () => {
  const { store, path } = open();
  const taskId = request(store, 'Rédige', 'pixel');
  const draft = claimDoc(store);
  const ids = accept(store, draft);
  store.recordProgress(draft, { ...ids, itemId: 'i', text: '{"reply":"En cours","deliverable":{"title":"T","body":"Début du texte', final: false });
  ok(intent(store, taskId, { kind: 'add_info', text: 'Après le départ' }));
  assert.equal(store.recoverInterrupted(), 1, 'what shutdown does');
  store.close();
  const reopened = openStore({ path, mascots });
  try {
    assert.equal(reopened.recoverInterrupted(), 0);
    const view = task(reopened, taskId);
    assert.equal(view.status, 'stopped');
    assert.equal(view.calls[0]?.state, 'interrupted');
    assert.deepEqual([view.progress?.attemptState, view.progress?.body, view.progress?.complete], ['interrupted', 'Début du texte', false]);
    assert.deepEqual(view.events.map(e => e.delivery.state), ['waiting']);
    assert.equal(reopened.claimNext('doc'), null);
    assert.equal(reopened.claimNext('chat'), null);
    ok(reopened.dispatch({ type: 'task.continue', requestId: rid(), taskId }));
    const retry = reopened.claimNext('doc');
    assert.equal(retry?.botId, 'mino');
    assert.match(retry?.turn.input ?? '', /Après le départ/);
    assert.equal(task(reopened, taskId).calls.length, 2);
  } finally {
    reopened.close();
  }
});
