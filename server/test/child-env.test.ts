import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAgentEngine } from '../src/agent-engine.js';
import { childEnv, takeProviderKey } from '../src/child-env.js';
import { createCodexEngine } from '../src/engine.js';

const SYNTHETIC_KEY = 'synthetic-test-key-not-a-secret';

test('a child environment keeps ordinary variables and drops every Composio and Honcho variable', () => {
  const env = childEnv({
    PATH: '/bin', HOME: '/home/x', COMPOSIO_API_KEY: SYNTHETIC_KEY, COMPOSIO_BASE_URL: 'https://example.invalid', composio_user_api_key: 'x',
    HONCHO_API_KEY: SYNTHETIC_KEY, HONCHO_BASE_URL: 'https://example.invalid', honcho_workspace_prefix: 'x',
  });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/home/x' });
});

test('the provider key is read once, trimmed, and removed from the server environment', () => {
  const env: NodeJS.ProcessEnv = { COMPOSIO_API_KEY: `  ${SYNTHETIC_KEY}\n`, PATH: '/bin' };
  assert.equal(takeProviderKey(env), SYNTHETIC_KEY);
  assert.deepEqual(env, { PATH: '/bin' });
  assert.equal(takeProviderKey(env), null);
  assert.equal(takeProviderKey({ COMPOSIO_API_KEY: '   ' }), null);
});

test('neither the chat engine child nor the mission executor child inherits a Composio or a Honcho variable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mino-child-env-'));
  const saved = { ...process.env };
  process.env.COMPOSIO_API_KEY = SYNTHETIC_KEY;
  process.env.COMPOSIO_BASE_URL = 'https://example.invalid';
  process.env.HONCHO_API_KEY = SYNTHETIC_KEY;
  process.env.HONCHO_BASE_URL = 'https://example.invalid';
  try {
    process.env.MINO_TEST_ENV_PROBE = join(dir, 'chat.json');
    const chat = createCodexEngine({ command: process.execPath, args: [fileURLToPath(new URL('./fixtures/fake-app-server.js', import.meta.url)), 'reply'], workDir: dir, clientVersion: 'test', requestTimeoutMs: 2000 });
    try {
      assert.equal((await chat.catalog()).state, 'ready');
    } finally {
      await chat.close();
    }
    process.env.MINO_TEST_ENV_PROBE = join(dir, 'mission.json');
    const mission = createAgentEngine({ command: process.execPath, args: [fileURLToPath(new URL('./fixtures/fake-agent-server.js', import.meta.url)), 'edit'], tmpDir: join(dir, 'agent-tmp'), clientVersion: 'test', requestTimeoutMs: 2000 });
    try {
      assert.equal((await mission.catalog()).ok, true);
    } finally {
      await mission.close();
    }
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'chat.json'), 'utf8')), []);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'mission.json'), 'utf8')), []);
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
});
