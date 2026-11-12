import { z } from "zod";
import {
  CommandSchema,
  DeviceSessionSchema,
  BrowserSessionSchema,
  MobileReplySchema,
  MobileSnapshotSchema,
  PairClaimSchema,
  PairGrantSchema,
  PairStatusSchema,
  type Command,
  type BrowserSession,
  type MobileSnapshot,
  type PairGrant,
} from "./generated/mobile-protocol";

export type Connection =
  | { kind: "unpaired" }
  | { kind: "pairing"; confirmCode: string }
  | { kind: "online" }
  | { kind: "offline"; message: string }
  | { kind: "revoked"; message: string };
const DraftSchema = z.object({
  text: z.string(),
  mentions: z.array(
    z.object({ botId: z.string(), start: z.number(), end: z.number() }),
  ),
});
export type Draft = z.infer<typeof DraftSchema>;
const PendingSchema = z
  .object({
    bytes: z.string(),
    command: CommandSchema,
    state: z.enum(["queued", "unknown", "refused"]),
    message: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    try {
      const decoded = CommandSchema.parse(JSON.parse(value.bytes));
      if (
        JSON.stringify(decoded) !== JSON.stringify(value.command) ||
        decoded.type === "bot.select" ||
        decoded.type === "storage.purge"
      )
        throw Error("invalid outbox");
    } catch {
      ctx.addIssue({ code: "custom", message: "Commande locale corrompue." });
    }
  });
