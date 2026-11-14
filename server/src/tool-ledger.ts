import { createHash, randomUUID } from 'node:crypto';
import { Ajv } from 'ajv';
import type { Admission } from './admission.js';
import type { ReceiptContext } from './context.js';
import type { ToolCall, ToolReply } from './engine.js';
import type { WorkState } from './protocol.js';
import { int, oneOf, oneOfOrNull, str, strOrNull, type Row } from './sql-rows.js';
import {
  ACCOUNT_STATUSES,
  EXECUTION_STATES,
  REPORT_STATES,
  STALE_REASONS,
  TOOL_LIMITS,
  TOOL_SLUG,
  ToolResultSchema,
  isMetaTool,
  type AccountStatus,
  type ExecutionView,
  type GrantView,
  type LinkView,
  type StaleReason,
  type ToolCommand,
  type ToolCommandOf,
  type ToolOutcome,
  type ToolProposalView,
  type ToolRefusalCode,
  type ToolResult,
  type ToolsStatus,
  type ToolsView,
} from './tools-protocol.js';

export type AccountFacts = { id: string; toolkit: string; alias: string; status: AccountStatus };

export type RawToolFacts = { slug: string; toolkit: string; name: string; description: string; version: string | null; inputSchema: unknown };

export type LiveFacts = { account: AccountFacts | null; tools: readonly RawToolFacts[] };

export type AccountReading = { kind: 'found'; account: AccountFacts } | { kind: 'absent' } | { kind: 'unreachable' };

