import { useState } from "react";
import {
  LIMITS,
  MAX_CONTINUATIONS,
  type AppView,
  type DocProposalView,
  type TaskEventView,
  type TaskView,
  type VersionView,
} from "../../server/src/protocol";
import {
  CONTINUE_LABELS,
  STEP_LABELS,
  deliveryLabel,
} from "../../server/web/tasks";
import { Markdown } from "../Markdown";
import { uid } from "../api";
import type { Port } from "../port";
import { CommandButton, FailureNote, useSender } from "./command";
import {
  CALL_STATE_LABELS,
  fromVersion,
  plural,
  stepChain,
  type BotNamer,
} from "./model";

export function StepChain({ task, name }: { task: TaskView; name: BotNamer }) {
  return (
    <ol className="ez-doc-steps">
      {stepChain(task).map((step, index) => (
        <li key={index} data-state={step.state}>
          {STEP_LABELS[step.step]} · {name(step.botId)} ·{" "}
          {CALL_STATE_LABELS[step.state]}
        </li>
      ))}
    </ol>
  );
}

export function Progress({
  task,
  name,
  tail,
}: {
  task: TaskView;
  name: BotNamer;
  tail?: number;
}) {
  const progress = task.progress;
  if (!progress) return null;
  const received = progress.body ?? progress.reply;
  const text =
    tail && received.length > tail ? `…${received.slice(-tail)}` : received;
  return (
    <section className="ez-doc-live" data-state={progress.attemptState}>
      <strong>
        {STEP_LABELS[progress.step]} par {name(progress.botId)} ·{" "}
        {progress.attemptState === "running"
          ? "texte reçu, non validé"
          : "texte partiel reçu avant l’arrêt, non validé"}
      </strong>
      <p className="ez-doc-muted">
        {plural(progress.chars, "caractère reçu", "caractères reçus")}
        {!progress.readable && " · pas encore lisibles comme réponse"}
      </p>
      {text && <pre className="ez-doc-stream">{text}</pre>}
    </section>
  );
}

export function ContinueButton({ port, task }: { port: Port; task: TaskView }) {
  const label = CONTINUE_LABELS[task.status];
  if (!task.canContinue || !label) return null;
  const left = MAX_CONTINUATIONS - task.continuations;
  return (
    <CommandButton
      run={port.run}
      make={() => ({
        type: "task.continue",
        requestId: uid(),
        taskId: task.id,
      })}
    >
      {label} ({plural(left, "reprise restante", "reprises restantes")})
    </CommandButton>
  );
}

export function CancelTaskButton({
  port,
  task,
}: {
  port: Port;
  task: TaskView;
}) {
  if (task.status === "cancelled" || task.status === "validated") return null;
  return (
    <CommandButton
      run={port.run}
      make={() => ({
        type: "task.intent",
        requestId: uid(),
        taskId: task.id,
        intent: { kind: "cancel" },
      })}
    >
      Annuler le travail
    </CommandButton>
  );
}

