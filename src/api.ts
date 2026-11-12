import type { AppView, Command } from "../server/src/protocol";
import type { AgentsView, AgentCommand } from "../server/src/agent-protocol";
export async function get<T>(url: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { signal });
  if (!r.ok)
    throw Error(
      `Service indisponible (${r.status}). Vos données restent sur le PC.`,
    );
  return r.json();
}
export class CommandRefusal extends Error {}
export async function command(
  input: Command | AgentCommand,
  agent = false,
): Promise<AppView | AgentsView> {
  const r = await fetch(agent ? "/api/agents/commands" : "/api/commands", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mino-csrf":
        document.querySelector<HTMLMetaElement>("meta[name=mino-csrf]")
          ?.content ?? "",
    },
    body: JSON.stringify(input),
  });
  const data = await r.json();
  if (!data.ok)
    throw new CommandRefusal(data.message ?? "La commande a été refusée.");
  return data.view;
}
export const uid = () => crypto.randomUUID();
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
