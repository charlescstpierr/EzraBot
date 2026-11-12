import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DISABLED_FEATURES as disabled, CODEX_CONFIG_ARGS } from '../dist/src/engine.js';
const cwd = mkdtempSync(join(tmpdir(), 'mino-capabilities-'));
const child = spawn('codex', ['app-server', '--listen', 'stdio://',
  ...disabled.flatMap(name => ['--disable', name]), ...CODEX_CONFIG_ARGS],
  { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let seq = 0;
const deadline = setTimeout(() => { child.kill(); process.exitCode = 1; }, 20_000);
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
  const { config } = await rpc('config/read', { includeLayers: false });
  const features = Object.fromEntries(disabled.map(name => [name, config.features?.[name] === false]));
  const mcp = Object.entries(config.mcp_servers ?? {}).map(([name, value]) => ({ name, enabled: value.enabled !== false }));
  const result = { contextIsolation: { skillsInstructionsDisabled: config.skills?.include_instructions === false, bundledSkillsDisabled: config.skills?.bundled?.enabled === false, projectDocsDisabled: config.project_doc_max_bytes === 0, skillCatalogBudget: config.skills?.max_context_tokens }, checkedAt: new Date().toISOString(), userAgent: init.userAgent, featuresDisabled: features,
    mcp, webSearchDisabled: config.web_search === 'disabled', allDisabled: Object.values(features).every(Boolean) && mcp.every(server => !server.enabled) };
  writeFileSync('docs/evidence/context-config-probe.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
  if (!result.allDisabled || !result.webSearchDisabled || !result.contextIsolation.skillsInstructionsDisabled || !result.contextIsolation.bundledSkillsDisabled || !result.contextIsolation.projectDocsDisabled || result.contextIsolation.skillCatalogBudget !== 1) process.exitCode = 1;
} catch {
  console.error('La vérification App Server a échoué. Aucun secret n’a été affiché.');
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  child.stdin.end();
  child.kill();
}
