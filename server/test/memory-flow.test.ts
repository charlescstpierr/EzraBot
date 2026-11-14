import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DEFAULT_POLICY } from '../src/admission.js';
import { HonchoConfigError, childEnv, takeHonchoConfig } from '../src/child-env.js';
import { startFakeHoncho } from './fixtures/fake-honcho.js';
import { BOT, PREFIX, startMemory } from './fixtures/memory-app.js';

const ENABLE = { type: 'memory.enable', label: 'Projet synthétique', acknowledged: true };

test('without a Honcho configuration, without a budget or with a budget of zero, nothing is enabled silently and no request leaves', async () => {
  const honcho = await startFakeHoncho();
  const off = await startMemory({ honcho: null });
  try {
    assert.deepEqual((await off.view()).memory.status, { state: 'off' });
    const refused = await off.memory(ENABLE);
    assert.deepEqual([refused.status, refused.body.code], [503, 'memory_unavailable']);
    assert.deepEqual((await off.view()).memory.scopes, []);
    assert.equal((await off.ask('Bonjour sans mémoire distante')).work.state, 'done');
  } finally {
    await off.stop();
  }
  for (const budget of [null, 0]) {
    const app = await startMemory({ honcho, budget });
    try {
      const status = (await app.view()).memory.status;
      assert.deepEqual(status, { state: 'ready', budget: budget === null ? null : { calls: 0, callsPerDay: 0 } });
      await app.accepted(ENABLE);
      await app.quiet();
      const scope = app.scopeOf(await app.view());
      assert.deepEqual([scope.state, scope.note], ['preparing', 'budget'], 'the consent is recorded locally and the refusal is visible');
      const answered = await app.ask('Une demande pendant la préparation');
      assert.deepEqual([answered.work.state, answered.work.attempt?.plan?.memory.recall?.state], ['done', 'unavailable']);
      assert.equal(app.store.admission.usage().find(u => u.budget === 'honcho')?.calls ?? 0, 0);
    } finally {
      await app.stop();
    }
  }
  assert.equal(honcho.requests.length, 0, 'the fake Honcho never received a request');
  assert.equal(Object.keys(DEFAULT_POLICY.capabilities).some(name => name.startsWith('honcho')), false, 'the default policy declares no Honcho capability');
  assert.deepEqual(DEFAULT_POLICY.budgets, { codex: { callsPerDay: 1000 }, composio: { callsPerDay: 200 } }, 'the Codex and Composio ceilings are unchanged');
  await honcho.close();
});

