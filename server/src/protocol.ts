import { z } from 'zod';
import { CONTEXT_SIZES, LIMITS, REPLY_STYLES, type ContextSize, type ReplyStyle } from './constants.js';

export * from './constants.js';

export const WORK_STATES = ['pending', 'running', 'review', 'done', 'failed', 'cancelled'] as const;
export type WorkState = (typeof WORK_STATES)[number];

export const RUN_STAGES = ['starting', 'thinking', 'writing'] as const;
export type RunStage = (typeof RUN_STAGES)[number];

export const LANES = ['chat', 'doc'] as const;
export type Lane = (typeof LANES)[number];

export const TASK_PLANS = ['solo', 'relay'] as const;
export type TaskPlan = (typeof TASK_PLANS)[number];
export const TASK_STEPS = ['draft', 'review', 'synthesis', 'revise'] as const;
export type TaskStep = (typeof TASK_STEPS)[number];
export const PLAN_STEPS: Record<TaskPlan, readonly TaskStep[]> = { solo: ['draft'], relay: ['draft', 'review', 'synthesis'] };
export const MAX_CONTINUATIONS = 2;
export const TASK_INTENTS = ['add_info', 'change_goal', 'cancel'] as const;
export type TaskIntentKind = (typeof TASK_INTENTS)[number];

export const PUBLISH_ACTION = 'publish';
export const CARNET_DESTINATION = 'carnet';
export const STANDARD_SPEED = 'standard';


