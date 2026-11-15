import assert from 'node:assert/strict';
import test from 'node:test';
import { serverEnvironment } from '../src/env.js';

const LAUNCH = { dataDir: '/data', port: 47317, codex: '/opt/codex/bin/codex', codexExec: '/opt/ezrabot/ezrabot-codex', generation: '0'.repeat(32) };

test('the server environment keeps the session basics and the launch settings, and nothing else', () => {
  const env = serverEnvironment({
    PATH: '/usr/bin', HOME: '/home/u', LANG: 'fr_CA.UTF-8', LC_TIME: 'fr_CA.UTF-8', XDG_RUNTIME_DIR: '/run/user/1000', CODEX_HOME: '/home/u/.codex',
    COMPOSIO_API_KEY: 'k', HONCHO_API_KEY: 'k', MINO_BUDGETS: '{}', MINO_DEVICE_URL: 'https://x', MINO_DEVICE_KEY: '/k', MINO_EVENTS_PORT: '1',
    MINO_PORT: '4317', MINO_DATA_DIR: '/home/u/.local/share/ezrabot', MINO_CODEX_BIN: '/tmp/evil', NODE_OPTIONS: '--require /tmp/evil.js',
    ELECTRON_RUN_AS_NODE: '0', LD_PRELOAD: '/tmp/evil.so', SSH_AUTH_SOCK: '/run/ssh', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/bus',
  }, LAUNCH);
  assert.deepEqual(env, {
    PATH: '/usr/bin', HOME: '/home/u', LANG: 'fr_CA.UTF-8', LC_TIME: 'fr_CA.UTF-8', XDG_RUNTIME_DIR: '/run/user/1000', CODEX_HOME: '/home/u/.codex',
    ELECTRON_RUN_AS_NODE: '1', MINO_PORT: '47317', MINO_DATA_DIR: '/data', MINO_DESKTOP_GENERATION: LAUNCH.generation,
    MINO_CODEX_BIN: '/opt/ezrabot/ezrabot-codex', EZRABOT_CODEX: '/opt/codex/bin/codex',
  });
});

test('without a resolved Codex, the server looks for none of its own choosing through the launcher', () => {
  const env = serverEnvironment({ PATH: '/usr/bin' }, { ...LAUNCH, codex: null });
  assert.equal(env.MINO_CODEX_BIN, undefined);
  assert.equal(env.EZRABOT_CODEX, undefined);
});
