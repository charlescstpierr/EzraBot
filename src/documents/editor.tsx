import { useEffect, useRef, useState } from "react";
import {
  LIMITS,
  type Command,
  type TaskView,
  type VersionView,
  type WorkView,
} from "../../server/src/protocol";
import type {
  Capture,
  DraftBook,
  ForeignDraft,
  VersionContent,
} from "../../server/web/drafts";
import { uid } from "../api";
import type { Port } from "../port";
import { FailureNote, useSender, type Sender } from "./command";
import { currentVersion, fromVersion, versionSource } from "./model";

type DraftBase = {
  id: string | null;
  n: number | null;
  title: string;
  body: string;
};
type State = { base: DraftBase; title: string; body: string };
type VersionScope = { kind: "version"; workId: string };

const EMPTY: DraftBase = { id: null, n: null, title: "", body: "" };
const snapshot = (version: VersionView | undefined): DraftBase =>
  version
    ? { id: version.id, n: version.n, title: version.title, body: version.body }
    : EMPTY;
const clean = (base: DraftBase): State => ({
  base,
  title: base.title,
  body: base.body,
});
const differs = (base: DraftBase, fields: { title: string; body: string }) =>
  fields.title.trim() !== base.title || fields.body.trim() !== base.body;

function fromDraft(draft: VersionContent, work: WorkView): State {
  const found = work.versions.find((v) => v.id === draft.baseVersionId);
  return {
    base: found ? snapshot(found) : { ...EMPTY, id: draft.baseVersionId },
    title: draft.title,
    body: draft.body,
  };
}

export type Editor = {
  state: State;
  dirty: boolean;
  remoteVersion: VersionView | null;
  note: string;
  savedN: number | null;
  sender: Sender;
  others: ForeignDraft<VersionScope>[];
  storage: ReturnType<DraftBook["status"]>;
  edit(patch: { title?: string; body?: string }): void;
  save(onto?: VersionView): void;
  discard(): void;
  resume(id: string): void;
  ignore(id: string): void;
};

export function useEditor({
  port,
  work,
  task,
  drafts,
}: {
  port: Port;
  work: WorkView;
  task: TaskView | null;
  drafts: DraftBook;
}): Editor {
  const scope: VersionScope = { kind: "version", workId: work.id };
  const latest = currentVersion(work);
  const [state, setState] = useState<State>(() => {
    const draft = drafts.read(scope);
    return draft ? fromDraft(draft, work) : clean(snapshot(latest));
  });
  const [note, setNote] = useState("");
  const [savedN, setSavedN] = useState<number | null>(null);
  const [others, setOthers] = useState(() => drafts.others(scope));
  const live = useRef(state);
  live.current = state;
  const inFlightCapture = useRef<Capture | null>(null);
  const put = (next: State) => {
    live.current = next;
    setState(next);
  };
  const remember = (next: State) => {
    if (differs(next.base, next))
      drafts.write(scope, {
        baseVersionId: next.base.id,
        title: next.title,
        body: next.body,
      });
    else drafts.discard(scope);
  };

  const sender = useSender(port.run, (command, outcome) => {
    if (command.type !== "task.edit" && command.type !== "version.edit") return;
    if (outcome.kind !== "accepted") return;
    if (outcome.result.kind !== "version") {
      setNote(
        "Le service n’a pas confirmé la version enregistrée. Votre saisie reste ici.",
      );
      return;
    }
    const base: DraftBase = {
      id: outcome.result.versionId,
      n: outcome.result.n,
      title: command.title,
      body: command.body,
    };
    const next = { ...live.current, base };
    if (
      !inFlightCapture.current ||
      !drafts.acknowledge(inFlightCapture.current)
    )
      remember(next);
    put(next);
    setSavedN(base.n);
  });

  const dirty = differs(state.base, state);
  if (!dirty && !sender.sending && latest && latest.n > (state.base.n ?? 0))
    put(clean(snapshot(latest)));

  useEffect(() => {
    const refresh = () =>
      setOthers(drafts.others({ kind: "version", workId: work.id }));
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
  }, [drafts, work.id]);

  return {
    state,
    dirty,
    remoteVersion:
      dirty && !sender.sending && latest && latest.id !== state.base.id
        ? latest
        : null,
    note,
    savedN: !dirty && savedN === state.base.n ? savedN : null,
    sender,
    others,
    storage: drafts.status(),
    edit(patch) {
      const next = { ...live.current, ...patch };
      put(next);
      setNote("");
      remember(next);
    },
    save(onto) {
      const title = state.title.trim();
      const body = state.body.trim();
      if (!title || !body) {
        setNote(
          "Le titre et le contenu sont nécessaires. Votre saisie reste ici.",
        );
        return;
      }
      const baseVersionId = onto ? onto.id : state.base.id;
      let command: Command;
      if (task)
        command = {
          type: "task.edit",
          requestId: uid(),
          taskId: task.id,
          baseVersionId,
          title,
          body,
        };
      else if (baseVersionId !== null)
        command = {
          type: "version.edit",
          requestId: uid(),
          workId: work.id,
          baseVersionId,
          title,
          body,
        };
      else return;
      if (sender.sending || sender.pendingUnknownCommand) return;
      inFlightCapture.current = drafts.write(scope, {
        baseVersionId: state.base.id,
        title: state.title,
        body: state.body,
      });
      setNote("");
      sender.send(command);
    },
    discard() {
      drafts.discard(scope);
      put(clean(snapshot(latest)));
      setNote("");
    },
    resume(id) {
      const adopted = drafts.adopt(scope, id);
      if (adopted) put(fromDraft(adopted, work));
      setOthers(drafts.others(scope));
    },
    ignore(id) {
      drafts.dismiss(scope, id);
      setOthers(drafts.others(scope));
    },
  };
}

