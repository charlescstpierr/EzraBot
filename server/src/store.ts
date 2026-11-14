import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, rmSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { z } from 'zod';
import {
  CARNET_DESTINATION,
  CONTEXT_SIZES,
  CommandResultSchema,
  CommandSchema,
  ContextPlanSchema,
  DEFAULT_CONTEXT_SIZE,
  DEFAULT_REPLY_STYLE,
  LIMITS,
  REPLY_STYLES,
  UsageSnapshotSchema,
  PUBLISH_ACTION,
  LANES,
  MAX_CONTINUATIONS,
  PLAN_STEPS,
  STANDARD_SPEED,
  TASK_INTENTS,
  TASK_PLANS,
  TASK_STEPS,
  type AttemptView,
  type StoreDiagnostics,
  type BotChoice,
  type BotView,
  type Command,
  type CommandOf,
  type CommandResult,
  type DeletionCounts,
  type DispatchOutcome,
  type DocProposalView,
  type HandoffView,
  HandoffSchema,
  type Lane,
  type MessageView,
  type ProgressView,
  type TaskCallView,
  type TaskEventView,
  type TaskStep,
  type TaskView,
  type ProposalView,
  type PublicationView,
  type RefusalCode,
  type RunStage,
  type StoreView,
  type VersionView,
  type WorkState,
  type WorkView,
} from './protocol.js';
import {
  engineFailure,
  checkMentions,
  replyTargets,
  ENGINE_ERRORS,
  SEED_BOTS,
  canTransition,
  canTransitionDocument,
  publicationPayload,
  sha256Hex,
  workTitle,
  type EngineOutcome,
  type MascotCatalogue,
  type UsageObservation,
} from './domain.js';
import { htmlDocument } from './html-artifact.js';
import { requestsBackgroundResult } from './message-intent.js';
import { composeContext, type ComposedTurn, type ContextSource, type Exchange, type TaskSource } from './context.js';
import type { AgentText } from './engine.js';
import { decodeReplyProgress } from './partial-json.js';
import { canContinue, maxCalls, nextStep, stepActor, taskStatus, type TaskFacts } from './task.js';
import { int, oneOf, oneOfOrNull, str, strOrNull, type Row } from './sql-rows.js';
import { TOOL_MIGRATION, TOOL_PURGE_ORDER, TOOL_SOURCE_MIGRATION, createToolLedger, type GrantSnapshot, type ReportClaim, type ToolLedger } from './tool-ledger.js';
import { SOURCE_MIGRATION, createSources } from './source.js';
import { CONNECTION_MIGRATION, createConnections } from './connection.js';
import { ADMISSION_MIGRATION, DEFAULT_POLICY, createAdmission, type Admission, type Departure, type Target } from './admission.js';
import { AdmitSchema, ORIGIN_KINDS, occurrenceOf, type AdmissionPolicy, type AutomaticOrigin, type Origin } from './admission-protocol.js';
import { createMemoryLedger, type Candidate, type MemoryLedger, type RecallOutcome, type RecallPlan } from './memory-ledger.js';
import { MEMORY_MIGRATION, MEMORY_PURGE_ORDER } from './memory-schema.js';

export type Claim = {
  lane: Lane;
  workId: string;
  attemptId: string;
  n: number;
  botId: string;
  choice: BotChoice;
  turn: ComposedTurn;
  /** Service rights frozen when the turn was composed. Empty outside an ordinary chat request. */
  toolGrants: readonly GrantSnapshot[];
  /** `receipt`: the turn only reports the outcome of an approved action and proposes nothing. */
  purpose: { kind: 'request' } | { kind: 'receipt'; executionId: string };
};

export type FinishResult = { kind: 'recorded'; state: WorkState } | { kind: 'stale' };

export type AdmitOutcome =
  | { ok: true; kind: 'admitted' | 'duplicate'; messageId: string; workId: string }
  | { ok: false; code: RefusalCode; message: string };

export type DownloadFile = { filename: string; content: string; mediaType: 'text/markdown' | 'text/html' };

/** What the HTTP layer knows about both lanes at the instant it dispatches, in the same synchronous tick: calls not returned yet. */
export type DispatchContext = { activeWorkIds: readonly string[] };

export type Store = {
  readonly rev: number;
  /** Connected services: accounts, rights, proposals and receipts, in this same database. */
  readonly tools: ToolLedger;
  /** The shared ceilings and one-use permits of every call, in this same database. */
  readonly admission: Admission;
  /** The Honcho project of each character: consent, sources, mapping and one row per request, in this same database. */
  readonly memory: MemoryLedger;
  dispatch(input: unknown, context?: DispatchContext): DispatchOutcome;
  /**
   * Creates the work an automatic origin asks for. The same occurrence with the same content returns the first work;
   * with another content it is refused. A person's message goes through `dispatch`, which creates its work the same way.
   */
  admit(input: unknown): AdmitOutcome;
  view(): StoreView;
  diagnostics(): StoreDiagnostics;
  claimNextJob(): Claim | null;
  /**
   * What the next chat call needs from Honcho before it is claimed. A search is reserved here and sent by the caller,
   * outside any transaction.
   */
  planRecall(): RecallPlan;
  claimNext(lane: Lane): Claim | null;
  /** `replan`: the call that would be claimed is not the one this recall was planned for. Nothing was claimed. */
  claimNext(lane: Lane, recall: RecallOutcome): Claim | 'replan' | null;
  /** Keeps the latest received text of this claim's turn, decoded without repair. Ignored unless thread and turn are the claim's. */
  recordProgress(claim: Claim, text: AgentText): void;
  /** False once the person cancelled the call or the server recovered it. */
  attemptRunning(attemptId: string): boolean;
  setStage(claim: Claim, stage: RunStage): void;
  bindThread(claim: Claim, threadId: string): void;
  bindTurn(claim: Claim, turnId: string): void;
  /**
   * The permit of this claim's call, for the engine to take in the same tick as the request that starts the turn.
   * Refused when the call was stopped or its goal changed since the claim, and when the permit was already used.
   */
  depart(claim: Claim): Departure;
  /** Keeps the latest cumulative snapshot of the attempt bound to this thread and turn, whatever its state. */
  observeUsage(observation: UsageObservation): void;
  finishJob(claim: Claim, outcome: EngineOutcome): FinishResult;
  recoverInterrupted(): number;
  botChoice(botId: string): BotChoice | null;
  /** The exact request of the person that Mino's proposal answers, only for a proposal of Mino in Mino's own thread. */
  missionOrigin(messageId: string): { text: string } | null;
  /** A live bot, as a lead identity for a coordinated mission. */
  leadCandidate(botId: string): { botId: string; name: string; shape: string; color: string } | null;
  versionFile(versionId: string): DownloadFile | null;
  messageFile(messageId: string): DownloadFile | null;
  publicationFile(publicationId: string): DownloadFile | null;
  exportThread(threadBotId?: string): DownloadFile;
  onChange(listener: () => void): () => void;
  close(): void;
};

export class StoreLockedError extends Error {
  constructor() {
    super('Une autre instance de Mino utilise déjà ce dossier de données.');
  }
}

