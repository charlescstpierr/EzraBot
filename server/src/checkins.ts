import { createHash } from 'node:crypto';
import {
  CHECKIN_DELIVERIES,
  CHECKIN_FACT_KINDS,
  CHECKIN_LIMITS,
  CHECKIN_OUTCOMES,
  CHECKIN_STATES,
  type BotChoice,
  type CheckinDecisionView,
  type CheckinFactKind,
  type CheckinFactView,
  type CheckinOutcome,
  type CheckinView,
  type CommandOf,
  type CommandResult,
  type RefusalCode,
} from './protocol.js';
import type { MissionOrigin } from './routines.js';
import { int, oneOf, oneOfOrNull, str, strOrNull, type Row } from './sql-rows.js';
import type { LedgerKit } from './tool-ledger.js';

const sqlList = (values: readonly string[]) => values.map(value => `'${value}'`).join(',');
const MINO = 'mino';

/**
 * Mino's check-ins: one settings row, one immutable decision per due check, the facts an admitted check-in reserved,
 * and which later attempts were composed from a published one. Decision, admission and reservation share one
 * transaction; publication and consumption share the transaction of the reply.
 */
export const CHECKIN_MIGRATION = `
CREATE TABLE checkin_windows(
  n INTEGER PRIMARY KEY CHECK(n >= 1),
  decided_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN (${sqlList(CHECKIN_OUTCOMES)})),
  reason TEXT NOT NULL,
  human_seq INTEGER NOT NULL CHECK(human_seq >= 0),
  next_at TEXT NOT NULL,
  message_id TEXT REFERENCES messages(id),
  delivery TEXT CHECK(delivery IS NULL OR delivery IN (${sqlList(CHECKIN_DELIVERIES)})),
  departed INTEGER NOT NULL DEFAULT 0 CHECK(departed IN (0, 1)),
  CHECK((outcome = 'admitted') = (delivery IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX checkin_one_open ON checkin_windows(delivery) WHERE delivery = 'pending';
CREATE INDEX checkin_windows_by_message ON checkin_windows(message_id);
CREATE TRIGGER checkin_windows_forward BEFORE UPDATE ON checkin_windows
  WHEN NEW.n IS NOT OLD.n OR NEW.decided_at IS NOT OLD.decided_at OR NEW.human_seq IS NOT OLD.human_seq OR NEW.next_at IS NOT OLD.next_at
    OR ((NEW.outcome IS NOT OLD.outcome OR NEW.reason IS NOT OLD.reason)
      AND NOT (OLD.outcome = 'admitted' AND NEW.outcome = 'refused' AND OLD.message_id IS NULL AND OLD.delivery = 'pending'))
    OR (NEW.message_id IS NOT OLD.message_id AND NEW.message_id IS NOT NULL AND NOT (OLD.message_id IS NULL AND OLD.delivery = 'pending'))
    OR (NEW.delivery IS NOT OLD.delivery AND NOT (
      (OLD.delivery = 'pending' AND (NEW.delivery IN ('published','released','held') OR (NEW.delivery IS NULL AND NEW.outcome = 'refused')))
      OR (OLD.delivery = 'held' AND NEW.delivery IN ('released','waived'))))
    OR NEW.departed < OLD.departed
  BEGIN SELECT RAISE(ABORT, 'a check-in decision is kept; only its delivery moves forward'); END;
CREATE TRIGGER checkin_windows_kept BEFORE DELETE ON checkin_windows BEGIN SELECT RAISE(ABORT, 'check-in decisions are kept'); END;
CREATE TRIGGER checkin_windows_origin BEFORE UPDATE OF message_id ON checkin_windows
  WHEN NEW.message_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM origins o
    WHERE o.message_id = NEW.message_id AND o.kind = 'checkin' AND o.bot_id = '${MINO}' AND o.occurrence = 'w' || NEW.n)
  BEGIN SELECT RAISE(ABORT, 'an admitted check-in points at the request of its window'); END;
CREATE TRIGGER origins_checkin BEFORE INSERT ON origins
  WHEN NEW.kind = 'checkin' AND (NEW.bot_id IS NOT '${MINO}' OR NOT EXISTS(SELECT 1 FROM checkin_windows w
    WHERE 'w' || w.n = NEW.occurrence AND w.outcome = 'admitted' AND w.delivery = 'pending' AND w.message_id IS NULL))
  BEGIN SELECT RAISE(ABORT, 'a check-in request comes only from its decision'); END;
CREATE TABLE checkin_state(
  id INTEGER PRIMARY KEY CHECK(id = 1),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  state TEXT NOT NULL CHECK(state IN (${sqlList(CHECKIN_STATES)})),
  held_window INTEGER REFERENCES checkin_windows(n),
  baseline_at TEXT,
  next_at TEXT,
  silent_streak INTEGER NOT NULL CHECK(silent_streak >= 0),
  high_water TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((state = 'off') = (next_at IS NULL)),
  CHECK(state = 'off' OR baseline_at IS NOT NULL)
) STRICT;
INSERT INTO checkin_state(id, revision, state, silent_streak, high_water, updated_at) VALUES (1, 1, 'off', 0, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z');
CREATE TRIGGER checkin_state_forward BEFORE UPDATE ON checkin_state
  WHEN NEW.revision < OLD.revision OR NEW.high_water < OLD.high_water
  BEGIN SELECT RAISE(ABORT, 'check-in settings move forward'); END;
CREATE TABLE checkin_facts(
  window_n INTEGER NOT NULL REFERENCES checkin_windows(n),
  fact_key TEXT NOT NULL,
  ref TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN (${sqlList(CHECKIN_FACT_KINDS)})),
  work_id TEXT,
  mission_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('reserved','published','released','waived','withdrawn')),
  PRIMARY KEY(window_n, fact_key)
) STRICT;
CREATE UNIQUE INDEX checkin_facts_once ON checkin_facts(fact_key) WHERE state IN ('reserved','published','waived');
CREATE INDEX checkin_facts_by_work ON checkin_facts(work_id);
CREATE TRIGGER checkin_facts_forward BEFORE UPDATE ON checkin_facts
  WHEN NEW.window_n IS NOT OLD.window_n OR NEW.fact_key IS NOT OLD.fact_key OR NEW.ref IS NOT OLD.ref OR NEW.kind IS NOT OLD.kind
    OR (NEW.work_id IS NOT OLD.work_id AND NEW.work_id IS NOT NULL) OR NEW.mission_id IS NOT OLD.mission_id
    OR (NEW.state IS NOT OLD.state AND NOT (
      (OLD.state = 'reserved' AND NEW.state IN ('published','released','waived')) OR NEW.state = 'withdrawn'))
  BEGIN SELECT RAISE(ABORT, 'a reserved fact is consumed, released, waived or withdrawn once'); END;
CREATE TRIGGER checkin_facts_kept BEFORE DELETE ON checkin_facts BEGIN SELECT RAISE(ABORT, 'check-in facts are kept'); END;
CREATE TABLE checkin_uses(
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  window_n INTEGER NOT NULL REFERENCES checkin_windows(n),
  PRIMARY KEY(attempt_id, window_n)
) STRICT;
`;

