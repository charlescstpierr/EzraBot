import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Admission } from './admission.js';
import type { AdmissionPolicy } from './admission-protocol.js';
import { LIMITS } from './constants.js';
import type { ContextSource } from './context.js';
import { selectHonchoRecall } from './honcho-contract.js';
import type { HonchoHttpResult, RemoteHonchoMessage } from './honcho-http.js';
import {
  MemoryResultSchema,
  SCOPE_STATES,
  type MemoryCommand,
  type MemoryCommandOf,
  type MemoryOutcome,
  type MemoryRefusalCode,
  type MemoryResult,
  type MemoryView,
  type Provenance,
  type ScopeView,
  type SyncState,
} from './memory-protocol.js';
import { int, oneOf, str, strOrNull, type Row } from './sql-rows.js';
import type { LedgerKit } from './tool-ledger.js';

const sqlList = (values: readonly string[]) => values.map(value => `'${value}'`).join(',');

const REQUEST_KINDS = ['workspace', 'session', 'ingest', 'read', 'search', 'withdraw'] as const;
type RequestKind = (typeof REQUEST_KINDS)[number];
const RECALL_STATES = ['none', 'used', 'empty', 'unavailable', 'suspended'] as const;
const EXPORT_STATES = ['pending', 'ingested', 'verified', 'uncertain', 'failed', 'voided'] as const;
const SOURCE_KINDS = ['message', 'declaration'] as const;
const SESSIONS = ['declarations', 'conversation'] as const;
/** The only peer EzraBot provisions. It is never observed: no derived conclusion is asked for and none is read. */
export const MEMORY_PEER = 'person';
const SEARCH_LIMIT = 20;
const QUERY_CHARS = 2000;
const RECALL_ITEMS = 10;
const RECALL_CHARS = 4000;

const CAPABILITY: Record<RequestKind, string> = {
  workspace: 'honcho.provision', session: 'honcho.provision', ingest: 'honcho.ingest',
  read: 'honcho.read', search: 'honcho.search', withdraw: 'honcho.withdraw',
};
export const MEMORY_BUDGET = 'honcho';

/** Declares the Honcho capabilities. Their budget stays absent until the server names it in `MINO_BUDGETS`, so no call is admitted by default. */
export function withMemoryCapabilities(policy: AdmissionPolicy): AdmissionPolicy {
  const cost = { kind: 'unavailable' as const, reason: 'Honcho n’annonce aucun prix par appel à ce serveur.' };
  return { ...policy, capabilities: { ...policy.capabilities, ...Object.fromEntries([...new Set(Object.values(CAPABILITY))].map(name => [name, { budget: MEMORY_BUDGET, cost }])) } };
}

/**
 * Honcho is the only long memory. SQLite keeps the originals, the consent, the mapping of each original to its remote copy,
 * the exclusions, the generation and one row per HTTP request. No remote text and no derived profile is stored.
 */
export const MEMORY_MIGRATION = `
CREATE TABLE memory_scopes(
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL UNIQUE REFERENCES bots(id),
  label TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
  state TEXT NOT NULL CHECK(state IN (${sqlList(SCOPE_STATES)})),
  workspace_id TEXT NOT NULL,
  next_workspace_id TEXT,
  note TEXT,
  consented_at TEXT NOT NULL,
  CHECK((state = 'reset_pending') = (next_workspace_id IS NOT NULL))
) STRICT;
CREATE TRIGGER memory_scopes_forward BEFORE UPDATE ON memory_scopes
  WHEN NEW.id IS NOT OLD.id OR NEW.bot_id IS NOT OLD.bot_id OR NEW.label IS NOT OLD.label OR NEW.consented_at IS NOT OLD.consented_at
    OR NEW.generation < OLD.generation
    OR (NEW.state IS NOT OLD.state AND NOT (
      (OLD.state = 'preparing' AND NEW.state = 'active')
      OR (OLD.state = 'active' AND NEW.state = 'withdrawal_pending')
      OR (OLD.state = 'withdrawal_pending' AND NEW.state = 'withdrawal_unverified')
      OR (OLD.state = 'withdrawal_unverified' AND NEW.state = 'reset_pending')
      OR (OLD.state = 'reset_pending' AND NEW.state = 'active')))
  BEGIN SELECT RAISE(ABORT, 'a memory scope only moves forward'); END;

CREATE TABLE memory_workspaces(
  id TEXT PRIMARY KEY,
  scope_id TEXT REFERENCES memory_scopes(id),
  state TEXT NOT NULL CHECK(state IN ('pending','confirmed','failed','retired')),
  created_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER memory_workspaces_forward BEFORE UPDATE ON memory_workspaces
  WHEN NEW.id IS NOT OLD.id OR (NEW.state IS NOT OLD.state AND NOT (
    (OLD.state = 'pending' AND NEW.state IN ('confirmed','failed'))
    OR (OLD.state = 'confirmed' AND NEW.state IN ('failed','retired'))))
  BEGIN SELECT RAISE(ABORT, 'a workspace is never reopened'); END;
CREATE TRIGGER memory_workspaces_kept BEFORE DELETE ON memory_workspaces
  BEGIN SELECT RAISE(ABORT, 'a workspace name is never reused'); END;

CREATE TABLE memory_sessions(
  workspace_id TEXT NOT NULL REFERENCES memory_workspaces(id),
  name TEXT NOT NULL CHECK(name IN (${sqlList(SESSIONS)})),
  confirmed INTEGER NOT NULL DEFAULT 0 CHECK(confirmed IN (0, 1)),
  PRIMARY KEY(workspace_id, name)
) STRICT;

CREATE TABLE memory_sources(
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL REFERENCES memory_scopes(id),
  kind TEXT NOT NULL CHECK(kind IN (${sqlList(SOURCE_KINDS)})),
  message_id TEXT UNIQUE REFERENCES messages(id),
  declaration_id TEXT,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  text TEXT,
  state TEXT NOT NULL CHECK(state IN ('authorized','corrected','excluded','forgotten')),
  replaced_by TEXT REFERENCES memory_sources(id),
  created_at TEXT NOT NULL,
  UNIQUE(declaration_id, revision),
  CHECK((kind = 'message') = (message_id IS NOT NULL)),
  CHECK((kind = 'declaration') = (declaration_id IS NOT NULL)),
  CHECK(kind = 'declaration' OR revision = 1),
  CHECK((kind = 'declaration' AND state = 'authorized') = (text IS NOT NULL)),
  CHECK((state = 'corrected') = (replaced_by IS NOT NULL))
) STRICT;
CREATE INDEX memory_sources_by_scope ON memory_sources(scope_id, state);
CREATE TRIGGER memory_sources_insert BEFORE INSERT ON memory_sources WHEN NEW.state IS NOT 'authorized'
  BEGIN SELECT RAISE(ABORT, 'a memory source starts authorized'); END;
CREATE TRIGGER memory_sources_withdrawn_once BEFORE UPDATE ON memory_sources
  WHEN OLD.state <> 'authorized' OR NEW.state = 'authorized' OR NEW.id IS NOT OLD.id OR NEW.scope_id IS NOT OLD.scope_id OR NEW.kind IS NOT OLD.kind
    OR NEW.message_id IS NOT OLD.message_id OR NEW.declaration_id IS NOT OLD.declaration_id OR NEW.revision IS NOT OLD.revision
  BEGIN SELECT RAISE(ABORT, 'a memory source is withdrawn once and never comes back'); END;

CREATE TABLE memory_exports(
  source_id TEXT NOT NULL REFERENCES memory_sources(id),
  workspace_id TEXT NOT NULL,
  session TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN (${sqlList(EXPORT_STATES)})),
  remote_id TEXT,
  request_id TEXT,
  reconcile INTEGER NOT NULL DEFAULT 0 CHECK(reconcile IN (0, 1)),
  PRIMARY KEY(source_id, workspace_id),
  FOREIGN KEY(workspace_id, session) REFERENCES memory_sessions(workspace_id, name),
  CHECK(state NOT IN ('ingested','verified') OR remote_id IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX memory_exports_remote ON memory_exports(workspace_id, session, remote_id) WHERE remote_id IS NOT NULL;
CREATE INDEX memory_exports_by_state ON memory_exports(workspace_id, state);

CREATE TABLE memory_requests(
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL REFERENCES memory_scopes(id),
  workspace_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN (${sqlList(REQUEST_KINDS)})),
  state TEXT NOT NULL CHECK(state IN ('reserved','started','ok','rejected','unavailable','uncertain','voided')),
  source_id TEXT REFERENCES memory_sources(id),
  session TEXT,
  work_id TEXT,
  hits TEXT CHECK(hits IS NULL OR json_valid(hits)),
  category TEXT,
  created_at TEXT NOT NULL,
  closed_at TEXT
) STRICT;
CREATE INDEX memory_requests_live ON memory_requests(scope_id, state);
CREATE TRIGGER memory_requests_insert BEFORE INSERT ON memory_requests WHEN NEW.state IS NOT 'reserved'
  BEGIN SELECT RAISE(ABORT, 'a memory request starts reserved'); END;
CREATE TRIGGER memory_requests_forward BEFORE UPDATE ON memory_requests
  WHEN NEW.id IS NOT OLD.id OR NEW.scope_id IS NOT OLD.scope_id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.generation IS NOT OLD.generation
    OR NEW.kind IS NOT OLD.kind OR NEW.source_id IS NOT OLD.source_id OR NEW.session IS NOT OLD.session OR NEW.work_id IS NOT OLD.work_id
    OR NOT ((OLD.state = 'reserved' AND NEW.state IN ('started','voided'))
      OR (OLD.state = 'started' AND NEW.state IN ('ok','rejected','unavailable','uncertain')))
  BEGIN SELECT RAISE(ABORT, 'a memory request leaves once and only moves forward'); END;

CREATE TABLE attempt_memory(
  attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),
  scope_id TEXT NOT NULL REFERENCES memory_scopes(id),
  generation INTEGER NOT NULL,
  recall TEXT NOT NULL CHECK(recall IN (${sqlList(RECALL_STATES)})),
  category TEXT,
  omitted INTEGER NOT NULL DEFAULT 0 CHECK(omitted >= 0),
  retired INTEGER NOT NULL DEFAULT 0 CHECK(retired IN (0, 1))
) STRICT;
CREATE TRIGGER attempt_memory_frozen BEFORE UPDATE ON attempt_memory
  WHEN NEW.attempt_id IS NOT OLD.attempt_id OR NEW.scope_id IS NOT OLD.scope_id OR NEW.generation IS NOT OLD.generation
    OR NEW.recall IS NOT OLD.recall OR NEW.omitted IS NOT OLD.omitted OR NEW.retired < OLD.retired
  BEGIN SELECT RAISE(ABORT, 'a frozen manifest only gets retired'); END;
CREATE TABLE attempt_sources(
  attempt_id TEXT NOT NULL REFERENCES attempt_memory(attempt_id),
  source_id TEXT NOT NULL REFERENCES memory_sources(id),
  via TEXT NOT NULL CHECK(via IN ('recall','request','history')),
  PRIMARY KEY(attempt_id, source_id)
) STRICT;
CREATE INDEX attempt_sources_by_source ON attempt_sources(source_id);
CREATE TABLE attempt_replies(
  attempt_id TEXT NOT NULL REFERENCES attempt_memory(attempt_id),
  reply_attempt_id TEXT NOT NULL REFERENCES attempts(id),
  PRIMARY KEY(attempt_id, reply_attempt_id)
) STRICT;
CREATE INDEX attempt_replies_by_reply ON attempt_replies(reply_attempt_id);
CREATE TRIGGER attempt_sources_frozen BEFORE UPDATE ON attempt_sources BEGIN SELECT RAISE(ABORT, 'a manifest row is frozen'); END;
CREATE TRIGGER attempt_replies_frozen BEFORE UPDATE ON attempt_replies BEGIN SELECT RAISE(ABORT, 'a manifest row is frozen'); END;
`;

