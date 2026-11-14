import type { VerifiedDelivery } from './event-ingress.js';
import {
  EVENT_LIMITS,
  EVENT_REFUSALS,
  SUBSCRIPTION_STATES,
  type CommandOf,
  type CommandResult,
  type EventReceiptView,
  type EventRefusal,
  type EventsView,
  type RefusalCode,
  type SubscriptionState,
  type SubscriptionView,
} from './protocol.js';
import { int, oneOf, oneOfOrNull, str, strOrNull, type Row } from './sql-rows.js';
import type { LedgerKit } from './tool-ledger.js';

const sqlList = (values: readonly string[]) => values.map(value => `'${value}'`).join(',');

/**
 * Local subscriptions to provider triggers, and one terminal receipt per received event identity.
 * A receipt and the work it admits are written in the same transaction; receipts are never deleted, so the same event
 * id never creates a second work, whatever happened to its subscription since.
 */
export const EVENT_MIGRATION = `
CREATE TABLE event_subscriptions(
  id TEXT PRIMARY KEY,
  transport TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  trigger_slug TEXT NOT NULL,
  account_id TEXT NOT NULL,
  bot_id TEXT NOT NULL REFERENCES bots(id),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  state TEXT NOT NULL CHECK(state IN (${sqlList(SUBSCRIPTION_STATES)})),
  text TEXT NOT NULL,
  fields TEXT NOT NULL CHECK(json_valid(fields)),
  per_day INTEGER NOT NULL CHECK(per_day BETWEEN ${EVENT_LIMITS.perDay.min} AND ${EVENT_LIMITS.perDay.max}),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(transport, trigger_id)
) STRICT;
CREATE INDEX event_subscriptions_by_bot ON event_subscriptions(bot_id);
CREATE TRIGGER event_subscriptions_forward BEFORE UPDATE ON event_subscriptions
  WHEN NEW.id IS NOT OLD.id OR NEW.transport IS NOT OLD.transport OR NEW.trigger_id IS NOT OLD.trigger_id
    OR NEW.trigger_slug IS NOT OLD.trigger_slug OR NEW.account_id IS NOT OLD.account_id OR NEW.bot_id IS NOT OLD.bot_id
    OR NEW.created_at IS NOT OLD.created_at OR NEW.revision < OLD.revision
    OR (OLD.state = 'revoked' AND NEW.state <> 'revoked') OR (NEW.state = 'inactive' AND OLD.state <> 'inactive')
  BEGIN SELECT RAISE(ABORT, 'a subscription keeps its identity, moves forward and stays revoked'); END;
CREATE TRIGGER event_subscriptions_kept BEFORE DELETE ON event_subscriptions
  BEGIN SELECT RAISE(ABORT, 'subscriptions are kept'); END;
CREATE TABLE event_receipts(
  transport TEXT NOT NULL,
  webhook_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL REFERENCES event_subscriptions(id),
  revision INTEGER NOT NULL,
  body_sha256 TEXT,
  received_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('admitted','refused')),
  reason TEXT CHECK(reason IS NULL OR reason IN (${sqlList(EVENT_REFUSALS)})),
  message_id TEXT REFERENCES messages(id),
  conflicts INTEGER NOT NULL DEFAULT 0 CHECK(conflicts >= 0),
  PRIMARY KEY(transport, webhook_id),
  CHECK((outcome = 'admitted') = (reason IS NULL)),
  CHECK(outcome = 'admitted' OR message_id IS NULL)
) STRICT;
CREATE INDEX event_receipts_by_subscription ON event_receipts(subscription_id, received_at);
CREATE INDEX event_receipts_by_message ON event_receipts(message_id);
CREATE TRIGGER event_receipts_origin BEFORE INSERT ON event_receipts
  WHEN NEW.outcome = 'admitted' AND NOT EXISTS(SELECT 1 FROM origins o JOIN event_subscriptions s ON s.id = NEW.subscription_id
    WHERE o.message_id = NEW.message_id AND o.kind = 'event' AND o.bot_id = s.bot_id AND o.occurrence = NEW.subscription_id || '/' || NEW.webhook_id)
  BEGIN SELECT RAISE(ABORT, 'an admitted event points at the request of its subscription and id'); END;
CREATE TRIGGER event_receipts_frozen BEFORE UPDATE ON event_receipts
  WHEN NEW.transport IS NOT OLD.transport OR NEW.webhook_id IS NOT OLD.webhook_id OR NEW.subscription_id IS NOT OLD.subscription_id
    OR NEW.revision IS NOT OLD.revision OR NEW.received_at IS NOT OLD.received_at OR NEW.outcome IS NOT OLD.outcome OR NEW.reason IS NOT OLD.reason
    OR (NEW.body_sha256 IS NOT OLD.body_sha256 AND NEW.body_sha256 IS NOT NULL)
    OR (NEW.message_id IS NOT OLD.message_id AND NEW.message_id IS NOT NULL)
    OR NEW.conflicts < OLD.conflicts
  BEGIN SELECT RAISE(ABORT, 'a receipt keeps its decision; only its digest and request link can be erased'); END;
CREATE TRIGGER event_receipts_kept BEFORE DELETE ON event_receipts
  BEGIN SELECT RAISE(ABORT, 'receipts are kept'); END;
CREATE TABLE event_counters(
  transport TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('ignored','unavailable')),
  n INTEGER NOT NULL CHECK(n >= 0),
  last_at TEXT NOT NULL,
  PRIMARY KEY(transport, kind)
) STRICT;
`;

