import { sha256Hex } from './domain.js';
import { int, str, type Row } from './sql-rows.js';

/** The saved version the person picked in the reader. Identities only: the server reads the text itself. */
export type SourceRef = { workId: string; versionId: string };

/** One saved document version, frozen with the request that cites it. */
export type FrozenSource = {
  messageId: string;
  workId: string;
  versionId: string;
  versionN: number;
  title: string;
  contentSha256: string;
  /** The head of the document when the request was admitted. Another head means the document changed since. */
  headVersionId: string;
  headN: number;
};

export type SourceRefusal = { code: 'not_found' | 'cross_work'; message: string };

type SqlValue = string | number | null;

export type SourceKit = {
  get(text: string, ...params: SqlValue[]): Row | undefined;
  all(text: string, ...params: SqlValue[]): Row[];
  run(text: string, ...params: SqlValue[]): number;
  now(): string;
};

export type Sources = {
  /** Reads the chosen version again and freezes it with this request. Writes nothing when it refuses. */
  freeze(messageId: string, threadBotId: string, ref: SourceRef): SourceRefusal | null;
  of(messageId: string): FrozenSource | null;
  /** Oldest first. */
  list(): FrozenSource[];
  /** True while the frozen version is still readable with the same content and the document has no newer version. */
  holds(source: FrozenSource): boolean;
  /** The frozen text, never the head's. */
  body(source: FrozenSource): string;
};

export const SOURCE_MIGRATION = `
CREATE TABLE message_sources(
  message_id TEXT PRIMARY KEY REFERENCES messages(id),
  work_id TEXT NOT NULL REFERENCES works(id),
  version_id TEXT NOT NULL REFERENCES versions(id),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
  head_version_id TEXT NOT NULL REFERENCES versions(id),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX message_sources_by_work ON message_sources(work_id);
CREATE TRIGGER message_sources_admitted BEFORE INSERT ON message_sources
  WHEN NOT EXISTS(SELECT 1 FROM messages m JOIN origins o ON o.message_id = m.id WHERE m.id = NEW.message_id AND m.role = 'user' AND o.kind = 'human')
    OR EXISTS(SELECT 1 FROM works WHERE request_message_id = NEW.message_id)
    OR EXISTS(SELECT 1 FROM message_mentions WHERE message_id = NEW.message_id)
    OR EXISTS(SELECT 1 FROM tasks WHERE request_message_id = NEW.message_id)
    OR NOT EXISTS(SELECT 1 FROM versions v WHERE v.id = NEW.version_id AND v.work_id = NEW.work_id)
    OR NEW.head_version_id IS NOT (SELECT id FROM versions WHERE work_id = NEW.work_id ORDER BY n DESC LIMIT 1)
    OR NOT EXISTS(SELECT 1 FROM works w JOIN messages asked ON asked.id = w.request_message_id JOIN messages m ON m.id = NEW.message_id
      WHERE w.id = NEW.work_id AND asked.bot_id = m.bot_id)
  BEGIN SELECT RAISE(ABORT, 'a source is a saved version of the same thread, frozen with a request of the person before its work'); END;
CREATE TRIGGER message_sources_immutable BEFORE UPDATE ON message_sources BEGIN SELECT RAISE(ABORT, 'sources are immutable'); END;
CREATE TRIGGER message_sources_kept BEFORE DELETE ON message_sources
  WHEN NOT EXISTS(SELECT 1 FROM purge_target t WHERE t.tbl = 'message_sources' AND t.id = OLD.message_id)
  BEGIN SELECT RAISE(ABORT, 'sources are kept'); END;
`;

const contentSha256 = (version: { workId: string; versionId: string; title: string; body: string }): string =>
  sha256Hex(JSON.stringify({ workId: version.workId, versionId: version.versionId, title: version.title, body: version.body }));

export function createSources(kit: SourceKit): Sources {
  const { get, run } = kit;
  const head = (workId: string): Row | undefined => get('SELECT id FROM versions WHERE work_id = ? ORDER BY n DESC LIMIT 1', workId);
  const FROZEN = `SELECT s.*, v.n AS version_n, v.title, h.n AS head_n FROM message_sources s
    JOIN versions v ON v.id = s.version_id JOIN versions h ON h.id = s.head_version_id`;
  const frozenOf = (row: Row): FrozenSource => ({
    messageId: str(row, 'message_id'), workId: str(row, 'work_id'), versionId: str(row, 'version_id'), versionN: int(row, 'version_n'), title: str(row, 'title'),
    contentSha256: str(row, 'content_sha256'), headVersionId: str(row, 'head_version_id'), headN: int(row, 'head_n'),
  });

  return {
    freeze(messageId, threadBotId, ref) {
      const version = get(`SELECT v.work_id, v.title, v.body, asked.bot_id AS thread_bot_id FROM versions v
        JOIN works w ON w.id = v.work_id JOIN messages asked ON asked.id = w.request_message_id WHERE v.id = ?`, ref.versionId);
      if (!version) return { code: 'not_found', message: 'Cette version n’existe pas. Rien n’a été préparé.' };
      if (str(version, 'work_id') !== ref.workId) return { code: 'cross_work', message: 'Cette version appartient à un autre document. Rien n’a été préparé.' };
      if (str(version, 'thread_bot_id') !== threadBotId) {
        return { code: 'cross_work', message: 'Cette version appartient à une autre conversation. Préparez l’action dans la conversation du document.' };
      }
      run('INSERT INTO message_sources(message_id, work_id, version_id, content_sha256, head_version_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        messageId, ref.workId, ref.versionId,
        contentSha256({ workId: ref.workId, versionId: ref.versionId, title: str(version, 'title'), body: str(version, 'body') }),
        str(head(ref.workId) ?? {}, 'id'), kit.now());
      return null;
    },
    of(messageId) {
      const row = get(`${FROZEN} WHERE s.message_id = ?`, messageId);
      return row ? frozenOf(row) : null;
    },
    list() {
      return kit.all(`${FROZEN} ORDER BY s.rowid`).map(frozenOf);
    },
    holds(source) {
      const version = get('SELECT title, body FROM versions WHERE id = ? AND work_id = ?', source.versionId, source.workId);
      const current = head(source.workId);
      return version !== undefined && current !== undefined && str(current, 'id') === source.headVersionId
        && contentSha256({ workId: source.workId, versionId: source.versionId, title: str(version, 'title'), body: str(version, 'body') }) === source.contentSha256;
    },
    body(source) {
      return str(get('SELECT body FROM versions WHERE id = ?', source.versionId) ?? {}, 'body');
    },
  };
}
