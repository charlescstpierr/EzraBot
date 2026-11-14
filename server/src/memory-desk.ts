import type { HonchoConfig } from './child-env.js';
import { HonchoHttpClient } from './honcho-http.js';
import type { RecallOutcome, RecallPlan, SendPermit, Settlement } from './memory-ledger.js';
import type { Store } from './store.js';

export type MemoryDesk = {
  /** Sends the search of one plan and says how it ended. It never throws. */
  recall(plan: Extract<RecallPlan, { kind: 'search' }>): Promise<RecallOutcome>;
  kick(): void;
  idle(): Promise<void>;
  close(): Promise<void>;
};

export type MemoryEvent = { event: 'memory'; action: SendPermit['kind']; ok: boolean; code?: string };

const MAX_RESPONSE_BYTES = 1_048_576;
/** Consecutive requests refused at their departure before a drain gives up, so a guard that keeps failing cannot spin. */
const MAX_DRY_PERMITS = 3;

/**
 * The only place that calls Honcho. Every request was reserved by the store, takes its one-use permit in the same tick
 * as its `fetch`, and is settled by the store afterwards. Nothing here retries, and no call runs inside a SQLite transaction.
 */
export function createMemoryDesk(options: {
  store: Store;
  config: HonchoConfig;
  /** Tests only: lets the client reach a fake Honcho on a loopback address over plain HTTP. */
  allowLoopbackHttpForTests?: boolean;
  log?: (entry: MemoryEvent) => void;
  closeGraceMs?: number;
}): MemoryDesk {
  const ledger = options.store.memory;
  const log = options.log ?? (() => {});
  const { baseUrl, apiKey, timeoutMs } = options.config;
  /** A request keeps the workspace it was reserved for: a late one can never reach a newer workspace. */
  const clientFor = (workspaceId: string) => new HonchoHttpClient({
    baseUrl, apiKey, workspaceId, timeoutMs, maxResponseBytes: MAX_RESPONSE_BYTES,
    ...(options.allowLoopbackHttpForTests ? { allowLoopbackHttpForTests: true } : {}),
  });
  // Throws at start, before any request, when the address or the key cannot be used.
  clientFor('configuration');
  let stopping = false;
  let closed = false;
  let draining: Promise<void> | null = null;
  let again = false;
  const searches = new AbortController();

  async function send(permit: SendPermit): Promise<Settlement> {
    const client = clientFor(permit.workspaceId);
    switch (permit.kind) {
      case 'workspace': return { kind: 'workspace', result: await client.provisionWorkspace() };
      case 'session': return { kind: 'session', result: await client.provisionSession({
        sessionId: permit.session, peers: [{ peerId: permit.peerId, observeMe: false, observeOthers: false }],
      }) };
      case 'ingest': return { kind: 'ingest', result: await client.ingestMessages({ sessionId: permit.session, messages: [{ peerId: permit.peerId, text: permit.text }] }) };
      case 'read': return { kind: 'read', result: await client.getMessage({ sessionId: permit.session, remoteId: permit.remoteId }) };
      case 'search': return { kind: 'search', result: await client.searchMessages({
        query: permit.query, limit: permit.limit, ...(permit.session === null ? {} : { sessionId: permit.session }),
      }, searches.signal) };
      case 'withdraw': return { kind: 'withdraw', result: await client.requestWithdrawal(permit.session === null ? { kind: 'workspace' } : { kind: 'session', sessionId: permit.session }) };
    }
  }

  /** Null when the request did not leave. */
  async function exchange(requestId: string): Promise<Settlement | null> {
    const permit = ledger.begin(requestId);
    if (!permit) return null;
    const settlement = await send(permit);
    if (closed) return null;
    ledger.settle(requestId, settlement);
    const result = settlement.result;
    log({ event: 'memory', action: permit.kind, ok: result.kind === 'ok', ...(result.kind === 'ok' ? {} : { code: result.kind }) });
    return settlement;
  }

  async function drain(): Promise<void> {
    do {
      again = false;
      let dry = 0;
      for (let next = ledger.next(); next && !stopping && dry < MAX_DRY_PERMITS; next = stopping ? null : ledger.next()) {
        dry = await exchange(next) ? 0 : dry + 1;
      }
    } while (again && !stopping);
  }

  function kick(): void {
    if (stopping) return;
    if (draining) {
      again = true;
      return;
    }
    // A change of the store wakes the desk from inside the call that made it: the drain starts once that call has returned.
    draining = Promise.resolve().then(drain).catch(() => {}).finally(() => {
      draining = null;
      if (again) kick();
    });
  }
  const unsubscribe = options.store.onChange(kick);

  return {
    async recall(plan) {
      if (stopping) return { kind: 'unavailable', workId: plan.workId, category: 'provider' };
      const settlement = await exchange(plan.requestId);
      // A search that did not leave was planned for a state that moved: the caller plans again.
      if (!settlement) return { kind: 'none' };
      return settlement.result.kind === 'ok' ? { kind: 'found', workId: plan.workId, requestId: plan.requestId }
        : { kind: 'unavailable', workId: plan.workId, category: 'provider' };
    },
    kick,
    async idle() {
      while (draining) await draining;
    },
    async close() {
      stopping = true;
      unsubscribe();
      searches.abort();
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
