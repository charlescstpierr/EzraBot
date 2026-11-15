import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const readme = await readFile(new URL('README.md', root), 'utf8');
const reference = readme.match(/!\[[^\]]*\]\((docs\/[^)\s]+\.gif)\)/);
assert.ok(reference, 'Le README doit afficher un GIF local dans docs/.');
const gif = await readFile(new URL(reference[1], root));
assert.ok(['GIF87a', 'GIF89a'].includes(gif.subarray(0, 6).toString()), 'Le fichier doit avoir un en-tête GIF valide.');
assert.ok(readme.includes('node scripts/generate-demo.mjs'), 'Le README doit documenter la commande du générateur.');
await access(new URL('scripts/generate-demo.mjs', root));
console.log('README OK : GIF local valide et générateur documenté présent.');
