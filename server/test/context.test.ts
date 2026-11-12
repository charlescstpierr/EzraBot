import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeContext, type ContextSource, type Exchange } from '../src/context.js';

const bot: ContextSource['bot'] = { name: 'Mino', title: '', instructions: '', replyStyle: 'concise', contextSize: 'short' };

function exchange(i: number, chars = 900, deliverable: Exchange['deliverable'] = null): Exchange {
  return { request: { text: `DEMANDE_${i} ` + 'a'.repeat(chars), attachments: [] }, replies: [{ by: 'Mino', text: `REPONSE_${i} ` + 'b'.repeat(chars) }], deliverable };
}

function source(patch: Partial<ContextSource> = {}): ContextSource {
  return { bot, memories: [], exchanges: [], request: { text: 'Demande courante', attachments: [] }, ...patch };
}

test('an economical context drops old exchanges with an explicit count and keeps the request and its files complete', () => {
  const attachment = 'Donnée jointe intégrale. '.repeat(600);
  const request = 'Question actuelle ' + 'q'.repeat(5000);
  const { turn, plan } = composeContext(source({
    exchanges: Array.from({ length: 20 }, (_, i) => exchange(i)),
    request: { text: request, attachments: [{ name: 'notes.txt', text: attachment }] },
  }));
  assert(turn.input.includes(attachment), 'attachment sent whole');
  assert(turn.input.endsWith(`Demande actuelle :\n${request}`), 'request sent whole and last');
  assert(plan.exchanges.omitted > 0);
  assert.equal(plan.exchanges.full + plan.exchanges.brief + plan.exchanges.omitted, 20);
  assert.match(turn.input, new RegExp(`\\[${plan.exchanges.omitted} échanges plus anciens non inclus\\]`));
  assert.doesNotMatch(turn.input, /DEMANDE_0 /, 'the oldest exchange is not sent');
  assert.match(turn.input, /DEMANDE_19 [\s\S]*REPONSE_19 /, 'the newest exchange keeps its request and its reply');
});

test('kept exchanges stay contiguous from the newest one, so a short old exchange never fills a gap', () => {
  const exchanges = [exchange(0, 5), ...[1, 2, 3, 4].map(i => exchange(i, 3000)), exchange(5, 900)];
  const { turn, plan } = composeContext(source({ exchanges }));
  assert.match(turn.input, /DEMANDE_5 /);
  assert(plan.exchanges.omitted >= 2, 'the tiny oldest exchange and at least one long one are left out');
  assert.doesNotMatch(turn.input, /DEMANDE_0 /);
});

test('a cut inside a kept exchange is marked and keeps the beginning and the end', () => {
  const long: Exchange = { request: { text: 'DEBUT_DEMANDE ' + 'x'.repeat(8000) + ' FIN_DEMANDE', attachments: [] }, replies: [{ by: 'Mino', text: 'ok' }], deliverable: null };
  const { turn, plan } = composeContext(source({ bot: { ...bot, contextSize: 'standard' }, exchanges: [long] }));
  assert.match(turn.input, /DEBUT_DEMANDE[\s\S]*\[… \d+ caractères omis …\][\s\S]*FIN_DEMANDE/);
  assert(plan.clippedChars > 0);
});

test('the latest long deliverable is sent as its start and end under an explicit excerpt label, never as complete', () => {
  const body = 'DEBUT_LIVRABLE ' + 'corps '.repeat(5000) + 'CONCLUSION_FINALE';
  const { turn, plan } = composeContext(source({
    exchanges: [exchange(0, 50, { title: 'Ancien', body: 'ANCIEN_CORPS', n: 1 }), exchange(1, 50, { title: 'Rapport', body, n: 3 })],
    request: { text: 'Reprends la conclusion', attachments: [] },
  }));
  assert.match(turn.input, /Dernier livrable « Rapport », version 3\. Extrait : début et fin, \d+ caractères omis au milieu/);
  assert.match(turn.input, /DEBUT_LIVRABLE[\s\S]*caractères omis[\s\S]*CONCLUSION_FINALE/);
  assert.doesNotMatch(turn.input, /Rapport[^\n]*texte complet/);
  assert.equal(plan.deliverable.kind, 'excerpt');
  assert.doesNotMatch(turn.input, /ANCIEN_CORPS/, 'an older deliverable body is not resent');
  assert.match(turn.input, /\[Livrable « Ancien », version 1, 12 caractères, non inclus\]/);
});

