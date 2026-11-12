import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url);
const port = Number(process.env.MINO_FAILURE_PORT ?? 4392);
const base = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), 'mino-missing-engine-'));
const child = spawn(process.execPath, ['dist/src/main.js'], {
  cwd: root,
  env: { ...process.env, MINO_DATA_DIR: dataDir, MINO_PORT: String(port), MINO_CODEX_BIN: join(dataDir, 'absent-codex') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.resume();
const exited = new Promise(resolve => child.once('exit', resolve));
let timeout;
try {
  await Promise.race([
    new Promise((resolve, reject) => {
      createInterface({ input: child.stdout }).on('line', line => {
        try { if (JSON.parse(line).event === 'ready') resolve(); } catch { reject(new Error('Journal de démarrage invalide')); }
      });
      child.once('error', () => reject(new Error('Démarrage impossible')));
      child.once('exit', () => reject(new Error('Arrêt avant disponibilité')));
    }),
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Délai de démarrage dépassé')), 10_000); }),
  ]);
  clearTimeout(timeout);
  const get = async path => (await fetch(base + path, { signal: AbortSignal.timeout(5000) }));
  const page = await (await get('/')).text();
  const token = /name="mino-csrf" content="([0-9a-f]+)"/.exec(page)?.[1];
  assert(token);
  const accepted = await (await fetch(base + '/api/commands', {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json', 'x-mino-csrf': token },
    body: JSON.stringify({ type: 'message.send', requestId: 'verify-missing-engine', botId: 'mino', text: 'Bonjour', attachments: [] }),
  })).json();
  assert.equal(accepted.ok, true);
  let view;
  for (let i = 0; i < 30; i += 1) {
    view = await (await get('/api/view?after=-1')).json();
    if (view.works[0]?.state === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(view.works[0]?.state, 'failed');
  assert.match(view.works[0]?.attempt?.error, /introuvable/);
  assert.equal(view.messages.filter(message => message.role === 'assistant').length, 0);
  const result = { checkedAt: new Date().toISOString(), integration: 'Real server, absent Codex executable',
    state: view.works[0].state, error: view.works[0].attempt.error, assistantReplies: 0, workId: view.works[0].id };
  writeFileSync(new URL('docs/evidence/real-failure.json', root), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  clearTimeout(timeout);
  child.kill('SIGTERM');
  await exited;
}
