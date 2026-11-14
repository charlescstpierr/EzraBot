import type { MissionStatus } from './agent-protocol.js';
import {
  ROUTINE_LIMITS,
  ROUTINE_SKIP_REASONS,
  ROUTINE_STATES,
  type CommandOf,
  type CommandResult,
  type RefusalCode,
  type RoutineBlockerView,
  type RoutineDecisionView,
  type RoutineSkipReason,
  type RoutineView,
} from './protocol.js';
import {
  addDays,
  localDateAt,
  nextSlot,
  parseClockTime,
  parseLocalDate,
  parseZone,
  upcoming,
  type Schedule,
  type Slot,
  type Weekday,
} from './routine-calendar.js';
import { int, oneOf, oneOfOrNull, str, strOrNull, type Row } from './sql-rows.js';
import type { LedgerKit } from './tool-ledger.js';

/**
 * A routine, its frozen revisions, one decision per routine and local date, and the uncertain effects the person
 * confirmed. The decision and the work it admits are written in the same transaction.
 */
export const ROUTINE_MIGRATION = `
CREATE TABLE routines(
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  state TEXT NOT NULL CHECK(state IN ('inactive','active','paused','held','ended')),
  anchor TEXT,
  held_on TEXT,
  ended_because TEXT CHECK(ended_because IS NULL OR ended_because IN ('cap','end_date')),
  admitted INTEGER NOT NULL DEFAULT 0 CHECK(admitted >= 0),
  last_admitted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((state = 'held') = (held_on IS NOT NULL)),
  CHECK((state = 'ended') = (ended_because IS NOT NULL)),
  CHECK((state = 'inactive') = (anchor IS NULL))
) STRICT;
CREATE INDEX routines_by_bot ON routines(bot_id);
CREATE TRIGGER routines_forward BEFORE UPDATE ON routines
  WHEN NEW.id IS NOT OLD.id OR NEW.bot_id IS NOT OLD.bot_id OR NEW.created_at IS NOT OLD.created_at
    OR OLD.state = 'ended' OR NEW.state = 'inactive' AND OLD.state <> 'inactive'
    OR NEW.revision < OLD.revision OR NEW.admitted < OLD.admitted
    OR (OLD.anchor IS NOT NULL AND NEW.anchor < OLD.anchor)
    OR (OLD.last_admitted_at IS NOT NULL AND (NEW.last_admitted_at IS NULL OR NEW.last_admitted_at < OLD.last_admitted_at))
  BEGIN SELECT RAISE(ABORT, 'a routine keeps its identity, its count and its anchor'); END;
CREATE TABLE routine_revisions(
  routine_id TEXT NOT NULL REFERENCES routines(id),
  n INTEGER NOT NULL CHECK(n >= 1),
  text TEXT NOT NULL,
  zone TEXT NOT NULL,
  time TEXT NOT NULL,
  weekdays TEXT NOT NULL CHECK(json_valid(weekdays)),
  ends_on TEXT NOT NULL,
  cap INTEGER NOT NULL CHECK(cap BETWEEN 1 AND ${ROUTINE_LIMITS.cap}),
  created_at TEXT NOT NULL,
  PRIMARY KEY(routine_id, n)
) STRICT;
CREATE TRIGGER routine_revisions_frozen BEFORE UPDATE ON routine_revisions BEGIN SELECT RAISE(ABORT, 'routine revisions are immutable'); END;
CREATE TABLE routine_occurrences(
  routine_id TEXT NOT NULL REFERENCES routines(id),
  local_date TEXT NOT NULL,
  revision INTEGER NOT NULL,
  slot_at TEXT NOT NULL,
  offset_minutes INTEGER NOT NULL,
  decided_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('admitted','skipped','refused')),
  reason TEXT NOT NULL,
  blocker TEXT,
  message_id TEXT REFERENCES messages(id),
  PRIMARY KEY(routine_id, local_date),
  FOREIGN KEY(routine_id, revision) REFERENCES routine_revisions(routine_id, n),
  CHECK((outcome = 'admitted') = (message_id IS NOT NULL)),
  CHECK(outcome <> 'skipped' OR reason IN (${ROUTINE_SKIP_REASONS.map(reason => `'${reason}'`).join(',')}))
) STRICT;
CREATE TRIGGER routine_occurrences_frozen BEFORE UPDATE ON routine_occurrences BEGIN SELECT RAISE(ABORT, 'routine occurrences are immutable'); END;
CREATE TRIGGER routine_occurrences_origin BEFORE INSERT ON routine_occurrences
  WHEN NEW.message_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM origins o JOIN routines r ON r.id = NEW.routine_id
    WHERE o.message_id = NEW.message_id AND o.kind = 'routine' AND o.bot_id = r.bot_id AND o.occurrence = NEW.routine_id || '/' || NEW.local_date)
  BEGIN SELECT RAISE(ABORT, 'an admitted occurrence points at the request of its routine and date'); END;
CREATE TABLE routine_acks(
  routine_id TEXT NOT NULL REFERENCES routines(id),
  blocker TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL,
  PRIMARY KEY(routine_id, blocker)
) STRICT;
`;

