import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { ReceiveOutcome } from './events.js';
import { EVENT_LIMITS } from './protocol.js';

declare const authenticated: unique symbol;
/**
 * An event whose raw bytes this server authenticated, and whose scope it checked against its own configuration.
 * Only `verifyDelivery` builds one. `data` stays in memory: the store copies only the fields a subscription names.
 */
export type VerifiedDelivery = Readonly<{
  transport: string;
  webhookId: string;
  bodySha256: string;
  triggerId: string;
  triggerSlug: string;
  accountId: string;
  data: Readonly<Record<string, unknown>>;
}> & { readonly [authenticated]: true };

export type EventIngressConfig = {
  /** Stable name of the provider project this secret signs for. Event identities are kept under it across secret changes. */
  transport: string;
  /** The current secret, then the previous one while the operator keeps it. */
  secrets: readonly Buffer[];
  port: number;
  bind: string;
};

export class EventIngressConfigError extends Error {
  constructor() {
    super('La réception d’événements est incomplète ou invalide. Donnez ensemble MINO_EVENTS_TRANSPORT (minuscules, chiffres, _ ou -, 40 au plus), MINO_EVENTS_PORT (1024 à 65535) et COMPOSIO_WEBHOOK_SECRET (16 caractères visibles au moins), avec au besoin COMPOSIO_WEBHOOK_SECRET_PREVIOUS et MINO_EVENTS_BIND (une adresse IP), ou aucun de ces réglages.');
  }
}

const secret = z.string().regex(/^[\x21-\x7e]{16,4096}$/);
const EventEnvSchema = z.strictObject({
  transport: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
  secret,
  previous: secret.optional(),
  port: z.number().int().min(1024).max(65535),
  bind: z.string().refine(address => isIP(address) !== 0),
});

/**
 * Reads the event settings of this server, then removes both webhook secrets from the environment, so no engine and
 * no child process ever inherits them. Null when none is given: nothing listens.
 */
export function takeEventIngressConfig(env: NodeJS.ProcessEnv): EventIngressConfig | null {
  const given = {
    transport: env.MINO_EVENTS_TRANSPORT?.trim(), secret: env.COMPOSIO_WEBHOOK_SECRET?.trim(), previous: env.COMPOSIO_WEBHOOK_SECRET_PREVIOUS?.trim(),
    port: env.MINO_EVENTS_PORT?.trim(), bind: env.MINO_EVENTS_BIND?.trim(),
  };
  delete env.COMPOSIO_WEBHOOK_SECRET;
  delete env.COMPOSIO_WEBHOOK_SECRET_PREVIOUS;
  if (Object.values(given).every(value => !value)) return null;
  const parsed = EventEnvSchema.safeParse({
    transport: given.transport, secret: given.secret, ...(given.previous ? { previous: given.previous } : {}),
    port: given.port ? Number(given.port) : undefined, bind: given.bind || '127.0.0.1',
  });
  if (!parsed.success) throw new EventIngressConfigError();
  const { transport, port, bind, previous } = parsed.data;
  return { transport, port, bind, secrets: [parsed.data.secret, ...(previous ? [previous] : [])].map(value => Buffer.from(value, 'utf8')) };
}

const WEBHOOK_ID = /^[A-Za-z0-9_.:+-]{1,120}$/;
const PROVIDER_ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const SIGNATURE = /^[A-Za-z0-9+/]{43}=$/;
const MAX_SIGNATURES = 8;
const TRIGGER_MESSAGE = 'composio.trigger.message';

export type Verification =
  | { kind: 'verified'; delivery: VerifiedDelivery }
  /** Authenticated, but another kind of provider notice: acknowledged, nothing kept. */
  | { kind: 'other' }
  | { kind: 'rejected'; status: 400 | 401 };

const reject = (status: 400 | 401): Verification => ({ kind: 'rejected', status });
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function one(headers: Readonly<Record<string, readonly string[] | undefined>>, name: string): string | null {
  const values = headers[name];
  return values?.length === 1 && values[0] !== undefined ? values[0] : null;
}

/**
 * Authenticates the exact bytes received, then checks the scope against this server's configuration.
 * The provider SDK's parser is not used: it would replace the event id with the trigger id.
 */
