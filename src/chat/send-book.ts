import {
  CommandSchema,
  CommandResultSchema,
  type CommandResult,
} from "../../server/src/protocol";
import type { KeyValueStorage, PromptContent } from "../../server/web/drafts";
import type { AppOutcome } from "../port";
import { isSendable, type SavedSend, type Sendable } from "./pending";

export type SendFact =
  | { kind: "queued" }
  | { kind: "unknown" }
  | { kind: "accepted"; receipt: Extract<CommandResult, { kind: "message" }> }
  | { kind: "refused"; reason: "refused" | "rejected" };
type FrozenSend = SavedSend & { draftNonce: string };
type Body = FrozenSend & {
  spaceId: string;
  writerId: string;
  departureId: string;
  savedAt: number;
};
type Final = Exclude<SendFact, { kind: "queued" }>;
type Departure = {
  ref: string;
  body: Body;
  final: Final | null;
  retired: boolean;
  frozen: boolean;
  durable: boolean;
};
export type BookEntry = FrozenSend & {
  spaceId: string;
  writerId: string;
  savedAt: number;
  fact: SendFact;
  durability: { frozen: boolean; fact: boolean };
  /** Another frozen command uses this requestId. Each command keeps only its own outcome. */
  conflict: boolean;
};
export type BookStatus =
  "durable" | "unavailable" | "storage-error" | "saturated";
export type SendAttempt =
  | { kind: "blocked"; reason: "invalid" | "conflict" | "purged" | BookStatus }
  | { kind: "settled"; outcome: AppOutcome; entry: BookEntry };

const LEGACY = "mino.send-book.v1|";
const PREFIX = "mino.send-book.v2|";
type Part = "body" | "final" | "retired";
const isPart = (s: string | undefined): s is Part =>
  s === "body" || s === "final" || s === "retired";
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;
const copy = <T>(v: T): T => structuredClone(v);
const sameCommand = (a: Sendable, b: Sendable) =>
  JSON.stringify(a) === JSON.stringify(b);
const blocked = (
  reason: Extract<SendAttempt, { kind: "blocked" }>["reason"],
): SendAttempt => ({ kind: "blocked", reason });
const byAge = (a: Departure, b: Departure) =>
  a.body.savedAt - b.body.savedAt ||
  a.body.writerId.localeCompare(b.body.writerId) ||
  a.body.departureId.localeCompare(b.body.departureId);
const slots = (entries: readonly BookEntry[]) =>
  new Set(entries.map((e) => e.command.requestId)).size;

function decode(segment: string | undefined): string | undefined {
  if (segment === undefined) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}
function keys(storage: KeyValueStorage): string[] {
  const length = storage.length;
  const found: string[] = [];
  for (let i = 0; i < length; i++) {
    const k = storage.key(i);
    if (k !== null) found.push(k);
  }
  return found;
}
function frozen(value: unknown): FrozenSend | null {
  if (
    !record(value) ||
    typeof value.draftNonce !== "string" ||
    !value.draftNonce
  )
    return null;
  const c = CommandSchema.safeParse(value.command);
  if (!c.success || !isSendable(c.data) || !record(value.raw)) return null;
  const raw = value.raw;
  if (typeof raw.text !== "string" || !Array.isArray(raw.files)) return null;
  // Reuse command validators for attachments and draft mentions, without trimming the saved draft.
  const checked = CommandSchema.safeParse({
    type: "message.say",
    requestId: c.data.requestId,
    botId: c.data.botId,
    text: c.data.text,
    attachments: raw.files,
    mentions: raw.mentions,
  });
  if (!checked.success || !isSendable(checked.data)) return null;
  let document: PromptContent["document"];
  if (raw.document !== undefined) {
    if (
      !record(raw.document) ||
      (raw.document.reviewerBotId !== null &&
        typeof raw.document.reviewerBotId !== "string")
    )
      return null;
    document = { reviewerBotId: raw.document.reviewerBotId };
  }
  return {
    command: c.data,
    draftNonce: value.draftNonce,
    raw: {
      text: raw.text,
      files: checked.data.attachments,
      ...(raw.mentions === undefined
        ? {}
        : { mentions: checked.data.mentions }),
      ...(document ? { document } : {}),
    },
  };
}
function parseBody(raw: string): Body | null {
  try {
    const v: unknown = JSON.parse(raw);
    const f = frozen(v);
    if (
      !f ||
      !record(v) ||
      typeof v.spaceId !== "string" ||
      typeof v.writerId !== "string" ||
      !v.writerId ||
      typeof v.departureId !== "string" ||
      !v.departureId ||
      typeof v.savedAt !== "number" ||
      !Number.isFinite(v.savedAt)
    )
      return null;
    return {
      ...f,
      spaceId: v.spaceId,
      writerId: v.writerId,
      departureId: v.departureId,
      savedAt: v.savedAt,
    };
  } catch {
    return null;
  }
}
function parseFinal(raw: string): Final | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (!record(v)) return null;
    switch (v.kind) {
      case "unknown":
        return { kind: "unknown" };
      case "refused":
        return v.reason === "refused" || v.reason === "rejected"
          ? { kind: "refused", reason: v.reason }
          : null;
      case "accepted": {
        const receipt = CommandResultSchema.safeParse(v.receipt);
        return receipt.success && receipt.data.kind === "message"
          ? { kind: "accepted", receipt: receipt.data }
          : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}
function legacyBot(raw: string | null): string | undefined {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    return record(value) &&
      record(value.command) &&
      typeof value.command.botId === "string"
      ? value.command.botId
      : undefined;
  } catch {
    return undefined;
  }
}
const finalOf = (outcome: AppOutcome): Final =>
  outcome.kind === "accepted" && outcome.result.kind === "message"
    ? { kind: "accepted", receipt: outcome.result }
    : outcome.kind === "refused" || outcome.kind === "rejected"
      ? { kind: "refused", reason: outcome.kind }
      : { kind: "unknown" };
