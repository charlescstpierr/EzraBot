import {
  BudgetsSchema,
  RESERVATION_STATES,
  SOURCE_KINDS,
  TARGET_KINDS,
  type AdmissionPolicy,
  type Cost,
  type ReservationState,
  type SourceKind,
  type TargetKind,
} from './admission-protocol.js';
import { int, oneOf, str, strOrNull, type Row } from './sql-rows.js';
import type { LedgerKit } from './tool-ledger.js';

const sqlList = (values: readonly string[]) => values.map(value => `'${value}'`).join(',');

/**
 * One row per call that asked to leave. It holds the budget slot and the one-use permit, nothing else:
 * works, missions and service receipts stay in their own registries.
 */
export const ADMISSION_MIGRATION = `
CREATE TABLE reservations(
  id TEXT PRIMARY KEY,
  capability TEXT NOT NULL,
  budget TEXT NOT NULL,
  day TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN (${sqlList(SOURCE_KINDS)})),
  source_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK(target_kind IN (${sqlList(TARGET_KINDS)})),
  target_id TEXT NOT NULL,
  target_revision TEXT,
  state TEXT NOT NULL CHECK(state IN (${sqlList(RESERVATION_STATES)})),
  cost_kind TEXT NOT NULL CHECK(cost_kind IN ('known','estimated','unavailable')),
  cost_micros INTEGER CHECK(cost_micros IS NULL OR cost_micros >= 0),
  cost_currency TEXT,
  cost_note TEXT NOT NULL,
  reserved_at TEXT NOT NULL,
  started_at TEXT,
  closed_at TEXT,
  CHECK((target_kind = 'chat') = (target_revision IS NULL)),
  CHECK((cost_kind = 'unavailable') = (cost_micros IS NULL)),
  CHECK((cost_micros IS NULL) = (cost_currency IS NULL))
) STRICT;
CREATE UNIQUE INDEX reservations_one_live_target ON reservations(capability, target_kind, target_id) WHERE state <> 'released';
CREATE INDEX reservations_by_budget ON reservations(budget, day) WHERE state <> 'released';
CREATE TRIGGER reservations_insert_reserved BEFORE INSERT ON reservations WHEN NEW.state IS NOT 'reserved'
  BEGIN SELECT RAISE(ABORT, 'a reservation starts reserved'); END;
CREATE TRIGGER reservations_forward BEFORE UPDATE ON reservations
  WHEN NEW.id IS NOT OLD.id OR NEW.capability IS NOT OLD.capability OR NEW.budget IS NOT OLD.budget OR NEW.day IS NOT OLD.day
    OR NEW.source_kind IS NOT OLD.source_kind OR NEW.source_id IS NOT OLD.source_id
    OR NEW.target_kind IS NOT OLD.target_kind OR NEW.target_id IS NOT OLD.target_id OR NEW.target_revision IS NOT OLD.target_revision
    OR NEW.cost_kind IS NOT OLD.cost_kind OR NEW.cost_micros IS NOT OLD.cost_micros OR NEW.cost_currency IS NOT OLD.cost_currency
    OR NEW.reserved_at IS NOT OLD.reserved_at
    OR (NEW.state IS NOT OLD.state AND NOT (
      (OLD.state = 'reserved' AND NEW.state IN ('started','released','unknown'))
      OR (OLD.state = 'started' AND NEW.state IN ('settled','unknown'))))
  BEGIN SELECT RAISE(ABORT, 'a reservation only moves forward and its permit is used once'); END;
CREATE TRIGGER reservations_kept BEFORE DELETE ON reservations BEGIN SELECT RAISE(ABORT, 'reservations are kept'); END;
`;

const NO_PRICE = 'Abonnement ChatGPT : Codex n’annonce aucun prix par appel.';

/**
 * The calls Mino already made before this registry existed keep an explicit daily ceiling.
 * Any other capability admits nothing until the server declares it with a budget.
 */
export const DEFAULT_POLICY: AdmissionPolicy = {
  budgets: { codex: { callsPerDay: 1000 }, composio: { callsPerDay: 200 } },
  capabilities: {
    'codex.chat': { budget: 'codex', cost: { kind: 'unavailable', reason: NO_PRICE } },
    'codex.document': { budget: 'codex', cost: { kind: 'unavailable', reason: NO_PRICE } },
    'codex.mission': { budget: 'codex', cost: { kind: 'unavailable', reason: NO_PRICE } },
    'composio.action': { budget: 'composio', cost: { kind: 'unavailable', reason: 'Composio n’annonce aucun prix par action.' } },
  },
};

export class BudgetConfigError extends Error {
  constructor() {
    super('MINO_BUDGETS doit être un objet JSON de plafonds par budget, par exemple {"codex":{"callsPerDay":300}}.');
  }
}

/** The server's ceilings: the defaults, with the budgets of `MINO_BUDGETS` replacing or adding theirs. */
export function policyFromEnv(raw: string | undefined): AdmissionPolicy {
  if (raw === undefined || raw.trim() === '') return DEFAULT_POLICY;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new BudgetConfigError();
  }
  const parsed = BudgetsSchema.safeParse(value);
  if (!parsed.success) throw new BudgetConfigError();
  return { ...DEFAULT_POLICY, budgets: { ...DEFAULT_POLICY.budgets, ...parsed.data } };
}

