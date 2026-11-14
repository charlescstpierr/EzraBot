import { oneOf, str, type Row } from './sql-rows.js';
import { isMetaTool, type ConnectionView } from './tools-protocol.js';

type SqlValue = string | number | null;

export type ConnectionKit = {
  get(text: string, ...params: SqlValue[]): Row | undefined;
  all(text: string, ...params: SqlValue[]): Row[];
  run(text: string, ...params: SqlValue[]): number;
  now(): string;
  newId(prefix: string): string;
};

export type Connections = {
  /** Records the service a successful chat reply proposed to connect. One request per turn: a repeat changes nothing. */
  offer(turn: { botId: string; workId: string; attemptId: string }, service: string): void;
  /** The request of a live bot, or null. */
  of(id: string): ConnectionView | null;
  /** Oldest first. */
  list(): ConnectionView[];
  /** The link becomes the one this request shows. A request erased meanwhile is left alone. */
  attach(id: string, linkId: string): void;
};

/**
 * A bot's proposal to connect a service. The row keeps what the bot named and the link the person started from the card.
 * It holds no account state: the link carries it, and only a provider reading changes a link.
 */
export const CONNECTION_MIGRATION = `
CREATE TABLE tool_connections(
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id),
  work_id TEXT NOT NULL REFERENCES works(id),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id),
  toolkit TEXT NOT NULL CHECK(length(toolkit) BETWEEN 1 AND 63 AND toolkit NOT GLOB '*[^a-z0-9_-]*' AND substr(toolkit, 1, 9) IS NOT 'composio_'),
  link_id TEXT REFERENCES tool_links(id),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX tool_connections_by_work ON tool_connections(work_id);
CREATE TRIGGER tool_connections_source BEFORE INSERT ON tool_connections
  WHEN NEW.link_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM attempts a JOIN works w ON w.id = a.work_id JOIN messages m ON m.attempt_id = a.id
    WHERE a.id = NEW.attempt_id AND a.state = 'succeeded' AND a.lane = 'chat' AND a.tool_execution_id IS NULL
      AND w.id = NEW.work_id AND w.bot_id = NEW.bot_id AND w.task_id IS NULL AND m.role = 'assistant')
  BEGIN SELECT RAISE(ABORT, 'a connection request comes from the recorded reply of a chat turn, without a link'); END;
CREATE TRIGGER tool_connections_frozen BEFORE UPDATE ON tool_connections
  WHEN NEW.id IS NOT OLD.id OR NEW.bot_id IS NOT OLD.bot_id OR NEW.work_id IS NOT OLD.work_id OR NEW.attempt_id IS NOT OLD.attempt_id
    OR NEW.toolkit IS NOT OLD.toolkit OR NEW.created_at IS NOT OLD.created_at
    OR NOT EXISTS(SELECT 1 FROM tool_links l WHERE l.id = NEW.link_id AND l.toolkit = NEW.toolkit)
  BEGIN SELECT RAISE(ABORT, 'a connection request only takes a link of its own service'); END;
CREATE TRIGGER tool_connections_kept BEFORE DELETE ON tool_connections
  WHEN NOT EXISTS(SELECT 1 FROM purge_target t WHERE t.tbl = 'tool_connections' AND t.id = OLD.id)
  BEGIN SELECT RAISE(ABORT, 'connection requests are kept'); END;
`;

const TOOLKIT = /^[a-z0-9_-]{1,63}$/;

/** The service name a bot wrote, as a catalogue identifier, or null when it cannot be one. It is compared, never trusted. */
export function toolkitOf(service: string): string | null {
  const toolkit = service.trim().toLowerCase();
  return TOOLKIT.test(toolkit) && !isMetaTool(toolkit) ? toolkit : null;
}

export function createConnections(kit: ConnectionKit): Connections {
  const { get, run } = kit;
  const VIEW = `SELECT c.id, c.bot_id, c.toolkit, c.created_at, reply.id AS message_id,
      l.id AS link_id, l.account_id, l.state AS link_state, l.created_at AS link_created_at
    FROM tool_connections c JOIN bots b ON b.id = c.bot_id AND b.deleted_at IS NULL
      JOIN messages reply ON reply.attempt_id = c.attempt_id LEFT JOIN tool_links l ON l.id = c.link_id`;
  const viewOf = (row: Row): ConnectionView => ({
    id: str(row, 'id'), botId: str(row, 'bot_id'), messageId: str(row, 'message_id'), toolkit: str(row, 'toolkit'), createdAt: str(row, 'created_at'),
    link: row.link_id === null ? null : {
      id: str(row, 'link_id'), toolkit: str(row, 'toolkit'), accountId: str(row, 'account_id'),
      state: oneOf(row, 'link_state', ['pending', 'active', 'failed'] as const), createdAt: str(row, 'link_created_at'),
    },
  });

  return {
    offer(turn, service) {
      const toolkit = toolkitOf(service);
      if (toolkit === null) return;
      run(`INSERT INTO tool_connections(id, bot_id, work_id, attempt_id, toolkit, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(attempt_id) DO NOTHING`,
        kit.newId('tc'), turn.botId, turn.workId, turn.attemptId, toolkit, kit.now());
    },
    of(id) {
      const row = get(`${VIEW} WHERE c.id = ?`, id);
      return row ? viewOf(row) : null;
    },
    list() {
      return kit.all(`${VIEW} ORDER BY c.rowid`).map(viewOf);
    },
    attach(id, linkId) {
      run('UPDATE tool_connections SET link_id = ? WHERE id = ?', linkId, id);
    },
  };
}
