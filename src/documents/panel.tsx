import { useState } from "react";
import type { TaskView, WorkView } from "../../server/src/protocol";
import type { DraftBook } from "../../server/web/drafts";
import {
  TASK_STATUS_HINTS,
  TASK_STATUS_LABELS,
  isActive,
  planLabel,
} from "../../server/web/tasks";
import { Mascot } from "../Mascot";
import { statuses } from "../api";
import type { Port } from "../port";
import { Diagnostics } from "./diagnostics";
import { EditorForm, useEditor } from "./editor";
import { botNamer, currentVersion } from "./model";
import {
  Calls,
  CancelTaskButton,
  ContinueButton,
  DocProposals,
  Exchanges,
  Intents,
  Progress,
  StepChain,
} from "./task";
import { History, Publication, Reader } from "./versions";
import { AcceptButton, NonTaskWorkControls, workNote } from "./work";

const UNSAVED =
  "Enregistrez ou abandonnez d’abord votre saisie : elle n’est pas dans la version enregistrée.";

function Panel({
  port,
  work,
  task,
  drafts,
  versionId,
}: {
  port: Port;
  work: WorkView;
  task: TaskView | null;
  drafts: DraftBook;
  versionId: string | undefined;
}) {
  const name = botNamer(port.view);
  const bot = port.view.bots.find((each) => each.id === work.botId);
  const current = currentVersion(work);
  const pinned = work.versions.find((version) => version.id === versionId);
  const shown = pinned ?? current;
  const old = shown !== undefined && shown.id !== current?.id;
  const editor = useEditor({ port, work, task, drafts });
  const editable =
    task !== null ||
    (current !== undefined &&
      (work.state === "review" || work.state === "done"));
  const [mode, setMode] = useState<"read" | "edit">(() =>
    editor.dirty || !current ? "edit" : "read",
  );
  const editing = editable && !old && (mode === "edit" || !current);
  const blocked = editor.dirty ? UNSAVED : null;
  const last = task?.calls.at(-1);
  const read = () => {
    setMode("read");
    port.go({ page: "document", workId: work.id });
  };
  return (
    <section
      className="ez-doc-panel"
      data-work-id={work.id}
      data-status={task ? task.status : work.state}
    >
      <header className="ez-doc-head">
        {bot && <Mascot shape={bot.shape} color={bot.color} size={36} />}
        <div>
          <span className="ez-doc-label">
            Document ·{" "}
            <span
              className="ez-doc-status"
              data-status={task ? task.status : work.state}
            >
              {task ? TASK_STATUS_LABELS[task.status] : statuses[work.state]}
            </span>
          </span>
          <h2>{work.title}</h2>
          {task && <p className="ez-doc-muted">{planLabel(task, name)}</p>}
        </div>
      </header>
      {task ? (
        <>
          <StepChain task={task} name={name} />
          <p>{TASK_STATUS_HINTS[task.status]}</p>
          {last?.error && last.state !== "succeeded" && (
            <p className="ez-doc-error">Dernier appel : {last.error}</p>
          )}
          <Progress task={task} name={name} />
          <DocProposals port={port} task={task} current={current} name={name} />
        </>
      ) : (
        <p className={work.state === "failed" ? "ez-doc-error" : undefined}>
          {workNote(
            work,
            port.view.works.some(
              (other) => other.state === "running" && other.id !== work.id,
            ),
          )}
        </p>
      )}

      <section className="ez-doc-section">
        <h3>
          {shown
            ? `Version ${shown.n}${old ? " · ancienne" : " · actuelle"}`
            : "Aucune version enregistrée"}
        </h3>
        {versionId && !pinned && (
          <p className="ez-doc-notice">
            La version demandée n’existe pas dans ce document. La version
            actuelle est affichée.
          </p>
        )}
        {old && current && (
          <p className="ez-doc-notice">
            Vous lisez une ancienne version. Elle ne se modifie pas : la
            restaurer crée une nouvelle version.{" "}
            <button type="button" className="ez-doc-btn" onClick={read}>
              Revenir à la version {current.n} actuelle
            </button>
          </p>
        )}
        {editable && !old && current && (
          <div
            className="ez-doc-tabs"
            role="group"
            aria-label="Mode du document"
          >
            <button
              type="button"
              aria-pressed={mode === "read"}
              onClick={() => setMode("read")}
            >
              Lire
            </button>
            <button
              type="button"
              aria-pressed={mode === "edit"}
              onClick={() => setMode("edit")}
            >
              Modifier{editor.dirty && " · saisie non enregistrée"}
            </button>
          </div>
        )}
        {editing ? (
          <EditorForm editor={editor} author={name(work.botId)} onRead={read} />
        ) : (
          shown && <Reader key={shown.id} version={shown} />
        )}
      </section>

      <div className="ez-doc-actions">
        {task && <ContinueButton port={port} task={task} />}
        {work.state === "review" && current && !(task && isActive(task)) && (
          <AcceptButton port={port} work={work} blocked={blocked} />
        )}
        {task ? (
          <CancelTaskButton port={port} task={task} />
        ) : (
          <NonTaskWorkControls port={port} work={work} />
        )}
      </div>

      <Publication port={port} work={work} blocked={blocked} />
      {work.versions.length > 0 && (
        <History
          port={port}
          work={work}
          shown={shown}
          author={name(work.botId)}
        />
      )}
      {task && (
        <>
          <Intents port={port} task={task} name={name} />
          <Exchanges view={port.view} task={task} name={name} />
          <Calls task={task} name={name} />
        </>
      )}
      <Diagnostics view={port.view} work={work} task={task} name={name} />
    </section>
  );
}

export function DocumentPanel({
  port,
  workId,
  drafts,
  versionId,
}: {
  port: Port;
  workId: string;
  drafts: DraftBook;
  versionId?: string;
}) {
  const found = port.view.works.find((work) => work.id === workId);
  if (!found)
    return (
      <section className="ez-doc-panel">
        <h2>Document introuvable</h2>
        <p>
          {port.view.purged.workIds.includes(workId)
            ? "Ce document a été effacé avec son bot."
            : "Ce document n’existe pas sur cet ordinateur."}
        </p>
      </section>
    );
  const task = port.view.tasks.find((each) => each.id === found.taskId) ?? null;
  const work =
    port.view.works.find((each) => each.id === task?.authorWorkId) ?? found;
  return (
    <Panel
      key={work.id}
      port={port}
      work={work}
      task={task}
      drafts={drafts}
      versionId={versionId}
    />
  );
}