test('consent, import, sync and recall: each request is admitted, each mapping is read again, and the turn receives local originals with an exact provenance', async () => {
  const honcho = await startFakeHoncho();
  const app = await startMemory({ honcho });
  try {
    const legacy = app.store.dispatch({ type: 'memory.create', requestId: randomUUID(), botId: BOT, text: 'Préfère les réponses en trois points.' });
    assert(legacy.ok && legacy.result.kind === 'memory');
    const kept = app.store.dispatch({ type: 'memory.create', requestId: randomUUID(), botId: BOT, text: 'Ancien souvenir local jamais importé.' });
    assert(kept.ok);
    const before = await app.ask('Bonjour avant le consentement');
    assert.match(app.turn().input, /Préfère les réponses en trois points\./, 'before consent the local memory is sent as before');
    assert.equal(before.work.attempt?.plan?.memory.recall, undefined);
    assert.equal(honcho.requests.length, 0, 'nothing is exported before consent');

    await app.enable();
    const provisioning = honcho.requests.map(r => [r.method, r.path.replace(/ezra-essai-[0-9a-f]+/, 'W')]);
    assert.deepEqual(provisioning, [['POST', '/v3/workspaces'], ['POST', '/v3/workspaces/W/sessions'], ['POST', '/v3/workspaces/W/sessions']]);
    const [workspaceId] = [...honcho.workspaces.keys()];
    assert.match(workspaceId ?? '', new RegExp(`^${PREFIX}-[0-9a-f]{24}$`), 'the workspace name is new and random under the server prefix');
    assert.deepEqual(honcho.requests.slice(1).map(r => r.body), [
      { id: 'declarations', peers: { person: { observe_me: false, observe_others: false } } },
      { id: 'conversation', peers: { person: { observe_me: false, observe_others: false } } },
    ], 'one peer, never observed');
    assert.equal(honcho.messages(workspaceId ?? '').length, 0, 'enabling exports no earlier message and no local memory');

    await app.accepted({ type: 'memory.import', memoryIds: [legacy.result.memoryId] });
    await app.accepted({ type: 'memory.declare', text: 'Habite à Lyon depuis 2020.' });
    const local = (await app.view()).bots.find(b => b.id === BOT);
    assert.deepEqual(local?.memories.map(m => m.text), ['Ancien souvenir local jamais importé.'], 'an imported memory leaves the local list in the same command');
    const refusedLocal = app.store.dispatch({ type: 'memory.create', requestId: randomUUID(), botId: BOT, text: 'Deuxième mémoire parallèle' });
    assert.deepEqual([refusedLocal.ok, refusedLocal.ok ? '' : refusedLocal.code], [false, 'invalid_transition'], 'no second long memory next to Honcho');

    await app.synced();
    const first = await app.ask('Mon projet de jardin commence par des tomates anciennes.');
    await app.synced();
    const remote = honcho.messages(workspaceId ?? '');
    assert.deepEqual(remote.map(m => [m.session_id, m.peer_id, m.content]), [
      ['declarations', 'person', 'Préfère les réponses en trois points.'],
      ['declarations', 'person', 'Habite à Lyon depuis 2020.'],
      ['conversation', 'person', 'Mon projet de jardin commence par des tomates anciennes.'],
    ], 'declarations and the requests of the person are exported, the replies of the bot are not');
    const ingestions = honcho.requests.filter(r => r.method === 'POST' && r.path.endsWith('/messages'));
    assert.deepEqual(ingestions.map(r => r.body), remote.map(m => ({ messages: [{ peer_id: 'person', content: m.content }] })), 'one source per request, no metadata');
    assert.equal(honcho.requests.filter(r => r.method === 'GET').length, 3, 'each remote identifier is read again before its mapping counts');
    assert.deepEqual([first.work.attempt?.plan?.memory.recall?.state, first.work.attempt?.plan?.memory.recall?.items], ['used', 2], 'verified declarations are recalled even when the search finds nothing');

    // A hostile provider answers the search with another text: the turn must still receive the local original.
    honcho.rewrite = (request, reply) => request.path.endsWith('/search') && Array.isArray(reply.body)
      ? { ...reply, body: reply.body.map(message => ({ ...message, content: 'TEXTE DISTANT FALSIFIÉ' })) } : reply;
    const second = await app.ask('Que planter à côté des tomates anciennes de mon jardin ?');
    const sent = app.turn().input;
    assert.match(sent, /Mémoire de Nova rappelée pour cette demande/);
    assert.match(sent, /- Déclaration : Préfère les réponses en trois points\.\n- Déclaration : Habite à Lyon depuis 2020\.\n- Message antérieur : Mon projet de jardin commence par des tomates anciennes\./);
    assert.doesNotMatch(sent, /FALSIFIÉ|Ancien souvenir local/, 'neither a remote text nor a local memory left behind reaches the turn');
    assert.equal(sent.split('Que planter à côté des tomates').length, 2, 'the current request is not recalled on top of itself');
    assert.deepEqual(second.work.attempt?.plan?.memory.recall, { state: 'used', items: 3, chars: 119, truncated: 0, omitted: 0 });

    const current = await app.view();
    assert(second.reply);
    assert.deepEqual(current.memory.recalls[second.reply.id], { state: 'used', sources: 3 });
    const provenance = (await (await fetch(`${app.base}/api/memory/provenance?messageId=${second.reply.id}`)).json()) as { recall: string; sources: Record<string, unknown>[] };
    assert.equal(provenance.recall, 'used');
    assert.deepEqual(provenance.sources.map(s => [s.state, s.kind, s.revision, s.text]), [
      ['authorized', 'declaration', 1, 'Préfère les réponses en trois points.'],
      ['authorized', 'declaration', 1, 'Habite à Lyon depuis 2020.'],
      ['authorized', 'message', 1, 'Mon projet de jardin commence par des tomates anciennes.'],
    ]);
    const original = current.messages.find(m => m.text === 'Mon projet de jardin commence par des tomates anciennes.');
    assert.equal(provenance.sources[2]?.messageId, original?.id, 'a recalled message opens on its original in the thread');

    const usage = app.store.admission.usage().find(u => u.budget === 'honcho');
    assert.equal(usage?.calls, honcho.requests.length, 'every HTTP request had its own durable reservation');
    assert.equal(usage?.unpricedCalls, honcho.requests.length, 'an unknown cost is counted as unpriced, never as zero');
    assert.deepEqual([usage?.knownMicros, usage?.estimatedMicros], [0, 0]);
  } finally {
    await app.stop();
    await honcho.close();
  }
});

const LABEL = 'Projet synthétique';
const SUCCEEDED = {
  kind: 'succeeded' as const, reply: { reply: 'Réponse composée avec une source retirée depuis.', deliverable: null },
  used: { model: 'faux', effort: 'low', speed: 'standard' }, threadId: 'fil-synthetique', turnId: 'tour-synthetique',
};
const searches = (honcho: Awaited<ReturnType<typeof startFakeHoncho>>) => honcho.requests.filter(r => r.path.endsWith('/search')).length;
const ingestions = (honcho: Awaited<ReturnType<typeof startFakeHoncho>>) => honcho.requests.filter(r => r.method === 'POST' && r.path.endsWith('/messages'));

