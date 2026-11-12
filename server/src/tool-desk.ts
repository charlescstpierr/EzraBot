import { randomUUID } from 'node:crypto';
import { ProviderError, type Provider, type ProviderErrorCategory } from './composio.js';
import type { TurnTools } from './engine.js';
import type { Claim, Store } from './store.js';
import { assessTool, type AccountReading, type LiveFacts, type SendResult } from './tool-ledger.js';
import {
  AvailableQuerySchema,
  LinkRequestSchema,
  ToolCommandSchema,
  isMetaTool,
  type AvailableTool,
  type ToolCommand,
  type ToolOutcome,
  type ToolRefusalCode,
  type ToolsReply,
  type ToolsView,
} from './tools-protocol.js';

export type DeskRequest = { method: 'GET' | 'POST'; route: string; query: URLSearchParams; body: unknown };

export type DeskFailure = { ok: false; code: ToolRefusalCode; message: string };
export type DeskResponse =
  | { status: number; body: ({ ok: true } & ToolsReply) | DeskFailure }
  | { status: number; outcome: ToolOutcome }
  | { status: number; page: string };

export type ActionDesk = {
  view(): ToolsView;
  forClaim(claim: Claim): TurnTools | undefined;
  /** Null when the route does not exist. */
  route(request: DeskRequest): Promise<DeskResponse | null>;
  kick(): void;
  idle(): Promise<void>;
  close(): Promise<void>;
};

export type DeskEvent = { event: 'tools'; action: string; ok: boolean; code?: string };

const PROVIDER_MESSAGES: Record<ProviderErrorCategory, string> = {
  unauthorized: 'Le fournisseur refuse la clé de ce serveur. Vérifiez la clé Composio du serveur.',
  not_found: 'Le fournisseur ne connaît pas cet élément pour cet espace.',
  rate_limited: 'Le fournisseur limite les appels pour le moment. Réessayez plus tard.',
  timeout: 'Le fournisseur n’a pas répondu à temps.',
  unavailable: 'Le fournisseur est indisponible pour le moment.',
};
const MISSING_KEY = 'Aucune clé Composio n’est configurée sur ce serveur. Les services connectés sont désactivés.';

const STATUS: Partial<Record<ToolRefusalCode, number>> = { invalid_command: 422, not_found: 404, provider_unavailable: 503 };