export type GrantSnapshot = {
  grantId: string;
  toolkit: string;
  accountId: string;
  toolSlug: string;
  version: string;
  schemaSha256: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type Pin = { proposalId: string; toolkit: string; accountId: string; toolSlug: string; version: string; schemaSha256: string };

/** The single right to send one approved action. Its row is already `dispatching`. */
export type DispatchPermit = { executionId: string; pin: Pin; arguments: Record<string, unknown> };

export type SendResult =
  /** Certain: the provider never received the action. */
  | { kind: 'not_sent'; reason: 'session' | 'tool_absent' | 'version_missing' | 'schema_changed' }
  | { kind: 'completed' | 'failed' | 'blocked'; data: unknown; error: string | null; logId: string }
  | { kind: 'input_required' }
  /** The request left, or may have left, and no trustworthy answer came back. Never resent. */
  | { kind: 'unknown'; category: 'timeout' | 'transport' | 'response' };

export type TurnIdentity = { workId: string; attemptId: string; botId: string; toolGrants: readonly GrantSnapshot[] };

export type ReportClaim = {
  executionId: string;
  workId: string;
  botId: string;
  threadBotId: string;
  requestMessageId: string;
  requestSeq: number;
  requestText: string;
  receipt: ReceiptContext;
};

type SqlValue = string | number | null;

export type LedgerKit = {
  get(text: string, ...params: SqlValue[]): Row | undefined;
  all(text: string, ...params: SqlValue[]): Row[];
  run(text: string, ...params: SqlValue[]): number;
  transaction<T>(body: () => T): T;
  now(): string;
  newId(prefix: string): string;
  changed(): void;
  sign(payload: unknown): string;
};

export type ToolLedger = {
  readonly ownerId: string;
  view(status: ToolsStatus): ToolsView;
  /** Applies one PC command. The same `requestId` with the same content returns the first receipt. */
  apply(command: ToolCommand, live: LiveFacts | null): ToolOutcome;
  recordLink(link: { linkId: string; toolkit: string; accountId: string }): void;
  link(linkId: string): LinkView | null;
  observeAccount(account: AccountFacts): void;
  account(accountId: string): AccountFacts | null;
  grantsFor(botId: string): GrantSnapshot[];
  propose(turn: TurnIdentity, call: ToolCall): ToolReply;
  peek(proposalId: string): Pin | null;
  nextApproved(): { executionId: string; pin: Pin } | null;
  /** Consumes the approval durably before any network call, or voids it when a check fails. */
  claimDispatch(executionId: string, reading: AccountReading): DispatchPermit | null;
  settle(permit: DispatchPermit, result: SendResult): void;

  nextReport(): ReportClaim | null;
  beginReport(executionId: string): void;
  endReport(executionId: string, report: 'done' | 'failed' | 'suppressed'): WorkState;
  cancelReport(workId: string): WorkState | null;
  hasLiveExecution(workId: string): boolean;
  syncDrafts(): void;
  recover(): number;
  blocksPurge(botId: string, erasedWorks: string): boolean;
  markPurge(botId: string, erasedWorks: string): void;
};

export const TOOL_MIGRATION = `
ALTER TABLE attempts ADD COLUMN tool_execution_id TEXT;
CREATE TABLE tool_accounts(
  id TEXT PRIMARY KEY,
  toolkit TEXT NOT NULL,
  alias TEXT NOT NULL,
  status TEXT NOT NULL,
  checked_at TEXT NOT NULL
) STRICT;
CREATE TABLE tool_links(
  id TEXT PRIMARY KEY,
  toolkit TEXT NOT NULL,
  account_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','active','failed')),
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE tool_grants(
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id),
  toolkit TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES tool_accounts(id),
  tool_slug TEXT NOT NULL,
  version TEXT NOT NULL CHECK(length(version) > 0),
  schema_sha256 TEXT NOT NULL,
  input_schema TEXT NOT NULL CHECK(json_valid(input_schema)),
  description TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;
CREATE UNIQUE INDEX tool_grants_active ON tool_grants(bot_id, tool_slug) WHERE revoked_at IS NULL;
CREATE TRIGGER tool_grants_one_account BEFORE INSERT ON tool_grants
  WHEN EXISTS(SELECT 1 FROM tool_grants g WHERE g.bot_id = NEW.bot_id AND g.toolkit = NEW.toolkit AND g.revoked_at IS NULL AND g.account_id IS NOT NEW.account_id)
  BEGIN SELECT RAISE(ABORT, 'one account per bot and service'); END;
CREATE TRIGGER tool_grants_no_meta BEFORE INSERT ON tool_grants WHEN substr(upper(NEW.tool_slug), 1, 9) = 'COMPOSIO_'
  BEGIN SELECT RAISE(ABORT, 'provider meta tools are never granted'); END;
CREATE TRIGGER tool_grants_live_bot BEFORE INSERT ON tool_grants
  WHEN EXISTS(SELECT 1 FROM bots WHERE id = NEW.bot_id AND deleted_at IS NOT NULL)
  BEGIN SELECT RAISE(ABORT, 'bot is deleted'); END;
CREATE TRIGGER tool_grants_frozen BEFORE UPDATE ON tool_grants
  WHEN OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR NEW.id IS NOT OLD.id OR NEW.bot_id IS NOT OLD.bot_id OR NEW.toolkit IS NOT OLD.toolkit
    OR NEW.account_id IS NOT OLD.account_id OR NEW.tool_slug IS NOT OLD.tool_slug OR NEW.version IS NOT OLD.version
    OR NEW.schema_sha256 IS NOT OLD.schema_sha256 OR NEW.input_schema IS NOT OLD.input_schema OR NEW.description IS NOT OLD.description
    OR NEW.granted_at IS NOT OLD.granted_at
  BEGIN SELECT RAISE(ABORT, 'a grant can only be revoked, once'); END;
CREATE TRIGGER tool_grants_kept BEFORE DELETE ON tool_grants
  WHEN NOT EXISTS(SELECT 1 FROM purge_target t WHERE t.tbl = 'tool_grants' AND t.id = OLD.id)
  BEGIN SELECT RAISE(ABORT, 'grants are kept'); END;

CREATE TABLE tool_proposals(
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id),
  work_id TEXT NOT NULL REFERENCES works(id),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id),
  call_id TEXT NOT NULL,
  grant_id TEXT NOT NULL REFERENCES tool_grants(id),
  toolkit TEXT NOT NULL,
  account_id TEXT NOT NULL,
  tool_slug TEXT NOT NULL,
  version TEXT NOT NULL,
  schema_sha256 TEXT NOT NULL,
  arguments TEXT NOT NULL CHECK(json_valid(arguments)),
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('drafted','open','approved','refused','stale')),
  stale_reason TEXT CHECK(stale_reason IS NULL OR stale_reason IN ('turn_failed','grant_changed','account_inactive','schema_changed')),
  created_at TEXT NOT NULL,
  closed_at TEXT,
  CHECK((state = 'stale') = (stale_reason IS NOT NULL))
) STRICT;
CREATE INDEX tool_proposals_by_work ON tool_proposals(work_id);
CREATE TRIGGER tool_proposals_source BEFORE INSERT ON tool_proposals
  WHEN NEW.state IS NOT 'drafted' OR NOT EXISTS(SELECT 1 FROM attempts a JOIN works w ON w.id = a.work_id
    WHERE a.id = NEW.attempt_id AND a.state = 'running' AND a.lane = 'chat' AND a.tool_execution_id IS NULL AND w.id = NEW.work_id AND w.bot_id = NEW.bot_id)
    OR NOT EXISTS(SELECT 1 FROM tool_grants g WHERE g.id = NEW.grant_id AND g.revoked_at IS NULL AND g.bot_id = NEW.bot_id AND g.toolkit = NEW.toolkit
      AND g.account_id = NEW.account_id AND g.tool_slug = NEW.tool_slug AND g.version = NEW.version AND g.schema_sha256 = NEW.schema_sha256)
  BEGIN SELECT RAISE(ABORT, 'a proposal comes from a running chat turn and an active grant'); END;
CREATE TRIGGER tool_proposals_frozen BEFORE UPDATE ON tool_proposals
  WHEN OLD.state IN ('approved','refused','stale')
    OR (OLD.state = 'drafted' AND NEW.state NOT IN ('open','stale'))
    OR (OLD.state = 'open' AND NEW.state NOT IN ('approved','refused','stale'))
    OR NEW.id IS NOT OLD.id OR NEW.bot_id IS NOT OLD.bot_id OR NEW.work_id IS NOT OLD.work_id OR NEW.attempt_id IS NOT OLD.attempt_id
    OR NEW.call_id IS NOT OLD.call_id OR NEW.grant_id IS NOT OLD.grant_id OR NEW.toolkit IS NOT OLD.toolkit OR NEW.account_id IS NOT OLD.account_id
    OR NEW.tool_slug IS NOT OLD.tool_slug OR NEW.version IS NOT OLD.version OR NEW.schema_sha256 IS NOT OLD.schema_sha256
    OR NEW.arguments IS NOT OLD.arguments OR NEW.fingerprint IS NOT OLD.fingerprint OR NEW.created_at IS NOT OLD.created_at
  BEGIN SELECT RAISE(ABORT, 'a proposal is immutable and closes once'); END;
CREATE TRIGGER tool_proposals_kept BEFORE DELETE ON tool_proposals
  WHEN NOT EXISTS(SELECT 1 FROM purge_target t WHERE t.tbl = 'tool_proposals' AND t.id = OLD.id)
  BEGIN SELECT RAISE(ABORT, 'proposals are kept'); END;

CREATE TABLE tool_executions(
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL UNIQUE REFERENCES tool_proposals(id),
  state TEXT NOT NULL CHECK(state IN ('approved','dispatching','completed','failed','blocked','unknown','voided')),
  category TEXT,
  log_id TEXT,
  summary TEXT,
  report TEXT NOT NULL DEFAULT 'none' CHECK(report IN ('none','queued','running','done','failed','suppressed')),
  report_from TEXT CHECK(report_from IS NULL OR report_from IN ('review','done')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(report = 'none' OR state IN ('completed','failed','blocked','unknown'))
) STRICT;
CREATE TRIGGER tool_executions_approved BEFORE INSERT ON tool_executions
  WHEN NEW.state IS NOT 'approved' OR NEW.report IS NOT 'none'
    OR NOT EXISTS(SELECT 1 FROM tool_proposals p WHERE p.id = NEW.proposal_id AND p.state = 'approved')
  BEGIN SELECT RAISE(ABORT, 'an execution starts from an approved proposal'); END;
CREATE TRIGGER tool_executions_forward BEFORE UPDATE ON tool_executions
  WHEN NEW.id IS NOT OLD.id OR NEW.proposal_id IS NOT OLD.proposal_id OR NEW.created_at IS NOT OLD.created_at
    OR (NEW.state IS NOT OLD.state AND NOT (
      (OLD.state = 'approved' AND NEW.state IN ('dispatching','voided'))
      OR (OLD.state = 'dispatching' AND NEW.state IN ('completed','failed','blocked','unknown','voided'))))
  BEGIN SELECT RAISE(ABORT, 'an execution only moves forward and is sent at most once'); END;
CREATE TRIGGER tool_executions_kept BEFORE DELETE ON tool_executions
  WHEN NOT EXISTS(SELECT 1 FROM purge_target t WHERE t.tbl = 'tool_executions' AND t.id = OLD.id)
  BEGIN SELECT RAISE(ABORT, 'executions are kept'); END;

CREATE TRIGGER attempts_report_source BEFORE INSERT ON attempts
  WHEN NEW.tool_execution_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM tool_executions e JOIN tool_proposals p ON p.id = e.proposal_id
    WHERE e.id = NEW.tool_execution_id AND e.report = 'queued' AND p.work_id = NEW.work_id)
  BEGIN SELECT RAISE(ABORT, 'a report turn belongs to a queued receipt of its work'); END;
`;

export const TOOL_PURGE_ORDER = [
  ['tool_executions', 'id'],
  ['tool_proposals', 'id'],
  ['tool_grants', 'id'],
] as const;

class ToolRefusal extends Error {
  constructor(readonly code: ToolRefusalCode, message: string) {
    super(message);
  }
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v)).join(',') + '}';
  }
  return JSON.stringify(value);
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export const schemaSha256 = (schema: unknown): string => sha256(canonicalJson(schema));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

