-- SQLite schema shipped at commit 0333a0d, before migrations existed. Used to prove upgrades keep data.
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
CREATE UNIQUE INDEX IF NOT EXISTS one_running_attempt ON attempts(state) WHERE state = 'running';
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
CREATE TRIGGER IF NOT EXISTS work_request_owner BEFORE INSERT ON works
  WHEN NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = NEW.request_message_id AND m.bot_id = NEW.bot_id AND m.role = 'user')
  BEGIN SELECT RAISE(ABORT, 'work request owner mismatch'); END;
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
