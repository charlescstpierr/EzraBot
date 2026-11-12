import { z } from 'zod';

/** Commands and views of the agent missions. Shared by the PC server, the PC page and the phone client (byte-identical copy in mobile/src/generated). */

export const AGENT_LIMITS = {
  goalChars: 6000,
  noteChars: 4000,
  projectNameChars: 60,
  pathChars: 1024,
  checkCommandChars: 300,
  defaultAttempts: 3,
  maxAttempts: 10,
  budgetStep: 2,
  eventOutputChars: 4000,
  eventDiffChars: 3000,
  finalTextChars: 20_000,
  observedChars: 8000,
  checkTimeoutMs: 5 * 60_000,
  eventsPerMission: 400,
  /** One budget for a coordinated tree: the lead's turns, every step, reviews and queued reservations. */
  coordinatedAttempts: 8,
  coordinatedStep: 4,
  coordinatedMax: 20,
  maxChildren: 4,
  acceptedInDossier: 5,
} as const;

/** `lead`: a read-only turn of the coordinated mission's lead, whose final message is a decision. `final`: Mino's check of the integrated folder, without a model call. */
export const ATTEMPT_KINDS = ['start', 'continue', 'resume', 'review', 'lead', 'final'] as const;
export type AttemptKind = (typeof ATTEMPT_KINDS)[number];

/**
 * running → verifying once Codex confirms the turn: Mino then runs the project check and observes the folder,
 * and only then marks the attempt completed. running or verifying → stopping when a stop is asked.
 * `interrupted` means the result is unknown: the process, the check or the server stopped without a confirmed end.
 */
export const ATTEMPT_STATES = ['queued', 'running', 'verifying', 'stopping', 'completed', 'failed', 'stopped', 'interrupted'] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];

/** `waiting`: a coordinated mission whose lead needs the person (a question, a refused decision, a step without a confirmed result, the budget). */
export const MISSION_STATUSES = ['queued', 'running', 'stopping', 'review', 'outdated', 'accepted', 'failed', 'stopped', 'interrupted', 'waiting'] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

/** `direct`: one executor, the default. `coordinated`: a lead decides each step, done by child missions. */
export const MISSION_MODES = ['direct', 'coordinated'] as const;
export type MissionMode = (typeof MISSION_MODES)[number];

export const DECISION_KINDS = ['delegate', 'continue', 'review', 'ask', 'finish'] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const requestId = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);
const text = (max: number) => z.string().trim().min(1).max(max);

export const AgentCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('project.add'), requestId,
    path: text(AGENT_LIMITS.pathChars),
    name: z.string().trim().max(AGENT_LIMITS.projectNameChars).optional(),
    /** Run by Mino through the Codex sandbox after each completed attempt, without a shell. Empty means none. */
    checkCommand: z.string().trim().max(AGENT_LIMITS.checkCommandChars).optional(),
  }),
  z.strictObject({ type: z.literal('project.update'), requestId, projectId: id, checkCommand: z.string().trim().max(AGENT_LIMITS.checkCommandChars) }),
  z.strictObject({ type: z.literal('project.archive'), requestId, projectId: id }),
  z.strictObject({
    type: z.literal('mission.create'), requestId, projectId: id, goal: text(AGENT_LIMITS.goalChars),
    model: text(200).nullable(), effort: text(80).nullable(),
    mode: z.enum(MISSION_MODES).optional(),
    /** A bot of the app, checked by the PC. Without it, the project's remembered lead is used. */
    leadBotId: id.optional(),
    /** Mino's chat proposal this mission comes from; the PC finds the person's exact words itself. */
    origin: z.strictObject({ messageId: id }).optional(),
  }),
  z.strictObject({ type: z.literal('mission.stop'), requestId, missionId: id }),
  z.strictObject({ type: z.literal('mission.resume'), requestId, missionId: id }),
  z.strictObject({ type: z.literal('mission.continue'), requestId, missionId: id, note: z.string().trim().max(AGENT_LIMITS.noteChars) }),
  z.strictObject({ type: z.literal('mission.revise'), requestId, missionId: id, goal: text(AGENT_LIMITS.goalChars), start: z.boolean() }),
  z.strictObject({ type: z.literal('mission.review'), requestId, missionId: id }),
  z.strictObject({ type: z.literal('mission.accept'), requestId, missionId: id, attemptId: id }),
  z.strictObject({ type: z.literal('mission.budget'), requestId, missionId: id }),
]);
export type AgentCommand = z.infer<typeof AgentCommandSchema>;

export type AgentRefusalCode = 'invalid_command' | 'not_found' | 'path_refused' | 'busy' | 'budget' | 'stale' | 'state' | 'unavailable' | 'duplicate';
export type AgentOutcome =
  | { ok: true; id: string; replayed: boolean }
  | { ok: false; code: AgentRefusalCode; message: string };

export type ProjectView = {
  id: string;
  name: string;
  path: string;
  git: boolean;
  checkCommand: string[] | null;
  archived: boolean;
  createdAt: string;
  /** The lead the person last chose for a coordinated mission in this project. */
  leadBotId: string | null;
};

