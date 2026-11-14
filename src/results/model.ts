import type { StoreView, WorkView } from "../../server/src/protocol";
import type { AgentsView } from "../../server/src/agent-protocol";
import type { Route } from "../port";

export type ResultRow = {
  id: string;
  title: string;
  botId: string | null;
  author: string | null;
  date: string;
  label: string;
  destination:
    | (Extract<Route, { page: "document" }> & { versionId: string })
    | (Extract<Route, { page: "missions" }> & { missionId: string });
};

export function results(
  view: StoreView,
  agents: AgentsView | null,
): ResultRow[] {
  const rows: ResultRow[] = view.works.flatMap((work) =>
    work.versions.map((version) => ({
      id: version.id,
      title: version.title,
      botId: work.botId,
      author: null,
      date: version.createdAt,
      label: `${version.id === work.versions.at(-1)?.id ? "Document" : "Version"} · version ${version.n}`,
      destination: { page: "document", workId: work.id, versionId: version.id },
    })),
  );
  for (const publication of view.carnet)
    rows.push({
      id: publication.id,
      title: publication.title,
      botId: publication.botId,
      author: null,
      date: publication.createdAt,
      label: `Publication · version ${publication.versionN}`,
      destination: {
        page: "document",
        workId: publication.workId,
        versionId: publication.versionId,
      },
    });
  for (const mission of agents?.missions ?? []) {
    if (mission.status !== "review" && mission.status !== "accepted") continue;
    rows.push({
      id: mission.id,
      title: mission.title,
      botId: mission.lead?.botId ?? null,
      author: mission.lead?.name ?? "Exécutant de mission",
      date: mission.updatedAt,
      label:
        mission.status === "accepted"
          ? "Mission · validée"
          : "Mission · à examiner",
      destination: { page: "missions", missionId: mission.id },
    });
  }
  return rows.sort(
    (a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id),
  );
}

export function activity(work: WorkView): string {
  const attempt = work.attempt;
  if (attempt?.state === "running") {
    switch (attempt.stage) {
      case "starting":
        return "Démarrage";
      case "thinking":
        return "Réflexion en cours";
      case "writing":
        return "Rédaction en cours";
      case null:
        return "Tentative en cours";
    }
  }
  switch (work.state) {
    case "pending":
      return "En attente";
    case "running":
      return "Travail en cours";
    case "review":
      return "À examiner";
    case "done":
      return "Validé";
    case "failed":
      return "Échec";
    case "cancelled":
      return "Annulé";
  }
}
