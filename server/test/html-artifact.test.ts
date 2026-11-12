import assert from 'node:assert/strict';
import { test } from 'node:test';
import { htmlDocument } from '../src/html-artifact.js';

const page = '<!doctype html><html lang="fr"><head><style>body{color:red}</style></head><body><button onclick="this.textContent=2">1</button><script>const x = "<tag>";</script></body></html>';

test('HTML documents and explicitly labelled single HTML blocks preserve their exact runnable source', () => {
  assert.equal(htmlDocument(page), page);
  assert.equal(htmlDocument('Voici la page.\n\n```html\n' + page + '\n```\n\nFin.'), page);
  assert.equal(htmlDocument('~~~HTML\n<button>Un fragment</button>\n~~~'), '<button>Un fragment</button>');
});

test('prose, unrelated code and ambiguous multiple HTML blocks stay ordinary content', () => {
  for (const content of ['Texte <b>gras</b>', 'const a = "<html></html>";', '```js\n"<html></html>"\n```', '```html\n<p>A</p>\n```\n```html\n<p>B</p>\n```', '```html\n\n```']) assert.equal(htmlDocument(content), null);
});