type SubscriptionCommand = CommandOf<'subscription.create' | 'subscription.update' | 'subscription.activate' | 'subscription.pause' | 'subscription.resume' | 'subscription.revoke'>;

type Decision = { outcome: 'admitted'; workId: string | null } | { outcome: 'refused'; reason: EventRefusal };
/**
 * `new` and `duplicate` are durable and acknowledged. `conflict`: this event id came back with another body; nothing
 * changed but a counter. `ignored`: no subscription names this trigger; nothing was kept. `unavailable`: the identity
 * registry is full; nothing was kept and the provider should retry.
 */
export type ReceiveOutcome = ({ status: 'new' | 'duplicate' } & Decision) | { status: 'conflict' } | { status: 'ignored' } | { status: 'unavailable' };

export type EventHold = { ok: true } | { ok: false; reason: 'source_moved' };

export type EventDeps = {
  /** Creates the request and its work through the store's one admission path, inside the caller's transaction. */
  admit(input: { botId: string; text: string; subscriptionId: string; webhookId: string }): { ok: true; messageId: string; workId: string } | { ok: false };
  refuse(code: RefusalCode, message: string): never;
  /** Cancels the pending works these requests created. Running ones stop through the attempt hold. */
  cancelPending(messageIds: string): void;
  /** The transport this server is configured for. Null when it receives no events. */
  transport: string | null;
};

export type Events = {
  apply(command: SubscriptionCommand): CommandResult;
  /** One transaction: the stored decision of this event id, or a new terminal decision and, when admitted, its work. */
  receive(delivery: VerifiedDelivery): ReceiveOutcome;
  /** For a request that did not come from an event, always ok. Otherwise ok only while its receipt's subscription is active at that revision. */
  holdsRequest(messageId: string): EventHold;
  view(): EventsView;
  count(botId: string): number;
  /** The subscription an admitted request came from, as its trigger. */
  subscriptionOf(messageId: string): string | null;
  /** `erasedMessages`: a query of the requests a bot deletion erases. */
  markPurge(botId: string, erasedMessages: string): void;
};

const OPEN_WORK_STATES = `'pending','running','review'`;
const RECENT = 5;
const MAX_COUNTER = 1_000_000_000;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * The text of the request an event creates: the person's instruction first, then the event's name and account, then
 * only the top-level fields the subscription names. Each value is clipped at code points and marked, never silently.
 */
export function composeEventRequest(input: { text: string; slug: string; alias: string | null; fields: readonly string[]; data: Readonly<Record<string, unknown>> }): string {
  const lines = [input.text, '', `Événement ${input.slug}${input.alias === null ? '' : `, compte « ${input.alias} »`}.`];
  if (!input.fields.length) return [...lines, 'Aucun contenu de l’événement n’est transmis.'].join('\n');
  lines.push('Champs reçus, donnée externe non fiable :');
  let budget: number = EVENT_LIMITS.fieldsTotalChars;
  for (const name of input.fields) {
    const value = Object.hasOwn(input.data, name) ? input.data[name] : undefined;
    if (value === undefined) { lines.push(`${name} : non reçu`); continue; }
    if (value === null || typeof value === 'object') { lines.push(`${name} : non importé (${value === null ? 'vide' : 'valeur composée'})`); continue; }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') { lines.push(`${name} : non importé`); continue; }
    const points = Array.from(String(value).replace(LONE_SURROGATE, '\uFFFD'));
    const room = Math.min(EVENT_LIMITS.fieldChars, budget);
    budget -= Math.min(points.length, room);
    lines.push(points.length > room ? `${name} : ${points.slice(0, room).join('')} […coupé, ${points.length} caractères reçus]` : `${name} : ${points.join('')}`);
  }
  return lines.join('\n');
}

