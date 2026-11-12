import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ignore from 'ignore';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const requiredFiles = [
  'mobile/App.tsx',
  'mobile/index.ts',
  'mobile/app.json',
  'mobile/package.json',
  'mobile/package-lock.json',
  'mobile/eas.json',
  'mobile/assets/icon.png',
];

export async function checkArchive({ sourceRoot = repositoryRoot, archiveRoot }) {
  if (!archiveRoot) throw new Error('Provide an archive directory.');
  const archiveInfo = await lstat(archiveRoot);
  if (!archiveInfo.isDirectory() || archiveInfo.isSymbolicLink()) {
    throw new Error('Archive root must be a directory, not a symbolic link.');
  }
  sourceRoot = await realpath(sourceRoot);
  archiveRoot = await realpath(archiveRoot);
  const overlaps = (parent, child) => {
    const path = relative(parent, child);
    return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
  };
  if (overlaps(sourceRoot, archiveRoot) || overlaps(archiveRoot, sourceRoot)) {
    throw new Error('Archive and source directories must be separate.');
  }
  const policy = ignore().add(await readFile(join(sourceRoot, '.easignore'), 'utf8'));
  const homeDirectory = homedir();

  async function collect(root, isArchive, directory = '', files = new Map()) {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const name = directory ? `${directory}/${entry.name}` : entry.name;
      const ignored = policy.ignores(entry.isDirectory() ? `${name}/` : name);
      if (entry.isSymbolicLink()) {
        if (isArchive || !ignored || !policy.ignores(`${name}/`)) {
          throw new Error(`Symbolic link is forbidden: ${name}`);
        }
        continue;
      }
      if (ignored) {
        if (isArchive) throw new Error(`Unexpected archive entry: ${name}`);
        continue;
      }
      if (entry.isDirectory()) {
        await collect(root, isArchive, name, files);
      } else if (entry.isFile()) {
        files.set(name, await readFile(join(root, name)));
      } else {
        throw new Error(`Unsupported entry: ${name}`);
      }
    }
    return files;
  }

  const expected = await collect(sourceRoot, false);
  for (const name of requiredFiles) {
    if (!expected.has(name)) throw new Error(`Required source file is missing or excluded: ${name}`);
  }
  const actual = await collect(archiveRoot, true);
  let bytes = 0;
  for (const [name, contents] of actual) {
    if (!expected.has(name)) throw new Error(`Unexpected archive file: ${name}`);
    if (!contents.equals(expected.get(name))) throw new Error(`Archive bytes differ: ${name}`);
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(contents);
    } catch {
      continue;
    }
    if (text.includes(homeDirectory)) throw new Error(`Home directory appears in archive text: ${name}`);
    if (/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(text)) {
      throw new Error(`Private key appears in archive text: ${name}`);
    }
  }
  for (const [name, contents] of expected) {
    if (!actual.has(name)) throw new Error(`Archive file is missing: ${name}`);
    bytes += contents.length;
  }
  return { files: actual.size, bytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const archiveRoot = args.length === 1 && !args[0].startsWith('-') ? args[0]
    : args.length === 2 && args[0] === '--archive' ? args[1] : undefined;
  if (!archiveRoot) {
    console.error('Usage: node scripts/check-eas-archive.mjs --archive <directory>');
    process.exitCode = 1;
  } else {
    try {
      const result = await checkArchive({ archiveRoot });
      console.log(`Archive verified: ${result.files} files, ${result.bytes} bytes match source.`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
