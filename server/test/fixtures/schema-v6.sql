-- Schema of mino.sqlite at user_version 6, as origin/main 36782f3 creates it on an empty folder. No data.
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE bots(
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
, instructions TEXT NOT NULL DEFAULT '', reply_style TEXT NOT NULL DEFAULT 'concise' CHECK(reply_style IN ('concise','normal','detailed')), context_size TEXT NOT NULL DEFAULT 'short' CHECK(context_size IN ('short','standard','long')), deleted_at TEXT) STRICT;
CREATE TABLE memories(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  bot_id TEXT NOT NULL REFERENCES bots(id),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE attempts(
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
  finished_at TEXT, context_plan TEXT CHECK(context_plan IS NULL OR json_valid(context_plan)), usage TEXT CHECK(usage IS NULL OR json_valid(usage)), lane TEXT NOT NULL DEFAULT 'chat' CHECK(lane IN ('chat','doc')), step TEXT CHECK(step IS NULL OR step IN ('draft','review','synthesis','revise')), task_revision INTEGER, base_version_id TEXT, events_through INTEGER, handoff_id TEXT, continued INTEGER NOT NULL DEFAULT 0 CHECK(continued IN (0, 1)), tool_execution_id TEXT,
  UNIQUE(work_id, n)
) STRICT;
CREATE TABLE messages(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  bot_id TEXT NOT NULL REFERENCES bots(id),
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  text TEXT NOT NULL,
  attempt_id TEXT UNIQUE REFERENCES attempts(id),
  created_at TEXT NOT NULL, handoff TEXT CHECK(handoff IS NULL OR json_valid(handoff)),
  CHECK((role = 'assistant') = (attempt_id IS NOT NULL))
) STRICT;
CREATE TABLE attachments(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL REFERENCES messages(id),
  name TEXT NOT NULL,
  text TEXT NOT NULL
) STRICT;
CREATE TABLE versions(
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
CREATE TABLE proposals(
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
CREATE UNIQUE INDEX one_open_proposal ON proposals(work_id) WHERE state = 'open';
CREATE TABLE decisions(
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals(id),
  decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')),
  payload_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE publications(
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
CREATE TABLE commands(
  request_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER messages_immutable BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'messages are immutable'); END;
CREATE TRIGGER versions_immutable BEFORE UPDATE ON versions BEGIN SELECT RAISE(ABORT, 'versions are immutable'); END;
CREATE TRIGGER versions_restore_same_work BEFORE INSERT ON versions
  WHEN NEW.restored_from IS NOT NULL AND (SELECT work_id FROM versions WHERE id = NEW.restored_from) IS NOT NEW.work_id
  BEGIN SELECT RAISE(ABORT, 'restore crosses works'); END;
CREATE TRIGGER proposals_same_work BEFORE INSERT ON proposals
  WHEN (SELECT work_id FROM versions WHERE id = NEW.version_id) IS NOT NEW.work_id
  BEGIN SELECT RAISE(ABORT, 'proposal crosses works'); END;
CREATE TRIGGER proposals_final BEFORE UPDATE ON proposals WHEN OLD.state <> 'open'
  BEGIN SELECT RAISE(ABORT, 'proposal is closed'); END;
CREATE TRIGGER proposals_payload_immutable BEFORE UPDATE ON proposals
  WHEN NEW.id IS NOT OLD.id OR NEW.work_id IS NOT OLD.work_id OR NEW.version_id IS NOT OLD.version_id
    OR NEW.action IS NOT OLD.action OR NEW.destination IS NOT OLD.destination
    OR NEW.payload_sha256 IS NOT OLD.payload_sha256 OR NEW.created_at IS NOT OLD.created_at
  BEGIN SELECT RAISE(ABORT, 'proposal payload is immutable'); END;
CREATE TRIGGER decisions_immutable BEFORE UPDATE ON decisions BEGIN SELECT RAISE(ABORT, 'decisions are immutable'); END;
CREATE TRIGGER publications_immutable BEFORE UPDATE ON publications BEGIN SELECT RAISE(ABORT, 'publications are immutable'); END;
CREATE TRIGGER publications_match_version BEFORE INSERT ON publications
  WHEN NOT EXISTS (SELECT 1 FROM versions v WHERE v.id = NEW.version_id AND v.work_id = NEW.work_id AND v.title = NEW.title AND v.body = NEW.body)
  BEGIN SELECT RAISE(ABORT, 'publication differs from its version'); END;
CREATE TABLE "works"(
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id),
  request_message_id TEXT NOT NULL REFERENCES messages(id),
  state TEXT NOT NULL CHECK(state IN ('pending','running','review','done','failed','cancelled')),
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, task_id TEXT REFERENCES tasks(id),
  UNIQUE(request_message_id, bot_id)
) STRICT;
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
CREATE TRIGGER reply_owner BEFORE INSERT ON messages
  WHEN NEW.role = 'assistant' AND NOT EXISTS (SELECT 1 FROM attempts a JOIN works w ON w.id = a.work_id WHERE a.id = NEW.attempt_id AND w.bot_id = NEW.bot_id)
  BEGIN SELECT RAISE(ABORT, 'reply owner mismatch'); END;
CREATE TABLE purge_target(tbl TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(tbl, id)) STRICT;
CREATE TABLE bot_deletions(bot_id TEXT PRIMARY KEY, work_ids TEXT NOT NULL CHECK(json_valid(work_ids)), deleted_at TEXT NOT NULL) STRICT;
CREATE INDEX messages_by_bot ON messages(bot_id, role);
CREATE INDEX works_by_bot ON works(bot_id);
CREATE INDEX mentions_by_bot ON message_mentions(bot_id);
CREATE INDEX memories_by_bot ON memories(bot_id);
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
CREATE TABLE tasks(
  id TEXT PRIMARY KEY,
  request_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
  author_bot_id TEXT NOT NULL REFERENCES bots(id),
  reviewer_bot_id TEXT REFERENCES bots(id),
  plan TEXT NOT NULL CHECK(plan IN ('solo','relay')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  continuations INTEGER NOT NULL DEFAULT 0 CHECK(continuations BETWEEN 0 AND 2),
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
CREATE INDEX works_by_task ON works(task_id) WHERE task_id IS NOT NULL;
CREATE TRIGGER work_owner_immutable BEFORE UPDATE OF bot_id, request_message_id, task_id ON works
  WHEN NEW.bot_id IS NOT OLD.bot_id OR NEW.request_message_id IS NOT OLD.request_message_id OR NEW.task_id IS NOT OLD.task_id
  BEGIN SELECT RAISE(ABORT, 'work owner is immutable'); END;
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
  kind TEXT NOT NULL CHECK(kind IN ('add_info','change_goal','cancel')),
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
    >= (SELECT CASE t.plan WHEN 'solo' THEN 1 ELSE 3 END + t.continuations
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
PRAGMA user_version=6;