type Validator = (value: unknown) => string | null;

/**
 * Real JSON Schema validation that never changes the value: no coercion, no defaults, no removal.
 * A schema that needs anything outside itself does not compile, so nothing is ever fetched.
 */
function compileValidator(schema: Record<string, unknown>): Validator | null {
  try {
    const validate = new Ajv({ strict: false, validateFormats: false, coerceTypes: false, useDefaults: false, removeAdditional: false }).compile(schema);
    return value => {
      if (validate(value) === true) return null;
      const first = validate.errors?.[0];
      return `${first?.instancePath || '/'} : ${first?.message ?? 'valeur refusée'}`.slice(0, 300);
    };
  } catch {
    return null;
  }
}

type ToolAssessment =
  | { ok: true; version: string; schemaSha256: string; inputSchema: Record<string, unknown>; description: string }
  | { ok: false; reason: string };

export function assessTool(tool: RawToolFacts, toolkit: string): ToolAssessment {
  if (isMetaTool(tool.slug)) return { ok: false, reason: 'Outil interne du fournisseur : il n’est jamais donné à un personnage.' };
  if (!TOOL_SLUG.test(tool.slug)) return { ok: false, reason: 'Le nom de cet outil n’est pas pris en charge.' };
  if (tool.toolkit !== toolkit) return { ok: false, reason: 'Cet outil appartient à un autre service.' };
  if (!tool.version) return { ok: false, reason: 'Le fournisseur n’annonce pas de version pour cet outil : une confirmation exacte est impossible.' };
  const schema = tool.inputSchema;
  if (!isRecord(schema) || schema.type !== 'object' || Buffer.byteLength(canonicalJson(schema), 'utf8') > TOOL_LIMITS.schemaBytes || !compileValidator(schema)) {
    return { ok: false, reason: 'Le schéma des arguments de cet outil est illisible, incomplet ou trop grand.' };
  }
  return {
    ok: true, version: tool.version, schemaSha256: schemaSha256(schema), inputSchema: schema,
    description: Array.from(tool.description).slice(0, TOOL_LIMITS.descriptionChars).join(''),
  };
}

const SENSITIVE_KEY = /token|secret|password|passwd|authorization|api[_-]?key|cookie|credential|session|signature|private[_-]?key/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[…]';
  if (Array.isArray(value)) return value.map(item => redact(item, depth + 1));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? '[retiré]' : redact(item, depth + 1)]));
}

export function summarize(data: unknown, error: string | null): string {
  const text = canonicalJson(redact({ data, error }));
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= TOOL_LIMITS.summaryBytes) return text;
  const kept = bytes.subarray(0, TOOL_LIMITS.summaryBytes).toString('utf8').replace(/�+$/, '');
  return `${kept}\n[… résultat tronqué : ${bytes.length - TOOL_LIMITS.summaryBytes} octets omis …]`;
}

const LINK_STATE: Record<AccountStatus, 'pending' | 'active' | 'failed'> = {
  INITIALIZING: 'pending', INITIATED: 'pending', ACTIVE: 'active', FAILED: 'failed', EXPIRED: 'failed', INACTIVE: 'failed', REVOKED: 'failed',
};

const REPORTABLE = ['completed', 'failed', 'blocked', 'unknown'] as const;
const WORK_STATES_AFTER_TURN = ['review', 'done'] as const;

const CAPABILITY = 'composio.action';