const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const token = z.string().regex(/^[A-Za-z0-9._-]{1,80}$/);
const requestId = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);
const color = z.string().regex(/^#[0-9a-f]{6}$/);
const text = (max: number) => z.string().trim().min(1).max(max);

const attachment = z.strictObject({
  name: text(LIMITS.attachmentNameChars),
  text: z.string().max(LIMITS.attachmentChars),
});

/** What deleting a bot removes, and what stays elsewhere signed « Bot supprimé ». Shown before confirmation and checked again on the server. */
export const DeletionCountsSchema = z.strictObject({
  messages: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  deliverables: z.number().int().nonnegative(),
  publications: z.number().int().nonnegative(),
  memories: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative(),
  keptReplies: z.number().int().nonnegative(),
  keptDeliverables: z.number().int().nonnegative(),
  keptMentions: z.number().int().nonnegative(),
  tasks: z.number().int().nonnegative(),
});
export type DeletionCounts = z.infer<typeof DeletionCountsSchema>;

export const MentionSpanSchema = z.strictObject({ botId: id, start: z.number().int().nonnegative(), end: z.number().int().positive() });
export type MentionSpan = z.infer<typeof MentionSpanSchema>;

export const CommandSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('message.say'), requestId, botId: id, text: text(LIMITS.messageChars),
    attachments: z.array(attachment).max(LIMITS.attachments),
    mentions: z.array(MentionSpanSchema).max(LIMITS.bots).optional(),
    reviewerBotId: id.optional(),
  }),
  z.strictObject({
    type: z.literal('message.send'),
    mentions: z.array(MentionSpanSchema).max(LIMITS.bots).optional(),
    requestId,
    botId: id,
    text: text(LIMITS.messageChars),
    attachments: z.array(attachment).max(LIMITS.attachments),
    /** A durable document task: written by the thread bot, optionally reviewed once by another selected bot. */
    document: z.strictObject({ reviewerBotId: id.nullable() }).optional(),
    /**
     * A saved document version the person picked in the reader of the PC, to prepare a service action from it.
     * Identities only: the server reads the version again and freezes it with the request.
     */
    source: z.strictObject({ workId: id, versionId: id }).optional(),
  }),
  z.strictObject({
    type: z.literal('task.intent'),
    requestId,
    taskId: id,
    intent: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('add_info'), text: text(LIMITS.messageChars) }),
      z.strictObject({ kind: z.literal('change_goal'), text: text(LIMITS.messageChars) }),
      z.strictObject({ kind: z.literal('cancel') }),
    ]),
  }),
  z.strictObject({ type: z.literal('task.continue'), requestId, taskId: id }),
  z.strictObject({
    type: z.literal('task.edit'),
    requestId,
    taskId: id,
    /** null only while the document has no version yet. */
    baseVersionId: id.nullable(),
    title: text(LIMITS.versionTitleChars),
    body: text(LIMITS.versionBodyChars),
  }),
  z.strictObject({
    type: z.literal('doc.adopt'),
    requestId,
    proposalId: id,
    seenVersionId: id.nullable(),
    seenRevision: z.number().int().positive(),
  }),
  z.strictObject({ type: z.literal('doc.dismiss'), requestId, proposalId: id }),
  z.strictObject({ type: z.literal('work.cancel'), requestId, workId: id }),
  z.strictObject({ type: z.literal('work.retry'), requestId, workId: id }),
  z.strictObject({ type: z.literal('work.accept'), requestId, workId: id }),
  z.strictObject({
    type: z.literal('version.edit'),
    requestId,
    workId: id,
    baseVersionId: id,
    title: text(LIMITS.versionTitleChars),
    body: text(LIMITS.versionBodyChars),
  }),
  z.strictObject({ type: z.literal('version.restore'), requestId, workId: id, versionId: id }),
  z.strictObject({
    type: z.literal('publication.propose'),
    requestId,
    workId: id,
    versionId: id,
    destination: z.literal(CARNET_DESTINATION),
  }),
  z.strictObject({
    type: z.literal('publication.approve'),
    requestId,
    proposalId: id,
    action: z.string().max(40),
    destination: z.string().max(40),
    versionId: id,
    payloadSha256: z.string().max(64),
  }),
  z.strictObject({ type: z.literal('publication.reject'), requestId, proposalId: id }),
  z.strictObject({
    type: z.literal('bot.create'),
    requestId,
    name: text(24),
    title: z.string().trim().max(60),
    shape: id,
    color,
  }),
  z.strictObject({
    type: z.literal('bot.update'),
    requestId,
    botId: id,
    name: text(24).optional(),
    title: z.string().trim().max(60).optional(),
    shape: id.optional(),
    color: color.optional(),
    reset: z.literal(true).optional(),
    instructions: z.string().trim().max(LIMITS.botInstructionsChars).optional(),
    replyStyle: z.enum(REPLY_STYLES).optional(),
    contextSize: z.enum(CONTEXT_SIZES).optional(),
  }),
  z.strictObject({ type: z.literal('bot.select'), requestId, botId: id }),
  z.strictObject({ type: z.literal('bot.delete'), requestId, botId: id, confirmName: z.string().trim().max(60), expected: DeletionCountsSchema }),
  z.strictObject({ type: z.literal('storage.purge'), requestId }),
  z.strictObject({
    type: z.literal('bot.configure'),
    requestId,
    botId: id,
    model: token.nullable(),
    effort: token.nullable(),
    speed: token,
  }),
  z.strictObject({ type: z.literal('memory.create'), requestId, botId: id, text: text(LIMITS.memoryChars) }),
  z.strictObject({
    type: z.literal('memory.update'),
    requestId,
    botId: id,
    memoryId: id,
    text: text(LIMITS.memoryChars),
    /** The memory's `updatedAt` when its editor opened it: any other current value refuses with `stale_base`. Absent, the last write wins. */
    baseUpdatedAt: z.iso.datetime({ precision: 3 }).optional(),
  }),
  z.strictObject({ type: z.literal('memory.delete'), requestId, botId: id, memoryId: id }),
]);

export type Command = z.infer<typeof CommandSchema>;
export type CommandType = Command['type'];
export type CommandOf<T extends CommandType> = Extract<Command, { type: T }>;

export const DeliverableSchema = z.strictObject({
  title: text(LIMITS.versionTitleChars),
  body: text(LIMITS.versionBodyChars),
});

/** Mino's proposal to hand work to an executor. Recorded with the reply; only the person's tap creates a mission. */
export const HandoffSchema = z.strictObject({
  goal: text(6000),
  coordinated: z.boolean(),
  why: text(500),
});
export type Handoff = z.infer<typeof HandoffSchema>;

/** A bot's proposal to connect a service it cannot use. Recorded with the reply; it connects nothing and grants nothing. */
export const ConnectionOfferSchema = z.strictObject({ service: z.string().max(200) });

export const EngineReplySchema = z.strictObject({
  reply: text(20000),
  deliverable: DeliverableSchema.nullable(),
  handoff: HandoffSchema.nullable().optional(),
  connection: ConnectionOfferSchema.nullable().optional(),
});
export type EngineReply = z.infer<typeof EngineReplySchema>;

export type BotChoice = { model: string | null; effort: string | null; speed: string };
export type ResolvedChoice = { model: string; effort: string; speed: string };

const workStateSchema = z.enum(WORK_STATES);

