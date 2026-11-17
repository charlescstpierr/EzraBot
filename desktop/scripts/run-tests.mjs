// The tests run under a guardian of their own. Orphans that a test leaves on purpose, such as the tree of a
// guardian it killed, are adopted by this outer guardian and not by systemd, and are reaped here at the end.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'ezt-'));
const outer = spawn(`${here}/dist/ezrabot-guardian`, ['--lock', join(dir, 'lock'), '--receipt', join(dir, 'receipt'), '--',
  process.execPath, '--test', '--test-concurrency=1', '--test-timeout=60000', ...process.argv.slice(2), `${here}/dist/test/*.test.js`], { stdio: ['pipe', 'pipe', 'inherit'] });
let verdict = { result: 'unconfirmed', runtimeCode: -1 };
createInterface({ input: outer.stdout }).on('line', line => {
  const event = JSON.parse(line);
  if (event.event === 'cleanup') verdict = event;
});
outer.on('exit', code => {
  if (verdict.result !== 'clean') console.error(`Test processes were not all confirmed gone: ${JSON.stringify(verdict)}`);
  else if (verdict.owned > 1) console.error(`The outer guardian reaped ${verdict.owned - 1} process(es) that the tests left behind.`);
  process.exit(verdict.result === 'clean' && verdict.owned === 1 ? verdict.runtimeCode : 1);
});
