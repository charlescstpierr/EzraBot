import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChatMarkdown, safeChatLink, type ChatBlock, type ChatInline } from '../src/chat-markdown';

function inlineText(nodes: ChatInline[]): string {
  return nodes.map((node): string => {
    switch (node.kind) {
      case 'text':
      case 'code': return node.text;
      case 'break': return '\n';
      case 'image': return `${node.label} ${node.source}`;
      default: return inlineText(node.children);
    }
  }).join('');
}

function textOf(blocks: ChatBlock[]): string {
  return blocks.map((block): string => {
    switch (block.kind) {
      case 'paragraph':
      case 'heading': return inlineText(block.children);
      case 'quote': return textOf(block.children);
      case 'list': return block.items.map(textOf).join('\n');
      case 'code': return block.text;
      case 'table': return block.rows.map((row) => row.map((cell) => inlineText(cell.children)).join('\t')).join('\n');
      case 'rule': return '';
    }
  }).join('\n');
}

test('assistant prose retains accents, line breaks, headings and inline formatting', () => {
  const blocks = parseChatMarkdown('# Réponse\n\nBonjour **Marie** et *Zoé*.\n`x + 1` reste ~~barré~~.');
  assert.equal(textOf(blocks), 'Réponse\nBonjour Marie et Zoé.\nx + 1 reste barré.');
  assert.deepEqual(blocks[0], { kind: 'heading', level: 1, children: [{ kind: 'text', text: 'Réponse' }] });
  const paragraph = blocks[1];
  assert.ok(paragraph?.kind === 'paragraph');
  assert.ok(paragraph.children.some((node) => node.kind === 'strong'));
  assert.ok(paragraph.children.some((node) => node.kind === 'emphasis'));
  assert.ok(paragraph.children.some((node) => node.kind === 'strike'));
});

test('nested ordered lists and quotes retain every item and the starting number', () => {
  const blocks = parseChatMarkdown('3. Premier\n   - Enfant **complet**\n     > Citation avec détail\n4. Dernier');
  const list = blocks[0];
  assert.ok(list?.kind === 'list');
  assert.equal(list.start, 3);
  assert.equal(list.items.length, 2);
  const nested = list.items[0]?.[1];
  assert.ok(nested?.kind === 'list');
  assert.equal(nested.start, null);
  assert.ok(nested.items[0]?.some((block) => block.kind === 'quote'));
  assert.equal(textOf(blocks), 'Premier\nEnfant complet\nCitation avec détail\nDernier');
});

test('fenced and indented code retain whitespace, markup, and the final newline', () => {
  const source = '  <script>danger()</script>\n\tconst value = "**literal**";  \n\n';
  const blocks = parseChatMarkdown(`\`\`\`typescript\n${source}\`\`\`\n\n    exact **code**\n`);
  assert.deepEqual(blocks[0], { kind: 'code', language: 'typescript', text: source });
  assert.deepEqual(blocks[1], { kind: 'code', language: '', text: 'exact **code**\n' });
});

test('only explicit http, https and mailto destinations become interactive links', () => {
  for (const url of ['https://example.com/path?q=oui', 'http://localhost:4319', 'mailto:bonjour@example.com']) {
    assert.equal(safeChatLink(url), url);
    const [block] = parseChatMarkdown(`[Ouvrir](${url})`);
    assert.ok(block?.kind === 'paragraph');
    assert.deepEqual(block.children, [{ kind: 'link', url, children: [{ kind: 'text', text: 'Ouvrir' }] }]);
  }
  const [plain] = parseChatMarkdown('https://example.com');
  assert.ok(plain?.kind === 'paragraph');
  assert.deepEqual(plain.children, [{ kind: 'text', text: 'https://example.com' }]);
});

test('unsafe and relative destinations remain visible and cannot become interactive links', () => {
  const destinations = ['javascript:alert(1)', 'data:text/html,hello', 'file:///etc/passwd', 'ftp://example.com/file', 'intent://example.com', '/relative', '//example.com', 'https://exa\nmple.com'];
  for (const destination of destinations) assert.equal(safeChatLink(destination), null, destination);
  for (const destination of destinations.slice(0, -1)) {
    const blocks = parseChatMarkdown(`[Visible](<${destination}>)`);
    assert.ok(textOf(blocks).includes('Visible'));
    assert.ok(textOf(blocks).includes(destination), destination);
    const [paragraph] = blocks;
    assert.ok(paragraph?.kind === 'paragraph');
    assert.ok(paragraph.children.every((node) => node.kind !== 'link'), destination);
  }
});

test('HTML stays literal text and images retain their labels and source without becoming links', () => {
  const html = '<script>alert("bonjour")</script>\n<iframe src="https://example.com"></iframe>';
  assert.equal(textOf(parseChatMarkdown(html)), html);
  const [image] = parseChatMarkdown('![Plan de la pièce](https://example.com/private.png)');
  assert.ok(image?.kind === 'paragraph');
  assert.deepEqual(image.children, [{ kind: 'image', label: 'Plan de la pièce', source: 'https://example.com/private.png' }]);
});

test('tables retain every cell, formatted contents, header status and alignment', () => {
  const [table] = parseChatMarkdown('| Nom | Mesure |\n| :--- | ---: |\n| **Largeur** | `180 px` |\n| Pièce | Très longue valeur complète |');
  assert.ok(table?.kind === 'table');
  assert.equal(table.rows.length, 3);
  assert.ok(table.rows[0]?.every((cell) => cell.header));
  assert.deepEqual(table.rows[1]?.map((cell) => cell.align), ['left', 'right']);
  assert.equal(textOf([table]), 'Nom\tMesure\nLargeur\t180 px\nPièce\tTrès longue valeur complète');
});

test('incomplete streaming Markdown retains the unfinished reply', () => {
  assert.equal(textOf(parseChatMarkdown('Une réponse **encore')), 'Une réponse **encore');
  assert.deepEqual(parseChatMarkdown('```js\nconst unfinished = 1'), [{ kind: 'code', language: 'js', text: 'const unfinished = 1' }]);
  assert.deepEqual(parseChatMarkdown(''), []);
});

test('the parser nesting limit cannot silently remove deeply nested source text', () => {
  const text = `${'> '.repeat(25)}Le détail complet doit rester visible.\n\nFin de la réponse.`;
  assert.equal(textOf(parseChatMarkdown(text)), text);
});
