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
  if (work.next.kind !== "retry")
    return work.next.kind === "new_request" || work.next.kind === "none"
      ? <p className="ez-doc-muted">{work.next.reason}</p>
      : null;
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

export function WorkContinuity({ port, work }: { port: Port; work: WorkView }) {
  const fact = work.lastFact;
  const receipt = port.view.tools.proposals.find(proposal => proposal.workId === work.id && proposal.execution?.id === (fact.kind === "execution" ? fact.id : null));
  return <div className="ez-doc-facts" data-continuity-work={work.id}>
    <p>Dernière tentative {work.attempt?.n ?? 0} · {work.state}. Même travail dans ce fil.</p>
    <p>{fact.kind === "none" ? "Aucun résultat confirmé." : fact.kind === "execution"
      ? `Action enregistrée · ${fact.state}${fact.state === "unknown" ? ". Résultat inconnu. Action non renvoyée." : ""}`
      : fact.kind === "version" ? `Version ${fact.n} enregistrée.` : "Réponse enregistrée."}</p>
    {fact.kind === "version" && <button type="button" className="ez-doc-btn" onClick={() => port.go({ page: "document", workId: work.id, versionId: fact.id })}>Ouvrir la preuve</button>}
    {fact.kind === "reply" && <button type="button" className="ez-doc-btn" onClick={() => port.go({ page: "chat", botId: work.threadBotId, messageId: fact.id })}>Ouvrir la réponse</button>}
    {fact.kind === "execution" && receipt && <button type="button" className="ez-doc-btn" onClick={() => port.go({ page: "chat", botId: work.threadBotId, messageId: receipt.messageId })}>Voir le reçu sur le PC</button>}
    {work.next.kind === "new_request" && <p>{work.next.reason} Le compte rendu se gère sur le PC.</p>}
    {work.attempt?.plan && 'history' in work.attempt.plan && work.attempt.plan.history.entries.map(entry => entry.requestMessageId && <button key={entry.requestMessageId} type="button" className="ez-doc-btn" onClick={() => port.go({ page: "chat", botId: work.threadBotId, messageId: entry.requestMessageId ?? work.requestMessageId })}>Ouvrir {entry.kind === 'recent' ? 'l’échange récent' : 'la source de l’extrait'}</button>)}
    {work.state === "running" && <p>Le texte reçu en cours de rédaction ne confirme aucun résultat.</p>}
  </div>;
}
