import { Composio, ComposioToolInputRequiredError, SessionPreset, type ConnectionRequestState } from '@composio/core';
import { schemaSha256, type AccountFacts, type Pin, type RawToolFacts, type SendResult } from './tool-ledger.js';
import { ACCOUNT_STATUSES, type ServiceOption } from './tools-protocol.js';

/** The only module that knows the Composio SDK. Everything it returns is a plain projection, never an SDK object. */

export type ProviderErrorCategory = 'unauthorized' | 'not_found' | 'rate_limited' | 'timeout' | 'unavailable';

/** A provider failure reduced to a safe category. It carries no provider text, header or address. */
export class ProviderError extends Error {
  constructor(readonly category: ProviderErrorCategory) {
    super(`provider:${category}`);
  }
}

export type Provider = {
  /** The ways to connect a service that the provider project really offers. */
  catalog(): Promise<ServiceOption[]>;
  /** Starts a connection. The address is for the person who asked, once. */
  startLink(serviceId: string, alias: string, callbackUrl: string): Promise<{ accountId: string; toolkit: string; redirectUrl: string }>;
  /** The account as the provider reports it for this space's owner, or null when the owner has no such account. */
  account(accountId: string, toolkit: string): Promise<AccountFacts | null>;
  /** The raw catalogue of a session pinned to this account, optionally limited to some actions. */
  toolsFor(toolkit: string, accountId: string, only?: readonly string[]): Promise<RawToolFacts[]>;
  /** Sends one approved action once. It never retries and never falls back to another execution path. */
  send(pin: Pin, args: Record<string, unknown>): Promise<SendResult>;
};

type Sdk = InstanceType<typeof Composio>;
type SdkSession = Awaited<ReturnType<Sdk['sessions']['create']>>;

/** The part of the SDK this adapter uses, with the SDK's own signatures. Tests replace exactly this. */
export type SdkPort = {
  authConfigs: Pick<Sdk['authConfigs'], 'list'>;
  connectedAccounts: Pick<Sdk['connectedAccounts'], 'list'>;
  sessions: { create(...args: Parameters<Sdk['sessions']['create']>): Promise<SessionPort> };
  tools: Pick<Sdk['tools'], 'getRawToolRouterSessionTools'>;
};
/** `authorize` and `execute` keep the published function types, which take no request options. */
export type SessionPort = Pick<SdkSession, 'sessionId' | 'execute'> & {
  authorize(...args: Parameters<SdkSession['authorize']>): Promise<ConnectionRequestState>;
};

const API_BASE_URL = 'https://backend.composio.dev';
const PAGE_LIMIT = 50;
const MAX_PAGES = 20;

/**
 * The key is passed explicitly with a fixed address, and every other credential source is switched off:
 * the SDK otherwise reads the environment and a file in the home directory.
 */
export function createComposioSdk(apiKey: string): SdkPort {
  return new Composio({
    apiKey, userApiKey: null, orgApiKey: null, baseURL: API_BASE_URL,
    allowTracking: false, disableVersionCheck: true, logLevel: 'silent',
    dangerouslyAllowAutoUploadDownloadFiles: false, fileUploadDirs: false,
  });
}

function categoryOf(error: unknown): ProviderErrorCategory {
  if (error instanceof ProviderError) return error.category;
  const status = error !== null && typeof error === 'object' && 'status' in error ? error.status : undefined;
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  return 'unavailable';
}