test('a correction, an exclusion or a forget is checked again before the recall leaves, before the composition, before the departure and before the publication', async () => {
  const honcho = await startFakeHoncho();
  const app = await startMemory({ honcho });
  assert(app.desk);
  try {
    await app.enable();
    await app.accepted({ type: 'memory.declare', text: 'Allergique aux arachides.' });
    await app.accepted({ type: 'memory.declare', text: 'Travaille le lundi à Nantes.' });
    await app.synced();
    const declaration = async (text: string) => {
      const found = app.scopeOf(await app.view()).declarations.find(d => d.text === text);
      assert(found, text);
      return found;
    };

    const request = app.send('Quel repas préparer pour lundi ?');
    const plan = app.store.planRecall();
    assert(plan.kind === 'search');
    app.apply({ type: 'memory.exclude', target: { kind: 'declaration', declarationId: (await declaration('Travaille le lundi à Nantes.')).declarationId } });
    const sent = searches(honcho);
    assert.deepEqual(await app.desk.recall(plan), { kind: 'none' });
    assert.equal(searches(honcho), sent, 'the search planned before the exclusion never left');

    const second = app.store.planRecall();
    assert(second.kind === 'search');
    const found = await app.desk.recall(second);
    assert.equal(found.kind, 'found');
    app.apply({ type: 'memory.correct', declarationId: (await declaration('Allergique aux arachides.')).declarationId, baseRevision: 1, text: 'Allergique aux noix.' });
    assert.equal(app.store.claimNext('chat', found), 'replan', 'nothing is claimed with a recall of the older generation');
    await app.synced();
    const third = app.store.planRecall();
    assert(third.kind === 'search');
    const claim = app.store.claimNext('chat', await app.desk.recall(third));
    assert(claim && claim !== 'replan');
    assert.match(claim.turn.input, /- Déclaration : Allergique aux noix\./);
    assert.doesNotMatch(claim.turn.input, /arachides|Nantes/, 'the corrected and the excluded versions are in no part of the text');

    app.apply({ type: 'memory.exclude', target: { kind: 'declaration', declarationId: (await declaration('Allergique aux noix.')).declarationId } });
    const started = app.turnsStarted();
    const ran = await app.chat.run({
      turn: claim.turn, choice: claim.choice, signal: new AbortController().signal,
      onStage() {}, onThread() {}, onTurn() {}, depart: () => app.store.depart(claim),
    });
    assert.equal(ran.kind, 'failed', 'the engine asked for its permit after the exclusion and was refused');
    assert.equal(app.turnsStarted(), started, 'no turn left for the App Server');
    assert.deepEqual(app.store.finishJob(claim, ran), { kind: 'recorded', state: 'failed' });
    const failed = (await app.view()).works.find(w => w.id === request.workId);
    assert.match(failed?.attempt?.error ?? '', /La mémoire de cette conversation a changé/);

    const later = app.send('Une autre demande pour mardi ?');
    const fourth = app.store.planRecall();
    const leaving = app.store.claimNext('chat', fourth.kind === 'search' ? await app.desk.recall(fourth) : fourth);
    assert(leaving && leaving !== 'replan');
    assert.deepEqual(app.store.depart(leaving), { ok: true });
    app.apply({ type: 'memory.forget', confirmLabel: LABEL });
    assert.deepEqual(app.store.finishJob(leaving, SUCCEEDED), { kind: 'recorded', state: 'failed' }, 'a turn that left before the forget records a failure when it comes back');
    const after = await app.view();
    assert.equal(after.messages.some(m => m.role === 'assistant' && m.workId === later.workId), false, 'no reply was published');
    assert.match(after.works.find(w => w.id === later.workId)?.attempt?.error ?? '', /La mémoire de cette conversation a changé/);
  } finally {
    await app.stop();
    await honcho.close();
  }
});

test('a turn in flight is stopped when a source it used is corrected: nothing is published, and the retry is composed again', async () => {
  const honcho = await startFakeHoncho();
  const app = await startMemory({ honcho, scenario: 'gated' });
  try {
    await app.enable();
    await app.accepted({ type: 'memory.declare', text: 'Préfère le thé vert.' });
    await app.synced();
    const workId = await app.say('Que boire ce soir ?');
    await app.until(v => v.works.find(w => w.id === workId)?.attempt?.turnId != null, 'the App Server accepted the turn');
    assert.match(app.turn().input, /Préfère le thé vert\./);
    const [declared] = app.scopeOf(await app.view()).declarations;
    await app.accepted({ type: 'memory.correct', declarationId: declared?.declarationId, baseRevision: 1, text: 'Préfère le café serré.' });
    const stopped = await app.until(v => v.works.find(w => w.id === workId)?.state === 'failed', 'the open turn is refused');
    assert.match(stopped.works.find(w => w.id === workId)?.attempt?.error ?? '', /La mémoire de cette conversation a changé/);
    app.openGate();
    await app.quiet();
    assert.equal((await app.view()).messages.some(m => m.role === 'assistant' && m.workId === workId), false, 'the stopped turn published nothing, even once the engine could answer');
    await app.synced();
    assert.equal((await app.post('/api/commands', { type: 'work.retry', requestId: randomUUID(), workId })).status, 200);
    await app.until(v => v.works.find(w => w.id === workId)?.state === 'done', 'the retry answers');
    assert.match(app.turn().input, /Préfère le café serré\./);
    assert.doesNotMatch(app.turn().input, /thé vert/);
  } finally {
    await app.stop();
    await honcho.close();
  }
});

test('an excluded request leaves every later context with the replies composed with it, directly or through an earlier reply; its other sources stay', async () => {
  const honcho = await startFakeHoncho();
  const app = await startMemory({ honcho });
  try {
    await app.ask('Demande ancienne avant le consentement.');
    await app.enable();
    await app.ask('Premier sujet : les abeilles du rucher.');
    await app.synced();
    const second = await app.ask('Deuxième sujet : la récolte du miel.');
    await app.synced();
    await app.ask('Troisième sujet : les pots en verre.');
    await app.synced();
    assert.equal(app.turn().input.split('\nPersonne : ').length - 1, 3, 'before the exclusion the three earlier exchanges are in the history');
    const first = (await app.view()).messages.find(m => m.text === 'Premier sujet : les abeilles du rucher.');
    assert(first && second.reply);
    await app.accepted({ type: 'memory.exclude', target: { kind: 'message', messageId: first.id } });
    assert.deepEqual(app.scopeOf(await app.view()).excludedMessageIds, [first.id]);

    await app.ask('Quatrième sujet : la récolte suivante.');
    const { input } = app.turn();
    assert.doesNotMatch(input, /abeilles/, 'the excluded original is in no part of the text');
    assert.deepEqual(input.split('\nPersonne : ').slice(1).map(part => part.split('\n')[0]), ['Demande ancienne avant le consentement.'],
      'the replies that received the excluded request, and the replies built on those, left the history');
    assert.match(input, /- Message antérieur : Deuxième sujet : la récolte du miel\./, 'a request of the person that is still authorized stays recallable as an original');

    const provenance = (await (await fetch(`${app.base}/api/memory/provenance?messageId=${second.reply.id}`)).json()) as { sources: Record<string, unknown>[] };
    assert.deepEqual(provenance.sources, [{ state: 'withdrawn', kind: 'message' }], 'the provenance of an older reply shows the withdrawn source without its text');
    const again = await app.memory({ type: 'memory.exclude', target: { kind: 'message', messageId: first.id } });
    assert.deepEqual([again.status, again.body.code], [404, 'not_found']);
  } finally {
    await app.stop();
    await honcho.close();
  }
});