const STORAGE_NOTES: Record<Editor["storage"], string> = {
  durable: "Elle est gardée dans ce navigateur.",
  unavailable:
    "Le stockage du navigateur est indisponible : elle n’est gardée que dans cette page.",
  full: "Le stockage du navigateur est plein : elle n’est gardée que dans cette page.",
};

export function EditorForm({
  editor,
  author,
  onRead,
}: {
  editor: Editor;
  author: string;
  onRead: () => void;
}) {
  const { state, dirty, remoteVersion, sender } = editor;
  const locked = sender.sending || sender.pendingUnknownCommand !== null;
  const [foreign] = editor.others;
  return (
    <form
      className="ez-doc-editor"
      data-dirty={dirty}
      onSubmit={(event) => {
        event.preventDefault();
        editor.save();
      }}
    >
      <label className="ez-doc-field">
        Titre
        <input
          value={state.title}
          maxLength={LIMITS.versionTitleChars}
          onChange={(event) => editor.edit({ title: event.target.value })}
        />
      </label>
      <label className="ez-doc-field">
        Contenu
        <textarea
          className="ez-doc-editor-body"
          value={state.body}
          maxLength={LIMITS.versionBodyChars}
          placeholder="Vous pouvez écrire ici avant que le bot ait fini : votre texte ne sera jamais remplacé."
          onChange={(event) => editor.edit({ body: event.target.value })}
        />
      </label>
      {remoteVersion && (
        <div className="ez-doc-conflict" role="alert">
          <strong>Une autre version est devenue actuelle</strong>
          <p>
            Votre saisie part {fromVersion(state.base.n)}. La version{" "}
            {remoteVersion.n} (
            {versionSource(remoteVersion, author).toLowerCase()}) est maintenant
            actuelle. Rien n’est fusionné ni remplacé sans vous.
          </p>
          <div className="ez-doc-actions">
            <button type="button" className="ez-doc-btn" onClick={onRead}>
              Lire la version {remoteVersion.n}
            </button>
            <button
              type="button"
              className="ez-doc-btn"
              disabled={locked}
              onClick={() => editor.save(remoteVersion)}
            >
              Enregistrer ma saisie comme version {remoteVersion.n + 1}
            </button>
            <button
              type="button"
              className="ez-doc-btn"
              disabled={locked}
              onClick={editor.discard}
            >
              Abandonner ma saisie et charger la version {remoteVersion.n}
            </button>
          </div>
        </div>
      )}
      <p className="ez-doc-muted" role="status">
        {sender.sending
          ? "Enregistrement…"
          : dirty
            ? `Saisie non enregistrée, partie ${fromVersion(state.base.n)}. ${STORAGE_NOTES[editor.storage]}`
            : editor.savedN !== null
              ? `Version ${editor.savedN} enregistrée.`
              : ""}
      </p>
      {editor.note && (
        <p className="ez-doc-alert" role="alert">
          {editor.note}
        </p>
      )}
      <FailureNote sender={sender} />
      <div className="ez-doc-actions">
        <button
          className="ez-doc-btn ez-doc-btn-primary"
          disabled={!dirty || locked}
        >
          Enregistrer une version
        </button>
        {dirty && !remoteVersion && (
          <button
            type="button"
            className="ez-doc-btn"
            disabled={locked}
            onClick={editor.discard}
          >
            Abandonner ma saisie
          </button>
        )}
      </div>
      {foreign && (
        <div className="ez-doc-notice">
          <p>
            Un autre onglet garde un brouillon de ce document (
            {new Date(foreign.savedAt).toLocaleTimeString("fr-CA", {
              hour: "2-digit",
              minute: "2-digit",
            })}
            ).
          </p>
          <div className="ez-doc-actions">
            <button
              type="button"
              className="ez-doc-btn"
              disabled={dirty || locked}
              title={
                dirty
                  ? "Enregistrez ou abandonnez d’abord votre saisie."
                  : undefined
              }
              onClick={() => editor.resume(foreign.id)}
            >
              Reprendre ce brouillon
            </button>
            <button
              type="button"
              className="ez-doc-btn"
              onClick={() => editor.ignore(foreign.id)}
            >
              Ignorer
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
