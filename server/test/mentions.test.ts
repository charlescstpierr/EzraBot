import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mentionQuery, insertMention, rebase, trimForSend } from '../web/mentions.js';
import { checkMentions } from '../src/domain.js';

test('only explicit selection makes an identified UTF16 span and survives a rename', () => {
  assert.equal(mentionQuery('a@b.com', 7), null);
  assert.equal(mentionQuery('`@Mi', 4), null);
  assert.equal(mentionQuery('```ts\n@Mi', 9), null);
  assert.deepEqual(mentionQuery('😀 @Pi', 6), { start: 3, query: 'Pi' });
  const inserted = insertMention('😀 @Pi', { start: 3, caret: 6 }, { id: 'pixel', name: 'Même Nom' });
  assert.deepEqual(inserted.span, { botId: 'pixel', start: 3, end: 12 });
  assert.deepEqual(checkMentions(inserted.text, [inserted.span]), [inserted.span]);
  assert.deepEqual(rebase(inserted.text, 'X ' + inserted.text, [inserted.span]), [{ botId: 'pixel', start: 5, end: 14 }]);
  assert.deepEqual(trimForSend('  @Nom  ', [{ botId: 'stable', start: 2, end: 6 }]), { text: '@Nom', spans: [{ botId: 'stable', start: 0, end: 4 }] });
});

test('editing, deleting or moving a selected tag inside code deactivates it', () => {
  const span = { botId: 'mino', start: 0, end: 5 };
  assert.deepEqual(rebase('@Mino salut', '@Mina salut', [span]), []);
  assert.deepEqual(rebase('@Mino salut', 'salut', [span]), []);
  assert.deepEqual(rebase('@Mino salut', '`@Mino` salut', [span]), []);
  assert.deepEqual(rebase('@Mino salut', '```\n@Mino salut\n```', [span]), []);
  assert.deepEqual(rebase('@Mino salut', '@Mino coucou', [span]), [span]);
});

test('fenced, indented and multi-backtick code suppresses invitation queries', () => {
  for (const code of ['~~~js\n@Mi', '``example @Mi', '    @Mi', '\t@Mi']) assert.equal(mentionQuery(code, code.length), null);
  assert(mentionQuery('~~~js\ncode\n~~~\n@Mi', 19));
});
