import type { RunStage, WorkView } from "../../server/src/protocol";
import { uid } from "../api";
import type { Port } from "../port";
import { CommandButton } from "./command";

const STAGES: Record<RunStage, string> = {
  starting: "Démarrage de l’appel…",
  thinking: "Réflexion…",
  writing: "Rédaction…",
};

export function AcceptButton({
  port,
  work,
  blocked = null,
}: {
  port: Port;
  work: WorkView;
  blocked?: string | null;
}) {
  return (
    <CommandButton
      run={port.run}
      disabled={blocked !== null}
      title={blocked ?? undefined}
      make={() => ({ type: "work.accept", requestId: uid(), workId: work.id })}
    >
      Valider le document
    </CommandButton>
  );
}

export function NonTaskWorkControls({
  port,
  work,
}: {
  port: Port;
  work: WorkView;
}) {
  if (work.state === "pending" || work.state === "running")
    return (
      <CommandButton
        run={port.run}
        make={() => ({
          type: "work.cancel",
          requestId: uid(),
          workId: work.id,
        })}
      >
        {work.state === "running" ? "Arrêter" : "Annuler"}
      </CommandButton>
    );
  if (work.state !== "failed" && work.state !== "cancelled") return null;
  if (!port.view.bots.some((bot) => bot.id === work.botId))
    return (
      <p className="ez-doc-muted">
        Ce bot a été supprimé : ce travail ne peut plus être relancé.
      </p>
    );
  return (
    <CommandButton
      run={port.run}
      make={() => ({ type: "work.retry", requestId: uid(), workId: work.id })}
    >
      Relancer
    </CommandButton>
  );
}

export function workNote(work: WorkView, busyElsewhere: boolean): string {
  switch (work.state) {
    case "pending":
      return busyElsewhere
        ? "En attente : un autre travail passe avant."
        : "En attente.";
    case "running":
      return STAGES[work.attempt?.stage ?? "starting"];
    case "failed":
      return work.attempt?.error ?? "L’appel a échoué.";
    case "cancelled":
      return "Arrêté à votre demande.";
    case "review":
      return "Le document est prêt. Relisez-le, modifiez-le ou validez-le.";
    case "done":
      return "Document validé.";
  }
}