type Fact = {
  key: string;
  kind: CheckinFactKind;
  at: string;
  /** An open decision of the person: still a candidate after a new baseline. */
  open: boolean;
  /** The reply that carries this fact in Mino's thread, when there is one. */
  seq: number | null;
  workId: string;
  missionId: string | null;
};

const LABELS: Record<CheckinFactKind, string> = {
  reply: 'Une réponse demandée dans ce fil est terminée.',
  version: 'Un document demandé dans ce fil est prêt à relire.',
  stopped: 'Un travail demandé dans ce fil s’est arrêté sans réponse.',
  publication: 'Une publication proposée attend une décision.',
  docproposal: 'Une proposition de document attend une décision.',
  action: 'Une action de service proposée attend une décision.',
  call: 'Un appel du modèle est parti sans fin enregistrée : résultat inconnu.',
  execution: 'Une action de service est partie sans réponse fiable : résultat inconnu.',
  mission: 'Une mission s’est arrêtée sans résultat confirmé.',
  review: 'Une mission terminée attend une validation.',
  automatic_done: 'Une routine ou un événement a terminé son travail avec une réponse.',
  automatic_stopped: 'Une routine ou un événement a arrêté son travail sans réponse.',
};

export function checkinText(facts: readonly { ref: string; kind: CheckinFactKind }[]): string {
  return [
    `Bilan automatique : ${facts.length} fait${facts.length > 1 ? 's' : ''} nouveau${facts.length > 1 ? 'x' : ''} depuis le bilan précédent. Références locales, sans contenu :`,
    ...facts.map(fact => `[${fact.ref}] ${LABELS[fact.kind]}`),
  ].join('\n');
}

export type CheckinHold = { ok: true } | { ok: false; reason: 'person_spoke' | 'paused' | 'source_moved' };

export type CheckinDeps = {
  /** Creates Mino's request and its work through the store's one admission path, inside the caller's transaction. */
  admit(input: { text: string; windowKey: string }): { ok: true; messageId: string; workId: string } | { ok: false; message: string };
  refuse(code: RefusalCode, message: string): never;
  missions(): readonly MissionOrigin[];
  /** False once the person withdrew this request from a memory. */
  allowed(requestMessageId: string): boolean;
  retired(workId: string): boolean;
  /** The shared ceiling of `codex.chat` today. Null: this server admits no such call. */
  budget(): { budget: string; callsPerDay: number; used: number } | null;
  /** Mino's model choice. Null once Mino was deleted. */
  choice(): BotChoice | null;
};

type CheckinCommand = CommandOf<'checkin.activate' | 'checkin.pause' | 'checkin.resume'>;