/** Bounds a provider call. A late answer is dropped: the caller has already recorded what it knows. */
function within<T>(ms: number, work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProviderError('timeout')), ms);
    work.then(value => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

export function createComposioProvider(options: {
  sdk: SdkPort;
  /** Stable private identity of this space at the provider. Never chosen by a model or a browser. */
  ownerId: string;
  readTimeoutMs?: number;
  executeTimeoutMs?: number;
}): Provider {
  const { sdk, ownerId } = options;
  const readTimeout = options.readTimeoutMs ?? 30_000;
  const executeTimeout = options.executeTimeoutMs ?? 120_000;

  /** Every read is bounded, and every failure leaves as a category only. */
  async function guarded<T>(body: () => Promise<T>): Promise<T> {
    try {
      return await within(readTimeout, body());
    } catch (error) {
      throw new ProviderError(categoryOf(error));
    }
  }

  const pinnedSession = (toolkit: string, accountId: string, only?: readonly string[]) =>
    sdk.sessions.create(ownerId, {
      sessionPreset: SessionPreset.DIRECT_TOOLS,
      toolkits: { enable: [toolkit] },
      ...(only ? { tools: { [toolkit]: { enable: [...only] } } } : {}),
      connectedAccounts: { [toolkit]: accountId },
      manageConnections: false,
      sandbox: { enable: false },
      proxyExecute: false,
    });

  const rawTools = async (sessionId: string): Promise<RawToolFacts[]> =>
    (await sdk.tools.getRawToolRouterSessionTools(sessionId)).map(tool => ({
      slug: tool.slug,
      toolkit: tool.toolkit?.slug ?? '',
      name: tool.name,
      description: tool.description ?? '',
      version: tool.version ?? null,
      inputSchema: tool.inputParameters ?? null,
    }));

  async function catalog(): Promise<ServiceOption[]> {
    return guarded(async () => {
      const services: ServiceOption[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const listed = await sdk.authConfigs.list({ showDisabled: false, limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) });
        for (const config of listed.items) {
          if (config.status !== 'ENABLED') continue;
          const reason = config.authScheme !== 'OAUTH2'
            ? `Méthode de connexion non prise en charge ici (${config.authScheme ?? 'inconnue'}). Seul OAuth 2 est pris en charge.`
            : config.isEnabledForToolRouter === false ? 'Cette configuration n’est pas activée pour les sessions du fournisseur.' : null;
          services.push({ id: config.id, toolkit: config.toolkit.slug, name: config.name, connectable: reason === null, reason });
        }
        if (!listed.nextCursor) break;
        cursor = listed.nextCursor;
      }
      return services;
    });
  }

  return {
    catalog,
    async startLink(serviceId, alias, callbackUrl) {
      const service = (await catalog()).find(candidate => candidate.id === serviceId);
      if (!service?.connectable) throw new ProviderError('not_found');
      return guarded(async () => {
        const session = await sdk.sessions.create(ownerId, {
          sessionPreset: SessionPreset.DIRECT_TOOLS,
          toolkits: { enable: [service.toolkit] },
          authConfigs: { [service.toolkit]: service.id },
          manageConnections: false,
          sandbox: { enable: false },
          proxyExecute: false,
        });
        const request = await session.authorize(service.toolkit, { callbackUrl, alias });
        if (!request.redirectUrl || !URL.canParse(request.redirectUrl) || new URL(request.redirectUrl).protocol !== 'https:') throw new ProviderError('unavailable');
        return { accountId: request.id, toolkit: service.toolkit, redirectUrl: request.redirectUrl };
      });
    },
    async account(accountId, toolkit) {
      return guarded(async () => {
        let cursor: string | undefined;
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const listed = await sdk.connectedAccounts.list({ userIds: [ownerId], toolkitSlugs: [toolkit], limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) });
          const found = listed.items.find(item => item.id === accountId);
          if (found) {
            const status = ACCOUNT_STATUSES.find(candidate => candidate === found.status);
            if (!status) throw new ProviderError('unavailable');
            return { id: found.id, toolkit: found.toolkit.slug, alias: found.alias?.trim() || found.wordId?.trim() || found.id, status: found.isDisabled ? 'INACTIVE' : status };
          }
          if (!listed.nextCursor) break;
          cursor = listed.nextCursor;
        }
        return null;
      });
    },
    async toolsFor(toolkit, accountId, only) {
      return guarded(async () => rawTools((await pinnedSession(toolkit, accountId, only)).sessionId));
    },
    async send(pin, args) {
      let session: SessionPort;
      let tools: RawToolFacts[];
      try {
        const opened = await within(readTimeout, pinnedSession(pin.toolkit, pin.accountId, [pin.toolSlug]));
        session = opened;
        tools = await within(readTimeout, rawTools(opened.sessionId));
      } catch {
        return { kind: 'not_sent', reason: 'session' };
      }
      // The check reads the session that will execute, because execute takes no version.
      const tool = tools.find(candidate => candidate.slug === pin.toolSlug);
      if (!tool || tool.toolkit !== pin.toolkit) return { kind: 'not_sent', reason: 'tool_absent' };
      if (!tool.version) return { kind: 'not_sent', reason: 'version_missing' };
      if (tool.version !== pin.version || schemaSha256(tool.inputSchema) !== pin.schemaSha256) return { kind: 'not_sent', reason: 'schema_changed' };
      try {
        const result = await within(executeTimeout, session.execute(pin.toolSlug, args, { account: pin.accountId }));
        return { kind: result.resultType, data: result.data, error: result.error, logId: result.logId };
      } catch (error) {
        if (error instanceof ComposioToolInputRequiredError) return { kind: 'input_required' };
        if (error instanceof ProviderError) return { kind: 'unknown', category: 'timeout' };
        return { kind: 'unknown', category: error instanceof Error && error.name === 'ZodError' ? 'response' : 'transport' };
      }
    },
  };
}
