import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMarkdownHtml } from '../web/markdown.js';
import { searchThread } from '../web/search.js';
import type { AppView, MessageView, WorkView } from '../src/protocol.js';

const decode = (html: string) => html.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const hrefs = (html: string) => [...html.matchAll(/<a\b[^>]*href="([^"]*)"/g)].map(m => m[1]);

test('raw HTML and scripts are shown as text, never as markup', () => {
  const html = renderMarkdownHtml('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<iframe src="https://example.com"></iframe> <b>gras</b>');
  assert.doesNotMatch(html, /<script|<img|<iframe|<b>/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('only absolute http, https and mailto links become links, and they open safely', () => {
  const html = renderMarkdownHtml([
    '[web](https://example.com/a?b=1) [clair](http://example.org) [mail](mailto:lea@example.com)',
    '[js](javascript:alert(1)) [JS](JaVaScRiPt:alert(1)) [data](data:text/html;base64,PHNjcmlwdD4=) [fichier](file:///etc/passwd)',
    '[relatif](/api/export) [local](notes.md) [protocole](//evil.example/x) [vb](vbscript:msgbox)',
    'https://auto.example/chemin et <https://angle.example> et fichier.md',
  ].join('\n\n'));
  assert.deepEqual(hrefs(html), ['https://example.com/a?b=1', 'http://example.org', 'mailto:lea@example.com', 'https://auto.example/chemin', 'https://angle.example']);
  for (const tag of html.match(/<a\b[^>]*>/g) ?? []) {
    assert.match(tag, /target="_blank"/);
    assert.match(tag, /rel="noopener noreferrer nofollow"/);
    assert.match(tag, /referrerpolicy="no-referrer"/);
  }
  assert.doesNotMatch(html, /href="(?:javascript|data|file|vbscript|\/)/i);
});

test('images never load: they become their alt text', () => {
  const html = renderMarkdownHtml('![logo <b>x</b>](https://tracker.example/pixel.png) et ![](https://tracker.example/2.png)');
  assert.doesNotMatch(html, /<img|tracker\.example/);
  assert.match(html, /\[image : logo &lt;b&gt;x&lt;\/b&gt;\]/);
  assert.match(html, /\[image\]/);
});

test('code blocks carry a copy button and keep the exact source text', () => {
  const source = 'const a = "<b>" && b < 3;\n  if (x) { return \'ok\'; }\n';
  const html = renderMarkdownHtml('Avant\n\n```ts\n' + source + '```\n\n    indenté <x>\n');
  const blocks = [...html.matchAll(/<div class="code-block">(.*?)<button type="button" class="code-copy">Copier<\/button><pre><code>([\s\S]*?)<\/code><\/pre><\/div>/g)];
  assert.equal(blocks.length, 2);
  assert.equal(decode(blocks[0]?.[2] ?? ''), source);
  assert.match(blocks[0]?.[1] ?? '', /code-lang">ts</);
  assert.equal(decode(blocks[1]?.[2] ?? ''), 'indenté <x>\n');
});

test('lists, tables and emphasis render as structure', () => {
  const html = renderMarkdownHtml('- un\n- deux\n\n1. premier\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n**fort** et *doux*');
  assert.match(html, /<ul>\s*<li>un<\/li>/);
  assert.match(html, /<ol>\s*<li>premier<\/li>/);
  assert.match(html, /<div class="table-scroll"><table>[\s\S]*<td>1<\/td>[\s\S]*<\/table><\/div>/);
  assert.match(html, /<strong>fort<\/strong> et <em>doux<\/em>/);
});

const message = (patch: Partial<MessageView> & Pick<MessageView, 'id' | 'text'>): MessageView => ({
  threadBotId: 'mino', mentions: [], role: 'user', botId: 'mino', workId: 'w', attachments: [], createdAt: '2026-11-01T10:00:00Z', stamp: null, taskStep: null, handoff: null, ...patch,
});

function viewWith(messages: MessageView[], works: WorkView[] = []): AppView {
  return { rev: 1, spaceId: 's', activeBotId: 'mino', bots: [], retiredBotIds: [], purged: { botIds: [], workIds: [] }, erasure: 'complete', messages, works, tasks: [], carnet: [], engine: { state: 'starting' } };
}

test('search ignores accents and case, needs every term, and points back to the right bot and message', () => {
  const view = viewWith([
    message({ threadBotId: 'mino', mentions: [], id: 'm1', text: 'Préparer la Réunion du lundi', createdAt: '2026-11-01T10:00:00Z' }),
    message({ id: 'm2', role: 'assistant', botId: 'pixel', text: 'La reunion de PIXEL est mardi', createdAt: '2026-11-02T10:00:00Z' }),
    message({ id: 'm3', text: 'Autre sujet', createdAt: '2026-11-03T10:00:00Z' }),
  ]);
  const hits = searchThread(view, 'RÉUNION');
  assert.deepEqual(hits.map(h => [h.botId, h.target]), [
    ['pixel', { kind: 'message', messageId: 'm2', role: 'assistant' }],
    ['mino', { kind: 'message', messageId: 'm1', role: 'user' }],
  ], 'newest first');
  assert.equal(hits[1]?.snippet.match, 'Réunion', 'the snippet shows the original text');
  assert.deepEqual(searchThread(view, 'reunion lundi').map(h => h.target), [{ kind: 'message', messageId: 'm1', role: 'user' }]);
  assert.deepEqual(searchThread(view, 'reunion jeudi'), []);
  assert.deepEqual(searchThread(view, '   '), []);
});

test('search covers the current version of a deliverable only, and leads to that version', () => {
  const work: WorkView = { threadBotId: 'mino', taskId: null,
    id: 'w1', botId: 'atlas', requestMessageId: 'm1', state: 'review', title: 'Plan', createdAt: '', updatedAt: '', attempt: null, attempts: 1, proposals: [],
    versions: [
      { id: 'v1', n: 1, title: 'Plan', body: 'ANCIENNE formulation', source: 'result', restoredFromN: null, createdAt: '2026-11-01T10:00:00Z' },
      { id: 'v2', n: 2, title: 'Plan', body: 'Nouvelle formulation, élégante', source: 'edit', restoredFromN: null, createdAt: '2026-11-02T10:00:00Z' },
    ],
  };
  const view = viewWith([], [work]);
  assert.deepEqual(searchThread(view, 'elegante').map(h => [h.botId, h.target]), [['atlas', { kind: 'version', workId: 'w1', versionId: 'v2', n: 2 }]]);
  assert.deepEqual(searchThread(view, 'ancienne'), []);
});
