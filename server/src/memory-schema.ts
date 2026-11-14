import { SCOPE_STATES } from './memory-protocol.js';

const sqlList = (values: readonly string[]) => values.map(value => `'${value}'`).join(',');

export const REQUEST_KINDS = ['workspace', 'session', 'ingest', 'read', 'search', 'withdraw'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];
export const RECALL_STATES = ['none', 'used', 'empty', 'unavailable', 'suspended'] as const;
export const EXPORT_STATES = ['pending', 'ingested', 'verified', 'uncertain', 'failed', 'voided'] as const;
export const SOURCE_KINDS = ['message', 'declaration'] as const;
export const SESSIONS = ['declarations', 'conversation'] as const;
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