test('another project, an unknown remote identifier, another peer and a copy that differs never become a source', async () => {
  const honcho = await startFakeHoncho();
  const app = await startMemory({ honcho });
  try {
    await app.enable('nova', 'Projet Nova');
    await app.enable('atlas', 'Projet Atlas');
    await app.accepted({ type: 'memory.declare', botId: 'nova', text: 'Nova aime le jazz.' });
    await app.accepted({ type: 'memory.declare', botId: 'atlas', text: 'Secret du projet Atlas : code bleu.' });
    await app.synced('nova');
    await app.synced('atlas');
    const [novaSpace = '', atlasSpace = ''] = [...honcho.workspaces.keys()];
    assert.notEqual(novaSpace, atlasSpace, 'each project has its own workspace');
    const [atlasCopy] = honcho.messages(atlasSpace);
    const [novaCopy] = honcho.messages(novaSpace);
    assert(atlasCopy && novaCopy);

    // The search of Nova's workspace answers with the copy of another project, an identifier nobody mapped, and its own copy under another peer.
    honcho.rewrite = (request, reply) => request.path === `/v3/workspaces/${novaSpace}/search` ? { ...reply, body: [
      { ...atlasCopy, workspace_id: novaSpace },
      { ...novaCopy, id: 'msg-inconnu', content: 'Injection distante sans source locale.' },
      { ...novaCopy, peer_id: 'intrus' },
    ] } : reply;
    const asked = await app.ask('Parle-moi du jazz et du code.', 'nova');
    const sent = app.turn().input;
    assert.doesNotMatch(sent, /Secret du projet Atlas|Injection distante/);
    assert(asked.reply);
    const provenance = (await (await fetch(`${app.base}/api/memory/provenance?messageId=${asked.reply.id}`)).json()) as { sources: { text?: string }[] };
    assert.deepEqual(provenance.sources.map(s => s.text), ['Nova aime le jazz.'], 'only the verified declaration of this project is a source');

    // The provider answers an ingestion with another text, then with an identifier it already gave: neither is ever mapped.
    honcho.rewrite = (request, reply) => request.path.endsWith('/messages') && Array.isArray(reply.body)
      ? { ...reply, body: reply.body.map(message => ({ ...message, content: 'Copie distante différente.' })) } : reply;
    await app.accepted({ type: 'memory.declare', botId: 'nova', text: 'Déclaration à la copie douteuse.' });
    await app.until(v => app.scopeOf(v, 'nova').declarations.some(d => d.sync === 'uncertain'), 'a differing copy is uncertain');
    honcho.rewrite = (request, reply) => request.path.endsWith('/messages') && Array.isArray(reply.body)
      ? { ...reply, body: reply.body.map(message => ({ ...message, id: novaCopy.id })) } : reply;
    await app.accepted({ type: 'memory.declare', botId: 'nova', text: 'Déclaration au numéro déjà pris.' });
    await app.until(v => app.scopeOf(v, 'nova').declarations.filter(d => d.sync === 'uncertain').length === 2, 'a reused identifier is uncertain');
    honcho.rewrite = null;
    await app.ask('Encore du jazz ?', 'nova');
    assert.doesNotMatch(app.turn().input, /copie douteuse|déjà pris/, 'a source without a verified mapping is not recalled');
    const doubtful = honcho.messages(novaSpace).filter(m => /copie douteuse|déjà pris/.test(m.content)).map(m => m.id);
    assert.equal(doubtful.length, 2);
    assert.equal(honcho.requests.some(r => r.method === 'GET' && doubtful.some(id => r.path.endsWith(`/${id}`))), false, 'no read was spent on a copy that already failed its check');
  } finally {
    await app.stop();
    await honcho.close();
  }
});

test('a workspace that already existed is refused, and the next try uses a new name', async () => {
  const honcho = await startFakeHoncho();
  const app = await startMemory({ honcho });
  try {
    honcho.intercept = request => request.path === '/v3/workspaces' ? { status: 200, body: request.body } : undefined;
    await app.accepted(ENABLE);
    const refused = await app.until(v => app.scopeOf(v).note === 'workspace_not_new', 'a 200 is not a new workspace');
    assert.deepEqual([app.scopeOf(refused).state, app.scopeOf(refused).resumable], ['preparing', true]);
    assert.equal(honcho.requests.length, 1, 'no session was provisioned in a workspace that is not new');
    honcho.intercept = null;
    await app.accepted({ type: 'memory.resume' });
    await app.until(v => app.scopeOf(v).state === 'active', 'the second workspace is confirmed');
    const names = honcho.requests.filter(r => r.path === '/v3/workspaces').map(r => (r.body as { id: string }).id);
    assert.equal(new Set(names).size, 2, 'the refused name was not tried again');
  } finally {
    await app.stop();
    await honcho.close();
  }
});

