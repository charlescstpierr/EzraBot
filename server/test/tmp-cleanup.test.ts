import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const scripts: Record<string, string> = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts;

test('the test command leaves no temporary folder behind, even when a test fails', () => {
  const system = mkdtempSync(join(tmpdir(), 'mino-tmp-cleanup-'));
  const { NODE_TEST_CONTEXT: _nested, ...env } = process.env;
  try {
    const run = spawnSync(`${scripts['test:run']} dist/test/fixtures/temp-leak.js`, { cwd: root, shell: true, encoding: 'utf8', env: { ...env, TMPDIR: system } });
    const output = run.stdout + run.stderr;
    assert.equal(run.status, 1, output);
    assert.match(output, /injected failure after /, 'the fixture ran and failed');
    assert.ok(output.includes(system), `the fixture used the dedicated temporary folder\n${output}`);
    assert.deepEqual(readdirSync(system), [], 'nothing is left in the temporary folder');
  } finally {
    rmSync(system, { recursive: true, force: true });
  }
});
