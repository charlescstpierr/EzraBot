import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL(import.meta.url.endsWith('.ts') ? '../../' : '../../../', import.meta.url);
const declarations = [
  { path: 'package.json', field: ['version'] },
  { path: 'package-lock.json', field: ['version'] },
  { path: 'package-lock.json', field: ['packages', '', 'version'] },
  { path: 'server/package.json', field: ['version'] },
  { path: 'server/package-lock.json', field: ['version'] },
  { path: 'server/package-lock.json', field: ['packages', '', 'version'] },
  { path: 'server/mobile/package.json', field: ['version'] },
  { path: 'server/mobile/package-lock.json', field: ['version'] },
  { path: 'server/mobile/package-lock.json', field: ['packages', '', 'version'] },
  { path: 'server/mobile/app.json', field: ['expo', 'version'] },
  { path: 'server/src/main.ts', field: ['VERSION'] },
];

test('version declarations match the first release in CHANGELOG.md', () => {
  const changelog = new URL('CHANGELOG.md', root);
  assert.ok(existsSync(changelog), 'CHANGELOG.md exists');
  const headings = [...readFileSync(changelog, 'utf8').matchAll(/^##\s+(.+)$/gm)];
  const heading = headings.find((match) => !/^\[?Unreleased\]?(?:\s|$)/i.test(match[1] ?? ''));
  const version = heading?.[1]?.match(/^\[?(\d+\.\d+\.\d+)\]?(?:\s|$)/)?.[1];
  assert.ok(version, 'the first release heading contains a version');

  for (const { path, field } of declarations) {
    const source = readFileSync(new URL(path, root), 'utf8');
    let value: unknown = path.endsWith('.ts')
      ? source.match(/^const VERSION = ['"]([^'"]+)['"];$/m)?.[1]
      : JSON.parse(source);
    if (!path.endsWith('.ts')) {
      for (const key of field) {
        assert.ok(typeof value === 'object' && value !== null && key in value, `${path} has ${field.join('.')}`);
        value = Reflect.get(value, key);
      }
    }
    assert.equal(value, version, `${path} ${field.join('.')}`);
  }
});
