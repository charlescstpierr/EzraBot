import {
  CommandSchema,
  CommandResultSchema,
  type CommandResult,
} from "../../server/src/protocol";
import type { KeyValueStorage, PromptContent } from "../../server/web/drafts";
import type { AppOutcome } from "../port";
import { isSendable, type SavedSend } from "./pending";

export type SendFact =
  | { kind: "queued" }
  | { kind: "unknown" }
  | { kind: "accepted"; receipt: Extract<CommandResult, { kind: "message" }> }
  | { kind: "refused"; reason: "refused" | "rejected" };
type FrozenSend = SavedSend & { draftNonce: string };
type Row = FrozenSend & {
  spaceId: string;
  writerId: string;
  savedAt: number;
  fact: SendFact;
};
export type BookEntry = Row & {
  durability: { frozen: boolean; fact: boolean };
};
export type BookStatus =
  "durable" | "unavailable" | "storage-error" | "saturated";
export type SendAttempt =
  | { kind: "blocked"; reason: "invalid" | "conflict" | "purged" | BookStatus }
  | { kind: "settled"; outcome: AppOutcome; entry: BookEntry };

const PREFIX = "mino.send-book.v1|";
const rank = (fact: SendFact) =>
  ({ queued: 0, unknown: 1, refused: 2, accepted: 3 })[fact.kind];
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;
const copy = <T>(v: T): T => structuredClone(v);

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
function parse(raw: string): Row | null {
  try {
    const v: unknown = JSON.parse(raw);
    const f = frozen(v);
    if (
      !f ||
      !record(v) ||
      typeof v.spaceId !== "string" ||
      typeof v.writerId !== "string" ||
      !v.writerId ||
      typeof v.savedAt !== "number" ||
      !Number.isFinite(v.savedAt) ||
      !record(v.fact)
    )
      return null;
    let fact: SendFact;
    switch (v.fact.kind) {
      case "queued":
      case "unknown":
        fact = { kind: v.fact.kind };
        break;
      case "refused":
        if (v.fact.reason !== "refused" && v.fact.reason !== "rejected")
          return null;
        fact = { kind: "refused", reason: v.fact.reason };
        break;
      case "accepted": {
        const receipt = CommandResultSchema.safeParse(v.fact.receipt);
        if (!receipt.success || receipt.data.kind !== "message") return null;
        fact = { kind: "accepted", receipt: receipt.data };
        break;
      }
      default:
        return null;
    }
    return {
      ...f,
      spaceId: v.spaceId,
      writerId: v.writerId,
      savedAt: v.savedAt,
      fact,
    };
  } catch {
    return null;
  }
}

