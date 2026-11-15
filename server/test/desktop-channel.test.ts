import assert from 'node:assert/strict';
import { closeSync, openSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DesktopChannelError, announceReady, takeDesktopChannel } from '../src/desktop-channel.js';

const GENERATION = '0123456789abcdef0123456789abcdef';

test('the desktop variables are read once and removed, so no engine inherits the Electron runtime switch', () => {
  const env: NodeJS.ProcessEnv = { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', MINO_DESKTOP_GENERATION: GENERATION };
  assert.equal(takeDesktopChannel(env), GENERATION);
  assert.deepEqual(env, { PATH: '/bin' });
  const cli: NodeJS.ProcessEnv = { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' };
  assert.equal(takeDesktopChannel(cli), null, 'the command-line server has no desktop channel');
  assert.deepEqual(cli, { PATH: '/bin' });
  assert.throws(() => takeDesktopChannel({ MINO_DESKTOP_GENERATION: 'x' }), DesktopChannelError);
});

test('ready names this process and its address once, then the descriptor is closed', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mino-ready-')), 'ready');
  const fd = openSync(path, 'w');
  announceReady(GENERATION, { url: 'http://127.0.0.1:47317', dataDir: '/data' }, fd);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { kind: 'ready', generation: GENERATION, pid: process.pid, url: 'http://127.0.0.1:47317', dataDir: '/data' });
  assert.throws(() => closeSync(fd), { code: 'EBADF' });
});
