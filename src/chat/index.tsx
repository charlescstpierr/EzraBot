import { AttachmentSchema, type Attachment } from "../../server/src/protocol";
import { attachmentStatus, flushAttachments } from "./durable";
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
import { LiveMascot, Mascot } from "../Mascot";
import { Markdown } from "../Markdown";
import {
  isSendable,
  readPending,
  storageRead,
  storageWrite,
  type SavedSend,
} from "./pending";
import "./style.css";
import { ArrowUp, LoaderCircle, RotateCw } from "lucide-react";
import { AttachmentMenu } from "./AttachmentMenu";

type Props = {
  port: Port;
  botId: string;
  focusMessageId?: string;
  drafts: DraftBook;
  slots: {
    replies(): ReactNode;
    task(message: MessageView): ReactNode;
    mission(message: MessageView): ReactNode;
    tools(message: MessageView): ReactNode;
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
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

function moment(before: string | undefined, at: string): string | null {
  const now = new Date(at);
  const previous = before ? new Date(before) : null;
  if (previous && now.getTime() - previous.getTime() < 30 * 60_000) return null;
  const time = now.toLocaleTimeString("fr-CA", {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (sameDay(now, new Date())) return `Aujourd’hui ${time}`;
  if (previous && sameDay(now, previous)) return time;
  return `${now.toLocaleDateString("fr-CA", { day: "numeric", month: "long" })} ${time}`;
}
export function ChatPage(props: Props) {
  return (
    <Thread key={`${props.port.view.spaceId}:${props.botId}`} {...props} />
  );
}
function Thread({ port, botId, focusMessageId, drafts, slots }: Props) {
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

  const canUseServices =
    port.view.tools.status.state === "ready" &&
    (port.view.tools.grants[botId]?.length ?? 0) > 0;
  const [useServices, setUseServices] = useState(true);
  const [storageError, setStorageError] = useState(false);
  const [fan, setFan] = useState(false);
  const [hideQuery, setHideQuery] = useState(false);
  const [caret, setCaret] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fanRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (fan) fanRef.current?.querySelector("button")?.focus();
  }, [fan]);
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
  const replying = port.view.works.some(
    (w) =>
      w.threadBotId === botId &&
      w.taskId === null &&
      w.versions.length === 0 &&
      (w.state === "pending" || w.state === "running"),
  );
  const lastVoice = messages
    .filter((m) => m.role === "assistant")
    .at(-1)?.botId;
  const presence =
    port.view.bots.find((b) => b.id === lastVoice) ??
    port.view.bots.find((b) => b.id === botId);

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
    window.addEventListener("attachment-storage", update);
    return () => {
      window.removeEventListener("storage", update);
      window.removeEventListener("attachment-storage", update);
      void flushAttachments();
    };
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
      if (!trimmed.text && !raw.files.length) return;
      const command = CommandSchema.safeParse({
        type: canUseServices && useServices ? "message.send" : "message.say",
        requestId: uid(),
        botId,
        text: trimmed.text,
        attachments: raw.files,
        mentions: trimmed.spans,
      });
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
      if (!(await flushAttachments(pendingKey))) {
        setStorageError(true);
        setError("Envoi arrêté : le stockage durable est indisponible.");
        return;
      }
      const outcome = await port.run.app(saved.command);
      if (outcome.kind === "accepted") {
        if (captureRef.current && drafts.acknowledge(captureRef.current)) {
          current.current = empty();
          setContent(current.current);
        }
        remember(null);
        captureRef.current = null;
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
  async function addFiles(files: FileList | File[] | null) {
    if (!files || loadingFiles.current) return;
    loadingFiles.current = true;
    setReadingFiles(true);
    setError("");
    const additions: Attachment[] = [];
    try {
      const selected = Array.from(files).filter(
        (file) =>
          !file.webkitRelativePath ||
          ![".DS_Store", "Thumbs.db", "desktop.ini"].includes(file.name),
      );
      const skipped = files.length - selected.length;
      if (!selected.length) {
        if (skipped) setError(`${skipped} fichier(s) système ignoré(s).`);
        return;
      }
      if (current.current.files.length + selected.length > LIMITS.attachments)
        throw Error(`Maximum ${LIMITS.attachments} fichiers.`);
      for (const file of selected) {
        const name = file.name.trim();
        if (
          !name ||
          name.length > LIMITS.attachmentNameChars ||
          /[\x00-\x1f/\\]/.test(name)
        )
          throw Error("Nom de fichier invalide.");
        const relativePath = file.webkitRelativePath || undefined;
        if (/^image\/(png|jpeg|webp)$/.test(file.type)) {
          if (file.size > LIMITS.imageBytes)
            throw Error(`${relativePath ?? name} dépasse 4 Mio.`);
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(",")[1]);
            reader.onerror = () =>
              reject(Error(`Lecture impossible : ${name}`));
            reader.readAsDataURL(file);
          });
          const bitmap = await createImageBitmap(file).catch(() => {
            throw Error(`${name} : image corrompue ou illisible.`);
          });
          bitmap.close();
          additions.push(
            AttachmentSchema.parse({
              kind: "image",
              name,
              mimeType: file.type,
              base64,
              ...(relativePath ? { relativePath } : {}),
            }),
          );
          continue;
        }
        if (
          !file.type.startsWith("text/") &&
          !/\.(txt|md|markdown|csv|json|html?|css|js|ts|tsx|jsx|xml|ya?ml|log)$/i.test(
            name,
          )
        )
          throw Error(
            `${relativePath ?? name} : format non pris en charge. Choisissez PNG, JPEG, WebP ou texte UTF-8. PDF, DOCX et HEIC ne sont pas lus.`,
          );
        if (file.size > LIMITS.attachmentChars * 4)
          throw Error(`${name} dépasse la taille autorisée.`);
        const value = new TextDecoder("utf-8", { fatal: true }).decode(
          await file.arrayBuffer(),
        );
        if (value.includes("\0") || value.length > LIMITS.attachmentChars)
          throw Error(
            `${name} est trop long ou contient des données non textuelles.`,
          );
        additions.push(
          AttachmentSchema.parse({
            name,
            text: value,
            ...(relativePath ? { relativePath } : {}),
          }),
        );
      }
      const combined = [...current.current.files, ...additions];
      const checked = CommandSchema.safeParse({
        type: "message.say",
        requestId: uid(),
        botId,
        text: current.current.text.trim(),
        attachments: combined,
      });
      if (!checked.success)
        throw Error(
          checked.error.issues.map((issue) => issue.message).join(" ; "),
        );
      change({ ...current.current, files: combined });
      if (skipped) setError(`${skipped} fichier(s) système ignoré(s).`);
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
      <section
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDrop={(e) => {
          if (e.dataTransfer.files.length) {
            e.preventDefault();
            void addFiles(e.dataTransfer.files);
          }
        }}
        className="ez-chat-empty"
      >
        <p>Aucun personnage dans ce fil.</p>
        <button onClick={() => port.go({ page: "characters" })}>
          Choisir un personnage
        </button>
      </section>
    );
  return (
    <section
      className="ez-chat"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        void addFiles(e.dataTransfer.files);
      }}
    >
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
            <button
              className="ez-chat-hero"
              aria-label={`Modifier ${bot.name}`}
              onClick={() => port.openBot({ mode: "edit", botId })}
            >
              <LiveMascot shape={bot.shape} color={bot.color} size={120} />
            </button>
            <h1>Salut, moi c’est {bot.name}.</h1>
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
          </div>
        )}
        {messages.map((m, i) => {
          const author = port.view.bots.find((b) => b.id === m.botId);
          const name =
            m.role === "user"
              ? "Vous"
              : (author?.name ?? "Personnage supprimé");
          const when = moment(messages[i - 1]?.createdAt, m.createdAt);
          return (
            <article
              key={m.id}
              data-message-id={m.id}
              aria-label={name}
              className={`ez-chat-message ez-chat-${m.role}${focused === m.id ? " ez-chat-focused" : ""}`}
            >
              {when && (
                <time className="ez-chat-when" dateTime={m.createdAt}>
                  {when}
                </time>
              )}
              {m.role === "assistant" && m.botId !== botId && (
                <span className="ez-chat-guest">{name}</span>
              )}
              <div className="ez-chat-bubble">
                <Markdown text={m.text} />
                {!!m.attachments.length && (
                  <ul className="ez-chat-files">
                    {m.attachments.map((f, i) => (
                      <li key={i}>
                        {f.kind === "image" && (
                          <img
                            className="ez-attachment-preview"
                            src={`/api/attachments/${f.id}`}
                            alt={f.name}
                          />
                        )}
                        {f.relativePath ?? f.name} ·{" "}
                        {f.kind === "image" ? "Image" : `${f.chars} caractères`}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {slots.task(m)}
              {slots.mission(m)}
              {slots.tools(m)}
            </article>
          );
        })}
        {slots.replies()}
        {!!messages.length && !replying && presence && (
          <div className="ez-chat-presence">
            <LiveMascot shape={presence.shape} color={presence.color} />
          </div>
        )}
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
        {attachmentStatus() === "saving" && (
          <p role="status">
            Sauvegarde du brouillon en cours. Gardez cette page ouverte.
          </p>
        )}
        {(storageError ||
          attachmentStatus() === "failed" ||
          drafts.status() !== "durable") && (
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
          </p>
        )}
        <ul className="ez-chat-files">
          {content.files.map((file, i) => (
            <li key={i}>
              {"kind" in file && (
                <img
                  className="ez-attachment-preview"
                  src={`data:${file.mimeType};base64,${file.base64}`}
                  alt={file.name}
                />
              )}
              {file.relativePath ?? file.name}
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
          <AttachmentMenu
            onFiles={(files) => void addFiles(files)}
            onInvite={
              port.view.bots.length > 1 ? () => setFan(true) : undefined
            }
            disabled={readingFiles}
          />
          <textarea
            ref={textarea}
            onPaste={(e) => {
              const images = Array.from(e.clipboardData.files).filter((file) =>
                file.type.startsWith("image/"),
              );
              if (images.length) {
                e.preventDefault();
                void addFiles(images);
              }
            }}
            aria-label="Message"
            rows={1}
            aria-describedby="message-keyboard-help"
            title="Entrée pour envoyer · Maj + Entrée pour une nouvelle ligne"
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
            title={
              busy ? "Envoi…" : pending ? "Réessayer le même envoi" : undefined
            }
            disabled={
              busy ||
              readingFiles ||
              (!content.text.trim() && !content.files.length && !pending)
            }
          >
            {busy ? (
              <LoaderCircle
                size={18}
                className="ez-chat-spin"
                aria-hidden="true"
              />
            ) : pending ? (
              <RotateCw size={18} aria-hidden="true" />
            ) : (
              <ArrowUp size={18} aria-hidden="true" />
            )}
          </button>
        </form>
        {(fan || query) && (
          <div
            ref={fanRef}
            className="ez-chat-fan bot-fan"
            aria-label="Personnages à inviter"
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              e.preventDefault();
              setFan(false);
              setHideQuery(true);
              textarea.current?.focus();
            }}
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
        {canUseServices && (
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
        <small id="message-keyboard-help" className="sr-only">
          Entrée pour envoyer · Maj + Entrée pour une nouvelle ligne
        </small>
      </div>
    </section>
  );
}
