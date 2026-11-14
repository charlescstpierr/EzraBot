import { z } from 'zod';

export type HonchoHttpFailure = {
  kind: 'rejected' | 'unavailable' | 'uncertain';
  reason: 'invalid-input' | 'cancelled' | 'timeout' | 'network' | 'redirect' | 'unauthorized'
    | 'rate-limited' | 'not-found' | 'conflict' | 'http' | 'invalid-response' | 'response-too-large';
};
export type HonchoHttpResult<T> = { kind: 'ok'; value: T } | HonchoHttpFailure;
export type RemoteHonchoMessage = {
  remoteId: string;
  workspaceId: string;
  sessionId: string;
  peerId: string;
  text: string;
  createdAt: string;
};
export type HonchoWithdrawal =
  | { kind: 'message'; sessionId: string; remoteId: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'workspace' };

const segment = z.string().min(1).max(512).refine((s) => s !== '.' && s !== '..');
const name = z.string().min(1).max(512).regex(/^[a-zA-Z0-9_-]+$/);
const timestamp = z.iso.datetime({ offset: true });
const messageResponse = z.object({
  id: segment, workspace_id: segment, session_id: segment, peer_id: segment,
  content: z.string(), created_at: timestamp,
}).transform((m): RemoteHonchoMessage => ({
  remoteId: m.id, workspaceId: m.workspace_id, sessionId: m.session_id,
  peerId: m.peer_id, text: m.content, createdAt: m.created_at,
}));
const messageInput = z.object({
  peerId: name, text: z.string().max(100_000),
  metadata: z.record(z.string(), z.string()).optional(), createdAt: timestamp.optional(),
});
const peersInput = z.array(z.object({
  peerId: name, observeMe: z.boolean(), observeOthers: z.boolean(),
})).min(1).max(100).refine((peers) => new Set(peers.map((p) => p.peerId)).size === peers.length);

export class HonchoHttpClient {
  readonly #base: string;
  readonly #key: string;
  readonly #workspaceId: string;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;

