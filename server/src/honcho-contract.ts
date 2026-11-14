import { z } from 'zod';

const id = z.string().trim().min(1).max(200);
const ProjectId = id.brand<'HonchoProjectId'>();
const WorkspaceId = id.brand<'HonchoWorkspaceId'>();
const SourceId = id.brand<'HonchoSourceId'>();
const Generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).brand<'HonchoGeneration'>();
const Revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const binding = { projectId: ProjectId, workspaceId: WorkspaceId, generation: Generation };

export const HonchoBindingSchema = z.strictObject(binding);

export const HonchoOriginSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('message'), threadId: id, messageId: id }),
  z.strictObject({ kind: z.literal('declaration'), declarationId: id }),
]);

const sourceIdentity = { projectId: ProjectId, sourceId: SourceId, revision: Revision };
export const HonchoSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('authorized'), ...sourceIdentity, origin: HonchoOriginSchema, text: z.string().min(1) }),
  z.strictObject({ kind: z.literal('corrected'), ...sourceIdentity, replacedBy: SourceId }),
  z.strictObject({ kind: z.literal('excluded'), ...sourceIdentity }),
]);

export const HonchoScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('active'), ...binding }),
  z.strictObject({ kind: z.literal('withdrawal_pending'), ...binding }),
  z.strictObject({ kind: z.literal('withdrawal_unverified'), ...binding, reason: z.string().min(1).max(500) }),
  z.strictObject({ kind: z.literal('reset_pending'), ...binding, nextWorkspaceId: WorkspaceId })
    .refine(scope => scope.workspaceId !== scope.nextWorkspaceId),
]);

export const HonchoRecallRequestSchema = z.strictObject({
  ...binding,
  query: z.string().min(1).max(2000),
  maxItems: z.number().int().min(1).max(10),
  maxChars: z.number().int().min(1).max(4000),
});
const ReferenceSchema = z.strictObject({ sourceId: SourceId, revision: Revision });
export const HonchoRecallResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('references'), ...binding, references: z.array(ReferenceSchema).max(100) }),
  z.strictObject({ kind: z.literal('unavailable'), reason: z.string().min(1).max(500) }),
]);

export const HonchoWriteResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('acknowledged'), receiptId: id }),
  z.strictObject({ kind: z.literal('unsupported'), reason: z.string().min(1).max(500) }),
  z.strictObject({ kind: z.literal('uncertain'), reason: z.string().min(1).max(500) }),
]);

export type HonchoSource = z.infer<typeof HonchoSourceSchema>;
export type HonchoScope = z.infer<typeof HonchoScopeSchema>;
export type HonchoRecallRequest = z.infer<typeof HonchoRecallRequestSchema>;
export type HonchoWriteResult = z.infer<typeof HonchoWriteResultSchema>;

type AuthorizedSource = Extract<HonchoSource, { kind: 'authorized' }>;
export interface HonchoPort {
  recall(request: HonchoRecallRequest): Promise<unknown>;
  ingest(input: { binding: z.infer<typeof HonchoBindingSchema>; source: AuthorizedSource }): Promise<HonchoWriteResult>;
  requestWithdrawal(input: { scope: HonchoScope; sourceIds: AuthorizedSource['sourceId'][] }): Promise<HonchoWriteResult>;
}

const SelectionSchema = z.strictObject({
  scope: HonchoScopeSchema,
  request: HonchoRecallRequestSchema,
  response: HonchoRecallResponseSchema,
  sources: z.array(HonchoSourceSchema),
  excludedSourceIds: z.array(SourceId),
});

export const HonchoRecallResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('selected'), ...binding,
    items: z.array(z.strictObject({
      ...sourceIdentity, origin: HonchoOriginSchema, text: z.string().min(1).max(4000), truncated: z.boolean(),
    })).max(10),
  }).refine(result => result.items.reduce((chars, item) => chars + item.text.length, 0) <= 4000),
  z.strictObject({ kind: z.literal('refused'), reason: z.enum([
    'invalid_input', 'scope_suspended', 'binding_mismatch', 'stale_generation', 'unavailable', 'ambiguous_sources',
  ]) }),
]);
export type HonchoRecallResult = z.infer<typeof HonchoRecallResultSchema>;

export function selectHonchoRecall(input: unknown): HonchoRecallResult {
  const parsed = SelectionSchema.safeParse(input);
  if (!parsed.success) return { kind: 'refused', reason: 'invalid_input' };
  const { scope, request, response, sources, excludedSourceIds } = parsed.data;
  if (scope.kind !== 'active') return { kind: 'refused', reason: 'scope_suspended' };
  if (response.kind === 'unavailable') return { kind: 'refused', reason: 'unavailable' };
  if ([request, response].some(value => value.projectId !== scope.projectId || value.workspaceId !== scope.workspaceId)) {
    return { kind: 'refused', reason: 'binding_mismatch' };
  }
  if (request.generation !== scope.generation || response.generation !== scope.generation) {
    return { kind: 'refused', reason: 'stale_generation' };
  }
  const originals = new Map<HonchoSource['sourceId'], HonchoSource>();
  for (const source of sources) {
    if (originals.has(source.sourceId)) return { kind: 'refused', reason: 'ambiguous_sources' };
    originals.set(source.sourceId, source);
  }
  const excluded = new Set(excludedSourceIds);
  const seen = new Set<HonchoSource['sourceId']>();
  const items: Extract<HonchoRecallResult, { kind: 'selected' }>['items'] = [];
  let remaining = request.maxChars;
  for (const reference of response.references) {
    if (items.length === request.maxItems || remaining === 0) break;
    if (seen.has(reference.sourceId) || excluded.has(reference.sourceId)) continue;
    const source = originals.get(reference.sourceId);
    if (!source || source.kind !== 'authorized' || source.projectId !== scope.projectId || source.revision !== reference.revision) continue;
    let end = Math.min(source.text.length, remaining);
    if (end < source.text.length && /[\uD800-\uDBFF]/.test(source.text.charAt(end - 1))) end--;
    if (end === 0) continue;
    const text = source.text.slice(0, end);
    items.push({ projectId: source.projectId, sourceId: source.sourceId, revision: source.revision, origin: source.origin, text, truncated: end < source.text.length });
    remaining -= text.length;
    seen.add(source.sourceId);
  }
  return { kind: 'selected', projectId: scope.projectId, workspaceId: scope.workspaceId, generation: scope.generation, items };
}
