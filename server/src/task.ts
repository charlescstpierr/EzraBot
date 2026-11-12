import { MAX_CONTINUATIONS, PLAN_STEPS, type AttemptView, type TaskPlan, type TaskStatus, type TaskStep } from './protocol.js';

export type StepAttempt = { step: TaskStep; state: AttemptView['state']; taskRevision: number; continued: boolean };

/** Everything the next step depends on, read from SQLite in one transaction. */
export type TaskFacts = {
  plan: TaskPlan;
  revision: number;
  continuations: number;
  cancelled: boolean;
  /** The author's work was validated by the person. */
  validated: boolean;
  /** Oldest first. */
  attempts: readonly StepAttempt[];
  openProposals: number;
  reviewerAvailable: boolean;
  /** An information or goal change no accepted turn has received yet. */
  unsentIntent: boolean;
};

export type NextStep =
  | { kind: 'claim'; step: TaskStep; continued: boolean }
  | { kind: 'wait'; status: Exclude<TaskStatus, 'queued'> };

const wait = (status: Exclude<TaskStatus, 'queued'>): NextStep => ({ kind: 'wait', status });

export function maxCalls(plan: TaskPlan, continuations: number): number {
  return PLAN_STEPS[plan].length + continuations;
}

export function stepActor(step: TaskStep): 'author' | 'reviewer' {
  return step === 'review' ? 'reviewer' : 'author';
}

/**
 * The only scheduler of a task. A failed or interrupted call is never rerun without a continuation the person granted,
 * a result based on an older goal stops the old plan, and an open proposal waits for the person's decision.
 */
export function nextStep(facts: TaskFacts): NextStep {
  if (facts.cancelled) return wait('cancelled');
  if (facts.attempts.some(attempt => attempt.state === 'running')) return wait('running');
  if (facts.validated) return wait('validated');
  const granted = facts.continuations > facts.attempts.filter(attempt => attempt.continued).length;
  const last = facts.attempts.at(-1);
  if (last && last.state !== 'succeeded') {
    if (last.step === 'review' && !facts.reviewerAvailable) return wait('reviewer_unavailable');
    return granted ? { kind: 'claim', step: last.step, continued: true } : wait('stopped');
  }
  const succeeded = facts.attempts.filter(attempt => attempt.state === 'succeeded');
  const latest = succeeded.at(-1);
  if (latest && latest.taskRevision < facts.revision) return granted ? { kind: 'claim', step: 'revise', continued: true } : wait('goal_changed');
  if (facts.openProposals > 0) return wait('needs_decision');
  const done = new Set(succeeded.map(attempt => attempt.step));
  const planned = PLAN_STEPS[facts.plan].find(step => !done.has(step));
  if (planned === 'review' && !facts.reviewerAvailable) return wait('reviewer_unavailable');
  if (planned) return { kind: 'claim', step: planned, continued: false };
  if (granted) return { kind: 'claim', step: 'revise', continued: true };
  return wait(facts.unsentIntent ? 'info_waiting' : 'finished');
}

export function taskStatus(facts: TaskFacts): TaskStatus {
  const next = nextStep(facts);
  return next.kind === 'claim' ? 'queued' : next.status;
}

const CONTINUABLE: ReadonlySet<TaskStatus> = new Set(['stopped', 'goal_changed', 'info_waiting', 'finished']);

/** One more explicit call, within the durable cap of two. */
export function canContinue(facts: TaskFacts): boolean {
  return facts.continuations < MAX_CONTINUATIONS && CONTINUABLE.has(taskStatus(facts));
}
