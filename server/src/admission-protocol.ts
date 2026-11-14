import { z } from 'zod';
import { CommandSchema } from './protocol.js';

export const ORIGIN_KINDS = ['human', 'routine', 'event', 'voice', 'checkin'] as const;
export type OriginKind = (typeof ORIGIN_KINDS)[number];

const key = z.string().regex(/^[A-Za-z0-9_.:+-]{1,120}$/);

/**
 * What asked for a work without the person typing it. It is context for the turn:
 * it grants no right and approves nothing.
 */
export const AutomaticOriginSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('routine'), routineId: key, occurrence: key }),
  z.strictObject({ kind: z.literal('event'), subscriptionId: key, eventKey: key }),
  z.strictObject({ kind: z.literal('voice'), callId: key, utteranceId: key }),
  z.strictObject({ kind: z.literal('checkin'), windowKey: key }),
]);
export type AutomaticOrigin = z.infer<typeof AutomaticOriginSchema>;
export type Origin = { kind: 'human'; requestId: string } | AutomaticOrigin;

/** The one occurrence an origin names, unique per thread bot and kind. `/` cannot appear in a key. */
export function occurrenceOf(origin: Origin): string {
  switch (origin.kind) {
    case 'human': return origin.requestId;
    case 'routine': return `${origin.routineId}/${origin.occurrence}`;
    case 'event': return `${origin.subscriptionId}/${origin.eventKey}`;
    case 'voice': return `${origin.callId}/${origin.utteranceId}`;
    case 'checkin': return origin.windowKey;
  }
}

const [, messageSend] = CommandSchema.options;
/** A work asked by an automatic origin: the bot and text of a sent message, without a person's command identity. */
export const AdmitSchema = messageSend.pick({ botId: true, text: true }).extend({ origin: AutomaticOriginSchema });
export type AdmitInput = z.infer<typeof AdmitSchema>;

const money = { currency: z.string().regex(/^[A-Z]{3}$/), micros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) };

/** What one call costs, as far as anyone knows. `unavailable` is never read as zero. */
export const CostSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('known'), ...money }),
  z.strictObject({ kind: z.literal('estimated'), ...money, method: z.string().trim().min(1).max(200) }),
  z.strictObject({ kind: z.literal('unavailable'), reason: z.string().trim().min(1).max(200) }),
]);
export type Cost = z.infer<typeof CostSchema>;

const name = z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/).max(60);

/** The ceilings of one budget for one UTC day. A capability with a price also needs `spendPerDay` in its currency. */
export const BudgetSchema = z.strictObject({
  callsPerDay: z.number().int().nonnegative().max(1_000_000),
  spendPerDay: z.strictObject(money).optional(),
});
export const BudgetsSchema = z.record(name, BudgetSchema);
export type Budgets = z.infer<typeof BudgetsSchema>;

/** A capability absent from `capabilities`, or whose budget is absent from `budgets`, admits no call. */
export const PolicySchema = z.strictObject({
  budgets: BudgetsSchema,
  capabilities: z.record(name, z.strictObject({ budget: name, cost: CostSchema })),
});
export type AdmissionPolicy = z.infer<typeof PolicySchema>;

export const TARGET_KINDS = ['chat', 'document', 'mission', 'service'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];
/** A lead's decision inside a coordinated mission asks for a call the person did not type. */
export const SOURCE_KINDS = [...ORIGIN_KINDS, 'lead'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const RESERVATION_STATES = ['reserved', 'started', 'settled', 'unknown', 'released'] as const;
export type ReservationState = (typeof RESERVATION_STATES)[number];
