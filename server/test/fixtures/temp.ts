import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

const owned: string[] = [];
after(() => { for (const dir of owned) rmSync(dir, { recursive: true, force: true }); });

/** A temporary folder that the importing test file removes after its last test, failed or not, also when the file runs alone. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  owned.push(dir);
  return dir;
}