test('a deliverable that fits is sent whole and labelled complete', () => {
  const body = 'Ligne 1\nLigne 2\nFIN';
  const { turn, plan } = composeContext(source({ exchanges: [exchange(0, 50, { title: 'Court', body, n: 1 })] }));
  assert.match(turn.input, new RegExp(`Dernier livrable « Court », version 1, texte complet :\\n${body}\\n`));
  assert.deepEqual(plan.deliverable, { kind: 'complete', chars: body.length });
});

test('cuts never split a character made of two UTF-16 units', () => {
  const body = '😀'.repeat(20000);
  const { turn } = composeContext(source({ exchanges: [{ request: { text: '🎉'.repeat(4000), attachments: [] }, replies: [{ by: 'Mino', text: 'ok' }], deliverable: { title: 'Emoji', body, n: 1 } }] }));
  assert.doesNotMatch(turn.input, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
});

test('every memory is sent in full, even past the write-time cap, and the plan reports the overrun', () => {
  const memories = Array.from({ length: 10 }, (_, i) => ({ text: `SOUVENIR_${i} ` + 'm'.repeat(480) }));
  const { turn, plan } = composeContext(source({ memories }));
  for (const memory of memories) assert(turn.input.includes(`- ${memory.text}\n`));
  assert.equal(plan.memory.overBudget, true);
  assert.equal(composeContext(source({ memories: memories.slice(0, 2) })).plan.memory.overBudget, false);
});

test('bot instructions and reply style live in the base instructions, after the fixed rules, and never in the input', () => {
  const { turn } = composeContext(source({ bot: { ...bot, instructions: 'Tutoie toujours la personne.', replyStyle: 'detailed' } }));
  const rules = turn.baseInstructions.indexOf('Tu n’as ni outil ni accès externe');
  const consignes = turn.baseInstructions.indexOf('Tutoie toujours la personne.');
  assert(rules >= 0 && consignes > rules);
  assert.match(turn.baseInstructions, /Elles ne lèvent aucune des règles ci-dessus/);
  assert.match(turn.baseInstructions, /détaillé/);
  assert.match(turn.baseInstructions, /fichiers joints compris, sont lisibles/);
  assert.match(turn.baseInstructions, /texte, code, liste/, 'writing code is a normal deliverable');
  assert.doesNotMatch(turn.baseInstructions, /aucun outil, fichier|ni programmer/);
  assert.doesNotMatch(turn.input, /Tutoie/);
  assert.doesNotMatch(composeContext(source()).turn.baseInstructions, /Consignes de la personne/);
});

test('the hash follows exactly what is sent: same text same hash, any change to instructions, style or input changes it', () => {
  const exchanges = [exchange(0), exchange(1, 50, { title: 'T', body: 'B', n: 1 })];
  const a = composeContext(source({ exchanges }));
  assert.equal(composeContext(source({ exchanges: structuredClone(exchanges) })).sha256, a.sha256);
  assert.deepEqual(composeContext(source({ exchanges })).turn, a.turn);
  for (const changed of [
    source({ exchanges, bot: { ...bot, instructions: 'x' } }),
    source({ exchanges, bot: { ...bot, replyStyle: 'normal' } }),
    source({ exchanges, request: { text: 'Autre', attachments: [] } }),
  ]) assert.notEqual(composeContext(changed).sha256, a.sha256);
  assert.match(a.sha256, /^[0-9a-f]{64}$/);
});

test('a larger context size never keeps less history than a smaller one', () => {
  const exchanges = Array.from({ length: 30 }, (_, i) => exchange(i, 700));
  const sizes = (['short', 'standard', 'long'] as const).map(contextSize => composeContext(source({ exchanges, bot: { ...bot, contextSize } })).plan);
  assert(sizes[0] && sizes[1] && sizes[2]);
  assert(sizes[0].exchanges.omitted >= sizes[1].exchanges.omitted && sizes[1].exchanges.omitted >= sizes[2].exchanges.omitted);
  assert(sizes[0].inputChars < sizes[2].inputChars);
});