export type Checkins = {
  apply(command: CheckinCommand): CommandResult;
  /** At most one decision per call, never one per missed interval. True when a check-in was admitted. */
  tick(): { admitted: boolean; changed: boolean };
  /** Whether a pending check-in request may still be claimed. Always ok for any other request. */
  holdsRequest(messageId: string): CheckinHold;
  /**
   * For a check-in call: the person's fence, the pause and its facts. For any call: whether a check-in its context was
   * composed from was withdrawn since. Read only.
   */
  holds(attemptId: string): CheckinHold;
  isCheckin(messageId: string): boolean;
  factCount(messageId: string): number;
  /** Writes which check-ins an attempt's context used, from its own request and the exact replies and requests it read. */
  recordUses(attemptId: string, requestMessageId: string, used: { historyMessageIds: readonly string[]; replyAttemptIds: readonly string[] }): void;
  withdrawnAttempt(attemptId: string): boolean;
  /** Settles the open check-in of this work from what the registries recorded. Inside the caller's transaction. */
  resolve(workId: string): void;
  /** Requests of published check-ins withdrawn since: hidden from the thread. */
  hiddenRequests(): Set<string>;
  view(): CheckinView;
  markPurge(botId: string, erased: { messages: string; works: string; attempts: string }): void;
};

const MINUTE = 60_000;
const intOrNull = (row: Row, key: string): number | null => (row[key] === null ? null : int(row, key));
const before = (a: string, b: string) => Date.parse(a) < Date.parse(b);
const later = (a: string, b: string) => (before(a, b) ? b : a);
const plus = (at: string, minutes: number) => new Date(Date.parse(at) + minutes * MINUTE).toISOString();
const digest = (values: readonly string[]) => createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 32);

/** The interval after this many checks without a fact since the last publication. */
export function checkinInterval(silentStreak: number): number {
  const doublings = Math.floor(silentStreak / CHECKIN_LIMITS.silentPerDoubling);
  return Math.min(CHECKIN_LIMITS.maxMinutes, CHECKIN_LIMITS.initialMinutes * 2 ** Math.min(doublings, 16));
}

