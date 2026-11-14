import { z } from 'zod';

const PROVIDER_VARIABLE = /^(COMPOSIO|HONCHO)_/i;

export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !PROVIDER_VARIABLE.test(name)));
}

export function takeProviderKey(env: NodeJS.ProcessEnv): string | null {
  const key = env.COMPOSIO_API_KEY?.trim();
  delete env.COMPOSIO_API_KEY;
  return key ? key : null;
}

export type HonchoConfig = { baseUrl: string; apiKey: string; workspacePrefix: string; timeoutMs: number };

export class HonchoConfigError extends Error {
  constructor() {
    super('La configuration Honcho est incomplète ou invalide. Donnez ensemble HONCHO_BASE_URL (https), HONCHO_API_KEY et HONCHO_WORKSPACE_PREFIX (lettres, chiffres, _ ou -, 40 au plus), ou aucune des trois.');
  }
}

const HonchoEnvSchema = z.strictObject({
  baseUrl: z.url({ protocol: /^https$/ }),
  apiKey: z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/),
  workspacePrefix: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
  timeoutMs: z.number().int().min(1).max(120_000),
});

/**
 * Reads the Honcho settings of this server, then removes every `HONCHO_*` variable from the environment,
 * so no engine and no child process ever inherits them. Null when none of the three settings is given: no call is possible.
 */
export function takeHonchoConfig(env: NodeJS.ProcessEnv): HonchoConfig | null {
  const given = { baseUrl: env.HONCHO_BASE_URL?.trim(), apiKey: env.HONCHO_API_KEY?.trim(), workspacePrefix: env.HONCHO_WORKSPACE_PREFIX?.trim() };
  const timeout = env.HONCHO_TIMEOUT_MS?.trim();
  for (const name of Object.keys(env)) if (/^HONCHO_/i.test(name)) delete env[name];
  if (!given.baseUrl && !given.apiKey && !given.workspacePrefix) return null;
  const parsed = HonchoEnvSchema.safeParse({ ...given, timeoutMs: timeout ? Number(timeout) : 8000 });
  if (!parsed.success) throw new HonchoConfigError();
  return parsed.data;
}
