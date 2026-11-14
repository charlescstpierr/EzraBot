import { engineFailure } from './domain.js';
import type { AgentText, Engine, TurnTools } from './engine.js';
import { LANES, type Lane } from './protocol.js';
import type { MemoryDesk } from './memory-desk.js';
import type { Claim, Store } from './store.js';

export type Worker = {
  /** Works whose engine run has not returned yet, in either lane, cancelled or not. */
  readonly activeWorkIds: readonly string[];
  kick(): void;
  /** Stops any running call the store no longer marks running or whose memory sources changed, then looks for new work. */
  sync(): void;
  cancel(workId: string): void;
  idle(): Promise<void>;
  close(): Promise<void>;
};

export type WorkerEvent =
  | { event: 'job.claimed'; lane: Lane; workId: string; attempt: number }
  | { event: 'job.finished'; lane: Lane; workId: string; attempt: number; outcome: string; recorded: boolean }
  | { event: 'worker.error' };

/** Plans in a row that may name another call before the chat call leaves without recall. */
const RECALL_PLANS = 3;

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
  /** Honcho recall for a chat turn. Without it a character with a Honcho project answers without memory. */
  memory?: Pick<MemoryDesk, 'recall'>;
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
      const outcome = ran.kind === 'succeeded' && !departed ? engineFailure('admission_refused', 'Le moteur a répondu sans prendre son permis de départ. Mino n’a rien enregistré.') : ran;
      flush();
      active = null;
      if (closed) return;
      const recorded = store.finishJob(claim, outcome);
      log({ event: 'job.finished', lane: name, workId: claim.workId, attempt: claim.n, outcome: outcome.kind, recorded: recorded.kind === 'recorded' });
    }

    /**
     * The recall is searched before the claim, outside any transaction, for the one call the store would take now.
     * When the store then takes another call, the search is planned again for that one.
     */
    async function claimNext(): Promise<Claim | null> {
      const memory = name === 'chat' ? options.memory : undefined;
      if (!memory) return store.claimNext(name);
      for (let plans = 0; plans < RECALL_PLANS; plans += 1) {
        const plan = store.planRecall();
        const recall = plan.kind === 'search' ? await memory.recall(plan) : plan;
        if (closed) return null;
        const claim = store.claimNext(name, recall);
        if (claim !== 'replan') return claim;
      }
      const claim = store.claimNext(name, { kind: 'forced' });
      return claim === 'replan' ? null : claim;
    }

    async function drain(): Promise<void> {
      do {
        again = false;
        for (let claim = await claimNext(); claim && !closed; claim = closed ? null : await claimNext()) await runClaim(claim);
      } while (again && !closed);
    }

    function kick(): void {
      if (closed) return;
      if (draining) {
        again = true;
        return;
      }
      // A claim can wait on a recall, so a kick may land after the last check of a drain and before it is cleared: it starts the next drain.
      draining = drain().catch(fatal).finally(() => {
        draining = null;
        if (again) kick();
      });
    }

    return {
      get active() {
        return active;
      },
      kick,
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
        if (active && (!store.attemptRunning(active.attemptId) || !store.memory.holds(active.attemptId).ok)) active.controller.abort();
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
