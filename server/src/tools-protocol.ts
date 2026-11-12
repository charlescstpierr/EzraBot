import { z } from 'zod';
import type { AppView } from './protocol.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const requestId = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);
const providerId = z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** A provider action name. It is also the name of the function the model may call. */
export const TOOL_SLUG = /^[A-Z][A-Z0-9_]{1,62}$/;
const toolSlug = z.string().regex(TOOL_SLUG);

/** Provider helpers that search, batch, proxy, run code or manage connections. The model never gets them. */
export const isMetaTool = (slug: string): boolean => slug.toUpperCase().startsWith('COMPOSIO_');

export const TOOL_LIMITS = {
  grantsPerBot: 20,
  argumentsBytes: 32 * 1024,
  schemaBytes: 64 * 1024,
  summaryBytes: 16 * 1024,
  descriptionChars: 1024,
} as const;

export const ToolCommandSchema = z.discriminatedUnion('type', [
  /** The bot's rights on this service become exactly these actions of this account. */
  z.strictObject({ type: z.literal('tools.grant'), requestId, botId: id, accountId: providerId, toolSlugs: z.array(toolSlug).min(1).max(TOOL_LIMITS.grantsPerBot) }),
  z.strictObject({ type: z.literal('tools.revoke'), requestId, botId: id, grantId: id }),
  z.strictObject({ type: z.literal('tools.approve'), requestId, proposalId: id, fingerprint: sha256 }),
  z.strictObject({ type: z.literal('tools.refuse'), requestId, proposalId: id }),
  z.strictObject({ type: z.literal('tools.report.retry'), requestId, executionId: id }),
]);
export type ToolCommand = z.infer<typeof ToolCommandSchema>;
export type ToolCommandOf<T extends ToolCommand['type']> = Extract<ToolCommand, { type: T }>;

export const STALE_REASONS = ['turn_failed', 'grant_changed', 'account_inactive', 'schema_changed'] as const;
export type StaleReason = (typeof STALE_REASONS)[number];

export const ToolResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('grants'), botId: z.string(), toolkit: z.string(), grantIds: z.array(z.string()) }),
  z.strictObject({ kind: z.literal('revoked'), botId: z.string(), grantId: z.string() }),
  z.strictObject({
    kind: z.literal('decision'),
    proposalId: z.string(),
    /** `stale`: a check failed at approval, the proposal is closed and nothing was sent. */
    decision: z.enum(['approved', 'refused', 'stale']),
    executionId: z.string().nullable(),
    staleReason: z.enum(STALE_REASONS).nullable(),
  }),
  z.strictObject({ kind: z.literal('report'), executionId: z.string() }),
]);
export type ToolResult = z.infer<typeof ToolResultSchema>;

export const TOOL_REFUSALS = [
  'invalid_command', 'request_conflict', 'not_found', 'invalid_transition', 'proposal_closed', 'approval_mismatch',
  'limit_reached', 'busy', 'tool_unavailable', 'provider_unavailable',
] as const;
export type ToolRefusalCode = (typeof TOOL_REFUSALS)[number];

export type ToolOutcome =
  | { ok: true; replayed: boolean; result: ToolResult }
  | { ok: false; code: ToolRefusalCode; message: string };

export const ToolsStatusSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('ready') }),
  /** The server has no provider key: nothing can be connected and no bot gets a tool. */
  z.strictObject({ state: z.literal('missing_key') }),
]);
export type ToolsStatus = z.infer<typeof ToolsStatusSchema>;