test('an ingestion without an answer stays uncertain and is never sent again; only the person asks to look again', async () => {
  const honcho = await startFakeHoncho();
  const app = await startMemory({ honcho, timeoutMs: 150 });
  try {
    await app.enable();
    honcho.intercept = request => request.path.endsWith('/messages') ? 'lose' : undefined;
    await app.accepted({ type: 'memory.declare', text: 'Arrivée chez Honcho, réponse perdue.' });
    await app.until(v => app.scopeOf(v).declarations[0]?.sync === 'uncertain', 'the lost answer is uncertain');
    honcho.intercept = request => request.path.endsWith('/messages') ? 'hang' : undefined;
    await app.accepted({ type: 'memory.declare', text: 'Jamais arrivée chez Honcho.' });
    const uncertain = await app.until(v => app.scopeOf(v).declarations.every(d => d.sync === 'uncertain'), 'the dropped request is uncertain');
    assert.deepEqual([app.scopeOf(uncertain).note, app.scopeOf(uncertain).resumable], ['timeout', true]);
    await new Promise(resolve => setTimeout(resolve, 300));
    await app.quiet();
    const sent = () => ingestions(honcho).map(r => (r.body as { messages: { content: string }[] }).messages[0]?.content);
    assert.deepEqual(sent(), ['Arrivée chez Honcho, réponse perdue.', 'Jamais arrivée chez Honcho.'], 'no ingestion was sent a second time');
    honcho.intercept = null;
    assert.equal((await app.ask('Une demande sans mémoire vérifiée ?')).work.attempt?.plan?.memory.recall?.state, 'empty', 'an uncertain source is not recalled');
    await app.until(v => app.scopeOf(v).messages.verified === 1, 'the new request is exported as usual');

    await app.accepted({ type: 'memory.resume' });
    const reconciled = await app.until(v => app.scopeOf(v).declarations[0]?.sync === 'verified', 'the copy that did arrive is found once and read again');
    await app.quiet();
    assert.deepEqual(app.scopeOf(await app.view()).declarations.map(d => d.sync), ['verified', 'uncertain'], 'without one exact candidate the source stays uncertain');
    assert.equal(app.scopeOf(reconciled).state, 'active');
    assert.deepEqual(sent(), ['Arrivée chez Honcho, réponse perdue.', 'Jamais arrivée chez Honcho.', 'Une demande sans mémoire vérifiée ?'], 'the reconciliation searched and read, and ingested nothing');
    assert.deepEqual(honcho.requests.filter(r => r.path.endsWith('/search') && (r.body as { filters?: unknown }).filters).map(r => (r.body as { filters: unknown }).filters),
      [{ session_id: 'declarations' }, { session_id: 'declarations' }]);
  } finally {
    await app.stop();
    await honcho.close();
  }
});

test('after a crash a request that had left is uncertain, one that had not left is released, and nothing leaves again by itself', async () => {
  const honcho = await startFakeHoncho();
  const first = await startMemory({ honcho: null });
  const path = first.path;
  await first.stop();
  const open = () => startMemory({ honcho, path });
  let app = await open();
  try {
    // The desk is closed first, so the store alone holds the request, as after a crash between the departure and the answer.
    await app.desk?.close();
    app.apply(ENABLE);
    const requestId = app.store.memory.next();
    assert(requestId);
    const permit = app.store.memory.begin(requestId);
    assert.equal(permit?.kind, 'workspace');
    await app.stop();
    assert.equal(honcho.requests.length, 0);

    app = await open();
    await app.quiet();
    const recovered = app.scopeOf(await app.view());
    assert.deepEqual([recovered.state, recovered.note, recovered.resumable], ['preparing', 'interrupted', true]);
    assert.equal(honcho.requests.length, 0, 'the restart sent nothing for the interrupted request');
    assert.equal(app.store.admission.usage().find(u => u.budget === 'honcho')?.calls, 1, 'a request that left keeps its slot');

    await app.accepted({ type: 'memory.resume' });
    await app.until(v => app.scopeOf(v).state === 'active', 'the person asked again and a new workspace is confirmed');
    assert.notEqual((honcho.requests[0]?.body as { id: string }).id, permit?.workspaceId, 'the interrupted workspace name is never used again');

    await app.desk?.close();
    app.apply({ type: 'memory.forget', confirmLabel: LABEL });
    const withdrawal = app.store.memory.next();
    assert(withdrawal);
    assert.deepEqual(app.store.memory.begin(withdrawal)?.kind, 'withdraw');
    await app.stop();
    app = await open();
    await app.until(v => app.scopeOf(v).state === 'withdrawal_unverified', 'a forget whose first withdrawal was in flight at the crash still closes');
    assert.deepEqual(honcho.requests.filter(r => r.method === 'DELETE').map(r => r.path.split('/').slice(4).join('/')), ['sessions/conversation', ''],
      'only the withdrawals that had not left were sent');
  } finally {
    await app.stop();
    await honcho.close();
  }
});

