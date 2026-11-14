import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  CommandSchema,
  LIMITS,
  type MessageView,
} from "../../server/src/protocol";
import type {
  Capture,
  DraftBook,
  PromptContent,
} from "../../server/web/drafts";
import {
  inCode,
  insertMention,
  mentionQuery,
  rebase,
  trimForSend,
} from "../../server/web/mentions";
import { uid } from "../api";
import type { Port } from "../port";
import { Mascot } from "../Mascot";
import { Markdown } from "../Markdown";
import {
  isSendable,
  readPending,
  storageRead,
  storageWrite,
  type SavedSend,
} from "./pending";
import "./style.css";

/** A saved document version the person picked in the reader, to prepare a service action from it with the next message. */
export type SourceChoice = {
  ref: { workId: string; versionId: string };
  label: ReactNode;
  /** Why nothing can be prepared with this bot now, or null. */
  blocked: string | null;
  clear(): void;
};
type Props = {
  port: Port;
  botId: string;
  focusMessageId?: string;
  source?: SourceChoice;
  drafts: DraftBook;
  slots: {
    task(message: MessageView): ReactNode;
    mission(message: MessageView): ReactNode;
    tools(message: MessageView): ReactNode;
    /** How the Honcho recall of a bot reply ended, with its sources. */
    memory(message: MessageView): ReactNode;
  };
};
const empty = (): PromptContent => ({ text: "", files: [], mentions: [] });
const suggestions = [
  ["Mettre mes idées au clair", "Peux-tu m’aider à structurer mes idées ?"],
  [
    "Avancer sur un projet",
    "J’aimerais avancer sur un projet. Aide-moi à préciser mon objectif.",
  ],
  [
    "Préparer quelque chose",
    "J’aimerais préparer un document. Peux-tu m’aider à définir ce dont tu as besoin ?",
  ],
];
export function ChatPage(props: Props) {
  return (
    <Thread key={`${props.port.view.spaceId}:${props.botId}`} {...props} />
  );
}
function Thread({ port, botId, focusMessageId, source, drafts, slots }: Props) {
  const scope = { kind: "prompt", botId } as const;
  const key = `mimobot:${port.view.spaceId}:${botId}`;
  const pendingKey = `${key}:pending`;
  const bot = port.view.bots.find((b) => b.id === botId);
  const [content, setContent] = useState<PromptContent>(() => {
    const saved = drafts.read(scope);
    const legacy = storageRead(`${key}:draft`);
    if (saved) return saved;
    if (legacy !== null) {
      const migrated = { ...empty(), text: legacy };
      drafts.write(scope, migrated);
      if (drafts.status() === "durable") storageWrite(`${key}:draft`, null);
      return migrated;
    }
    return empty();
  });
  const current = useRef(content);
  const [pending, setPending] = useState(() => {
    const saved = readPending(pendingKey, botId);
    if (!saved) return null;
    const trimmed = trimForSend(content.text, content.mentions ?? []);
    if (
      trimmed.text === saved.command.text &&
      JSON.stringify(content.files) ===
        JSON.stringify(saved.command.attachments) &&
      JSON.stringify(trimmed.spans) ===
        JSON.stringify(saved.command.mentions ?? [])
    ) {
      return { ...saved, raw: content };
    }
    return saved;
  });
  const pendingRef = useRef(pending);
  const captureRef = useRef<Capture | null>(null);
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** Offered only when this bot has service rights. On by default; every action still waits for the person's approval. */
  const canUseServices =
    port.view.tools.status.state === "ready" &&
    (port.view.tools.grants[botId]?.length ?? 0) > 0;
  const [useServices, setUseServices] = useState(true);
  const [storageError, setStorageError] = useState(false);
  const [fan, setFan] = useState(false);
  const [hideQuery, setHideQuery] = useState(false);
  const [caret, setCaret] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [focused, setFocused] = useState<string>();
  const [, refreshForeign] = useState(0);
  const messages = port.view.messages.filter((m) => m.threadBotId === botId);
  const query = hideQuery ? null : mentionQuery(content.text, caret);
  const choices = port.view.bots.filter(
    (b) =>
      b.id !== botId &&
      (!query ||
        b.name.toLocaleLowerCase().includes(query.query.toLocaleLowerCase())),
  );
  const foreign = drafts.others(scope);

  function change(next: PromptContent) {
    current.current = next;
    drafts.write(scope, next);
    setContent(next);
  }
  function text(value: string) {
    change({
      ...current.current,
      text: value,
      mentions: rebase(
        current.current.text,
        value,
        current.current.mentions ?? [],
      ),
    });
  }
  function remember(next: SavedSend | null) {
    pendingRef.current = next;
    setPending(next);
    setStorageError(
      !storageWrite(pendingKey, next ? JSON.stringify(next) : null),
    );
  }
  useEffect(() => {
    const update = () => refreshForeign((n) => n + 1);
    window.addEventListener("storage", update);
    return () => window.removeEventListener("storage", update);
  }, []);
  useEffect(() => {
    if (!textarea.current) return;
    textarea.current.style.height = "auto";
    textarea.current.style.height = `${Math.min(160, textarea.current.scrollHeight)}px`;
  }, [content.text]);
  useEffect(() => {
    if (follow.current && scroll.current)
      scroll.current.scrollTop = messages.length
        ? scroll.current.scrollHeight
        : 0;
  }, [messages.length, port.view.rev]);
  useEffect(() => {
    if (!focusMessageId) return;
    const node = scroll.current?.querySelector(
      `[data-message-id="${CSS.escape(focusMessageId)}"]`,
    );
    if (!node) return;
    follow.current = false;
    node.scrollIntoView({ block: "center", behavior: "smooth" });
    setFocused(focusMessageId);
    const timer = setTimeout(() => setFocused(undefined), 2400);
    return () => clearTimeout(timer);
  }, [focusMessageId, messages.length]);

  async function send() {
    if (sending.current || loadingFiles.current || !bot) return;
    let saved = pendingRef.current;
    if (!saved) {
      const raw = current.current;
      const trimmed = trimForSend(raw.text, raw.mentions ?? []);
      if (!trimmed.text) return;
      if (source && (source.blocked || trimmed.spans.length)) {
        setError(
          source.blocked ??
            "Retirez les @ : une action depuis une version se prépare avec ce personnage seulement.",
        );
        return;
      }
      const command = CommandSchema.safeParse(
        source
          ? {
              type: "message.send",
              requestId: uid(),
              botId,
              text: trimmed.text,
              attachments: raw.files,
              source: source.ref,
            }
          : {
              type:
                canUseServices && useServices ? "message.send" : "message.say",
              requestId: uid(),
              botId,
              text: trimmed.text,
              attachments: raw.files,
              mentions: trimmed.spans,
            },
      );
      if (!command.success || !isSendable(command.data)) {
        setError(
          "Le message ou les pièces jointes dépassent les limites autorisées.",
        );
        return;
      }
      saved = { command: command.data, raw };
      captureRef.current = drafts.write(scope, raw);
      remember(saved);
    } else if (
      !captureRef.current &&
      JSON.stringify(current.current) === JSON.stringify(saved.raw)
    ) {
      captureRef.current = drafts.write(scope, current.current);
    }
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      const outcome = await port.run.app(saved.command);
      if (outcome.kind === "accepted") {
        if (captureRef.current && drafts.acknowledge(captureRef.current)) {
          current.current = empty();
          setContent(current.current);
        }
        remember(null);
        captureRef.current = null;
        if (saved.command.type === "message.send" && saved.command.source)
          source?.clear();
      } else {
        setError(
          outcome.kind === "refused"
            ? `${outcome.message} (${outcome.code})`
            : outcome.kind === "rejected"
              ? `${outcome.message} (${outcome.status})`
              : outcome.message,
        );
        if (outcome.kind !== "unknown") {
          remember(null);
          captureRef.current = null;
        }
      }
    } catch {
      setError(
        "Connexion interrompue. Le résultat est inconnu. Réessayez le même envoi.",
      );
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  function invite(id: string) {
    const selected = port.view.bots.find((b) => b.id === id);
    if (!selected) return;
    const before = current.current;
    const insertion = mentionQuery(before.text, caret);
    const at = insertion
      ? { start: insertion.start, caret }
      : { start: before.text.length, caret: before.text.length };
    const source =
      insertion || !before.text || /\s$/.test(before.text)
        ? before.text
        : before.text + " ";
    if (source !== before.text) {
      at.start++;
      at.caret++;
    }
    if (inCode(source, at.start)) {
      setError("Sortez du bloc de code pour inviter un personnage.");
      return;
    }
    const inserted = insertMention(source, at, selected);
    change({
      ...before,
      text: inserted.text,
      mentions: [
        ...rebase(before.text, inserted.text, before.mentions ?? []),
        inserted.span,
      ],
    });
    setCaret(inserted.caret);
    setFan(false);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(inserted.caret, inserted.caret);
    });
  }
  const loadingFiles = useRef(false);
  const [readingFiles, setReadingFiles] = useState(false);
  async function addFiles(files: FileList | null) {
    if (!files || loadingFiles.current) return;
    loadingFiles.current = true;
    setReadingFiles(true);
    setError("");
    const additions = [];
    try {
      if (current.current.files.length + files.length > LIMITS.attachments)
        throw Error(`Maximum ${LIMITS.attachments} fichiers.`);
      for (const file of Array.from(files)) {
        const name = file.name.trim();
        if (
          !name ||
          name.length > LIMITS.attachmentNameChars ||
          /[\x00-\x1f/\\]/.test(name)
        )
          throw Error("Nom de fichier invalide.");
        if (
          !file.type.startsWith("text/") &&
          !/\.(txt|md|markdown|csv|json|html?|css|js|ts|tsx|jsx|xml|ya?ml|log)$/i.test(
            name,
          )
        )
          throw Error("Choisissez un fichier texte.");
        if (file.size > LIMITS.attachmentChars * 4)
          throw Error(`${name} dépasse la taille autorisée.`);
        const value = new TextDecoder("utf-8", { fatal: true }).decode(
          await file.arrayBuffer(),
        );
        if (value.includes("\0") || value.length > LIMITS.attachmentChars)
          throw Error(
            `${name} est trop long ou contient des données non textuelles.`,
          );
        additions.push({ name, text: value });
      }
      change({
        ...current.current,
        files: [...current.current.files, ...additions],
      });
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Lecture du fichier impossible.",
      );
    } finally {
      loadingFiles.current = false;
      setReadingFiles(false);
    }
  }
  if (!bot)
    return (
      <section className="ez-chat-empty">
        <p>Aucun personnage dans ce fil.</p>
        <button onClick={() => port.go({ page: "characters" })}>
          Choisir un personnage
        </button>
      </section>
    );
  return (
    <section className="ez-chat">
      <div
        className="ez-chat-scroll"
        ref={scroll}
        onScroll={() => {
          const node = scroll.current;
          if (!node) return;
          follow.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 100;
          setAtBottom(follow.current);
        }}
      >
        {!messages.length && (
          <div className="ez-chat-welcome">
            <small>VOS IDÉES ONT DE LA COMPAGNIE</small>
            <button
              className="ez-chat-hero hero-mascot"
              aria-label="Personnaliser le personnage"
              onClick={() => port.go({ page: "characters", botId })}
            >
              <Mascot shape={bot.shape} color={bot.color} size={148} animated />
            </button>
            <h1>Salut, moi c’est {bot.name}.</h1>
            <p>
              Une idée en tête ? Un projet à faire avancer ?<br />
              On s’y met ensemble.
            </p>
            <div className="ez-chat-suggestions">
              {suggestions.map(([title, value]) => (
                <button
                  key={title}
                  onClick={() => {
                    text(value);
                    textarea.current?.focus();
                  }}
                >
                  {title}
                  <span aria-hidden="true">↗</span>
                </button>
              ))}
            </div>
            <small>Un petit compagnon. De grandes possibilités.</small>
          </div>
        )}
        {messages.map((m) => {
          const author = port.view.bots.find((b) => b.id === m.botId);
          return (
            <article
              key={m.id}
              data-message-id={m.id}
              className={`ez-chat-message ez-chat-${m.role}${focused === m.id ? " ez-chat-focused" : ""}`}
            >
              <div className="ez-chat-author">
                {m.role === "assistant" && author && (
                  <Mascot shape={author.shape} color={author.color} size={25} />
                )}
                <strong>
                  {m.role === "user"
                    ? "Vous"
                    : (author?.name ?? "Personnage supprimé")}
                </strong>
                <time dateTime={m.createdAt}>
                  {new Date(m.createdAt).toLocaleTimeString("fr-CA", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </div>
              <Markdown text={m.text} />
              {!!m.attachments.length && (
                <ul className="ez-chat-files">
                  {m.attachments.map((f, i) => (
                    <li key={i}>
                      {f.name} · {f.chars} caractères
                    </li>
                  ))}
                </ul>
              )}
              {m.stamp && (
                <small className="ez-chat-stamp">
                  {m.stamp.model} · {m.stamp.effort} · {m.stamp.speed}
                </small>
              )}
              {slots.task(m)}
              {slots.mission(m)}
              {slots.tools(m)}
              {slots.memory(m)}
            </article>
          );
        })}
      </div>
      <div className="ez-chat-compose-area">
        {!atBottom && (
          <button
            className="ez-chat-latest"
            onClick={() => {
              follow.current = true;
              scroll.current?.scrollTo({
                top: scroll.current.scrollHeight,
                behavior: "smooth",
              });
              setAtBottom(true);
            }}
          >
            ↓ Derniers messages
          </button>
        )}
        {foreign.map((d) => (
          <div className="ez-chat-foreign" key={d.id}>
            <p>Brouillon d’une autre page · {d.content.text.slice(0, 100)}</p>
            <button
              onClick={() => {
                const adopted = drafts.adopt(scope, d.id);
                if (adopted) {
                  current.current = adopted;
                  setContent(adopted);
                }
                refreshForeign((n) => n + 1);
              }}
            >
              Reprendre ce brouillon
            </button>
            <button
              onClick={() => {
                drafts.dismiss(scope, d.id);
                refreshForeign((n) => n + 1);
              }}
            >
              Masquer
            </button>
          </div>
        ))}
        {(storageError || drafts.status() !== "durable") && (
          <p role="status">
            Le stockage local est indisponible ou plein. Gardez cette page
            ouverte pour conserver votre envoi.
          </p>
        )}
        {error && (
          <p className="ez-chat-error" role="alert">
            {error}
          </p>
        )}
        {pending && !busy && (
          <p role="status">
            Un envoi attend sa confirmation. Réessayez avec la même commande.
            {pending.command.type === "message.send" &&
              pending.command.source &&
              " Il cite la version de document choisie."}
          </p>
        )}
        {source && !pending && (
          <div className="ez-chat-source" role="status">
            <p>
              <strong>Version source</strong> {source.label}
            </p>
            <small>
              {source.blocked ??
                `Seule cette version enregistrée sera transmise à ${bot?.name ?? "ce personnage"}. Précisez votre demande : l’action exacte attendra votre approbation.`}
            </small>
            <button type="button" onClick={source.clear}>
              Retirer la version source
            </button>
          </div>
        )}
        <ul className="ez-chat-files">
          {content.files.map((file, i) => (
            <li key={i}>
              {file.name}
              <button
                type="button"
                aria-label={`Retirer ${file.name}`}
                onClick={() =>
                  change({
                    ...current.current,
                    files: current.current.files.filter(
                      (_, index) => index !== i,
                    ),
                  })
                }
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <form
          className="ez-chat-composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <button
            type="button"
            aria-label="Inviter un personnage"
            aria-expanded={fan}
            onClick={() => setFan(!fan)}
          >
            @
          </button>
          <textarea
            ref={textarea}
            aria-label="Message"
            placeholder={`Écrire à ${bot.name}…`}
            maxLength={LIMITS.messageChars}
            value={content.text}
            onChange={(e) => {
              setHideQuery(false);
              text(e.target.value);
              setCaret(e.target.selectionStart);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setFan(false);
                setHideQuery(true);
              }
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button
            type="submit"
            aria-label="Envoyer le message"
            disabled={
              busy || readingFiles || (!content.text.trim() && !pending)
            }
          >
            {busy ? "Envoi…" : pending ? "Réessayer" : "↑"}
          </button>
        </form>
        {(fan || query) && (
          <div
            className="ez-chat-fan bot-fan"
            aria-label="Personnages à inviter"
          >
            <strong>Inviter dans ce fil</strong>
            {choices.map((b) => (
              <button
                key={b.id}
                type="button"
                aria-label={b.name}
                onClick={() => invite(b.id)}
              >
                <Mascot shape={b.shape} color={b.color} size={30} />
                <span>
                  {b.name}
                  <small>{b.title}</small>
                </span>
              </button>
            ))}
            {!choices.length && <p>Aucun personnage correspondant.</p>}
            <button
              type="button"
              onClick={() => {
                setFan(false);
                setHideQuery(true);
                textarea.current?.focus();
              }}
            >
              Fermer
            </button>
          </div>
        )}
        {canUseServices && !source && (
          <label className="ez-chat-services">
            <input
              type="checkbox"
              checked={useServices}
              disabled={busy || pending !== null}
              onChange={(e) => setUseServices(e.target.checked)}
            />
            <span>
              Utiliser les services connectés
              <small>
                {useServices
                  ? ` Ce message reste dans la conversation : ${bot.name} peut proposer une action, que vous confirmez.`
                  : " Une demande de document part en mode document, sans service."}
              </small>
            </span>
          </label>
        )}
        <label className="ez-chat-attachment">
          Joindre des fichiers texte
          <input
            aria-label="Joindre des fichiers texte"
            type="file"
            multiple
            accept="text/*,.txt,.md,.json,.csv,.html,.css,.js,.ts,.xml,.yaml,.yml"
            disabled={readingFiles}
            onChange={(e) => {
              void addFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
        <small className="ez-chat-footnote">
          Entrée pour envoyer · Maj + Entrée pour une nouvelle ligne
        </small>
      </div>
    </section>
  );
}