/** What will be called. `id` is the only identity a departure has; `revision` is what the call was reserved against. */
export type Target = { kind: 'chat'; id: string } | { kind: Exclude<TargetKind, 'chat'>; id: string; revision: string };

export type ReservationRequest = {
  capability: string;
  /** Who asked: the origin of a work, or a lead's decision. Context only, never a right. */
  source: { kind: SourceKind; id: string };
  target: Target;
};

export type DenialCode = 'not_configured' | 'calls_exhausted' | 'spend_exhausted' | 'already_departed' | 'conflict';
export type Reserved = { ok: true; reservationId: string };
export type Denied = { ok: false; code: DenialCode; message: string };
export type Departure = { ok: true } | { ok: false; reason: string };

/** What the registry that owns a target can testify about a call after a restart. */
export type Evidence = 'not_departed' | 'ended' | 'unknown';

export type BudgetUsage = {
  budget: string;
  day: string;
  calls: number;
  callsPerDay: number;
  /** Micros of the budget's currency. Calls without a price are counted in `unpricedCalls`, never as zero spend. */
  knownMicros: number;
  estimatedMicros: number;
  unpricedCalls: number;
};

export type Admission = {
  /** Reserves the shared ceilings of one call in one transaction. Asked again unchanged, an unused reservation is returned as is. */
  reserve(request: ReservationRequest): Reserved | Denied;
  /** The one-use permit of a reserved call. Refused once used, and when the target moved from the reserved revision. */
  depart(capability: string, target: Target): Departure;
  /** Records how the call ended. An unused permit frees its slot; a used one never does. Null when nothing was reserved. */
  settle(capability: string, target: Pick<Target, 'kind' | 'id'>, end: 'ended' | 'unknown'): ReservationState | null;
  /** After a restart, for targets recorded in this database: an unused permit is released, a used one stays unknown. */
  recover(): { released: number; unknown: number };
  /**
   * After a restart, for mission targets: only the missions registry can say whether a call left or ended.
   * An unused permit is released when the registry says the turn never left, a used one is settled when it says the turn ended.
   * Every other case stays unknown and keeps its slot. Null leaves a turn that runs now untouched.
   */
  reconcileMissions(evidence: (attemptId: string) => Evidence | null): { released: number; settled: number; unknown: number };
  usage(): BudgetUsage[];
};

const revisionOf = (target: Target): string | null => (target.kind === 'chat' ? null : target.revision);
const dayOf = (instant: string): string => instant.slice(0, 10);

const costColumns = (cost: Cost): [kind: Cost['kind'], micros: number | null, currency: string | null, note: string] =>
  cost.kind === 'unavailable' ? [cost.kind, null, null, cost.reason] : [cost.kind, cost.micros, cost.currency, cost.kind === 'estimated' ? cost.method : ''];