/** The rows erased with a bot, children first. */
export const ROUTINE_PURGE_ORDER = [
  ['routine_acks', `routine_id || ':' || blocker`],
  ['routine_occurrences', `routine_id || ':' || local_date`],
  ['routine_revisions', `routine_id || ':' || n`],
  ['routines', 'id'],
] as const;

type RoutineCommand = CommandOf<'routine.create' | 'routine.update' | 'routine.activate' | 'routine.pause' | 'routine.resume' | 'routine.delete'>;
type Fields = Omit<CommandOf<'routine.create'>, 'type' | 'requestId' | 'botId'>;
type Revision = Schedule & { n: number; text: string; cap: number };

const OPEN_MISSIONS: readonly MissionStatus[] = ['queued', 'running', 'stopping', 'review', 'outdated', 'waiting'];
export type MissionOrigin = { missionId: string; originMessageId: string; status: MissionStatus };

export type RoutineDeps = {
  /** Creates the request and its work through the store's one admission path, inside the caller's transaction. */
  admit(input: { botId: string; text: string; routineId: string; date: string }): { ok: true; messageId: string; workId: string } | { ok: false; message: string };
  refuse(code: RefusalCode, message: string): never;
  /** Missions the person opened from a reply, as the missions registry sees them now. */
  missions(): readonly MissionOrigin[];
};

export type Routines = {
  apply(command: RoutineCommand): CommandResult;
  /** Decides every active routine whose slot came, once. `since`: when this server started; earlier slots are never admitted. */
  tick(since: string): { admitted: number; changed: boolean };
  views(): RoutineView[];
  count(botId: string): number;
  markPurge(botId: string): void;
};

const MINUTE = 60_000;
const isWeekday = (day: number): day is Weekday => Number.isInteger(day) && day >= 1 && day <= 7;
const later = (a: string, b: string) => (Date.parse(a) >= Date.parse(b) ? a : b);