/** Rows erased with a bot. Workspace names stay as tombstones, detached from their scope. */
export const MEMORY_PURGE_ORDER = [
  ['attempt_replies', `attempt_id || ':' || reply_attempt_id`],
  ['attempt_sources', `attempt_id || ':' || source_id`],
  ['attempt_memory', 'attempt_id'],
  ['memory_requests', 'id'],
  ['memory_exports', `source_id || ':' || workspace_id`],
  ['memory_sources', 'id'],
  ['memory_sessions', `workspace_id || ':' || name`],
  ['memory_scopes', 'id'],
] as const;

/** Why a planned search gave nothing: admission refused it, or Honcho did not answer it. */
export type RecallFailure = 'budget' | 'provider';

/** What the worker found before it claims a chat call. `workId` ties a search to the one call it was planned for. */
export type RecallPlan =
  | { kind: 'none' }
  | { kind: 'unavailable'; workId: string; category: RecallFailure }
  | { kind: 'search'; workId: string; requestId: string };
export type RecallOutcome =
  | { kind: 'none' }
  /** Three plans in a row named another call: this one leaves without recall. */
  | { kind: 'forced' }
  | { kind: 'unavailable'; workId: string; category: RecallFailure }
  | { kind: 'found'; workId: string; requestId: string };

/** The single right to send one request. `workspaceId` is the one captured when the request was reserved, never the scope's current one. */
export type SendPermit = { requestId: string; workspaceId: string } & (
  | { kind: 'workspace' }
  | { kind: 'session'; session: string; peerId: string }
  | { kind: 'ingest'; session: string; peerId: string; text: string }
  | { kind: 'read'; session: string; remoteId: string }
  | { kind: 'search'; query: string; limit: number; session: string | null }
  | { kind: 'withdraw'; session: string | null });

export type Settlement =
  | { kind: 'workspace'; result: HonchoHttpResult<{ created: boolean }> }
  | { kind: 'session'; result: HonchoHttpResult<unknown> }
  | { kind: 'ingest'; result: HonchoHttpResult<RemoteHonchoMessage[]> }
  | { kind: 'read'; result: HonchoHttpResult<RemoteHonchoMessage> }
  | { kind: 'search'; result: HonchoHttpResult<RemoteHonchoMessage[]> }
  | { kind: 'withdraw'; result: HonchoHttpResult<unknown> | { kind: 'unsupported' } };

export type Hold = { ok: true } | { ok: false; reason: 'generation_moved' | 'scope_suspended' | 'source_withdrawn' };

/** A chat request about to be composed, as the store read it. */
export type Candidate = { workId: string; botId: string; threadBotId: string; requestMessageId: string; human: boolean };

/** What the composed text of one attempt contains, by local identity. */
export type Manifest = {
  threadBotId: string;
  /** Recalled source rows, already checked. */
  recalled: readonly string[];
  recall: { state: (typeof RECALL_STATES)[number]; category: string | null; omitted: number };
  requestMessageId: string;
  historyMessageIds: readonly string[];
  /** Attempts whose recorded output is part of this text. */
  replyAttemptIds: readonly string[];
};

export type MemoryLedger = {
  view(): MemoryView;
  /** Applies one PC command. The same `requestId` with the same content returns the first receipt. */
  apply(command: MemoryCommand): MemoryOutcome;
  /** The sources of one bot reply, read again now. Null when the message is not a bot reply. */
  provenance(messageId: string): Provenance | null;
  /** The next request to send, reserved against the Honcho budget. Null when nothing can leave now. */
  next(): string | null;
  /** Reads everything again and uses the one-use permit. Null when a guard fails: the request is voided and nothing leaves. */
  begin(requestId: string): SendPermit | null;
  settle(requestId: string, settlement: Settlement): void;
  /** False once a source of this attempt was withdrawn or its scope moved: the attempt must neither leave nor publish. */
  holds(attemptId: string): Hold;
};