export function createAdmission(kit: Pick<LedgerKit, 'get' | 'all' | 'run' | 'transaction' | 'now' | 'newId'>, policy: AdmissionPolicy): Admission {
  const { get, all, run, now, newId } = kit;
  const denied = (code: DenialCode, message: string): Denied => ({ ok: false, code, message });
  const live = (capability: string, target: Pick<Target, 'kind' | 'id'>): Row | undefined =>
    get(`SELECT * FROM reservations WHERE capability = ? AND target_kind = ? AND target_id = ? AND state <> 'released'`, capability, target.kind, target.id);
  const stateOf = (row: Row) => oneOf(row, 'state', RESERVATION_STATES);
  const close = (id: string, from: ReservationState, to: ReservationState): number =>
    run('UPDATE reservations SET state = ?, closed_at = ? WHERE id = ? AND state = ?', to, now(), id, from);

  function used(budget: string, day: string): Row {
    return get(`SELECT COUNT(*) AS calls,
        COALESCE(SUM(CASE WHEN cost_kind = 'known' THEN cost_micros END), 0) AS known,
        COALESCE(SUM(CASE WHEN cost_kind = 'estimated' THEN cost_micros END), 0) AS estimated,
        COALESCE(SUM(cost_kind = 'unavailable'), 0) AS unpriced
      FROM reservations WHERE budget = ? AND day = ? AND state <> 'released'`, budget, day) ?? {};
  }

  function reserve(request: ReservationRequest): Reserved | Denied {
    return kit.transaction((): Reserved | Denied => {
      const { capability, source, target } = request;
      const existing = live(capability, target);
      if (existing) {
        if (stateOf(existing) !== 'reserved') return denied('already_departed', 'Cet appel est déjà parti une fois. Son permis ne se redonne pas.');
        const same = str(existing, 'source_kind') === source.kind && str(existing, 'source_id') === source.id && strOrNull(existing, 'target_revision') === revisionOf(target);
        return same ? { ok: true, reservationId: str(existing, 'id') }
          : denied('conflict', 'Cet appel est déjà réservé pour une autre demande ou une autre révision. Aucun appel n’est parti.');
      }
      const declared = policy.capabilities[capability];
      const budget = declared ? policy.budgets[declared.budget] : undefined;
      if (!declared || !budget) {
        return denied('not_configured', `La capacité « ${capability} » n’a aucun plafond configuré sur ce serveur. Aucun appel n’est parti.`);
      }
      const day = dayOf(now());
      const spent = used(declared.budget, day);
      if (int(spent, 'calls') >= budget.callsPerDay) {
        return denied('calls_exhausted', `Plafond d’appels du jour atteint pour « ${declared.budget} » : ${int(spent, 'calls')} sur ${budget.callsPerDay}. Aucun appel n’est parti. Le compteur repart à minuit UTC ; le plafond se règle avec MINO_BUDGETS.`);
      }
      const cost = declared.cost;
      if (cost.kind !== 'unavailable') {
        const ceiling = budget.spendPerDay;
        if (!ceiling || ceiling.currency !== cost.currency) {
          return denied('not_configured', `La capacité « ${capability} » a un prix en ${cost.currency}, mais le budget « ${declared.budget} » n’a aucun plafond de dépense dans cette devise. Aucun appel n’est parti.`);
        }
        if (int(spent, 'known') + int(spent, 'estimated') + cost.micros > ceiling.micros) {
          return denied('spend_exhausted', `Plafond de dépense du jour atteint pour « ${declared.budget} ». Aucun appel n’est parti. Le compteur repart à minuit UTC ; le plafond se règle avec MINO_BUDGETS.`);
        }
      }
      const reservationId = newId('res');
      run(`INSERT INTO reservations(id, capability, budget, day, source_kind, source_id, target_kind, target_id, target_revision, state,
          cost_kind, cost_micros, cost_currency, cost_note, reserved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?)`,
      reservationId, capability, declared.budget, day, source.kind, source.id, target.kind, target.id, revisionOf(target), ...costColumns(cost), now());
      return { ok: true, reservationId };
    });
  }

  function depart(capability: string, target: Target): Departure {
    return kit.transaction((): Departure => {
      const row = live(capability, target);
      if (!row) return { ok: false, reason: 'Cet appel n’a aucune réservation. Mino ne l’a pas lancé.' };
      if (stateOf(row) !== 'reserved') return { ok: false, reason: 'Le permis de cet appel a déjà servi. Mino ne l’a pas relancé.' };
      const departedAt = now();
      if (str(row, 'day') !== dayOf(departedAt)) {
        close(str(row, 'id'), 'reserved', 'released');
        return { ok: false, reason: 'Le jour UTC a changé depuis la réservation. Mino n’a pas lancé l’appel. Relancez le travail pour réserver dans le budget du jour.' };
      }
      if (strOrNull(row, 'target_revision') !== revisionOf(target)) {
        return { ok: false, reason: 'L’objectif a changé entre la réservation et le départ. Mino n’a pas lancé l’appel sur l’ancienne version.' };
      }
      run(`UPDATE reservations SET state = 'started', started_at = ? WHERE id = ? AND state = 'reserved'`, departedAt, str(row, 'id'));
      return { ok: true };
    });
  }

  function settle(capability: string, target: Pick<Target, 'kind' | 'id'>, end: 'ended' | 'unknown'): ReservationState | null {
    return kit.transaction((): ReservationState | null => {
      const row = live(capability, target);
      if (!row) return null;
      const state = stateOf(row);
      const next: ReservationState = state === 'reserved' ? 'released' : state === 'started' ? (end === 'ended' ? 'settled' : 'unknown') : state;
      if (next !== state) close(str(row, 'id'), state, next);
      return next;
    });
  }

  return {
    reserve,
    depart,
    settle,
    recover() {
      return kit.transaction(() => ({
        released: run(`UPDATE reservations SET state = 'released', closed_at = ? WHERE state = 'reserved' AND target_kind <> 'mission'`, now()),
        unknown: run(`UPDATE reservations SET state = 'unknown', closed_at = ? WHERE state = 'started' AND target_kind <> 'mission'`, now()),
      }));
    },
    reconcileMissions(evidence) {
      return kit.transaction(() => {
        const counts = { released: 0, settled: 0, unknown: 0 };
        for (const row of all(`SELECT id, state, target_id FROM reservations WHERE target_kind = 'mission' AND state IN ('reserved','started')`)) {
          const state = stateOf(row);
          const seen = evidence(str(row, 'target_id'));
          if (seen === null) continue;
          const next = state === 'reserved' && seen === 'not_departed' ? 'released' : state === 'started' && seen === 'ended' ? 'settled' : 'unknown';
          counts[next] += close(str(row, 'id'), state, next);
        }
        return counts;
      });
    },
    usage() {
      const day = dayOf(now());
      return Object.entries(policy.budgets).map(([budget, ceiling]) => {
        const spent = used(budget, day);
        return {
          budget, day, calls: int(spent, 'calls'), callsPerDay: ceiling.callsPerDay,
          knownMicros: int(spent, 'known'), estimatedMicros: int(spent, 'estimated'), unpricedCalls: int(spent, 'unpriced'),
        };
      });
    },
  };
}
