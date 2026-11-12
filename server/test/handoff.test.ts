import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { composeContext, MINO_OUTPUT_SCHEMA, OUTPUT_SCHEMA, type ContextSource } from '../src/context.js';
import { loadMascots, parseEngineReply, type EngineOutcome } from '../src/domain.js';
import { openStore, type Store } from '../src/store.js';

const mascots = loadMascots(new URL('../../assets/mascots.json', import.meta.url));
const open = () => openStore({ path: join(mkdtempSync(join(tmpdir(), 'mino-handoff-')), 'mino.sqlite'), mascots });
const REQUEST = 'Ajoute une fonction slugify avec tests,  puis documente-la dans le README.';
const proposal = { goal: 'Ajoute une fonction slugify avec tests, puis documente-la dans le README.', coordinated: true, why: 'Deux étapes séparables.' };
const reply = (handoff: typeof proposal | null): EngineOutcome => ({
  kind: 'succeeded', reply: { reply: 'Je peux confier ça.', deliverable: null, handoff },
  used: { model: 'gpt-test', effort: 'low', speed: 'standard' }, threadId: 'thread-1', turnId: 'turn-1',
});
function ask(store: Store, botId: string, text = REQUEST) {
  const sent = store.dispatch({ type: 'message.send', requestId: randomUUID(), botId, text, attachments: [] });
  assert.ok(sent.ok);
  const claim = store.claimNextJob();
  assert.ok(claim);
  return claim;
}

const source = (extra: Partial<ContextSource> = {}): ContextSource => ({
  bot: { name: 'Mino', title: 'coordinateur', instructions: '', replyStyle: 'normal', contextSize: 'standard' },
  memories: [], exchanges: [], request: { text: 'Bonjour', attachments: [] }, ...extra,
});

test('only Mino’s own chat turn may propose a mission; other bots and document steps keep their schema', () => {
  const mino = composeContext(source({ orchestrator: true }));
  assert.equal(mino.turn.outputSchema, MINO_OUTPUT_SCHEMA);
  assert.match(mino.turn.baseInstructions, /`handoff` : null, sauf/);
  const nova = composeContext(source());
  assert.equal(nova.turn.outputSchema, OUTPUT_SCHEMA);
  assert.doesNotMatch(nova.turn.baseInstructions, /handoff/);
  assert.notEqual(mino.sha256, nova.sha256);
});

test('a malformed proposal fails like any invalid reply', () => {
  assert.equal(parseEngineReply(JSON.stringify({ reply: 'x', deliverable: null, handoff: { goal: 'g', coordinated: 'oui', why: 'w' } })), null);
  assert.equal(parseEngineReply(JSON.stringify({ reply: 'x', deliverable: null, handoff: { goal: 'g', coordinated: true, why: 'w', projectId: 'p' } })), null);
  assert.deepEqual(parseEngineReply(JSON.stringify({ reply: 'x', deliverable: null }))?.handoff, undefined, 'an older reply shape stays valid');
});

test('Mino’s proposal is recorded on its reply, resolves to the person’s exact words, and creates nothing by itself', () => {
  const store = open();
  try {
    const claim = ask(store, 'mino');
    assert.equal(claim.turn.outputSchema, MINO_OUTPUT_SCHEMA);
    store.finishJob(claim, reply(proposal));
    const answer = store.view().messages.find(m => m.role === 'assistant');
    assert.deepEqual(answer?.handoff, proposal);
    assert.deepEqual(store.missionOrigin(answer?.id ?? ''), { text: REQUEST }, 'the exact request, byte for byte');
    const request = store.view().messages.find(m => m.role === 'user');
    assert.equal(store.missionOrigin(request?.id ?? ''), null, 'a person’s message is not a proposal');
    assert.equal(store.leadCandidate('nova')?.name, 'Nova');
    assert.equal(store.leadCandidate('inconnu'), null);
  } finally { store.close(); }
});

test('a proposal from another bot or in another thread is dropped and cannot be used as an origin', () => {
  const store = open();
  try {
    const claim = ask(store, 'nova');
    assert.equal(claim.turn.outputSchema, OUTPUT_SCHEMA);
    store.finishJob(claim, reply(proposal));
    const answer = store.view().messages.find(m => m.role === 'assistant');
    assert.equal(answer?.handoff, null);
    assert.equal(store.missionOrigin(answer?.id ?? ''), null);
    const plain = ask(store, 'mino', 'Bonjour');
    store.finishJob(plain, reply(null));
    const hello = store.view().messages.filter(m => m.role === 'assistant').at(-1);
    assert.equal(hello?.handoff, null);
    assert.equal(store.missionOrigin(hello?.id ?? ''), null, 'a reply without proposal is not an origin');
  } finally { store.close(); }
});