export type AgentEventKind =
  | 'agent_message' | 'command_started' | 'command' | 'file_change' | 'plan'
  | 'approval_declined' | 'blocked_tool' | 'error' | 'stop_requested' | 'note' | 'check' | 'observed';

export type AgentEventView = {
  id: string;
  attemptId: string;
  seq: number;
  at: string;
  kind: AgentEventKind;
  /** Only what Codex or Mino actually reported, shortened with an explicit marker when long. */
  data: Record<string, unknown>;
};

export type Usage = { input: number; cachedInput: number; output: number; reasoningOutput: number; total: number };

export type CheckView = { command: string[]; exitCode: number | null; output: string; at: string; error: string | null };
export type ObservedView = { git: boolean; head: string | null; status: string[]; diffStat: string; at: string; error: string | null; changedDuringAttempt: string[] };

export type AttemptView = {
  id: string;
  n: number;
  kind: AttemptKind;
  goalRev: number;
  state: AttemptState;
  sandbox: 'workspace-write' | 'read-only';
  threadId: string | null;
  turnId: string | null;
  model: string | null;
  effort: string | null;
  note: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  finalText: string | null;
  usage: Usage | null;
  /** The project check this attempt is held to, fixed when the attempt started; null when the project had none. */
  checkCommand: string[] | null;
  check: CheckView | null;
  observed: ObservedView | null;
  /** The exact text Mino sent to Codex for this attempt, written when it started; null before, or for Mino's own check. */
  input: string | null;
  /** The recorded event that woke the lead, for a lead attempt. */
  trigger: string | null;
};

/** `lead`: written by the lead in a decision, whose id is given. */
export type GoalView = { rev: number; text: string; createdAt: string; origin: 'person' | 'lead'; decisionId: string | null };

/** The lead as chosen when the mission was created, kept even if the bot is later renamed or deleted. */
export type LeadIdentity = { botId: string; name: string; shape: string; color: string };

export type DecisionView = {
  id: string;
  /** 1 for the first decision of this mission. */
  n: number;
  attemptId: string;
  attemptN: number;
  goalRev: number;
  /** null when the lead's message could not be read as a decision. */
  kind: DecisionKind | null;
  decision: Record<string, unknown> | null;
  /** The lead's final message, exactly. */
  raw: string;
  outcome: 'applied' | 'refused';
  refusal: string | null;
  childId: string | null;
  createdAt: string;
};

export type EvidenceView = {
  childId: string;
  childTitle: string;
  attemptId: string;
  attemptN: number | null;
  check: CheckView | null;
  checkCommand: string[] | null;
  observed: ObservedView | null;
};

export type MissionSummary = {
  originMessageId: string | null;
  id: string;
  projectId: string;
  title: string;
  status: MissionStatus;
  goalRev: number;
  attemptsUsed: number;
  maxAttempts: number;
  threadId: string | null;
  acceptedAttemptId: string | null;
  createdAt: string;
  updatedAt: string;
  mode: MissionMode;
  /** The coordinated mission this step belongs to. */
  parentId: string | null;
  lead: LeadIdentity | null;
  /** Why a coordinated mission waits for the person, when its status is `waiting`. */
  waiting: string | null;
  /** The shared budget of a coordinated tree, for the mission and its steps; null for a direct mission. `attemptsUsed` stays this mission's own count. */
  tree: { used: number; max: number } | null;
};

export type MissionDetail = MissionSummary & {
  goals: GoalView[];
  attempts: AttemptView[];
  events: AgentEventView[];
  eventsOmitted: number;
  /** Actions the server would admit now, computed by the same rules that check the commands. */
  can: { stop: boolean; resume: boolean; continue: boolean; revise: boolean; review: boolean; accept: string | null; budget: boolean };
  /** Why the latest finished work cannot be accepted although it answers the current goal, or null. */
  acceptBlocked: string | null;
  live: { attemptId: string; activity: string | null; text: string } | null;
  /** The steps of a coordinated mission, oldest first. */
  children: MissionSummary[];
  decisions: DecisionView[];
  /** The person's exact message in the chat this mission comes from. */
  origin: { messageId: string; text: string } | null;
  /** For a step: the coordinated mission and the decision that created it. */
  parent: { id: string; title: string; lead: LeadIdentity | null; decisionN: number | null; current: boolean } | null;
  /** Summed over the tree for a coordinated mission. `unknownAttempts`: started attempts without reported usage. */
  tokens: { total: number; unknownAttempts: number };
  /** The lead's applied `finish`, with the evidence the PC checked and Mino's final check of the folder. */
  synthesis: { decisionId: string; summary: string; limits: string; evidence: EvidenceView[]; final: AttemptView | null } | null;
};

export type AgentEngineStatus = { state: 'idle' | 'starting' | 'ready' | 'unavailable'; message?: string };

export type AgentsView = {
  rev: number;
  projects: ProjectView[];
  missions: MissionSummary[];
  engine: AgentEngineStatus;
  queue: string[];
};