test('a forget suspends at once, an acknowledgement reopens nothing, and a reset opens a new empty workspace that a late ingestion never reaches', async () => {
  const honcho = await startFakeHoncho();
  const app = await startMemory({ honcho });
  try {
    await app.enable();
    await app.accepted({ type: 'memory.declare', text: 'Déclaration faite avant l’oubli.' });
    await app.ask('Message avant l’oubli sur les orchidées.');
    await app.synced();
    const [oldSpace = ''] = [...honcho.workspaces.keys()];

    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    honcho.intercept = async request => {
      if (request.path.endsWith('/conversation/messages')) await gate;
    };
    await app.ask('Message en vol pendant l’oubli sur les orchidées.');
    await app.until(() => ingestions(honcho).length === 3, 'the ingestion of the last request is in flight');

    const wrong = await app.memory({ type: 'memory.forget', confirmLabel: 'Autre nom' });
    assert.deepEqual([wrong.status, wrong.body.code], [409, 'stale_base']);
    const before = searches(honcho);
    await app.accepted({ type: 'memory.forget', confirmLabel: LABEL });
    assert.equal(app.scopeOf(await app.view()).state, 'withdrawal_pending');
    assert.equal(honcho.requests.filter(r => r.method === 'DELETE').length, 0, 'the scope is closed before any answer of the provider');
    const during = await app.ask('Une demande pendant la suspension.');
    assert.equal(during.work.attempt?.plan?.memory.recall?.state, 'suspended');
    assert.equal(searches(honcho), before, 'a suspended scope sends no search');
    assert.doesNotMatch(app.turn().input, /avant l’oubli|en vol/, 'forgotten originals are in neither the recall nor the history');
    assert.match(app.turn().input, /Mémoire de Nova indisponible pour ce tour/);

    release();
    const closed = await app.until(v => app.scopeOf(v).state === 'withdrawal_unverified', 'the withdrawal requests ended');
    assert.equal(app.scopeOf(closed).note, 'purge_unverified');
    assert.deepEqual(honcho.requests.filter(r => r.method === 'DELETE').map(r => r.path.replace(oldSpace, 'W')),
      ['/v3/workspaces/W/sessions/declarations', '/v3/workspaces/W/sessions/conversation', '/v3/workspaces/W']);
    assert.equal(honcho.messages(oldSpace).some(m => m.content.startsWith('Message en vol')), true, 'the late ingestion reached the old workspace only');
    const declare = await app.memory({ type: 'memory.declare', text: 'Déclaration pendant la suspension.' });
    assert.deepEqual([declare.status, declare.body.code], [409, 'invalid_transition']);
    assert.equal((await app.ask('Toujours suspendue ?')).work.attempt?.plan?.memory.recall?.state, 'suspended', 'three acknowledgements reopen nothing');

    assert.equal((await app.memory({ type: 'memory.reset', confirmLabel: LABEL })).status, 422, 'a reset needs its explicit acknowledgement');
    assert.equal((await app.memory({ type: 'memory.reset', confirmLabel: 'Autre nom', acknowledged: true })).status, 409);
    await app.accepted({ type: 'memory.reset', confirmLabel: LABEL, acknowledged: true });
    await app.until(v => app.scopeOf(v).state === 'active', 'the new workspace is confirmed');
    const newSpace = [...honcho.workspaces.keys()].find(name => name !== oldSpace) ?? '';
    assert.match(newSpace, new RegExp(`^${PREFIX}-[0-9a-f]{24}$`));
    await app.quiet();
    assert.equal(honcho.messages(newSpace).length, 0, 'no older declaration, history or request in flight was sent to the new workspace');
    assert.deepEqual(app.scopeOf(await app.view()).declarations, [], 'forgotten declarations are not proposed again');

    await app.ask('Nouveau départ sur les orchidées.');
    await app.synced();
    assert.deepEqual(honcho.messages(newSpace).map(m => m.content), ['Nouveau départ sur les orchidées.']);
    assert.doesNotMatch(app.turn().input, /avant l’oubli|en vol/);
    assert.equal(honcho.requests.filter(r => r.method === 'POST' && r.path.startsWith(`/v3/workspaces/${oldSpace}/`) && honcho.requests.indexOf(r) > honcho.requests.findIndex(d => d.method === 'DELETE')).length, 0,
      'nothing is written to the old workspace after its withdrawal was asked');
  } finally {
    await app.stop();
    await honcho.close();
  }
});

test('when the search fails or the budget is spent the turn answers with no memory at all, and the scope keeps its real state', async () => {
  const honcho = await startFakeHoncho();
  const app = await startMemory({ honcho });
  try {
    await app.enable();
    await app.accepted({ type: 'memory.declare', text: 'Préfère les trains de nuit.' });
    await app.synced();
    honcho.intercept = request => request.path.endsWith('/search') ? { status: 503, body: {} } : undefined;
    const failed = await app.ask('Comment voyager vers Vienne ?');
    assert.deepEqual([failed.work.state, failed.work.attempt?.plan?.memory.recall?.state], ['done', 'unavailable']);
    assert.match(app.turn().input, /Mémoire de Nova indisponible pour ce tour/);
    assert.doesNotMatch(app.turn().input, /trains de nuit/, 'without Honcho not even a local declaration is sent');
    assert.equal(app.scopeOf(await app.view()).state, 'active');
    honcho.intercept = null;
    assert.equal((await app.ask('Et vers Prague ?')).work.attempt?.plan?.memory.recall?.state, 'used');
  } finally {
    await app.stop();
  }
  const limited = await startMemory({ honcho, budget: 5 });
  try {
    const sent = honcho.requests.length;
    await limited.enable();
    await limited.accepted({ type: 'memory.declare', text: 'Déclaration qui consomme le reste du budget.' });
    await limited.synced();
    assert.equal(honcho.requests.length - sent, 5, 'three provisioning requests, one ingestion, one read');
    const answered = await limited.ask('Une demande une fois le plafond atteint ?');
    assert.deepEqual([answered.work.state, answered.work.attempt?.plan?.memory.recall?.state], ['done', 'unavailable']);
    assert.equal(honcho.requests.length - sent, 5, 'no request leaves beyond the ceiling');
    assert.equal(limited.scopeOf(await limited.view()).note, 'budget');
    assert.deepEqual(limited.store.admission.usage().find(u => u.budget === 'codex')?.callsPerDay, 1000);
  } finally {
    await limited.stop();
    await honcho.close();
  }
});

