import { mkdtempSync as createTempDir, rmSync } from 'node:fs';
import { after } from 'node:test';

const owned: string[] = [];
after(() => { for (const dir of owned) rmSync(dir, { recursive: true, force: true }); });

/** A temporary folder that the importing test file removes after its last test, failed or not, also when the file runs alone. */
export function mkdtempSync(prefix: string): string {
  const dir = createTempDir(prefix);
  owned.push(dir);
  return dir;
}