function entryOf(ds: readonly Departure[], conflict: boolean): BookEntry {
  const decisive =
    ds.find((d) => d.final?.kind === "accepted") ??
    ds.find((d) => d.final?.kind === "unknown") ??
    ds.find((d) => d.final === null) ??
    ds[0];
  const { departureId: _, ...first } = ds[0].body;
  return copy({
    ...first,
    fact: decisive.final ?? { kind: "queued" },
    durability: { frozen: ds.some((d) => d.frozen), fact: decisive.durable },
    conflict,
  });
}
function project(departures: readonly Departure[]): BookEntry[] {
  const requests = new Map<string, Map<string, Departure[]>>();
  for (const d of [...departures].sort(byAge)) {
    const variants =
      requests.get(d.body.command.requestId) ?? new Map<string, Departure[]>();
    requests.set(d.body.command.requestId, variants);
    const command = JSON.stringify(d.body.command);
    variants.set(command, [...(variants.get(command) ?? []), d]);
  }
  return [...requests.values()].flatMap((variants) =>
    [...variants.values()]
      .filter((ds) => ds.some((d) => !d.retired))
      .map((ds) => entryOf(ds, variants.size > 1)),
  );
}

/**
 * A fresh instance is a fresh tab writer. Recovery only reads; run is the explicit takeover/replay gesture.
 * `randomId` must return a new value on every call: it names the page writer and each departure.
 */
