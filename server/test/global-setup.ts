import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The runner calls the teardown after a failed test or Ctrl-C too, and child processes inherit TMPDIR.
let root = '';

export function globalSetup(): void {
  root = mkdtempSync(join(tmpdir(), 'mino-test-run-'));
  process.env.TMPDIR = root;
}

export function globalTeardown(): void {
  rmSync(root, { recursive: true, force: true });
}