export const ACCOUNT_STATUSES = ['INITIALIZING', 'INITIATED', 'ACTIVE', 'FAILED', 'EXPIRED', 'INACTIVE', 'REVOKED'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const AccountViewSchema = z.strictObject({
  id: z.string(), toolkit: z.string(), alias: z.string(), status: z.enum(ACCOUNT_STATUSES), checkedAt: z.string(),
});

export const LinkViewSchema = z.strictObject({
  id: z.string(), toolkit: z.string(), accountId: z.string(), state: z.enum(['pending', 'active', 'failed']), createdAt: z.string(),
});
export type LinkView = z.infer<typeof LinkViewSchema>;

export const GrantViewSchema = z.strictObject({
  id: z.string(), botId: z.string(), toolkit: z.string(), accountId: z.string(), accountAlias: z.string(),
  toolSlug: z.string(), version: z.string(), description: z.string(), grantedAt: z.string(),
});
export type GrantView = z.infer<typeof GrantViewSchema>;

export const EXECUTION_STATES = ['approved', 'dispatching', 'completed', 'failed', 'blocked', 'unknown', 'voided'] as const;
export const REPORT_STATES = ['none', 'queued', 'running', 'done', 'failed', 'suppressed'] as const;

export const ExecutionViewSchema = z.strictObject({
  id: z.string(),
  state: z.enum(EXECUTION_STATES),
  /** A safe category for voided, blocked and unknown outcomes. Never a raw provider message. */
  category: z.string().nullable(),
  logId: z.string().nullable(),
  /** Bounded and redacted provider result. External data, shown as such. */
  summary: z.string().nullable(),
  report: z.enum(REPORT_STATES),
  updatedAt: z.string(),
});
export type ExecutionView = z.infer<typeof ExecutionViewSchema>;

export const ToolProposalViewSchema = z.strictObject({
  id: z.string(),
  botId: z.string(),
  threadBotId: z.string(),
  workId: z.string(),
  /** The bot message of the turn that proposed the action. */
  messageId: z.string(),
  toolkit: z.string(),
  accountId: z.string(),
  accountAlias: z.string(),
  toolSlug: z.string(),
  version: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  fingerprint: z.string(),
  state: z.enum(['open', 'approved', 'refused', 'stale']),
  staleReason: z.enum(STALE_REASONS).nullable(),
  createdAt: z.string(),
  execution: ExecutionViewSchema.nullable(),
});
export type ToolProposalView = z.infer<typeof ToolProposalViewSchema>;

export const ToolsViewSchema = z.strictObject({
  status: ToolsStatusSchema,
  accounts: z.array(AccountViewSchema),
  links: z.array(LinkViewSchema),
  /** Active rights by bot. A bot without an entry has no right. */
  grants: z.record(z.string(), z.array(GrantViewSchema)),
  proposals: z.array(ToolProposalViewSchema),
});
export type ToolsView = z.infer<typeof ToolsViewSchema>;

export type PcView = AppView & { tools: ToolsView };

export const ServiceOptionSchema = z.strictObject({
  id: z.string(),
  toolkit: z.string(),
  name: z.string(),
  connectable: z.boolean(),
  reason: z.string().nullable(),
});
export type ServiceOption = z.infer<typeof ServiceOptionSchema>;

export const AvailableToolSchema = z.strictObject({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.string().nullable(),
  grantable: z.boolean(),
  reason: z.string().nullable(),
});
export type AvailableTool = z.infer<typeof AvailableToolSchema>;

/** `alias` is the name the person gives this account. It is what an approval card later shows. */
export const LinkRequestSchema = z.strictObject({ serviceId: providerId, alias: z.string().trim().min(1).max(40) });
export const AvailableQuerySchema = z.strictObject({ accountId: providerId });

export const ToolsReplySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('catalog'), services: z.array(ServiceOptionSchema) }),
  /** The only place the connection address ever appears. It is not stored and not shown again. */
  z.strictObject({ kind: z.literal('link'), linkId: z.string(), redirectUrl: z.string() }),
  z.strictObject({ kind: z.literal('checked'), link: LinkViewSchema }),
  z.strictObject({ kind: z.literal('available'), tools: z.array(AvailableToolSchema) }),
]);
export type ToolsReply = z.infer<typeof ToolsReplySchema>;
export type ToolsReplyOf<K extends ToolsReply['kind']> = Extract<ToolsReply, { kind: K }>;
