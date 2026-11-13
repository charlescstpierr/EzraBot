// Reads `model/list` from the installed Codex App Server and writes the test catalogue the browser QA mirrors.
// Read-only: no thread, no turn, no Mino data. Run it again when the installed engine announces other models.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const target = fileURLToPath(new URL('../test/fixtures/engine-catalogue.json', import.meta.url));
const child = spawn(process.env.MINO_CODEX_BIN ?? 'codex', ['app-server', '--listen', 'stdio://', '-c', 'mcp_servers={}', '-c', 'web_search="disabled"'],
  { cwd: mkdtempSync(join(tmpdir(), 'mino-catalogue-')), stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let seq = 0;
const deadline = setTimeout(() => { child.kill(); process.exitCode = 1; }, 30_000);
const send = value => child.stdin.write(JSON.stringify(value) + '\n');
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
}
child.stderr.resume();
child.on('error', () => { process.exitCode = 1; });
child.on('close', () => {
  clearTimeout(deadline);
  for (const waiter of pending.values()) waiter.reject(new Error('App Server fermé'));
});
createInterface({ input: child.stdout }).on('line', line => {
  const value = JSON.parse(line);
  const waiter = pending.get(value.id);
  if (waiter) {
    pending.delete(value.id);
    value.error ? waiter.reject(new Error('Échec RPC')) : waiter.resolve(value.result);
  } else if (value.id !== undefined) send({ id: value.id, error: { code: -32000, message: 'Action indisponible' } });
});
try {
  const init = await rpc('initialize', { clientInfo: { name: 'mino_probe', version: '0.1.0' } });
  send({ method: 'initialized', params: {} });
  const models = [];
  let cursor = null;
  do {
    const page = await rpc('model/list', { limit: 100, cursor });
    models.push(...page.data);
    cursor = page.nextCursor ?? null;
  } while (cursor);
  const catalogue = {
    engine: `codex ${/\/(\d+\.\d+\.\d+)/.exec(init.userAgent)?.[1] ?? 'inconnu'}`,
    checkedAt: new Date().toISOString().slice(0, 10),
    models: models.map(m => ({
      id: m.id, displayName: m.displayName, hidden: m.hidden, isDefault: m.isDefault, inputModalities: m.inputModalities,
      supportedReasoningEfforts: m.supportedReasoningEfforts.map(e => ({ reasoningEffort: e.reasoningEffort })),
      defaultReasoningEffort: m.defaultReasoningEffort,
      serviceTiers: (m.serviceTiers ?? []).map(t => ({ id: t.id, name: t.name, description: t.description })),
    })),
  };
  writeFileSync(target, JSON.stringify(catalogue, null, 2) + '\n');
  console.log(`${catalogue.engine} : ${catalogue.models.map(m => m.id).join(', ')}`);
} catch {
  console.error('La lecture du catalogue App Server a échoué. Aucun secret n’a été affiché.');
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  child.stdin.end();
  child.kill();
}