export function verifyDelivery(raw: Buffer, headers: Readonly<Record<string, readonly string[] | undefined>>, config: Pick<EventIngressConfig, 'transport' | 'secrets'>, nowMs: number, ownerId: string): Verification {
  const webhookId = one(headers, 'webhook-id');
  const timestamp = one(headers, 'webhook-timestamp');
  const signatures = one(headers, 'webhook-signature');
  const version = one(headers, 'x-composio-webhook-version');
  if (webhookId === null || timestamp === null || signatures === null || version === null) return reject(400);
  if (!WEBHOOK_ID.test(webhookId) || !/^[0-9]{1,12}$/.test(timestamp) || raw.length === 0) return reject(400);
  const offered = signatures.split(' ');
  if (offered.length > MAX_SIGNATURES) return reject(400);
  const v1 = offered.flatMap(entry => {
    const [scheme, value, ...rest] = entry.split(',');
    return scheme === 'v1' && value !== undefined && rest.length === 0 && SIGNATURE.test(value) ? [Buffer.from(value, 'base64')] : [];
  });
  if (!v1.length) return reject(401);
  const signed = Buffer.concat([Buffer.from(`${webhookId}.${timestamp}.`, 'utf8'), raw]);
  const expected = config.secrets.map(key => createHmac('sha256', key).update(signed).digest());
  if (!v1.some(candidate => expected.some(digest => timingSafeEqual(candidate, digest)))) return reject(401);
  if (Math.abs(nowMs - Number(timestamp) * 1000) > EVENT_LIMITS.skewSeconds * 1000) return reject(400);
  if (version !== 'V3') return reject(400);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    return reject(400);
  }
  if (!record(body) || body.id !== webhookId || typeof body.type !== 'string') return reject(400);
  if (body.type !== TRIGGER_MESSAGE) return body.type.startsWith('composio.') ? { kind: 'other' } : reject(400);
  const { metadata, data } = body;
  if (!record(metadata) || !record(data)) return reject(400);
  const { trigger_id: triggerId, trigger_slug: triggerSlug, connected_account_id: accountId, user_id: userId } = metadata;
  if (typeof triggerId !== 'string' || !PROVIDER_ID.test(triggerId) || typeof accountId !== 'string' || !PROVIDER_ID.test(accountId)
    || typeof triggerSlug !== 'string' || !/^[A-Z0-9_]{1,120}$/.test(triggerSlug) || userId !== ownerId) return reject(400);
  const delivery = {
    transport: config.transport, webhookId, triggerId, triggerSlug, accountId, data,
    bodySha256: createHash('sha256').update(raw).digest('hex'),
  };
  // The one place a delivery is constructed: every field above was authenticated or checked.
  return { kind: 'verified', delivery: delivery as VerifiedDelivery };
}

const STATUS: Record<ReceiveOutcome['status'], number> = { new: 200, duplicate: 200, ignored: 200, conflict: 409, unavailable: 503 };

export type IngressEvent = { event: 'events'; status: number; outcome?: string };

/**
 * The listener for signed provider events, apart from the PC and phone servers: it shares no cookie, origin or
 * session with them. It answers only after the store committed its decision.
 */
export function createEventIngress(options: {
  config: EventIngressConfig;
  ownerId: string;
  receive(delivery: VerifiedDelivery): ReceiveOutcome;
  /** Called after every committed admission and every admitted duplicate, so a lost wake-up is caught by the next retry. */
  wake(): void;
  log?: (entry: IngressEvent) => void;
  now?: () => number;
}): Server {
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  const answer = (res: ServerResponse, status: number, outcome?: string) => {
    log({ event: 'events', status, ...(outcome ? { outcome } : {}) });
    if (res.headersSent || res.destroyed) return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', connection: 'close' });
    res.end(JSON.stringify({ ok: status === 200 }));
  };

  function read(req: IncomingMessage): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > EVENT_LIMITS.bodyBytes) {
          req.removeAllListeners('data');
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (new URL(req.url ?? '/', 'http://events').pathname !== '/events/composio') return answer(res, 404);
    if (req.method !== 'POST') return answer(res, 405);
    const declared = Number(req.headers['content-length'] ?? 0);
    if (!Number.isFinite(declared) || declared > EVENT_LIMITS.bodyBytes) return answer(res, 413);
    const raw = await read(req);
    if (raw === null) return answer(res, 413);
    const verified = verifyDelivery(raw, req.headersDistinct, options.config, now(), options.ownerId);
    if (verified.kind === 'rejected') return answer(res, verified.status);
    if (verified.kind === 'other') return answer(res, 200, 'other');
    const outcome = options.receive(verified.delivery);
    if ((outcome.status === 'new' || outcome.status === 'duplicate') && outcome.outcome === 'admitted') options.wake();
    answer(res, STATUS[outcome.status], outcome.status === 'new' || outcome.status === 'duplicate' ? `${outcome.status}:${outcome.outcome}` : outcome.status);
  }

  const server = createServer({ requestTimeout: EVENT_LIMITS.deadlineMs, headersTimeout: EVENT_LIMITS.deadlineMs, keepAliveTimeout: 1000 }, (req, res) => {
    void handle(req, res).catch(() => answer(res, 500));
  });
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 1;
  return server;
}