test('a document step and a deleted character follow the same guards', async () => {
  const honcho = await startFakeHoncho();
  const app = await startMemory({ honcho });
  try {
    await app.enable();
    const request = app.send('Rédige une note sur les marées.', { document: { reviewerBotId: null } });
    const claim = app.store.claimNext('doc');
    assert(claim);
    assert.deepEqual(app.store.depart(claim), { ok: true });
    app.store.bindThread(claim, 'fil-doc');
    app.store.bindTurn(claim, 'tour-doc');
    app.store.recordProgress(claim, { threadId: 'fil-doc', turnId: 'tour-doc', itemId: 'i1', text: '{"reply":"Début visible","deliverable":{"title":"Marées","body":"Texte en cours"}}', final: false });
    assert.equal((await app.view()).tasks[0]?.progress?.reply, 'Début visible');
    app.apply({ type: 'memory.exclude', target: { kind: 'message', messageId: request.messageId } });
    app.store.recordProgress(claim, { threadId: 'fil-doc', turnId: 'tour-doc', itemId: 'i1', text: '{"reply":"Suite après le retrait","deliverable":null}', final: true });
    const outcome = { ...SUCCEEDED, reply: { reply: 'Voici la note.', deliverable: { title: 'Marées', body: 'Note composée avec la demande retirée.' } } };
    assert.deepEqual(app.store.finishJob(claim, outcome), { kind: 'recorded', state: 'failed' });
    const after = await app.view();
    assert.deepEqual([after.works.find(w => w.id === request.workId)?.versions.length, after.tasks[0]?.progress?.reply, after.tasks[0]?.progress?.readable], [0, '', false],
      'no version was written and the text already received is no longer shown');
    assert.equal(after.messages.some(m => m.role === 'assistant'), false);
    assert.equal(app.store.dispatch({ type: 'task.continue', requestId: randomUUID(), taskId: after.tasks[0]?.id ?? '' }).ok, true);
    assert.equal(app.store.claimNext('doc'), null, 'a step whose request was withdrawn is closed before any reservation');
    assert.match((await app.view()).tasks[0]?.calls.at(-1)?.error ?? '', /La mémoire de cette conversation a changé/);

    const nova = (await app.view()).bots.find(b => b.id === BOT);
    assert(nova);
    const deletion = app.store.dispatch({ type: 'bot.delete', requestId: randomUUID(), botId: BOT, confirmName: nova.name, expected: nova.deletion });
    assert.deepEqual([deletion.ok, deletion.ok ? '' : deletion.code], [false, 'busy'], 'a character with an open Honcho project is forgotten before it is deleted');
    await app.accepted({ type: 'memory.forget', confirmLabel: LABEL });
    await app.until(v => app.scopeOf(v).state === 'withdrawal_unverified', 'the withdrawal requests ended');
    const closed = (await app.view()).bots.find(b => b.id === BOT);
    assert(closed);
    const erased = app.store.dispatch({ type: 'bot.delete', requestId: randomUUID(), botId: BOT, confirmName: closed.name, expected: closed.deletion });
    assert.equal(erased.ok, true, erased.ok ? '' : erased.message);
    assert.deepEqual((await app.view()).memory.scopes, []);
  } finally {
    await app.stop();
    await honcho.close();
  }
});

