import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import ignore from 'ignore';
import { checkArchive } from './check-eas-archive.mjs';

const policy = await readFile(new URL('../../.easignore', import.meta.url), 'utf8');
const core = {
  'mobile/App.tsx': 'export default function App() {}',
  'mobile/index.ts': 'import App from "./App";',
  'mobile/app.json': '{}',
  'mobile/package.json': '{}',
  'mobile/package-lock.json': '{}',
  'mobile/eas.json': '{}',
  'mobile/assets/icon.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mino-archive-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source');
  const archiveRoot = join(root, 'archive');
  for (const directory of [sourceRoot, archiveRoot]) {
    for (const [name, contents] of Object.entries(core)) {
      await mkdir(dirname(join(directory, name)), { recursive: true });
      await writeFile(join(directory, name), contents);
    }
  }
  await writeFile(join(sourceRoot, '.easignore'), policy);
  return { sourceRoot, archiveRoot };
}

test('accepts the exact allowed file set and bytes', async (t) => {
  const result = await checkArchive(await fixture(t));
  assert.equal(result.files, 7);
  assert.equal(result.bytes, Object.values(core).reduce((sum, contents) => sum + Buffer.byteLength(contents), 0));
});

test('rejects an unexpected archive file', async (t) => {
  const paths = await fixture(t);
  await writeFile(join(paths.archiveRoot, 'mobile/.env'), 'TOKEN=private');
  await assert.rejects(checkArchive(paths), /Unexpected archive entry/);
});

test('rejects a permitted archive file absent from the source', async (t) => {
  const paths = await fixture(t);
  await writeFile(join(paths.archiveRoot, 'mobile/assets/extra.png'), 'unexpected');
  await assert.rejects(checkArchive(paths), /Unexpected archive file/);
});

test('rejects a missing archive file', async (t) => {
  const paths = await fixture(t);
  await rm(join(paths.archiveRoot, 'mobile/App.tsx'));
  await assert.rejects(checkArchive(paths), /Archive file is missing/);
});

test('rejects an empty source and archive even when their sets agree', async (t) => {
  const paths = await fixture(t);
  await rm(join(paths.sourceRoot, 'mobile'), { recursive: true });
  await rm(join(paths.archiveRoot, 'mobile'), { recursive: true });
  await assert.rejects(checkArchive(paths), /Required source file is missing or excluded/);
});

test('rejects changed bytes', async (t) => {
  const paths = await fixture(t);
  await writeFile(join(paths.archiveRoot, 'mobile/assets/icon.png'), 'different');
  await assert.rejects(checkArchive(paths), /Archive bytes differ/);
});

test('rejects symlinks in the archive and included source paths', async (t) => {
  const paths = await fixture(t);
  for (const root of [paths.archiveRoot, paths.sourceRoot]) {
    const name = join(root, 'mobile/App.tsx');
    await rm(name);
    await symlink('index.ts', name);
    await assert.rejects(checkArchive(paths), /Symbolic link is forbidden/);
    await rm(name);
    await writeFile(name, core['mobile/App.tsx']);
  }
});

test('prunes excluded source directories and follows policy changes', async (t) => {
  const paths = await fixture(t);
  await mkdir(join(paths.sourceRoot, 'mobile/node_modules'), { recursive: true });
  await symlink('missing-private-target', join(paths.sourceRoot, 'mobile/node_modules/private.ts'));
  await writeFile(join(paths.sourceRoot, 'mobile/.env'), homedir());
  for (const root of [paths.sourceRoot, paths.archiveRoot]) {
    await mkdir(join(root, 'mobile/src/generated'), { recursive: true });
    await writeFile(join(root, 'mobile/src/generated/extra.json'), '{}');
    await writeFile(join(root, 'mobile/src/generated/extra.ts'), 'export const value = 1;');
  }
  await assert.rejects(checkArchive(paths), /Unexpected archive entry/);
  await writeFile(join(paths.sourceRoot, '.easignore'), `${policy}\n!/mobile/src/generated/extra.json\n`);
  assert.equal((await checkArchive(paths)).files, 9);
});

test('rejects private keys without exposing their contents', async (t) => {
  const paths = await fixture(t);
  const secret = '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-value';
  for (const root of [paths.sourceRoot, paths.archiveRoot]) {
    await writeFile(join(root, 'mobile/App.tsx'), secret);
  }
  await assert.rejects(checkArchive(paths), (error) => {
    assert.match(error.message, /Private key appears/);
    assert.ok(!error.message.includes(secret));
    return true;
  });
});

test('rejects the actual home path but accepts unrelated home paths', async (t) => {
  const paths = await fixture(t);
  for (const root of [paths.sourceRoot, paths.archiveRoot]) {
    await writeFile(join(root, 'mobile/App.tsx'), '/home/some-other-operator/project');
  }
  assert.equal((await checkArchive(paths)).files, 7);
  for (const root of [paths.sourceRoot, paths.archiveRoot]) {
    await writeFile(join(root, 'mobile/App.tsx'), `${homedir()}/project`);
  }
  await assert.rejects(checkArchive(paths), (error) => {
    assert.match(error.message, /Home directory appears/);
    assert.ok(!error.message.includes(homedir()));
    return true;
  });
});

test('rejects source/archive overlap and an archive root symlink', async (t) => {
  const paths = await fixture(t);
  await assert.rejects(checkArchive({ ...paths, archiveRoot: paths.sourceRoot }), /must be separate/);
  await assert.rejects(checkArchive({ ...paths, archiveRoot: join(paths.sourceRoot, 'mobile') }), /must be separate/);
  const link = `${paths.archiveRoot}-link`;
  await symlink(paths.archiveRoot, link, 'dir');
  await assert.rejects(checkArchive({ ...paths, archiveRoot: link }), /Archive root must be a directory/);
});


test('permits directory traversal when EAS supplies paths without a trailing slash', () => {
  const rules = ignore().add(policy);
  for (const name of ['mobile', 'mobile/src', 'mobile/src/generated', 'mobile/src/missions', 'mobile/assets']) {
    assert.equal(rules.ignores(name), false, name);
    assert.equal(rules.ignores(`${name}/`), false, `${name}/`);
  }
  for (const name of ['data', 'mobile/node_modules', 'mobile/.expo', 'mobile/ios', 'mobile/src/private.sqlite']) {
    assert.equal(rules.ignores(name), true, name);
  }
});