const CALLBACK_PAGE = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Retour à EzraBot</title></head>
<body><p>Vous pouvez fermer cet onglet et revenir à EzraBot. Utilisez « Vérifier la connexion » pour connaître son état.</p></body></html>`;

const failure = (code: ToolRefusalCode, message: string): DeskResponse => ({ status: STATUS[code] ?? 409, body: { ok: false, code, message } });

export function createActionDesk(options: {
  store: Store;
  /** Null when the server has no provider key. */
  provider: Provider | null;
  port: number;
  wake(): void;
  log?: (entry: DeskEvent) => void;
  closeGraceMs?: number;
}): ActionDesk {
  const { store, provider } = options;
  const ledger = store.tools;
  const log = options.log ?? (() => {});
  let stopping = false;
  let closed = false;
  let draining: Promise<void> | null = null;
  let again = false;

  const view = (): ToolsView => ledger.view(provider ? { state: 'ready' } : { state: 'missing_key' });

  async function dispatch(executionId: string, pin: { accountId: string; toolkit: string }, port: Provider): Promise<void> {
    let reading: AccountReading;
    try {
      const account = await port.account(pin.accountId, pin.toolkit);
      reading = account ? { kind: 'found', account } : { kind: 'absent' };
    } catch {
      reading = { kind: 'unreachable' };
    }
    if (closed) return;
    const permit = ledger.claimDispatch(executionId, reading);
    if (!permit) {
      log({ event: 'tools', action: 'dispatch', ok: false, code: 'voided' });
      return;
    }
    const result = await port.send(permit.pin, permit.arguments).catch((): SendResult => ({ kind: 'unknown', category: 'transport' }));
    if (closed) return;
    ledger.settle(permit, result);
    log({ event: 'tools', action: 'dispatch', ok: result.kind === 'completed', code: result.kind });
    options.wake();
  }

  async function drain(): Promise<void> {
    do {
      again = false;
      for (let next = ledger.nextApproved(); next && !stopping; next = stopping ? null : ledger.nextApproved()) {
        if (provider) await dispatch(next.executionId, next.pin, provider);
        else ledger.claimDispatch(next.executionId, { kind: 'unreachable' });
      }
    } while (again && !stopping);
  }

  function kick(): void {
    if (stopping) return;
    if (draining) {
      again = true;
      return;
    }
    draining = drain().catch(() => log({ event: 'tools', action: 'dispatch', ok: false, code: 'error' })).finally(() => {
      draining = null;
    });
  }

  async function reading<T>(port: Provider, body: (port: Provider) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; response: DeskResponse }> {
    try {
      return { ok: true, value: await body(port) };
    } catch (error) {
      const category = error instanceof ProviderError ? error.category : 'unavailable';
      return { ok: false, response: failure(category === 'not_found' ? 'not_found' : 'provider_unavailable', PROVIDER_MESSAGES[category]) };
    }
  }

  async function liveFacts(command: ToolCommand, port: Provider): Promise<LiveFacts | null> {
    const target = command.type === 'tools.approve' ? ledger.peek(command.proposalId)
      : command.type === 'tools.grant' ? ledger.account(command.accountId) : null;
    if (!target) return null;
    const accountId = 'accountId' in target ? target.accountId : target.id;
    const only = command.type === 'tools.grant' ? command.toolSlugs : 'toolSlug' in target ? [target.toolSlug] : [];
    try {
      const account = await port.account(accountId, target.toolkit);
      return { account, tools: account ? await port.toolsFor(target.toolkit, accountId, only) : [] };
    } catch {
      return null;
    }
  }

  async function command(body: unknown): Promise<DeskResponse> {
    const parsed = ToolCommandSchema.safeParse(body);
    if (!parsed.success) {
      log({ event: 'tools', action: 'unknown', ok: false, code: 'invalid_command' });
      return { status: 422, outcome: { ok: false, code: 'invalid_command', message: 'Cette commande est incomplète ou invalide.' } };
    }
    const input = parsed.data;
    const needsProvider = input.type === 'tools.grant' || input.type === 'tools.approve';
    let outcome = ledger.apply(input, null);
    if (needsProvider && !outcome.ok && outcome.code === 'provider_unavailable') {
      if (!provider) outcome = { ok: false, code: 'provider_unavailable', message: MISSING_KEY };
      else if (input.type === 'tools.grant' && !ledger.account(input.accountId)) outcome = { ok: false, code: 'not_found', message: 'Ce compte n’est pas relié à cet espace. Reliez-le d’abord dans les préférences.' };
      else outcome = ledger.apply(input, await liveFacts(input, provider));
    }
    log({ event: 'tools', action: input.type, ok: outcome.ok, ...(outcome.ok ? {} : { code: outcome.code }) });
    if (outcome.ok) {
      kick();
      options.wake();
    }
    return { status: outcome.ok ? 200 : STATUS[outcome.code] ?? 409, outcome };
  }

  async function checkLink(linkId: string, port: Provider): Promise<DeskResponse> {
    const link = ledger.link(linkId);
    if (!link) return failure('not_found', 'Cette demande de connexion n’existe pas.');
    const read = await reading(port, p => p.account(link.accountId, link.toolkit));
    if (!read.ok) return read.response;
    if (read.value) ledger.observeAccount(read.value);
    const checked = ledger.link(linkId) ?? link;
    log({ event: 'tools', action: 'link.check', ok: true, code: checked.state });
    return { status: 200, body: { ok: true, kind: 'checked', link: checked } };
  }

  async function route(request: DeskRequest): Promise<DeskResponse | null> {
    const { method, route: path } = request;
    if (method === 'POST' && path === 'commands') return command(request.body);
    const linkCheck = /^links\/([A-Za-z0-9_-]{1,80})\/check$/.exec(path);
    const known = (method === 'GET' && (path === 'catalog' || path === 'available' || path === 'callback')) || (method === 'POST' && (path === 'link' || linkCheck !== null));
    if (!known) return null;
    if (!provider) return path === 'callback' ? { status: 200, page: CALLBACK_PAGE } : failure('provider_unavailable', MISSING_KEY);

    if (path === 'catalog') {
      const read = await reading(provider, p => p.catalog());
      return read.ok ? { status: 200, body: { ok: true, kind: 'catalog', services: read.value } } : read.response;
    }
    if (path === 'link') {
      const parsed = LinkRequestSchema.safeParse(request.body);
      if (!parsed.success) return failure('invalid_command', 'Choisissez un service et donnez un nom à ce compte.');
      const linkId = `tl_${randomUUID()}`;
      const callbackUrl = `http://127.0.0.1:${options.port}/api/tools/callback?link=${linkId}`;
      const read = await reading(provider, p => p.startLink(parsed.data.serviceId, parsed.data.alias, callbackUrl));
      log({ event: 'tools', action: 'link', ok: read.ok });
      if (!read.ok) return read.response;
      ledger.recordLink({ linkId, toolkit: read.value.toolkit, accountId: read.value.accountId });
      return { status: 200, body: { ok: true, kind: 'link', linkId, redirectUrl: read.value.redirectUrl } };
    }
    if (linkCheck?.[1]) return checkLink(linkCheck[1], provider);
    if (path === 'callback') {
      const linkId = request.query.get('link') ?? '';
      if (/^[A-Za-z0-9_-]{1,80}$/.test(linkId)) await checkLink(linkId, provider);
      return { status: 200, page: CALLBACK_PAGE };
    }
    const query = AvailableQuerySchema.safeParse({ accountId: request.query.get('accountId') });
    const account = query.success ? ledger.account(query.data.accountId) : null;
    if (!account) return failure('not_found', 'Ce compte n’est pas relié à cet espace.');
    const read = await reading(provider, p => p.toolsFor(account.toolkit, account.id));
    if (!read.ok) return read.response;
    const tools: AvailableTool[] = read.value.filter(tool => !isMetaTool(tool.slug)).map(tool => {
      const assessment = assessTool(tool, account.toolkit);
      return {
        slug: tool.slug, name: tool.name, description: Array.from(tool.description).slice(0, 300).join(''), version: tool.version,
        grantable: assessment.ok, reason: assessment.ok ? null : assessment.reason,
      };
    });
    return { status: 200, body: { ok: true, kind: 'available', tools } };
  }

  return {
    view,
    forClaim(claim) {
      if (claim.lane !== 'chat' || claim.purpose.kind !== 'request' || !claim.toolGrants.length) return undefined;
      return {
        specs: claim.toolGrants.map(grant => ({ name: grant.toolSlug, description: grant.description, inputSchema: grant.inputSchema })),
        call: async call => ledger.propose(claim, call),
      };
    },
    route,
    kick,
    async idle() {
      while (draining) await draining;
    },
    async close() {
      stopping = true;
      const pending = draining;
      if (pending) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([pending, new Promise<void>(resolve => { timer = setTimeout(resolve, options.closeGraceMs ?? 5_000); })]);
        clearTimeout(timer);
      }
      closed = true;
    },
  };
}
