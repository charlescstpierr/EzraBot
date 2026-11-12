const PROVIDER_VARIABLE = /^COMPOSIO_/i;

export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !PROVIDER_VARIABLE.test(name)));
}

export function takeProviderKey(env: NodeJS.ProcessEnv): string | null {
  const key = env.COMPOSIO_API_KEY?.trim();
  delete env.COMPOSIO_API_KEY;
  return key ? key : null;
}