function OpenProposal({
  port,
  task,
  proposal,
  current,
  name,
}: {
  port: Port;
  task: TaskView;
  proposal: DocProposalView;
  current: VersionView | undefined;
  name: BotNamer;
}) {
  const sender = useSender(port.run);
  const locked = sender.sending || sender.pendingUnknownCommand !== null;
  return (
    <article className="ez-doc-proposal" data-proposal-id={proposal.id}>
      <strong>
        {STEP_LABELS[proposal.step]} de {name(proposal.botId)} : «{" "}
        {proposal.title} »
      </strong>
      <p>
        Proposition{" "}
        {proposal.reason === "goal_changed"
          ? `écrite pour l’objectif de la révision ${proposal.revision}. L’objectif actuel est la révision ${task.revision}.`
          : `écrite à partir ${fromVersion(proposal.baseVersionN)} alors que ${current ? `la version ${current.n}` : "votre texte"} est actuelle.`}{" "}
        Rien n’a été remplacé.
      </p>
      <details>
        <summary>Voir le texte proposé</summary>
        <pre className="ez-doc-code">{proposal.body}</pre>
      </details>
      <div className="ez-doc-actions">
        <button
          type="button"
          className="ez-doc-btn ez-doc-btn-primary"
          disabled={locked}
          onClick={() =>
            sender.send({
              type: "doc.adopt",
              requestId: uid(),
              proposalId: proposal.id,
              seenVersionId: current?.id ?? null,
              seenRevision: task.revision,
            })
          }
        >
          Adopter comme version {current ? current.n + 1 : 1}
        </button>
        <button
          type="button"
          className="ez-doc-btn"
          disabled={locked}
          onClick={() =>
            sender.send({
              type: "doc.dismiss",
              requestId: uid(),
              proposalId: proposal.id,
            })
          }
        >
          Écarter la proposition
        </button>
      </div>
      <FailureNote sender={sender} />
    </article>
  );
}

export function DocProposals({
  port,
  task,
  current,
  name,
}: {
  port: Port;
  task: TaskView;
  current: VersionView | undefined;
  name: BotNamer;
}) {
  if (!task.proposals.length) return null;
  const open = task.proposals.filter((proposal) => proposal.state === "open");
  return (
    <section className="ez-doc-section">
      <h3>
        {open.length ? "Propositions à arbitrer" : "Propositions traitées"}
      </h3>
      {open.map((proposal) => (
        <OpenProposal
          key={proposal.id}
          port={port}
          task={task}
          proposal={proposal}
          current={current}
          name={name}
        />
      ))}
      <ul className="ez-doc-resolved">
        {task.proposals
          .filter((proposal) => proposal.state !== "open")
          .map((proposal) => (
            <li key={proposal.id} data-state={proposal.state}>
              {STEP_LABELS[proposal.step]} de {name(proposal.botId)} :{" "}
              {proposal.state === "adopted"
                ? `adoptée (version ${proposal.versionN ?? "?"})`
                : "écartée"}
            </li>
          ))}
      </ul>
    </section>
  );
}

const EVENT_LABELS: Record<TaskEventView["kind"], string> = {
  add_info: "Précision",
  change_goal: "Nouvel objectif",
  cancel: "Annulation",
};

export function Events({ task, name }: { task: TaskView; name: BotNamer }) {
  if (!task.events.length) return null;
  return (
    <ul className="ez-doc-events">
      {task.events.map((event) => (
        <li key={event.id} data-delivery={event.delivery.state}>
          <strong>
            {EVENT_LABELS[event.kind]}
            {event.kind === "change_goal" && ` (révision ${event.revision})`}
          </strong>
          {event.text && <span> « {event.text} »</span>}
          <small>{deliveryLabel(event, name)}</small>
        </li>
      ))}
    </ul>
  );
}

export function Intents({
  port,
  task,
  name,
}: {
  port: Port;
  task: TaskView;
  name: BotNamer;
}) {
  const [text, setText] = useState("");
  const sender = useSender(port.run, (command, outcome) => {
    if (outcome.kind !== "accepted" || command.type !== "task.intent") return;
    const intent = command.intent;
    if (intent.kind !== "cancel")
      setText((typed) => (typed.trim() === intent.text ? "" : typed));
  });
  const closed = task.status === "cancelled" || task.status === "validated";
  const locked =
    sender.sending || sender.pendingUnknownCommand !== null || !text.trim();
  const send = (kind: "add_info" | "change_goal") =>
    sender.send({
      type: "task.intent",
      requestId: uid(),
      taskId: task.id,
      intent: { kind, text: text.trim() },
    });
  return (
    <section className="ez-doc-section">
      <h3>Objectif et précisions</h3>
      <p>
        Objectif{task.revision > 1 && ` (révision ${task.revision})`} :{" "}
        {task.goal}
      </p>
      <Events task={task} name={name} />
      {!closed && (
        <div className="ez-doc-intent">
          <textarea
            aria-label="Précision ou nouvel objectif pour ce document"
            placeholder="Une précision pour ce document, ou son nouvel objectif"
            maxLength={LIMITS.messageChars}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="ez-doc-actions">
            <button
              type="button"
              className="ez-doc-btn"
              disabled={locked}
              onClick={() => send("add_info")}
            >
              Ajouter une précision
            </button>
            <button
              type="button"
              className="ez-doc-btn"
              disabled={locked}
              onClick={() => send("change_goal")}
            >
              Changer l’objectif
            </button>
          </div>
          <FailureNote sender={sender} />
        </div>
      )}
    </section>
  );
}

