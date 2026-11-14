import { z } from 'zod';
import { WorkNextSchema, WorkFactSchema, CommandResultSchema, CommandSchema, DeletionCountsSchema, CHECKIN_DELIVERIES, CHECKIN_OUTCOMES, CHECKIN_STATES, EVENT_REFUSALS, MentionSpanSchema, ROUTINE_STATES, SUBSCRIPTION_STATES, TASK_STATUSES, WORK_STATES } from './protocol.js';

const id = z.string();
const choice = z.object({ model: id.nullable(), effort: id.nullable(), speed: id });
const version = z.object({ id, n: z.number().int(), title: id, body: id, source: z.enum(['result', 'edit', 'restore']), restoredFromN: z.number().nullable(), createdAt: id });
const proposal = z.object({ id, versionId: id, versionN: z.number(), action: z.literal('publish'), destination: z.literal('carnet'), payloadSha256: id, state: z.enum(['open', 'approved', 'rejected', 'stale']), title: id, body: id });
const delivery = z.discriminatedUnion('state', [
  z.object({ state: z.literal('sent'), attemptN: z.number(), step: id, botId: id, turnId: id }),
  z.object({ state: z.literal('prepared'), step: id, botId: id }),
  z.object({ state: z.literal('waiting'), notSent: z.number() }),
  z.object({ state: z.literal('superseded'), byRevision: z.number() }),
  z.object({ state: z.literal('applied') }),
]);

export const MobileSnapshotSchema = z.object({
  schemaVersion: z.literal(1), rev: z.number().int().nonnegative(), spaceId: id,
  erasure: z.enum(['complete', 'incomplete']), purged: z.object({ botIds: z.array(id), workIds: z.array(id) }),
  bots: z.array(z.object({ id, name: id, title: id, shape: id, color: id, instructions: id, replyStyle: id, contextSize: id, choice,
    memories: z.array(z.object({ id, text: id, updatedAt: id })), memoryChars: z.number(), memoryScope: z.object({ label: id, state: id }).nullable().optional(), deletion: DeletionCountsSchema })),
  messages: z.array(z.object({ id, threadBotId: id, botId: id, role: z.enum(['user', 'assistant']), text: id, workId: id, createdAt: id, mentions: z.array(MentionSpanSchema), attachments: z.array(z.object({ name: id, chars: z.number() })),
    handoff: z.object({ goal: id, coordinated: z.boolean(), why: id }).nullable().optional() })),
  works: z.array(z.object({ next: WorkNextSchema, lastFact: WorkFactSchema, id, threadBotId: id, botId: id, taskId: id.nullable(), requestMessageId: id, state: z.enum(WORK_STATES), title: id, createdAt: id, updatedAt: id,
    attempt: z.object({ n: z.number(), state: id, stage: id.nullable(), error: id.nullable(), used: choice.nullable() }).nullable(),
    versions: z.array(version), proposals: z.array(proposal) })),
  tasks: z.array(z.object({ id, threadBotId: id, authorBotId: id, reviewerBotId: id.nullable(), authorWorkId: id, requestMessageId: id,
    revision: z.number(), goal: id, status: z.enum(TASK_STATUSES), canContinue: z.boolean(), maxCalls: z.number(),
    calls: z.array(z.object({ botId: id, n: z.number(), step: id, state: id, turnAccepted: z.boolean(), error: id.nullable() })),
    events: z.array(z.object({ id, kind: id, text: id, revision: z.number(), createdAt: id, delivery })),
    handoffs: z.array(z.object({ id, fromBotId: id, fromStep: id, toStep: id, versionN: z.number().nullable(), readBy: z.array(z.object({ botId: id, step: id, n: z.number(), state: id })) })),
    proposals: z.array(z.object({ id, title: id, body: id, state: id, reason: id, baseVersionN: z.number().nullable(), revision: z.number() })),
    progress: z.object({ botId: id, step: id, reply: id, title: id.nullable(), body: id.nullable(), complete: z.boolean(), readable: z.boolean(), updatedAt: id }).nullable(),
    createdAt: id, updatedAt: id })),
  carnet: z.array(z.object({ id, threadBotId: id, workId: id, botId: id, versionId: id, versionN: z.number(), title: id, body: id, payloadSha256: id, createdAt: id })),
  /** Read, pause and plain resume only: creating, editing, activating, deleting and confirming an uncertain effect stay on the PC. */
  routines: z.array(z.object({ id, botId: id, revision: z.number(), text: id, time: id, weekdays: z.array(z.number()), zone: id, endsOn: id, cap: z.number(), admitted: z.number(),
    state: z.enum(ROUTINE_STATES), endedBecause: id.nullable(), heldOn: z.object({ label: id }).nullable(),
    upcoming: z.array(z.discriminatedUnion('kind', [z.object({ kind: z.literal('due'), date: id, at: id, offsetMinutes: z.number(), repeated: z.boolean() }), z.object({ kind: z.literal('missing'), date: id })])),
    last: z.object({ date: id, outcome: z.enum(['admitted', 'skipped', 'refused']), reason: id.optional(), message: id.optional() }).nullable() })).optional(),
  /** Read and pause only. The instruction, fields and event ids stay on the PC. `account` is the last state the PC observed. */
  events: z.object({
    reception: z.discriminatedUnion('state', [z.object({ state: z.literal('off') }), z.object({ state: z.literal('configured'), transport: id })]),
    subscriptions: z.array(z.object({ id, botId: id, triggerSlug: id, state: z.enum(SUBSCRIPTION_STATES), revision: z.number(), perDay: z.number(),
      account: z.object({ alias: id, status: id }).nullable(), today: z.object({ admitted: z.number(), refused: z.number() }),
      last: z.object({ receivedAt: id, outcome: z.enum(['admitted', 'refused']), reason: z.enum(EVENT_REFUSALS).nullable(), workId: id.nullable() }).nullable() })),
  }).optional(),
  /** Read and pause only. Activation, resumption and the confirmation of a held check-in stay on the PC. */
  checkin: z.object({
    state: z.enum(CHECKIN_STATES), held: z.object({ window: id, departed: z.boolean() }).nullable(), nextAt: id.nullable(), intervalMinutes: z.number(),
    quietUntil: id.nullable(), departures: z.object({ used: z.number(), max: z.number() }),
    last: z.object({ window: id, decidedAt: id, outcome: z.enum(CHECKIN_OUTCOMES), delivery: z.enum(CHECKIN_DELIVERIES).nullable(), withdrawn: z.boolean() }).nullable(),
  }).optional(),
  engine: z.discriminatedUnion('state', [z.object({ state: z.literal('starting') }), z.object({ state: z.literal('unavailable'), message: id }),
    z.object({ state: z.literal('ready'), account: z.literal('chatgpt'), models: z.array(z.object({ id, displayName: id, isDefault: z.boolean(), efforts: z.array(id), defaultEffort: id, speeds: z.array(z.object({ id, name: id, description: id })) })) })]),
});
export type MobileSnapshot = z.infer<typeof MobileSnapshotSchema>;
export type MobileBot = MobileSnapshot['bots'][number];
export type MobileWork = MobileSnapshot['works'][number];
export type MobileTask = MobileSnapshot['tasks'][number];
export type MobileRoutine = NonNullable<MobileSnapshot['routines']>[number];
/** The routine buttons a phone may show: exactly the commands `/m/commands` accepts for this state. */
export function phoneRoutineActions(routine: Pick<MobileRoutine, 'state'>): ('pause' | 'resume')[] {
  return routine.state === 'active' || routine.state === 'held' ? ['pause'] : routine.state === 'paused' ? ['resume'] : [];
}

