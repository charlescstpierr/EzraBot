import { engineFailure } from './domain.js';
import type { AgentText, Engine, TurnTools } from './engine.js';
import { LANES, type Lane } from './protocol.js';
import type { Claim, Store } from './store.js';

export type Worker = {
  /** Works whose engine run has not returned yet, in either lane, cancelled or not. */
  readonly activeWorkIds: readonly string[];
  kick(): void;
  /** Stops any running call the store no longer marks running, then looks for new work. */
  sync(): void;
  cancel(workId: string): void;
  idle(): Promise<void>;
  close(): Promise<void>;
};

export type WorkerEvent =
  | { event: 'job.claimed'; lane: Lane; workId: string; attempt: number }
  | { event: 'job.finished'; lane: Lane; workId: string; attempt: number; outcome: string; recorded: boolean }
  | { event: 'worker.error' };

/** Received text is written at most this often per call, plus a last write when the call ends. */
export const PROGRESS_INTERVAL_MS = 400;

type LaneRunner = {
  readonly active: { workId: string; attemptId: string; controller: AbortController } | null;
  kick(): void;
  idle(): Promise<void>;
  close(): Promise<void>;
};

export function createWorker(options: {
  store: Store;
  engines: Record<Lane, Engine>;
  /** Service tools for a chat turn. The document lane never asks. */
  tools?: { forClaim(claim: Claim): TurnTools | undefined };
  log?: (entry: WorkerEvent) => void;
  onFatal?: () => void;
  progressIntervalMs?: number;
}): Worker {
  const { store } = options;
  const log = options.log ?? (() => {});
  const interval = options.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
  let closed = false;
  const fatal = () => {
    if (closed) return;
    closed = true;
    log({ event: 'worker.error' });
    options.onFatal?.();
  };
  const guarded = (write: () => void) => {
    if (closed) return;
    try {
      write();
    } catch {
      fatal();
    }
  };

  function lane(name: Lane, engine: Engine): LaneRunner {
    let active: LaneRunner['active'] = null;
    let draining: Promise<void> | null = null;
    let again = false;
    const unsubscribe = engine.onUsage(observation => guarded(() => store.observeUsage(observation)));

    async function runClaim(claim: Claim): Promise<void> {
      const controller = new AbortController();
      active = { workId: claim.workId, attemptId: claim.attemptId, controller };
      log({ event: 'job.claimed', lane: name, workId: claim.workId, attempt: claim.n });
      let pending: AgentText | null = null;
      let timer: NodeJS.Timeout | null = null;
      const flush = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        const text = pending;
        pending = null;
        if (text) guarded(() => store.recordProgress(claim, text));
      };
      const offered = name === 'chat' ? options.tools?.forClaim(claim) : undefined;
      let departed = false;
      const ran = await engine.run({
        ...(offered ? { tools: offered } : {}),
        turn: claim.turn,
        choice: claim.choice,
        signal: controller.signal,
        onStage: stage => guarded(() => store.setStage(claim, stage)),
        onThread: threadId => guarded(() => store.bindThread(claim, threadId)),
        onTurn: turnId => guarded(() => store.bindTurn(claim, turnId)),
        depart: () => {
          const departure = closed ? { ok: false as const, reason: 'Mino s’arrête. L’appel n’est pas parti.' } : store.depart(claim);
          departed = departure.ok;
          return departure;
        },
        ...(name === 'doc' ? {
          onText: (text: AgentText) => {
            pending = text;
            if (text.final) flush();
            else timer ??= setTimeout(flush, interval);
          },
        } : {}),
      }).catch(() => engineFailure('engine_exited'));
      // An engine that answers without having taken its permit skipped the last check: its answer is not recorded.
      const outcome = ran.kind === 'succeeded' && !departed ? engineFailure('admission_refused', 'Le moteur a répondu sans prendre son permis de départ. Mino n’a rien enregistré.') : ran;
      flush();
      active = null;
      if (closed) return;
      const recorded = store.finishJob(claim, outcome);
      log({ event: 'job.finished', lane: name, workId: claim.workId, attempt: claim.n, outcome: outcome.kind, recorded: recorded.kind === 'recorded' });
    }

    async function drain(): Promise<void> {
      do {
        again = false;
        for (let claim = store.claimNext(name); claim && !closed; claim = closed ? null : store.claimNext(name)) await runClaim(claim);
      } while (again && !closed);
    }

    return {
      get active() {
        return active;
      },
      kick() {
        if (closed) return;
        if (draining) {
          again = true;
          return;
        }
        draining = drain().catch(fatal).finally(() => {
          draining = null;
        });
      },
      async idle() {
        while (draining) await draining;
      },
      async close() {
        unsubscribe();
        active?.controller.abort();
        await draining;
      },
    };
  }

  const runners = LANES.map(name => lane(name, options.engines[name]));
  const kickAll = () => {
    for (const runner of runners) runner.kick();
  };

  return {
    get activeWorkIds() {
      return runners.flatMap(runner => (runner.active ? [runner.active.workId] : []));
    },
    kick: kickAll,
    sync() {
      for (const runner of runners) {
        const active = runner.active;
        if (active && !store.attemptRunning(active.attemptId)) active.controller.abort();
      }
      kickAll();
    },
    cancel(workId) {
      for (const runner of runners) if (runner.active?.workId === workId) runner.active.controller.abort();
    },
    async idle() {
      for (let settled = false; !settled;) {
        await Promise.all(runners.map(runner => runner.idle()));
        settled = runners.every(runner => !runner.active);
      }
    },
    async close() {
      closed = true;
      await Promise.all(runners.map(runner => runner.close()));
    },
  };
}
