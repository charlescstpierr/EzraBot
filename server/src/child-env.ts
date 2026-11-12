const PROVIDER_VARIABLE = /^COMPOSIO_/i;

/** The environment handed to every Codex child: the server's own, without any Composio variable. */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !PROVIDER_VARIABLE.test(name)));
}

/** Reads the provider key once and removes it from this process, so nothing started later can inherit it. */
export function takeProviderKey(env: NodeJS.ProcessEnv): string | null {
  const key = env.COMPOSIO_API_KEY?.trim();
  delete env.COMPOSIO_API_KEY;
  return key ? key : null;
}