/** What only the store calls, inside its own transactions. */
export type MemoryInternals = MemoryLedger & {
  scoped(botId: string): boolean;
  scopeView(botId: string): { label: string; state: ScopeView['state'] } | null;
  declarationCount(botId: string): number;
  /** A request of the person entered a thread: it becomes a source when that thread's project accepts new ones. */
  observe(message: { id: string; threadBotId: string }): void;
  plan(candidate: Candidate): RecallPlan;
  /** The memory part of a chat request, or `replan` when the given recall was planned for another call or an older state. */
  recall(candidate: Candidate, recall: RecallOutcome | undefined): { part: NonNullable<ContextSource['recall']>; recalled: string[]; category: string | null } | 'replan' | null;
  /** False for a request the person excluded or forgot. */
  requestAllowed(messageId: string): boolean;
  /** True when any call of this work was composed with a source withdrawn since. */
  workRetired(workId: string): boolean;
  freeze(attemptId: string, manifest: Manifest): void;
  recover(): number;
  blocksPurge(botId: string): boolean;
  markPurge(botId: string, erasedAttempts: string): void;
};

class MemoryRefusal extends Error {
  constructor(readonly code: MemoryRefusalCode, message: string) {
    super(message);
  }
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = /[\uD800-\uDBFF]/.test(text.charAt(max - 1)) ? max - 1 : max;
  return text.slice(0, end);
}

const HitsSchema = z.array(z.strictObject({ remoteId: z.string(), session: z.string(), peer: z.string() }));

const SUSPENDED = 'La mémoire de ce personnage est suspendue. Aucune déclaration ne peut être ajoutée ou modifiée avant un nouvel espace vide.';