export const CommandResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('message'), messageId: z.string(), workId: z.string(), taskId: z.string().optional() }),
  z.strictObject({ kind: z.literal('task'), taskId: z.string(), revision: z.number(), eventId: z.string().nullable() }),
  z.strictObject({ kind: z.literal('docProposal'), proposalId: z.string(), state: z.enum(['adopted', 'dismissed']), versionId: z.string().nullable() }),
  z.strictObject({ kind: z.literal('work'), workId: z.string(), state: workStateSchema }),
  z.strictObject({ kind: z.literal('version'), versionId: z.string(), n: z.number() }),
  z.strictObject({ kind: z.literal('proposal'), proposalId: z.string(), payloadSha256: z.string() }),
  z.strictObject({
    kind: z.literal('decision'),
    proposalId: z.string(),
    decision: z.enum(['approved', 'rejected']),
    publicationId: z.string().nullable(),
  }),
  z.strictObject({ kind: z.literal('bot'), botId: z.string() }),
  z.strictObject({ kind: z.literal('memory'), memoryId: z.string() }),
  z.strictObject({ kind: z.literal('botDeleted'), botId: z.string(), nextBotId: z.string().nullable(), erased: z.boolean() }),
  z.strictObject({ kind: z.literal('purge'), erased: z.boolean() }),
]);
export type CommandResult = z.infer<typeof CommandResultSchema>;

export type RefusalCode =
  | 'invalid_command'
  | 'request_conflict'
  | 'not_found'
  | 'invalid_transition'
  | 'stale_base'
  | 'cross_work'
  | 'not_current'
  | 'proposal_closed'
  | 'approval_mismatch'
  | 'limit_reached'
  | 'unknown_shape'
  | 'choice_unavailable'
  | 'busy';

export type DispatchOutcome =
  | { ok: true; replayed: boolean; result: CommandResult }
  | { ok: false; code: RefusalCode; message: string };

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const TokenCountsSchema = z.strictObject({
  input: count,
  cachedInput: count,
  cacheWriteInput: count,
  output: count,
  reasoningOutput: count,
  total: count,
});
export type TokenCounts = z.infer<typeof TokenCountsSchema>;

/** Counters exactly as Codex reported them for one turn. `total` is cumulative for the thread, `last` is the latest request. */
export const UsageSnapshotSchema = z.strictObject({
  last: TokenCountsSchema,
  total: TokenCountsSchema,
  modelContextWindow: count.nullable(),
  receivedAt: z.string(),
});
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>;

/** What the context policy put in the text sent for one attempt. Sizes are characters, never tokens. */
const LegacyContextPlanSchema = z.strictObject({
  policyVersion: z.number().int().max(11),
  contextSize: z.enum(CONTEXT_SIZES),
  replyStyle: z.enum(REPLY_STYLES),
  exchanges: z.strictObject({ full: count, brief: count, omitted: count }),
  clippedChars: count,
  deliverable: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('none') }),
    z.strictObject({ kind: z.literal('complete'), chars: count }),
    z.strictObject({ kind: z.literal('excerpt'), chars: count, omittedChars: count }),
  ]),
  memory: z.strictObject({
    count, chars: count, overBudget: z.boolean(),
    /** Absent when the turn had no Honcho recall to make: a character without a project, a document step, a report or a guest. */
    recall: z.strictObject({
      state: z.enum(['used', 'empty', 'unavailable', 'suspended']), items: count, chars: count, truncated: count, omitted: count,
    }).optional(),
  }),
  attachments: z.strictObject({ count, chars: count }),
  instructionsChars: count,
  baseChars: count,
  inputChars: count,
  utf8Bytes: count,
});
export const HistoryCoverageSchema = z.strictObject({
  budgetChars: count, usedChars: count,
  entries: z.array(z.strictObject({
    requestMessageId: z.string().nullable(),
    kind: z.enum(['recent', 'older']),
    components: z.array(z.strictObject({ by: z.string(), sourceChars: count, omittedChars: count })),
  })),
});
export const ContextPlanSchema = z.union([
  LegacyContextPlanSchema,
  LegacyContextPlanSchema.extend({ policyVersion: z.literal(12), history: HistoryCoverageSchema }),
]);
export type ContextPlan = z.infer<typeof ContextPlanSchema>;

export type AttemptView = {
  n: number;
  lane: Lane;
  step: TaskStep | null;
  state: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  stage: RunStage | null;
  requested: BotChoice;
  used: ResolvedChoice | null;
  threadId: string | null;
  turnId: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** null for attempts recorded before context plans existed. */
  plan: ContextPlan | null;
  /** null when Codex reported nothing for this attempt. Never a zero or an estimate. */
  usage: UsageSnapshot | null;
};