test('the Honcho key and address reach no child process, prompt, view, log or database, and the workspace name stays in the database only', async () => {
  const env: NodeJS.ProcessEnv = {
    PATH: '/bin', HONCHO_BASE_URL: 'https://honcho.exemple.invalid/', HONCHO_API_KEY: ' cle-lue-une-fois ', HONCHO_WORKSPACE_PREFIX: 'ezra',
    HONCHO_AUTRE: 'x', honcho_minuscule: 'y',
  };
  assert.deepEqual(takeHonchoConfig(env), { baseUrl: 'https://honcho.exemple.invalid/', apiKey: 'cle-lue-une-fois', workspacePrefix: 'ezra', timeoutMs: 8000 });
  assert.deepEqual(Object.keys(env), ['PATH'], 'every HONCHO_* variable is removed once read');
  assert.equal(takeHonchoConfig({ PATH: '/bin' }), null);
  for (const partial of [
    { HONCHO_API_KEY: 'cle' },
    { HONCHO_BASE_URL: 'http://honcho.exemple.invalid', HONCHO_API_KEY: 'cle', HONCHO_WORKSPACE_PREFIX: 'ezra' },
    { HONCHO_BASE_URL: 'https://honcho.exemple.invalid', HONCHO_API_KEY: 'cle', HONCHO_WORKSPACE_PREFIX: 'deux mots' },
    { HONCHO_BASE_URL: 'https://honcho.exemple.invalid', HONCHO_API_KEY: 'cle', HONCHO_WORKSPACE_PREFIX: 'ezra', HONCHO_TIMEOUT_MS: 'bientôt' },
  ]) {
    const given: NodeJS.ProcessEnv = { ...partial };
    assert.throws(() => takeHonchoConfig(given), HonchoConfigError);
    assert.deepEqual(Object.keys(given), [], 'an invalid configuration is removed from the environment too');
  }
  assert.deepEqual(Object.keys(childEnv({ PATH: '/bin', HONCHO_API_KEY: 'cle', honcho_base_url: 'u', COMPOSIO_API_KEY: 'c' })), ['PATH']);

  process.env.HONCHO_API_KEY = 'cle-restee-dans-l-environnement';
  process.env.HONCHO_BASE_URL = 'https://reste.exemple.invalid';
  const honcho = await startFakeHoncho('cle-synthetique-a-ne-jamais-voir');
  const app = await startMemory({ honcho });
  try {
    await app.enable();
    await app.accepted({ type: 'memory.declare', text: 'Déclaration sans secret.' });
    await app.synced();
    const asked = await app.ask('Une demande sans secret ?');
    await app.synced();
    assert(asked.reply);
    assert.deepEqual(app.childEnv(), [], 'the engine child received no provider variable');
    const [workspace = ''] = [...honcho.workspaces.keys()];
    const address = new URL(honcho.url).host;
    const exposed = [
      JSON.stringify(await app.view()), JSON.stringify(app.store.diagnostics()), JSON.stringify(app.logs), app.turn().base, app.turn().input,
      await (await fetch(`${app.base}/api/memory/provenance?messageId=${asked.reply.id}`)).text(),
    ].join('\n');
    for (const secret of [honcho.key, address, workspace, 'cle-restee-dans-l-environnement', 'reste.exemple.invalid']) {
      assert.equal(exposed.includes(secret), false, `« ${secret} » is in no view, log or prompt`);
    }
    assert.deepEqual([...new Set(app.logs.flatMap(entry => Object.keys(entry)))].filter(key => !['event', 'action', 'ok', 'code'].includes(key)), [], 'logs carry categories only');
    assert(app.logs.length >= 6);
  } finally {
    await app.stop();
    await honcho.close();
    delete process.env.HONCHO_API_KEY;
    delete process.env.HONCHO_BASE_URL;
  }
  const stored = [app.path, `${app.path}-wal`].filter(file => existsSync(file)).map(file => readFileSync(file).toString('latin1')).join('');
  const [workspace = ''] = [...honcho.workspaces.keys()];
  for (const secret of [honcho.key, new URL(honcho.url).host]) assert.equal(stored.includes(secret), false, 'the key and the address are never written to SQLite');
  assert.equal(stored.includes(workspace), true, 'the mapping keeps the workspace name on the server');
});

test('a request written before the consent is never sent to Honcho as a search query', async () => {
  const honcho = await startFakeHoncho();
  const app = await startMemory({ honcho });
  try {
    const early = app.send('Demande écrite avant mon accord.');
    app.apply(ENABLE);
    await app.until(v => app.scopeOf(v).state === 'active', 'the scope is active');
    assert.deepEqual(app.store.planRecall(), { kind: 'none' });
    const claim = app.store.claimNext('chat', { kind: 'none' });
    assert(claim && claim !== 'replan');
    assert.match(claim.turn.input, /Mémoire de Nova indisponible pour ce tour/);
    assert.equal(searches(honcho), 0);
    assert.equal(honcho.messages([...honcho.workspaces.keys()][0] ?? '').length, 0, 'the earlier request was not exported either');
    assert.equal((await app.view()).works.find(w => w.id === early.workId)?.attempt?.plan?.memory.recall?.state, 'unavailable');
  } finally {
    await app.stop();
    await honcho.close();
  }
});

test('a recall planned for another call is not used, and a call that could not be planned leaves with a visible absence of memory', async () => {
  const honcho = await startFakeHoncho();
  const app = await startMemory({ honcho });
  assert(app.desk);
  try {
    await app.enable();
    await app.accepted({ type: 'memory.declare', text: 'Préfère les musées le matin.' });
    await app.synced();
    const first = app.send('Quel musée visiter demain ?');
    const plan = app.store.planRecall();
    assert(plan.kind === 'search');
    const found = await app.desk.recall(plan);
    assert.equal(app.store.dispatch({ type: 'work.cancel', requestId: randomUUID(), workId: first.workId }).ok, true);
    const second = app.send('Et quel musée après-demain ?');
    assert.equal(app.store.claimNext('chat', found), 'replan', 'the search of the cancelled call is not given to the next one');
    assert.equal(app.store.claimNext('chat', { kind: 'none' }), 'replan', 'a call that needs a recall is not claimed without one');
    assert.equal((await app.view()).works.find(w => w.id === second.workId)?.attempts, 0, 'nothing was claimed');
    const forced = app.store.claimNext('chat', { kind: 'forced' });
    assert(forced && forced !== 'replan');
    assert.equal(forced.workId, second.workId);
    assert.match(forced.turn.input, /Mémoire de Nova indisponible pour ce tour/);
    assert.doesNotMatch(forced.turn.input, /musées le matin/);
    assert.equal((await app.view()).works.find(w => w.id === second.workId)?.attempt?.plan?.memory.recall?.state, 'unavailable');
  } finally {
    await app.stop();
    await honcho.close();
  }
});