export function createRoutines(kit: Pick<LedgerKit, 'get' | 'all' | 'run' | 'transaction' | 'now' | 'newId'>, deps: RoutineDeps): Routines {
  const { get, all, run, transaction, now, newId } = kit;

  function schedule(fields: Fields, at: string): Omit<Revision, 'n'> {
    const zone = parseZone(fields.zone);
    if (!zone) deps.refuse('invalid_command', `« ${fields.zone} » n’est pas un fuseau horaire nommé. Choisissez une zone comme America/Toronto, ou UTC. Un décalage fixe n’est pas accepté.`);
    const time = parseClockTime(fields.time);
    const endsOn = parseLocalDate(fields.endsOn);
    if (!time || !endsOn) deps.refuse('invalid_command', 'L’heure ou la date de fin n’existe pas.');
    const weekdays = fields.weekdays.filter(isWeekday).sort((a, b) => a - b);
    const today = localDateAt(Date.parse(at), zone);
    if (endsOn < today) deps.refuse('invalid_command', `La date de fin est passée dans ce fuseau : nous sommes le ${today}.`);
    if (endsOn > addDays(today, ROUTINE_LIMITS.horizonDays)) deps.refuse('invalid_command', `La date de fin doit tomber au plus ${ROUTINE_LIMITS.horizonDays} jours après aujourd’hui.`);
    return { zone, time, weekdays, endsOn, text: fields.text, cap: fields.cap };
  }

  const routineRow = (routineId: string): Row => get('SELECT * FROM routines WHERE id = ?', routineId) ?? deps.refuse('not_found', 'Cette routine n’existe pas ou a été supprimée.');
  const stateOf = (row: Row) => oneOf(row, 'state', ROUTINE_STATES);
  function revisionOf(routineId: string, n: number): Revision {
    const row = get('SELECT * FROM routine_revisions WHERE routine_id = ? AND n = ?', routineId, n);
    if (!row) throw new Error('Révision de routine absente');
    const zone = parseZone(str(row, 'zone'));
    const time = parseClockTime(str(row, 'time'));
    const endsOn = parseLocalDate(str(row, 'ends_on'));
    const days: unknown = JSON.parse(str(row, 'weekdays'));
    if (!zone || !time || !endsOn || !Array.isArray(days)) throw new Error('Révision de routine illisible');
    return { n, text: str(row, 'text'), zone, time, endsOn, cap: int(row, 'cap'), weekdays: days.filter((day): day is Weekday => typeof day === 'number' && isWeekday(day)) };
  }
  const currentRevision = (row: Row) => revisionOf(str(row, 'id'), int(row, 'revision'));
  const insertRevision = (routineId: string, n: number, revision: Omit<Revision, 'n'>, at: string) =>
    run(`INSERT INTO routine_revisions(routine_id, n, text, zone, time, weekdays, ends_on, cap, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      routineId, n, revision.text, revision.zone, revision.time, JSON.stringify(revision.weekdays), revision.endsOn, revision.cap, at);
  const result = (routineId: string): CommandResult => {
    const row = routineRow(routineId);
    return { kind: 'routine', routineId, revision: int(row, 'revision'), state: stateOf(row) };
  };
  const requireRevision = (row: Row, expected: number) => {
    if (int(row, 'revision') !== expected) deps.refuse('stale_base', 'Cette routine a changé depuis son affichage, par exemple dans un autre onglet. Relisez-la. Rien n’a été modifié.');
  };

  function apply(command: RoutineCommand): CommandResult {
    const at = now();
    switch (command.type) {
      case 'routine.create': {
        if (!get('SELECT 1 AS x FROM bots WHERE id = ? AND deleted_at IS NULL', command.botId)) deps.refuse('not_found', 'Ce personnage n’existe pas ou a été supprimé.');
        const { type: _type, requestId: _requestId, botId, ...fields } = command;
        const revision = schedule(fields, at);
        const routineId = newId('r');
        run(`INSERT INTO routines(id, bot_id, revision, state, created_at, updated_at) VALUES (?, ?, 1, 'inactive', ?, ?)`, routineId, botId, at, at);
        insertRevision(routineId, 1, revision, at);
        return result(routineId);
      }
      case 'routine.update': {
        const row = routineRow(command.routineId);
        if (stateOf(row) === 'ended') deps.refuse('invalid_transition', 'Cette routine est terminée. Créez-en une nouvelle.');
        requireRevision(row, command.expectedRevision);
        const { type: _type, requestId: _requestId, routineId, expectedRevision: _expected, ...fields } = command;
        const revision = schedule(fields, at);
        if (revision.cap <= int(row, 'admitted')) deps.refuse('limit_reached', `Cette routine a déjà admis ${int(row, 'admitted')} demandes. Son plafond doit rester au-dessus.`);
        const n = int(row, 'revision') + 1;
        insertRevision(routineId, n, revision, at);
        const anchor = strOrNull(row, 'anchor');
        run('UPDATE routines SET revision = ?, anchor = ?, updated_at = ? WHERE id = ?', n, anchor === null ? null : later(anchor, at), at, routineId);
        return result(routineId);
      }
      case 'routine.activate': {
        const row = routineRow(command.routineId);
        if (stateOf(row) !== 'inactive') deps.refuse('invalid_transition', 'Cette routine a déjà été activée.');
        requireRevision(row, command.expectedRevision);
        const revision = currentRevision(row);
        schedule({ ...revision, weekdays: [...revision.weekdays] }, at);
        if (!nextSlot(revision, Date.parse(at))) deps.refuse('invalid_transition', 'Aucun créneau ne reste avant la date de fin.');
        run(`UPDATE routines SET state = 'active', anchor = ?, updated_at = ? WHERE id = ?`, at, at, command.routineId);
        return result(command.routineId);
      }
      case 'routine.pause': {
        const row = routineRow(command.routineId);
        const state = stateOf(row);
        if (state !== 'active' && state !== 'held') deps.refuse('invalid_transition', state === 'paused' ? 'Cette routine est déjà en pause.' : 'Seule une routine active peut être mise en pause.');
        run(`UPDATE routines SET state = 'paused', held_on = NULL, updated_at = ? WHERE id = ?`, at, command.routineId);
        return result(command.routineId);
      }
      case 'routine.resume': {
        const row = routineRow(command.routineId);
        const state = stateOf(row);
        if (state === 'held') {
          const heldOn = str(row, 'held_on');
          if (command.confirmBlocker !== heldOn) deps.refuse('stale_base', 'Cette reprise doit confirmer l’effet incertain affiché par la routine. Rien n’a été repris.');
          run('INSERT INTO routine_acks(routine_id, blocker, acknowledged_at) VALUES (?, ?, ?)', command.routineId, heldOn, at);
        } else if (state !== 'paused' || command.confirmBlocker !== undefined) {
          deps.refuse('invalid_transition', 'Seule une routine en pause ou en attente de vérification peut reprendre.');
        }
        run(`UPDATE routines SET state = 'active', held_on = NULL, anchor = ?, updated_at = ? WHERE id = ?`, later(str(row, 'anchor'), at), at, command.routineId);
        return result(command.routineId);
      }
      case 'routine.delete': {
        const row = routineRow(command.routineId);
        for (const [table] of ROUTINE_PURGE_ORDER) run(`DELETE FROM ${table} WHERE ${table === 'routines' ? 'id' : 'routine_id'} = ?`, command.routineId);
        return { kind: 'routine', routineId: command.routineId, revision: int(row, 'revision'), state: stateOf(row) };
      }
      default: {
        const _exhaustive: never = command;
        return _exhaustive;
      }
    }
  }

  const admittedMessages = (routineId: string): string[] =>
    all('SELECT message_id FROM routine_occurrences WHERE routine_id = ? AND message_id IS NOT NULL', routineId).map(row => str(row, 'message_id'));

  /**
   * What earlier occurrences of this routine still leave open or uncertain, read from the registries that own those
   * facts. Uncertain effects the person already confirmed are left out; a new one needs a new confirmation.
   */
  function blockers(routineId: string): RoutineBlockerView[] {
    const messages = admittedMessages(routineId);
    if (!messages.length) return [];
    const ids = `SELECT message_id FROM routine_occurrences WHERE routine_id = ?1 AND message_id IS NOT NULL`;
    const works = `SELECT id FROM works WHERE request_message_id IN (${ids})`;
    const found: RoutineBlockerView[] = [];
    for (const row of all(`SELECT r.id, w.id AS work_id FROM reservations r LEFT JOIN works w ON w.request_message_id = r.source_id
      WHERE r.state = 'unknown' AND r.source_id IN (${ids}) ORDER BY r.rowid`, routineId)) {
      found.push({ key: `call:${str(row, 'id')}`, state: 'uncertain', kind: 'call', workId: strOrNull(row, 'work_id'), label: 'Un appel du modèle est parti sans fin enregistrée.' });
    }
    for (const row of all(`SELECT e.id, p.work_id FROM tool_executions e JOIN tool_proposals p ON p.id = e.proposal_id
      WHERE e.state = 'unknown' AND p.work_id IN (${works}) ORDER BY e.rowid`, routineId)) {
      found.push({ key: `action:${str(row, 'id')}`, state: 'uncertain', kind: 'action', workId: str(row, 'work_id'), label: 'Une action de service est partie sans réponse fiable.' });
    }
    const replies = new Map(all(`SELECT m.id, a.work_id FROM messages m JOIN attempts a ON a.id = m.attempt_id WHERE a.work_id IN (${works})`, routineId)
      .map(row => [str(row, 'id'), str(row, 'work_id')] as const));
    const missions = replies.size ? deps.missions().filter(mission => replies.has(mission.originMessageId)) : [];
    for (const mission of missions.filter(m => m.status === 'interrupted')) {
      found.push({ key: `mission:${mission.missionId}`, state: 'uncertain', kind: 'mission', workId: replies.get(mission.originMessageId) ?? null, label: 'Une mission ouverte depuis une réponse s’est arrêtée sans résultat confirmé.' });
    }
    const acknowledged = new Set(all('SELECT blocker FROM routine_acks WHERE routine_id = ?', routineId).map(row => str(row, 'blocker')));
    const uncertain = found.filter(blocker => !acknowledged.has(blocker.key));
    for (const row of all(`SELECT id, state FROM works WHERE id IN (${works}) AND state IN ('pending','running','review') ORDER BY rowid`, routineId)) {
      uncertain.push({ key: `work:${str(row, 'id')}`, state: 'open', kind: 'work', workId: str(row, 'id'),
        label: str(row, 'state') === 'review' ? 'La réponse précédente attend votre validation.' : 'La demande précédente n’est pas terminée.' });
    }
    for (const row of all(`SELECT id, work_id FROM proposals WHERE state = 'open' AND work_id IN (${works}) ORDER BY seq`, routineId)) {
      uncertain.push({ key: `publication:${str(row, 'id')}`, state: 'open', kind: 'publication', workId: str(row, 'work_id'), label: 'Une publication proposée attend votre décision.' });
    }
    for (const row of all(`SELECT p.id, p.work_id FROM tool_proposals p LEFT JOIN tool_executions e ON e.proposal_id = p.id
      WHERE p.work_id IN (${works}) AND (p.state IN ('drafted','open') OR e.state IN ('approved','dispatching') OR e.report IN ('queued','running'))
      ORDER BY p.rowid`, routineId)) {
      uncertain.push({ key: `action:${str(row, 'id')}`, state: 'open', kind: 'action', workId: str(row, 'work_id'), label: 'Une action de service attend votre décision ou son envoi.' });
    }
    for (const mission of missions.filter(m => OPEN_MISSIONS.includes(m.status))) {
      uncertain.push({ key: `mission:${mission.missionId}`, state: 'open', kind: 'mission', workId: replies.get(mission.originMessageId) ?? null, label: 'Une mission ouverte depuis une réponse n’est pas terminée.' });
    }
    return uncertain;
  }

  function decide(row: Row, slot: Extract<Slot, { kind: 'due' }>, at: string, outcome: { kind: 'skipped'; reason: RoutineSkipReason; blocker?: string } | { kind: 'refused'; message: string } | { kind: 'admitted'; messageId: string }) {
    run(`INSERT INTO routine_occurrences(routine_id, local_date, revision, slot_at, offset_minutes, decided_at, outcome, reason, blocker, message_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    str(row, 'id'), slot.date, int(row, 'revision'), new Date(slot.at).toISOString(), slot.offsetMinutes, at, outcome.kind,
    outcome.kind === 'skipped' ? outcome.reason : outcome.kind === 'refused' ? outcome.message : 'admitted',
    outcome.kind === 'skipped' ? outcome.blocker ?? null : null, outcome.kind === 'admitted' ? outcome.messageId : null);
  }

  /** One routine, in one transaction: at most one decision and at most one admission. */
  function step(routineId: string, at: string, since: number): { admitted: boolean; changed: boolean } {
    return transaction(() => {
      const moment = Date.parse(at);
      let changed = false;
      for (;;) {
        const row = get('SELECT * FROM routines WHERE id = ?', routineId);
        if (!row || stateOf(row) !== 'active') return { admitted: false, changed };
        const revision = currentRevision(row);
        const slot = nextSlot(revision, Date.parse(str(row, 'anchor')));
        const setAnchor = (anchor: string) => run('UPDATE routines SET anchor = ?, updated_at = ? WHERE id = ?', anchor, at, routineId);
        if (!slot) {
          run(`UPDATE routines SET state = 'ended', ended_because = 'end_date', updated_at = ? WHERE id = ?`, at, routineId);
          return { admitted: false, changed: true };
        }
        if (slot.at > moment) return { admitted: false, changed };
        if (get('SELECT 1 AS x FROM routine_occurrences WHERE routine_id = ? AND local_date = ?', routineId, slot.date)) {
          setAnchor(new Date(slot.at).toISOString());
          changed = true;
          continue;
        }
        const missed: RoutineSkipReason | null = slot.at <= since ? 'offline' : moment - slot.at > ROUTINE_LIMITS.lateMinutes * MINUTE ? 'late' : null;
        if (missed) {
          decide(row, slot, at, { kind: 'skipped', reason: missed });
          setAnchor(at);
          return { admitted: false, changed: true };
        }
        setAnchor(new Date(slot.at).toISOString());
        const last = strOrNull(row, 'last_admitted_at');
        if (last !== null && moment - Date.parse(last) < ROUTINE_LIMITS.cooldownMinutes * MINUTE) {
          decide(row, slot, at, { kind: 'skipped', reason: 'cooldown' });
          return { admitted: false, changed: true };
        }
        const [blocker] = blockers(routineId);
        if (blocker) {
          decide(row, slot, at, { kind: 'skipped', reason: blocker.state === 'uncertain' ? 'uncertain' : 'previous_open', blocker: blocker.key });
          if (blocker.state === 'uncertain') run(`UPDATE routines SET state = 'held', held_on = ? WHERE id = ?`, blocker.key, routineId);
          return { admitted: false, changed: true };
        }
        const admitted = deps.admit({ botId: str(row, 'bot_id'), text: revision.text, routineId, date: slot.date });
        if (!admitted.ok) {
          decide(row, slot, at, { kind: 'refused', message: admitted.message });
          return { admitted: false, changed: true };
        }
        decide(row, slot, at, { kind: 'admitted', messageId: admitted.messageId });
        const count = int(row, 'admitted') + 1;
        run('UPDATE routines SET admitted = ?, last_admitted_at = ? WHERE id = ?', count, at, routineId);
        if (count >= revision.cap) run(`UPDATE routines SET state = 'ended', ended_because = 'cap' WHERE id = ?`, routineId);
        return { admitted: true, changed: true };
      }
    });
  }

  function tick(since: string): { admitted: number; changed: boolean } {
    const at = now();
    const started = Date.parse(since);
    let admitted = 0;
    let changed = false;
    for (const row of all(`SELECT id FROM routines WHERE state = 'active' ORDER BY created_at, id`)) {
      const outcome = step(str(row, 'id'), at, started);
      if (outcome.admitted) admitted += 1;
      changed ||= outcome.changed;
    }
    return { admitted, changed };
  }

  function decisionView(row: Row): RoutineDecisionView {
    const base = { date: str(row, 'local_date'), revision: int(row, 'revision'), slotAt: str(row, 'slot_at'), offsetMinutes: int(row, 'offset_minutes'), decidedAt: str(row, 'decided_at') };
    const outcome = oneOf(row, 'outcome', ['admitted', 'skipped', 'refused'] as const);
    if (outcome === 'admitted') {
      const messageId = str(row, 'message_id');
      const work = get('SELECT id FROM works WHERE request_message_id = ? ORDER BY rowid LIMIT 1', messageId);
      return { ...base, outcome, messageId, workId: work ? str(work, 'id') : null };
    }
    if (outcome === 'refused') return { ...base, outcome, message: str(row, 'reason') };
    return { ...base, outcome, reason: oneOf(row, 'reason', ROUTINE_SKIP_REASONS), blocker: strOrNull(row, 'blocker') };
  }

  function views(): RoutineView[] {
    const at = now();
    return all('SELECT * FROM routines ORDER BY created_at, id').map(row => {
      const id = str(row, 'id');
      const revision = currentRevision(row);
      const state = stateOf(row);
      const heldOn = strOrNull(row, 'held_on');
      const decided = new Set(all('SELECT local_date FROM routine_occurrences WHERE routine_id = ?', id).map(r => str(r, 'local_date')));
      const anchor = strOrNull(row, 'anchor');
      const remaining = state === 'ended' ? 0 : Math.min(ROUTINE_LIMITS.previewSlots, revision.cap - int(row, 'admitted'));
      const after = Date.parse(anchor === null ? at : later(anchor, at));
      const ahead = [...decided].filter(date => date >= localDateAt(after, revision.zone)).length;
      const slots = remaining > 0 ? upcoming(revision, after, remaining + ahead).filter(slot => !decided.has(slot.date)).slice(0, remaining) : [];
      const last = get('SELECT * FROM routine_occurrences WHERE routine_id = ? ORDER BY decided_at DESC, rowid DESC LIMIT 1', id);
      return {
        id, botId: str(row, 'bot_id'), revision: revision.n, text: revision.text, time: revision.time, weekdays: [...revision.weekdays],
        zone: revision.zone, endsOn: revision.endsOn, cap: revision.cap, admitted: int(row, 'admitted'), state,
        endedBecause: oneOfOrNull(row, 'ended_because', ['cap', 'end_date'] as const),
        heldOn: heldOn === null ? null : blockers(id).find(blocker => blocker.key === heldOn)
          ?? { key: heldOn, state: 'uncertain', kind: heldOn.startsWith('action:') ? 'action' : heldOn.startsWith('mission:') ? 'mission' : 'call', workId: null, label: 'Un effet précédent reste incertain.' },
        upcoming: slots.map(slot => slot.kind === 'due'
          ? { kind: 'due', date: slot.date, at: new Date(slot.at).toISOString(), offsetMinutes: slot.offsetMinutes, repeated: slot.repeated }
          : { kind: 'missing', date: slot.date }),
        last: last ? decisionView(last) : null,
        createdAt: str(row, 'created_at'), updatedAt: str(row, 'updated_at'),
      };
    });
  }

  return {
    apply,
    tick,
    views,
    count: botId => int(get('SELECT COUNT(*) AS n FROM routines WHERE bot_id = ?', botId) ?? {}, 'n'),
    markPurge(botId) {
      run(`INSERT OR IGNORE INTO purge_target(tbl, id) SELECT 'routines', id FROM routines WHERE bot_id = ?`, botId);
      const erased = `SELECT id FROM purge_target WHERE tbl = 'routines'`;
      run(`INSERT OR IGNORE INTO purge_target(tbl, id) SELECT 'routine_revisions', routine_id || ':' || n FROM routine_revisions WHERE routine_id IN (${erased})`);
      run(`INSERT OR IGNORE INTO purge_target(tbl, id) SELECT 'routine_occurrences', routine_id || ':' || local_date FROM routine_occurrences WHERE routine_id IN (${erased})`);
      run(`INSERT OR IGNORE INTO purge_target(tbl, id) SELECT 'routine_acks', routine_id || ':' || blocker FROM routine_acks WHERE routine_id IN (${erased})`);
      run(`UPDATE commands SET fingerprint = '' WHERE type LIKE 'routine.%' AND json_extract(result, '$.routineId') IN (${erased})`);
    },
  };
}