export const DiagnosticsSchema = z.strictObject({
  schemaVersion: z.literal(1), spaceId: z.string(), rev: z.number().int().nonnegative(),
  engineState: z.string(), activeWorkIds: z.array(z.string()),
  works: z.array(z.strictObject({
    id: z.string(), requestMessageId: z.string(), actorBotId: z.string(), threadBotId: z.string(), state: workStateSchema,
    createdAt: z.string(), updatedAt: z.string(),
  })),
  attempts: z.array(z.strictObject({
    id: z.string(), workId: z.string(), actorBotId: z.string(), threadBotId: z.string(), n: z.number().int().positive(),
    state: z.enum(['running','succeeded','failed','cancelled','interrupted']),
    stage: z.enum(['starting','thinking','writing']).nullable(),
    threadId: z.string().nullable(), turnId: z.string().nullable(), errorCode: z.string().nullable(),
    requested: z.strictObject({model:z.string().nullable(),effort:z.string().nullable(),speed:z.string()}),
    used: z.strictObject({model:z.string(),effort:z.string(),speed:z.string()}).nullable(),
    plan: ContextPlanSchema.nullable(),
    startedAt: z.string(), finishedAt: z.string().nullable(), usage: UsageSnapshotSchema.nullable(),
  })),
});
export type DiagnosticsSnapshot = z.infer<typeof DiagnosticsSchema>;
export type StoreDiagnostics = Omit<DiagnosticsSnapshot, 'engineState' | 'activeWorkIds'>;

export type VersionView = {
  id: string;
  n: number;
  title: string;
  body: string;
  source: 'result' | 'edit' | 'restore';
  restoredFromN: number | null;
  createdAt: string;
};

export type ProposalView = {
  id: string;
  versionId: string;
  versionN: number;
  action: typeof PUBLISH_ACTION;
  destination: typeof CARNET_DESTINATION;
  payloadSha256: string;
  state: 'open' | 'approved' | 'rejected' | 'stale';
  staleReason: 'edited' | 'restored' | 'replaced' | null;
  title: string;
  body: string;
  createdAt: string;
};

export type PublicationView = {
  threadBotId: string;
  id: string;
  workId: string;
  botId: string;
  versionId: string;
  versionN: number;
  title: string;
  body: string;
  payloadSha256: string;
  createdAt: string;
};

export const WorkNextSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('retry') }),
  z.strictObject({ kind: z.literal('wait'), reason: z.string() }),
  z.strictObject({ kind: z.literal('document'), reason: z.string() }),
  z.strictObject({ kind: z.literal('new_request'), reason: z.string() }),
  z.strictObject({ kind: z.literal('none'), reason: z.string() }),
]);
export type WorkNext = z.infer<typeof WorkNextSchema>;
export const WorkFactSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('reply'), id: z.string(), at: z.string() }),
  z.strictObject({ kind: z.literal('version'), id: z.string(), n: count, at: z.string() }),
  z.strictObject({ kind: z.literal('execution'), id: z.string(), state: z.string(), logId: z.string().nullable(), at: z.string() }),
]);
export type WorkFact = z.infer<typeof WorkFactSchema>;

export type WorkView = {
  next: WorkNext;
  lastFact: WorkFact;
  threadBotId: string;
  id: string;
  taskId: string | null;
  botId: string;
  requestMessageId: string;
  state: WorkState;
  title: string;
  createdAt: string;
  updatedAt: string;
  attempt: AttemptView | null;
  attempts: number;
  versions: VersionView[];
  proposals: ProposalView[];
};

export type MessageView = {
  threadBotId: string;
  mentions: MentionSpan[];
  id: string;
  role: 'user' | 'assistant';
  botId: string;
  text: string;
  workId: string;
  attachments: { name: string; chars: number }[];
  createdAt: string;
  stamp: (ResolvedChoice & { threadId: string; turnId: string }) | null;
  taskStep: TaskStep | null;
  /** Mino's proposal on its own reply, in its own thread. */
  handoff: Handoff | null;
};

