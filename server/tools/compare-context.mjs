import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { composeContext } from '../dist/src/context.js';
import { contextFixtures } from './context-fixtures.mjs';

const root = new URL('../', import.meta.url);
const baseline = JSON.parse(readFileSync(new URL('docs/evidence/context-baseline.json', root), 'utf8'));

function toSource(context, contextSize) {
  const exchanges = [];
  for (let i = 0; i + 1 < context.history.length; i += 2) {
    const [request, reply] = [context.history[i], context.history[i + 1]];
    if (request?.role !== 'user' || reply?.role !== 'assistant') throw new Error('Fixture history must alternate user then assistant');
    exchanges.push({ request: { text: request.text, attachments: [] }, replies: [{ by: context.bot.name, text: reply.text }], deliverable: null });
  }
  return {
    bot: { name: context.bot.name, title: context.bot.title, instructions: '', replyStyle: 'concise', contextSize },
    memories: context.memories,
    exchanges,
    request: context.request,
  };
}

const fixtures = contextFixtures().map(fixture => {
  const before = baseline.fixtures.find(entry => entry.name === fixture.name);
  if (!before) throw new Error(`Baseline missing fixture ${fixture.name}`);
  const sizes = Object.fromEntries(['short', 'standard', 'long'].map(size => {
    const { turn, plan } = composeContext(toSource(fixture.context, size));
    const totalChars = plan.baseChars + plan.inputChars;
    const requestKept = turn.input.endsWith(fixture.context.request.text);
    const attachmentsKept = fixture.context.request.attachments.every(file => turn.input.includes(file.text));
    if (!requestKept || !attachmentsKept) throw new Error(`${fixture.name}/${size}: current request or attachment not sent whole`);
    return [size, {
      baseChars: plan.baseChars,
      inputChars: plan.inputChars,
      totalChars,
      utf8Bytes: plan.utf8Bytes,
      deltaChars: totalChars - before.totalChars,
      deltaBytes: plan.utf8Bytes - before.utf8Bytes,
      exchanges: plan.exchanges,
      clippedChars: plan.clippedChars,
    }];
  }));
  return { name: fixture.name, baseline: { totalChars: before.totalChars, utf8Bytes: before.utf8Bytes }, sizes };
});

const report = {
  checkedAt: new Date().toISOString(),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  uncommittedChanges: execFileSync('git', ['status', '--porcelain', '--', 'src', 'tools/context-fixtures.mjs'], { cwd: root, encoding: 'utf8' }).trim() !== '',
  baselineCommit: baseline.sourceCommit,
  measurement: 'Characters (code points) and UTF-8 bytes of baseInstructions + input composed by Mino, reply style concise, on the same synthetic fixtures as the baseline. Not token counts, latency or billing. The baseline counted UTF-16 length, identical here because the fixtures contain no character outside the BMP.',
  fixtures,
};
const out = new URL('docs/evidence/context-comparison.json', root);
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
for (const fixture of fixtures) {
  for (const [size, entry] of Object.entries(fixture.sizes)) {
    process.stdout.write(`${fixture.name} [${size}] ${fixture.baseline.totalChars} → ${entry.totalChars} caractères (${entry.deltaChars >= 0 ? '+' : ''}${entry.deltaChars}), ${fixture.baseline.utf8Bytes} → ${entry.utf8Bytes} octets\n`);
  }
}
process.stdout.write(`Comparaison écrite dans ${out.pathname}\n`);