export type Pending = z.infer<typeof PendingSchema>;
const LocalSchema = z.object({
  drafts: z.record(z.string(), DraftSchema),
  selected: z.string(),
  queue: z.array(PendingSchema),
  snapshot: MobileSnapshotSchema.nullable(),
  lastSeen: z.number().nullable(),
});
type Local = z.infer<typeof LocalSchema>;
const SecretSchema = z.object({
  session: z.union([DeviceSessionSchema, BrowserSessionSchema]),
  claim: PairClaimSchema.nullable(),
});
export type Secret = z.infer<typeof SecretSchema>;
export type Session = Secret['session'];
export type Storage = {
  readSecret(): Promise<string | null>;
  writeSecret(value: string | null): Promise<void>;
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
};
export type Transport = (
  session: Session,
  path: string,
  body?: string,
  signal?: AbortSignal,
) => Promise<unknown>;
export class RemoteError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function safeBase(raw: string, allowDevWeb = false): string {
  const url = new URL(raw);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw Error("Adresse PC invalide.");
  if (
    url.protocol !== "https:" &&
    !(
      allowDevWeb &&
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    throw Error("Une adresse HTTPS est obligatoire sur téléphone.");
  return url.toString().replace(/\/$/, "");
}
export function parseGrant(raw: string, allowDevWeb = false): PairGrant {
  const decoded = raw.trim().startsWith("{")
    ? raw
    : new URL(raw).searchParams.get("grant");
  if (!decoded)
    throw Error("Collez le JSON du QR ou une URI avec ?grant=JSON.");
  const grant = PairGrantSchema.parse(JSON.parse(decoded));
  if (
    !Number.isFinite(Date.parse(grant.expiresAt)) ||
    Date.parse(grant.expiresAt) <= Date.now()
  )
    throw Error("Association expirée. Recréez le QR sur le PC.");
  return { ...grant, url: safeBase(grant.url, allowDevWeb) };
}
const blank = (): Local => ({
  drafts: {},
  selected: "",
  queue: [],
  snapshot: null,
  lastSeen: null,
});
export const scope = (s: Session) => `mino:${s.spaceId}:${s.deviceId}`;
function targetsPurged(command: Command, snapshot: MobileSnapshot): boolean {
  if ("botId" in command && snapshot.purged.botIds.includes(command.botId))
    return true;
  if (
    "reviewerBotId" in command &&
    command.reviewerBotId &&
    snapshot.purged.botIds.includes(command.reviewerBotId)
  )
    return true;
  if (
    "mentions" in command &&
    command.mentions?.some((m) => snapshot.purged.botIds.includes(m.botId))
  )
    return true;
  if ("workId" in command && snapshot.purged.workIds.includes(command.workId))
    return true;
  if (
    "taskId" in command &&
    !snapshot.tasks.some((t) => t.id === command.taskId)
  )
    return true;
  if (
    "proposalId" in command &&
    !snapshot.works.some((w) =>
      w.proposals.some((p) => p.id === command.proposalId),
    ) &&
    !snapshot.tasks.some((t) =>
      t.proposals.some((p) => p.id === command.proposalId),
    )
  )
    return true;
  return false;
}
type RefreshFlight = {
  secret: Secret;
  controller: AbortController;
  poll: AbortController | null;
  promise: Promise<void>;
};
export class Controller {
  newMessageIds = new Set<string>();
  connection: Connection = { kind: "unpaired" };
  local = blank();
  private secret: Secret | null = null;
  private listeners = new Set<() => void>();
  private writer: Promise<unknown> = Promise.resolve();
  private refreshFlight: RefreshFlight | null = null;
  constructor(
    private storage: Storage,
    private transport: Transport,
    private allowDevWeb = false,
  ) {}
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private emit() {
    for (const fn of this.listeners) fn();
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writer.then(fn, fn);
    this.writer = next.catch(() => {});
    return next;
  }
  private async save() {
    if (this.secret)
      await this.storage.write(
        scope(this.secret.session),
        JSON.stringify(this.local),
      );
  }
  private async reset(message: string) {
    const old = this.secret;
    this.refreshFlight?.controller.abort();
    this.secret = null;
    this.newMessageIds = new Set();
    this.local = blank();
    this.connection = { kind: "revoked", message };
    this.emit();
    await this.storage.writeSecret(null);
    if (old) await this.storage.remove(scope(old.session));
  }
  private async fail(error: unknown) {
    if (error instanceof RemoteError && this.secret?.claim && error.status >= 400 && error.status < 500 && error.status !== 429) {
      await this.reset(error.message); return;
    }
    if (
      error instanceof RemoteError &&
      (error.status === 401 || error.code === "space_mismatch")
    ) {
      await this.reset(
        error.code === "space_mismatch"
          ? "Base PC différente. Associez à nouveau cet appareil."
          : "Association révoquée ou expirée.",
      );
      return;
    }
    this.connection = {
      kind: "offline",
      message: error instanceof RemoteError ? error.message : "PC injoignable. Les données affichées sont anciennes.",
    };
    this.emit();
  }
  async boot() {
    return this.serial(async () => {
      const raw = await this.storage.readSecret();
      if (!raw) return;
      try {
        this.secret = SecretSchema.parse(JSON.parse(raw));
        safeBase(this.secret.session.url, this.allowDevWeb);
        const cached = await this.storage.read(scope(this.secret.session));
        if (cached) {
          this.local = LocalSchema.parse(JSON.parse(cached));
          if (
            this.local.snapshot &&
            this.local.snapshot.spaceId !== this.secret.session.spaceId
          )
            throw Error("Cache belongs to another space");
          this.local.queue = this.local.queue.map((p) => ({
            ...p,
            state: p.state === "refused" ? "refused" : "unknown",
          }));
        }
        this.connection = this.secret.claim || 'kind' in this.secret.session
          ? { kind: "pairing", confirmCode: "" }
          : { kind: "offline", message: "Connexion au PC…" };
        this.emit();
      } catch {
        await this.reset("Données locales invalides. Associez à nouveau.");
      }
    });
  }
  async pair(
    grant: PairGrant,
    device: { deviceId: string; deviceName: string; deviceToken: string },
  ) {
    return this.serial(async () => {
      if (this.secret) await this.reset("Nouvelle association.");
      const claim = PairClaimSchema.parse({
        pairingId: grant.pairingId,
        secret: grant.secret,
        ...device,
      });
      this.secret = {
        session: {
          url: grant.url,
          spaceId: grant.spaceId,
          deviceId: device.deviceId,
          token: device.deviceToken,
        },
        claim,
      };
      await this.storage.writeSecret(JSON.stringify(this.secret));
      this.connection = { kind: "pairing", confirmCode: "" };
      this.emit();
    });
  }
  async connectBrowser(session: BrowserSession) {
    return this.serial(async () => {
      const parsed = BrowserSessionSchema.parse(session);
      safeBase(parsed.url);
      if (this.secret && scope(this.secret.session) !== scope(parsed))
        throw Error('Déconnecte cet appareil avant de changer de connexion.');
      this.refreshFlight?.controller.abort();
      this.secret = { session: parsed, claim: null };
      await this.storage.writeSecret(JSON.stringify(this.secret));
      this.connection = { kind: 'pairing', confirmCode: '' };
      this.emit();
    });
  }
  pause() {
    this.refreshFlight?.controller.abort();
    if (this.connection.kind === "online") {
      this.connection = {
        kind: "offline",
        message: "Dernière observation avant la mise en arrière-plan.",
      };
      this.emit();
    }
  }
  async forget(message = "Appareil déconnecté. Révoquez aussi cet appareil sur le PC.") {
    return this.serial(() =>
      this.reset(message),
    );
  }
  setDraft(botId: string, draft: Draft) {
    this.local = {
      ...this.local,
      drafts: { ...this.local.drafts, [botId]: draft },
    };
    this.emit();
    return this.serial(() => this.save());
  }
  select(botId: string) {
    this.local = { ...this.local, selected: botId };
    this.emit();
    return this.serial(() => this.save());
  }
  private async apply(snapshot: MobileSnapshot) {
    if (snapshot.spaceId !== this.secret?.session.spaceId)
      throw new RemoteError(409, "space_mismatch", "Base différente");
    if (this.local.snapshot && snapshot.rev <= this.local.snapshot.rev) return;
    this.newMessageIds = new Set(
      this.local.snapshot
        ? snapshot.messages
            .filter(
              (m) =>
                !this.local.snapshot?.messages.some((old) => old.id === m.id),
            )
            .map((m) => m.id)
        : [],
    );
    const drafts = { ...this.local.drafts };
    for (const id of snapshot.purged.botIds) delete drafts[id];
    this.local = {
      ...this.local,
      snapshot,
      drafts,
      queue: this.local.queue.filter(
        (p) => !targetsPurged(p.command, snapshot),
      ),
      lastSeen: Date.now(),
      selected: snapshot.bots.some((b) => b.id === this.local.selected)
        ? this.local.selected
        : (snapshot.bots[0]?.id ?? ""),
    };
    await this.save();
    this.emit();
  }
  private current(flight: RefreshFlight) {
    return this.secret === flight.secret && !flight.controller.signal.aborted;
  }
  private request(
    flight: RefreshFlight,
    path: string,
    body?: string,
    signal = flight.controller.signal,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Error("Requête annulée."));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        signal.removeEventListener("abort", abort);
        abort();
        return;
      }
      Promise.resolve()
        .then(() => {
          if (signal.aborted) throw new Error("Requête annulée.");
          return this.transport(flight.secret.session, path, body, signal);
        })
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }
  async refresh(signal?: AbortSignal) {
    const flight = await this.serial(async () => {
      if (!this.secret || signal?.aborted) return null;
      if (this.refreshFlight && this.current(this.refreshFlight))
        return this.refreshFlight;
      const next: RefreshFlight = {
        secret: this.secret,
        controller: new AbortController(),
        poll: null,
        promise: Promise.resolve(),
      };
      const abort = () => next.controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      this.refreshFlight = next;
      next.promise = Promise.resolve()
        .then(() => this.runRefresh(next))
        .finally(() => {
          signal?.removeEventListener("abort", abort);
          if (this.refreshFlight === next) this.refreshFlight = null;
        });
      return next;
    });
    await flight?.promise;
  }
  private async runRefresh(flight: RefreshFlight) {
    const { secret } = flight;
    try {
      const pairing = await this.serial(async () =>
        this.current(flight) &&
        (secret.claim !== null || 'kind' in secret.session || this.connection.kind === "pairing"),
      );
      if (!this.current(flight)) return;
      if (secret.claim) {
        const status = PairStatusSchema.parse(
          await this.request(
            flight,
            "/m/pair/claim",
            JSON.stringify(secret.claim),
          ),
        );
        await this.serial(async () => {
          if (!this.current(flight)) return;
          if (
            status.deviceId !== secret.session.deviceId ||
            status.spaceId !== secret.session.spaceId
          )
            throw new RemoteError(409, "space_mismatch", "Association différente");
          this.connection = { kind: "pairing", confirmCode: status.confirmCode };
          this.emit();
        });
      }
      if (pairing) {
        if (!this.current(flight)) return;
        const status = PairStatusSchema.parse(
          await this.request(flight, "/m/pair/status"),
        );
        const active = await this.serial(async () => {
          if (!this.current(flight)) return false;
          if (
            status.deviceId !== secret.session.deviceId ||
            status.spaceId !== secret.session.spaceId
          )
            throw new RemoteError(409, "space_mismatch", "Association différente");
          if (status.state === "revoked" || status.state === "expired") {
            await this.reset("Association révoquée ou expirée.");
            return false;
          }
          if (status.state !== "active") {
            this.connection = { kind: "pairing", confirmCode: status.confirmCode };
            this.emit();
            return false;
          }
          secret.claim = null;
          await this.storage.writeSecret(JSON.stringify(secret));
          return true;
        });
        if (!active) return;
      }
      while (this.current(flight)) {
        const poll = await this.serial(async () => {
          if (!this.current(flight)) return null;
          const controller = new AbortController();
          const abort = () => controller.abort();
          flight.controller.signal.addEventListener("abort", abort, { once: true });
          const waiting = this.local.queue.length === 0;
          if (waiting) flight.poll = controller;
          return {
            controller,
            abort,
            waiting,
            path: waiting
              ? `/m/view?after=${this.local.snapshot?.rev ?? 0}`
              : "/m/view",
          };
        });
        if (!poll) return;
        try {
          const snapshot = MobileSnapshotSchema.parse(
            await this.request(flight, poll.path, undefined, poll.controller.signal),
          );
          await this.serial(async () => {
            if (!this.current(flight) || poll.controller.signal.aborted) return;
            await this.apply(snapshot);
            if (!this.current(flight)) return;
            this.connection = { kind: "online" };
            this.emit();
          });
        } catch (error) {
          if (
            poll.waiting &&
            poll.controller.signal.aborted &&
            this.current(flight)
          )
            continue;
          throw error;
        } finally {
          flight.controller.signal.removeEventListener("abort", poll.abort);
          if (flight.poll === poll.controller) flight.poll = null;
        }
        if (poll.controller.signal.aborted && this.current(flight)) continue;
        await this.flush(flight);
        return;
      }
    } catch (error) {
      await this.serial(async () => {
        if (this.current(flight)) await this.fail(error);
      });
    }
  }
  enqueue(command: Command, sentDraft?: Draft) {
    return this.serial(async () => {
      if (!this.secret || this.secret.claim || this.connection.kind === 'pairing')
        throw Error("Associez cet appareil avant l’envoi.");
      CommandSchema.parse(command);
      if (command.type === "bot.select" || command.type === "storage.purge")
        throw Error("Commande réservée au PC.");
      if (
        this.local.queue.some((p) => p.command.requestId === command.requestId)
      )
        throw Error("Identifiant déjà en attente.");
      if (
        command.type === "publication.approve" &&
        (this.connection.kind !== "online" ||
          this.local.queue.length ||
          Object.values(this.local.drafts).some((d) => d.text.trim()))
      )
        throw Error(
          "Approbation disponible en ligne, sans brouillon ni envoi en attente.",
        );
      const previousDraft =
        sentDraft && "botId" in command
          ? this.local.drafts[command.botId]
          : undefined;
      const clearedDraft: Draft = { text: "", mentions: [] };
      this.local.queue.push({
        command,
        bytes: JSON.stringify(command),
        state: "queued",
      });
      if (
        sentDraft &&
        "botId" in command &&
        JSON.stringify(this.local.drafts[command.botId]) ===
          JSON.stringify(sentDraft)
      )
        this.local.drafts[command.botId] = clearedDraft;
      try {
        await this.save();
      } catch (error) {
        this.local.queue = this.local.queue.filter(
          (p) => p.command.requestId !== command.requestId,
        );
        if (
          "botId" in command &&
          previousDraft &&
          this.local.drafts[command.botId] === clearedDraft
        )
          this.local.drafts[command.botId] = previousDraft;
        this.emit();
        throw error;
      }
      this.refreshFlight?.poll?.abort();
      this.emit();
    });
  }
  private async flush(flight: RefreshFlight) {
    while (this.current(flight)) {
      const item = await this.serial(async () => {
        if (!this.current(flight)) return null;
        const first = this.local.queue[0];
        if (
          !first ||
          first.state === "refused" ||
          (first.state === "unknown" &&
            first.command.type === "publication.approve")
        )
          return null;
        first.state = "unknown";
        await this.save();
        this.emit();
        return first;
      });
      if (!item || !this.current(flight)) return;
      const response = MobileReplySchema.parse(
        await this.request(flight, "/m/commands", item.bytes),
      );
      const accepted = await this.serial(async () => {
        if (!this.current(flight)) return false;
        if (response.view) await this.apply(response.view);
        if (response.ok)
          this.local.queue = this.local.queue.filter((p) => p !== item);
        else if (this.local.queue.includes(item)) {
          item.state = "refused";
          item.message = response.message;
        }
        await this.save();
        this.emit();
        return response.ok;
      });
      if (!accepted) return;
    }
  }
  retry(requestId: string) {
    return this.serial(async () => {
      const p = this.local.queue.find((p) => p.command.requestId === requestId);
      if (p) {
        p.state = "queued";
        await this.save();
        this.refreshFlight?.poll?.abort();
        this.emit();
      }
    });
  }
  discard(requestId: string) {
    return this.serial(async () => {
      this.local.queue = this.local.queue.filter(
        (p) => p.command.requestId !== requestId,
      );
      await this.save();
      this.emit();
    });
  }
}