export function openSendBook(options: {
  spaceId: string;
  storage: KeyValueStorage | null;
  send: (command: SavedSend["command"]) => Promise<AppOutcome>;
  randomId?: () => string;
  now?: () => number;
  capacity?: number;
  ttlMs?: number;
}) {
  const randomId = options.randomId ?? (() => crypto.randomUUID());
  const writerId = randomId();
  const now = options.now ?? Date.now;
  const capacity = options.capacity ?? 20;
  const ttl = options.ttlMs ?? 7 * 24 * 60 * 60 * 1000;
  const storage = options.storage;
  const space = encodeURIComponent(options.spaceId);
  const legacy = `${LEGACY}${space}|`;
  const prefix = `${PREFIX}${space}|`;
  const drafts = new Map<string, Body>();
  const unsaved = new Map<string, { bot: string; final: Final }>();
  const active = new Map<
    string,
    { command: Sendable; attempt: Promise<SendAttempt> }
  >();
  const gone = new Set<string>();
  let status: BookStatus = storage ? "durable" : "unavailable";

  const refOf = (body: Body) =>
    [body.command.botId, body.writerId, body.departureId]
      .map(encodeURIComponent)
      .join("|");
  const partKey = (part: Part, ref: string) => `${prefix}${part}|${ref}`;
  const barrierKey = (bot: string) =>
    `${prefix}gone|${encodeURIComponent(bot)}`;
  const barred = (store: KeyValueStorage, bot: string) =>
    gone.has(bot) || store.getItem(barrierKey(bot)) !== null;
  function split(key: string) {
    const [part, bot, ...rest] = key.slice(prefix.length).split("|");
    return {
      part,
      bot: decode(bot),
      ref: [bot, ...rest].join("|"),
      size: rest.length,
    };
  }
  function load(store: KeyValueStorage) {
    const bodies = new Map<string, Body>();
    const finals = new Map<string, Final>();
    const retired = new Set<string>();
    const fenced = new Set(gone);
    for (const key of keys(store)) {
      if (!key.startsWith(prefix)) continue;
      const { part, bot, ref, size } = split(key);
      if (part === "gone" && bot !== undefined && size === 0) fenced.add(bot);
      if (!isPart(part) || size !== 2) continue;
      const raw = store.getItem(key);
      if (raw === null) continue;
      if (part === "body") {
        const body = parseBody(raw);
        if (body?.spaceId === options.spaceId && refOf(body) === ref)
          bodies.set(ref, body);
      } else if (part === "final") {
        const final = parseFinal(raw);
        if (final) finals.set(ref, final);
      } else if (raw === "1") retired.add(ref);
    }
    const departures: Departure[] = [];
    for (const [ref, body] of bodies) {
      if (fenced.has(body.command.botId)) continue;
      const stored = finals.get(ref);
      const kept = stored ? undefined : unsaved.get(ref)?.final;
      departures.push({
        ref,
        body,
        final: stored ?? kept ?? null,
        retired: stored?.kind === "accepted" && retired.has(ref),
        frozen: true,
        durable: kept === undefined,
      });
    }
    return { departures, fenced };
  }
  function withDrafts(
    departures: Departure[],
    fenced: ReadonlySet<string>,
  ): Departure[] {
    const stored = new Set(departures.map((d) => d.body.command.requestId));
    for (const body of drafts.values())
      if (
        !stored.has(body.command.requestId) &&
        !fenced.has(body.command.botId)
      )
        departures.push({
          ref: refOf(body),
          body,
          final: null,
          retired: false,
          frozen: false,
          durable: false,
        });
    return departures;
  }
  function view(): Departure[] {
    if (!storage) return withDrafts([], gone);
    const { departures, fenced } = load(storage);
    return withDrafts(departures, fenced);
  }
  function sweep(store: KeyValueStorage): void {
    const found = keys(store)
      .filter((k) => k.startsWith(prefix))
      .map((k) => ({ key: k, ...split(k) }));
    const fenced = new Set(gone);
    for (const s of found)
      if (s.part === "gone" && s.bot !== undefined) fenced.add(s.bot);
    for (const s of found)
      if (s.part !== "gone" && s.bot !== undefined && fenced.has(s.bot))
        store.removeItem(s.key);
  }
  function purgeable(
    store: KeyValueStorage,
    key: string,
    botIds: readonly string[],
  ): boolean {
    let bot: string | undefined;
    if (key.startsWith(prefix)) {
      const parsed = split(key);
      if (parsed.part === "gone") return false;
      bot = parsed.bot;
    } else if (key.startsWith(legacy) && !key.startsWith(`${legacy}gone|`))
      bot = legacyBot(store.getItem(key));
    else return false;
    // Unreadable rows cannot identify a surviving bot and must not retain private text.
    return bot === undefined || botIds.includes(bot);
  }
  const freeze = (f: FrozenSend): Body =>
    copy({
      command: f.command,
      raw: f.raw,
      draftNonce: f.draftNonce,
      spaceId: options.spaceId,
      writerId,
      departureId: randomId(),
      savedAt: now(),
    });
  function start(f: FrozenSend): SendAttempt | Promise<SendAttempt> {
    status = storage ? "durable" : "unavailable";
    const { requestId, botId } = f.command;
    let departures: Departure[];
    try {
      if (storage ? barred(storage, botId) : gone.has(botId))
        return blocked("purged");
      if (storage) sweep(storage);
      departures = view();
    } catch {
      status = "storage-error";
      drafts.set(requestId, freeze(f));
      return blocked(status);
    }
    const same = departures
      .filter((d) => d.body.command.requestId === requestId)
      .sort(byAge);
    if (same.some((d) => !sameCommand(d.body.command, f.command)))
      return blocked("conflict");
    if (!same.length && slots(project(departures)) >= capacity) {
      status = "saturated";
      return blocked(status);
    }
    const body = freeze(same.at(0)?.body ?? f);
    if (!storage) {
      drafts.set(requestId, body);
      return blocked(status);
    }
    const ref = refOf(body);
    try {
      storage.setItem(partKey("body", ref), JSON.stringify(body));
    } catch {
      status = "storage-error";
      drafts.set(requestId, body);
      return blocked(status);
    }
    drafts.delete(requestId);
    // A purge may have written its barrier and swept between the first barrier read and this body.
    let fenced = true;
    try {
      fenced = barred(storage, botId);
    } catch {
      status = "storage-error";
    }
    if (fenced) {
      try {
        storage.removeItem(partKey("body", ref));
      } catch {
        status = "storage-error";
      }
      return blocked(status === "storage-error" ? status : "purged");
    }
    return depart(storage, body, ref);
  }
  async function depart(
    store: KeyValueStorage,
    body: Body,
    ref: string,
  ): Promise<SendAttempt> {
    let outcome: AppOutcome;
    try {
      outcome = await options.send(copy(body.command));
    } catch {
      outcome = { kind: "unknown", message: "Résultat inconnu" };
    }
    const final = finalOf(outcome);
    let durable = false;
    try {
      if (!barred(store, body.command.botId)) {
        store.setItem(partKey("final", ref), JSON.stringify(final));
        durable = true;
      }
    } catch {
      status = "storage-error";
      unsaved.set(ref, { bot: body.command.botId, final });
    }
    let entry: BookEntry | undefined;
    try {
      entry = project(view()).find((e) => sameCommand(e.command, body.command));
    } catch {
      status = "storage-error";
    }
    return {
      kind: "settled",
      outcome,
      entry:
        entry ??
        entryOf(
          [{ ref, body, final, retired: false, frozen: true, durable }],
          false,
        ),
    };
  }
  return {
    writerId,
    status: (): BookStatus =>
      status === "durable" && (drafts.size > 0 || unsaved.size > 0)
        ? "storage-error"
        : status,
    /** Read-only. When storage cannot be read, status turns to storage-error and only this page's drafts remain. */
    snapshot(botId?: string): BookEntry[] {
      let departures: Departure[];
      try {
        departures = view();
      } catch {
        status = "storage-error";
        departures = withDrafts([], gone);
      }
      return project(departures).filter(
        (r) => botId === undefined || r.command.botId === botId,
      );
    },
    run(input: FrozenSend): Promise<SendAttempt> {
      const f = frozen(input);
      if (!f) return Promise.resolve(blocked("invalid"));
      const id = f.command.requestId;
      const running = active.get(id);
      if (running)
        return sameCommand(running.command, f.command)
          ? running.attempt
          : Promise.resolve(blocked("conflict"));
      // Registered before any storage access or POST, so a synchronous re-entry joins this departure.
      let settle: (
        attempt: SendAttempt | Promise<SendAttempt>,
      ) => void = () => {};
      const attempt = new Promise<SendAttempt>((resolve) => {
        settle = resolve;
      });
      const slot = { command: f.command, attempt };
      active.set(id, slot);
      const release = () => {
        if (active.get(id) === slot) active.delete(id);
      };
      const started = start(f);
      if (started instanceof Promise) void attempt.then(release, release);
      else release();
      settle(started);
      return attempt;
    },
    /**
     * Accepted sends need server-view proof of terminal, unprotected work, and are only retired: their bytes stay
     * as a witness for a retry this collect could not see. Only known refusals lose their keys, body first.
     * Unresolved, uncertain, unsaved and divergent requests survive every cap and TTL. The first error stops.
     */
    collect(terminalUnprotectedRequestIds: readonly string[]): void {
      if (!storage) return;
      const proof = new Set(terminalUnprotectedRequestIds);
      try {
        sweep(storage);
        const departures = view();
        let used = slots(project(departures));
        const requests = new Map<string, Departure[]>();
        for (const d of departures.filter((d) => d.frozen).sort(byAge)) {
          const id = d.body.command.requestId;
          requests.set(id, [...(requests.get(id) ?? []), d]);
        }
        for (const [id, group] of requests) {
          const live = group.filter((d) => !d.retired);
          if (
            !live.length ||
            active.has(id) ||
            new Set(group.map((d) => JSON.stringify(d.body.command))).size >
              1 ||
            group.some(
              (d) =>
                !d.durable || d.final === null || d.final.kind === "unknown",
            ) ||
            (group.some((d) => d.final?.kind === "accepted") &&
              !proof.has(id)) ||
            (used < capacity && live.some((d) => now() - d.body.savedAt < ttl))
          )
            continue;
          for (const d of live)
            if (d.final?.kind === "refused") {
              storage.removeItem(partKey("body", d.ref));
              storage.removeItem(partKey("final", d.ref));
            }
          for (const d of live)
            if (d.final?.kind === "accepted")
              storage.setItem(partKey("retired", d.ref), "1");
          used = slots(project(view()));
        }
      } catch {
        status = "storage-error";
      }
    },
    /** Every barrier is durable before any deletion, so a late response or stale tab cannot restore a deleted bot. */
    purge(botIds: readonly string[]): void {
      if (!botIds.length) return;
      if (!storage) {
        status = "unavailable";
        return;
      }
      try {
        for (const bot of botIds) storage.setItem(barrierKey(bot), "1");
      } catch {
        status = "storage-error";
        return;
      }
      for (const bot of botIds) gone.add(bot);
      for (const [id, body] of drafts)
        if (botIds.includes(body.command.botId)) drafts.delete(id);
      for (const [ref, kept] of unsaved)
        if (botIds.includes(kept.bot)) unsaved.delete(ref);
      try {
        for (const key of keys(storage))
          if (purgeable(storage, key, botIds)) storage.removeItem(key);
      } catch {
        status = "storage-error";
      }
    },
  };
}
