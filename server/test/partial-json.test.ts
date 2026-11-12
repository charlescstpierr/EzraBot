import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeReplyProgress, parsePartialJson } from '../src/partial-json.js';

const answers = [
  { reply: 'Voici le plan.', deliverable: { title: 'Plan « été »', body: '# Plan\n\n- Étape 1 : \t tabulée\n- Guillemets "doubles" et \\ barre\n- Emoji 🌱 et 漢字\n- Contrôle \u0001 et \b\f\r' } },
  { reply: 'Avis : clair 👍', deliverable: null },
  { deliverable: { body: '<!doctype html><html><body><script>alert("x")</script></body></html>', title: 'Page' }, reply: 'Page prête.' },
];

const encodings = (value: unknown): string[] => [
  JSON.stringify(value),
  JSON.stringify(value, null, 2),
  JSON.stringify(value).replace(/[^\x20-\x7e]/gu, ch => [...ch].map(unit => Array.from({ length: unit.length }, (_, k) => '\\u' + unit.charCodeAt(k).toString(16).padStart(4, '0')).join('')).join('')),
];

test('every prefix of a valid answer decodes to prefixes of the final values, and the whole answer decodes exactly', () => {
  for (const answer of answers) {
    for (const encoded of encodings(answer)) {
      const final = JSON.parse(encoded) as typeof answer;
      let states = 0;
      let previous = '';
      for (let cut = 0; cut <= encoded.length; cut += 1) {
        const progress = decodeReplyProgress(encoded.slice(0, cut));
        assert(progress, `prefix ${cut} of a valid answer is readable`);
        const reply = progress.reply?.text ?? '';
        assert(final.reply.startsWith(reply), `reply prefix at ${cut}`);
        assert(!/[\ud800-\udbff]$/.test(reply) || progress.reply?.complete, 'a cut surrogate pair is withheld');
        if (progress.deliverable.state === 'object') {
          assert(final.deliverable, 'an object appears only for a real deliverable');
          const body = progress.deliverable.body?.text ?? '';
          assert(final.deliverable.body.startsWith(body), `body prefix at ${cut}`);
          if (body !== previous) states += 1;
          previous = body;
        }
        if (progress.deliverable.state === 'null') assert.equal(final.deliverable, null);
      }
      const whole = decodeReplyProgress(encoded);
      assert.deepEqual(whole?.reply, { text: final.reply, complete: true });
      if (final.deliverable) {
        assert.deepEqual(whole?.deliverable, { state: 'object', title: { text: final.deliverable.title, complete: true }, body: { text: final.deliverable.body, complete: true } });
        assert(states > 2, 'the body grows through several received states');
      } else {
        assert.deepEqual(whole?.deliverable, { state: 'null' });
      }
    }
  }
});

test('an escape cut by the stream is withheld until it is complete', () => {
  assert.deepEqual(decodeReplyProgress('{"reply":"a\\')?.reply, { text: 'a', complete: false });
  assert.deepEqual(decodeReplyProgress('{"reply":"a\\u00')?.reply, { text: 'a', complete: false });
  assert.deepEqual(decodeReplyProgress('{"reply":"a\\u00e9')?.reply, { text: 'aé', complete: false });
  assert.deepEqual(decodeReplyProgress('{"reply":"\\ud83c')?.reply, { text: '', complete: false });
  assert.deepEqual(decodeReplyProgress('{"reply":"\\ud83c\\udf31"}')?.reply, { text: '🌱', complete: true });
  assert.deepEqual(decodeReplyProgress('{"rep')?.reply, null);
});

test('text that is not JSON is never repaired into an answer', () => {
  for (const invalid of ['Voici', '{"reply":"a"}x', '{"reply":"a\\q"}', '{"reply":"line\nbreak"}', '{reply:"a"}', '{"reply":"a",}', '{"reply" "a"}', '["a"]', '{"reply":nul}', '{"reply":01}']) {
    assert.equal(decodeReplyProgress(invalid), null, invalid);
  }
  assert.deepEqual(decodeReplyProgress(''), { reply: null, deliverable: { state: 'absent' } });
  assert.deepEqual(decodeReplyProgress('{"reply":"a","deliverable":nu'), { reply: { text: 'a', complete: true }, deliverable: { state: 'absent' } });
});

test('excessive nesting is rejected without exhausting the server stack', () => {
  assert.equal(decodeReplyProgress('{"reply":"ok","noise":' + '['.repeat(10_000)), null);
  assert.equal(parsePartialJson('['.repeat(10_000) + '0' + ']'.repeat(10_000)), null);
  assert.deepEqual(decodeReplyProgress('{"reply":"after","deliverable":null}')?.reply, { text: 'after', complete: true });
});

test('the generic reader keeps nested partial values and agrees with JSON.parse on complete documents', () => {
  const document = { a: [1, -2.5e3, true, false, null, 'x y'], b: { c: '' }, d: [] };
  const encoded = JSON.stringify(document);
  const read = (node: ReturnType<typeof parsePartialJson>): unknown => {
    if (!node) return Symbol('invalid');
    if (node.kind === 'string' || node.kind === 'scalar') return node.kind === 'string' ? node.text : node.value;
    if (node.kind === 'array') return node.items.map(read);
    return Object.fromEntries([...node.fields].map(([k, v]) => [k, read(v)]));
  };
  assert.deepEqual(read(parsePartialJson(encoded)), document);
  assert.equal(parsePartialJson(encoded)?.complete, true);
  for (let cut = 0; cut < encoded.length; cut += 1) assert.notEqual(parsePartialJson(encoded.slice(0, cut)), null, `prefix ${cut}`);
  for (let cut = 1; cut < encoded.length; cut += 1) assert.equal(parsePartialJson(encoded.slice(0, cut))?.complete, false, `prefix ${cut} is incomplete`);
});
