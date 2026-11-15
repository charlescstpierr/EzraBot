import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from './temp.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('a directly run test fails after creating its folder', () => {
  assert.fail(`injected failure after ${mkdtempSync(join(tmpdir(), 'mino-owned-'))}`);
});
