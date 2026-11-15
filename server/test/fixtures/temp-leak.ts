import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('a test that fails after it and its child leave temporary folders', () => {
  const own = mkdtempSync(join(tmpdir(), 'mino-leak-'));
  writeFileSync(join(own, 'data'), 'synthetic');
  const child = execFileSync(process.execPath, ['-e', "process.stdout.write(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'mino-leak-child-')))"], { encoding: 'utf8' });
  assert.fail(`injected failure after ${own} and ${child}`);
});
