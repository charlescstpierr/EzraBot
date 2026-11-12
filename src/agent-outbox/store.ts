import {
  AgentCommandSchema,
  type AgentCommand,
} from "../../server/src/agent-protocol";
import type { KeyValueStorage } from "../../server/web/drafts";
import type { AgentsOutcome } from "../port";

export type OutboxEntry = {
  spaceId: string;
  command: AgentCommand;
  ownerBotIds: string[];
};

export type PendingCommand = OutboxEntry & {
  sending: boolean;
  durable: boolean;
};

export type AgentOutbox = {
  run(
    command: AgentCommand,
    ownerBotIds: readonly string[],
  ): Promise<AgentsOutcome>;
  holds(command: AgentCommand): boolean;
  pending(): readonly PendingCommand[];
  subscribe(listener: () => void): () => void;
  sync(): void;
  purge(botIds: readonly string[]): void;
};

export const OUTBOX_KEY = "mino.outbox.v1|";

type Held = { entry: OutboxEntry; durable: boolean; recoverable: boolean };

function canonical(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : item,
  );
}
function payload({ requestId: _, ...rest }: AgentCommand): string {
  return canonical(rest);
}

function parseEntry(
  raw: string | null,
  spaceId: string,
  requestId: string,
): OutboxEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(raw ?? "null");
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const {
    spaceId: space,
    command,
    ownerBotIds,
  } = value as Record<string, unknown>;
  const parsed = AgentCommandSchema.safeParse(command);
  if (
    space !== spaceId ||
    !parsed.success ||
    parsed.data.requestId !== requestId ||
    !Array.isArray(ownerBotIds) ||
    !ownerBotIds.every((id) => typeof id === "string")
  )
    return null;
  return { spaceId, command: parsed.data, ownerBotIds };
}

export function openAgentOutbox(options: {
  spaceId: string;
  storage: KeyValueStorage | null;
  send(command: AgentCommand): Promise<AgentsOutcome>;
}): AgentOutbox {
  const { spaceId, storage, send } = options;
  const prefix = `${OUTBOX_KEY}${encodeURIComponent(spaceId)}|`;
  const held = new Map<string, Held>();
  const flights = new Map<string, Promise<AgentsOutcome>>();
  const standIns = new Map<string, AgentCommand>();
  const listeners = new Set<() => void>();
  let snapshot: readonly PendingCommand[] = [];

  function publish() {
    snapshot = [...held.values()]
      .filter((item) => item.recoverable)
      .map((item) => ({
        ...item.entry,
        sending: flights.has(item.entry.command.requestId),
        durable: item.durable,
      }));
    for (const listener of listeners) listener();
  }
  function write(entry: OutboxEntry): boolean {
    if (!storage) return false;
    try {
      storage.setItem(prefix + entry.command.requestId, JSON.stringify(entry));
      return true;
    } catch {
      return false;
    }
  }
  function remove(requestId: string) {
    try {
      storage?.removeItem(prefix + requestId);
    } catch {}
  }
  function stored(): Map<string, OutboxEntry> | null {
    if (!storage) return null;
    try {
      const found = new Map<string, OutboxEntry>();
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (!key?.startsWith(prefix)) continue;
        const requestId = key.slice(prefix.length);
        const entry = parseEntry(storage.getItem(key), spaceId, requestId);
        if (entry) found.set(requestId, entry);
      }
      return found;
    } catch {
      return null;
    }
  }
  function adopt(): boolean {
    const saved = stored();
    if (!saved) return false;
    let changed = false;
    for (const [requestId, item] of held)
      if (item.durable && !saved.has(requestId)) {
        held.delete(requestId);
        changed = true;
      }
    for (const [requestId, entry] of saved) {
      const item = held.get(requestId);
      if (!item) {
        held.set(requestId, { entry, durable: true, recoverable: true });
        changed = true;
      } else if (!flights.has(requestId) && !item.recoverable) {
        item.recoverable = true;
        changed = true;
      }
    }
    return changed;
  }
  function find(command: AgentCommand): Held | undefined {
    const requestId = (standIns.get(command.requestId) ?? command).requestId;
    return (
      held.get(requestId) ??
      [...held.values()].find(
        (item) => payload(item.entry.command) === payload(command),
      )
    );
  }
  const conflict = (message: string): AgentsOutcome => ({
    kind: "rejected",
    status: 409,
    message,
  });

  adopt();
  publish();

  return {
    run(command, ownerBotIds) {
      adopt();
      const saved = find(command);
      const target =
        saved?.entry.command ?? standIns.get(command.requestId) ?? command;
      if (saved) {
        if (target.requestId !== command.requestId)
          standIns.set(command.requestId, target);
        else if (canonical(target) !== canonical(command))
          return Promise.resolve(
            conflict(
              "Cet identifiant de demande a déjà servi pour une autre commande.",
            ),
          );
      } else if (held.size && command.type !== "mission.stop") {
        let waiting = false;
        for (const [requestId, item] of held)
          if (!flights.has(requestId)) {
            item.recoverable = true;
            waiting = true;
          }
        publish();
        return Promise.resolve(
          conflict(
            waiting
              ? "Une autre commande attend encore sa confirmation. Utilisez « Réessayer la commande en attente » avant d’en envoyer une nouvelle."
              : "Une commande est en cours d’envoi. Réessayez dans un instant.",
          ),
        );
      }
      const entry: OutboxEntry = saved?.entry ?? {
        spaceId,
        command: target,
        ownerBotIds: [...new Set(ownerBotIds)],
      };
      const requestId = entry.command.requestId;
      const flying = flights.get(requestId);
      if (flying) return flying;
      held.set(requestId, {
        entry,
        durable: write(entry),
        recoverable: saved?.recoverable ?? false,
      });
      const flight = send(entry.command)
        .catch((): AgentsOutcome => ({
          kind: "unknown",
          message: "Confirmation non reçue. Réessayez le même envoi.",
        }))
        .then((outcome) => {
          flights.delete(requestId);
          const item = held.get(requestId);
          if (outcome.kind === "unknown") {
            if (item) item.recoverable = true;
          } else {
            held.delete(requestId);
            remove(requestId);
          }
          publish();
          return outcome;
        });
      flights.set(requestId, flight);
      publish();
      return flight;
    },
    holds: (command) => find(command) !== undefined,
    pending: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sync() {
      if (adopt()) publish();
    },
    purge(botIds) {
      if (!botIds.length) return;
      let changed = adopt();
      const gone = new Set(botIds);
      for (const [requestId, item] of held)
        if (item.entry.ownerBotIds.some((id) => gone.has(id))) {
          held.delete(requestId);
          remove(requestId);
          changed = true;
        }
      if (changed) publish();
    },
  };
}

export function commandOwners(
  command: AgentCommand,
  known: {
    messages: readonly { id: string; threadBotId: string }[];
    missions: readonly {
      id: string;
      originMessageId: string | null;
      lead: { botId: string } | null;
    }[];
  },
): string[] {
  const thread = (messageId: string | null | undefined) =>
    known.messages.find((message) => message.id === messageId)?.threadBotId;
  const mission =
    "missionId" in command
      ? known.missions.find((item) => item.id === command.missionId)
      : undefined;
  const owners =
    command.type === "mission.create"
      ? [command.leadBotId, thread(command.origin?.messageId)]
      : [mission?.lead?.botId, thread(mission?.originMessageId)];
  return owners.filter((id) => id !== undefined);
}
