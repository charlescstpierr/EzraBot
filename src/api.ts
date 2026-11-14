import {
  CommandResultSchema,
  type Command,
  type RefusalCode,
} from "../server/src/protocol";
import {
  TOOL_REFUSALS,
  ToolResultSchema,
  ToolsReplySchema,
  type PcView,
  type ToolCommand,
  type ToolRefusalCode,
  type ToolsReply,
  type ToolsReplyOf,
} from "../server/src/tools-protocol";
import {
  MEMORY_REFUSALS,
  MemoryResultSchema,
  ProvenanceSchema,
  type MemoryCommand,
  type MemoryRefusalCode,
  type Provenance,
} from "../server/src/memory-protocol";
import type {
  AgentsView,
  AgentCommand,
  AgentRefusalCode,
} from "../server/src/agent-protocol";
import type { CommandRunner, MissionResponse } from "./port";

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal });
  if (!response.ok)
    throw Error(
      `Service indisponible (${response.status}). Vos données restent sur le PC.`,
    );
  return response.json();
}
export const getAppView = async (signal?: AbortSignal, after?: number) =>
  (await getJson(
    after === undefined ? "/api/view" : `/api/view?after=${after}`,
    signal,
  )) as PcView;
export const getAgentsView = async (signal?: AbortSignal) =>
  (await getJson("/api/agents/view", signal)) as AgentsView;
export const getMission = async (id: string, signal?: AbortSignal) =>
  (await getJson(
    `/api/agents/missions/${encodeURIComponent(id)}`,
    signal,
  )) as MissionResponse;
export const uid = () => crypto.randomUUID();
const appCodes = {
  invalid_command: true,
  request_conflict: true,
  not_found: true,
  invalid_transition: true,
  stale_base: true,
  cross_work: true,
  not_current: true,
  proposal_closed: true,
  approval_mismatch: true,
  limit_reached: true,
  unknown_shape: true,
  choice_unavailable: true,
  busy: true,
} satisfies Record<RefusalCode, true>;
const agentCodes = {
  invalid_command: true,
  not_found: true,
  path_refused: true,
  busy: true,
  budget: true,
  stale: true,
  state: true,
  unavailable: true,
  duplicate: true,
} satisfies Record<AgentRefusalCode, true>;
const isToolCode = (code: unknown): code is ToolRefusalCode =>
  TOOL_REFUSALS.some((known) => known === code);
const isMemoryCode = (code: unknown): code is MemoryRefusalCode =>
  MEMORY_REFUSALS.some((known) => known === code);
/** The sources one reply was composed with, as the server reads them now. */
export async function getProvenance(
  messageId: string,
  signal?: AbortSignal,
): Promise<Provenance> {
  const data = await getJson(
    `/api/memory/provenance?messageId=${encodeURIComponent(messageId)}`,
    signal,
  );
  if (!isRecord(data)) throw Error("Réponse inattendue du service.");
  const { ok: _ok, ...provenance } = data;
  const parsed = ProvenanceSchema.safeParse(provenance);
  if (!parsed.success) throw Error("Réponse inattendue du service.");
  return parsed.data;
}
const csrfToken = () =>
  document.querySelector<HTMLMetaElement>('meta[name="mino-csrf"]')?.content ??
  "";
/**
 * One exchange with the PC-only tools routes. The answer is parsed against the server's own schema.
 * A connection address in a `link` answer is returned to the caller only: nothing here keeps it.
 */