class Refusal extends Error {
  constructor(readonly code: RefusalCode, message: string) {
    super(message);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS bots(
  id TEXT PRIMARY KEY,
  position INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  shape TEXT NOT NULL,
  color TEXT NOT NULL,
  default_shape TEXT NOT NULL,
  default_color TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  speed TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS memories(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  bot_id TEXT NOT NULL REFERENCES bots(id),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS works(
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id),
  request_message_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('pending','running','review','done','failed','cancelled')),
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS attempts(
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id),
  n INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('running','succeeded','failed','cancelled','interrupted')),
  stage TEXT,
  requested_model TEXT,
  requested_effort TEXT,
  requested_speed TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  speed TEXT,
  thread_id TEXT,
  turn_id TEXT,
  context_sha256 TEXT NOT NULL,
  memory_ids TEXT NOT NULL,
  error_code TEXT,
  error_text TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(work_id, n)
) STRICT;
CREATE TABLE IF NOT EXISTS messages(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  bot_id TEXT NOT NULL REFERENCES bots(id),
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  text TEXT NOT NULL,
  attempt_id TEXT UNIQUE REFERENCES attempts(id),
  created_at TEXT NOT NULL,
  CHECK((role = 'assistant') = (attempt_id IS NOT NULL))
) STRICT;
CREATE TABLE IF NOT EXISTS attachments(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL REFERENCES messages(id),
  name TEXT NOT NULL,
  text TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS versions(
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id),
  n INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('result','edit','restore')),
  restored_from TEXT REFERENCES versions(id),
  attempt_id TEXT REFERENCES attempts(id),
  created_at TEXT NOT NULL,
  UNIQUE(work_id, n),
  CHECK((source = 'restore') = (restored_from IS NOT NULL))
) STRICT;
CREATE TABLE IF NOT EXISTS proposals(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  work_id TEXT NOT NULL REFERENCES works(id),
  version_id TEXT NOT NULL REFERENCES versions(id),
  action TEXT NOT NULL CHECK(action = 'publish'),
  destination TEXT NOT NULL CHECK(destination = 'carnet'),
  payload_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open','approved','rejected','stale')),
  stale_reason TEXT CHECK(stale_reason IN ('edited','restored','replaced')),
  created_at TEXT NOT NULL,
  closed_at TEXT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS one_open_proposal ON proposals(work_id) WHERE state = 'open';
CREATE TABLE IF NOT EXISTS decisions(
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals(id),
  decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')),
  payload_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS publications(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals(id),
  decision_id TEXT NOT NULL UNIQUE REFERENCES decisions(id),
  work_id TEXT NOT NULL REFERENCES works(id),
  version_id TEXT NOT NULL REFERENCES versions(id),
  destination TEXT NOT NULL CHECK(destination = 'carnet'),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS commands(
  request_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER IF NOT EXISTS messages_immutable BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'messages are immutable'); END;
CREATE TRIGGER IF NOT EXISTS messages_kept BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT, 'messages are immutable'); END;
CREATE TRIGGER IF NOT EXISTS work_owner_immutable BEFORE UPDATE OF bot_id, request_message_id ON works
  WHEN NEW.bot_id IS NOT OLD.bot_id OR NEW.request_message_id IS NOT OLD.request_message_id
  BEGIN SELECT RAISE(ABORT, 'work owner is immutable'); END;
CREATE TRIGGER IF NOT EXISTS reply_owner BEFORE INSERT ON messages
  WHEN NEW.role = 'assistant' AND NOT EXISTS (SELECT 1 FROM attempts a JOIN works w ON w.id = a.work_id WHERE a.id = NEW.attempt_id AND w.bot_id = NEW.bot_id)
  BEGIN SELECT RAISE(ABORT, 'reply owner mismatch'); END;
CREATE TRIGGER IF NOT EXISTS versions_immutable BEFORE UPDATE ON versions BEGIN SELECT RAISE(ABORT, 'versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS versions_kept BEFORE DELETE ON versions BEGIN SELECT RAISE(ABORT, 'versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS versions_restore_same_work BEFORE INSERT ON versions
  WHEN NEW.restored_from IS NOT NULL AND (SELECT work_id FROM versions WHERE id = NEW.restored_from) IS NOT NEW.work_id
  BEGIN SELECT RAISE(ABORT, 'restore crosses works'); END;
CREATE TRIGGER IF NOT EXISTS proposals_same_work BEFORE INSERT ON proposals
  WHEN (SELECT work_id FROM versions WHERE id = NEW.version_id) IS NOT NEW.work_id
  BEGIN SELECT RAISE(ABORT, 'proposal crosses works'); END;
CREATE TRIGGER IF NOT EXISTS proposals_final BEFORE UPDATE ON proposals WHEN OLD.state <> 'open'
  BEGIN SELECT RAISE(ABORT, 'proposal is closed'); END;
CREATE TRIGGER IF NOT EXISTS proposals_payload_immutable BEFORE UPDATE ON proposals
  WHEN NEW.id IS NOT OLD.id OR NEW.work_id IS NOT OLD.work_id OR NEW.version_id IS NOT OLD.version_id
    OR NEW.action IS NOT OLD.action OR NEW.destination IS NOT OLD.destination
    OR NEW.payload_sha256 IS NOT OLD.payload_sha256 OR NEW.created_at IS NOT OLD.created_at
  BEGIN SELECT RAISE(ABORT, 'proposal payload is immutable'); END;
CREATE TRIGGER IF NOT EXISTS proposals_kept BEFORE DELETE ON proposals BEGIN SELECT RAISE(ABORT, 'proposals are kept'); END;
CREATE TRIGGER IF NOT EXISTS decisions_immutable BEFORE UPDATE ON decisions BEGIN SELECT RAISE(ABORT, 'decisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS decisions_kept BEFORE DELETE ON decisions BEGIN SELECT RAISE(ABORT, 'decisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS publications_immutable BEFORE UPDATE ON publications BEGIN SELECT RAISE(ABORT, 'publications are immutable'); END;
CREATE TRIGGER IF NOT EXISTS publications_kept BEFORE DELETE ON publications BEGIN SELECT RAISE(ABORT, 'publications are immutable'); END;
CREATE TRIGGER IF NOT EXISTS publications_match_version BEFORE INSERT ON publications
  WHEN NOT EXISTS (SELECT 1 FROM versions v WHERE v.id = NEW.version_id AND v.work_id = NEW.work_id AND v.title = NEW.title AND v.body = NEW.body)
  BEGIN SELECT RAISE(ABORT, 'publication differs from its version'); END;
`;

const sqlList = (values: readonly string[]) => values.map(value => `'${value}'`).join(',');

/** Migration backups Mino writes next to the database. Each holds the whole space at that time. */
const MANAGED_BACKUPS = ['.pre-v2'] as const;

const MIGRATIONS: readonly { sql: string; rebuild?: true; backup?: (typeof MANAGED_BACKUPS)[number] }[] = [
  { sql: `ALTER TABLE bots ADD COLUMN instructions TEXT NOT NULL DEFAULT '';
   ALTER TABLE bots ADD COLUMN reply_style TEXT NOT NULL DEFAULT '${DEFAULT_REPLY_STYLE}' CHECK(reply_style IN (${sqlList(REPLY_STYLES)}));
   ALTER TABLE bots ADD COLUMN context_size TEXT NOT NULL DEFAULT '${DEFAULT_CONTEXT_SIZE}' CHECK(context_size IN (${sqlList(CONTEXT_SIZES)}));
   ALTER TABLE attempts ADD COLUMN context_plan TEXT CHECK(context_plan IS NULL OR json_valid(context_plan));
   ALTER TABLE attempts ADD COLUMN usage TEXT CHECK(usage IS NULL OR json_valid(usage));` },
  { rebuild: true, backup: '.pre-v2', sql: `
DROP TRIGGER IF EXISTS work_request_owner;
DROP TRIGGER IF EXISTS work_owner_immutable;
DROP TRIGGER IF EXISTS reply_owner;
CREATE TABLE works_v2(
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id),
  request_message_id TEXT NOT NULL REFERENCES messages(id),
  state TEXT NOT NULL CHECK(state IN ('pending','running','review','done','failed','cancelled')),
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(request_message_id, bot_id)
) STRICT;

INSERT INTO works_v2 SELECT * FROM works ORDER BY rowid;
DROP TABLE works;
ALTER TABLE works_v2 RENAME TO works;
CREATE TABLE message_mentions(
 message_id TEXT NOT NULL REFERENCES messages(id), position INTEGER NOT NULL,
 bot_id TEXT NOT NULL REFERENCES bots(id), start INTEGER NOT NULL, "end" INTEGER NOT NULL,
 PRIMARY KEY(message_id, position), CHECK(start >= 0 AND "end" > start + 1)
) STRICT;
CREATE TRIGGER mentions_insert BEFORE INSERT ON message_mentions
 WHEN NOT EXISTS(SELECT 1 FROM messages WHERE id=NEW.message_id AND role='user')
 OR EXISTS(SELECT 1 FROM works WHERE request_message_id=NEW.message_id)
 BEGIN SELECT RAISE(ABORT, 'mentions must precede works on a user request'); END;
CREATE TRIGGER mentions_immutable BEFORE UPDATE ON message_mentions BEGIN SELECT RAISE(ABORT, 'mentions are immutable'); END;
CREATE TRIGGER mentions_kept BEFORE DELETE ON message_mentions BEGIN SELECT RAISE(ABORT, 'mentions are immutable'); END;
CREATE TRIGGER work_request_owner BEFORE INSERT ON works
 WHEN NOT EXISTS(SELECT 1 FROM messages m WHERE m.id=NEW.request_message_id AND m.role='user' AND (
 (NOT EXISTS(SELECT 1 FROM message_mentions mm WHERE mm.message_id=m.id) AND m.bot_id=NEW.bot_id)
 OR EXISTS(SELECT 1 FROM message_mentions mm WHERE mm.message_id=m.id AND mm.bot_id=NEW.bot_id)))
 BEGIN SELECT RAISE(ABORT, 'work request owner mismatch'); END;
CREATE TRIGGER IF NOT EXISTS work_owner_immutable BEFORE UPDATE OF bot_id, request_message_id ON works
  WHEN NEW.bot_id IS NOT OLD.bot_id OR NEW.request_message_id IS NOT OLD.request_message_id
  BEGIN SELECT RAISE(ABORT, 'work owner is immutable'); END;
CREATE TRIGGER IF NOT EXISTS reply_owner BEFORE INSERT ON messages
  WHEN NEW.role = 'assistant' AND NOT EXISTS (SELECT 1 FROM attempts a JOIN works w ON w.id = a.work_id WHERE a.id = NEW.attempt_id AND w.bot_id = NEW.bot_id)
  BEGIN SELECT RAISE(ABORT, 'reply owner mismatch'); END;
` },
  { sql: `
ALTER TABLE bots ADD COLUMN deleted_at TEXT;
CREATE TABLE purge_target(tbl TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(tbl, id)) STRICT;
CREATE TABLE bot_deletions(bot_id TEXT PRIMARY KEY, work_ids TEXT NOT NULL CHECK(json_valid(work_ids)), deleted_at TEXT NOT NULL) STRICT;
CREATE INDEX messages_by_bot ON messages(bot_id, role);
CREATE INDEX works_by_bot ON works(bot_id);
CREATE INDEX mentions_by_bot ON message_mentions(bot_id);
CREATE INDEX memories_by_bot ON memories(bot_id);
DROP TRIGGER IF EXISTS messages_kept;
DROP TRIGGER IF EXISTS mentions_kept;
DROP TRIGGER IF EXISTS versions_kept;
DROP TRIGGER IF EXISTS proposals_kept;
DROP TRIGGER IF EXISTS decisions_kept;
DROP TRIGGER IF EXISTS publications_kept;
CREATE TRIGGER messages_kept BEFORE DELETE ON messages
  WHEN NOT EXISTS(SELECT 1 FROM purge_target t WHERE t.tbl = 'messages' AND t.id = OLD.id)
  BEGIN SELECT RAISE(ABORT, 'messages are immutable'); END;
CREATE TRIGGER mentions_kept BEFORE DELETE ON message_mentions
  WHEN NOT EXISTS(SELECT 1 FROM purge_target t WHERE t.tbl = 'message_mentions' AND t.id = OLD.message_id || ':' || OLD.position)
  BEGIN SELECT RAISE(ABORT, 'mentions are immutable'); END;
CREATE TRIGGER versions_kept BEFORE DELETE ON versions
  WHEN NOT EXISTS(SELECT 1 FROM purge_target t WHERE t.tbl = 'versions' AND t.id = OLD.id)
  BEGIN SELECT RAISE(ABORT, 'versions are immutable'); END;
CREATE TRIGGER proposals_kept BEFORE DELETE ON proposals
  WHEN NOT EXISTS(SELECT 1 FROM purge_target t WHERE t.tbl = 'proposals' AND t.id = OLD.id)
  BEGIN SELECT RAISE(ABORT, 'proposals are kept'); END;
CREATE TRIGGER decisions_kept BEFORE DELETE ON decisions
  WHEN NOT EXISTS(SELECT 1 FROM purge_target t WHERE t.tbl = 'decisions' AND t.id = OLD.id)
  BEGIN SELECT RAISE(ABORT, 'decisions are immutable'); END;
CREATE TRIGGER publications_kept BEFORE DELETE ON publications
  WHEN NOT EXISTS(SELECT 1 FROM purge_target t WHERE t.tbl = 'publications' AND t.id = OLD.id)
  BEGIN SELECT RAISE(ABORT, 'publications are immutable'); END;
CREATE TRIGGER works_kept BEFORE DELETE ON works
  WHEN NOT EXISTS(SELECT 1 FROM purge_target t WHERE t.tbl = 'works' AND t.id = OLD.id)
  BEGIN SELECT RAISE(ABORT, 'works are kept'); END;
CREATE TRIGGER attempts_kept BEFORE DELETE ON attempts
  WHEN NOT EXISTS(SELECT 1 FROM purge_target t WHERE t.tbl = 'attempts' AND t.id = OLD.id)
  BEGIN SELECT RAISE(ABORT, 'attempts are kept'); END;
CREATE TRIGGER attachments_kept BEFORE DELETE ON attachments
  WHEN NOT EXISTS(SELECT 1 FROM purge_target t WHERE t.tbl = 'attachments' AND t.id = CAST(OLD.seq AS TEXT))
  BEGIN SELECT RAISE(ABORT, 'attachments are kept'); END;
CREATE TRIGGER bots_kept BEFORE DELETE ON bots
  WHEN NOT EXISTS(SELECT 1 FROM purge_target t WHERE t.tbl = 'bots' AND t.id = OLD.id)
  BEGIN SELECT RAISE(ABORT, 'bots are kept'); END;
CREATE TRIGGER bots_deleted_final BEFORE UPDATE ON bots WHEN OLD.deleted_at IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'a deleted bot cannot change'); END;
CREATE TRIGGER messages_live_bot BEFORE INSERT ON messages
  WHEN EXISTS(SELECT 1 FROM bots WHERE id = NEW.bot_id AND deleted_at IS NOT NULL)
  BEGIN SELECT RAISE(ABORT, 'bot is deleted'); END;
CREATE TRIGGER mentions_live_bot BEFORE INSERT ON message_mentions
  WHEN EXISTS(SELECT 1 FROM bots WHERE id = NEW.bot_id AND deleted_at IS NOT NULL)
  BEGIN SELECT RAISE(ABORT, 'bot is deleted'); END;
CREATE TRIGGER memories_live_bot BEFORE INSERT ON memories
  WHEN EXISTS(SELECT 1 FROM bots WHERE id = NEW.bot_id AND deleted_at IS NOT NULL)
  BEGIN SELECT RAISE(ABORT, 'bot is deleted'); END;
CREATE TRIGGER works_live_bot BEFORE INSERT ON works
  WHEN EXISTS(SELECT 1 FROM bots WHERE id = NEW.bot_id AND deleted_at IS NOT NULL)
  BEGIN SELECT RAISE(ABORT, 'bot is deleted'); END;
CREATE TRIGGER works_retired_actor BEFORE UPDATE OF state ON works
  WHEN NEW.state IN ('pending','running') AND EXISTS(SELECT 1 FROM bots WHERE id = NEW.bot_id AND deleted_at IS NOT NULL)
  BEGIN SELECT RAISE(ABORT, 'bot is deleted'); END;
CREATE TRIGGER attempts_live_bot BEFORE INSERT ON attempts
  WHEN EXISTS(SELECT 1 FROM works w JOIN bots b ON b.id = w.bot_id WHERE w.id = NEW.work_id AND b.deleted_at IS NOT NULL)
  BEGIN SELECT RAISE(ABORT, 'bot is deleted'); END;
` },
  { sql: `
CREATE TABLE tasks(
  id TEXT PRIMARY KEY,
  request_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
  author_bot_id TEXT NOT NULL REFERENCES bots(id),
  reviewer_bot_id TEXT REFERENCES bots(id),
  plan TEXT NOT NULL CHECK(plan IN (${sqlList(TASK_PLANS)})),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  continuations INTEGER NOT NULL DEFAULT 0 CHECK(continuations BETWEEN 0 AND ${MAX_CONTINUATIONS}),
  cancelled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((plan = 'relay') = (reviewer_bot_id IS NOT NULL)),
  CHECK(reviewer_bot_id IS NOT author_bot_id)
) STRICT;
CREATE TRIGGER tasks_request_owner BEFORE INSERT ON tasks
  WHEN NOT EXISTS(SELECT 1 FROM messages m WHERE m.id = NEW.request_message_id AND m.role = 'user' AND m.bot_id = NEW.author_bot_id)
    OR EXISTS(SELECT 1 FROM works WHERE request_message_id = NEW.request_message_id)
    OR EXISTS(SELECT 1 FROM message_mentions WHERE message_id = NEW.request_message_id)
  BEGIN SELECT RAISE(ABORT, 'task request owner mismatch'); END;
CREATE TRIGGER tasks_live_bots BEFORE INSERT ON tasks
  WHEN EXISTS(SELECT 1 FROM bots WHERE id IN (NEW.author_bot_id, NEW.reviewer_bot_id) AND deleted_at IS NOT NULL)
  BEGIN SELECT RAISE(ABORT, 'bot is deleted'); END;
CREATE TRIGGER tasks_identity_immutable BEFORE UPDATE ON tasks
  WHEN NEW.id IS NOT OLD.id OR NEW.request_message_id IS NOT OLD.request_message_id OR NEW.author_bot_id IS NOT OLD.author_bot_id
    OR NEW.reviewer_bot_id IS NOT OLD.reviewer_bot_id OR NEW.plan IS NOT OLD.plan OR NEW.created_at IS NOT OLD.created_at
    OR NEW.revision < OLD.revision OR NEW.continuations < OLD.continuations
    OR (OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS NOT OLD.cancelled_at)
  BEGIN SELECT RAISE(ABORT, 'task identity is immutable'); END;
CREATE TRIGGER tasks_kept BEFORE DELETE ON tasks
  WHEN NOT EXISTS(SELECT 1 FROM purge_target t WHERE t.tbl = 'tasks' AND t.id = OLD.id)
  BEGIN SELECT RAISE(ABORT, 'tasks are kept'); END;

ALTER TABLE works ADD COLUMN task_id TEXT REFERENCES tasks(id);
CREATE INDEX works_by_task ON works(task_id) WHERE task_id IS NOT NULL;
DROP TRIGGER IF EXISTS work_owner_immutable;
CREATE TRIGGER work_owner_immutable BEFORE UPDATE OF bot_id, request_message_id, task_id ON works
  WHEN NEW.bot_id IS NOT OLD.bot_id OR NEW.request_message_id IS NOT OLD.request_message_id OR NEW.task_id IS NOT OLD.task_id
  BEGIN SELECT RAISE(ABORT, 'work owner is immutable'); END;
DROP TRIGGER IF EXISTS work_request_owner;
CREATE TRIGGER work_request_owner BEFORE INSERT ON works
 WHEN NOT EXISTS(SELECT 1 FROM messages m WHERE m.id = NEW.request_message_id AND m.role = 'user' AND (
   (NEW.task_id IS NULL AND NOT EXISTS(SELECT 1 FROM tasks t WHERE t.request_message_id = m.id) AND (
     (NOT EXISTS(SELECT 1 FROM message_mentions mm WHERE mm.message_id = m.id) AND m.bot_id = NEW.bot_id)
     OR EXISTS(SELECT 1 FROM message_mentions mm WHERE mm.message_id = m.id AND mm.bot_id = NEW.bot_id)))
   OR EXISTS(SELECT 1 FROM tasks t WHERE t.id = NEW.task_id AND t.request_message_id = m.id
     AND (t.author_bot_id = NEW.bot_id OR t.reviewer_bot_id = NEW.bot_id))))
 BEGIN SELECT RAISE(ABORT, 'work request owner mismatch'); END;

CREATE TABLE task_events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL CHECK(kind IN (${sqlList(TASK_INTENTS)})),
  text TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  CHECK((kind = 'cancel') = (text = ''))
) STRICT;
CREATE INDEX task_events_by_task ON task_events(task_id, seq);
CREATE TRIGGER task_events_immutable BEFORE UPDATE ON task_events BEGIN SELECT RAISE(ABORT, 'task events are immutable'); END;
CREATE TRIGGER task_events_kept BEFORE DELETE ON task_events
  WHEN NOT EXISTS(SELECT 1 FROM purge_target t WHERE t.tbl = 'task_events' AND t.id = OLD.id)
  BEGIN SELECT RAISE(ABORT, 'task events are kept'); END;

CREATE TABLE handoffs(
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  from_attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id),
  to_step TEXT NOT NULL CHECK(to_step IN ('review','synthesis')),
  message_id TEXT NOT NULL REFERENCES messages(id),
  version_id TEXT REFERENCES versions(id),
  created_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER handoffs_source BEFORE INSERT ON handoffs
  WHEN NOT EXISTS(SELECT 1 FROM attempts a JOIN works w ON w.id = a.work_id JOIN messages m ON m.attempt_id = a.id
    WHERE a.id = NEW.from_attempt_id AND a.state = 'succeeded' AND w.task_id = NEW.task_id AND m.id = NEW.message_id)
  BEGIN SELECT RAISE(ABORT, 'a handoff points at a recorded output of its task'); END;
CREATE TRIGGER handoffs_immutable BEFORE UPDATE ON handoffs BEGIN SELECT RAISE(ABORT, 'handoffs are immutable'); END;
CREATE TRIGGER handoffs_kept BEFORE DELETE ON handoffs
  WHEN NOT EXISTS(SELECT 1 FROM purge_target t WHERE t.tbl = 'handoffs' AND t.id = OLD.id)
  BEGIN SELECT RAISE(ABORT, 'handoffs are kept'); END;

DROP INDEX IF EXISTS one_running_attempt;
ALTER TABLE attempts ADD COLUMN lane TEXT NOT NULL DEFAULT 'chat' CHECK(lane IN (${sqlList(LANES)}));
ALTER TABLE attempts ADD COLUMN step TEXT CHECK(step IS NULL OR step IN (${sqlList(TASK_STEPS)}));
ALTER TABLE attempts ADD COLUMN task_revision INTEGER;
ALTER TABLE attempts ADD COLUMN base_version_id TEXT;
ALTER TABLE attempts ADD COLUMN events_through INTEGER;
ALTER TABLE attempts ADD COLUMN handoff_id TEXT;
ALTER TABLE attempts ADD COLUMN continued INTEGER NOT NULL DEFAULT 0 CHECK(continued IN (0, 1));
CREATE UNIQUE INDEX one_running_attempt_per_lane ON attempts(lane) WHERE state = 'running';
CREATE TRIGGER attempts_lane_matches BEFORE INSERT ON attempts
  WHEN NEW.lane IS NOT (SELECT CASE WHEN task_id IS NULL THEN 'chat' ELSE 'doc' END FROM works WHERE id = NEW.work_id)
    OR (NEW.lane = 'doc') <> (NEW.step IS NOT NULL AND NEW.task_revision IS NOT NULL AND NEW.events_through IS NOT NULL)
    OR (NEW.handoff_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM handoffs h JOIN works w ON w.task_id = h.task_id
      WHERE h.id = NEW.handoff_id AND w.id = NEW.work_id AND h.to_step = NEW.step))
    OR (NEW.base_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM versions v JOIN works a ON a.id = v.work_id JOIN works w ON w.task_id = a.task_id
      WHERE v.id = NEW.base_version_id AND w.id = NEW.work_id))
  BEGIN SELECT RAISE(ABORT, 'attempt claim does not match its work'); END;
CREATE TRIGGER attempts_task_budget BEFORE INSERT ON attempts
  WHEN NEW.lane = 'doc' AND (SELECT COUNT(*) FROM attempts a JOIN works w ON w.id = a.work_id
      WHERE w.task_id = (SELECT task_id FROM works WHERE id = NEW.work_id))
    >= (SELECT CASE t.plan WHEN 'solo' THEN ${PLAN_STEPS.solo.length} ELSE ${PLAN_STEPS.relay.length} END + t.continuations
      FROM tasks t WHERE t.id = (SELECT task_id FROM works WHERE id = NEW.work_id))
  BEGIN SELECT RAISE(ABORT, 'task call budget reached'); END;
CREATE TRIGGER attempts_claim_frozen BEFORE UPDATE OF work_id, n, lane, step, task_revision, base_version_id, events_through, handoff_id, continued ON attempts
  WHEN NEW.work_id IS NOT OLD.work_id OR NEW.n IS NOT OLD.n OR NEW.lane IS NOT OLD.lane OR NEW.step IS NOT OLD.step
    OR NEW.task_revision IS NOT OLD.task_revision OR NEW.base_version_id IS NOT OLD.base_version_id
    OR NEW.events_through IS NOT OLD.events_through OR NEW.handoff_id IS NOT OLD.handoff_id OR NEW.continued IS NOT OLD.continued
  BEGIN SELECT RAISE(ABORT, 'an attempt claim is frozen'); END;

CREATE TABLE attempt_progress(
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  item_id TEXT NOT NULL,
  chars INTEGER NOT NULL,
  reply TEXT NOT NULL,
  title TEXT,
  body TEXT,
  readable INTEGER NOT NULL CHECK(readable IN (0, 1)),
  complete INTEGER NOT NULL CHECK(complete IN (0, 1)),
  writes INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(attempt_id, item_id)
) STRICT;
CREATE TRIGGER attempt_progress_doc_lane BEFORE INSERT ON attempt_progress
  WHEN NOT EXISTS(SELECT 1 FROM attempts WHERE id = NEW.attempt_id AND lane = 'doc' AND turn_id IS NOT NULL)
  BEGIN SELECT RAISE(ABORT, 'progress belongs to an accepted document turn'); END;
CREATE TRIGGER attempt_progress_kept BEFORE DELETE ON attempt_progress
  WHEN NOT EXISTS(SELECT 1 FROM purge_target t WHERE t.tbl = 'attempt_progress' AND t.id = OLD.attempt_id || ':' || OLD.item_id)
  BEGIN SELECT RAISE(ABORT, 'progress is kept'); END;

CREATE TABLE doc_proposals(
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id),
  base_version_id TEXT REFERENCES versions(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('base_moved','goal_changed')),
  state TEXT NOT NULL CHECK(state IN ('open','adopted','dismissed')),
  version_id TEXT REFERENCES versions(id),
  created_at TEXT NOT NULL,
  closed_at TEXT,
  CHECK((state = 'adopted') = (version_id IS NOT NULL))
) STRICT;
CREATE TRIGGER doc_proposals_same_work BEFORE INSERT ON doc_proposals
  WHEN NOT EXISTS(SELECT 1 FROM attempts a JOIN works w ON w.id = a.work_id WHERE a.id = NEW.attempt_id AND w.id = NEW.work_id AND w.task_id IS NOT NULL)
  BEGIN SELECT RAISE(ABORT, 'a document proposal comes from a call of its task work'); END;
CREATE TRIGGER doc_proposals_frozen BEFORE UPDATE ON doc_proposals
  WHEN OLD.state <> 'open' OR NEW.id IS NOT OLD.id OR NEW.work_id IS NOT OLD.work_id OR NEW.attempt_id IS NOT OLD.attempt_id
    OR NEW.base_version_id IS NOT OLD.base_version_id OR NEW.title IS NOT OLD.title OR NEW.body IS NOT OLD.body
    OR NEW.reason IS NOT OLD.reason OR NEW.created_at IS NOT OLD.created_at
  BEGIN SELECT RAISE(ABORT, 'a document proposal is frozen'); END;
CREATE TRIGGER doc_proposals_kept BEFORE DELETE ON doc_proposals
  WHEN NOT EXISTS(SELECT 1 FROM purge_target t WHERE t.tbl = 'doc_proposals' AND t.id = OLD.id)
  BEGIN SELECT RAISE(ABORT, 'document proposals are kept'); END;
` },
  { sql: `ALTER TABLE messages ADD COLUMN handoff TEXT CHECK(handoff IS NULL OR json_valid(handoff));` },
  { sql: TOOL_MIGRATION },
  { sql: `
CREATE TABLE origins(
  message_id TEXT PRIMARY KEY REFERENCES messages(id),
  bot_id TEXT NOT NULL REFERENCES bots(id),
  kind TEXT NOT NULL CHECK(kind IN (${sqlList(ORIGIN_KINDS)})),
  occurrence TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(bot_id, kind, occurrence)
) STRICT;
INSERT INTO origins(message_id, bot_id, kind, occurrence, fingerprint, created_at)
  SELECT id, bot_id, 'human', 'legacy:' || id, '', created_at FROM messages WHERE role = 'user';
CREATE TRIGGER origins_request BEFORE INSERT ON origins
  WHEN NOT EXISTS(SELECT 1 FROM messages m WHERE m.id = NEW.message_id AND m.role = 'user' AND m.bot_id = NEW.bot_id)
  BEGIN SELECT RAISE(ABORT, 'an origin belongs to a request of its thread'); END;