  constructor(config: {
    baseUrl: string; apiKey: string; workspaceId: string; timeoutMs: number;
    maxResponseBytes: number; allowLoopbackHttpForTests?: boolean;
  }) {
    const parsed = z.object({
      baseUrl: z.url(), apiKey: z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/),
      workspaceId: name, timeoutMs: z.number().int().min(1).max(120_000),
      maxResponseBytes: z.number().int().min(1).max(4_194_304),
      allowLoopbackHttpForTests: z.boolean().optional(),
    }).safeParse(config);
    if (!parsed.success) throw new Error('Configuration Honcho invalide.');
    const url = new URL(parsed.data.baseUrl);
    const loopback = ['127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash
      || /[?#]/.test(parsed.data.baseUrl)
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && parsed.data.allowLoopbackHttpForTests))) {
      throw new Error('Configuration Honcho invalide.');
    }
    this.#base = url.href.replace(/\/$/, '');
    this.#key = parsed.data.apiKey;
    this.#workspaceId = parsed.data.workspaceId;
    this.#timeoutMs = parsed.data.timeoutMs;
    this.#maxResponseBytes = parsed.data.maxResponseBytes;
  }

  provisionWorkspace(signal?: AbortSignal): Promise<HonchoHttpResult<{ workspaceId: string }>> {
    const schema = z.object({ id: z.literal(this.#workspaceId) })
      .transform((w) => ({ workspaceId: w.id }));
    return this.#request('POST', '/v3/workspaces', { id: this.#workspaceId }, [200, 201], schema, true, signal);
  }

  provisionSession(input: {
    sessionId: string; peers: { peerId: string; observeMe: boolean; observeOthers: boolean }[];
  }, signal?: AbortSignal): Promise<HonchoHttpResult<{ sessionId: string }>> {
    const parsed = z.object({ sessionId: name, peers: peersInput }).safeParse(input);
    if (!parsed.success) return Promise.resolve({ kind: 'rejected', reason: 'invalid-input' });
    const { sessionId, peers } = parsed.data;
    const schema = z.object({ id: z.literal(sessionId), workspace_id: z.literal(this.#workspaceId) })
      .transform((s) => ({ sessionId: s.id }));
    return this.#request('POST', this.#path('sessions'), {
      id: sessionId,
      peers: Object.fromEntries(peers.map((p) => [p.peerId, { observe_me: p.observeMe, observe_others: p.observeOthers }])),
    }, [200, 201], schema, true, signal);
  }

  ingestMessages(input: {
    sessionId: string;
    messages: { peerId: string; text: string; metadata?: Record<string, string>; createdAt?: string }[];
  }, signal?: AbortSignal): Promise<HonchoHttpResult<RemoteHonchoMessage[]>> {
    const parsed = z.object({ sessionId: segment, messages: z.array(messageInput).min(1).max(100) }).safeParse(input);
    if (!parsed.success) return Promise.resolve({ kind: 'rejected', reason: 'invalid-input' });
    const { sessionId, messages } = parsed.data;
    const schema = this.#messages(sessionId).length(messages.length);
    return this.#request('POST', this.#path('sessions', sessionId, 'messages'), {
      messages: messages.map((m) => ({ peer_id: m.peerId, content: m.text,
        ...(m.metadata === undefined ? {} : { metadata: m.metadata }),
        ...(m.createdAt === undefined ? {} : { created_at: m.createdAt }),
      })),
    }, [201], schema, true, signal);
  }

  searchMessages(input: { query: string; limit: number; sessionId?: string }, signal?: AbortSignal): Promise<HonchoHttpResult<RemoteHonchoMessage[]>> {
    const parsed = z.object({ query: z.string().min(1).max(16_000), limit: z.number().int().min(1).max(100), sessionId: segment.optional() }).safeParse(input);
    if (!parsed.success) return Promise.resolve({ kind: 'rejected', reason: 'invalid-input' });
    const { query, limit, sessionId } = parsed.data;
    return this.#request('POST', this.#path('search'), {
      query, limit, ...(sessionId === undefined ? {} : { filters: { session_id: sessionId } }),
    }, [200], this.#messages(sessionId).max(limit), false, signal);
  }

  getMessage(input: { sessionId: string; remoteId: string }, signal?: AbortSignal): Promise<HonchoHttpResult<RemoteHonchoMessage>> {
    const parsed = z.object({ sessionId: segment, remoteId: segment }).safeParse(input);
    if (!parsed.success) return Promise.resolve({ kind: 'rejected', reason: 'invalid-input' });
    const { sessionId, remoteId } = parsed.data;
    const schema = messageResponse.refine((m) => m.workspaceId === this.#workspaceId && m.sessionId === sessionId && m.remoteId === remoteId);
    return this.#request('GET', this.#path('sessions', sessionId, 'messages', remoteId), undefined, [200], schema, false, signal);
  }

  requestWithdrawal(scope: HonchoWithdrawal, signal?: AbortSignal): Promise<HonchoHttpResult<{ kind: 'acknowledged'; purge: 'unverified' }> | { kind: 'unsupported' }> {
    if (scope.kind === 'message') return Promise.resolve({ kind: 'unsupported' });
    if (scope.kind === 'session' && !segment.safeParse(scope.sessionId).success) {
      return Promise.resolve({ kind: 'rejected', reason: 'invalid-input' });
    }
    const path = scope.kind === 'workspace' ? this.#path() : this.#path('sessions', scope.sessionId);
    return this.#request('DELETE', path, undefined, [202], z.object({ message: z.string() })
      .transform(() => ({ kind: 'acknowledged' as const, purge: 'unverified' as const })), true, signal);
  }

  #path(...parts: string[]): string {
    return `/v3/workspaces/${[this.#workspaceId, ...parts].map(encodeURIComponent).join('/')}`;
  }

  #messages(sessionId?: string) {
    return z.array(messageResponse.refine((m) => m.workspaceId === this.#workspaceId
      && (sessionId === undefined || m.sessionId === sessionId)));
  }

  async #request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body: unknown,
    statuses: number[], schema: z.ZodType<T>, write: boolean, signal?: AbortSignal): Promise<HonchoHttpResult<T>> {
    if (signal?.aborted) return { kind: 'rejected', reason: 'cancelled' };
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      response = await fetch(this.#base + path, {
        method, headers: { Authorization: `Bearer ${this.#key}`, Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: combined, redirect: 'manual',
      });
      if (!statuses.includes(response.status)) {
        const status = response.status;
        const reason = status >= 300 && status < 400 ? 'redirect'
          : status === 401 || status === 403 ? 'unauthorized' : status === 429 ? 'rate-limited'
          : status === 404 ? 'not-found' : status === 409 ? 'conflict' : 'http';
        return { kind: write && (status >= 500 || status === 408 || status < 400) ? 'uncertain'
          : status >= 400 && status < 500 ? 'rejected' : 'unavailable', reason };
      }
      reader = response.body?.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      if (reader) {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > this.#maxResponseBytes) return { kind: write ? 'uncertain' : 'unavailable', reason: 'response-too-large' };
          chunks.push(part.value);
        }
      }
      const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      const parsed = schema.safeParse(data);
      if (!parsed.success) return { kind: write ? 'uncertain' : 'unavailable', reason: 'invalid-response' };
      return { kind: 'ok', value: parsed.data };
    } catch {
      const reason = signal?.aborted ? 'cancelled' : timeout.aborted ? 'timeout'
        : response ? 'invalid-response' : 'network';
      return { kind: write ? 'uncertain' : 'unavailable', reason };
    } finally {
      if (reader) await reader.cancel().catch(() => {});
      else if (response?.body) await response.body.cancel().catch(() => {});
    }
  }
}
