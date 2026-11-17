/**
 * The server environment is built from a short list, never copied whole: a desktop session can carry
 * provider keys, budgets, a phone or an event setting meant for the command-line server, and none of
 * them may reach the application by accident.
 */
const SESSION = new Set([
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'PATH',
  'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TMPDIR',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CODEX_HOME',
]);

/** `codexExec` is the small launcher that closes inherited descriptors before it starts `codex`. */
export type ServerLaunch = { dataDir: string; port: number; codex: string | null; codexExec: string; generation: string };

export function serverEnvironment(session: NodeJS.ProcessEnv, launch: ServerLaunch): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(session)) {
    if (value !== undefined && (SESSION.has(name) || name.startsWith('LC_'))) env[name] = value;
  }
  return {
    ...env,
    ELECTRON_RUN_AS_NODE: '1',
    MINO_PORT: String(launch.port),
    MINO_DATA_DIR: launch.dataDir,
    MINO_DESKTOP_GENERATION: launch.generation,
    ...(launch.codex ? { MINO_CODEX_BIN: launch.codexExec, EZRABOT_CODEX: launch.codex } : {}),
  };
}