/** A fresh instance is a fresh tab writer. Recovery only reads; run is the explicit takeover/replay gesture. */
export function openSendBook(options: {
  spaceId: string;
  storage: KeyValueStorage | null;
  send: (command: SavedSend["command"]) => Promise<AppOutcome>;
  randomId?: () => string;
  now?: () => number;
  capacity?: number;
  ttlMs?: number;
}) {
  const writerId = (options.randomId ?? (() => crypto.randomUUID()))();
  const now = options.now ?? Date.now;
  const capacity = options.capacity ?? 20;
  const ttl = options.ttlMs ?? 7 * 24 * 60 * 60 * 1000;
  const storage = options.storage;
  const prefix = `${PREFIX}${encodeURIComponent(options.spaceId)}|`;
  const own = new Map<string, BookEntry>();
  const active = new Map<string, Promise<SendAttempt>>();
  const gone = new Set<string>();
  let status: BookStatus = storage ? "durable" : "unavailable";
  const currentStatus = (): BookStatus => status;
  const key = (r: Row) =>
    `${prefix}${encodeURIComponent(r.writerId)}|${encodeURIComponent(r.command.requestId)}`;
  const goneKey = (bot: string) => `${prefix}gone|${encodeURIComponent(bot)}`;
  function keys(): string[] {
    try {
      return storage
        ? Array.from({ length: storage.length }, (_, i) =>
            storage.key(i),
          ).filter((k): k is string => k !== null)
        : [];
    } catch {
      status = "storage-error";
      return [];
    }
  }
  function isGone(bot: string): boolean {
    try {
      return gone.has(bot) || storage?.getItem(goneKey(bot)) === "1";
    } catch {
      status = "storage-error";
      return gone.has(bot);
    }
  }
  function rows(): BookEntry[] {
    const entries = new Map<string, BookEntry>();
    for (const k of keys()) {
      if (!k.startsWith(prefix)) continue;
      try {
        const raw = storage?.getItem(k);
        const row = raw ? parse(raw) : null;
        if (
          row &&
          row.spaceId === options.spaceId &&
          key(row) === k &&
          !isGone(row.command.botId)
        )
          entries.set(k, { ...row, durability: { frozen: true, fact: true } });
      } catch {
        status = "storage-error";
      }
    }
    for (const row of own.values())
      if (!isGone(row.command.botId)) entries.set(key(row), row);
    return [...entries.values()];
  }
  function merged(): BookEntry[] {
    const result = new Map<string, BookEntry>();
    for (const row of rows().sort(
      (a, b) => a.savedAt - b.savedAt || a.writerId.localeCompare(b.writerId),
    )) {
      const id = row.command.requestId;
      const first = result.get(id);
      if (
        !first ||
        (JSON.stringify(first.command) === JSON.stringify(row.command) &&
          rank(row.fact) > rank(first.fact))
      )
        result.set(id, row);
    }
    return [...result.values()];
  }
  function persist(row: BookEntry): boolean {
    if (!storage) {
      status = "unavailable";
      return false;
    }
    try {
      const { durability: _, ...stored } = row;
      storage.setItem(key(row), JSON.stringify(stored));
      row.durability = { frozen: true, fact: true };
      status = "durable";
      return true;
    } catch {
      status = "storage-error";
      row.durability.fact = false;
      return false;
    }
  }
  async function depart(row: BookEntry): Promise<SendAttempt> {
    let outcome: AppOutcome;
    try {
      outcome = await options.send(copy(row.command));
    } catch {
      outcome = { kind: "unknown", message: "Résultat inconnu" };
    }
    const fact: SendFact =
      outcome.kind === "accepted" && outcome.result.kind === "message"
        ? { kind: "accepted", receipt: outcome.result }
        : outcome.kind === "refused" || outcome.kind === "rejected"
          ? { kind: "refused", reason: outcome.kind }
          : { kind: "unknown" };
    const latest = merged().find(
      (r) => r.command.requestId === row.command.requestId,
    );
    const highest =
      latest && rank(latest.fact) > rank(row.fact) ? latest.fact : row.fact;
    row.fact = copy(rank(fact) > rank(highest) ? fact : highest);
    // Purging during transport must not resurrect the deleted scope when its response arrives.
    if (!isGone(row.command.botId)) persist(row);
    return { kind: "settled", outcome, entry: copy(row) };
  }
  return {
    writerId,
    status: (): BookStatus =>
      status === "durable" &&
      [...own.values()].some((r) => !r.durability.frozen || !r.durability.fact)
        ? "storage-error"
        : status,
    snapshot(botId?: string): BookEntry[] {
      return copy(
        merged().filter(
          (r) => botId === undefined || r.command.botId === botId,
        ),
      );
    },
    run(input: FrozenSend): Promise<SendAttempt> {
      status = storage ? "durable" : "unavailable";
      const f = frozen(input);
      const blocked = (
        reason: Extract<SendAttempt, { kind: "blocked" }>["reason"],
      ): Promise<SendAttempt> => Promise.resolve({ kind: "blocked", reason });
      if (!f) return blocked("invalid");
      if (isGone(f.command.botId)) return blocked("purged");
      const all = rows();
      const same = all.filter(
        (r) => r.command.requestId === f.command.requestId,
      );
      if (
        same.some(
          (r) => JSON.stringify(r.command) !== JSON.stringify(f.command),
        )
      )
        return blocked("conflict");
      const running = active.get(f.command.requestId);
      if (running) return running;
      if (!same.length && merged().length >= capacity) {
        status = "saturated";
        return blocked(status);
      }
      const previous = merged().find(
        (r) => r.command.requestId === f.command.requestId,
      );
      const row: BookEntry = {
        ...(previous ?? f),
        spaceId: options.spaceId,
        writerId,
        savedAt: previous?.savedAt ?? now(),
        fact: copy(previous?.fact ?? { kind: "queued" }),
        durability: {
          frozen: previous?.durability.frozen ?? false,
          fact: false,
        },
      };
      own.set(f.command.requestId, row);
      if (currentStatus() === "storage-error" || !persist(row))
        return blocked(status);
      const promise = depart(row).finally(() =>
        active.delete(f.command.requestId),
      );
      active.set(f.command.requestId, promise);
      return promise;
    },
    /** Only a complete server-view proof of terminal, unprotected work may make an accepted pointer collectible.
     * Readers never collect another writer. Unknown/queued entries survive every cap and TTL.
     */
    collect(terminalUnprotectedRequestIds: readonly string[]): void {
      const eligible = new Set(terminalUnprotectedRequestIds);
      const all = merged();
      let count = all.length;
      for (const row of rows().sort((a, b) => a.savedAt - b.savedAt)) {
        if (
          row.writerId !== writerId ||
          row.fact.kind !== "accepted" ||
          !eligible.has(row.command.requestId) ||
          rows().some(
            (other) =>
              other.command.requestId === row.command.requestId &&
              other.fact.kind !== "accepted",
          ) ||
          active.has(row.command.requestId) ||
          (now() - row.savedAt < ttl && count < capacity)
        )
          continue;
        try {
          storage?.removeItem(key(row));
          own.delete(row.command.requestId);
          count--;
        } catch {
          status = "storage-error";
        }
      }
    },
    /** Deletion is the sole cross-writer write. The marker also blocks a late response or stale tab. */
    purge(botIds: readonly string[]): void {
      for (const bot of botIds) {
        gone.add(bot);
        try {
          if (storage) storage.setItem(goneKey(bot), "1");
          else status = "unavailable";
        } catch {
          status = "storage-error";
        }
      }
      for (const row of rowsIncludingGone()) {
        if (!botIds.includes(row.command.botId)) continue;
        own.delete(row.command.requestId);
        try {
          storage?.removeItem(key(row));
        } catch {
          status = "storage-error";
        }
      }
    },
  };
  function rowsIncludingGone(): Row[] {
    const found: Row[] = [...own.values()];
    for (const k of keys())
      if (k.startsWith(prefix)) {
        try {
          const raw = storage?.getItem(k);
          const row = raw ? parse(raw) : null;
          if (row && key(row) === k) found.push(row);
        } catch {
          status = "storage-error";
        }
      }
    return found;
  }
}