export async function toolsRequest<K extends ToolsReply["kind"]>(
  kind: K,
  route: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<ToolsReplyOf<K>> {
  const response = await fetch(`/api/tools/${route}`, {
    signal,
    cache: "no-store",
    headers: {
      "x-mino-csrf": csrfToken(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined
      ? {}
      : { method: "POST", body: JSON.stringify(body) }),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!isRecord(data) || data.ok !== true) {
    throw Error(
      isRecord(data) && typeof data.message === "string"
        ? data.message
        : `Service indisponible (${response.status}).`,
    );
  }
  const { ok: _ok, ...reply } = data;
  const parsed = ToolsReplySchema.safeParse(reply);
  if (!parsed.success || parsed.data.kind !== kind)
    throw Error("Réponse inattendue du service.");
  return parsed.data as ToolsReplyOf<K>;
}
const isAppCode = (code: unknown): code is RefusalCode =>
  typeof code === "string" && Object.hasOwn(appCodes, code);
const isAgentCode = (code: unknown): code is AgentRefusalCode =>
  typeof code === "string" && Object.hasOwn(agentCodes, code);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export function createRunner(
  apply: { app(view: PcView): void; agents(view: AgentsView): void },
  transport: typeof fetch = fetch,
  csrf: () => string = csrfToken,
): CommandRunner {
  async function post(
    command: Command | AgentCommand | ToolCommand | MemoryCommand,
    url:
      | "/api/commands"
      | "/api/agents/commands"
      | "/api/tools/commands"
      | "/api/memory/commands",
  ): Promise<
    | { kind: "unknown"; message: string }
    | { kind: "response"; data: Record<string, unknown>; status: number }
  > {
    try {
      const response = await transport(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-mino-csrf": csrf(),
        },
        body: JSON.stringify(command),
      });
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        return {
          kind: "unknown",
          message: "Réponse illisible. Réessayez avec le même envoi.",
        };
      }
      if (response.status >= 500)
        return {
          kind: "unknown",
          message:
            isRecord(data) && typeof data.message === "string"
              ? data.message
              : "Le service ne confirme pas le résultat. Réessayez avec le même envoi.",
        };
      if (!isRecord(data))
        return {
          kind: "unknown",
          message: "Réponse inattendue du service.",
        };
      return { kind: "response", data, status: response.status };
    } catch {
      return {
        kind: "unknown",
        message:
          "Connexion interrompue. Le résultat est inconnu. Réessayez avec le même envoi.",
      };
    }
  }
  return {
    async app(input) {
      const received = await post(input, "/api/commands");
      if (received.kind === "unknown") return received;
      const { data, status } = received;
      const view = isRecord(data.view) ? (data.view as PcView) : null;
      if (view) apply.app(view);
      if (data.ok === true && view) {
        const result = CommandResultSchema.safeParse(data.result);
        if (result.success)
          return {
            kind: "accepted",
            view,
            result: result.data,
            replayed: data.replayed === true,
          };
      }
      if (data.ok === false && typeof data.message === "string") {
        if (view && isAppCode(data.code))
          return {
            kind: "refused",
            view,
            code: data.code,
            message: data.message,
          };
        if (status >= 400)
          return { kind: "rejected", status, message: data.message };
      }
      return {
        kind: "unknown",
        message:
          "Le service ne confirme pas cette commande. Conservez cet envoi pour réessayer.",
      };
    },
    async tools(input) {
      const received = await post(input, "/api/tools/commands");
      if (received.kind === "unknown") return received;
      const { data, status } = received;
      const view = isRecord(data.view) ? (data.view as PcView) : null;
      if (view) apply.app(view);
      if (data.ok === true && view) {
        const result = ToolResultSchema.safeParse(data.result);
        if (result.success)
          return {
            kind: "accepted",
            view,
            result: result.data,
            replayed: data.replayed === true,
          };
      }
      if (data.ok === false && typeof data.message === "string") {
        if (view && isToolCode(data.code))
          return {
            kind: "refused",
            view,
            code: data.code,
            message: data.message,
          };
        if (status >= 400)
          return { kind: "rejected", status, message: data.message };
      }
      return {
        kind: "unknown",
        message:
          "Le service ne confirme pas cette décision. Réessayez la même action : elle ne sera pas appliquée deux fois.",
      };
    },
    async memory(input) {
      const received = await post(input, "/api/memory/commands");
      if (received.kind === "unknown") return received;
      const { data, status } = received;
      const view = isRecord(data.view) ? (data.view as PcView) : null;
      if (view) apply.app(view);
      if (data.ok === true && view) {
        const result = MemoryResultSchema.safeParse(data.result);
        if (result.success)
          return {
            kind: "accepted",
            view,
            result: result.data,
            replayed: data.replayed === true,
          };
      }
      if (data.ok === false && typeof data.message === "string") {
        if (view && isMemoryCode(data.code))
          return {
            kind: "refused",
            view,
            code: data.code,
            message: data.message,
          };
        if (status >= 400)
          return { kind: "rejected", status, message: data.message };
      }
      return {
        kind: "unknown",
        message:
          "Le service ne confirme pas cette commande. Réessayez la même action : elle ne sera pas appliquée deux fois.",
      };
    },
    async agents(input) {
      const received = await post(input, "/api/agents/commands");
      if (received.kind === "unknown") return received;
      const { data, status } = received;
      const view = isRecord(data.view) ? (data.view as AgentsView) : null;
      if (view) apply.agents(view);
      if (data.ok === true && view && typeof data.id === "string")
        return {
          kind: "accepted",
          view,
          result: { id: data.id },
          replayed: data.replayed === true,
        };
      if (data.ok === false && typeof data.message === "string") {
        if (view && isAgentCode(data.code))
          return {
            kind: "refused",
            view,
            code: data.code,
            message: data.message,
          };
        if (status >= 400)
          return { kind: "rejected", status, message: data.message };
      }
      return {
        kind: "unknown",
        message:
          "Le service ne confirme pas cette commande. Conservez cet envoi pour réessayer.",
      };
    },
  };
}
export const statuses: Record<string, string> = {
  pending: "En attente",
  queued: "En attente",
  running: "En cours",
  review: "À examiner",
  done: "Terminé",
  accepted: "Validé",
  failed: "Échec",
  cancelled: "Annulé",
  stopping: "Arrêt demandé",
  stopped: "Arrêté",
  interrupted: "Résultat inconnu",
  outdated: "Objectif modifié",
  waiting: "Décision attendue",
};