export function createMemoryLedger(kit: LedgerKit, receipts: {
  find(requestId: string): { type: string; fingerprint: string; result: string } | null;
  save(requestId: string, type: string, fingerprint: string, result: string): void;
}, admission: Admission, config: { workspacePrefix: string } | null): MemoryInternals {
  const { get, all, run, now, newId } = kit;

  const scopeOf = (botId: string): Row | undefined => get('SELECT * FROM memory_scopes WHERE bot_id = ?', botId);
  const scopeById = (scopeId: string): Row | undefined => get('SELECT * FROM memory_scopes WHERE id = ?', scopeId);
  const stateOf = (scope: Row) => oneOf(scope, 'state', SCOPE_STATES);
  const targetOf = (requestId: string, generation: number) => ({ kind: 'service', id: requestId, revision: `g${generation}` }) as const;
  const original = (source: Row): string | null => str(source, 'kind') === 'declaration'
    ? strOrNull(source, 'text')
    : strOrNull(get('SELECT text FROM messages WHERE id = ?', str(source, 'message_id')) ?? { text: null }, 'text');
  /** Counts the notes that really changed, so a view is refreshed once when a refusal first appears and not at every later try. */
  let noted = 0;
  const note = (scopeId: string, category: string | null) => {
    noted += run('UPDATE memory_scopes SET note = ? WHERE id = ? AND note IS NOT ?', category, scopeId, category);
  };

  function requireScope(botId: string): Row {
    const scope = scopeOf(botId);
    if (!scope) throw new MemoryRefusal('not_found', 'Ce personnage n’a pas de mémoire Honcho.');
    return scope;
  }
  function requireOpen(botId: string): Row {
    const scope = requireScope(botId);
    if (stateOf(scope) !== 'preparing' && stateOf(scope) !== 'active') throw new MemoryRefusal('invalid_transition', SUSPENDED);
    return scope;
  }

  function newWorkspace(scopeId: string): string {
    if (!config) throw new MemoryRefusal('memory_unavailable', 'Honcho n’est pas configuré sur ce serveur. Aucun appel n’est parti.');
    const workspaceId = `${config.workspacePrefix}-${randomBytes(12).toString('hex')}`;
    run(`INSERT INTO memory_workspaces(id, scope_id, state, created_at) VALUES (?, ?, 'pending', ?)`, workspaceId, scopeId, now());
    for (const name of SESSIONS) run('INSERT INTO memory_sessions(workspace_id, name) VALUES (?, ?)', workspaceId, name);
    return workspaceId;
  }

  /** Closes a request that never left and frees its slot. */
  function voidRequest(request: Row): void {
    const id = str(request, 'id');
    run(`UPDATE memory_requests SET state = 'voided', closed_at = ? WHERE id = ? AND state = 'reserved'`, now(), id);
    admission.settle(CAPABILITY[oneOf(request, 'kind', REQUEST_KINDS)], { kind: 'service', id }, 'ended');
    run('UPDATE memory_exports SET request_id = NULL WHERE request_id = ?', id);
  }

  /** A correction, an exclusion, a forget and a reset all start a new generation: every request still waiting was reserved for the old one. */
  function advance(scope: Row): number {
    const generation = int(scope, 'generation') + 1;
    run('UPDATE memory_scopes SET generation = ? WHERE id = ?', generation, str(scope, 'id'));
    for (const request of all(`SELECT * FROM memory_requests WHERE scope_id = ? AND state = 'reserved'`, str(scope, 'id'))) voidRequest(request);
    return generation;
  }

  /** Withdraws source rows for good, then retires every attempt whose text contained one, directly or through a reply it received. */
  function withdraw(sourceIds: readonly string[], to: 'excluded' | 'forgotten' | { replacedBy: string }): void {
    for (const sourceId of sourceIds) {
      const source = get('SELECT declaration_id FROM memory_sources WHERE id = ?', sourceId) ?? {};
      if (typeof to === 'string') run('UPDATE memory_sources SET state = ?, text = NULL WHERE id = ?', to, sourceId);
      else run(`UPDATE memory_sources SET state = 'corrected', text = NULL, replaced_by = ? WHERE id = ?`, to.replacedBy, sourceId);
      run(`UPDATE memory_exports SET state = 'voided', reconcile = 0 WHERE source_id = ? AND state <> 'voided'`, sourceId);
      const declarationId = strOrNull(source, 'declaration_id');
      if (declarationId !== null) {
        run(`UPDATE commands SET fingerprint = '' WHERE type LIKE 'memory.%'
          AND EXISTS(SELECT 1 FROM json_each(json_extract(result, '$.declarationIds')) WHERE value = ?)`, declarationId);
      }
      const tainted = `WITH RECURSIVE hit(id) AS (
          SELECT attempt_id FROM attempt_sources WHERE source_id = ?1
          UNION SELECT r.attempt_id FROM attempt_replies r JOIN hit ON r.reply_attempt_id = hit.id)
        SELECT id FROM hit`;
      run(`UPDATE attempts SET context_sha256 = '' WHERE id IN (${tainted})`, sourceId);
      run(`UPDATE attempt_memory SET retired = 1 WHERE retired = 0 AND attempt_id IN (${tainted})`, sourceId);
    }
  }

  function addSource(scope: Row, input: { kind: 'message'; messageId: string } | { kind: 'declaration'; declarationId: string; revision: number; text: string }): string {
    const sourceId = newId('ms');
    if (input.kind === 'message') {
      run(`INSERT INTO memory_sources(id, scope_id, kind, message_id, revision, state, created_at) VALUES (?, ?, 'message', ?, 1, 'authorized', ?)`,
        sourceId, str(scope, 'id'), input.messageId, now());
    } else {
      run(`INSERT INTO memory_sources(id, scope_id, kind, declaration_id, revision, text, state, created_at) VALUES (?, ?, 'declaration', ?, ?, ?, 'authorized', ?)`,
        sourceId, str(scope, 'id'), input.declarationId, input.revision, input.text, now());
    }
    if (stateOf(scope) === 'active') queueExport(str(scope, 'workspace_id'), sourceId, input.kind);
    return sourceId;
  }
  const queueExport = (workspaceId: string, sourceId: string, kind: string) =>
    run(`INSERT OR IGNORE INTO memory_exports(source_id, workspace_id, session, state) VALUES (?, ?, ?, 'pending')`,
      sourceId, workspaceId, kind === 'declaration' ? 'declarations' : 'conversation');

  function declare(scope: Row, text: string): string {
    const count = int(get(`SELECT COUNT(*) AS n FROM memory_sources WHERE scope_id = ? AND kind = 'declaration' AND state = 'authorized'`, str(scope, 'id')) ?? {}, 'n');
    if (count >= LIMITS.memoriesPerBot) throw new MemoryRefusal('limit_reached', `Ce personnage a déjà ${LIMITS.memoriesPerBot} déclarations. Excluez-en une avant d’en ajouter.`);
    const declarationId = newId('md');
    addSource(scope, { kind: 'declaration', declarationId, revision: 1, text });
    return declarationId;
  }

  const currentDeclaration = (scope: Row, declarationId: string): Row => {
    const row = get(`SELECT * FROM memory_sources WHERE scope_id = ? AND declaration_id = ? AND state = 'authorized'`, str(scope, 'id'), declarationId);
    if (!row) throw new MemoryRefusal('not_found', 'Cette déclaration n’existe plus dans la mémoire de ce personnage.');
    return row;
  };

  function confirmLabel(scope: Row, typed: string): void {
    if (typed.trim() !== str(scope, 'label')) throw new MemoryRefusal('stale_base', 'Le nom saisi ne correspond pas exactement au nom du projet. Rien n’a changé.');
  }

  function execute(command: MemoryCommand): MemoryResult {
    const botId = command.botId;
    if (!get('SELECT 1 AS x FROM bots WHERE id = ? AND deleted_at IS NULL', botId)) throw new MemoryRefusal('not_found', 'Ce personnage n’existe pas ou a été supprimé.');
    switch (command.type) {
      case 'memory.enable': {
        if (scopeOf(botId)) throw new MemoryRefusal('invalid_transition', 'Ce personnage a déjà un projet de mémoire Honcho.');
        const scopeId = newId('mp');
        // The workspace row points at its scope, so the scope exists first and gets its workspace name in the same transaction.
        run(`INSERT INTO memory_scopes(id, bot_id, label, state, workspace_id, consented_at) VALUES (?, ?, ?, 'preparing', '', ?)`, scopeId, botId, command.label, now());
        run('UPDATE memory_scopes SET workspace_id = ? WHERE id = ?', newWorkspace(scopeId), scopeId);
        return { kind: 'scope', botId, state: 'preparing' };
      }
      case 'memory.import': {
        const scope = requireOpen(botId);
        const declarationIds = command.memoryIds.map(memoryId => {
          const memory = get('SELECT text FROM memories WHERE id = ? AND bot_id = ?', memoryId, botId);
          if (!memory) throw new MemoryRefusal('not_found', 'Un de ces souvenirs n’existe plus pour ce personnage. Rien n’a été importé.');
          const declarationId = declare(scope, str(memory, 'text'));
          run('DELETE FROM memories WHERE id = ?', memoryId);
          run(`UPDATE commands SET fingerprint = '' WHERE type IN ('memory.create', 'memory.update') AND json_extract(result, '$.memoryId') = ?`, memoryId);
          return declarationId;
        });
        return { kind: 'declarations', botId, declarationIds };
      }
      case 'memory.declare':
        return { kind: 'declarations', botId, declarationIds: [declare(requireOpen(botId), command.text)] };
      case 'memory.correct': {
        const scope = requireOpen(botId);
        const current = currentDeclaration(scope, command.declarationId);
        if (int(current, 'revision') !== command.baseRevision) throw new MemoryRefusal('stale_base', 'Cette déclaration a changé entre-temps. Rien n’a été écrasé.');
        if (str(current, 'text') === command.text) throw new MemoryRefusal('invalid_command', 'Le texte corrigé est identique au texte actuel.');
        advance(scope);
        const replacedBy = addSource(scope, { kind: 'declaration', declarationId: command.declarationId, revision: command.baseRevision + 1, text: command.text });
        withdraw([str(current, 'id')], { replacedBy });
        return { kind: 'declarations', botId, declarationIds: [command.declarationId] };
      }
      case 'memory.exclude': {
        const scope = requireOpen(botId);
        const target = command.target;
        const source = target.kind === 'declaration' ? currentDeclaration(scope, target.declarationId)
          : get(`SELECT * FROM memory_sources WHERE scope_id = ? AND message_id = ? AND state = 'authorized'`, str(scope, 'id'), target.messageId);
        if (!source) throw new MemoryRefusal('not_found', 'Ce message ne fait pas partie de la mémoire de ce personnage, ou en est déjà exclu.');
        advance(scope);
        withdraw([str(source, 'id')], 'excluded');
        return { kind: 'excluded', botId, sourceId: str(source, 'id') };
      }
      case 'memory.forget': {
        const scope = requireScope(botId);
        if (stateOf(scope) !== 'active') throw new MemoryRefusal('invalid_transition', 'Seule une mémoire active peut être oubliée.');
        confirmLabel(scope, command.confirmLabel);
        advance(scope);
        withdraw(all(`SELECT id FROM memory_sources WHERE scope_id = ? AND state = 'authorized'`, str(scope, 'id')).map(row => str(row, 'id')), 'forgotten');
        run(`UPDATE memory_scopes SET state = 'withdrawal_pending', note = NULL WHERE id = ?`, str(scope, 'id'));
        return { kind: 'scope', botId, state: 'withdrawal_pending' };
      }
      case 'memory.reset': {
        const scope = requireScope(botId);
        if (stateOf(scope) !== 'withdrawal_unverified') throw new MemoryRefusal('invalid_transition', 'Un nouvel espace vide se demande après un oubli, quand les demandes de retrait sont terminées.');
        confirmLabel(scope, command.confirmLabel);
        advance(scope);
        run(`UPDATE memory_scopes SET state = 'reset_pending', next_workspace_id = ?, note = NULL WHERE id = ?`, newWorkspace(str(scope, 'id')), str(scope, 'id'));
        return { kind: 'scope', botId, state: 'reset_pending' };
      }
      case 'memory.resume': {
        const scope = requireScope(botId);
        const scopeId = str(scope, 'id');
        const state = stateOf(scope);
        if (state === 'preparing' || state === 'reset_pending') {
          const column = state === 'preparing' ? 'workspace_id' : 'next_workspace_id';
          const failed = get(`SELECT 1 AS x FROM memory_workspaces WHERE id = ? AND state = 'failed'`, str(scope, column));
          if (!failed) throw new MemoryRefusal('invalid_transition', 'La préparation de cet espace est encore en cours. Rien à reprendre.');
          run(`UPDATE memory_scopes SET ${column} = ?, note = NULL WHERE id = ?`, newWorkspace(scopeId), scopeId);
        } else if (state === 'active') {
          const workspaceId = str(scope, 'workspace_id');
          const moved = run(`UPDATE memory_exports SET state = 'pending' WHERE workspace_id = ? AND state = 'failed'`, workspaceId)
            + run(`UPDATE memory_exports SET state = 'ingested' WHERE workspace_id = ? AND state = 'uncertain' AND remote_id IS NOT NULL`, workspaceId)
            + run(`UPDATE memory_exports SET reconcile = 1 WHERE workspace_id = ? AND state = 'uncertain' AND remote_id IS NULL AND reconcile = 0`, workspaceId);
          if (!moved) throw new MemoryRefusal('invalid_transition', 'Rien n’est incertain ni en échec dans cette mémoire.');
          note(scopeId, null);
        } else if (state === 'withdrawal_pending') {
          note(scopeId, null);
        } else {
          throw new MemoryRefusal('invalid_transition', 'Cette mémoire reste suspendue. Demandez un nouvel espace vide pour la rouvrir.');
        }
        return { kind: 'scope', botId, state };
      }
      default: {
        const _exhaustive: never = command;
        return _exhaustive;
      }
    }
  }

  function apply(command: MemoryCommand): MemoryOutcome {
    try {
      const outcome = kit.transaction((): Extract<MemoryOutcome, { ok: true }> => {
        const { requestId, ...payload } = command;
        const print = kit.sign(payload);
        const prior = receipts.find(requestId);
        if (prior) {
          if (prior.type !== command.type || prior.fingerprint !== print) throw new MemoryRefusal('request_conflict', 'Cette identité de commande a déjà servi pour un autre contenu.');
          return { ok: true, replayed: true, result: MemoryResultSchema.parse(JSON.parse(prior.result)) };
        }
        const result = execute(command);
        receipts.save(requestId, command.type, print, JSON.stringify(result));
        return { ok: true, replayed: false, result };
      });
      if (!outcome.replayed) kit.changed();
      return outcome;
    } catch (error) {
      if (error instanceof MemoryRefusal) return { ok: false, code: error.code, message: error.message };
      throw error;
    }
  }

  /** Reserves one request. A refusal of admission leaves no request: the scope shows why nothing left. */
  function reserve(scope: Row, workspaceId: string, kind: RequestKind, about: { sourceId?: string; session?: string; workId?: string; origin?: string }): string | null {
    const requestId = newId('mr');
    const generation = int(scope, 'generation');
    const reserved = admission.reserve({
      capability: CAPABILITY[kind], source: { kind: 'human', id: about.origin ?? str(scope, 'id') }, target: targetOf(requestId, generation),
    });
    if (!reserved.ok) {
      note(str(scope, 'id'), 'budget');
      return null;
    }
    run(`INSERT INTO memory_requests(id, scope_id, workspace_id, generation, kind, state, source_id, session, work_id, created_at) VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?)`,
      requestId, str(scope, 'id'), workspaceId, generation, kind, about.sourceId ?? null, about.session ?? null, about.workId ?? null, now());
    if (about.sourceId !== undefined) run('UPDATE memory_exports SET request_id = ? WHERE source_id = ? AND workspace_id = ?', requestId, about.sourceId, workspaceId);
    return requestId;
  }

  const WITHDRAW_TARGETS: readonly (string | null)[] = [...SESSIONS, null];
  const withdrawn = (scope: Row, session: string | null): Row | undefined =>
    get(`SELECT state FROM memory_requests WHERE scope_id = ? AND workspace_id = ? AND kind = 'withdraw' AND session IS ? AND state <> 'voided'`,
      str(scope, 'id'), str(scope, 'workspace_id'), session);

  function nextFor(scope: Row): string | null {
    const scopeId = str(scope, 'id');
    if (get(`SELECT 1 AS x FROM memory_requests WHERE scope_id = ? AND state IN ('reserved','started') AND work_id IS NULL`, scopeId)) return null;
    const state = stateOf(scope);
    if (state === 'preparing' || state === 'reset_pending') {
      const workspaceId = str(scope, state === 'preparing' ? 'workspace_id' : 'next_workspace_id');
      const workspace = get('SELECT state FROM memory_workspaces WHERE id = ?', workspaceId) ?? {};
      if (str(workspace, 'state') === 'pending') return reserve(scope, workspaceId, 'workspace', {});
      if (str(workspace, 'state') !== 'confirmed') return null;
      const session = get('SELECT name FROM memory_sessions WHERE workspace_id = ? AND confirmed = 0 ORDER BY name DESC LIMIT 1', workspaceId);
      return session ? reserve(scope, workspaceId, 'session', { session: str(session, 'name') }) : null;
    }
    if (state === 'active') {
      const workspaceId = str(scope, 'workspace_id');
      const waiting = get(`SELECT source_id, session, state, remote_id FROM memory_exports WHERE workspace_id = ? AND request_id IS NULL
        AND (state IN ('pending','ingested') OR (state = 'uncertain' AND reconcile = 1)) ORDER BY rowid LIMIT 1`, workspaceId);
      if (!waiting) return null;
      const about = { sourceId: str(waiting, 'source_id'), session: str(waiting, 'session') };
      return reserve(scope, workspaceId, str(waiting, 'state') === 'pending' ? 'ingest' : str(waiting, 'state') === 'ingested' ? 'read' : 'search', about);
    }
    if (state === 'withdrawal_pending') {
      const target = WITHDRAW_TARGETS.find(session => !withdrawn(scope, session));
      return target === undefined ? null : reserve(scope, str(scope, 'workspace_id'), 'withdraw', target === null ? {} : { session: target });
    }
    return null;
  }

  function next(): string | null {
    const before = noted;
    const requestId = kit.transaction(() => {
      for (const scope of all('SELECT * FROM memory_scopes ORDER BY rowid')) {
        const reserved = nextFor(scope);
        if (reserved) return reserved;
      }
      return null;
    });
    if (noted !== before) kit.changed();
    return requestId;
  }

  const exportOf = (request: Row): Row | undefined =>
    get('SELECT * FROM memory_exports WHERE source_id = ? AND workspace_id = ? AND request_id = ?', strOrNull(request, 'source_id'), str(request, 'workspace_id'), str(request, 'id'));
  const authorizedSource = (sourceId: string | null): Row | undefined =>
    sourceId === null ? undefined : get(`SELECT * FROM memory_sources WHERE id = ? AND state = 'authorized'`, sourceId);

  /** The permit of one reserved request, built from what SQLite says now. Undefined when a guard fails. */
  function permitFor(request: Row, scope: Row): SendPermit | undefined {
    const requestId = str(request, 'id');
    const workspaceId = str(request, 'workspace_id');
    const state = stateOf(scope);
    const kind = oneOf(request, 'kind', REQUEST_KINDS);
    const base = { requestId, workspaceId };
    if (kind === 'workspace' || kind === 'session') {
      if (state !== 'preparing' && state !== 'reset_pending') return undefined;
      if (workspaceId !== str(scope, state === 'preparing' ? 'workspace_id' : 'next_workspace_id')) return undefined;
      const workspace = get('SELECT state FROM memory_workspaces WHERE id = ?', workspaceId) ?? {};
      if (kind === 'workspace') return str(workspace, 'state') === 'pending' ? { ...base, kind } : undefined;
      const session = str(request, 'session');
      if (str(workspace, 'state') !== 'confirmed' || !get('SELECT 1 AS x FROM memory_sessions WHERE workspace_id = ? AND name = ? AND confirmed = 0', workspaceId, session)) return undefined;
      return { ...base, kind, session, peerId: MEMORY_PEER };
    }
    if (kind === 'withdraw') {
      return state === 'withdrawal_pending' && workspaceId === str(scope, 'workspace_id') ? { ...base, kind, session: strOrNull(request, 'session') } : undefined;
    }
    if (state !== 'active' || workspaceId !== str(scope, 'workspace_id')) return undefined;
    const workId = strOrNull(request, 'work_id');
    if (kind === 'search' && workId !== null) {
      const work = get(`SELECT m.text FROM works w JOIN messages m ON m.id = w.request_message_id WHERE w.id = ? AND w.state = 'pending'`, workId);
      return work ? { ...base, kind, query: clip(str(work, 'text'), QUERY_CHARS), limit: SEARCH_LIMIT, session: null } : undefined;
    }
    const exported = exportOf(request);
    const source = authorizedSource(strOrNull(request, 'source_id'));
    const text = source ? original(source) : null;
    if (!exported || !source || text === null) return undefined;
    const session = str(exported, 'session');
    if (!get('SELECT 1 AS x FROM memory_sessions WHERE workspace_id = ? AND name = ? AND confirmed = 1', workspaceId, session)) return undefined;
    const exportState = oneOf(exported, 'state', EXPORT_STATES);
    if (kind === 'ingest') return exportState === 'pending' ? { ...base, kind, session, peerId: MEMORY_PEER, text } : undefined;
    if (kind === 'read') {
      const remoteId = strOrNull(exported, 'remote_id');
      return exportState === 'ingested' && remoteId !== null ? { ...base, kind, session, remoteId } : undefined;
    }
    return exportState === 'uncertain' && int(exported, 'reconcile') === 1 ? { ...base, kind: 'search', query: clip(text, QUERY_CHARS), limit: SEARCH_LIMIT, session } : undefined;
  }

  function begin(requestId: string): SendPermit | null {
    return kit.transaction((): SendPermit | null => {
      const request = get(`SELECT * FROM memory_requests WHERE id = ? AND state = 'reserved'`, requestId);
      if (!request) return null;
      const scope = scopeById(str(request, 'scope_id'));
      const permit = scope && int(scope, 'generation') === int(request, 'generation') ? permitFor(request, scope) : undefined;
      // An original the transport would refuse never leaves: its export fails here instead of being reserved again for ever.
      if (permit?.kind === 'ingest' && (permit.text.includes('\u0000') || permit.text.length > 100_000)) {
        voidRequest(request);
        run(`UPDATE memory_exports SET state = 'failed' WHERE source_id = ? AND workspace_id = ?`, strOrNull(request, 'source_id'), permit.workspaceId);
        return null;
      }
      if (!scope || !permit || !admission.depart(CAPABILITY[permit.kind], targetOf(requestId, int(scope, 'generation'))).ok) {
        voidRequest(request);
        return null;
      }
      run(`UPDATE memory_requests SET state = 'started' WHERE id = ?`, requestId);
      return permit;
    });
  }

  /** A session is confirmed, or a reset got its workspace: the scope opens on this workspace and every current source waits for its export. */
  function activate(scope: Row, workspaceId: string): void {
    const scopeId = str(scope, 'id');
    if (stateOf(scope) === 'reset_pending') {
      run(`UPDATE memory_workspaces SET state = 'retired' WHERE id = ? AND state = 'confirmed'`, str(scope, 'workspace_id'));
      run(`UPDATE memory_scopes SET state = 'active', workspace_id = ?, next_workspace_id = NULL, note = NULL WHERE id = ?`, workspaceId, scopeId);
    } else {
      run(`UPDATE memory_scopes SET state = 'active', note = NULL WHERE id = ?`, scopeId);
    }
    for (const source of all(`SELECT id, kind FROM memory_sources WHERE scope_id = ? AND state = 'authorized' ORDER BY rowid`, scopeId)) {
      queueExport(workspaceId, str(source, 'id'), str(source, 'kind'));
    }
  }

  const sameCopy = (remote: RemoteHonchoMessage, exported: Row, text: string): boolean =>
    remote.peerId === MEMORY_PEER && remote.sessionId === str(exported, 'session') && remote.workspaceId === str(exported, 'workspace_id') && remote.text === text;
  const mappedElsewhere = (exported: Row, remoteId: string): boolean => get(
    'SELECT 1 AS x FROM memory_exports WHERE workspace_id = ? AND session = ? AND remote_id = ? AND source_id <> ?',
    str(exported, 'workspace_id'), str(exported, 'session'), remoteId, str(exported, 'source_id')) !== undefined;

  function settleExport(request: Row, scope: Row, settlement: Extract<Settlement, { kind: 'ingest' | 'read' | 'search' }>): void {
    const exported = exportOf(request);
    if (!exported) return;
    const where = [str(exported, 'source_id'), str(exported, 'workspace_id')] as const;
    const set = (state: (typeof EXPORT_STATES)[number], remoteId: string | null = strOrNull(exported, 'remote_id')) =>
      run('UPDATE memory_exports SET state = ?, remote_id = ?, request_id = NULL, reconcile = 0 WHERE source_id = ? AND workspace_id = ?', state, remoteId, ...where);
    const source = authorizedSource(str(exported, 'source_id'));
    const text = source ? original(source) : null;
    if (stateOf(scope) !== 'active' || str(scope, 'workspace_id') !== str(exported, 'workspace_id') || text === null) return void set('voided', null);
    const result = settlement.result;
    if (settlement.kind === 'ingest') {
      if (settlement.result.kind !== 'ok') return void set(result.kind === 'rejected' ? 'failed' : 'uncertain');
      const [remote, ...others] = settlement.result.value;
      const matches = remote !== undefined && !others.length && sameCopy(remote, exported, text) && !mappedElsewhere(exported, remote.remoteId);
      return void (matches ? set('ingested', remote.remoteId) : set('uncertain'));
    }
    if (settlement.kind === 'read') {
      const matches = settlement.result.kind === 'ok' && settlement.result.value.remoteId === strOrNull(exported, 'remote_id') && sameCopy(settlement.result.value, exported, text);
      return void set(matches ? 'verified' : 'uncertain');
    }
    const candidates = settlement.result.kind === 'ok'
      ? settlement.result.value.filter(remote => sameCopy(remote, exported, text) && !mappedElsewhere(exported, remote.remoteId)) : [];
    const [only, ...more] = candidates;
    set(only !== undefined && !more.length ? 'ingested' : 'uncertain', only !== undefined && !more.length ? only.remoteId : null);
  }

  function settle(requestId: string, settlement: Settlement): void {
    kit.transaction(() => {
      const request = get(`SELECT * FROM memory_requests WHERE id = ? AND state = 'started'`, requestId);
      if (!request || str(request, 'kind') !== settlement.kind) return;
      const result = settlement.result;
      const state = result.kind === 'unsupported' ? 'rejected' : result.kind;
      const category = result.kind === 'ok' ? null : result.kind === 'unsupported' ? 'unsupported' : result.reason;
      const hits = settlement.kind === 'search' && settlement.result.kind === 'ok' && strOrNull(request, 'work_id') !== null
        ? JSON.stringify(settlement.result.value.map(remote => ({ remoteId: remote.remoteId, session: remote.sessionId, peer: remote.peerId }))) : null;
      run('UPDATE memory_requests SET state = ?, category = ?, hits = ?, closed_at = ? WHERE id = ?', state, category, hits, now(), requestId);
      admission.settle(CAPABILITY[settlement.kind], { kind: 'service', id: requestId }, state === 'uncertain' ? 'unknown' : 'ended');
      const scope = scopeById(str(request, 'scope_id'));
      if (!scope) return;
      const scopeId = str(scope, 'id');
      const workspaceId = str(request, 'workspace_id');
      if (settlement.kind === 'workspace' || settlement.kind === 'session') {
        const waiting = (stateOf(scope) === 'preparing' && str(scope, 'workspace_id') === workspaceId)
          || (stateOf(scope) === 'reset_pending' && strOrNull(scope, 'next_workspace_id') === workspaceId);
        // A workspace that already existed is not a new one: it is refused like a failure and its name is never tried again.
        const confirmed = settlement.kind === 'workspace' ? settlement.result.kind === 'ok' && settlement.result.value.created : settlement.result.kind === 'ok';
        if (!waiting || !confirmed) {
          run(`UPDATE memory_workspaces SET state = 'failed' WHERE id = ? AND state IN ('pending','confirmed')`, workspaceId);
          if (waiting) note(scopeId, settlement.result.kind === 'ok' ? 'workspace_not_new' : category);
          return;
        }
        if (settlement.kind === 'workspace') return void run(`UPDATE memory_workspaces SET state = 'confirmed' WHERE id = ?`, workspaceId);
        run('UPDATE memory_sessions SET confirmed = 1 WHERE workspace_id = ? AND name = ?', workspaceId, str(request, 'session'));
        if (!get('SELECT 1 AS x FROM memory_sessions WHERE workspace_id = ? AND confirmed = 0', workspaceId)) activate(scope, workspaceId);
        return;
      }
      if (settlement.kind === 'withdraw') {
        if (stateOf(scope) !== 'withdrawal_pending' || WITHDRAW_TARGETS.some(session => {
          const sent = withdrawn(scope, session);
          return !sent || str(sent, 'state') === 'reserved' || str(sent, 'state') === 'started';
        })) return;
        // Even three acknowledgements prove no purge: the scope stays closed, and only a new empty workspace reopens it.
        run(`UPDATE memory_scopes SET state = 'withdrawal_unverified', note = 'purge_unverified' WHERE id = ?`, scopeId);
        run(`UPDATE memory_workspaces SET state = 'retired' WHERE id = ? AND state = 'confirmed'`, workspaceId);
        return;
      }
      if (strOrNull(request, 'work_id') !== null) return;
      settleExport(request, scope, settlement);
      if (result.kind === 'ok') note(scopeId, null);
      else note(scopeId, category);
    });
    kit.changed();
  }

  function recover(): number {
    let uncertain = 0;
    for (const request of all(`SELECT * FROM memory_requests WHERE state IN ('reserved','started')`)) {
      const requestId = str(request, 'id');
      if (str(request, 'state') === 'reserved') {
        run(`UPDATE memory_requests SET state = 'voided', closed_at = ? WHERE id = ?`, now(), requestId);
        run('UPDATE memory_exports SET request_id = NULL WHERE request_id = ?', requestId);
        continue;
      }
      uncertain += run(`UPDATE memory_requests SET state = 'uncertain', category = 'interrupted', closed_at = ? WHERE id = ?`, now(), requestId);
      run(`UPDATE memory_exports SET state = 'uncertain', request_id = NULL, reconcile = 0 WHERE request_id = ?`, requestId);
      const kind = str(request, 'kind');
      if (kind === 'workspace' || kind === 'session') {
        run(`UPDATE memory_workspaces SET state = 'failed' WHERE id = ? AND state IN ('pending','confirmed')`, str(request, 'workspace_id'));
        note(str(request, 'scope_id'), 'interrupted');
      }
    }
    return uncertain;
  }

  function holds(attemptId: string): Hold {
    const frozen = get('SELECT m.*, s.generation AS now_generation, s.state AS scope_state FROM attempt_memory m JOIN memory_scopes s ON s.id = m.scope_id WHERE m.attempt_id = ?', attemptId);
    if (!frozen) return { ok: true };
    if (int(frozen, 'generation') !== int(frozen, 'now_generation')) return { ok: false, reason: 'generation_moved' };
    if (str(frozen, 'recall') === 'used' && str(frozen, 'scope_state') !== 'active') return { ok: false, reason: 'scope_suspended' };
    const withdrawnRow = int(frozen, 'retired') === 1 || get(`SELECT 1 AS x FROM attempt_sources a JOIN memory_sources s ON s.id = a.source_id
      WHERE a.attempt_id = ? AND s.state <> 'authorized'`, attemptId) !== undefined
      || get('SELECT 1 AS x FROM attempt_replies r JOIN attempt_memory m ON m.attempt_id = r.reply_attempt_id WHERE r.attempt_id = ? AND m.retired = 1', attemptId) !== undefined;
    return withdrawnRow ? { ok: false, reason: 'source_withdrawn' } : { ok: true };
  }

  const eligible = (candidate: Candidate, scope: Row | undefined): scope is Row =>
    scope !== undefined && candidate.botId === candidate.threadBotId && candidate.human && stateOf(scope) === 'active';

  function plan(candidate: Candidate): RecallPlan {
    const scope = scopeOf(candidate.botId);
    if (!eligible(candidate, scope)) return { kind: 'none' };
    const requestId = reserve(scope, str(scope, 'workspace_id'), 'search', { workId: candidate.workId, origin: candidate.requestMessageId });
    return requestId ? { kind: 'search', workId: candidate.workId, requestId } : { kind: 'unavailable', workId: candidate.workId, category: 'budget' };
  }

  function recall(candidate: Candidate, given: RecallOutcome | undefined): ReturnType<MemoryInternals['recall']> {
    const scope = scopeOf(candidate.botId);
    if (!scope || candidate.botId !== candidate.threadBotId) return null;
    const absent = (state: 'unavailable' | 'suspended', category: string | null) => ({ part: { state, items: [], omitted: 0 }, recalled: [], category });
    const state = stateOf(scope);
    if (state !== 'active') return state === 'preparing' ? absent('unavailable', 'preparing') : absent('suspended', null);
    if (!candidate.human) return absent('unavailable', 'automatic_request');
    if (given === undefined) return absent('unavailable', 'not_planned');
    if (given.kind === 'forced') return absent('unavailable', 'replan');
    if (given.kind === 'none' || given.workId !== candidate.workId) return 'replan';
    if (given.kind === 'unavailable') return absent('unavailable', given.category);
    const scopeId = str(scope, 'id');
    const workspaceId = str(scope, 'workspace_id');
    const generation = int(scope, 'generation');
    const request = get(`SELECT hits FROM memory_requests WHERE id = ? AND kind = 'search' AND state = 'ok' AND scope_id = ? AND workspace_id = ? AND generation = ? AND work_id = ?`,
      given.requestId, scopeId, workspaceId, generation, candidate.workId);
    if (!request) return 'replan';
    const verified = (sourceId: string) => get(`SELECT 1 AS x FROM memory_exports WHERE source_id = ? AND workspace_id = ? AND state = 'verified'`, sourceId, workspaceId) !== undefined;
    const found: Row[] = [];
    for (const hit of HitsSchema.parse(JSON.parse(strOrNull(request, 'hits') ?? '[]'))) {
      if (hit.peer !== MEMORY_PEER) continue;
      const mapped = get(`SELECT source_id FROM memory_exports WHERE workspace_id = ? AND session = ? AND remote_id = ? AND state = 'verified'`, workspaceId, hit.session, hit.remoteId);
      let row = mapped ? get('SELECT * FROM memory_sources WHERE id = ? AND scope_id = ?', str(mapped, 'source_id'), scopeId) : undefined;
      // A corrected declaration is replaced by its current version, when that version was verified in its turn.
      while (row && str(row, 'state') === 'corrected') row = get('SELECT * FROM memory_sources WHERE id = ?', str(row, 'replaced_by'));
      const source = row;
      if (!source || str(source, 'state') !== 'authorized' || !verified(str(source, 'id')) || strOrNull(source, 'message_id') === candidate.requestMessageId) continue;
      if (!found.some(known => known.id === source.id)) found.push(source);
    }
    const declarations = all(`SELECT * FROM memory_sources WHERE scope_id = ? AND kind = 'declaration' AND state = 'authorized' ORDER BY rowid`, scopeId).filter(row => verified(str(row, 'id')));
    const ordered = [
      ...found.filter(row => str(row, 'kind') === 'declaration'),
      ...declarations.filter(row => !found.some(hit => hit.id === row.id)),
      ...found.filter(row => str(row, 'kind') === 'message'),
    ].slice(0, 100);
    const stableId = (row: Row) => strOrNull(row, 'declaration_id') ?? str(row, 'id');
    const binding = { projectId: scopeId, workspaceId, generation };
    const query = clip(str(get('SELECT text FROM messages WHERE id = ?', candidate.requestMessageId) ?? {}, 'text'), QUERY_CHARS);
    const selected = selectHonchoRecall({
      scope: { kind: 'active', ...binding },
      request: { ...binding, query, maxItems: RECALL_ITEMS, maxChars: RECALL_CHARS },
      response: { kind: 'references', ...binding, references: ordered.map(row => ({ sourceId: stableId(row), revision: int(row, 'revision') })) },
      sources: ordered.map(row => ({
        kind: 'authorized', projectId: scopeId, sourceId: stableId(row), revision: int(row, 'revision'), text: original(row) ?? '',
        origin: str(row, 'kind') === 'declaration' ? { kind: 'declaration', declarationId: stableId(row) } : { kind: 'message', threadId: candidate.threadBotId, messageId: str(row, 'message_id') },
      })),
      excludedSourceIds: [],
    });
    if (selected.kind !== 'selected') return absent('unavailable', 'mapping');
    const rows = selected.items.flatMap(item => ordered.filter(row => stableId(row) === item.sourceId));
    return {
      part: {
        state: selected.items.length ? 'used' : 'empty',
        items: selected.items.map(item => ({ origin: item.origin.kind, text: item.text, truncated: item.truncated })),
        omitted: ordered.length - selected.items.length,
      },
      recalled: rows.map(row => str(row, 'id')),
      category: null,
    };
  }

  function freeze(attemptId: string, manifest: Manifest): void {
    const scope = scopeOf(manifest.threadBotId);
    if (!scope) return;
    const scopeId = str(scope, 'id');
    run('INSERT INTO attempt_memory(attempt_id, scope_id, generation, recall, category, omitted) VALUES (?, ?, ?, ?, ?, ?)',
      attemptId, scopeId, int(scope, 'generation'), manifest.recall.state, manifest.recall.category, manifest.recall.omitted);
    const add = (sourceId: string, via: string) => run('INSERT OR IGNORE INTO attempt_sources(attempt_id, source_id, via) VALUES (?, ?, ?)', attemptId, sourceId, via);
    for (const sourceId of manifest.recalled) add(sourceId, 'recall');
    const ofMessage = (messageId: string) => get('SELECT id FROM memory_sources WHERE message_id = ? AND scope_id = ?', messageId, scopeId);
    const request = ofMessage(manifest.requestMessageId);
    if (request) add(str(request, 'id'), 'request');
    for (const messageId of manifest.historyMessageIds) {
      const source = ofMessage(messageId);
      if (source) add(str(source, 'id'), 'history');
    }
    for (const replyAttemptId of new Set(manifest.replyAttemptIds)) {
      if (replyAttemptId !== attemptId) run('INSERT OR IGNORE INTO attempt_replies(attempt_id, reply_attempt_id) VALUES (?, ?)', attemptId, replyAttemptId);
    }
  }

  const syncOf = (state: string | null): SyncState =>
    state === 'verified' ? 'verified' : state === 'uncertain' ? 'uncertain' : state === 'failed' ? 'failed' : 'pending';

  function scopeViewOf(scope: Row): ScopeView {
    const scopeId = str(scope, 'id');
    const state = stateOf(scope);
    const workspaceId = str(scope, 'workspace_id');
    const sources = all(`SELECT s.*, e.state AS export_state FROM memory_sources s
      LEFT JOIN memory_exports e ON e.source_id = s.id AND e.workspace_id = ?
      WHERE s.scope_id = ? AND s.state = 'authorized' ORDER BY s.rowid`, workspaceId, scopeId);
    const messages = { pending: 0, verified: 0, uncertain: 0, failed: 0 };
    for (const row of sources) if (str(row, 'kind') === 'message') messages[syncOf(strOrNull(row, 'export_state'))] += 1;
    const target = state === 'reset_pending' ? strOrNull(scope, 'next_workspace_id') : workspaceId;
    const stuck = (state === 'preparing' || state === 'reset_pending') && get(`SELECT 1 AS x FROM memory_workspaces WHERE id = ? AND state = 'failed'`, target) !== undefined;
    return {
      botId: str(scope, 'bot_id'), label: str(scope, 'label'), state, note: strOrNull(scope, 'note'), consentedAt: str(scope, 'consented_at'),
      declarations: sources.filter(row => str(row, 'kind') === 'declaration').map(row => ({
        declarationId: str(row, 'declaration_id'), revision: int(row, 'revision'), text: str(row, 'text'),
        sync: syncOf(strOrNull(row, 'export_state')), createdAt: str(row, 'created_at'),
      })),
      messages,
      excludedMessageIds: all(`SELECT message_id FROM memory_sources WHERE scope_id = ? AND kind = 'message' AND state = 'excluded' ORDER BY rowid`, scopeId).map(row => str(row, 'message_id')),
      resumable: stuck || (state === 'active' && sources.some(row => ['uncertain', 'failed'].includes(strOrNull(row, 'export_state') ?? ''))),
    };
  }

  function view(): MemoryView {
    const usage = admission.usage().find(entry => entry.budget === MEMORY_BUDGET);
    return {
      status: config ? { state: 'ready', budget: usage ? { calls: usage.calls, callsPerDay: usage.callsPerDay } : null } : { state: 'off' },
      scopes: all('SELECT s.* FROM memory_scopes s JOIN bots b ON b.id = s.bot_id AND b.deleted_at IS NULL ORDER BY s.rowid').map(scopeViewOf),
      recalls: Object.fromEntries(all(`SELECT m.id, COUNT(*) AS n FROM attempt_sources s JOIN messages m ON m.attempt_id = s.attempt_id
        WHERE s.via = 'recall' GROUP BY m.id`).map(row => [str(row, 'id'), int(row, 'n')])),
    };
  }

  function provenance(messageId: string): Provenance | null {
    const reply = get(`SELECT attempt_id FROM messages WHERE id = ? AND role = 'assistant'`, messageId);
    if (!reply) return null;
    const attemptId = str(reply, 'attempt_id');
    const frozen = get('SELECT recall, omitted FROM attempt_memory WHERE attempt_id = ?', attemptId);
    if (!frozen) return { messageId, recall: 'none', omitted: 0, sources: [] };
    return {
      messageId, recall: oneOf(frozen, 'recall', RECALL_STATES), omitted: int(frozen, 'omitted'),
      sources: all(`SELECT s.* FROM attempt_sources a JOIN memory_sources s ON s.id = a.source_id WHERE a.attempt_id = ? AND a.via = 'recall' ORDER BY a.rowid`, attemptId).map(source => {
        const kind = oneOf(source, 'kind', SOURCE_KINDS);
        const text = str(source, 'state') === 'authorized' ? original(source) : null;
        return text === null ? { state: 'withdrawn' as const, kind } : {
          state: 'authorized' as const, kind, revision: int(source, 'revision'), text,
          declarationId: strOrNull(source, 'declaration_id'), messageId: strOrNull(source, 'message_id'), createdAt: str(source, 'created_at'),
        };
      }),
    };
  }

  return {
    view, apply, provenance, next, begin, settle, holds, plan, recall, freeze, recover,
    scoped: botId => scopeOf(botId) !== undefined,
    scopeView(botId) {
      const scope = scopeOf(botId);
      return scope ? { label: str(scope, 'label'), state: stateOf(scope) } : null;
    },
    declarationCount: botId => int(get(`SELECT COUNT(*) AS n FROM memory_sources s JOIN memory_scopes p ON p.id = s.scope_id
      WHERE p.bot_id = ? AND s.kind = 'declaration' AND s.state = 'authorized'`, botId) ?? {}, 'n'),
    observe(message) {
      const scope = scopeOf(message.threadBotId);
      if (scope && (stateOf(scope) === 'preparing' || stateOf(scope) === 'active')) addSource(scope, { kind: 'message', messageId: message.id });
    },
    requestAllowed: messageId => get(`SELECT 1 AS x FROM memory_sources WHERE message_id = ? AND state <> 'authorized'`, messageId) === undefined,
    workRetired: workId => get('SELECT 1 AS x FROM attempt_memory m JOIN attempts a ON a.id = m.attempt_id WHERE a.work_id = ? AND m.retired = 1', workId) !== undefined,
    blocksPurge(botId) {
      const scope = scopeOf(botId);
      if (!scope) return false;
      return ['active', 'withdrawal_pending', 'reset_pending'].includes(stateOf(scope))
        || get(`SELECT 1 AS x FROM memory_requests WHERE scope_id = ? AND state IN ('reserved','started')`, str(scope, 'id')) !== undefined;
    },
    markPurge(botId, erasedAttempts) {
      const scope = scopeOf(botId);
      const scopeId = scope ? str(scope, 'id') : '';
      const mark = (tbl: string, key: string, where: string, ...params: string[]) =>
        run(`INSERT OR IGNORE INTO purge_target(tbl, id) SELECT '${tbl}', ${key} FROM ${tbl} WHERE ${where}`, ...params);
      mark('attempt_memory', 'attempt_id', `scope_id = ? OR attempt_id IN (${erasedAttempts})`, scopeId);
      const manifests = `SELECT id FROM purge_target WHERE tbl = 'attempt_memory'`;
      mark('attempt_sources', `attempt_id || ':' || source_id`, `attempt_id IN (${manifests})`);
      mark('attempt_replies', `attempt_id || ':' || reply_attempt_id`, `attempt_id IN (${manifests}) OR reply_attempt_id IN (${erasedAttempts})`);
      mark('memory_requests', 'id', 'scope_id = ?', scopeId);
      mark('memory_sources', 'id', 'scope_id = ?', scopeId);
      mark('memory_exports', `source_id || ':' || workspace_id`, `source_id IN (SELECT id FROM purge_target WHERE tbl = 'memory_sources')`);
      mark('memory_sessions', `workspace_id || ':' || name`, 'workspace_id IN (SELECT id FROM memory_workspaces WHERE scope_id = ?)', scopeId);
      mark('memory_scopes', 'id', 'id = ?', scopeId);
      run(`UPDATE memory_workspaces SET state = CASE state WHEN 'confirmed' THEN 'retired' WHEN 'pending' THEN 'failed' ELSE state END WHERE scope_id = ?`, scopeId);
      run('UPDATE memory_workspaces SET scope_id = NULL WHERE scope_id = ?', scopeId);
      run(`UPDATE commands SET fingerprint = '' WHERE type LIKE 'memory.%' AND json_extract(result, '$.botId') = ?`, botId);
    },
  };
}