/** Derived from durable facts, never stored. */
export const TASK_STATUSES = ['queued', 'running', 'stopped', 'goal_changed', 'needs_decision', 'reviewer_unavailable', 'info_waiting', 'finished', 'validated', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export type TaskEventView = {
  id: string;
  kind: TaskIntentKind;
  text: string;
  revision: number;
  createdAt: string;
  /** `sent`: the App Server accepted a turn whose context contained it. `prepared`: frozen by a call whose turn is not accepted yet. */
  delivery:
    | { state: 'sent'; attemptN: number; step: TaskStep; botId: string; turnId: string }
    | { state: 'prepared'; step: TaskStep; botId: string }
    | { state: 'waiting'; notSent: number }
    | { state: 'superseded'; byRevision: number }
    | { state: 'applied' };
};

export type TaskCallView = {
  workId: string;
  botId: string;
  n: number;
  step: TaskStep;
  state: AttemptView['state'];
  continued: boolean;
  taskRevision: number;
  baseVersionN: number | null;
  turnAccepted: boolean;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

/** One recorded output handed to the next step. The text stays in its message; nothing is copied. */
export type HandoffView = {
  id: string;
  fromBotId: string;
  fromStep: TaskStep;
  toStep: 'review' | 'synthesis';
  messageId: string;
  versionN: number | null;
  createdAt: string;
  /** Accepted turns whose context contained it, with that context's hash ('' once a memory it used was deleted). */
  readBy: { botId: string; step: TaskStep; n: number; state: AttemptView['state']; contextSha256: string }[];
};

export type DocProposalView = {
  id: string;
  workId: string;
  botId: string;
  step: TaskStep;
  baseVersionN: number | null;
  revision: number;
  title: string;
  body: string;
  reason: 'base_moved' | 'goal_changed';
  state: 'open' | 'adopted' | 'dismissed';
  versionN: number | null;
  createdAt: string;
};

/** Text actually received during a call, decoded without repair. Never a version. */
export type ProgressView = {
  botId: string;
  step: TaskStep;
  attemptState: AttemptView['state'];
  chars: number;
  reply: string;
  title: string | null;
  body: string | null;
  complete: boolean;
  readable: boolean;
  writes: number;
  updatedAt: string;
};

export type TaskView = {
  id: string;
  requestMessageId: string;
  threadBotId: string;
  authorBotId: string;
  reviewerBotId: string | null;
  plan: TaskPlan;
  revision: number;
  goal: string;
  continuations: number;
  maxCalls: number;
  status: TaskStatus;
  canContinue: boolean;
  authorWorkId: string;
  reviewWorkId: string | null;
  calls: TaskCallView[];
  events: TaskEventView[];
  handoffs: HandoffView[];
  proposals: DocProposalView[];
  progress: ProgressView | null;
  createdAt: string;
  updatedAt: string;
};

export type BotView = {
  id: string;
  name: string;
  title: string;
  shape: string;
  color: string;
  defaultShape: string;
  defaultColor: string;
  choice: BotChoice;
  instructions: string;
  replyStyle: ReplyStyle;
  contextSize: ContextSize;
  memories: { id: string; text: string; updatedAt: string }[];
  memoryChars: number;
  /**
   * Set once the person gave this character a Honcho project. From then on its local memories are no longer sent,
   * and its memory is managed on the PC only.
   */
  memoryScope: { label: string; state: 'preparing' | 'active' | 'withdrawal_pending' | 'withdrawal_unverified' | 'reset_pending' } | null;
  deletion: DeletionCounts;
};

export type StoreView = {
  rev: number;
  /** Random per database: browser markers from another database on the same origin never apply here. */
  spaceId: string;
  /** '' when no bot is left. */
  activeBotId: string;
  bots: BotView[];
  /** Deleted bots still named by kept guest contributions or mentions. Never selectable. */
  retiredBotIds: string[];
  /** Identifiers erased by bot deletions, so every tab can purge its local copies of exactly these. */
  purged: { botIds: string[]; workIds: string[] };
  /** 'incomplete' while a deletion's managed backups, journal or free pages are not cleaned yet. */
  erasure: 'complete' | 'incomplete';
  messages: MessageView[];
  works: WorkView[];
  tasks: TaskView[];
  carnet: PublicationView[];
};

export type CatalogModel = {
  id: string;
  displayName: string;
  isDefault: boolean;
  efforts: string[];
  defaultEffort: string;
  speeds: { id: string; name: string; description: string }[];
};

export type EngineStatus =
  | { state: 'starting' }
  | { state: 'ready'; account: 'chatgpt'; models: CatalogModel[] }
  | { state: 'unavailable'; message: string };

export type AppView = StoreView & { engine: EngineStatus };
