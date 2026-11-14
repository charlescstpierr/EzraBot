import { z } from 'zod';
import { LIMITS } from './constants.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const requestId = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);
const declaration = z.string().trim().min(1).max(LIMITS.memoryChars);
const label = z.string().trim().min(1).max(60);

export const SCOPE_STATES = ['preparing', 'active', 'withdrawal_pending', 'withdrawal_unverified', 'reset_pending'] as const;
export type ScopeState = (typeof SCOPE_STATES)[number];

/** PC only. Every command names the character: its project is never deduced from anything else. */
export const MemoryCommandSchema = z.discriminatedUnion('type', [
  /** The person creates and names the project of this character. `acknowledged`: the limits were shown before. */
  z.strictObject({ type: z.literal('memory.enable'), requestId, botId: id, label, acknowledged: z.literal(true) }),
  /** Chosen local memories become declarations. Each one leaves the local list in the same transaction. */
  z.strictObject({ type: z.literal('memory.import'), requestId, botId: id, memoryIds: z.array(id).min(1).max(LIMITS.memoriesPerBot) }),
  z.strictObject({ type: z.literal('memory.declare'), requestId, botId: id, text: declaration }),
  z.strictObject({ type: z.literal('memory.correct'), requestId, botId: id, declarationId: id, baseRevision: z.number().int().positive(), text: declaration }),
  z.strictObject({
    type: z.literal('memory.exclude'), requestId, botId: id,
    target: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('declaration'), declarationId: id }),
      z.strictObject({ kind: z.literal('message'), messageId: id }),
    ]),
  }),
  z.strictObject({ type: z.literal('memory.forget'), requestId, botId: id, confirmLabel: z.string().max(60) }),
  /** A new, empty workspace after a forget. Nothing older is sent to it. */
  z.strictObject({ type: z.literal('memory.reset'), requestId, botId: id, confirmLabel: z.string().max(60), acknowledged: z.literal(true) }),
  /** The only reconciliation: the person asks to look again at what is uncertain or failed. */
  z.strictObject({ type: z.literal('memory.resume'), requestId, botId: id }),
]);
export type MemoryCommand = z.infer<typeof MemoryCommandSchema>;
export type MemoryCommandOf<T extends MemoryCommand['type']> = Extract<MemoryCommand, { type: T }>;
export const MEMORY_COMMAND_TYPES = MemoryCommandSchema.options.map(option => option.shape.type.value);

export const MemoryResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('scope'), botId: z.string(), state: z.enum(SCOPE_STATES) }),
  z.strictObject({ kind: z.literal('declarations'), botId: z.string(), declarationIds: z.array(z.string()) }),
  z.strictObject({ kind: z.literal('excluded'), botId: z.string(), sourceId: z.string() }),
]);
export type MemoryResult = z.infer<typeof MemoryResultSchema>;

export const MEMORY_REFUSALS = [
  'invalid_command', 'request_conflict', 'not_found', 'invalid_transition', 'stale_base', 'limit_reached', 'busy', 'memory_unavailable',
] as const;
export type MemoryRefusalCode = (typeof MEMORY_REFUSALS)[number];

export type MemoryOutcome =
  | { ok: true; replayed: boolean; result: MemoryResult }
  | { ok: false; code: MemoryRefusalCode; message: string };

/** Where one source stands in the current workspace. `verified`: its remote copy was read again and matches. */
export const SYNC_STATES = ['pending', 'verified', 'uncertain', 'failed'] as const;
export type SyncState = (typeof SYNC_STATES)[number];

const count = z.number().int().nonnegative();

export const ScopeViewSchema = z.strictObject({
  botId: z.string(),
  label: z.string(),
  state: z.enum(SCOPE_STATES),
  /** A safe category for the last thing that stopped: never a provider message, an address or a remote identifier. */
  note: z.string().nullable(),
  consentedAt: z.string(),
  declarations: z.array(z.strictObject({
    declarationId: z.string(), revision: z.number().int().positive(), text: z.string(), sync: z.enum(SYNC_STATES), createdAt: z.string(),
  })),
  /** Requests of the person in this thread since the consent. */
  messages: z.strictObject({ pending: count, verified: count, uncertain: count, failed: count }),
  excludedMessageIds: z.array(z.string()),
  /** Something is uncertain or failed and `memory.resume` can look at it again. */
  resumable: z.boolean(),
});
export type ScopeView = z.infer<typeof ScopeViewSchema>;

export const MemoryViewSchema = z.strictObject({
  status: z.discriminatedUnion('state', [
    /** The server has no Honcho configuration: nothing can be enabled and no call leaves. */
    z.strictObject({ state: z.literal('off') }),
    /** `budget` null: the server declares no `honcho` budget, so admission refuses every call. */
    z.strictObject({ state: z.literal('ready'), budget: z.strictObject({ calls: count, callsPerDay: count }).nullable() }),
  ]),
  scopes: z.array(ScopeViewSchema),
  /** Replies composed with recalled sources: reply message id to the number of sources. */
  recalls: z.record(z.string(), count),
});
export type MemoryView = z.infer<typeof MemoryViewSchema>;

/** The sources one reply was composed with, read again with the rights of now. A withdrawn source shows no text. */
export const ProvenanceSchema = z.strictObject({
  messageId: z.string(),
  recall: z.enum(['none', 'used', 'empty', 'unavailable', 'suspended']),
  omitted: count,
  sources: z.array(z.discriminatedUnion('state', [
    z.strictObject({
      state: z.literal('authorized'), kind: z.enum(['declaration', 'message']), revision: z.number().int().positive(), text: z.string(),
      declarationId: z.string().nullable(), messageId: z.string().nullable(), createdAt: z.string(),
    }),
    z.strictObject({ state: z.literal('withdrawn'), kind: z.enum(['declaration', 'message']) }),
  ])),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;