export function createCheckins(kit: Pick<LedgerKit, 'get' | 'all' | 'run' | 'transaction' | 'now'>, deps: CheckinDeps): Checkins {
  const { get, all, run, transaction } = kit;
  /** One spelling of the clock, so stored instants compare as text too. */
  const now = () => new Date(Date.parse(kit.now())).toISOString();

  const settings = (): Row => get('SELECT * FROM checkin_state WHERE id = 1') ?? {};
  const windowRow = (n: number): Row | undefined => get('SELECT * FROM checkin_windows WHERE n = ?', n);
  const windowOfMessage = (messageId: string): Row | undefined => get('SELECT * FROM checkin_windows WHERE message_id = ?', messageId);
  const windowOfWork = (workId: string): Row | undefined =>
    get('SELECT c.* FROM checkin_windows c JOIN works w ON w.request_message_id = c.message_id WHERE w.id = ?', workId);
  const windowOfAttempt = (attemptId: string): Row | undefined =>
    get('SELECT c.* FROM checkin_windows c JOIN works w ON w.request_message_id = c.message_id JOIN attempts a ON a.work_id = w.id WHERE a.id = ?', attemptId);
  const keyOf = (n: number) => `w${n}`;

  /** The person's last sent message, in any thread. A dictated text, an import, a routine, an event or a check-in is never one. */
  function personMark(): { seq: number; at: string | null } {
    const row = get(`SELECT m.seq, m.created_at FROM messages m JOIN origins o ON o.message_id = m.id
      WHERE o.kind = 'human' AND o.occurrence NOT LIKE 'legacy:%' ORDER BY m.seq DESC LIMIT 1`);
    return row ? { seq: int(row, 'seq'), at: str(row, 'created_at') } : { seq: 0, at: null };
  }
  const quietUntil = (mark: { at: string | null }) => (mark.at === null ? null : plus(mark.at, CHECKIN_LIMITS.quietMinutes));

  /** Works the person asked for in Mino's thread and may still be told about, and automatic works of this space. */
  function scope(): { asked: string[]; automatic: string[]; threadSeq: number } {
    const asked = all(`SELECT w.id, w.request_message_id FROM works w JOIN messages m ON m.id = w.request_message_id
      JOIN origins o ON o.message_id = m.id JOIN bots b ON b.id = w.bot_id AND b.deleted_at IS NULL
      WHERE m.bot_id = '${MINO}' AND o.kind = 'human' ORDER BY w.rowid`)
      .filter(row => deps.allowed(str(row, 'request_message_id')) && !deps.retired(str(row, 'id'))).map(row => str(row, 'id'));
    const automatic = all(`SELECT w.id FROM works w JOIN origins o ON o.message_id = w.request_message_id
      JOIN bots b ON b.id = w.bot_id AND b.deleted_at IS NULL WHERE o.kind IN ('routine','event') ORDER BY w.rowid`).map(row => str(row, 'id'));
    const thread = get(`SELECT COALESCE(MAX(m.seq), 0) AS seq FROM messages m JOIN origins o ON o.message_id = m.id
      WHERE m.bot_id = '${MINO}' AND o.kind = 'human' AND o.occurrence NOT LIKE 'legacy:%'`) ?? {};
    return { asked, automatic, threadSeq: int(thread, 'seq') };
  }

  /** Every fact that holds now, read from the registries that own it. Consumption and baseline are not applied here. */
  function discover(): Fact[] {
    const { asked, automatic } = scope();
    const facts: Fact[] = [];
    const push = (fact: Omit<Fact, 'open' | 'seq' | 'missionId'> & Partial<Pick<Fact, 'open' | 'seq' | 'missionId'>>) =>
      facts.push({ open: false, seq: null, missionId: null, ...fact });
    if (asked.length) {
      const works = JSON.stringify(asked);
      const inWorks = 'IN (SELECT value FROM json_each(?1))';
      for (const row of all(`SELECT a.id, a.work_id, r.created_at, r.seq FROM attempts a JOIN messages r ON r.attempt_id = a.id
        WHERE a.work_id ${inWorks} AND a.state = 'succeeded' AND NOT EXISTS(SELECT 1 FROM versions v WHERE v.attempt_id = a.id)`, works)) {
        push({ key: `reply:${str(row, 'id')}`, kind: 'reply', at: str(row, 'created_at'), seq: int(row, 'seq'), workId: str(row, 'work_id') });
      }
      for (const row of all(`SELECT v.id, v.work_id, v.created_at, (SELECT r.seq FROM messages r WHERE r.attempt_id = v.attempt_id) AS seq FROM versions v
        WHERE v.work_id ${inWorks} AND v.source = 'result' AND v.n = (SELECT MAX(x.n) FROM versions x WHERE x.work_id = v.work_id)`, works)) {
        push({ key: `version:${str(row, 'id')}`, kind: 'version', at: str(row, 'created_at'), seq: intOrNull(row, 'seq'), workId: str(row, 'work_id') });
      }
      for (const row of all(`SELECT a.id, a.work_id, a.finished_at FROM attempts a JOIN works w ON w.id = a.work_id
        WHERE a.work_id ${inWorks} AND w.state = 'failed' AND a.state IN ('failed','interrupted') AND a.finished_at IS NOT NULL
          AND a.n = (SELECT MAX(x.n) FROM attempts x WHERE x.work_id = a.work_id)`, works)) {
        push({ key: `stopped:${str(row, 'id')}`, kind: 'stopped', at: str(row, 'finished_at'), workId: str(row, 'work_id') });
      }
      for (const row of all(`SELECT id, work_id, payload_sha256, created_at FROM proposals WHERE state = 'open' AND work_id ${inWorks}`, works)) {
        push({ key: `publication:${str(row, 'id')}:${str(row, 'payload_sha256')}`, kind: 'publication', at: str(row, 'created_at'), open: true, workId: str(row, 'work_id') });
      }
      for (const row of all(`SELECT id, work_id, created_at FROM doc_proposals WHERE state = 'open' AND work_id ${inWorks}`, works)) {
        push({ key: `docproposal:${str(row, 'id')}`, kind: 'docproposal', at: str(row, 'created_at'), open: true, workId: str(row, 'work_id') });
      }
      for (const row of all(`SELECT id, work_id, fingerprint, created_at FROM tool_proposals WHERE state = 'open' AND work_id ${inWorks}`, works)) {
        push({ key: `action:${str(row, 'id')}:${str(row, 'fingerprint')}`, kind: 'action', at: str(row, 'created_at'), open: true, workId: str(row, 'work_id') });
      }
      for (const row of all(`SELECT r.id, a.work_id, COALESCE(r.closed_at, r.reserved_at) AS at FROM reservations r JOIN attempts a ON a.id = r.target_id
        WHERE r.state = 'unknown' AND r.target_kind IN ('chat','document') AND a.work_id ${inWorks}`, works)) {
        push({ key: `call:${str(row, 'id')}`, kind: 'call', at: str(row, 'at'), workId: str(row, 'work_id') });
      }
      for (const row of all(`SELECT e.id, p.work_id, e.updated_at FROM tool_executions e JOIN tool_proposals p ON p.id = e.proposal_id
        WHERE e.state = 'unknown' AND p.work_id ${inWorks}`, works)) {
        push({ key: `execution:${str(row, 'id')}`, kind: 'execution', at: str(row, 'updated_at'), workId: str(row, 'work_id') });
      }
      const replies = new Map(all(`SELECT m.id, a.work_id FROM messages m JOIN attempts a ON a.id = m.attempt_id WHERE a.work_id ${inWorks}`, works)
        .map(row => [str(row, 'id'), str(row, 'work_id')] as const));
      for (const mission of replies.size ? deps.missions() : []) {
        const workId = replies.get(mission.originMessageId);
        if (workId === undefined) continue;
        if (mission.status === 'interrupted') {
          push({ key: `mission:${mission.missionId}:${mission.goalRev}:${digest(mission.interruptions)}`, kind: 'mission', at: mission.updatedAt, workId, missionId: mission.missionId });
        } else if (mission.status === 'review' && mission.latestAttemptId !== null) {
          push({ key: `review:${mission.missionId}:${mission.goalRev}:${mission.latestAttemptId}`, kind: 'review', at: mission.updatedAt, open: true, workId, missionId: mission.missionId });
        }
      }
    }
    if (automatic.length) {
      for (const row of all(`SELECT a.id, a.state, a.work_id, a.finished_at FROM attempts a JOIN works w ON w.id = a.work_id
        WHERE a.work_id IN (SELECT value FROM json_each(?)) AND w.state IN ('done','review','failed') AND a.state IN ('succeeded','failed','interrupted')
          AND a.finished_at IS NOT NULL AND a.n = (SELECT MAX(x.n) FROM attempts x WHERE x.work_id = a.work_id)`, JSON.stringify(automatic))) {
        push({ key: `automatic:${str(row, 'id')}`, kind: str(row, 'state') === 'succeeded' ? 'automatic_done' : 'automatic_stopped', at: str(row, 'finished_at'), workId: str(row, 'work_id') });
      }
    }
    return facts;
  }

  /** Facts to report now: never reported, newer than the baseline unless still open, and not followed by the person in Mino's thread. */
  function candidates(baseline: string): Fact[] {
    const taken = new Set(all(`SELECT fact_key FROM checkin_facts WHERE state IN ('reserved','published','waived')`).map(row => str(row, 'fact_key')));
    const { threadSeq } = scope();
    return discover()
      .filter(fact => !taken.has(fact.key) && (fact.open || !before(fact.at, baseline)) && (fact.seq === null || fact.seq > threadSeq))
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.key < b.key ? -1 : 1));
  }

  /** Sources that still exist and that the person did not withdraw: works and missions a fact may link to. */
  function liveSources(): { works: Set<string>; missions: Set<string> } {
    const { asked, automatic } = scope();
    return { works: new Set([...asked, ...automatic]), missions: new Set(deps.missions().map(mission => mission.missionId)) };
  }
  const gone = (fact: Row, live: ReturnType<typeof liveSources>) => {
    const workId = strOrNull(fact, 'work_id');
    const missionId = strOrNull(fact, 'mission_id');
    return str(fact, 'state') === 'withdrawn' || workId === null || !live.works.has(workId) || (missionId !== null && !live.missions.has(missionId));
  };
  const factsOf = (n: number) => all('SELECT * FROM checkin_facts WHERE window_n = ? ORDER BY ref', n);
  const withdrawnWindow = (n: number, live = liveSources()) => factsOf(n).some(fact => gone(fact, live));

  function holdsWindow(row: Row): CheckinHold {
    if (personMark().seq > int(row, 'human_seq')) return { ok: false, reason: 'person_spoke' };
    const state = settings();
    if (str(state, 'state') !== 'active' || intOrNull(state, 'held_window') !== null) return { ok: false, reason: 'paused' };
    const valid = new Set(discover().map(fact => fact.key));
    const reserved = factsOf(int(row, 'n'));
    return reserved.length && reserved.every(fact => str(fact, 'state') === 'reserved' && valid.has(str(fact, 'fact_key')))
      ? { ok: true } : { ok: false, reason: 'source_moved' };
  }

  const usedWindows = (attemptId: string): number[] => all('SELECT window_n FROM checkin_uses WHERE attempt_id = ?', attemptId).map(row => int(row, 'window_n'));

  function withdrawnAttempt(attemptId: string): boolean {
    const windows = usedWindows(attemptId).filter(n => strOrNull(windowRow(n) ?? {}, 'delivery') === 'published');
    if (!windows.length) return false;
    const live = liveSources();
    return windows.some(n => withdrawnWindow(n, live));
  }

  function departuresSince(at: string): { used: number; first: string | null } {
    const row = get(`SELECT COUNT(*) AS n, MIN(started_at) AS first FROM reservations
      WHERE source_kind = 'checkin' AND state IN ('started','settled','unknown') AND started_at > ?`, plus(at, -24 * 60)) ?? {};
    return { used: int(row, 'n'), first: strOrNull(row, 'first') };
  }

  const setFacts = (n: number, to: 'published' | 'released' | 'waived') =>
    run(`UPDATE checkin_facts SET state = ? WHERE window_n = ? AND state = 'reserved'`, to, n);

  function hold(n: number, departed: boolean, at: string) {
    run(`UPDATE checkin_windows SET delivery = 'held', departed = ? WHERE n = ?`, departed ? 1 : 0, n);
    run('UPDATE checkin_state SET held_window = ?, high_water = ?, updated_at = ? WHERE id = 1', n, later(str(settings(), 'high_water'), at), at);
  }
  function release(n: number, at: string) {
    setFacts(n, 'released');
    run(`UPDATE checkin_windows SET delivery = 'released' WHERE n = ?`, n);
    const state = settings();
    if (str(state, 'state') === 'off') return;
    const after = later(quietUntil(personMark()) ?? at, at);
    run('UPDATE checkin_state SET next_at = ?, high_water = ?, updated_at = ? WHERE id = 1',
      later(strOrNull(state, 'next_at') ?? after, after), later(str(state, 'high_water'), at), at);
  }

  function resolve(workId: string): void {
    const row = windowOfWork(workId);
    if (row) settle(row, now());
  }
  /** What became of an admitted check-in whose work no longer waits or runs, from the work, its attempts and its permits. */
  function settle(row: Row, at: string): void {
    if (strOrNull(row, 'delivery') !== 'pending') return;
    const n = int(row, 'n');
    const messageId = strOrNull(row, 'message_id');
    const work = messageId === null ? undefined : get('SELECT * FROM works WHERE request_message_id = ?', messageId);
    if (work && ['pending', 'running'].includes(str(work, 'state'))) return;
    if (!work) {
      release(n, at);
      return;
    }
    const attempts = all('SELECT id, state, error_code FROM attempts WHERE work_id = ? ORDER BY n', str(work, 'id'));
    const ids = JSON.stringify(attempts.map(attempt => str(attempt, 'id')));
    if (get(`SELECT 1 AS x FROM messages WHERE attempt_id IN (SELECT value FROM json_each(?))`, ids)) {
      setFacts(n, 'published');
      run(`UPDATE checkin_windows SET delivery = 'published' WHERE n = ?`, n);
      run(`UPDATE checkin_state SET silent_streak = 0, next_at = CASE WHEN state = 'off' THEN NULL ELSE ? END, high_water = ?, updated_at = ? WHERE id = 1`,
        plus(at, CHECKIN_LIMITS.initialMinutes), later(str(settings(), 'high_water'), at), at);
      return;
    }
    const departed = get(`SELECT 1 AS x FROM reservations WHERE target_id IN (SELECT value FROM json_each(?)) AND state IN ('started','settled','unknown')`, ids) !== undefined;
    const last = attempts.at(-1);
    const moved = last === undefined || strOrNull(last, 'error_code') === 'checkin_moved';
    if (!departed && moved) release(n, at);
    else hold(n, departed, at);
  }

  function decide(at: string): boolean {
    const state = settings();
    const streak = int(state, 'silent_streak');
    const mark = personMark();
    const n = int(get('SELECT COALESCE(MAX(n), 0) + 1 AS n FROM checkin_windows') ?? {}, 'n');
    const record = (outcome: CheckinOutcome, reason: string, nextAt: string, nextStreak = streak) => {
      run(`INSERT INTO checkin_windows(n, decided_at, outcome, reason, human_seq, next_at, delivery) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        n, at, outcome, reason, mark.seq, nextAt, outcome === 'admitted' ? 'pending' : null);
      run('UPDATE checkin_state SET next_at = ?, silent_streak = ?, high_water = ?, updated_at = ? WHERE id = 1', nextAt, nextStreak, at, at);
    };
    const quiet = quietUntil(mark);
    if (quiet !== null && before(at, quiet)) {
      record('quiet', 'person_active', quiet);
      return false;
    }
    const facts = candidates(str(state, 'baseline_at'));
    if (!facts.length) {
      record('silent', 'no_fact', plus(at, checkinInterval(streak + 1)), streak + 1);
      return false;
    }
    const departures = departuresSince(at);
    if (departures.used >= CHECKIN_LIMITS.departuresPerDay) {
      record('deferred', 'departures_per_day', later(plus(departures.first ?? at, 24 * 60), plus(at, 1)));
      return false;
    }
    const nextAt = plus(at, checkinInterval(streak));
    const budget = deps.budget();
    if (!budget || budget.callsPerDay <= 0 || budget.used >= budget.callsPerDay) {
      record('refused', budget ? 'budget_exhausted' : 'not_configured', nextAt);
      run('UPDATE checkin_state SET held_window = ? WHERE id = 1', n);
      return false;
    }
    const picked = facts.slice(0, CHECKIN_LIMITS.factsPerCheckin).map((fact, i) => ({ ...fact, ref: `f${i + 1}` }));
    record('admitted', 'facts', nextAt);
    const admitted = deps.admit({ text: checkinText(picked), windowKey: keyOf(n) });
    if (!admitted.ok) {
      run(`UPDATE checkin_windows SET outcome = 'refused', reason = ?, delivery = NULL WHERE n = ?`, admitted.message, n);
      run('UPDATE checkin_state SET held_window = ? WHERE id = 1', n);
      return false;
    }
    run('UPDATE checkin_windows SET message_id = ? WHERE n = ?', admitted.messageId, n);
    for (const fact of picked) {
      run(`INSERT INTO checkin_facts(window_n, fact_key, ref, kind, work_id, mission_id, state) VALUES (?, ?, ?, ?, ?, ?, 'reserved')`,
        n, fact.key, fact.ref, fact.kind, fact.workId, fact.missionId);
    }
    return true;
  }

  function tick(): { admitted: boolean; changed: boolean } {
    return transaction(() => {
      const at = now();
      const open = get(`SELECT * FROM checkin_windows WHERE delivery = 'pending'`);
      if (open) {
        settle(open, at);
        if (strOrNull(windowRow(int(open, 'n')) ?? {}, 'delivery') === 'pending') return { admitted: false, changed: false };
      }
      const state = settings();
      const changed = open !== undefined;
      if (str(state, 'state') !== 'active' || intOrNull(state, 'held_window') !== null) return { admitted: false, changed };
      if (before(at, str(state, 'high_water')) || before(at, str(state, 'next_at'))) return { admitted: false, changed };
      return { admitted: decide(at), changed: true };
    });
  }

  const resultOf = (): CommandResult => {
    const state = settings();
    return { kind: 'checkin', revision: int(state, 'revision'), state: oneOf(state, 'state', CHECKIN_STATES), held: intOrNull(state, 'held_window') !== null };
  };

  function apply(command: CheckinCommand): CommandResult {
    const at = now();
    const state = settings();
    const current = oneOf(state, 'state', CHECKIN_STATES);
    const heldWindow = intOrNull(state, 'held_window');
    const requireRevision = (expected: number) => {
      if (int(state, 'revision') !== expected) deps.refuse('stale_base', 'Les bilans ont changé depuis leur affichage, par exemple dans un autre onglet. Relisez-les. Rien n’a été modifié.');
    };
    const start = () => {
      const moment = later(str(state, 'high_water'), at);
      run(`UPDATE checkin_state SET revision = revision + 1, state = 'active', held_window = NULL, baseline_at = ?, next_at = ?, high_water = ?, updated_at = ? WHERE id = 1`,
        moment, plus(moment, checkinInterval(int(state, 'silent_streak'))), moment, at);
    };
    switch (command.type) {
      case 'checkin.activate': {
        if (current !== 'off') deps.refuse('invalid_transition', 'Les bilans ont déjà été activés.');
        requireRevision(command.expectedRevision);
        if (deps.choice() === null) deps.refuse('not_found', 'Mino a été supprimé : aucun bilan ne peut être activé.');
        const budget = deps.budget();
        if (!budget || budget.callsPerDay <= 0) deps.refuse('invalid_transition', 'Ce serveur n’admet aucun appel de conversation au modèle : aucun plafond n’est configuré. Rien n’a été activé.');
        start();
        return resultOf();
      }
      case 'checkin.pause': {
        if (current !== 'active') deps.refuse('invalid_transition', current === 'paused' ? 'Les bilans sont déjà en pause.' : 'Les bilans ne sont pas activés.');
        run(`UPDATE checkin_state SET revision = revision + 1, state = 'paused', high_water = ?, updated_at = ? WHERE id = 1`, later(str(state, 'high_water'), at), at);
        return resultOf();
      }
      case 'checkin.resume': {
        requireRevision(command.expectedRevision);
        if (current === 'off') deps.refuse('invalid_transition', 'Les bilans ne sont pas activés.');
        if (heldWindow !== null) {
          if (command.confirmWindow !== keyOf(heldWindow)) deps.refuse('stale_base', 'Cette reprise doit confirmer le bilan affiché en attente de vérification. Rien n’a été repris.');
          const held = windowRow(heldWindow) ?? {};
          if (strOrNull(held, 'delivery') === 'held') {
            const departed = int(held, 'departed') === 1;
            setFacts(heldWindow, departed ? 'waived' : 'released');
            run('UPDATE checkin_windows SET delivery = ? WHERE n = ?', departed ? 'waived' : 'released', heldWindow);
          }
        } else if (command.confirmWindow !== undefined || current !== 'paused') {
          deps.refuse('invalid_transition', current === 'active' ? 'Les bilans sont déjà actifs.' : 'Aucun bilan n’attend de vérification.');
        }
        start();
        return resultOf();
      }
      default: {
        const _exhaustive: never = command;
        return _exhaustive;
      }
    }
  }

  function decisionView(row: Row, live: ReturnType<typeof liveSources>): CheckinDecisionView {
    const n = int(row, 'n');
    const messageId = strOrNull(row, 'message_id');
    const work = messageId === null ? undefined : get('SELECT id FROM works WHERE request_message_id = ? ORDER BY rowid LIMIT 1', messageId);
    const facts = factsOf(n);
    const delivery = oneOfOrNull(row, 'delivery', CHECKIN_DELIVERIES);
    return {
      window: keyOf(n), decidedAt: str(row, 'decided_at'), outcome: oneOf(row, 'outcome', CHECKIN_OUTCOMES), reason: str(row, 'reason'), delivery,
      messageId, workId: work ? str(work, 'id') : null,
      withdrawn: delivery === 'published' && facts.some(fact => gone(fact, live)),
      facts: facts.map((fact): CheckinFactView => {
        const away = gone(fact, live);
        return {
          ref: str(fact, 'ref'), kind: oneOf(fact, 'kind', CHECKIN_FACT_KINDS),
          state: away ? 'withdrawn' : oneOf(fact, 'state', ['reserved', 'published', 'released', 'waived', 'withdrawn'] as const),
          workId: away ? null : strOrNull(fact, 'work_id'), missionId: away ? null : strOrNull(fact, 'mission_id'),
        };
      }),
    };
  }

  function view(): CheckinView {
    const at = now();
    const state = settings();
    const live = liveSources();
    const heldWindow = intOrNull(state, 'held_window');
    const held = heldWindow === null ? undefined : windowRow(heldWindow);
    const quiet = quietUntil(personMark());
    const budget = deps.budget();
    const recent = all(`SELECT * FROM checkin_windows ORDER BY n DESC LIMIT ${CHECKIN_LIMITS.recent}`).map(row => decisionView(row, live));
    return {
      revision: int(state, 'revision'),
      state: oneOf(state, 'state', CHECKIN_STATES),
      held: held ? { window: keyOf(int(held, 'n')), departed: int(held, 'departed') === 1, reason: str(held, 'outcome') === 'refused' ? str(held, 'reason') : int(held, 'departed') === 1 ? 'departed_unpublished' : 'refused_before_departure' } : null,
      nextAt: strOrNull(state, 'next_at'),
      intervalMinutes: checkinInterval(int(state, 'silent_streak')),
      silentStreak: int(state, 'silent_streak'),
      quietUntil: quiet !== null && before(at, quiet) ? quiet : null,
      departures: { used: departuresSince(later(str(state, 'high_water'), at)).used, max: CHECKIN_LIMITS.departuresPerDay },
      budget: budget ? { capability: 'codex.chat', budget: budget.budget, callsPerDay: budget.callsPerDay } : null,
      model: deps.choice(),
      last: recent[0] ?? null,
      recent,
    };
  }

  return {
    apply,
    tick,
    holdsRequest(messageId) {
      const row = windowOfMessage(messageId);
      return row && strOrNull(row, 'delivery') === 'pending' ? holdsWindow(row) : { ok: true };
    },
    holds(attemptId) {
      const own = windowOfAttempt(attemptId);
      if (own && strOrNull(own, 'delivery') === 'pending') {
        const held = holdsWindow(own);
        if (!held.ok) return held;
      }
      return withdrawnAttempt(attemptId) ? { ok: false, reason: 'source_moved' } : { ok: true };
    },
    isCheckin: messageId => windowOfMessage(messageId) !== undefined,
    factCount(messageId) {
      const row = windowOfMessage(messageId);
      return row ? factsOf(int(row, 'n')).length : 0;
    },
    recordUses(attemptId, requestMessageId, used) {
      const windows = new Set<number>();
      for (const messageId of [requestMessageId, ...used.historyMessageIds]) {
        const row = windowOfMessage(messageId);
        if (row) windows.add(int(row, 'n'));
      }
      for (const replyAttemptId of used.replyAttemptIds) for (const n of usedWindows(replyAttemptId)) windows.add(n);
      for (const n of windows) run('INSERT OR IGNORE INTO checkin_uses(attempt_id, window_n) VALUES (?, ?)', attemptId, n);
    },
    withdrawnAttempt,
    resolve,
    hiddenRequests() {
      const live = liveSources();
      return new Set(all(`SELECT n, message_id FROM checkin_windows WHERE delivery = 'published' AND message_id IS NOT NULL`)
        .filter(row => withdrawnWindow(int(row, 'n'), live)).map(row => str(row, 'message_id')));
    },
    view,
    markPurge(botId, erased) {
      run(`UPDATE checkin_facts SET state = 'withdrawn', work_id = NULL WHERE work_id IN (${erased.works})`);
      run(`DELETE FROM checkin_uses WHERE attempt_id IN (${erased.attempts})`);
      run(`UPDATE checkin_windows SET message_id = NULL WHERE message_id IN (${erased.messages})`);
      if (botId !== MINO) return;
      const at = now();
      run(`UPDATE checkin_facts SET state = 'withdrawn' WHERE state = 'reserved'`);
      run(`UPDATE checkin_windows SET delivery = 'released' WHERE delivery = 'pending'`);
      run(`UPDATE checkin_windows SET delivery = 'waived' WHERE delivery = 'held'`);
      run(`UPDATE checkin_state SET revision = revision + 1, state = 'off', held_window = NULL, baseline_at = NULL, next_at = NULL, updated_at = ? WHERE id = 1`, at);
      run(`UPDATE commands SET fingerprint = '' WHERE type LIKE 'checkin.%'`);
    },
  };
}