export type MobileSubscription = NonNullable<MobileSnapshot['events']>['subscriptions'][number];
/** The subscription buttons a phone may show: exactly the commands `/m/commands` accepts for this state. */
export function phoneSubscriptionActions(subscription: Pick<MobileSubscription, 'state'>): 'pause'[] {
  return subscription.state === 'active' ? ['pause'] : [];
}

export type MobileCheckin = NonNullable<MobileSnapshot['checkin']>;
/** The check-in buttons a phone may show: exactly the commands `/m/commands` accepts for this state. */
export function phoneCheckinActions(checkin: Pick<MobileCheckin, 'state'>): 'pause'[] {
  return checkin.state === 'active' ? ['pause'] : [];
}

export const MobileReplySchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), replayed: z.boolean(), result: CommandResultSchema, view: MobileSnapshotSchema }),
  z.object({ ok: z.literal(false), code: id.optional(), message: id, view: MobileSnapshotSchema.optional() }),
]);
export const PairGrantSchema = z.strictObject({ version: z.literal(1), url: z.url(), spaceId: id, pairingId: z.string().uuid(), secret: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: id });
export type PairGrant = z.infer<typeof PairGrantSchema>;
export const PairClaimSchema = z.strictObject({ pairingId: z.string().uuid(), secret: z.string().regex(/^[a-f0-9]{64}$/), deviceId: z.string().uuid(), deviceName: z.string().trim().min(1).max(50), deviceToken: z.string().regex(/^[a-f0-9]{64}$/) });
export const PairStatusSchema = z.object({ state: z.enum(['pending', 'active', 'revoked', 'expired']), deviceId: id, spaceId: id, confirmCode: id });
export type PairStatus = z.infer<typeof PairStatusSchema>;
export const DeviceSessionSchema = z.strictObject({ url: z.url(), spaceId: id, deviceId: z.string().uuid(), token: z.string().regex(/^[a-f0-9]{64}$/) });
export type DeviceSession = z.infer<typeof DeviceSessionSchema>;
export const BrowserSessionSchema = z.strictObject({ kind: z.literal('cookie'), url: z.url(), spaceId: id, deviceId: z.string().uuid() });
export type BrowserSession = z.infer<typeof BrowserSessionSchema>;
export const BrowserSessionStatusSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('unpaired') }),
  z.strictObject({ state: z.enum(['pending', 'active']), session: BrowserSessionSchema, confirmCode: id, expiresAt: id }),
]);
export { CommandSchema };
export type { Command } from './protocol.js';