export function Exchanges({
  view,
  task,
  name,
}: {
  view: AppView;
  task: TaskView;
  name: BotNamer;
}) {
  if (task.plan === "solo" && !task.handoffs.length) return null;
  return (
    <section className="ez-doc-section">
      <h3>Échanges entre bots</h3>
      {!task.handoffs.length && (
        <p className="ez-doc-muted">
          {task.status === "reviewer_unavailable"
            ? "Aucun échange : le relecteur a été supprimé avant sa relecture."
            : "Le brouillon sera transmis au relecteur quand il sera enregistré."}
        </p>
      )}
      {task.handoffs.map((handoff) => {
        const to =
          handoff.toStep === "review"
            ? (task.reviewerBotId ?? "")
            : task.authorBotId;
        const message = view.messages.find((m) => m.id === handoff.messageId);
        return (
          <article key={handoff.id} className="ez-doc-exchange">
            <strong>
              {name(handoff.fromBotId)} → {name(to)} ·{" "}
              {handoff.toStep === "review"
                ? "brouillon pour avis"
                : "avis pour la synthèse"}
            </strong>
            <p className="ez-doc-muted">
              {handoff.readBy.length
                ? handoff.readBy
                    .map(
                      (read) =>
                        `Transmis à ${name(read.botId)} dans un tour accepté (${STEP_LABELS[read.step].toLowerCase()}, appel ${read.n}, ${CALL_STATE_LABELS[read.state]})`,
                    )
                    .join(" · ")
                : "En attente de transmission à un tour accepté."}
            </p>
            {message && (
              <details>
                <summary>Message enregistré</summary>
                <Markdown text={message.text} />
              </details>
            )}
          </article>
        );
      })}
      <p className="ez-doc-muted">
        Seuls les messages enregistrés et le document circulent. Deux bots qui
        relisent la même source ne vérifient pas les faits de façon
        indépendante.
      </p>
    </section>
  );
}

export function Calls({ task, name }: { task: TaskView; name: BotNamer }) {
  return (
    <details className="ez-doc-details">
      <summary>
        Appels · {task.calls.length} / {task.maxCalls}
      </summary>
      <ul>
        {task.calls.map((call) => (
          <li key={`${call.workId}:${call.n}`} data-state={call.state}>
            {STEP_LABELS[call.step]} · {name(call.botId)} · appel {call.n}
            {call.continued && " (reprise)"} · {CALL_STATE_LABELS[call.state]} ·
            base :{" "}
            {call.baseVersionN === null
              ? "document vide"
              : `version ${call.baseVersionN}`}{" "}
            · objectif révision {call.taskRevision} ·{" "}
            {call.turnAccepted
              ? "tour accepté par Codex"
              : "aucun tour accepté"}
            {call.error && ` · ${call.error}`}
          </li>
        ))}
      </ul>
      <p className="ez-doc-muted">
        Reprises utilisées : {task.continuations} / {MAX_CONTINUATIONS}. Chaque
        appel commencé compte, même interrompu. Aucun appel ne repart seul après
        un arrêt.
      </p>
    </details>
  );
}
