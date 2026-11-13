import type {
  MessageView,
  TaskView,
  WorkView,
} from "../../server/src/protocol";
import {
  TASK_STATUS_HINTS,
  TASK_STATUS_LABELS,
  isActive,
  planLabel,
} from "../../server/web/tasks";
import { LiveMascot, Mascot } from "../Mascot";
import { Markdown } from "../Markdown";
import { statuses } from "../api";
import type { Port } from "../port";
import { botNamer, currentVersion, formatDate, plural } from "./model";
import {
  Calls,
  CancelTaskButton,
  ContinueButton,
  Events,
  Progress,
  StepChain,
} from "./task";
import { AcceptButton, NonTaskWorkControls, workNote } from "./work";

function TaskSummary({ port, task }: { port: Port; task: TaskView }) {
  const name = botNamer(port.view);
  const work = port.view.works.find((w) => w.id === task.authorWorkId);
  const author = port.view.bots.find((bot) => bot.id === task.authorBotId);
  const current = work && currentVersion(work);
  const last = task.calls.at(-1);
  const unsent = task.events.filter(
    (event) =>
      event.delivery.state === "waiting" || event.delivery.state === "prepared",
  ).length;
  const toDecide = task.proposals.filter((p) => p.state === "open").length;
  return (
    <article
      className="ez-doc-card"
      data-task-id={task.id}
      data-status={task.status}
    >
      <header>
        {author && (
          <Mascot shape={author.shape} color={author.color} size={28} />
        )}
        <span className="ez-doc-label">Document</span>
        <span className="ez-doc-status" data-status={task.status}>
          {TASK_STATUS_LABELS[task.status]}
        </span>
      </header>
      <strong className="ez-doc-card-title">{work?.title ?? "Document"}</strong>
      <p className="ez-doc-muted">{planLabel(task, name)}</p>
      <StepChain task={task} name={name} />
      <Progress task={task} name={name} tail={220} />
      <p>{TASK_STATUS_HINTS[task.status]}</p>
      {last?.error && last.state !== "succeeded" && (
        <p className="ez-doc-error">Dernier appel : {last.error}</p>
      )}
      <p className="ez-doc-muted">
        {current
          ? `Version ${current.n} enregistrée.`
          : "Aucune version enregistrée."}
        {unsent > 0 &&
          ` ${plural(unsent, "précision pas encore transmise", "précisions pas encore transmises")}.`}
        {toDecide > 0 &&
          ` ${plural(toDecide, "proposition à arbitrer", "propositions à arbitrer")}.`}
      </p>
      <Events task={task} name={name} />
      <Calls task={task} name={name} />
      <div className="ez-doc-actions">
        <button
          type="button"
          className="ez-doc-btn ez-doc-btn-primary"
          onClick={() =>
            port.go({ page: "document", workId: task.authorWorkId })
          }
        >
          Ouvrir le document
        </button>
        <ContinueButton port={port} task={task} />
        {work?.state === "review" && current && !isActive(task) && (
          <AcceptButton port={port} work={work} />
        )}
        {isActive(task) && <CancelTaskButton port={port} task={task} />}
      </div>
      <small className="ez-doc-muted">
        Demande enregistrée sur cet ordinateur · {formatDate(task.createdAt)}
      </small>
    </article>
  );
}

function WorkSummary({ port, work }: { port: Port; work: WorkView }) {
  const current = currentVersion(work);
  if (work.state === "done" && !current) return null;
  const bot = port.view.bots.find((each) => each.id === work.botId);
  if (!current && work.taskId === null) {
    const active = work.state === "pending" || work.state === "running";
    const preview = active ? work.replyPreview?.trim() : "";
    const name = botNamer(port.view)(work.botId);
    return (
      <div className="ez-chat-reply" data-work-id={work.id}>
        {preview && (
          <div className="ez-chat-bubble ez-chat-partial" aria-busy="true">
            <Markdown text={preview} />
          </div>
        )}
        <div className="ez-chat-presence" role={active ? "status" : undefined}>
          {active && bot && (
            <LiveMascot
              shape={bot.shape}
              color={bot.color}
              activity={preview ? "speaking" : "thinking"}
            />
          )}
          <p className={work.state === "failed" ? "ez-doc-error" : undefined}>
            {active
              ? `${name} ${preview ? "écrit" : "prépare une réponse"}…`
              : workNote(work, false)}
          </p>
          <NonTaskWorkControls port={port} work={work} />
        </div>
      </div>
    );
  }
  const busyElsewhere = port.view.works.some(
    (other) => other.state === "running" && other.id !== work.id,
  );
  return (
    <article
      className="ez-doc-card"
      data-work-id={work.id}
      data-state={work.state}
    >
      <header>
        {bot && <Mascot shape={bot.shape} color={bot.color} size={28} />}
        <span className="ez-doc-label">
          {current ? "Document" : botNamer(port.view)(work.botId)}
        </span>
        <span className="ez-doc-status" data-status={work.state}>
          {statuses[work.state]}
        </span>
      </header>
      {current && <strong className="ez-doc-card-title">{work.title}</strong>}
      <p className={work.state === "failed" ? "ez-doc-error" : undefined}>
        {workNote(work, busyElsewhere)}
      </p>
      <p className="ez-doc-muted">
        {current
          ? `Version ${current.n} enregistrée.`
          : "Aucune version enregistrée."}
      </p>
      <div className="ez-doc-actions">
        {current && (
          <button
            type="button"
            className="ez-doc-btn ez-doc-btn-primary"
            onClick={() => port.go({ page: "document", workId: work.id })}
          >
            Ouvrir le document
          </button>
        )}
        {work.state === "review" && <AcceptButton port={port} work={work} />}
        <NonTaskWorkControls port={port} work={work} />
      </div>
    </article>
  );
}

export function TaskCard({
  port,
  message,
}: {
  port: Port;
  message: MessageView;
}) {
  const task = port.view.tasks.find((t) => t.requestMessageId === message.id);
  if (task) return <TaskSummary port={port} task={task} />;
  return (
    <>
      {port.view.works
        .filter((work) => work.requestMessageId === message.id)
        .map((work) => (
          <WorkSummary key={work.id} port={port} work={work} />
        ))}
    </>
  );
}