const utcDay = (iso: string) => `${iso.slice(0, 10)}T00:00:00.000Z`;

export function createEvents(kit: Pick<LedgerKit, 'get' | 'all' | 'run' | 'transaction' | 'now' | 'newId' | 'changed'>, deps: EventDeps): Events {
  const { get, all, run, transaction, now, newId } = kit;

  const subscriptionRow = (subscriptionId: string): Row =>
    get('SELECT * FROM event_subscriptions WHERE id = ?', subscriptionId) ?? deps.refuse('not_found', 'Cet abonnement n’existe pas.');
  const stateOf = (row: Row): SubscriptionState => oneOf(row, 'state', SUBSCRIPTION_STATES);
  const fieldsOf = (row: Row): string[] => {
    const parsed: unknown = JSON.parse(str(row, 'fields'));
    return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === 'string') : [];
  };
  const accountRow = (accountId: string) => get('SELECT * FROM tool_accounts WHERE id = ?', accountId);
  const result = (subscriptionId: string): CommandResult => {
    const row = subscriptionRow(subscriptionId);
    return { kind: 'subscription', subscriptionId, revision: int(row, 'revision'), state: stateOf(row) };
  };
  const requireRevision = (row: Row, expected: number) => {
    if (int(row, 'revision') !== expected) deps.refuse('stale_base', 'Cet abonnement a changé depuis son affichage, par exemple dans un autre onglet. Relisez-le. Rien n’a été modifié.');
  };
  const requireTransport = (row: Row | null): string => {
    const transport = deps.transport;
    if (transport === null) deps.refuse('invalid_transition', `Ce serveur ne reçoit aucun événement : sa réception n’est pas configurée. Rien n’a été ${row ? 'activé' : 'créé'}.`);
    if (row && str(row, 'transport') !== transport) deps.refuse('invalid_transition', `Cet abonnement attend le transport « ${str(row, 'transport')} », mais ce serveur reçoit « ${transport} ». Rien n’a été activé.`);
    return transport;
  };
  const requireReady = (row: Row) => {
    requireTransport(row);
    if (!get('SELECT 1 AS x FROM bots WHERE id = ? AND deleted_at IS NULL', str(row, 'bot_id'))) deps.refuse('not_found', 'Le personnage de cet abonnement a été supprimé.');
    const account = accountRow(str(row, 'account_id'));
    if (!account || str(account, 'status') !== 'ACTIVE') {
      deps.refuse('invalid_transition', 'Le dernier état connu de ce compte n’est pas actif. Vérifiez la connexion dans Services, puis réessayez. Rien n’a été activé.');
    }
  };
  const receiptsOf = (subscriptionId: string) => `SELECT message_id FROM event_receipts WHERE subscription_id = '${subscriptionId.replaceAll("'", "''")}' AND message_id IS NOT NULL`;
  /** Every change moves the revision: requests admitted earlier no longer hold, and those still pending are cancelled. */
  function move(row: Row, set: { state?: SubscriptionState; text?: string; fields?: readonly string[]; perDay?: number }, at: string) {
    const id = str(row, 'id');
    run('UPDATE event_subscriptions SET revision = ?, state = ?, text = ?, fields = ?, per_day = ?, updated_at = ? WHERE id = ?',
      int(row, 'revision') + 1, set.state ?? stateOf(row), set.text ?? str(row, 'text'), JSON.stringify(set.fields ?? fieldsOf(row)),
      set.perDay ?? int(row, 'per_day'), at, id);
    deps.cancelPending(receiptsOf(id));
  }

  function apply(command: SubscriptionCommand): CommandResult {
    const at = now();
    switch (command.type) {
      case 'subscription.create': {
        const transport = requireTransport(null);
        if (!get('SELECT 1 AS x FROM bots WHERE id = ? AND deleted_at IS NULL', command.botId)) deps.refuse('not_found', 'Ce personnage n’existe pas ou a été supprimé.');
        if (!accountRow(command.accountId)) deps.refuse('not_found', 'Ce compte n’est pas connu de ce serveur. Connectez-le d’abord dans Services.');
        if (get('SELECT 1 AS x FROM event_subscriptions WHERE transport = ? AND trigger_id = ?', transport, command.triggerId)) {
          deps.refuse('request_conflict', 'Ce déclencheur a déjà un abonnement, même révoqué. Configurez un nouveau déclencheur chez le fournisseur pour un autre usage. Rien n’a été créé.');
        }
        if (int(get('SELECT COUNT(*) AS n FROM event_subscriptions WHERE transport = ?', transport) ?? {}, 'n') >= EVENT_LIMITS.subscriptions) {
          deps.refuse('limit_reached', `Ce transport a déjà ${EVENT_LIMITS.subscriptions} abonnements enregistrés, révoqués compris. Rien n’a été créé.`);
        }
        const subscriptionId = newId('es');
        run(`INSERT INTO event_subscriptions(id, transport, trigger_id, trigger_slug, account_id, bot_id, revision, state, text, fields, per_day, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 1, 'inactive', ?, ?, ?, ?, ?)`,
        subscriptionId, transport, command.triggerId, command.triggerSlug, command.accountId, command.botId, command.text, JSON.stringify(command.fields), command.perDay, at, at);
        return result(subscriptionId);
      }
      case 'subscription.update': {
        const row = subscriptionRow(command.subscriptionId);
        if (stateOf(row) === 'revoked') deps.refuse('invalid_transition', 'Cet abonnement est révoqué. Créez-en un nouveau sur un autre déclencheur.');
        requireRevision(row, command.expectedRevision);
        move(row, { text: command.text, fields: command.fields, perDay: command.perDay }, at);
        return result(command.subscriptionId);
      }
      case 'subscription.activate':
      case 'subscription.resume': {
        const row = subscriptionRow(command.subscriptionId);
        const from = command.type === 'subscription.activate' ? 'inactive' : 'paused';
        if (stateOf(row) !== from) deps.refuse('invalid_transition', from === 'inactive' ? 'Cet abonnement a déjà été activé.' : 'Seul un abonnement en pause peut reprendre.');
        requireRevision(row, command.expectedRevision);
        requireReady(row);
        move(row, { state: 'active' }, at);
        return result(command.subscriptionId);
      }
      case 'subscription.pause': {
        const row = subscriptionRow(command.subscriptionId);
        if (stateOf(row) !== 'active') deps.refuse('invalid_transition', stateOf(row) === 'paused' ? 'Cet abonnement est déjà en pause.' : 'Seul un abonnement actif peut être mis en pause.');
        move(row, { state: 'paused' }, at);
        return result(command.subscriptionId);
      }
      case 'subscription.revoke': {
        const row = subscriptionRow(command.subscriptionId);
        if (stateOf(row) === 'revoked') deps.refuse('invalid_transition', 'Cet abonnement est déjà révoqué.');
        move(row, { state: 'revoked' }, at);
        run('UPDATE event_receipts SET body_sha256 = NULL WHERE subscription_id = ?', command.subscriptionId);
        return result(command.subscriptionId);
      }
      default: {
        const _exhaustive: never = command;
        return _exhaustive;
      }
    }
  }

  function tally(transport: string, kind: 'ignored' | 'unavailable', at: string) {
    run(`INSERT INTO event_counters(transport, kind, n, last_at) VALUES (?, ?, 1, ?)
      ON CONFLICT(transport, kind) DO UPDATE SET n = MIN(n + 1, ${MAX_COUNTER}), last_at = excluded.last_at`, transport, kind, at);
  }

  const workOf = (messageId: string | null): string | null => {
    if (messageId === null) return null;
    const work = get('SELECT id FROM works WHERE request_message_id = ? ORDER BY rowid LIMIT 1', messageId);
    return work ? str(work, 'id') : null;
  };
  const decisionOf = (receipt: Row): Decision => {
    const reason = oneOfOrNull(receipt, 'reason', EVENT_REFUSALS);
    return reason === null ? { outcome: 'admitted', workId: workOf(strOrNull(receipt, 'message_id')) } : { outcome: 'refused', reason };
  };

  /** The first refusal that applies to a new event of this subscription, in the order the person reads them. */
  function refusalOf(sub: Row, delivery: VerifiedDelivery, at: string): EventRefusal | null {
    const state = stateOf(sub);
    if (state !== 'active') return state;
    if (!get('SELECT 1 AS x FROM bots WHERE id = ? AND deleted_at IS NULL', str(sub, 'bot_id'))) return 'bot_deleted';
    if (delivery.triggerSlug !== str(sub, 'trigger_slug')) return 'trigger_mismatch';
    if (delivery.accountId !== str(sub, 'account_id')) return 'account_mismatch';
    const account = accountRow(str(sub, 'account_id'));
    if (!account || str(account, 'status') !== 'ACTIVE') return 'account_inactive';
    const id = str(sub, 'id');
    const today = int(get(`SELECT COUNT(*) AS n FROM event_receipts WHERE subscription_id = ? AND outcome = 'admitted' AND received_at >= ?`, id, utcDay(at)) ?? {}, 'n');
    if (today >= int(sub, 'per_day')) return 'per_day';
    const open = int(get(`SELECT COUNT(*) AS n FROM works WHERE state IN (${OPEN_WORK_STATES}) AND request_message_id IN (${receiptsOf(id)})`) ?? {}, 'n');
    if (open >= EVENT_LIMITS.openWorks) return 'backlog';
    return null;
  }

  function receive(delivery: VerifiedDelivery): ReceiveOutcome {
    const outcome = transaction((): ReceiveOutcome => {
      const at = now();
      const prior = get('SELECT * FROM event_receipts WHERE transport = ? AND webhook_id = ?', delivery.transport, delivery.webhookId);
      if (prior) {
        const digest = strOrNull(prior, 'body_sha256');
        if (digest !== null && digest !== delivery.bodySha256) {
          run('UPDATE event_receipts SET conflicts = MIN(conflicts + 1, ?) WHERE transport = ? AND webhook_id = ?', MAX_COUNTER, delivery.transport, delivery.webhookId);
          return { status: 'conflict' };
        }
        return { status: 'duplicate', ...decisionOf(prior) };
      }
      const sub = get('SELECT * FROM event_subscriptions WHERE transport = ? AND trigger_id = ?', delivery.transport, delivery.triggerId);
      if (!sub) {
        tally(delivery.transport, 'ignored', at);
        return { status: 'ignored' };
      }
      if (int(get('SELECT COUNT(*) AS n FROM event_receipts WHERE transport = ?', delivery.transport) ?? {}, 'n') >= EVENT_LIMITS.receipts) {
        tally(delivery.transport, 'unavailable', at);
        return { status: 'unavailable' };
      }
      const subscriptionId = str(sub, 'id');
      // A revoked subscription keeps no body digest, like the receipts its revocation already retired.
      const insert = (decision: { reason: EventRefusal } | { messageId: string }) => run(
        `INSERT INTO event_receipts(transport, webhook_id, subscription_id, revision, body_sha256, received_at, outcome, reason, message_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        delivery.transport, delivery.webhookId, subscriptionId, int(sub, 'revision'), stateOf(sub) === 'revoked' ? null : delivery.bodySha256, at,
        'reason' in decision ? 'refused' : 'admitted', 'reason' in decision ? decision.reason : null, 'messageId' in decision ? decision.messageId : null);
      const refused = refusalOf(sub, delivery, at);
      if (refused) {
        insert({ reason: refused });
        return { status: 'new', outcome: 'refused', reason: refused };
      }
      const account = accountRow(str(sub, 'account_id'));
      const admitted = deps.admit({
        botId: str(sub, 'bot_id'), subscriptionId, webhookId: delivery.webhookId,
        text: composeEventRequest({ text: str(sub, 'text'), slug: str(sub, 'trigger_slug'), alias: account ? str(account, 'alias') : null, fields: fieldsOf(sub), data: delivery.data }),
      });
      if (!admitted.ok) {
        insert({ reason: 'admission_refused' });
        return { status: 'new', outcome: 'refused', reason: 'admission_refused' };
      }
      insert({ messageId: admitted.messageId });
      return { status: 'new', outcome: 'admitted', workId: admitted.workId };
    });
    if (outcome.status !== 'duplicate') kit.changed();
    return outcome;
  }

  function holdsRequest(messageId: string): EventHold {
    const origin = get('SELECT kind FROM origins WHERE message_id = ?', messageId);
    if (!origin || str(origin, 'kind') !== 'event') return { ok: true };
    const held = get(`SELECT 1 AS x FROM event_receipts r JOIN event_subscriptions s ON s.id = r.subscription_id
      JOIN tool_accounts a ON a.id = s.account_id
      WHERE r.message_id = ? AND r.outcome = 'admitted' AND s.state = 'active' AND s.revision = r.revision AND s.transport = ? AND a.status = 'ACTIVE'`,
    messageId, deps.transport);
    return held ? { ok: true } : { ok: false, reason: 'source_moved' };
  }

  const receiptView = (row: Row): EventReceiptView => {
    const decision = decisionOf(row);
    return {
      webhookId: str(row, 'webhook_id'), receivedAt: str(row, 'received_at'), revision: int(row, 'revision'), outcome: decision.outcome,
      reason: decision.outcome === 'refused' ? decision.reason : null, workId: decision.outcome === 'admitted' ? decision.workId : null,
      conflicts: int(row, 'conflicts'), retired: strOrNull(row, 'body_sha256') === null,
    };
  };

  function view(): EventsView {
    const at = now();
    const transport = deps.transport;
    const counter = (kind: 'ignored' | 'unavailable') => {
      const row = transport === null ? undefined : get('SELECT n, last_at FROM event_counters WHERE transport = ? AND kind = ?', transport, kind);
      return row ? { n: int(row, 'n'), lastAt: str(row, 'last_at') } : { n: 0, lastAt: null };
    };
    const subscriptions = all('SELECT * FROM event_subscriptions ORDER BY created_at, id').map((row): SubscriptionView => {
      const id = str(row, 'id');
      const account = accountRow(str(row, 'account_id'));
      const today = get(`SELECT COALESCE(SUM(outcome = 'admitted'), 0) AS admitted, COALESCE(SUM(outcome = 'refused'), 0) AS refused
        FROM event_receipts WHERE subscription_id = ? AND received_at >= ?`, id, utcDay(at)) ?? {};
      const recent = all(`SELECT * FROM event_receipts WHERE subscription_id = ? ORDER BY received_at DESC, rowid DESC LIMIT ${RECENT}`, id).map(receiptView);
      return {
        id, botId: str(row, 'bot_id'), transport: str(row, 'transport'), triggerId: str(row, 'trigger_id'), triggerSlug: str(row, 'trigger_slug'),
        accountId: str(row, 'account_id'),
        account: account ? { alias: str(account, 'alias'), toolkit: str(account, 'toolkit'), status: str(account, 'status'), checkedAt: str(account, 'checked_at') } : null,
        revision: int(row, 'revision'), state: stateOf(row), text: str(row, 'text'), fields: fieldsOf(row), perDay: int(row, 'per_day'),
        today: { admitted: int(today, 'admitted'), refused: int(today, 'refused') },
        open: int(get(`SELECT COUNT(*) AS n FROM works WHERE state IN (${OPEN_WORK_STATES}) AND request_message_id IN (${receiptsOf(id)})`) ?? {}, 'n'),
        last: recent[0] ?? null, recent,
        createdAt: str(row, 'created_at'), updatedAt: str(row, 'updated_at'),
      };
    });
    return {
      reception: transport === null ? { state: 'off' } : { state: 'configured', transport },
      receipts: transport === null ? 0 : int(get('SELECT COUNT(*) AS n FROM event_receipts WHERE transport = ?', transport) ?? {}, 'n'),
      ignored: counter('ignored'),
      unavailable: counter('unavailable'),
      subscriptions,
    };
  }

  return {
    apply,
    receive,
    holdsRequest,
    view,
    count: botId => int(get('SELECT COUNT(*) AS n FROM event_subscriptions WHERE bot_id = ?', botId) ?? {}, 'n'),
    subscriptionOf(messageId) {
      const row = get('SELECT subscription_id FROM event_receipts WHERE message_id = ?', messageId);
      return row ? str(row, 'subscription_id') : null;
    },
    markPurge(botId, erasedMessages) {
      const at = now();
      for (const row of all(`SELECT * FROM event_subscriptions WHERE bot_id = ?`, botId)) {
        run(`UPDATE event_subscriptions SET revision = revision + 1, state = 'revoked', text = '', fields = '[]', updated_at = ? WHERE id = ?`, at, str(row, 'id'));
        run('UPDATE event_receipts SET body_sha256 = NULL WHERE subscription_id = ?', str(row, 'id'));
        run(`UPDATE commands SET fingerprint = '' WHERE type LIKE 'subscription.%' AND json_extract(result, '$.subscriptionId') = ?`, str(row, 'id'));
      }
      run(`UPDATE event_receipts SET message_id = NULL, body_sha256 = NULL WHERE message_id IN (${erasedMessages})`);
    },
  };
}
