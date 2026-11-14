import { AGENT_LIMITS, type CheckView, type ObservedView } from './agent-protocol.js';
import { clip, type AgentEngine, type ExecOutcome } from './agent-engine.js';
import type { AttemptClaim, Missions } from './missions.js';
import { observeProject } from './project-guard.js';

export type AgentWorker = {
  kick(): void;
  /** Aborts the running turn or check when the registry marks the attempt stopping. */
  sync(): void;
  idle(): Promise<void>;
  close(): Promise<void>;
};

const OBSERVE_TIMEOUT_MS = 15_000;
type Observation = { observed: ObservedView } & ({ kind: 'complete' | 'cancelled' } | { kind: 'unknown'; message: string });

/** One executor at a time, taken from the global queue. The registry owns state; this loop only drives Codex. */
export function createAgentWorker(options: {
  missions: Missions;
  engine: AgentEngine;
  log?: (entry: Record<string, unknown>) => void;
  onFatal?: () => void;
  now?: () => string;
}): AgentWorker {
  const { missions, engine } = options;
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date().toISOString());
  let closed = false;
  /** Requests cancellation of observations outside an attempt when Mino closes. */
  const closing = new AbortController();
  let draining: Promise<void> | null = null;
  let again = false;
  let active: { claim: AttemptClaim; controller: AbortController } | null = null;

  const guarded = (write: () => void) => {
    if (closed) return;
    try { write(); } catch (error) {
      log({ event: 'agents.error', message: error instanceof Error ? error.message : 'unknown' });
      closed = true;
      options.onFatal?.();
    }
  };

  /** Git runs read-only; a later successful listing cannot confirm an earlier command's unknown stop. */
  async function observe(path: string, baseline: string[] | null, signal: AbortSignal): Promise<Observation> {
    const outcomes: ExecOutcome[] = [];
    const observed = await observeProject(path, baseline, now, async (argv, env) => {
      const result = await engine.exec({ cwd: path, argv, env, sandbox: 'read-only', signal, timeoutMs: OBSERVE_TIMEOUT_MS });
      outcomes.push(result);
      return result;
    });
    const unknown = outcomes.find(result => result.kind === 'unknown');
    if (unknown) return { kind: 'unknown', observed, message: unknown.message };
    return { kind: signal.aborted && outcomes.some(result => result.kind !== 'exited') ? 'cancelled' : 'complete', observed };
  }

  /** The project check, then the observation after it: the attempt stays active and stoppable until both are over. */
  async function verify(claim: AttemptClaim, signal: AbortSignal): Promise<void> {
    let check: CheckView | null = null;
    let end: 'done' | 'cancelled' | 'unknown' = 'done';
    let message: string | undefined;
    if (claim.checkCommand) {
      missions.setLive(claim.attemptId, `Contrôle de Mino : ${clip(claim.checkCommand.join(' '), 160)}`, '');
      const result = await engine.exec({ cwd: claim.cwd, argv: claim.checkCommand, sandbox: 'workspace-write', signal, timeoutMs: AGENT_LIMITS.checkTimeoutMs });
      const at = now();
      const command = claim.checkCommand;
      if (result.kind === 'exited') {
        check = { command, exitCode: result.exitCode, output: clip(`${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`, AGENT_LIMITS.eventOutputChars), at, error: null };
      } else if (result.kind === 'cancelled') {
        end = 'cancelled';
        check = { command, exitCode: null, output: '', at, error: 'Contrôle arrêté avant sa fin.' };
      } else if (result.kind === 'unknown') {
        end = 'unknown';
        message = `Le contrôle « ${command.join(' ')} » n’a pas confirmé sa fin. ${result.message}`;
        check = { command, exitCode: null, output: '', at, error: result.message };
      } else check = { command, exitCode: null, output: '', at, error: result.message };
    }
    if (closed) return;
    missions.setLive(claim.attemptId, 'Mino constate le dossier', '');
    const baseline = missions.baseline(claim.attemptId);
    const observation = await observe(claim.cwd, baseline, signal);
    if (observation.kind === 'unknown') {
      end = 'unknown';
      message = [message, `Le constat du dossier n’a pas confirmé sa fin. ${observation.message}`].filter(Boolean).join(' ');
    } else if (observation.kind === 'cancelled' && end === 'done') end = 'cancelled';
    guarded(() => missions.verified(claim, { check, observed: observation.observed, end, ...(message ? { message } : {}) }));
    if (observation.kind !== 'complete' && !closed) {
      const after = await observe(claim.cwd, baseline, closing.signal);
      if (after.kind === 'complete') guarded(() => missions.setObserved(claim.attemptId, after.observed));
    }
  }

  async function runClaim(claim: AttemptClaim): Promise<void> {
    const controller = new AbortController();
    active = { claim, controller };
    try {
      log({ event: 'agents.claimed', missionId: claim.missionId, attempt: claim.n, kind: claim.kind });
      const before = await observe(claim.cwd, null, controller.signal);
      guarded(() => missions.setBaseline(claim, before.observed.git && !before.observed.error ? before.observed.status : null));
      if (missions.stopRequested(claim.attemptId)) controller.abort();
      let departed = false;
      const ran: Parameters<Missions['finish']>[1] = before.kind === 'unknown'
        ? { kind: 'interrupted', message: `Le constat initial n’a pas confirmé sa fin. ${before.message}` }
        // Mino's final check of a coordinated mission has no model turn: it goes straight to the check and the observation.
        : claim.kind === 'final' ? { kind: 'completed', finalText: null, threadId: '', turnId: '' }
        : await engine.run({
          cwd: claim.cwd,
          sandbox: claim.sandbox,
          threadId: claim.threadId,
          model: claim.model,
          effort: claim.effort,
          developerInstructions: claim.developerInstructions,
          input: claim.input,
          outputSchema: claim.outputSchema,
          signal: controller.signal,
          depart: () => {
            const departure = closed ? { ok: false as const, reason: 'Mino s’arrête. La tentative n’est pas partie.' } : missions.depart(claim);
            departed = departure.ok;
            return departure;
          },
          onThread: (threadId, model, effort) => guarded(() => missions.bindThread(claim, threadId, model, effort)),
          onTurn: turnId => guarded(() => missions.bindTurn(claim, turnId)),
          onEvent: event => guarded(() => missions.recordEvent(claim, event)),
          onActivity: (activity, text) => missions.setLive(claim.attemptId, activity, text),
          onUsage: usage => guarded(() => missions.recordUsage(claim, usage)),
        }).catch((): Parameters<Missions['finish']>[1] => ({ kind: 'interrupted', message: 'L’exécutant a rencontré une erreur interne. Le résultat est inconnu.' }));
      // A model turn that completes without its permit skipped the last check: its report is not taken as a result.
      const outcome: typeof ran = ran.kind === 'completed' && claim.kind !== 'final' && !departed
        ? { kind: 'failed', code: 'admission_refused', message: 'L’exécutant a répondu sans prendre son permis de départ.', effects: true } : ran;
      if (closed && outcome.kind !== 'stopped' && outcome.kind !== 'completed') return;
      let state: ReturnType<Missions['finish']> = null;
      guarded(() => { state = missions.finish(claim, outcome); });
      log({ event: 'agents.finished', missionId: claim.missionId, attempt: claim.n, outcome: outcome.kind, recorded: state !== null });
      if (state === 'verifying') {
        if (missions.stopRequested(claim.attemptId)) controller.abort();
        await verify(claim, controller.signal);
      } else if (state !== null && !closed) {
        const observation = await observe(claim.cwd, missions.baseline(claim.attemptId), closing.signal);
        if (observation.kind === 'complete') guarded(() => missions.setObserved(claim.attemptId, observation.observed));
      }
    } finally {
      active = null;
    }
  }

  async function drain(): Promise<void> {
    for (const attemptId of missions.unobserved()) {
      const path = missions.attemptPath(attemptId);
      if (path && !closed) {
        const observation = await observe(path, missions.baseline(attemptId), closing.signal);
        if (observation.kind === 'complete') guarded(() => missions.setObserved(attemptId, observation.observed));
      }
    }
    do {
      again = false;
      for (let claim = closed ? null : missions.claimNext(); claim; claim = closed ? null : missions.claimNext()) await runClaim(claim);
    } while (again && !closed);
  }

  function kick(): void {
    if (closed) return;
    if (draining) { again = true; return; }
    draining = drain().catch(error => {
      log({ event: 'agents.error', message: error instanceof Error ? error.message : 'unknown' });
    }).finally(() => {
      draining = null;
      if (again) kick();
    });
  }

  return {
    kick,
    sync() {
      if (active && missions.stopRequested(active.claim.attemptId)) active.controller.abort();
      kick();
    },
    async idle() {
      while (draining) await draining;
    },
    async close() {
      closed = true;
      closing.abort();
      active?.controller.abort();
      await draining;
    },
  };
}