CREATE TRIGGER origins_immutable BEFORE UPDATE ON origins BEGIN SELECT RAISE(ABORT, 'origins are immutable'); END;
CREATE TRIGGER origins_kept BEFORE DELETE ON origins
  WHEN NOT EXISTS(SELECT 1 FROM purge_target t WHERE t.tbl = 'origins' AND t.id = OLD.message_id)
  BEGIN SELECT RAISE(ABORT, 'origins are kept'); END;
CREATE TRIGGER works_admitted BEFORE INSERT ON works
  WHEN NOT EXISTS(SELECT 1 FROM origins WHERE message_id = NEW.request_message_id)
  BEGIN SELECT RAISE(ABORT, 'a work is created through admission, with its origin'); END;
` },
  { sql: ADMISSION_MIGRATION },
  { rebuild: true, sql: SOURCE_MIGRATION + TOOL_SOURCE_MIGRATION },
  { sql: CONNECTION_MIGRATION },
  { sql: MEMORY_MIGRATION },
];
const SQLITE_COMPANIONS = ['', '-wal', '-shm', '-journal'] as const;
export const managedBackupPaths = (path: string): string[] =>
  MANAGED_BACKUPS.flatMap(suffix => SQLITE_COMPANIONS.map(companion => path + suffix + companion));

/** The rows erased with a bot, in an order that never leaves a dangling reference between statements. */
const PURGE_ORDER = [
  ...MEMORY_PURGE_ORDER,
  ...TOOL_PURGE_ORDER,
  ['tool_connections', 'id'],
  ['message_sources', 'message_id'],
  ['publications', 'id'],
  ['decisions', 'id'],
  ['proposals', 'id'],
  ['doc_proposals', 'id'],
  ['handoffs', 'id'],
  ['attempt_progress', `attempt_id || ':' || item_id`],
  ['versions', 'id'],
  ['message_mentions', `message_id || ':' || position`],
  ['attachments', 'CAST(seq AS TEXT)'],
  ['messages', 'id', `role = 'assistant'`],
  ['attempts', 'id'],
  ['works', 'id'],
  ['task_events', 'id'],
  ['tasks', 'id'],
  ['origins', 'message_id'],
  ['messages', 'id', `role = 'user'`],
  ['memories', 'id'],
] as const;

const DELETED_BOT_NAME = 'Bot supprimé';
/** Who a request is attributed to in an export. Only `human` is the person. */
const ORIGIN_LABELS: Record<Origin['kind'], string> = { human: 'Vous', routine: 'Routine', event: 'Événement', voice: 'Voix', checkin: 'Bilan' };
/** The coordinator of the space: only its own thread can propose a mission. */
const MINO_ID = 'mino';

function parseJsonColumn<T>(row: Row, key: string, schema: { parse(value: unknown): T }): T | null {
  const value = strOrNull(row, key);
  return value === null ? null : schema.parse(JSON.parse(value));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + stableStringify(v)).join(',') + '}';
  }
  return JSON.stringify(value);
}

function nextUpdatedAt(previous: string, clock: string): string {
  const floor = Date.parse(previous) + 1;
  return Date.parse(clock) < floor ? new Date(floor).toISOString() : clock;
}

function isBusy(error: unknown): boolean {
  if (!(error instanceof Error) || !('errcode' in error)) return false;
  const code = error.errcode;
  return code === 5 || code === 6;
}

const WORK_STATE_VALUES = ['pending', 'running', 'review', 'done', 'failed', 'cancelled'] as const;
const ATTEMPT_STATES = ['running', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const;
const STAGES = ['starting', 'thinking', 'writing'] as const;
const VERSION_SOURCES = ['result', 'edit', 'restore'] as const;
const PROPOSAL_STATES = ['open', 'approved', 'rejected', 'stale'] as const;
const STALE_REASONS = ['edited', 'restored', 'replaced'] as const;

export type StoreOptions = {
  path: string;
  mascots: MascotCatalogue;
  now?: () => string;
  missionContext?: () => NonNullable<ContextSource['missions']>;
  serviceTools?: boolean;
  /** The ceilings of this server. Without it, only the calls Mino already made keep a daily ceiling. */
  policy?: AdmissionPolicy;
  /** Set when the server has a Honcho configuration. Without it no character can get a Honcho project. */
  memory?: { workspacePrefix: string };
};

export function openStore(options: StoreOptions): Store {
  const now = options.now ?? (() => new Date().toISOString());
  const newId = (prefix: string) => `${prefix}_${randomUUID()}`;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(options.path);
    db.exec('PRAGMA locking_mode=EXCLUSIVE');
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA synchronous=FULL');
    db.exec('PRAGMA foreign_keys=ON');
    db.exec('PRAGMA secure_delete=ON');
    db.exec('BEGIN IMMEDIATE');
    db.exec('COMMIT');
  } catch (error) {
    if (isBusy(error)) throw new StoreLockedError();
    throw error;
  }
  const schemaVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  if (schemaVersion > MIGRATIONS.length) { db.close(); throw new Error('Ces données viennent d’une version plus récente de Mino.'); }
  db.exec(SCHEMA);
  MIGRATIONS.slice(schemaVersion).forEach((migration, i) => {
    if (migration.backup) {
      const backup = options.path + migration.backup;
      if (options.path !== ':memory:' && !existsSync(backup)) {
        const previousMask = process.umask(0o077);
        try {
          db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
          chmodSync(backup, 0o600);
        } finally {
          process.umask(previousMask);
        }
      }
    }
    if (migration.rebuild) db.exec('PRAGMA foreign_keys=OFF');
    try {
      db.exec('BEGIN IMMEDIATE');
      db.exec(migration.sql);
      if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Liens SQLite invalides après migration');
      db.exec(`PRAGMA user_version = ${schemaVersion + i + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally {
      db.exec('PRAGMA foreign_keys=ON');
    }
  });

  db.exec('DROP INDEX IF EXISTS one_running_attempt');

  const statements = new Map<string, StatementSync>();
  const sql = (text: string): StatementSync => {
    let statement = statements.get(text);
    if (!statement) {
      statement = db.prepare(text);
      statements.set(text, statement);
    }
    return statement;
  };
  const get = (text: string, ...params: (string | number | null)[]): Row | undefined => sql(text).get(...params);
  const all = (text: string, ...params: (string | number | null)[]): Row[] => sql(text).all(...params);
  const run = (text: string, ...params: (string | number | null)[]): number => Number(sql(text).run(...params).changes);

  const storedRevision = get('SELECT value FROM meta WHERE key = ?', 'view_revision');
  let rev = storedRevision ? Number(str(storedRevision, 'value')) : 0;
  if (!Number.isSafeInteger(rev) || rev < 0) throw new Error('Révision de données invalide');
  rev += 1;
  run('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)', 'view_revision', String(rev));
  const listeners = new Set<() => void>();
  const changed = () => {
    rev += 1;
    run('UPDATE meta SET value = ? WHERE key = ?', String(rev), 'view_revision');
    for (const listener of listeners) listener();
  };

  /** A body that runs inside another one joins its transaction: both commit or roll back together. */
  function transaction<T>(body: () => T): T {
    if (db.isTransaction) return body();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = body();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const shapes = new Map(options.mascots.shapes.map(shape => [shape.id, shape]));

  transaction(() => {
    if (!get('SELECT value FROM meta WHERE key = ?', 'hmac_key')) {
      run('INSERT INTO meta(key, value) VALUES (?, ?)', 'hmac_key', randomBytes(32).toString('hex'));
    }
    if (!get('SELECT value FROM meta WHERE key = ?', 'space_id')) {
      run('INSERT INTO meta(key, value) VALUES (?, ?)', 'space_id', randomUUID());
    }
    if (get('SELECT value FROM meta WHERE key = ?', 'bots_initialized')) return;
    run('INSERT INTO meta(key, value) VALUES (?, ?)', 'bots_initialized', '1');
    const count = int(get('SELECT COUNT(*) AS n FROM bots') ?? { n: 0 }, 'n');
    if (count === 0) {
      SEED_BOTS.forEach((seed, position) => {
        const color = shapes.get(seed.shape)?.defaultColor;
        if (!color) throw new Error(`Forme initiale absente du catalogue: ${seed.shape}`);
        run(
          `INSERT INTO bots(id, position, name, title, shape, color, default_shape, default_color, model, effort, speed, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
          seed.id, position, seed.name, seed.title, seed.shape, color, seed.shape, color, STANDARD_SPEED, now(),
        );
      });
      run('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)', 'active_bot_id', SEED_BOTS[0].id);
    }
  });

  const hmacKey = str(get('SELECT value FROM meta WHERE key = ?', 'hmac_key') ?? {}, 'value');
  const spaceId = str(get('SELECT value FROM meta WHERE key = ?', 'space_id') ?? {}, 'value');
  /** A deletion is fingerprinted by its bot only: the typed name and the counters never reach the journal. */
  const fingerprint = (command: Command) => {
    const { requestId: _requestId, ...payload } = command;
    const signed = payload.type === 'bot.delete' ? { type: payload.type, botId: payload.botId } : payload;
    return createHmac('sha256', hmacKey).update(stableStringify(signed)).digest('hex');
  };

  const sign = (payload: unknown) => createHmac('sha256', hmacKey).update(stableStringify(payload)).digest('hex');
  const admission = createAdmission({ get, all, run, transaction, now, newId }, options.policy ?? DEFAULT_POLICY);
  const sources = createSources({ get, all, run, now });
  const connections = createConnections({ get, all, run, now, newId });

  const kit = { get, all, run, transaction, now, newId, changed, sign };
  const receipts = {
    find(requestId: string) {
      const prior = get('SELECT type, fingerprint, result FROM commands WHERE request_id = ?', requestId);
      return prior ? { type: str(prior, 'type'), fingerprint: str(prior, 'fingerprint'), result: str(prior, 'result') } : null;
    },
    save(requestId: string, type: string, print: string, result: string) {
      run('INSERT INTO commands(request_id, type, fingerprint, result, created_at) VALUES (?, ?, ?, ?, ?)', requestId, type, print, result, now());
    },
  };
  const tools = createToolLedger(kit, receipts, admission, sources, connections, { holds: attemptId => memory.holds(attemptId) });
  const memory = createMemoryLedger(kit, receipts, admission, options.memory ?? null, tools.memoryMoved);
  const HONCHO_OWNS_MEMORY = 'Ce personnage utilise la mémoire Honcho. Ses déclarations se gèrent sur l’ordinateur, dans sa page. Rien n’a été enregistré.';

  const requireBot = (botId: string, message = 'Ce bot n’existe pas ou a été supprimé.'): Row => {
    const bot = get('SELECT * FROM bots WHERE id = ? AND deleted_at IS NULL', botId);
    if (!bot) throw new Refusal('not_found', message);
    return bot;
  };
  const firstLiveBot = (): string | null => {
    const row = get('SELECT id FROM bots WHERE deleted_at IS NULL ORDER BY position LIMIT 1');
    return row ? str(row, 'id') : null;
  };
  const requireWork = (workId: string): Row => {
    const work = get('SELECT * FROM works WHERE id = ?', workId);
    if (!work) throw new Refusal('not_found', 'Ce travail n’existe pas.');
    return work;
  };
  const workState = (work: Row) => oneOf(work, 'state', WORK_STATE_VALUES);
  const setWorkState = (work: Row, to: WorkState, title?: string) => {
    const from = workState(work);
    const allowed = strOrNull(work, 'task_id') === null ? canTransition(from, to) : canTransitionDocument(from, to);
    if (!allowed) {
      throw new Refusal('invalid_transition', 'Ce travail ne peut pas changer d’état de cette façon maintenant.');
    }
    run('UPDATE works SET state = ?, title = ?, updated_at = ? WHERE id = ?', to, title ?? str(work, 'title'), now(), str(work, 'id'));
  };
  const currentVersion = (workId: string): Row | undefined =>
    get('SELECT * FROM versions WHERE work_id = ? ORDER BY n DESC LIMIT 1', workId);
  const staleOpenProposals = (workId: string, reason: 'edited' | 'restored' | 'replaced') => {
    run(`UPDATE proposals SET state = 'stale', stale_reason = ?, closed_at = ? WHERE work_id = ? AND state = 'open'`, reason, now(), workId);
  };
  const STALE_BY_SOURCE = { edit: 'edited', restore: 'restored', result: 'replaced' } as const;
  const insertVersion = (input: {
    workId: string; title: string; body: string; source: 'result' | 'edit' | 'restore';
    restoredFrom: string | null; attemptId: string | null;
  }): { versionId: string; n: number } => {
    const n = int(get('SELECT COALESCE(MAX(n), 0) + 1 AS n FROM versions WHERE work_id = ?', input.workId) ?? {}, 'n');
    const versionId = newId('v');
    run(
      `INSERT INTO versions(id, work_id, n, title, body, source, restored_from, attempt_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      versionId, input.workId, n, input.title, input.body, input.source, input.restoredFrom, input.attemptId, now(),
    );
    staleOpenProposals(input.workId, STALE_BY_SOURCE[input.source]);
    tools.sourceMoved(input.workId);
    return { versionId, n };
  };
  const requireEditable = (work: Row): Row => {
    const state = workState(work);
    if (state !== 'review' && state !== 'done') {
      throw new Refusal('invalid_transition', 'Ce travail n’a pas de livrable modifiable pour le moment.');
    }
    const current = currentVersion(str(work, 'id'));
    if (!current) throw new Refusal('not_found', 'Ce travail n’a pas encore de livrable.');
    return current;
  };
  const requireMemory = (botId: string, memoryId: string): Row => {
    const memory = get('SELECT * FROM memories WHERE id = ? AND bot_id = ?', memoryId, botId);
    if (!memory) throw new Refusal('not_found', 'Ce souvenir n’existe pas pour ce bot.');
    return memory;
  };
  const memoryChars = (botId: string): number =>
    int(get('SELECT COALESCE(SUM(length(text)), 0) AS n FROM memories WHERE bot_id = ?', botId) ?? {}, 'n');
  const requireMemoryRoom = (botId: string, replacedChars: number, text: string) => {
    const before = memoryChars(botId);
    const after = before - replacedChars + Array.from(text).length;
    if (after > LIMITS.memoryTotalChars && after > before) {
      throw new Refusal('limit_reached', `La mémoire de ce bot dépasserait ${LIMITS.memoryTotalChars} caractères. Raccourcissez ou retirez un souvenir.`);
    }
  };
  const requireShape = (shape: string) => {
    if (!shapes.has(shape)) throw new Refusal('unknown_shape', 'Cette forme ne fait pas partie des mascottes.');
  };

  const requireTask = (taskId: string): Row => {
    const task = get('SELECT * FROM tasks WHERE id = ?', taskId);
    if (!task) throw new Refusal('not_found', 'Ce travail documentaire n’existe pas.');
    return task;
  };
  const taskOf = (work: Row): Row | undefined => {
    const taskId = strOrNull(work, 'task_id');
    return taskId === null ? undefined : requireTask(taskId);
  };
  const authorWork = (task: Row): Row => {
    const work = get('SELECT * FROM works WHERE task_id = ? AND bot_id = ?', str(task, 'id'), str(task, 'author_bot_id'));
    if (!work) throw new Error('Travail de l’auteur absent');
    return work;
  };
  const reviewWork = (task: Row): Row | undefined => {
    const reviewer = strOrNull(task, 'reviewer_bot_id');
    return reviewer === null ? undefined : get('SELECT * FROM works WHERE task_id = ? AND bot_id = ?', str(task, 'id'), reviewer);
  };
  const taskAttempts = (taskId: string): Row[] =>
    all('SELECT a.*, w.bot_id FROM attempts a JOIN works w ON w.id = a.work_id WHERE w.task_id = ? ORDER BY a.rowid', taskId);
  const taskEvents = (taskId: string): Row[] => all('SELECT * FROM task_events WHERE task_id = ? ORDER BY seq', taskId);
  const liveBot = (botId: string | null): boolean =>
    botId !== null && get('SELECT 1 AS x FROM bots WHERE id = ? AND deleted_at IS NULL', botId) !== undefined;

  const eventDelivery = (event: Row, attempts: readonly Row[], currentRevision: number): TaskEventView['delivery'] => {
    if (str(event, 'kind') === 'cancel') return { state: 'applied' };
    const seq = int(event, 'seq');
    const isGoal = str(event, 'kind') === 'change_goal';
    const holders = attempts.filter(a => a.events_through !== null && int(a, 'events_through') >= seq
      && (!isGoal || int(a, 'task_revision') === int(event, 'revision')));
    const sent = holders.find(a => a.turn_id !== null);
    if (sent) return { state: 'sent', attemptN: int(sent, 'n'), step: oneOf(sent, 'step', TASK_STEPS), botId: str(sent, 'bot_id'), turnId: str(sent, 'turn_id') };
    const preparing = holders.find(a => str(a, 'state') === 'running');
    if (preparing) return { state: 'prepared', step: oneOf(preparing, 'step', TASK_STEPS), botId: str(preparing, 'bot_id') };
    if (isGoal && int(event, 'revision') < currentRevision) return { state: 'superseded', byRevision: currentRevision };
    return { state: 'waiting', notSent: holders.length };
  };

  const taskFacts = (task: Row, attempts = taskAttempts(str(task, 'id')), events = taskEvents(str(task, 'id'))): TaskFacts => ({
    plan: oneOf(task, 'plan', TASK_PLANS),
    revision: int(task, 'revision'),
    continuations: int(task, 'continuations'),
    cancelled: task.cancelled_at !== null,
    validated: workState(authorWork(task)) === 'done',
    attempts: attempts.map(a => ({ step: oneOf(a, 'step', TASK_STEPS), state: oneOf(a, 'state', ATTEMPT_STATES), taskRevision: int(a, 'task_revision'), continued: int(a, 'continued') === 1 })),
    openProposals: int(get(`SELECT COUNT(*) AS n FROM doc_proposals WHERE work_id = ? AND state = 'open'`, str(authorWork(task), 'id')) ?? {}, 'n'),
    reviewerAvailable: liveBot(strOrNull(task, 'reviewer_bot_id')),
    unsentIntent: events.some(event => eventDelivery(event, attempts, int(task, 'revision')).state === 'waiting'),
  });

  const touchTask = (taskId: string) => run('UPDATE tasks SET updated_at = ? WHERE id = ?', now(), taskId);
  const addEvent = (task: Row, kind: (typeof TASK_INTENTS)[number], text: string, revision: number): string => {
    const eventId = newId('ev');
    run('INSERT INTO task_events(id, task_id, kind, text, revision, created_at) VALUES (?, ?, ?, ?, ?, ?)', eventId, str(task, 'id'), kind, text, revision, now());
    touchTask(str(task, 'id'));
    return eventId;
  };

  const cancelTask = (task: Row): string | null => {
    if (task.cancelled_at !== null) return null;
    const eventId = addEvent(task, 'cancel', '', int(task, 'revision'));
    run('UPDATE tasks SET cancelled_at = ?, updated_at = ? WHERE id = ?', now(), now(), str(task, 'id'));
    run(`UPDATE attempts SET state = 'cancelled', stage = NULL, finished_at = ?
      WHERE state = 'running' AND work_id IN (SELECT id FROM works WHERE task_id = ?)`, now(), str(task, 'id'));
    for (const work of all(`SELECT * FROM works WHERE task_id = ? AND state IN ('pending','running')`, str(task, 'id'))) {
      setWorkState(work, currentVersion(str(work, 'id')) ? 'review' : 'cancelled');
    }
    return eventId;
  };

  const STOP_REASONS: Partial<Record<ReturnType<typeof taskStatus>, string>> = {
    cancelled: 'Ce travail documentaire est annulé.',
    running: 'Un appel de ce travail est déjà en cours.',
    queued: 'Une étape de ce travail est déjà prévue.',
    validated: 'Ce document est validé. Modifiez-le directement ou faites une nouvelle demande.',
    needs_decision: 'Une proposition attend votre choix : adoptez-la ou écartez-la d’abord.',
    reviewer_unavailable: 'Le relecteur choisi a été supprimé : la relecture n’est plus possible. Le document reste modifiable.',
  };

  function taskIntent(command: CommandOf<'task.intent'>): CommandResult {
    const task = requireTask(command.taskId);
    if (task.cancelled_at !== null) throw new Refusal('invalid_transition', STOP_REASONS.cancelled ?? '');
    const intent = command.intent;
    if (intent.kind === 'cancel') {
      const eventId = cancelTask(task);
      return { kind: 'task', taskId: command.taskId, revision: int(task, 'revision'), eventId };
    }
    if (workState(authorWork(task)) === 'done') throw new Refusal('invalid_transition', STOP_REASONS.validated ?? '');
    const previousChars = int(get('SELECT COALESCE(SUM(length(text)), 0) AS n FROM task_events WHERE task_id = ?', command.taskId) ?? {}, 'n');
    if (previousChars + Array.from(intent.text).length > LIMITS.taskIntentTotalChars) {
      throw new Refusal('limit_reached', `Ce travail a atteint sa limite de ${LIMITS.taskIntentTotalChars} caractères de précisions et changements d’objectif. Rien n’a été ajouté. Modifiez le document directement ou ouvrez un nouveau travail.`);
    }
    const revision = int(task, 'revision') + (intent.kind === 'change_goal' ? 1 : 0);
    if (intent.kind === 'change_goal') run('UPDATE tasks SET revision = ? WHERE id = ?', revision, command.taskId);
    const eventId = addEvent(task, intent.kind, intent.text, revision);
    return { kind: 'task', taskId: command.taskId, revision, eventId };
  }

  function continueTask(command: CommandOf<'task.continue'>): CommandResult {
    const task = requireTask(command.taskId);
    const attempts = taskAttempts(command.taskId);
    const facts = taskFacts(task, attempts);
    if (!canContinue(facts)) {
      if (facts.continuations >= MAX_CONTINUATIONS) {
        throw new Refusal('limit_reached', `Ce travail a déjà eu ses ${MAX_CONTINUATIONS} reprises supplémentaires. Modifiez le document vous-même ou faites une nouvelle demande.`);
      }
      throw new Refusal('invalid_transition', STOP_REASONS[taskStatus(facts)] ?? 'Ce travail ne peut pas être relancé maintenant.');
    }
    run('UPDATE tasks SET continuations = continuations + 1, updated_at = ? WHERE id = ?', now(), command.taskId);
    const last = attempts.at(-1);
    if (last && str(last, 'state') !== 'succeeded') {
      const work = requireWork(str(last, 'work_id'));
      if (workState(work) === 'failed' || workState(work) === 'cancelled') setWorkState(work, 'pending');
    }
    return { kind: 'task', taskId: command.taskId, revision: int(task, 'revision'), eventId: null };
  }

  function editTask(command: CommandOf<'task.edit'>): CommandResult {
    const task = requireTask(command.taskId);
    const work = authorWork(task);
    const current = currentVersion(str(work, 'id'));
    if ((current ? str(current, 'id') : null) !== command.baseVersionId) {
      throw new Refusal('stale_base', 'Ce document a changé entre-temps, par exemple dans un autre onglet. Rien n’a été écrasé.');
    }
    const version = insertVersion({ workId: str(work, 'id'), title: command.title, body: command.body, source: 'edit', restoredFrom: null, attemptId: null });
    if (['done', 'failed', 'cancelled'].includes(workState(work))) setWorkState(work, 'review', command.title);
    else run('UPDATE works SET title = ?, updated_at = ? WHERE id = ?', command.title, now(), str(work, 'id'));
    touchTask(command.taskId);
    return { kind: 'version', ...version };
  }

  const requireOpenDocProposal = (proposalId: string): Row => {
    const proposal = get('SELECT * FROM doc_proposals WHERE id = ?', proposalId);
    if (!proposal) throw new Refusal('not_found', 'Cette proposition n’existe pas.');
    if (str(proposal, 'state') !== 'open') throw new Refusal('proposal_closed', 'Cette proposition a déjà été traitée.');
    return proposal;
  };

  function adoptProposal(command: CommandOf<'doc.adopt'>): CommandResult {
    const proposal = requireOpenDocProposal(command.proposalId);
    const work = requireWork(str(proposal, 'work_id'));
    const task = taskOf(work);
    if (!task) throw new Error('Proposition hors tâche');
    const current = currentVersion(str(work, 'id'));
    if ((current ? str(current, 'id') : null) !== command.seenVersionId) {
      throw new Refusal('stale_base', 'Le document a changé depuis l’affichage de cette proposition. Comparez de nouveau avant de l’adopter.');
    }
    if (int(task, 'revision') !== command.seenRevision) {
      throw new Refusal('stale_base', 'L’objectif a changé depuis l’affichage de cette proposition. Comparez de nouveau avant de l’adopter.');
    }
    const version = insertVersion({
      workId: str(work, 'id'), title: str(proposal, 'title'), body: str(proposal, 'body'), source: 'result', restoredFrom: null, attemptId: str(proposal, 'attempt_id'),
    });
    run(`UPDATE doc_proposals SET state = 'adopted', version_id = ?, closed_at = ? WHERE id = ?`, version.versionId, now(), command.proposalId);
    if (['done', 'failed', 'cancelled'].includes(workState(work))) setWorkState(work, 'review', str(proposal, 'title'));
    else run('UPDATE works SET title = ?, updated_at = ? WHERE id = ?', str(proposal, 'title'), now(), str(work, 'id'));
    touchTask(str(task, 'id'));
    return { kind: 'docProposal', proposalId: command.proposalId, state: 'adopted', versionId: version.versionId };
  }

  function execute(command: Exclude<Command, { type: 'storage.purge' }>, context: DispatchContext): CommandResult {
    switch (command.type) {
      case 'message.say': {
        const { type: _type, reviewerBotId, ...message } = command;
        if (reviewerBotId && message.mentions?.length) throw new Refusal('invalid_command', 'Choisissez une invitation dans le fil ou une relecture.');
        const background = !message.mentions?.length && (reviewerBotId !== undefined || requestsBackgroundResult(message.text));
        return sendMessage({ ...message, type: 'message.send', ...(background ? { document: { reviewerBotId: reviewerBotId ?? null } } : {}) });
      }
      case 'message.send': return sendMessage(command);
      case 'bot.delete': return deleteBot(command, context);
      case 'task.intent': return taskIntent(command);
      case 'task.continue': return continueTask(command);
      case 'task.edit': return editTask(command);
      case 'doc.adopt': return adoptProposal(command);
      case 'doc.dismiss': {
        const proposal = requireOpenDocProposal(command.proposalId);
        run(`UPDATE doc_proposals SET state = 'dismissed', closed_at = ? WHERE id = ?`, now(), command.proposalId);
        const task = taskOf(requireWork(str(proposal, 'work_id')));
        if (task) touchTask(str(task, 'id'));
        return { kind: 'docProposal', proposalId: command.proposalId, state: 'dismissed', versionId: null };
      }
      case 'work.cancel': {
        const work = requireWork(command.workId);
        const task = taskOf(work);
        if (task) {
          if (task.cancelled_at === null) cancelTask(task);
          return { kind: 'work', workId: command.workId, state: workState(requireWork(command.workId)) };
        }
        run(`UPDATE attempts SET state = 'cancelled', finished_at = ? WHERE work_id = ? AND state = 'running'`, now(), command.workId);
        const reported = tools.cancelReport(command.workId);
        if (reported) return { kind: 'work', workId: command.workId, state: reported };
        setWorkState(work, 'cancelled');
        return { kind: 'work', workId: command.workId, state: 'cancelled' };
      }
      case 'work.retry': {
        const work = requireWork(command.workId);
        if (taskOf(work)) throw new Refusal('invalid_transition', 'Ce travail documentaire se reprend avec « Reprendre », qui compte dans sa limite d’appels.');
        requireBot(str(work, 'bot_id'), 'Ce bot a été supprimé : ce travail ne peut pas être relancé.');
        if (tools.hasLiveExecution(command.workId)) {
          throw new Refusal('invalid_transition', 'Ce travail a déjà une action de service approuvée. Il ne se relance pas : faites une nouvelle demande.');
        }
        setWorkState(work, 'pending');
        return { kind: 'work', workId: command.workId, state: 'pending' };
      }
      case 'work.accept': {
        const work = requireWork(command.workId);
        if (workState(work) !== 'review') throw new Refusal('invalid_transition', 'Ce travail n’attend pas de validation.');
        const task = taskOf(work);
        const status = task ? taskStatus(taskFacts(task)) : null;
        if (status === 'running' || status === 'queued') {
          throw new Refusal('invalid_transition', 'Ce travail documentaire continue : une étape est en cours ou prévue. Attendez sa fin ou annulez-le.');
        }
        setWorkState(work, 'done');
        return { kind: 'work', workId: command.workId, state: 'done' };
      }
      case 'version.edit': {
        const work = requireWork(command.workId);
        const current = requireEditable(work);
        if (str(current, 'id') !== command.baseVersionId) {
          throw new Refusal('stale_base', 'Ce livrable a changé entre-temps, par exemple dans un autre onglet. Rien n’a été écrasé.');
        }
        const version = insertVersion({ workId: command.workId, title: command.title, body: command.body, source: 'edit', restoredFrom: null, attemptId: null });
        setWorkState(work, 'review', command.title);
        return { kind: 'version', ...version };
      }
      case 'version.restore': {
        const work = requireWork(command.workId);
        const current = requireEditable(work);
        const source = get('SELECT * FROM versions WHERE id = ?', command.versionId);
        if (!source) throw new Refusal('not_found', 'Cette version n’existe pas.');
        if (str(source, 'work_id') !== command.workId) throw new Refusal('cross_work', 'Cette version appartient à un autre travail.');
        if (str(source, 'id') === str(current, 'id')) throw new Refusal('invalid_transition', 'Cette version est déjà la version actuelle.');
        const version = insertVersion({
          workId: command.workId, title: str(source, 'title'), body: str(source, 'body'), source: 'restore',
          restoredFrom: command.versionId, attemptId: null,
        });
        setWorkState(work, 'review', str(source, 'title'));
        return { kind: 'version', ...version };
      }
      case 'publication.propose': return propose(command);
      case 'publication.approve': return approve(command);
      case 'publication.reject': {
        const proposal = requireOpenProposal(command.proposalId);
        const decisionId = newId('d');
        run(`INSERT INTO decisions(id, proposal_id, decision, payload_sha256, created_at) VALUES (?, ?, 'rejected', ?, ?)`,
          decisionId, command.proposalId, str(proposal, 'payload_sha256'), now());
        run(`UPDATE proposals SET state = 'rejected', closed_at = ? WHERE id = ?`, now(), command.proposalId);
        return { kind: 'decision', proposalId: command.proposalId, decision: 'rejected', publicationId: null };
      }
      case 'bot.create': {
        const count = int(get('SELECT COUNT(*) AS n FROM bots WHERE deleted_at IS NULL') ?? {}, 'n');
        if (count >= LIMITS.bots) throw new Refusal('limit_reached', `Votre espace contient déjà ${LIMITS.bots} bots.`);
        requireShape(command.shape);
        const defaultColor = shapes.get(command.shape)?.defaultColor ?? command.color;
        const position = int(get('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM bots') ?? {}, 'n');
        const botId = newId('b');
        run(
          `INSERT INTO bots(id, position, name, title, shape, color, default_shape, default_color, model, effort, speed, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
          botId, position, command.name, command.title, command.shape, command.color, command.shape, defaultColor, STANDARD_SPEED, now(),
        );
        return { kind: 'bot', botId };
      }
      case 'bot.update': {
        const bot = requireBot(command.botId);
        if (command.shape !== undefined) requireShape(command.shape);
        const shape = command.reset ? str(bot, 'default_shape') : command.shape ?? str(bot, 'shape');
        const color = command.reset ? str(bot, 'default_color') : command.color ?? str(bot, 'color');
        run('UPDATE bots SET name = ?, title = ?, shape = ?, color = ?, instructions = ?, reply_style = ?, context_size = ? WHERE id = ?',
          command.name ?? str(bot, 'name'), command.title ?? str(bot, 'title'), shape, color,
          command.instructions ?? str(bot, 'instructions'), command.replyStyle ?? str(bot, 'reply_style'),
          command.contextSize ?? str(bot, 'context_size'), command.botId);
        return { kind: 'bot', botId: command.botId };
      }
      case 'bot.select': {
        requireBot(command.botId);
        run('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)', 'active_bot_id', command.botId);
        return { kind: 'bot', botId: command.botId };
      }
      case 'bot.configure': {
        requireBot(command.botId);
        run('UPDATE bots SET model = ?, effort = ?, speed = ? WHERE id = ?', command.model, command.effort, command.speed, command.botId);
        return { kind: 'bot', botId: command.botId };
      }
      case 'memory.create': {
        requireBot(command.botId);
        if (memory.scoped(command.botId)) throw new Refusal('invalid_transition', HONCHO_OWNS_MEMORY);
        const count = int(get('SELECT COUNT(*) AS n FROM memories WHERE bot_id = ?', command.botId) ?? {}, 'n');
        if (count >= LIMITS.memoriesPerBot) throw new Refusal('limit_reached', 'La mémoire de ce bot est pleine. Retirez un souvenir avant d’en ajouter.');
        requireMemoryRoom(command.botId, 0, command.text);
        const memoryId = newId('mem');
        run('INSERT INTO memories(id, bot_id, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', memoryId, command.botId, command.text, now(), now());
        return { kind: 'memory', memoryId };
      }
      case 'memory.update': {
        const stored = requireMemory(command.botId, command.memoryId);
        if (memory.scoped(command.botId)) throw new Refusal('invalid_transition', HONCHO_OWNS_MEMORY);
        const current = str(stored, 'updated_at');
        if (command.baseUpdatedAt !== undefined && command.baseUpdatedAt !== current) {
          throw new Refusal('stale_base', 'Ce souvenir a changé entre-temps, par exemple dans un autre onglet. Rien n’a été écrasé.');
        }
        requireMemoryRoom(command.botId, Array.from(str(stored, 'text')).length, command.text);
        run('UPDATE memories SET text = ?, updated_at = ? WHERE id = ?', command.text, nextUpdatedAt(current, now()), command.memoryId);
        return { kind: 'memory', memoryId: command.memoryId };
      }
      case 'memory.delete': {
        requireMemory(command.botId, command.memoryId);
        run('DELETE FROM memories WHERE id = ?', command.memoryId);
        run(`UPDATE commands SET fingerprint = '' WHERE type IN ('memory.create', 'memory.update') AND json_extract(result, '$.memoryId') = ?`, command.memoryId);
        run(`UPDATE attempts SET context_sha256 = '' WHERE EXISTS (SELECT 1 FROM json_each(memory_ids) WHERE value = ?)`, command.memoryId);
        return { kind: 'memory', memoryId: command.memoryId };
      }
      default: {
        const _exhaustive: never = command;
        return _exhaustive;
      }
    }
  }

  function sendMessage(command: CommandOf<'message.send'>): CommandResult {
    const { type: _type, requestId, ...content } = command;
    const { messageId, workId, taskId } = admitWork({ ...content, origin: { kind: 'human', requestId } });
    return { kind: 'message', messageId, workId, ...(taskId === null ? {} : { taskId }) };
  }

  type WorkRequest = Omit<CommandOf<'message.send'>, 'type' | 'requestId'> & { origin: Origin };

  /**
   * The only place that creates a request and its works. One occurrence of an origin creates them once per thread bot:
   * asked again with the same content it returns the first work, with another content it is refused.
   */
  function admitWork(request: WorkRequest): { duplicate: boolean; messageId: string; workId: string; taskId: string | null } {
    requireBot(request.botId);
    const mentions = checkMentions(request.text, request.mentions ?? []);
    if (!mentions) throw new Refusal('invalid_command', 'Mentions invalides.');
    const { origin, ...content } = request;
    const occurrence = occurrenceOf(origin);
    const print = sign(content);
    const prior = get('SELECT message_id, fingerprint FROM origins WHERE bot_id = ? AND kind = ? AND occurrence = ?', request.botId, origin.kind, occurrence);
    if (prior) {
      if (str(prior, 'fingerprint') !== print) throw new Refusal('request_conflict', 'Cette occurrence a déjà créé un travail avec un autre contenu. Rien n’a été créé.');
      const first = get('SELECT id, task_id FROM works WHERE request_message_id = ? ORDER BY rowid LIMIT 1', str(prior, 'message_id'));
      if (!first) throw new Error('Travail de l’occurrence absent');
      return { duplicate: true, messageId: str(prior, 'message_id'), workId: str(first, 'id'), taskId: strOrNull(first, 'task_id') };
    }
    const targets = replyTargets(request.botId, mentions);
    targets.forEach(botId => requireBot(botId, 'Un bot mentionné a été supprimé ou n’existe plus. Retirez sa mention avant d’envoyer.'));
    if (request.source) {
      if (mentions.length || request.document) {
        throw new Refusal('invalid_command', 'Une action depuis une version se prépare avec le bot de cette conversation, sans @ ni mode document.');
      }
      if (!options.serviceTools || !tools.grantsFor(request.botId).length) {
        throw new Refusal('invalid_transition', 'Ce personnage n’a aucun service connecté utilisable. Rien n’a été préparé ni envoyé.');
      }
    }
    const reviewerBotId = request.document?.reviewerBotId ?? null;
    if (request.document) {
      if (mentions.length) throw new Refusal('invalid_command', 'Un document est rédigé par le bot de ce fil. Retirez les @ et choisissez le relecteur dans le mode document.');
      if (reviewerBotId === request.botId) throw new Refusal('invalid_command', 'Le relecteur doit être un autre bot que l’auteur.');
      if (reviewerBotId !== null) requireBot(reviewerBotId, 'Le relecteur choisi a été supprimé ou n’existe plus.');
    }
    const messageId = newId('m');
    const workId = newId('w');
    const at = now();
    run(`INSERT INTO messages(id, bot_id, role, text, attempt_id, created_at) VALUES (?, ?, 'user', ?, NULL, ?)`, messageId, request.botId, request.text, at);
    run('INSERT INTO origins(message_id, bot_id, kind, occurrence, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?)', messageId, request.botId, origin.kind, occurrence, print, at);
    if (origin.kind === 'human') memory.observe({ id: messageId, threadBotId: request.botId });
    for (const file of request.attachments) {
      run('INSERT INTO attachments(message_id, name, text) VALUES (?, ?, ?)', messageId, file.name, file.text);
    }
    if (request.source) {
      const refused = sources.freeze(messageId, request.botId, request.source);
      if (refused) throw new Refusal(refused.code, refused.message);
    }
    if (request.document) {
      const taskId = newId('t');
      run(`INSERT INTO tasks(id, request_message_id, author_bot_id, reviewer_bot_id, plan, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        taskId, messageId, request.botId, reviewerBotId, reviewerBotId === null ? 'solo' : 'relay', at, at);
      run(`INSERT INTO works(id, bot_id, request_message_id, state, title, created_at, updated_at, task_id) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
        workId, request.botId, messageId, workTitle(request.text), at, at, taskId);
      return { duplicate: false, messageId, workId, taskId };
    }
    mentions.forEach((span, position) => run('INSERT INTO message_mentions(message_id, position, bot_id, start, "end") VALUES (?, ?, ?, ?, ?)', messageId, position, span.botId, span.start, span.end));
    targets.forEach((botId, index) => run(`INSERT INTO works(id, bot_id, request_message_id, state, title, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
      index === 0 ? workId : newId('w'), botId, messageId, workTitle(request.text), at, at));
    return { duplicate: false, messageId, workId, taskId: null };
  }

  function admit(input: unknown): AdmitOutcome {
    const parsed = AdmitSchema.safeParse(input);
    if (!parsed.success) return { ok: false, code: 'invalid_command', message: 'Cette demande automatique est incomplète ou invalide.' };
    try {
      const admitted = transaction(() => admitWork({ ...parsed.data, attachments: [] }));
      if (!admitted.duplicate) changed();
      return { ok: true, kind: admitted.duplicate ? 'duplicate' : 'admitted', messageId: admitted.messageId, workId: admitted.workId };
    } catch (error) {
      if (error instanceof Refusal) return { ok: false, code: error.code, message: error.message };
      throw error;
    }
  }

  /** Same definition for the confirmation shown to the person and for the check made when the deletion runs. */
  function deletionCounts(botId: string): DeletionCounts {
    const row = get(`WITH req AS (SELECT id FROM messages WHERE role = 'user' AND bot_id = ?1),
      w AS (SELECT id, state FROM works WHERE request_message_id IN (SELECT id FROM req)),
      mine AS (SELECT id, state FROM works WHERE bot_id = ?1 AND request_message_id NOT IN (SELECT id FROM req))
      SELECT
        (SELECT COUNT(*) FROM req) + (SELECT COUNT(*) FROM messages r JOIN attempts a ON a.id = r.attempt_id WHERE a.work_id IN (SELECT id FROM w)) AS messages,
        (SELECT COUNT(*) FROM attachments WHERE message_id IN (SELECT id FROM req)) AS files,
        (SELECT COUNT(*) FROM w WHERE EXISTS (SELECT 1 FROM versions v WHERE v.work_id = w.id)) AS deliverables,
        (SELECT COUNT(*) FROM publications WHERE work_id IN (SELECT id FROM w)) AS publications,
        (SELECT COUNT(*) FROM memories WHERE bot_id = ?1) AS memories,
        (SELECT COUNT(*) FROM w WHERE state = 'pending') + (SELECT COUNT(*) FROM mine WHERE state = 'pending') AS waiting,
        (SELECT COUNT(*) FROM messages r JOIN attempts a ON a.id = r.attempt_id WHERE a.work_id IN (SELECT id FROM mine)) AS keptReplies,
        (SELECT COUNT(*) FROM mine WHERE EXISTS (SELECT 1 FROM versions v WHERE v.work_id = mine.id)) AS keptDeliverables,
        (SELECT COUNT(DISTINCT message_id) FROM message_mentions WHERE bot_id = ?1 AND message_id NOT IN (SELECT id FROM req)) AS keptMentions,
        (SELECT COUNT(*) FROM tasks WHERE request_message_id IN (SELECT id FROM req)) AS tasks`, botId) ?? {};
    return {
      messages: int(row, 'messages'), files: int(row, 'files'), deliverables: int(row, 'deliverables'),
      publications: int(row, 'publications'), memories: int(row, 'memories') + memory.declarationCount(botId), waiting: int(row, 'waiting'),
      keptReplies: int(row, 'keptReplies'), keptDeliverables: int(row, 'keptDeliverables'), keptMentions: int(row, 'keptMentions'),
      tasks: int(row, 'tasks'),
    };
  }

  const target = (tbl: string, select: string, ...params: (string | number)[]) =>
    run(`INSERT OR IGNORE INTO purge_target(tbl, id) ${select}`, ...params);
  const targetsOf = (tbl: string) => `SELECT id FROM purge_target WHERE tbl = '${tbl}'`;

  /**
   * Erases a bot's own thread by its requests, whatever bot answered them, plus its memories and settings.
   * Its guest contributions in other threads stay byte for byte and point at an anonymous witness row.
   * Each erased row is listed in purge_target first: the delete triggers let through only those keys.
   */
  function deleteBot(command: CommandOf<'bot.delete'>, context: DispatchContext): CommandResult {
    if (get('SELECT bot_id FROM bot_deletions WHERE bot_id = ?', command.botId)) {
      return { kind: 'botDeleted', botId: command.botId, nextBotId: firstLiveBot(), erased: false };
    }
    const bot = requireBot(command.botId);
    if (command.confirmName !== str(bot, 'name')) {
      throw new Refusal('stale_base', 'Le nom saisi ne correspond pas exactement au nom du bot. Rien n’a été supprimé.');
    }
    const botId = command.botId;
    run('DELETE FROM purge_target');
    target('messages', `SELECT 'messages', id FROM messages WHERE role = 'user' AND bot_id = ?`, botId);
    target('origins', `SELECT 'origins', id FROM purge_target WHERE tbl = 'messages'`);
    target('works', `SELECT 'works', id FROM works WHERE request_message_id IN (${targetsOf('messages')})`);
    const related = `${targetsOf('works')} UNION SELECT id FROM works WHERE bot_id = ?`;
    const stopping = context.activeWorkIds.some(workId => get(`SELECT 1 AS x FROM (${related}) WHERE id = ?`, botId, workId));
    if (stopping || get(`SELECT 1 AS x FROM attempts WHERE state = 'running' AND work_id IN (${related})`, botId)) {
      throw new Refusal('busy', 'Un appel de ce bot, ou dans sa conversation, est encore en cours ou en train de s’arrêter. Attendez qu’il soit terminé. Rien n’a été supprimé.');
    }
    if (tools.blocksPurge(botId, targetsOf('works'))) {
      throw new Refusal('busy', 'Une action de service approuvée pour ce bot, ou dans sa conversation, est en cours d’envoi. Attendez son reçu. Rien n’a été supprimé.');
    }
    if (memory.blocksPurge(botId)) {
      throw new Refusal('busy', 'Ce personnage a une mémoire Honcho ouverte ou en cours de préparation. Demandez d’abord son oubli dans sa page et attendez la fin des demandes de retrait. Rien n’a été supprimé.');
    }
    if (stableStringify(deletionCounts(botId)) !== stableStringify(command.expected)) {
      throw new Refusal('stale_base', 'Le contenu de ce bot a changé depuis l’ouverture de la confirmation. Vérifiez les nouveaux chiffres. Rien n’a été supprimé.');
    }
    target('attempts', `SELECT 'attempts', id FROM attempts WHERE work_id IN (${targetsOf('works')})`);
    target('messages', `SELECT 'messages', id FROM messages WHERE attempt_id IN (${targetsOf('attempts')})`);
    target('attachments', `SELECT 'attachments', CAST(seq AS TEXT) FROM attachments WHERE message_id IN (${targetsOf('messages')})`);
    target('message_mentions', `SELECT 'message_mentions', message_id || ':' || position FROM message_mentions WHERE message_id IN (${targetsOf('messages')})`);
    target('versions', `SELECT 'versions', id FROM versions WHERE work_id IN (${targetsOf('works')})`);
    target('proposals', `SELECT 'proposals', id FROM proposals WHERE work_id IN (${targetsOf('works')})`);
    target('decisions', `SELECT 'decisions', id FROM decisions WHERE proposal_id IN (${targetsOf('proposals')})`);
    target('publications', `SELECT 'publications', id FROM publications WHERE work_id IN (${targetsOf('works')})`);
    target('memories', `SELECT 'memories', id FROM memories WHERE bot_id = ?`, botId);
    target('tasks', `SELECT 'tasks', id FROM tasks WHERE request_message_id IN (${targetsOf('messages')})`);
    target('task_events', `SELECT 'task_events', id FROM task_events WHERE task_id IN (${targetsOf('tasks')})`);
    target('handoffs', `SELECT 'handoffs', id FROM handoffs WHERE task_id IN (${targetsOf('tasks')})`);
    target('attempt_progress', `SELECT 'attempt_progress', attempt_id || ':' || item_id FROM attempt_progress WHERE attempt_id IN (${targetsOf('attempts')})`);
    target('doc_proposals', `SELECT 'doc_proposals', id FROM doc_proposals WHERE work_id IN (${targetsOf('works')})`);
    target('message_sources', `SELECT 'message_sources', message_id FROM message_sources WHERE message_id IN (${targetsOf('messages')})`);
    target('tool_connections', `SELECT 'tool_connections', id FROM tool_connections WHERE bot_id = ? OR work_id IN (${targetsOf('works')})`, botId);
    tools.markPurge(botId, targetsOf('works'));
    memory.markPurge(botId, targetsOf('attempts'));
    const erasedWorkIds = all(`${targetsOf('works')} ORDER BY id`).map(row => str(row, 'id'));

    run(`UPDATE commands SET fingerprint = '',
        result = CASE WHEN json_extract(result, '$.kind') = 'proposal' THEN json_set(result, '$.payloadSha256', '') ELSE result END
      WHERE type <> 'bot.delete' AND (json_extract(result, '$.botId') = ?1
        OR json_extract(result, '$.messageId') IN (${targetsOf('messages')})
        OR json_extract(result, '$.workId') IN (${targetsOf('works')})
        OR json_extract(result, '$.workId') IN (SELECT id FROM works WHERE bot_id = ?1)
        OR json_extract(result, '$.versionId') IN (${targetsOf('versions')})
        OR json_extract(result, '$.proposalId') IN (${targetsOf('proposals')})
        OR json_extract(result, '$.publicationId') IN (${targetsOf('publications')})
        OR json_extract(result, '$.memoryId') IN (${targetsOf('memories')})
        OR json_extract(result, '$.taskId') IN (${targetsOf('tasks')})
        OR json_extract(result, '$.eventId') IN (${targetsOf('task_events')})
        OR json_extract(result, '$.proposalId') IN (${targetsOf('doc_proposals')}))`, botId);

    const deleted = new Map<string, number>();
    for (const [tbl, key, filter] of PURGE_ORDER) {
      deleted.set(tbl, (deleted.get(tbl) ?? 0) + run(`DELETE FROM ${tbl} WHERE ${key} IN (${targetsOf(tbl)})${filter ? ` AND ${filter}` : ''}`));
    }
    for (const [tbl, n] of deleted) {
      if (n !== int(get('SELECT COUNT(*) AS n FROM purge_target WHERE tbl = ?', tbl) ?? {}, 'n')) throw new Error(`Suppression incomplète: ${tbl}`);
    }

    run(`UPDATE works SET state = 'cancelled', updated_at = ? WHERE bot_id = ? AND state = 'pending'`, now(), botId);
    run(`UPDATE attempts SET memory_ids = '[]', context_sha256 = '', context_plan = NULL
      WHERE work_id IN (SELECT id FROM works WHERE bot_id = ?)`, botId);
    const witnessed = get(`SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM messages WHERE bot_id = ?1)
      OR EXISTS (SELECT 1 FROM works WHERE bot_id = ?1) OR EXISTS (SELECT 1 FROM message_mentions WHERE bot_id = ?1)
      OR EXISTS (SELECT 1 FROM tasks WHERE reviewer_bot_id = ?1 OR author_bot_id = ?1)`, botId);
    if (witnessed) {
      const position = int(get('SELECT MIN(0, COALESCE(MIN(position), 0)) - 1 AS n FROM bots') ?? {}, 'n');
      const at = now();
      run(`UPDATE bots SET deleted_at = ?, position = ?, name = ?, title = '', shape = '', color = '', default_shape = '', default_color = '',
          model = NULL, effort = NULL, speed = ?, instructions = '', reply_style = ?, context_size = ?, created_at = ? WHERE id = ?`,
        at, position, DELETED_BOT_NAME, STANDARD_SPEED, DEFAULT_REPLY_STYLE, DEFAULT_CONTEXT_SIZE, at, botId);
    } else {
      target('bots', `SELECT 'bots', ?`, botId);
      if (run(`DELETE FROM bots WHERE id IN (${targetsOf('bots')})`) !== 1) throw new Error('Suppression incomplète: bots');
    }
    target('bots', `SELECT 'bots', b.id FROM bots b WHERE b.deleted_at IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM messages WHERE bot_id = b.id)
      AND NOT EXISTS(SELECT 1 FROM works WHERE bot_id = b.id)
      AND NOT EXISTS(SELECT 1 FROM message_mentions WHERE bot_id = b.id)
      AND NOT EXISTS(SELECT 1 FROM tasks WHERE reviewer_bot_id = b.id OR author_bot_id = b.id)`);
    const orphanCount = int(get(`SELECT COUNT(*) AS n FROM bots WHERE deleted_at IS NOT NULL AND id IN (${targetsOf('bots')})`) ?? {}, 'n');
    if (run(`DELETE FROM bots WHERE deleted_at IS NOT NULL AND id IN (${targetsOf('bots')})`) !== orphanCount) throw new Error('Suppression incomplète: anciens témoins');
    run('DELETE FROM purge_target');
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Liens SQLite invalides après suppression');

    run('INSERT INTO bot_deletions(bot_id, work_ids, deleted_at) VALUES (?, ?, ?)', botId, JSON.stringify(erasedWorkIds), now());
    const active = get('SELECT value FROM meta WHERE key = ?', 'active_bot_id');
    const nextBotId = active && str(active, 'value') !== botId && get('SELECT 1 AS x FROM bots WHERE id = ? AND deleted_at IS NULL', str(active, 'value'))
      ? str(active, 'value') : firstLiveBot();
    if (nextBotId) run('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)', 'active_bot_id', nextBotId);
    else run('DELETE FROM meta WHERE key = ?', 'active_bot_id');
    run('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)', 'erasure_pending', '1');
    return { kind: 'botDeleted', botId, nextBotId, erased: false };
  }

  const erasurePending = () => get('SELECT value FROM meta WHERE key = ?', 'erasure_pending') !== undefined;
  const checkpoint = () => {
    const result = get('PRAGMA wal_checkpoint(TRUNCATE)') ?? {};
    if (int(result, 'busy') !== 0) throw new Error('Journal SQLite occupé');
  };

  /**
   * Finishes what a committed deletion promised: managed backups gone, free pages rewritten, journal emptied.
   * The marker is removed last, so a failure or a crash leaves it for a retry or for the next start.
   */
  function completeErasure(): boolean {
    if (!erasurePending()) return true;
    try {
      if (options.path !== ':memory:') for (const file of managedBackupPaths(options.path)) rmSync(file, { force: true });
      db.exec('VACUUM');
      checkpoint();
      run('DELETE FROM meta WHERE key = ?', 'erasure_pending');
      changed();
      checkpoint();
      return true;
    } catch {
      // The first checkpoint removed all erased content. A later failure can involve only the completion marker.
      return !erasurePending();
    }
  }

  function propose(command: CommandOf<'publication.propose'>): CommandResult {
    const work = requireWork(command.workId);
    const current = requireEditable(work);
    const version = get('SELECT * FROM versions WHERE id = ?', command.versionId);
    if (!version) throw new Refusal('not_found', 'Cette version n’existe pas.');
    if (str(version, 'work_id') !== command.workId) throw new Refusal('cross_work', 'Cette version appartient à un autre travail.');
    if (str(version, 'id') !== str(current, 'id')) throw new Refusal('not_current', 'Seule la version actuelle peut être proposée.');
    staleOpenProposals(command.workId, 'replaced');
    const payloadSha256 = sha256Hex(publicationPayload({
      workId: command.workId, versionId: command.versionId, title: str(version, 'title'), body: str(version, 'body'),
    }));
    const proposalId = newId('p');
    run(
      `INSERT INTO proposals(id, work_id, version_id, action, destination, payload_sha256, state, stale_reason, created_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', NULL, ?, NULL)`,
      proposalId, command.workId, command.versionId, PUBLISH_ACTION, CARNET_DESTINATION, payloadSha256, now(),
    );
    return { kind: 'proposal', proposalId, payloadSha256 };
  }

  function requireOpenProposal(proposalId: string): Row {
    const proposal = get('SELECT * FROM proposals WHERE id = ?', proposalId);
    if (!proposal) throw new Refusal('not_found', 'Cette proposition n’existe pas.');
    const state = oneOf(proposal, 'state', PROPOSAL_STATES);
    if (state === 'stale') throw new Refusal('proposal_closed', 'Cette proposition est périmée : le contenu a changé depuis. Proposez à nouveau la version actuelle.');
    if (state !== 'open') throw new Refusal('proposal_closed', 'Cette proposition a déjà été décidée.');
    return proposal;
  }

  function approve(command: CommandOf<'publication.approve'>): CommandResult {
    const proposal = requireOpenProposal(command.proposalId);
    const matches = command.action === str(proposal, 'action')
      && command.destination === str(proposal, 'destination')
      && command.versionId === str(proposal, 'version_id')
      && command.payloadSha256 === str(proposal, 'payload_sha256');
    if (!matches) {
      throw new Refusal('approval_mismatch', 'Cette approbation ne correspond pas exactement à la proposition affichée. Rien n’a été publié.');
    }
    const workId = str(proposal, 'work_id');
    const work = requireWork(workId);
    const current = currentVersion(workId);
    const version = get('SELECT * FROM versions WHERE id = ?', str(proposal, 'version_id')) ?? {};
    const recomputed = sha256Hex(publicationPayload({
      workId, versionId: str(version, 'id'), title: str(version, 'title'), body: str(version, 'body'),
    }));
    if (!current || str(current, 'id') !== str(version, 'id') || recomputed !== str(proposal, 'payload_sha256')) {
      throw new Refusal('proposal_closed', 'Cette proposition est périmée : le contenu a changé depuis. Proposez à nouveau la version actuelle.');
    }
    const decisionId = newId('d');
    const publicationId = newId('pub');
    const at = now();
    run(`INSERT INTO decisions(id, proposal_id, decision, payload_sha256, created_at) VALUES (?, ?, 'approved', ?, ?)`,
      decisionId, command.proposalId, recomputed, at);
    run(
      `INSERT INTO publications(id, proposal_id, decision_id, work_id, version_id, destination, title, body, payload_sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      publicationId, command.proposalId, decisionId, workId, str(version, 'id'), CARNET_DESTINATION,
      str(version, 'title'), str(version, 'body'), recomputed, at,
    );
    run(`UPDATE proposals SET state = 'approved', closed_at = ? WHERE id = ?`, at, command.proposalId);
    if (workState(work) === 'review') setWorkState(work, 'done');
    return { kind: 'decision', proposalId: command.proposalId, decision: 'approved', publicationId };
  }

  function dispatch(input: unknown, context: DispatchContext = { activeWorkIds: [] }): DispatchOutcome {
    const parsed = CommandSchema.safeParse(input);
    if (!parsed.success) return { ok: false, code: 'invalid_command', message: 'Cette commande est incomplète ou invalide.' };
    const command = parsed.data;
    if (command.type === 'storage.purge') return { ok: true, replayed: false, result: { kind: 'purge', erased: completeErasure() } };
    try {
      const outcome = transaction((): Extract<DispatchOutcome, { ok: true }> => {
        const print = fingerprint(command);
        const prior = get('SELECT * FROM commands WHERE request_id = ?', command.requestId);
        if (prior) {
          if (str(prior, 'type') !== command.type || str(prior, 'fingerprint') !== print) {
            throw new Refusal('request_conflict', 'Cette identité de commande a déjà servi pour un autre contenu.');
          }
          return { ok: true, replayed: true, result: CommandResultSchema.parse(JSON.parse(str(prior, 'result'))) };
        }
        const result = execute(command, context);
        tools.syncDrafts();
        run('INSERT INTO commands(request_id, type, fingerprint, result, created_at) VALUES (?, ?, ?, ?, ?)',
          command.requestId, command.type, print, JSON.stringify(result), now());
        return { ok: true, replayed: false, result };
      });
      if (!outcome.replayed) changed();
      if (outcome.result.kind === 'botDeleted') return { ...outcome, result: { ...outcome.result, erased: completeErasure() } };
      return outcome;
    } catch (error) {
      if (error instanceof Refusal) return { ok: false, code: error.code, message: error.message };
      throw error;
    }
  }

  /** Set on a request the person did not type, so the turn reads it as a trigger and never as their instruction. */
  const triggerOf = (row: Row): { trigger?: AutomaticOrigin['kind'] } => {
    const kind = oneOf(row, 'origin_kind', ORIGIN_KINDS);
    return kind === 'human' ? {} : { trigger: kind };
  };
  const originKind = (messageId: string): Row => get('SELECT kind AS origin_kind FROM origins WHERE message_id = ?', messageId) ?? {};

  type Traced = { exchange: Exchange; requestMessageId: string; attemptIds: string[] };

  function threadExchanges(threadBotId: string, beforeSeq: number): Traced[] {
    return all(`SELECT request.*, o.kind AS origin_kind FROM messages request JOIN origins o ON o.message_id = request.id
      WHERE request.role='user' AND request.bot_id=? AND request.seq < ?
      AND EXISTS(SELECT 1 FROM works w WHERE w.request_message_id=request.id AND w.state IN ('review','done')) ORDER BY request.seq`,
    threadBotId, beforeSeq).flatMap(request => {
      const requestMessageId = str(request, 'id');
      if (!memory.requestAllowed(requestMessageId)) return [];
      const recorded = all(`SELECT w.id AS work_id, a.id AS attempt_id, reply.text, b.name FROM works w
        JOIN bots b ON b.id=w.bot_id JOIN attempts a ON a.work_id=w.id AND a.state='succeeded'
        JOIN messages reply ON reply.attempt_id=a.id
        WHERE w.request_message_id=? AND w.state IN ('review','done') ORDER BY w.rowid, a.n`, requestMessageId);
      const responses = recorded.filter(row => !memory.workRetired(str(row, 'work_id')));
      if (recorded.length && !responses.length) return [];
      const lastVersion = responses.map(row => currentVersion(str(row, 'work_id'))).findLast(v => v !== undefined);
      return [{
        requestMessageId,
        attemptIds: responses.map(row => str(row, 'attempt_id')),
        exchange: { request: { text: str(request, 'text'), ...triggerOf(request), attachments: all('SELECT name, length(text) AS chars FROM attachments WHERE message_id=? ORDER BY seq', requestMessageId).map(f => ({ name: str(f, 'name'), chars: int(f, 'chars') })) },
          replies: responses.map(row => ({ by: str(row, 'name'), text: str(row, 'text') })),
          deliverable: lastVersion ? { title: str(lastVersion, 'title'), body: str(lastVersion, 'body'), n: int(lastVersion, 'n') } : null },
      }];
    });
  }
  const succeededAttempts = (workId: string): string[] =>
    all(`SELECT id FROM attempts WHERE work_id = ? AND state = 'succeeded'`, workId).map(row => str(row, 'id'));

  const botSource = (bot: Row): ContextSource['bot'] => ({
    name: str(bot, 'name'),
    title: str(bot, 'title'),
    instructions: str(bot, 'instructions'),
    replyStyle: oneOf(bot, 'reply_style', REPLY_STYLES),
    contextSize: oneOf(bot, 'context_size', CONTEXT_SIZES),
  });

  const ONGOING_LABELS: Partial<Record<ReturnType<typeof taskStatus>, string>> = {
    queued: 'en attente de son prochain appel',
    running: 'un appel est en cours',
    stopped: 'interrompu ; la personne peut le reprendre',
    goal_changed: 'objectif modifié ; la personne choisit la suite',
    needs_decision: 'une proposition attend le choix de la personne',
    reviewer_unavailable: 'relecture impossible : le relecteur a été supprimé',
    info_waiting: 'une précision attend une nouvelle passe',
  };

  type Prepared = {
    workId: string; botId: string; bot: Row; memories: { id: string; text: string }[]; source: Omit<ContextSource, 'exchanges'>;
    threadBotId: string; requestMessageId: string; exchanges: Traced[];
    /** Recalled source rows of this turn, and how the recall ended. */
    recalled?: { sourceIds: string[]; category: string | null };
    /** Attempts whose recorded output this text contains outside the past exchanges: a handoff, a prior reply, a document. */
    builtOn?: string[];
  };

  function startAttempt(lane: Lane, prepared: Prepared, frozen: {
    step: TaskStep; taskRevision: number; baseVersionId: string | null; eventsThrough: number; handoffId: string | null; continued: boolean;
  } | null, purpose: Claim['purpose'] = { kind: 'request' }): Claim {
    const toolGrants = options.serviceTools && lane === 'chat' && purpose.kind === 'request' && prepared.source.chosen?.holds !== false
      ? tools.grantsFor(prepared.botId) : [];
    const source: ContextSource = {
      ...prepared.source,
      exchanges: prepared.exchanges.map(traced => traced.exchange),
      ...(lane === 'chat' && prepared.source.orchestrator && options.missionContext ? { missions: options.missionContext() } : {}),
      ...(toolGrants.length ? { tools: { names: toolGrants.map(grant => grant.toolSlug) } } : {}),
      ...(options.serviceTools && lane === 'chat' && purpose.kind === 'request' ? { connections: true as const } : {}),
    };
    const composed = composeContext(source);
    const bot = prepared.bot;
    const choice: BotChoice = { model: strOrNull(bot, 'model'), effort: strOrNull(bot, 'effort'), speed: str(bot, 'speed') };
    const n = int(get('SELECT COALESCE(MAX(n), 0) + 1 AS n FROM attempts WHERE work_id = ?', prepared.workId) ?? {}, 'n');
    const attemptId = newId('a');
    run(
      `INSERT INTO attempts(id, work_id, n, state, stage, requested_model, requested_effort, requested_speed, context_sha256, memory_ids, context_plan, started_at,
         lane, step, task_revision, base_version_id, events_through, handoff_id, continued, tool_execution_id)
       VALUES (?, ?, ?, 'running', 'starting', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      attemptId, prepared.workId, n, choice.model, choice.effort, choice.speed, composed.sha256,
      JSON.stringify(prepared.memories.map(m => m.id)), JSON.stringify(composed.plan), now(),
      lane, frozen?.step ?? null, frozen?.taskRevision ?? null, frozen?.baseVersionId ?? null, frozen?.eventsThrough ?? null,
      frozen?.handoffId ?? null, frozen?.continued ? 1 : 0, purpose.kind === 'receipt' ? purpose.executionId : null,
    );
    const lastDeliverable = prepared.exchanges.findLastIndex(traced => traced.exchange.deliverable !== null);
    const sent = prepared.exchanges.filter((_, index) => index >= composed.plan.exchanges.omitted || index === lastDeliverable);
    memory.freeze(attemptId, {
      threadBotId: prepared.threadBotId,
      recalled: prepared.recalled?.sourceIds ?? [],
      recall: { state: source.recall?.state ?? 'none', category: prepared.recalled?.category ?? null, omitted: source.recall?.omitted ?? 0 },
      requestMessageId: prepared.requestMessageId,
      historyMessageIds: sent.map(traced => traced.requestMessageId),
      replyAttemptIds: [...sent.flatMap(traced => traced.attemptIds), ...(prepared.builtOn ?? [])],
    });
    return { lane, workId: prepared.workId, attemptId, n, botId: prepared.botId, choice, turn: composed.turn, toolGrants, purpose };
  }

  const memoriesOf = (botId: string) => memory.scoped(botId) ? []
    : all('SELECT id, text FROM memories WHERE bot_id = ? ORDER BY seq', botId).map(row => ({ id: str(row, 'id'), text: str(row, 'text') }));
  const requestAttachments = (messageId: string) =>
    all('SELECT name, text FROM attachments WHERE message_id = ? ORDER BY seq', messageId).map(row => ({ name: str(row, 'name'), text: str(row, 'text') }));

  /** The same work answers again, only to report the receipt of its approved action. No new request, no new work. */
  function claimReport(report: ReportClaim): Claim {
    const bot = requireBot(report.botId);
    const memories = memoriesOf(report.botId);
    const claim = startAttempt('chat', {
      workId: report.workId, botId: report.botId, bot, memories,
      threadBotId: report.threadBotId, requestMessageId: report.requestMessageId,
      exchanges: threadExchanges(report.threadBotId, report.requestSeq), builtOn: succeededAttempts(report.workId),
      source: {
        bot: botSource(bot),
        memories,
        request: { text: report.requestText, ...triggerOf(originKind(report.requestMessageId)), attachments: requestAttachments(report.requestMessageId) },
        receipt: report.receipt,
      },
    }, null, { kind: 'receipt', executionId: report.executionId });
    tools.beginReport(report.executionId);
    return claim;
  }

  const peekChat = (): Row | undefined => get(
    `SELECT w.id AS work_id, w.bot_id, m.bot_id AS thread_bot_id, m.seq, m.id AS message_id, m.text, o.kind AS origin_kind
     FROM works w JOIN messages m ON m.id = w.request_message_id JOIN origins o ON o.message_id = m.id
       JOIN bots actor ON actor.id = w.bot_id AND actor.deleted_at IS NULL
     WHERE w.state = 'pending' AND w.task_id IS NULL ORDER BY m.seq, w.rowid LIMIT 1`,
  );
  const candidateOf = (next: Row): Candidate => ({
    workId: str(next, 'work_id'), botId: str(next, 'bot_id'), threadBotId: str(next, 'thread_bot_id'), requestMessageId: str(next, 'message_id'),
  });

  function planRecall(): RecallPlan {
    const plan = transaction((): RecallPlan => {
      if (get(`SELECT id FROM attempts WHERE state = 'running' AND lane = 'chat'`) || tools.nextReport()) return { kind: 'none' };
      const next = peekChat();
      return next ? memory.plan(candidateOf(next)) : { kind: 'none' };
    });
    if (plan.kind === 'unavailable') changed();
    return plan;
  }

  function claimChat(recall: RecallOutcome | undefined): Claim | 'replan' | null {
    const report = tools.nextReport();
    if (report) return claimReport(report);
    const next = peekChat();
    if (!next) return null;
    const workId = str(next, 'work_id');
    const botId = str(next, 'bot_id');
    const recalled = memory.recall(candidateOf(next), recall);
    if (recalled === 'replan') return 'replan';
    const bot = requireBot(botId);
    const memories = memoriesOf(botId);
    const ongoing = all(`SELECT t.* FROM tasks t JOIN messages m ON m.id = t.request_message_id WHERE m.bot_id = ? AND t.cancelled_at IS NULL ORDER BY m.seq`, str(next, 'thread_bot_id'))
      .filter(task => memory.requestAllowed(str(task, 'request_message_id')))
      .flatMap(task => {
        const state = ONGOING_LABELS[taskStatus(taskFacts(task))];
        return state ? [{ title: str(authorWork(task), 'title'), state }] : [];
      });
    const source = sources.of(str(next, 'message_id'));
    const claim = startAttempt('chat', {
      workId, botId, bot, memories,
      threadBotId: str(next, 'thread_bot_id'), requestMessageId: str(next, 'message_id'),
      exchanges: threadExchanges(str(next, 'thread_bot_id'), int(next, 'seq')),
      ...(recalled ? { recalled: { sourceIds: recalled.recalled, category: recalled.category } } : {}),
      ...(source ? { builtOn: succeededAttempts(source.workId) } : {}),
      source: {
        bot: botSource(bot),
        memories,
        ...(recalled ? { recall: recalled.part } : {}),
        request: { text: str(next, 'text'), ...triggerOf(next), attachments: requestAttachments(str(next, 'message_id')) },
        ...(source ? { chosen: { title: source.title, n: source.versionN, headN: source.headN, body: sources.body(source), holds: sources.holds(source) } } : {}),
        ...(ongoing.length ? { ongoing } : {}),
        ...(botId === MINO_ID && str(next, 'thread_bot_id') === MINO_ID ? { orchestrator: true } : {}),
      },
    }, null);
    setWorkState(requireWork(workId), 'running');
    return claim;
  }

  function claimDoc(): Claim | null {
    const tasks = all(`SELECT t.*, m.bot_id AS thread_bot_id, m.seq, m.text FROM tasks t JOIN messages m ON m.id = t.request_message_id
      WHERE t.cancelled_at IS NULL ORDER BY m.seq`);
    for (const task of tasks) {
      const taskId = str(task, 'id');
      const next = nextStep(taskFacts(task));
      if (next.kind !== 'claim') continue;
      const author = authorWork(task);
      const work = stepActor(next.step) === 'author' ? author : reviewWork(task);
      if (!work) continue;
      const botId = str(work, 'bot_id');
      if (!liveBot(botId) || workState(work) === 'done' || workState(work) === 'running') continue;
      const handoff = next.step === 'review' || next.step === 'synthesis'
        ? get('SELECT h.*, w.bot_id AS from_bot_id, m.text AS reply, v.n AS version_n FROM handoffs h JOIN attempts a ON a.id = h.from_attempt_id JOIN works w ON w.id = a.work_id JOIN messages m ON m.id = h.message_id LEFT JOIN versions v ON v.id = h.version_id WHERE h.task_id = ? AND h.to_step = ? ORDER BY h.rowid DESC LIMIT 1', taskId, next.step)
        : undefined;
      if ((next.step === 'review' || next.step === 'synthesis') && !handoff) continue;
      const bot = requireBot(botId);
      const memories = memoriesOf(botId);
      const base = currentVersion(str(author, 'id'));
      const events = taskEvents(taskId);
      const eventsThrough = events.length ? int(events[events.length - 1] ?? {}, 'seq') : 0;
      const goal = events.findLast(event => str(event, 'kind') === 'change_goal');
      const nameOf = (id: string) => liveBot(id) ? str(requireBot(id), 'name') : DELETED_BOT_NAME;
      const reviewer = strOrNull(task, 'reviewer_bot_id');
      const taskSource: TaskSource = {
        step: next.step,
        authorName: nameOf(str(task, 'author_bot_id')),
        reviewerName: reviewer === null ? null : nameOf(reviewer),
        goal: goal ? { text: str(goal, 'text'), revision: int(goal, 'revision') } : null,
        infos: events.filter(event => str(event, 'kind') === 'add_info').map(event => str(event, 'text')),
        document: base ? { title: str(base, 'title'), body: str(base, 'body'), n: int(base, 'n') } : null,
        handoff: handoff ? { fromName: nameOf(str(handoff, 'from_bot_id')), reply: str(handoff, 'reply'), versionN: handoff.version_n === null ? null : int(handoff, 'version_n') } : null,
      };
      if (workState(work) === 'failed' || workState(work) === 'cancelled') setWorkState(work, 'pending');
      setWorkState(requireWork(str(work, 'id')), 'running');
      return startAttempt('doc', {
        workId: str(work, 'id'), botId, bot, memories,
        threadBotId: str(task, 'thread_bot_id'), requestMessageId: str(task, 'request_message_id'),
        exchanges: threadExchanges(str(task, 'thread_bot_id'), int(task, 'seq')),
        builtOn: [...(base ? succeededAttempts(str(author, 'id')) : []), ...(handoff ? [str(handoff, 'from_attempt_id')] : [])],
        source: {
          bot: botSource(bot),
          memories,
          request: { text: str(task, 'text'), attachments: requestAttachments(str(task, 'request_message_id')) },
          task: taskSource,
        },
      }, {
        step: next.step, taskRevision: int(task, 'revision'), baseVersionId: base ? str(base, 'id') : null,
        eventsThrough, handoffId: handoff ? str(handoff, 'id') : null, continued: next.continued,
      });
    }
    return null;
  }

  const CAPABILITY: Record<Lane, string> = { chat: 'codex.chat', doc: 'codex.document' };
  /** The call of a claim, as the admission registry names it. A document call is reserved against the goal revision it was composed for. */
  const targetOf = (claim: Claim, revision: number | null): Target =>
    revision === null ? { kind: 'chat', id: claim.attemptId } : { kind: 'document', id: claim.attemptId, revision: String(revision) };

  /**
   * A claim leaves this function with its ceilings reserved. A refused one is recorded as a call that never left,
   * with the reason, and the search goes on.
   */
  function claimNext(lane: Lane): Claim | null;
  function claimNext(lane: Lane, recall: RecallOutcome): Claim | 'replan' | null;
  function claimNext(lane: Lane, recall?: RecallOutcome): Claim | 'replan' | null {
    let refused = false;
    const claim = transaction((): Claim | 'replan' | null => {
      if (get(`SELECT id FROM attempts WHERE state = 'running' AND lane = ?`, lane)) return null;
      for (;;) {
        const candidate = lane === 'chat' ? claimChat(recall) : claimDoc();
        if (!candidate || candidate === 'replan') return candidate;
        if (!memory.holds(candidate.attemptId).ok) {
          refused = true;
          finishAttempt(candidate, engineFailure('memory_changed'));
          tools.syncDrafts();
          continue;
        }
        const facts = get(`SELECT a.task_revision, w.request_message_id, o.kind AS origin_kind FROM attempts a JOIN works w ON w.id = a.work_id
          JOIN origins o ON o.message_id = w.request_message_id WHERE a.id = ?`, candidate.attemptId) ?? {};
        const reserved = admission.reserve({
          capability: CAPABILITY[lane],
          source: { kind: oneOf(facts, 'origin_kind', ORIGIN_KINDS), id: str(facts, 'request_message_id') },
          target: targetOf(candidate, facts.task_revision === null ? null : int(facts, 'task_revision')),
        });
        if (reserved.ok) return candidate;
        refused = true;
        finishAttempt(candidate, engineFailure('admission_refused', reserved.message));
        tools.syncDrafts();
      }
    });
    if (claim || refused) changed();
    return claim;
  }

  function depart(claim: Claim): Departure {
    return transaction((): Departure => {
      if (!memory.holds(claim.attemptId).ok) return { ok: false, reason: ENGINE_ERRORS.memory_changed };
      const row = get(`SELECT a.state, w.state AS work_state, t.revision FROM attempts a JOIN works w ON w.id = a.work_id
        LEFT JOIN tasks t ON t.id = w.task_id WHERE a.id = ?`, claim.attemptId);
      if (!row || str(row, 'state') !== 'running' || str(row, 'work_state') !== 'running') {
        return { ok: false, reason: 'Cet appel a été arrêté avant son départ. Mino ne l’a pas lancé.' };
      }
      return admission.depart(CAPABILITY[claim.lane], targetOf(claim, row.revision === null ? null : int(row, 'revision')));
    });
  }

  function recordProgress(claim: Claim, text: AgentText): void {
    if (claim.lane !== 'doc' || !memory.holds(claim.attemptId).ok) return;
    if (!get('SELECT 1 AS x FROM attempts WHERE id = ? AND thread_id = ? AND turn_id = ?', claim.attemptId, text.threadId, text.turnId)) return;
    const decoded = decodeReplyProgress(text.text);
    const prior = get('SELECT * FROM attempt_progress WHERE attempt_id = ? AND item_id = ?', claim.attemptId, text.itemId);
    const clip = (value: string | null, max: number) => value === null ? null : Array.from(value).slice(0, max).join('');
    const document = decoded?.deliverable.state === 'object' ? decoded.deliverable : null;
    const reply = decoded ? clip(decoded.reply?.text ?? '', 20_000) ?? '' : prior ? str(prior, 'reply') : '';
    const title = decoded ? clip(document?.title?.text ?? null, LIMITS.versionTitleChars) : prior ? strOrNull(prior, 'title') : null;
    const body = decoded ? clip(document?.body?.text ?? null, LIMITS.versionBodyChars) : prior ? strOrNull(prior, 'body') : null;
    run(`INSERT INTO attempt_progress(attempt_id, item_id, chars, reply, title, body, readable, complete, writes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(attempt_id, item_id) DO UPDATE SET chars = excluded.chars, reply = excluded.reply, title = excluded.title, body = excluded.body,
        readable = excluded.readable, complete = excluded.complete, writes = writes + 1, updated_at = excluded.updated_at`,
    claim.attemptId, text.itemId, text.text.length, reply, title, body, decoded ? 1 : 0, text.final ? 1 : 0, now());
    changed();
  }

  function setStage(claim: Claim, stage: RunStage): void {
    if (run(`UPDATE attempts SET stage = ? WHERE id = ? AND state = 'running' AND (stage IS NOT ?)`, stage, claim.attemptId, stage) > 0) changed();
  }

  function bindThread(claim: Claim, threadId: string): void {
    if (run('UPDATE attempts SET thread_id = ? WHERE id = ? AND thread_id IS NULL', threadId, claim.attemptId) > 0) changed();
  }

  function bindTurn(claim: Claim, turnId: string): void {
    if (run(`UPDATE attempts SET turn_id = ?, usage = CASE WHEN turn_id = ? THEN usage ELSE NULL END
      WHERE id = ? AND thread_id IS NOT NULL AND turn_id IS NOT ?`, turnId, turnId, claim.attemptId, turnId) > 0) changed();
  }

  function observeUsage({ threadId, turnId, usage }: UsageObservation): void {
    const snapshot = JSON.stringify({ ...usage, receivedAt: now() });
    const updated = run(
      `UPDATE attempts SET usage = ?, turn_id = COALESCE(turn_id, ?)
       WHERE thread_id = ? AND (turn_id IS NULL OR turn_id = ?)
         AND (usage IS NULL OR json_extract(usage, '$.total.total') <= ?)`,
      snapshot, turnId, threadId, turnId, usage.total.total,
    );
    if (updated > 0) changed();
  }

  function finishJob(claim: Claim, outcome: EngineOutcome): FinishResult {
    const result = transaction((): FinishResult => {
      admission.settle(CAPABILITY[claim.lane], { kind: claim.lane === 'chat' ? 'chat' : 'document', id: claim.attemptId }, 'ended');
      const finished = finishAttempt(claim, outcome);
      tools.syncDrafts();
      return finished;
    });
    if (result.kind === 'recorded') changed();
    return result;
  }

  function finishAttempt(claim: Claim, given: EngineOutcome): FinishResult {
    const attempt = get('SELECT * FROM attempts WHERE id = ?', claim.attemptId);
    const work = get('SELECT * FROM works WHERE id = ?', claim.workId);
    const latest = get('SELECT id FROM attempts WHERE work_id = ? ORDER BY n DESC LIMIT 1', claim.workId);
    if (!attempt || !work || !latest || !get('SELECT 1 AS x FROM bots WHERE id = ? AND deleted_at IS NULL', str(work, 'bot_id'))
      || str(attempt, 'work_id') !== claim.workId || int(attempt, 'n') !== claim.n
      || str(attempt, 'state') !== 'running' || workState(work) !== 'running' || str(latest, 'id') !== claim.attemptId) {
      return { kind: 'stale' };
    }
    const held = memory.holds(claim.attemptId).ok;
    const outcome = held ? given : engineFailure('memory_changed');
    if (!held) run(`UPDATE attempt_progress SET reply = '', title = NULL, body = NULL, readable = 0 WHERE attempt_id = ?`, claim.attemptId);
    if (work.task_id !== null) return finishTaskStep(claim, outcome, attempt, work);
    /** Set for a turn that reports a receipt: it records a message and nothing else, and the work returns to its earlier state. */
    const reportOf = strOrNull(attempt, 'tool_execution_id');
    const at = now();
    switch (outcome.kind) {
      case 'succeeded': {
        run(
          `UPDATE attempts SET state = 'succeeded', stage = NULL, model = ?, effort = ?, speed = ?, thread_id = COALESCE(thread_id, ?), turn_id = COALESCE(turn_id, ?), finished_at = ? WHERE id = ?`,
          outcome.used.model, outcome.used.effort, outcome.used.speed, outcome.threadId, outcome.turnId, at, claim.attemptId,
        );
        const threadBot = str(get('SELECT bot_id FROM messages WHERE id = ?', str(work, 'request_message_id')) ?? {}, 'bot_id');
        // Only Mino, in its own thread, may propose a mission; any other bot's proposal is dropped.
        const handoff = reportOf === null && str(work, 'bot_id') === MINO_ID && threadBot === MINO_ID ? outcome.reply.handoff ?? null : null;
        run(`INSERT INTO messages(id, bot_id, role, text, attempt_id, created_at, handoff) VALUES (?, ?, 'assistant', ?, ?, ?, ?)`,
          newId('m'), str(work, 'bot_id'), outcome.reply.reply, claim.attemptId, at, handoff ? JSON.stringify(handoff) : null);
        if (options.serviceTools && reportOf === null && outcome.reply.connection) {
          connections.offer({ botId: str(work, 'bot_id'), workId: claim.workId, attemptId: claim.attemptId }, outcome.reply.connection.service);
        }
        if (reportOf !== null) return { kind: 'recorded', state: tools.endReport(reportOf, 'done') };
        const deliverable = outcome.reply.deliverable;
        if (deliverable) {
          insertVersion({ workId: claim.workId, title: deliverable.title, body: deliverable.body, source: 'result', restoredFrom: null, attemptId: claim.attemptId });
          setWorkState(work, 'review', deliverable.title);
          return { kind: 'recorded', state: 'review' };
        }
        setWorkState(work, 'done');
        return { kind: 'recorded', state: 'done' };
      }
      case 'failed': {
        run(`UPDATE attempts SET state = 'failed', stage = NULL, error_code = ?, error_text = ?, finished_at = ? WHERE id = ?`,
          outcome.code, outcome.message, at, claim.attemptId);
        if (reportOf !== null) return { kind: 'recorded', state: tools.endReport(reportOf, 'failed') };
        setWorkState(work, 'failed');
        return { kind: 'recorded', state: 'failed' };
      }
      case 'cancelled': {
        run(`UPDATE attempts SET state = 'cancelled', stage = NULL, finished_at = ? WHERE id = ?`, at, claim.attemptId);
        if (reportOf !== null) return { kind: 'recorded', state: tools.endReport(reportOf, 'suppressed') };
        setWorkState(work, 'cancelled');
        return { kind: 'recorded', state: 'cancelled' };
      }
      default: {
        const _exhaustive: never = outcome;
        return _exhaustive;
      }
    }
  }

  function finishTaskStep(claim: Claim, given: EngineOutcome, attempt: Row, work: Row): FinishResult {
    const task = requireTask(str(work, 'task_id'));
    const step = oneOf(attempt, 'step', TASK_STEPS);
    const shapeOk = given.kind !== 'succeeded' || (given.reply.deliverable === null) === (step === 'review');
    const outcome: EngineOutcome = shapeOk ? given : engineFailure('invalid_output');
    const at = now();
    touchTask(str(task, 'id'));
    if (outcome.kind === 'failed') {
      run(`UPDATE attempts SET state = 'failed', stage = NULL, error_code = ?, error_text = ?, finished_at = ? WHERE id = ?`,
        outcome.code, outcome.message, at, claim.attemptId);
      const state = currentVersion(str(work, 'id')) ? 'review' : 'failed';
      setWorkState(work, state);
      return { kind: 'recorded', state };
    }
    if (outcome.kind === 'cancelled') {
      run(`UPDATE attempts SET state = 'cancelled', stage = NULL, finished_at = ? WHERE id = ?`, at, claim.attemptId);
      const state = currentVersion(str(work, 'id')) ? 'review' : 'cancelled';
      setWorkState(work, state);
      return { kind: 'recorded', state };
    }
    run(
      `UPDATE attempts SET state = 'succeeded', stage = NULL, model = ?, effort = ?, speed = ?, thread_id = COALESCE(thread_id, ?), turn_id = COALESCE(turn_id, ?), finished_at = ? WHERE id = ?`,
      outcome.used.model, outcome.used.effort, outcome.used.speed, outcome.threadId, outcome.turnId, at, claim.attemptId,
    );
    const messageId = newId('m');
    run(`INSERT INTO messages(id, bot_id, role, text, attempt_id, created_at) VALUES (?, ?, 'assistant', ?, ?, ?)`,
      messageId, str(work, 'bot_id'), outcome.reply.reply, claim.attemptId, at);
    const handOff = (toStep: 'review' | 'synthesis', versionId: string | null) => run(
      'INSERT INTO handoffs(id, task_id, from_attempt_id, to_step, message_id, version_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      newId('h'), str(task, 'id'), claim.attemptId, toStep, messageId, versionId, at);
    const deliverable = outcome.reply.deliverable;
    if (deliverable === null) {
      setWorkState(work, 'done');
      handOff('synthesis', strOrNull(attempt, 'base_version_id'));
      return { kind: 'recorded', state: 'done' };
    }
    const current = currentVersion(str(work, 'id'));
    const goalMoved = int(task, 'revision') !== int(attempt, 'task_revision');
    const baseMoved = (current ? str(current, 'id') : null) !== strOrNull(attempt, 'base_version_id');
    let versionId: string | null = null;
    if (goalMoved || baseMoved) {
      run(`INSERT INTO doc_proposals(id, work_id, attempt_id, base_version_id, title, body, reason, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
        newId('dp'), str(work, 'id'), claim.attemptId, strOrNull(attempt, 'base_version_id'), deliverable.title, deliverable.body,
        goalMoved ? 'goal_changed' : 'base_moved', at);
    } else {
      versionId = insertVersion({ workId: claim.workId, title: deliverable.title, body: deliverable.body, source: 'result', restoredFrom: null, attemptId: claim.attemptId }).versionId;
    }
    setWorkState(work, 'review', versionId ? deliverable.title : undefined);
    const reviewer = strOrNull(task, 'reviewer_bot_id');
    const reviewed = taskAttempts(str(task, 'id')).some(a => str(a, 'step') === 'review' && str(a, 'state') === 'succeeded');
    if (reviewer !== null && step !== 'synthesis' && !goalMoved && !reviewed && liveBot(reviewer)) {
      if (!reviewWork(task)) {
        run(`INSERT INTO works(id, bot_id, request_message_id, state, title, created_at, updated_at, task_id) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
          newId('w'), reviewer, str(task, 'request_message_id'), `Relecture · ${str(work, 'title')}`, at, at, str(task, 'id'));
      }
      handOff('review', versionId);
    }
    return { kind: 'recorded', state: 'review' };
  }

  function recoverInterrupted(): number {
    const recovered = transaction(() => {
      const unknownSends = tools.recover() + memory.recover();
      admission.recover();
      const interrupted = run(
        `UPDATE attempts SET state = 'interrupted', stage = NULL, error_code = 'interrupted', error_text = ?, finished_at = ? WHERE state = 'running'`,
        ENGINE_ERRORS.interrupted, now(),
      );
      run(`UPDATE works SET state = 'failed', updated_at = ? WHERE state = 'running'`, now());
      const availableDocuments = run(`UPDATE works SET state = 'review', updated_at = ?
        WHERE task_id IS NOT NULL AND state IN ('failed','cancelled')
          AND EXISTS (SELECT 1 FROM versions v WHERE v.work_id = works.id)`, now());
      tools.syncDrafts();
      return {interrupted,availableDocuments,unknownSends};
    });
    if (recovered.interrupted > 0 || recovered.availableDocuments > 0 || recovered.unknownSends > 0) changed();
    return recovered.interrupted;
  }

  function attemptView(row: Row): AttemptView {
    const model = strOrNull(row, 'model');
    const effort = strOrNull(row, 'effort');
    const speed = strOrNull(row, 'speed');
    return {
      n: int(row, 'n'),
      lane: oneOf(row, 'lane', LANES),
      step: oneOfOrNull(row, 'step', TASK_STEPS),
      state: oneOf(row, 'state', ATTEMPT_STATES),
      stage: oneOfOrNull(row, 'stage', STAGES),
      requested: { model: strOrNull(row, 'requested_model'), effort: strOrNull(row, 'requested_effort'), speed: str(row, 'requested_speed') },
      used: model && effort && speed ? { model, effort, speed } : null,
      threadId: strOrNull(row, 'thread_id'),
      turnId: strOrNull(row, 'turn_id'),
      error: strOrNull(row, 'error_text'),
      startedAt: str(row, 'started_at'),
      finishedAt: strOrNull(row, 'finished_at'),
      plan: parseJsonColumn(row, 'context_plan', ContextPlanSchema),
      usage: parseJsonColumn(row, 'usage', UsageSnapshotSchema),
    };
  }

  function diagnostics(): StoreDiagnostics {
    const works = all(`SELECT w.id, w.request_message_id, w.bot_id, m.bot_id AS thread_bot_id, w.state, w.created_at, w.updated_at
      FROM works w JOIN messages m ON m.id = w.request_message_id ORDER BY w.rowid`).map(row => ({
      id: str(row,'id'), requestMessageId: str(row,'request_message_id'), actorBotId: str(row,'bot_id'), threadBotId: str(row,'thread_bot_id'),
      state: oneOf(row,'state',WORK_STATE_VALUES), createdAt: str(row,'created_at'), updatedAt: str(row,'updated_at'),
    }));
    const attempts = all(`SELECT a.id, a.work_id, a.n, a.state, a.stage, a.thread_id, a.turn_id, a.error_code,
      a.started_at, a.finished_at, a.usage, a.context_plan, a.requested_model, a.requested_effort, a.requested_speed, a.model, a.effort, a.speed, w.bot_id, m.bot_id AS thread_bot_id
      FROM attempts a JOIN works w ON w.id = a.work_id JOIN messages m ON m.id = w.request_message_id ORDER BY a.rowid`).map(row => ({
      id: str(row,'id'), workId: str(row,'work_id'), actorBotId: str(row,'bot_id'), threadBotId: str(row,'thread_bot_id'), n: int(row,'n'),
      state: oneOf(row,'state',ATTEMPT_STATES), stage: oneOfOrNull(row,'stage',STAGES),
      threadId: strOrNull(row,'thread_id'), turnId: strOrNull(row,'turn_id'), errorCode: strOrNull(row,'error_code'),
      requested: {model:strOrNull(row,'requested_model'),effort:strOrNull(row,'requested_effort'),speed:str(row,'requested_speed')},
      used: strOrNull(row,'model') && strOrNull(row,'effort') && strOrNull(row,'speed') ? {model:str(row,'model'),effort:str(row,'effort'),speed:str(row,'speed')} : null,
      plan: parseJsonColumn(row,'context_plan',ContextPlanSchema),
      startedAt: str(row,'started_at'), finishedAt: strOrNull(row,'finished_at'), usage: parseJsonColumn(row,'usage',UsageSnapshotSchema),
    }));
    return {schemaVersion:1,spaceId,rev,works,attempts};
  }

  function view(): StoreView {
    const memoriesByBot = new Map<string, BotView['memories']>();
    for (const row of all('SELECT id, bot_id, text, updated_at FROM memories ORDER BY seq')) {
      const list = memoriesByBot.get(str(row, 'bot_id')) ?? [];
      list.push({ id: str(row, 'id'), text: str(row, 'text'), updatedAt: str(row, 'updated_at') });
      memoriesByBot.set(str(row, 'bot_id'), list);
    }
    const bots: BotView[] = all('SELECT * FROM bots WHERE deleted_at IS NULL ORDER BY position').map(row => ({
      id: str(row, 'id'),
      name: str(row, 'name'),
      title: str(row, 'title'),
      shape: str(row, 'shape'),
      color: str(row, 'color'),
      defaultShape: str(row, 'default_shape'),
      defaultColor: str(row, 'default_color'),
      choice: { model: strOrNull(row, 'model'), effort: strOrNull(row, 'effort'), speed: str(row, 'speed') },
      instructions: str(row, 'instructions'),
      replyStyle: oneOf(row, 'reply_style', REPLY_STYLES),
      contextSize: oneOf(row, 'context_size', CONTEXT_SIZES),
      memories: memoriesByBot.get(str(row, 'id')) ?? [],
      memoryChars: memoryChars(str(row, 'id')),
      memoryScope: memory.scopeView(str(row, 'id')),
      deletion: deletionCounts(str(row, 'id')),
    }));
    const attachmentsByMessage = new Map<string, MessageView['attachments']>();
    for (const row of all('SELECT message_id, name, length(text) AS chars FROM attachments ORDER BY seq')) {
      const list = attachmentsByMessage.get(str(row, 'message_id')) ?? [];
      list.push({ name: str(row, 'name'), chars: int(row, 'chars') });
      attachmentsByMessage.set(str(row, 'message_id'), list);
    }
    const messages: MessageView[] = all(
      `SELECT m.*, COALESCE(request.bot_id, m.bot_id) AS thread_bot_id, COALESCE(a.work_id, w.id) AS work_id, a.model, a.effort, a.speed, a.thread_id, a.turn_id, a.step
       FROM messages m LEFT JOIN attempts a ON a.id = m.attempt_id LEFT JOIN works w ON w.id = (SELECT first.id FROM works first WHERE first.request_message_id=m.id ORDER BY first.rowid LIMIT 1)
       LEFT JOIN works actor ON actor.id=a.work_id LEFT JOIN messages request ON request.id=actor.request_message_id
       ORDER BY m.seq`,
    ).map(row => {
      const model = strOrNull(row, 'model');
      const effort = strOrNull(row, 'effort');
      const speed = strOrNull(row, 'speed');
      const threadId = strOrNull(row, 'thread_id');
      const turnId = strOrNull(row, 'turn_id');
      return {
        id: str(row, 'id'),
        threadBotId: str(row, 'thread_bot_id'),
        mentions: all('SELECT bot_id, start, "end" FROM message_mentions WHERE message_id=? ORDER BY position', str(row, 'id')).map(m => ({ botId: str(m, 'bot_id'), start: int(m, 'start'), end: int(m, 'end') })),
        role: oneOf(row, 'role', ['user', 'assistant'] as const),
        botId: str(row, 'bot_id'),
        text: str(row, 'text'),
        workId: str(row, 'work_id'),
        attachments: attachmentsByMessage.get(str(row, 'id')) ?? [],
        createdAt: str(row, 'created_at'),
        stamp: model && effort && speed && threadId && turnId ? { model, effort, speed, threadId, turnId } : null,
        taskStep: oneOfOrNull(row, 'step', TASK_STEPS),
        handoff: parseJsonColumn(row, 'handoff', HandoffSchema),
      };
    });
    const versionsByWork = new Map<string, VersionView[]>();
    const versionN = new Map<string, number>();
    for (const row of all('SELECT * FROM versions ORDER BY work_id, n')) versionN.set(str(row, 'id'), int(row, 'n'));
    for (const row of all('SELECT * FROM versions ORDER BY work_id, n')) {
      const list = versionsByWork.get(str(row, 'work_id')) ?? [];
      const restoredFrom = strOrNull(row, 'restored_from');
      list.push({
        id: str(row, 'id'),
        n: int(row, 'n'),
        title: str(row, 'title'),
        body: str(row, 'body'),
        source: oneOf(row, 'source', VERSION_SOURCES),
        restoredFromN: restoredFrom ? versionN.get(restoredFrom) ?? null : null,
        createdAt: str(row, 'created_at'),
      });
      versionsByWork.set(str(row, 'work_id'), list);
    }
    const proposalsByWork = new Map<string, ProposalView[]>();
    for (const row of all('SELECT p.*, v.n AS version_n, v.title, v.body FROM proposals p JOIN versions v ON v.id = p.version_id ORDER BY p.seq')) {
      const list = proposalsByWork.get(str(row, 'work_id')) ?? [];
      list.push({
        id: str(row, 'id'),
        versionId: str(row, 'version_id'),
        versionN: int(row, 'version_n'),
        action: PUBLISH_ACTION,
        destination: CARNET_DESTINATION,
        payloadSha256: str(row, 'payload_sha256'),
        state: oneOf(row, 'state', PROPOSAL_STATES),
        staleReason: oneOfOrNull(row, 'stale_reason', STALE_REASONS),
        title: str(row, 'title'),
        body: str(row, 'body'),
        createdAt: str(row, 'created_at'),
      });
      proposalsByWork.set(str(row, 'work_id'), list);
    }
    const latestAttempts = new Map<string, Row>();
    const attemptCounts = new Map<string, number>();
    for (const row of all('SELECT * FROM attempts ORDER BY work_id, n')) {
      latestAttempts.set(str(row, 'work_id'), row);
      attemptCounts.set(str(row, 'work_id'), int(row, 'n'));
    }
    const works: WorkView[] = all('SELECT w.*, m.bot_id AS thread_bot_id FROM works w JOIN messages m ON m.id = w.request_message_id ORDER BY m.seq, w.rowid').map(row => {
      const id = str(row, 'id');
      const attempt = latestAttempts.get(id);
      return {
        id,
        taskId: strOrNull(row, 'task_id'),
        botId: str(row, 'bot_id'),
        threadBotId: str(row, 'thread_bot_id'),
        requestMessageId: str(row, 'request_message_id'),
        state: workState(row),
        title: str(row, 'title'),
        createdAt: str(row, 'created_at'),
        updatedAt: str(row, 'updated_at'),
        attempt: attempt ? attemptView(attempt) : null,
        attempts: attemptCounts.get(id) ?? 0,
        versions: versionsByWork.get(id) ?? [],
        proposals: proposalsByWork.get(id) ?? [],
      };
    });
    const carnet: PublicationView[] = all(
      'SELECT p.*, v.n AS version_n, w.bot_id, m.bot_id AS thread_bot_id FROM publications p JOIN versions v ON v.id = p.version_id JOIN works w ON w.id = p.work_id JOIN messages m ON m.id=w.request_message_id ORDER BY p.seq DESC',
    ).map(row => ({
      id: str(row, 'id'),
      workId: str(row, 'work_id'),
      botId: str(row, 'bot_id'),
      threadBotId: str(row, 'thread_bot_id'),
      versionId: str(row, 'version_id'),
      versionN: int(row, 'version_n'),
      title: str(row, 'title'),
      body: str(row, 'body'),
      payloadSha256: str(row, 'payload_sha256'),
      createdAt: str(row, 'created_at'),
    }));
    const active = get('SELECT value FROM meta WHERE key = ?', 'active_bot_id');
    const activeBotId = active && bots.some(bot => bot.id === str(active, 'value')) ? str(active, 'value') : bots[0]?.id ?? '';
    const retiredBotIds = all('SELECT id FROM bots WHERE deleted_at IS NOT NULL ORDER BY position DESC').map(row => str(row, 'id'));
    const ledger = all('SELECT bot_id, work_ids FROM bot_deletions ORDER BY rowid');
    const purged = {
      botIds: ledger.map(row => str(row, 'bot_id')),
      workIds: ledger.flatMap(row => z.array(z.string()).parse(JSON.parse(str(row, 'work_ids')))),
    };
    const erasure = erasurePending() ? 'incomplete' as const : 'complete' as const;
    return { rev, spaceId, activeBotId, bots, retiredBotIds, purged, erasure, messages, works, tasks: taskViews(versionN), carnet };
  }

  function taskViews(versionN: ReadonlyMap<string, number>): TaskView[] {
    const nOf = (id: string | null) => id === null ? null : versionN.get(id) ?? null;
    return all(`SELECT t.*, m.bot_id AS thread_bot_id, m.text FROM tasks t JOIN messages m ON m.id = t.request_message_id ORDER BY m.seq`).map(task => {
      const id = str(task, 'id');
      const attempts = taskAttempts(id);
      const events = taskEvents(id);
      const facts = taskFacts(task, attempts, events);
      const author = authorWork(task);
      const calls: TaskCallView[] = attempts.map(a => ({
        workId: str(a, 'work_id'), botId: str(a, 'bot_id'), n: int(a, 'n'), step: oneOf(a, 'step', TASK_STEPS),
        state: oneOf(a, 'state', ATTEMPT_STATES), continued: int(a, 'continued') === 1, taskRevision: int(a, 'task_revision'),
        baseVersionN: nOf(strOrNull(a, 'base_version_id')), turnAccepted: a.turn_id !== null, error: strOrNull(a, 'error_text'),
        startedAt: str(a, 'started_at'), finishedAt: strOrNull(a, 'finished_at'),
      }));
      const handoffs: HandoffView[] = all(`SELECT h.*, a.step AS from_step, w.bot_id AS from_bot_id FROM handoffs h
        JOIN attempts a ON a.id = h.from_attempt_id JOIN works w ON w.id = a.work_id WHERE h.task_id = ? ORDER BY h.rowid`, id).map(h => ({
        id: str(h, 'id'), fromBotId: str(h, 'from_bot_id'), fromStep: oneOf(h, 'from_step', TASK_STEPS),
        toStep: oneOf(h, 'to_step', ['review', 'synthesis'] as const), messageId: str(h, 'message_id'), versionN: nOf(strOrNull(h, 'version_id')),
        createdAt: str(h, 'created_at'),
        readBy: attempts.filter(a => a.handoff_id === h.id && a.turn_id !== null).map(a => ({
          botId: str(a, 'bot_id'), step: oneOf(a, 'step', TASK_STEPS), n: int(a, 'n'), state: oneOf(a, 'state', ATTEMPT_STATES), contextSha256: str(a, 'context_sha256'),
        })),
      }));
      const proposals: DocProposalView[] = all(`SELECT p.*, a.step, a.task_revision, w.bot_id FROM doc_proposals p JOIN attempts a ON a.id = p.attempt_id
        JOIN works w ON w.id = p.work_id WHERE p.work_id = ? ORDER BY p.rowid`, str(author, 'id')).map(p => ({
        id: str(p, 'id'), workId: str(p, 'work_id'), botId: str(p, 'bot_id'), step: oneOf(p, 'step', TASK_STEPS),
        baseVersionN: nOf(strOrNull(p, 'base_version_id')), revision: int(p, 'task_revision'), title: str(p, 'title'), body: str(p, 'body'),
        reason: oneOf(p, 'reason', ['base_moved', 'goal_changed'] as const), state: oneOf(p, 'state', ['open', 'adopted', 'dismissed'] as const),
        versionN: nOf(strOrNull(p, 'version_id')), createdAt: str(p, 'created_at'),
      }));
      const last = attempts.at(-1);
      const row = last && str(last, 'state') !== 'succeeded'
        ? get('SELECT * FROM attempt_progress WHERE attempt_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1', str(last, 'id')) : undefined;
      const progress: ProgressView | null = last && row ? {
        botId: str(last, 'bot_id'), step: oneOf(last, 'step', TASK_STEPS), attemptState: oneOf(last, 'state', ATTEMPT_STATES),
        chars: int(row, 'chars'), reply: str(row, 'reply'), title: strOrNull(row, 'title'), body: strOrNull(row, 'body'),
        complete: int(row, 'complete') === 1, readable: int(row, 'readable') === 1, writes: int(row, 'writes'), updatedAt: str(row, 'updated_at'),
      } : null;
      const goal = events.findLast(event => str(event, 'kind') === 'change_goal');
      return {
        id,
        requestMessageId: str(task, 'request_message_id'),
        threadBotId: str(task, 'thread_bot_id'),
        authorBotId: str(task, 'author_bot_id'),
        reviewerBotId: strOrNull(task, 'reviewer_bot_id'),
        plan: facts.plan,
        revision: facts.revision,
        goal: goal ? str(goal, 'text') : str(task, 'text'),
        continuations: facts.continuations,
        maxCalls: maxCalls(facts.plan, facts.continuations),
        status: taskStatus(facts),
        canContinue: canContinue(facts),
        authorWorkId: str(author, 'id'),
        reviewWorkId: (() => { const review = reviewWork(task); return review ? str(review, 'id') : null; })(),
        calls,
        events: events.map(event => ({
          id: str(event, 'id'), kind: oneOf(event, 'kind', TASK_INTENTS), text: str(event, 'text'), revision: int(event, 'revision'),
          createdAt: str(event, 'created_at'), delivery: eventDelivery(event, attempts, int(task, 'revision')),
        })),
        handoffs,
        proposals,
        progress,
        createdAt: str(task, 'created_at'),
        updatedAt: str(task, 'updated_at'),
      };
    });
  }

  completeErasure();

  const fileName = (title: string, suffix: string, extension = '.md') =>
    (title.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 60) || 'mino') + suffix + extension;

  return {
    get rev() { return rev; },
    tools,
    admission,
    memory,
    dispatch,
    admit,
    view,
    diagnostics,
    claimNextJob: () => claimNext('chat'),
    planRecall,
    claimNext,
    recordProgress,
    attemptRunning: attemptId => get(`SELECT 1 AS x FROM attempts WHERE id = ? AND state = 'running'`, attemptId) !== undefined,
    setStage,
    bindThread,
    bindTurn,
    depart,
    observeUsage,
    finishJob,
    recoverInterrupted,
    missionOrigin(messageId) {
      const row = get(`SELECT request.text FROM messages reply JOIN attempts a ON a.id = reply.attempt_id JOIN works w ON w.id = a.work_id
        JOIN messages request ON request.id = w.request_message_id
        WHERE reply.id = ? AND reply.role = 'assistant' AND reply.handoff IS NOT NULL AND reply.bot_id = ? AND request.bot_id = ?`, messageId, MINO_ID, MINO_ID);
      return row ? { text: str(row, 'text') } : null;
    },
    leadCandidate(botId) {
      const bot = get('SELECT id, name, shape, color FROM bots WHERE id = ? AND deleted_at IS NULL', botId);
      return bot ? { botId: str(bot, 'id'), name: str(bot, 'name'), shape: str(bot, 'shape'), color: str(bot, 'color') } : null;
    },
    botChoice(botId) {
      const bot = get('SELECT model, effort, speed FROM bots WHERE id = ? AND deleted_at IS NULL', botId);
      return bot ? { model: strOrNull(bot, 'model'), effort: strOrNull(bot, 'effort'), speed: str(bot, 'speed') } : null;
    },
    versionFile(versionId) {
      const row = get('SELECT title, body, n FROM versions WHERE id = ?', versionId);
      if (!row) return null;
      const html = htmlDocument(str(row, 'body'));
      return html ? { filename: fileName(str(row, 'title'), ` - version ${int(row, 'n')}`, '.html'), content: html, mediaType: 'text/html' }
        : { filename: fileName(str(row, 'title'), ` - version ${int(row, 'n')}`), content: `# ${str(row, 'title')}\n\n${str(row, 'body')}\n`, mediaType: 'text/markdown' };
    },
    messageFile(messageId) {
      const row = get(`SELECT text FROM messages WHERE id = ? AND role = 'assistant'`, messageId);
      const html = row ? htmlDocument(str(row, 'text')) : null;
      return html ? { filename: 'creation-mino.html', content: html, mediaType: 'text/html' } : null;
    },
    publicationFile(publicationId) {
      const row = get('SELECT title, body, payload_sha256, created_at FROM publications WHERE id = ?', publicationId);
      if (!row) return null;
      const html = htmlDocument(str(row, 'body'));
      return html ? { filename: fileName(str(row, 'title'), ' - carnet', '.html'), content: html, mediaType: 'text/html' }
        : { filename: fileName(str(row, 'title'), ' - carnet'),
          content: `# ${str(row, 'title')}\n\n${str(row, 'body')}\n\n---\nPublié dans le Carnet local de Mino le ${str(row, 'created_at')}. Empreinte SHA-256 : ${str(row, 'payload_sha256')}\n`, mediaType: 'text/markdown' };
    },
    exportThread(threadBotId) {
      const snapshot = view();
      const names = new Map([...snapshot.retiredBotIds.map(id => [id, DELETED_BOT_NAME] as const), ...snapshot.bots.map(bot => [bot.id, bot.name] as const)]);
      const lines = ['# Fil Mino', ''];
      const automatic = new Map(all(`SELECT message_id, kind FROM origins WHERE kind <> 'human'`).map(row => [str(row, 'message_id'), oneOf(row, 'kind', ORIGIN_KINDS)] as const));
      for (const message of snapshot.messages.filter(m => !threadBotId || m.threadBotId === threadBotId)) {
        const bot = names.get(message.botId) ?? 'Bot';
        lines.push(message.role === 'user' ? `**${ORIGIN_LABELS[automatic.get(message.id) ?? 'human']} → ${bot}${message.mentions.length ? ' (' + [...new Set(message.mentions.map(m => names.get(m.botId) ?? m.botId))].map(n => '@' + n).join(', ') + ')' : ''}** · ${message.createdAt}` : `**${bot}** · ${message.createdAt}`, '', message.text, '');
      }
      return { filename: 'fil-mino.md', content: lines.join('\n'), mediaType: 'text/markdown' };
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      db.close();
    },
  };
}