export function createToolLedger(kit: LedgerKit, receipts: {
  find(requestId: string): { type: string; fingerprint: string; result: string } | null;
  save(requestId: string, type: string, fingerprint: string, result: string): void;
}, admission: Admission): ToolLedger {
  const { get, all, run, now, newId } = kit;

  kit.transaction(() => {
    if (!get('SELECT value FROM meta WHERE key = ?', 'composio_owner')) run('INSERT INTO meta(key, value) VALUES (?, ?)', 'composio_owner', randomUUID());
  });
  const ownerId = str(get('SELECT value FROM meta WHERE key = ?', 'composio_owner') ?? {}, 'value');

  const fingerprintOf = (pin: Omit<Pin, 'proposalId'>, args: unknown) => sha256(canonicalJson({
    v: 1, owner: ownerId, accountId: pin.accountId, toolkit: pin.toolkit, version: pin.version, slug: pin.toolSlug, schemaSha256: pin.schemaSha256, arguments: args,
  }));

  const liveBot = (botId: string) => get('SELECT 1 AS x FROM bots WHERE id = ? AND deleted_at IS NULL', botId) !== undefined;
  const pinOf = (proposal: Row): Pin => ({
    proposalId: str(proposal, 'id'), toolkit: str(proposal, 'toolkit'), accountId: str(proposal, 'account_id'),
    toolSlug: str(proposal, 'tool_slug'), version: str(proposal, 'version'), schemaSha256: str(proposal, 'schema_sha256'),
  });
  const parseArguments = (proposal: Row): Record<string, unknown> => {
    const value: unknown = JSON.parse(str(proposal, 'arguments'));
    if (!isRecord(value)) throw new Error('Arguments enregistrés invalides');
    return value;
  };
  const accountOf = (row: Row): AccountFacts => ({ id: str(row, 'id'), toolkit: str(row, 'toolkit'), alias: str(row, 'alias'), status: oneOf(row, 'status', ACCOUNT_STATUSES) });

  const closeProposals = (where: string, reason: StaleReason, ...params: SqlValue[]) =>
    run(`UPDATE tool_proposals SET state = 'stale', stale_reason = ?, closed_at = ? WHERE ${where}`, reason, now(), ...params);
  const voidApproved = (where: string, category: string, ...params: SqlValue[]) =>
    run(`UPDATE tool_executions SET state = 'voided', category = ?, updated_at = ? WHERE state = 'approved' AND ${where}`, category, now(), ...params);

  function observe(account: AccountFacts): void {
    run(`INSERT INTO tool_accounts(id, toolkit, alias, status, checked_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET alias = excluded.alias, status = excluded.status, checked_at = excluded.checked_at`,
    account.id, account.toolkit, account.alias, account.status, now());
    run(`UPDATE tool_links SET state = ? WHERE account_id = ? AND state IS NOT ?`, LINK_STATE[account.status], account.id, LINK_STATE[account.status]);
    if (account.status === 'ACTIVE') return;
    closeProposals(`state IN ('drafted','open') AND account_id = ?`, 'account_inactive', account.id);
    voidApproved('proposal_id IN (SELECT id FROM tool_proposals WHERE account_id = ?)', 'account_inactive', account.id);
  }

  function revokeGrant(grantId: string): void {
    run('UPDATE tool_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', now(), grantId);
    closeProposals(`state IN ('drafted','open') AND grant_id = ?`, 'grant_changed', grantId);
    voidApproved('proposal_id IN (SELECT id FROM tool_proposals WHERE grant_id = ?)', 'grant_changed', grantId);
  }

  const grantMatches = (proposal: Row): boolean => get(
    `SELECT 1 AS x FROM tool_grants WHERE id = ? AND revoked_at IS NULL AND bot_id = ? AND account_id = ? AND tool_slug = ? AND version = ? AND schema_sha256 = ?`,
    str(proposal, 'grant_id'), str(proposal, 'bot_id'), str(proposal, 'account_id'), str(proposal, 'tool_slug'), str(proposal, 'version'), str(proposal, 'schema_sha256'),
  ) !== undefined;

  function grant(command: ToolCommandOf<'tools.grant'>, live: LiveFacts | null): ToolResult {
    if (!live) throw new ToolRefusal('provider_unavailable', 'Le fournisseur ne répond pas. Aucun droit n’a été changé.');
    if (!liveBot(command.botId)) throw new ToolRefusal('not_found', 'Ce personnage n’existe pas ou a été supprimé.');
    const account = live.account;
    if (!account || account.id !== command.accountId) throw new ToolRefusal('not_found', 'Ce compte n’existe pas chez le fournisseur pour cet espace.');
    observe(account);
    if (account.status !== 'ACTIVE') throw new ToolRefusal('tool_unavailable', 'Ce compte n’est pas actif. Vérifiez sa connexion avant de donner des droits.');
    const wanted = [...new Set(command.toolSlugs)].map(slug => {
      const tool = live.tools.find(candidate => candidate.slug === slug);
      if (!tool) throw new ToolRefusal('tool_unavailable', `L’outil ${slug} n’est pas proposé pour ce compte. Aucun droit n’a été changé.`);
      const assessment = assessTool(tool, account.toolkit);
      if (!assessment.ok) throw new ToolRefusal('tool_unavailable', `${slug} : ${assessment.reason} Aucun droit n’a été changé.`);
      return { slug, ...assessment };
    });
    const elsewhere = int(get('SELECT COUNT(*) AS n FROM tool_grants WHERE bot_id = ? AND revoked_at IS NULL AND toolkit IS NOT ?', command.botId, account.toolkit) ?? {}, 'n');
    if (elsewhere + wanted.length > TOOL_LIMITS.grantsPerBot) {
      throw new ToolRefusal('limit_reached', `Un personnage peut recevoir au plus ${TOOL_LIMITS.grantsPerBot} outils. Aucun droit n’a été changé.`);
    }
    const kept = new Set<string>();
    for (const current of all('SELECT * FROM tool_grants WHERE bot_id = ? AND toolkit = ? AND revoked_at IS NULL', command.botId, account.toolkit)) {
      const same = wanted.find(tool => tool.slug === str(current, 'tool_slug') && tool.version === str(current, 'version') && tool.schemaSha256 === str(current, 'schema_sha256'));
      if (same && str(current, 'account_id') === account.id) kept.add(same.slug);
      else revokeGrant(str(current, 'id'));
    }
    for (const tool of wanted) {
      if (kept.has(tool.slug)) continue;
      run(`INSERT INTO tool_grants(id, bot_id, toolkit, account_id, tool_slug, version, schema_sha256, input_schema, description, granted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId('tg'), command.botId, account.toolkit, account.id, tool.slug, tool.version, tool.schemaSha256, canonicalJson(tool.inputSchema), tool.description, now());
    }
    const grantIds = all('SELECT id FROM tool_grants WHERE bot_id = ? AND toolkit = ? AND revoked_at IS NULL ORDER BY tool_slug', command.botId, account.toolkit).map(row => str(row, 'id'));
    return { kind: 'grants', botId: command.botId, toolkit: account.toolkit, grantIds };
  }

  function requireProposal(proposalId: string): Row {
    const proposal = get('SELECT * FROM tool_proposals WHERE id = ?', proposalId);
    if (!proposal || str(proposal, 'state') === 'drafted') throw new ToolRefusal('not_found', 'Cette proposition n’existe pas.');
    const state = str(proposal, 'state');
    if (state === 'stale') throw new ToolRefusal('proposal_closed', 'Cette proposition est périmée. Rien n’a été envoyé.');
    if (state !== 'open') throw new ToolRefusal('proposal_closed', 'Cette proposition a déjà été décidée.');
    return proposal;
  }

  function approve(command: ToolCommandOf<'tools.approve'>, live: LiveFacts | null): ToolResult {
    const proposal = requireProposal(command.proposalId);
    const pin = pinOf(proposal);
    if (command.fingerprint !== str(proposal, 'fingerprint')) {
      throw new ToolRefusal('approval_mismatch', 'Cette approbation ne correspond pas exactement à la proposition affichée. Rien n’a été envoyé.');
    }
    if (!live) throw new ToolRefusal('provider_unavailable', 'Le fournisseur ne répond pas : le compte et l’outil n’ont pas pu être revérifiés. Rien n’a été envoyé.');
    if (live.account) observe(live.account);
    const tool = live.tools.find(candidate => candidate.slug === pin.toolSlug);
    const assessment = tool ? assessTool(tool, pin.toolkit) : null;
    const reason: StaleReason | null =
      !grantMatches(proposal) || !liveBot(str(proposal, 'bot_id')) ? 'grant_changed'
        : !live.account || live.account.id !== pin.accountId || live.account.toolkit !== pin.toolkit || live.account.status !== 'ACTIVE' ? 'account_inactive'
          : !assessment?.ok || assessment.version !== pin.version || assessment.schemaSha256 !== pin.schemaSha256
            || fingerprintOf(pin, parseArguments(proposal)) !== str(proposal, 'fingerprint') ? 'schema_changed'
            : null;
    if (reason) {
      closeProposals(`id = ? AND state = 'open'`, reason, command.proposalId);
      const closed = oneOf(get('SELECT stale_reason FROM tool_proposals WHERE id = ?', command.proposalId) ?? {}, 'stale_reason', STALE_REASONS);
      return { kind: 'decision', proposalId: command.proposalId, decision: 'stale', executionId: null, staleReason: closed };
    }
    const work = get('SELECT state FROM works WHERE id = ?', str(proposal, 'work_id'));
    if (!work || !WORK_STATES_AFTER_TURN.some(state => state === str(work, 'state'))) {
      throw new ToolRefusal('invalid_transition', 'Le travail de cette proposition est en cours ou arrêté. Attendez sa fin avant d’approuver.');
    }
    const at = now();
    run(`UPDATE tool_proposals SET state = 'approved', closed_at = ? WHERE id = ?`, at, command.proposalId);
    const executionId = newId('tx');
    run(`INSERT INTO tool_executions(id, proposal_id, state, created_at, updated_at) VALUES (?, ?, 'approved', ?, ?)`, executionId, command.proposalId, at, at);
    return { kind: 'decision', proposalId: command.proposalId, decision: 'approved', executionId, staleReason: null };
  }

  const reportEligible = (proposal: Row): boolean => {
    const work = get('SELECT state FROM works WHERE id = ?', str(proposal, 'work_id'));
    return liveBot(str(proposal, 'bot_id')) && work !== undefined && WORK_STATES_AFTER_TURN.some(state => state === str(work, 'state'));
  };

  function execute(command: ToolCommand, live: LiveFacts | null): ToolResult {
    switch (command.type) {
      case 'tools.grant': return grant(command, live);
      case 'tools.revoke': {
        const row = get('SELECT * FROM tool_grants WHERE id = ? AND bot_id = ?', command.grantId, command.botId);
        if (!row) throw new ToolRefusal('not_found', 'Ce droit n’existe pas pour ce personnage.');
        if (row.revoked_at !== null) throw new ToolRefusal('invalid_transition', 'Ce droit est déjà retiré.');
        revokeGrant(command.grantId);
        return { kind: 'revoked', botId: command.botId, grantId: command.grantId };
      }
      case 'tools.approve': return approve(command, live);
      case 'tools.refuse': {
        requireProposal(command.proposalId);
        run(`UPDATE tool_proposals SET state = 'refused', closed_at = ? WHERE id = ?`, now(), command.proposalId);
        return { kind: 'decision', proposalId: command.proposalId, decision: 'refused', executionId: null, staleReason: null };
      }
      case 'tools.report.retry': {
        const execution = get('SELECT e.*, p.work_id, p.bot_id FROM tool_executions e JOIN tool_proposals p ON p.id = e.proposal_id WHERE e.id = ?', command.executionId);
        if (!execution) throw new ToolRefusal('not_found', 'Ce reçu n’existe pas.');
        if (str(execution, 'report') !== 'failed') throw new ToolRefusal('invalid_transition', 'Ce compte rendu n’est pas en échec. Rien n’a été relancé.');
        if (!reportEligible(execution)) throw new ToolRefusal('invalid_transition', 'Ce travail ne peut pas recevoir de compte rendu maintenant.');
        run(`UPDATE tool_executions SET report = 'queued', updated_at = ? WHERE id = ?`, now(), command.executionId);
        return { kind: 'report', executionId: command.executionId };
      }
      default: {
        const _exhaustive: never = command;
        return _exhaustive;
      }
    }
  }

  function apply(command: ToolCommand, live: LiveFacts | null): ToolOutcome {
    try {
      const outcome = kit.transaction((): Extract<ToolOutcome, { ok: true }> => {
        const { requestId, ...payload } = command;
        const print = kit.sign(payload);
        const prior = receipts.find(requestId);
        if (prior) {
          if (prior.type !== command.type || prior.fingerprint !== print) {
            throw new ToolRefusal('request_conflict', 'Cette identité de commande a déjà servi pour un autre contenu.');
          }
          return { ok: true, replayed: true, result: ToolResultSchema.parse(JSON.parse(prior.result)) };
        }
        const result = execute(command, live);
        receipts.save(requestId, command.type, print, JSON.stringify(result));
        return { ok: true, replayed: false, result };
      });
      if (!outcome.replayed) kit.changed();
      return outcome;
    } catch (error) {
      if (error instanceof ToolRefusal) return { ok: false, code: error.code, message: error.message };
      throw error;
    }
  }

  const recorded = (proposalId: string): ToolReply => ({
    success: true,
    text: `Proposition ${proposalId} enregistrée. Rien n’est exécuté : la personne doit l’approuver sur son PC. Termine ta réponse en décrivant l’action proposée et en disant qu’elle attend son approbation ; n’affirme pas qu’elle est faite.`,
  });

  function propose(turn: TurnIdentity, call: ToolCall): ToolReply {
    const refused = (text: string): ToolReply => ({ success: false, text });
    return kit.transaction((): ToolReply => {
      const snapshot = turn.toolGrants.find(candidate => candidate.toolSlug === call.tool);
      if (!snapshot) return refused('Action refusée : cet outil ne fait pas partie des droits de ce personnage.');
      if (!get(`SELECT 1 AS x FROM attempts WHERE id = ? AND work_id = ? AND state = 'running'`, turn.attemptId, turn.workId)) {
        return refused('Action refusée : ce tour n’est plus en cours.');
      }
      if (!isRecord(call.arguments)) return refused('Action refusée : les arguments doivent être un objet JSON.');
      const canonical = canonicalJson(call.arguments);
      const existing = get('SELECT * FROM tool_proposals WHERE attempt_id = ?', turn.attemptId);
      if (existing) {
        const same = str(existing, 'call_id') === call.callId && str(existing, 'tool_slug') === call.tool && str(existing, 'arguments') === canonical
          && str(existing, 'state') === 'drafted';
        return same ? recorded(str(existing, 'id')) : refused('Action refusée : une seule proposition est possible par tour. La première reste enregistrée telle quelle.');
      }
      if (Buffer.byteLength(canonical, 'utf8') > TOOL_LIMITS.argumentsBytes) return refused('Action refusée : les arguments sont trop volumineux.');
      const invalid = compileValidator(snapshot.inputSchema)?.(call.arguments);
      if (invalid === undefined) return refused('Action refusée : le schéma de cet outil est illisible.');
      if (invalid !== null) return refused(`Action refusée : arguments invalides (${invalid}). Rien n’a été enregistré.`);
      const current = get('SELECT * FROM tool_grants WHERE id = ? AND revoked_at IS NULL', snapshot.grantId);
      const account = get('SELECT status FROM tool_accounts WHERE id = ?', snapshot.accountId);
      if (!current || !account || str(account, 'status') !== 'ACTIVE') return refused('Action refusée : ce droit ou ce compte n’est plus actif.');
      const pin = { toolkit: snapshot.toolkit, accountId: snapshot.accountId, toolSlug: snapshot.toolSlug, version: snapshot.version, schemaSha256: snapshot.schemaSha256 };
      const proposalId = newId('tp');
      run(`INSERT INTO tool_proposals(id, bot_id, work_id, attempt_id, call_id, grant_id, toolkit, account_id, tool_slug, version, schema_sha256, arguments, fingerprint, state, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'drafted', ?)`,
      proposalId, turn.botId, turn.workId, turn.attemptId, call.callId, snapshot.grantId, pin.toolkit, pin.accountId, pin.toolSlug, pin.version, pin.schemaSha256,
      canonical, fingerprintOf(pin, call.arguments), now());
      return recorded(proposalId);
    });
  }

  function claimDispatch(executionId: string, reading: AccountReading): DispatchPermit | null {
    let found = false;
    const permit = kit.transaction((): DispatchPermit | null => {
      const row = get(`SELECT p.*, e.id AS execution_id FROM tool_executions e JOIN tool_proposals p ON p.id = e.proposal_id WHERE e.id = ? AND e.state = 'approved'`, executionId);
      if (!row) return null;
      found = true;
      if (reading.kind === 'found') observe(reading.account);
      const pin = pinOf(row);
      const args = parseArguments(row);
      const work = get('SELECT state FROM works WHERE id = ?', str(row, 'work_id'));
      const category =
        reading.kind === 'unreachable' ? 'provider_unavailable'
          : !grantMatches(row) ? 'grant_changed'
            : !liveBot(str(row, 'bot_id')) ? 'bot_deleted'
              : !work || !WORK_STATES_AFTER_TURN.some(state => state === str(work, 'state')) ? 'work_changed'
                : reading.kind !== 'found' || reading.account.id !== pin.accountId || reading.account.toolkit !== pin.toolkit || reading.account.status !== 'ACTIVE' ? 'account_inactive'
                  : fingerprintOf(pin, args) !== str(row, 'fingerprint') ? 'schema_changed'
                    : null;
      if (category) {
        voidApproved('id = ?', category, executionId);
        return null;
      }
      const target = { kind: 'service', id: executionId, revision: str(row, 'fingerprint') } as const;
      const reserved = admission.reserve({ capability: CAPABILITY, source: { kind: 'human', id: str(row, 'id') }, target });
      if (!reserved.ok || !admission.depart(CAPABILITY, target).ok) {
        voidApproved('id = ?', 'budget', executionId);
        return null;
      }
      run(`UPDATE tool_executions SET state = 'dispatching', updated_at = ? WHERE id = ? AND state = 'approved'`, now(), executionId);
      return { executionId, pin, arguments: args };
    });
    if (found) kit.changed();
    return permit;
  }

  function settle(permit: DispatchPermit, result: SendResult): void {
    kit.transaction(() => {
      const row = get(`SELECT p.work_id, p.bot_id FROM tool_executions e JOIN tool_proposals p ON p.id = e.proposal_id WHERE e.id = ? AND e.state = 'dispatching'`, permit.executionId);
      if (!row) return;
      admission.settle(CAPABILITY, { kind: 'service', id: permit.executionId }, result.kind === 'unknown' ? 'unknown' : 'ended');
      const at = now();
      if (result.kind === 'not_sent') {
        run(`UPDATE tool_executions SET state = 'voided', category = ?, updated_at = ? WHERE id = ?`, result.reason, at, permit.executionId);
        return;
      }
      const report = reportEligible(row) ? 'queued' : 'suppressed';
      if (result.kind === 'unknown') {
        run(`UPDATE tool_executions SET state = 'unknown', category = ?, report = ?, updated_at = ? WHERE id = ?`, result.category, report, at, permit.executionId);
      } else if (result.kind === 'input_required') {
        run(`UPDATE tool_executions SET state = 'blocked', category = 'input_required', report = ?, updated_at = ? WHERE id = ?`, report, at, permit.executionId);
      } else {
        run(`UPDATE tool_executions SET state = ?, log_id = ?, summary = ?, report = ?, updated_at = ? WHERE id = ?`,
          result.kind, result.logId.slice(0, 200), summarize(result.data, result.error), report, at, permit.executionId);
      }
    });
    kit.changed();
  }

  function nextReport(): ReportClaim | null {
    const row = get(`SELECT e.id AS execution_id, e.state AS execution_state, e.category, e.log_id, e.summary,
        p.work_id, p.bot_id, p.toolkit, p.tool_slug, p.version, p.arguments, p.account_id,
        request.id AS request_id, request.bot_id AS thread_bot_id, request.seq, request.text AS request_text, reply.text AS prior_reply, account.alias
      FROM tool_executions e JOIN tool_proposals p ON p.id = e.proposal_id JOIN works w ON w.id = p.work_id
        JOIN bots b ON b.id = p.bot_id AND b.deleted_at IS NULL
        JOIN messages request ON request.id = w.request_message_id JOIN messages reply ON reply.attempt_id = p.attempt_id
        LEFT JOIN tool_accounts account ON account.id = p.account_id
      WHERE e.report = 'queued' AND w.state IN ('review','done') ORDER BY e.rowid LIMIT 1`);
    if (!row) return null;
    return {
      executionId: str(row, 'execution_id'), workId: str(row, 'work_id'), botId: str(row, 'bot_id'), threadBotId: str(row, 'thread_bot_id'),
      requestMessageId: str(row, 'request_id'), requestSeq: int(row, 'seq'), requestText: str(row, 'request_text'),
      receipt: {
        priorReply: str(row, 'prior_reply'), toolkit: str(row, 'toolkit'), accountAlias: strOrNull(row, 'alias') ?? str(row, 'account_id'),
        toolSlug: str(row, 'tool_slug'), version: str(row, 'version'), arguments: str(row, 'arguments'),
        state: oneOf(row, 'execution_state', REPORTABLE), category: strOrNull(row, 'category'), logId: strOrNull(row, 'log_id'), summary: strOrNull(row, 'summary'),
      },
    };
  }

  const workOf = (executionId: string): Row => {
    const row = get('SELECT e.report, e.report_from, p.work_id FROM tool_executions e JOIN tool_proposals p ON p.id = e.proposal_id WHERE e.id = ?', executionId);
    if (!row) throw new Error('Reçu absent');
    return row;
  };

  function beginReport(executionId: string): void {
    const row = workOf(executionId);
    const work = get('SELECT state FROM works WHERE id = ?', str(row, 'work_id')) ?? {};
    const from = oneOf(work, 'state', WORK_STATES_AFTER_TURN);
    if (run(`UPDATE tool_executions SET report = 'running', report_from = ?, updated_at = ? WHERE id = ? AND report = 'queued'`, from, now(), executionId) !== 1
      || run(`UPDATE works SET state = 'running', updated_at = ? WHERE id = ? AND state = ?`, now(), str(row, 'work_id'), from) !== 1) {
      throw new Error('Compte rendu non réclamable');
    }
  }

  function endReport(executionId: string, report: 'done' | 'failed' | 'suppressed'): WorkState {
    const row = workOf(executionId);
    const from = oneOf(row, 'report_from', WORK_STATES_AFTER_TURN);
    if (run(`UPDATE tool_executions SET report = ?, updated_at = ? WHERE id = ? AND report = 'running'`, report, now(), executionId) !== 1
      || run(`UPDATE works SET state = ?, updated_at = ? WHERE id = ? AND state = 'running'`, from, now(), str(row, 'work_id')) !== 1) {
      throw new Error('Compte rendu non terminable');
    }
    return from;
  }

  const runningReport = (workId: string): string | null => {
    const row = get(`SELECT e.id FROM tool_executions e JOIN tool_proposals p ON p.id = e.proposal_id WHERE p.work_id = ? AND e.report = 'running'`, workId);
    return row ? str(row, 'id') : null;
  };

  function view(status: ToolsStatus): ToolsView {
    const grants: Record<string, GrantView[]> = {};
    for (const row of all(`SELECT g.*, a.alias FROM tool_grants g JOIN bots b ON b.id = g.bot_id AND b.deleted_at IS NULL JOIN tool_accounts a ON a.id = g.account_id
      WHERE g.revoked_at IS NULL ORDER BY g.toolkit, g.tool_slug`)) {
      (grants[str(row, 'bot_id')] ??= []).push({
        id: str(row, 'id'), botId: str(row, 'bot_id'), toolkit: str(row, 'toolkit'), accountId: str(row, 'account_id'), accountAlias: str(row, 'alias'),
        toolSlug: str(row, 'tool_slug'), version: str(row, 'version'), description: str(row, 'description'), grantedAt: str(row, 'granted_at'),
      });
    }
    const proposals: ToolProposalView[] = all(`SELECT p.*, reply.id AS message_id, request.bot_id AS thread_bot_id, a.alias,
        e.id AS execution_id, e.state AS execution_state, e.category, e.log_id, e.summary, e.report, e.updated_at AS execution_updated_at
      FROM tool_proposals p JOIN messages reply ON reply.attempt_id = p.attempt_id JOIN works w ON w.id = p.work_id
        JOIN messages request ON request.id = w.request_message_id LEFT JOIN tool_accounts a ON a.id = p.account_id
        LEFT JOIN tool_executions e ON e.proposal_id = p.id
      WHERE p.state IS NOT 'drafted' ORDER BY p.rowid`).map(row => {
      const execution: ExecutionView | null = row.execution_id === null ? null : {
        id: str(row, 'execution_id'), state: oneOf(row, 'execution_state', EXECUTION_STATES), category: strOrNull(row, 'category'),
        logId: strOrNull(row, 'log_id'), summary: strOrNull(row, 'summary'), report: oneOf(row, 'report', REPORT_STATES), updatedAt: str(row, 'execution_updated_at'),
      };
      return {
        id: str(row, 'id'), botId: str(row, 'bot_id'), threadBotId: str(row, 'thread_bot_id'), workId: str(row, 'work_id'), messageId: str(row, 'message_id'),
        toolkit: str(row, 'toolkit'), accountId: str(row, 'account_id'), accountAlias: strOrNull(row, 'alias') ?? str(row, 'account_id'),
        toolSlug: str(row, 'tool_slug'), version: str(row, 'version'), arguments: parseArguments(row), fingerprint: str(row, 'fingerprint'),
        state: oneOf(row, 'state', ['open', 'approved', 'refused', 'stale'] as const), staleReason: oneOfOrNull(row, 'stale_reason', STALE_REASONS),
        createdAt: str(row, 'created_at'), execution,
      };
    });
    return {
      status,
      accounts: all('SELECT * FROM tool_accounts ORDER BY toolkit, alias, id').map(row => ({ ...accountOf(row), checkedAt: str(row, 'checked_at') })),
      links: all(`SELECT * FROM tool_links WHERE state IS NOT 'active' ORDER BY created_at DESC, rowid DESC LIMIT 10`).map(linkOf),
      grants,
      proposals,
    };
  }

  const purgeScope = (erasedWorks: string) => `bot_id = ? OR work_id IN (${erasedWorks})`;
  const linkOf = (row: Row): LinkView => ({
    id: str(row, 'id'), toolkit: str(row, 'toolkit'), accountId: str(row, 'account_id'), state: oneOf(row, 'state', ['pending', 'active', 'failed'] as const), createdAt: str(row, 'created_at'),
  });

  return {
    ownerId,
    view,
    apply,
    recordLink(link) {
      run(`INSERT INTO tool_links(id, toolkit, account_id, state, created_at) VALUES (?, ?, ?, 'pending', ?)`, link.linkId, link.toolkit, link.accountId, now());
      kit.changed();
    },
    link(linkId) {
      const row = get('SELECT * FROM tool_links WHERE id = ?', linkId);
      return row ? linkOf(row) : null;
    },
    observeAccount(account) {
      kit.transaction(() => observe(account));
      kit.changed();
    },
    account(accountId) {
      const row = get('SELECT * FROM tool_accounts WHERE id = ?', accountId);
      return row ? accountOf(row) : null;
    },
    grantsFor(botId) {
      return all(`SELECT g.* FROM tool_grants g JOIN tool_accounts a ON a.id = g.account_id AND a.status = 'ACTIVE'
        WHERE g.bot_id = ? AND g.revoked_at IS NULL ORDER BY g.tool_slug`, botId).map(row => {
        const inputSchema: unknown = JSON.parse(str(row, 'input_schema'));
        if (!isRecord(inputSchema)) throw new Error('Schéma enregistré invalide');
        return {
          grantId: str(row, 'id'), toolkit: str(row, 'toolkit'), accountId: str(row, 'account_id'), toolSlug: str(row, 'tool_slug'),
          version: str(row, 'version'), schemaSha256: str(row, 'schema_sha256'), description: str(row, 'description'), inputSchema,
        };
      });
    },
    propose,
    peek(proposalId) {
      const row = get(`SELECT * FROM tool_proposals WHERE id = ? AND state IS NOT 'drafted'`, proposalId);
      return row ? pinOf(row) : null;
    },
    nextApproved() {
      const row = get(`SELECT p.*, e.id AS execution_id FROM tool_executions e JOIN tool_proposals p ON p.id = e.proposal_id WHERE e.state = 'approved' ORDER BY e.rowid LIMIT 1`);
      return row ? { executionId: str(row, 'execution_id'), pin: pinOf(row) } : null;
    },
    claimDispatch,
    settle,
    nextReport,
    beginReport,
    endReport,
    cancelReport(workId) {
      const executionId = runningReport(workId);
      return executionId === null ? null : endReport(executionId, 'suppressed');
    },
    hasLiveExecution(workId) {
      return get(`SELECT 1 AS x FROM tool_executions e JOIN tool_proposals p ON p.id = e.proposal_id WHERE p.work_id = ? AND e.state IS NOT 'voided'`, workId) !== undefined;
    },
    syncDrafts() {
      run(`UPDATE tool_proposals SET state = 'open' WHERE state = 'drafted'
        AND EXISTS(SELECT 1 FROM attempts a JOIN messages m ON m.attempt_id = a.id WHERE a.id = tool_proposals.attempt_id AND a.state = 'succeeded')`);
      closeProposals(`state = 'drafted' AND EXISTS(SELECT 1 FROM attempts a WHERE a.id = tool_proposals.attempt_id AND a.state IS NOT 'running')`, 'turn_failed');
    },
    recover() {
      const at = now();
      for (const row of all(`SELECT e.id, e.report_from, p.work_id FROM tool_executions e JOIN tool_proposals p ON p.id = e.proposal_id WHERE e.report = 'running'`)) {
        run(`UPDATE works SET state = ?, updated_at = ? WHERE id = ? AND state = 'running'`, oneOf(row, 'report_from', WORK_STATES_AFTER_TURN), at, str(row, 'work_id'));
        run(`UPDATE tool_executions SET report = 'failed', updated_at = ? WHERE id = ?`, at, str(row, 'id'));
      }
      let unknown = 0;
      for (const row of all(`SELECT e.id, p.work_id, p.bot_id FROM tool_executions e JOIN tool_proposals p ON p.id = e.proposal_id WHERE e.state = 'dispatching'`)) {
        unknown += run(`UPDATE tool_executions SET state = 'unknown', category = 'interrupted', report = ?, updated_at = ? WHERE id = ?`,
          reportEligible(row) ? 'queued' : 'suppressed', at, str(row, 'id'));
      }
      return unknown;
    },
    blocksPurge(botId, erasedWorks) {
      return get(`SELECT 1 AS x FROM tool_executions e JOIN tool_proposals p ON p.id = e.proposal_id
        WHERE e.state IN ('approved','dispatching') AND (p.bot_id = ? OR p.work_id IN (${erasedWorks}))`, botId) !== undefined;
    },
    markPurge(botId, erasedWorks) {
      run(`INSERT OR IGNORE INTO purge_target(tbl, id) SELECT 'tool_proposals', id FROM tool_proposals WHERE ${purgeScope(erasedWorks)}`, botId);
      run(`INSERT OR IGNORE INTO purge_target(tbl, id) SELECT 'tool_executions', id FROM tool_executions
        WHERE proposal_id IN (SELECT id FROM purge_target WHERE tbl = 'tool_proposals')`);
      run(`INSERT OR IGNORE INTO purge_target(tbl, id) SELECT 'tool_grants', id FROM tool_grants WHERE bot_id = ?`, botId);
      run(`UPDATE attempts SET tool_execution_id = NULL WHERE tool_execution_id IN (SELECT id FROM purge_target WHERE tbl = 'tool_executions')`);
      run(`UPDATE commands SET fingerprint = '' WHERE type LIKE 'tools.%' AND (
        json_extract(result, '$.botId') = ?
        OR json_extract(result, '$.proposalId') IN (SELECT id FROM purge_target WHERE tbl = 'tool_proposals')
        OR json_extract(result, '$.executionId') IN (SELECT id FROM purge_target WHERE tbl = 'tool_executions'))`, botId);
    },
  };
}
