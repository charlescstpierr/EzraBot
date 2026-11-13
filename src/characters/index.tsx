import { useState } from "react";
import { Plus, Check, Trash2, Pencil, MessageCircle } from "lucide-react";
import {
  CONTEXT_SIZES,
  REPLY_STYLES,
  LIMITS,
  type BotView,
} from "../../server/src/protocol";
import type { Port } from "../port";
import { uid } from "../api";
import { Mascot } from "../Mascot";
import { ToolGrants } from "../tools";
import { useAction } from "./action";
export { BotSheet } from "./sheet";
export { BotSwitcher } from "./switcher";
export { ModelPicker } from "./model";
import { ModelPicker, modelLabel } from "./model";
import "./style.css";
const deletionLabels: Record<string, string> = {
  messages: "Messages",
  files: "Fichiers",
  deliverables: "Documents",
  publications: "Publications",
  memories: "Souvenirs",
  waiting: "Travaux en attente",
  keptReplies: "Réponses conservées ailleurs",
  keptDeliverables: "Documents conservés ailleurs",
  keptMentions: "Mentions conservées ailleurs",
  tasks: "Tâches",
};
export function CharacterGallery({ port }: { port: Port }) {
  return (
    <ul className="bot-grid" aria-label="Personnages">
      <li>
        <button
          className="bot-card bot-card-new"
          onClick={() => port.openBot({ mode: "create" })}
        >
          <span className="bot-card-plus">
            <Plus size={22} />
          </span>
          <strong>Nouveau personnage</strong>
        </button>
      </li>
      {port.view.bots.map((bot) => (
        <li key={bot.id} className="bot-card">
          <button
            className="bot-card-main"
            aria-label={`Discuter avec ${bot.name}`}
            onClick={() => port.go({ page: "chat", botId: bot.id })}
          >
            <Mascot shape={bot.shape} color={bot.color} size={64} />
            <strong>{bot.name}</strong>
            {bot.title && <small>{bot.title}</small>}
            {bot.instructions && <p>{bot.instructions}</p>}
            <span className="bot-card-model">{modelLabel(port, bot)}</span>
          </button>
          <button
            className="icon bot-card-edit"
            aria-label={`Modifier ${bot.name}`}
            onClick={() => port.openBot({ mode: "edit", botId: bot.id })}
          >
            <Pencil size={16} />
          </button>
        </li>
      ))}
    </ul>
  );
}
export function CharacterPanel({ port, botId }: { port: Port; botId: string }) {
  const bot = port.view.bots.find((b) => b.id === botId);
  if (!bot)
    return (
      <div className="empty">
        <h2>Ce personnage n’est plus disponible.</h2>
        <button
          className="outline"
          onClick={() => port.go({ page: "characters" })}
        >
          Voir les personnages
        </button>
      </div>
    );
  return <Settings key={bot.id} port={port} bot={bot} />;
}
function Settings({ port, bot }: { port: Port; bot: BotView }) {
  const [memory, setMemory] = useState("");
  const addMemory = useAction(port);
  return (
    <div className="ez-character">
      <header className="ez-character-hero">
        <Mascot shape={bot.shape} color={bot.color} size={88} />
        <div>
          <h2>{bot.name}</h2>
          {bot.title && <p>{bot.title}</p>}
        </div>
        <div className="ez-character-hero-actions">
          <button
            className="black"
            onClick={() => port.go({ page: "chat", botId: bot.id })}
          >
            Discuter
            <MessageCircle size={16} />
          </button>
          <button
            className="outline"
            onClick={() => port.openBot({ mode: "edit", botId: bot.id })}
          >
            Modifier le profil
            <Pencil size={15} />
          </button>
        </div>
      </header>
      <section aria-labelledby="personality-heading">
        <h3 id="personality-heading">Personnalité et instructions</h3>
        {bot.instructions ? (
          <blockquote>{bot.instructions}</blockquote>
        ) : (
          <p>Aucune instruction pour le moment.</p>
        )}
      </section>
      <section aria-labelledby="model-heading" className="ez-character-model">
        <h3 id="model-heading">Modèle</h3>
        <ModelPicker port={port} bot={bot} />
      </section>
      <section aria-labelledby="memory-heading">
        <h3 id="memory-heading">Sa mémoire</h3>
        <p>
          {bot.memoryChars} / {LIMITS.memoryTotalChars} caractères utilisés.
        </p>
        {bot.memories.map((item) => (
          <MemoryEditor
            key={item.id}
            port={port}
            botId={bot.id}
            memory={item}
          />
        ))}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const captured = memory;
            void addMemory.perform(
              {
                type: "memory.create",
                requestId: uid(),
                botId: bot.id,
                text: memory,
              },
              () =>
                setMemory((current) => (current === captured ? "" : current)),
            );
          }}
        >
          <fieldset disabled={addMemory.disabled}>
            <label>
              Un souvenir à garder
              <textarea
                required
                maxLength={LIMITS.memoryChars}
                value={memory}
                onChange={(e) => setMemory(e.target.value)}
                placeholder="Quelque chose à retenir…"
              />
            </label>
            <button className="outline">
              Ajouter à sa mémoire
              <Plus size={16} />
            </button>
          </fieldset>
        </form>
        {addMemory.feedback}
      </section>
      <ToolGrants port={port} bot={bot} />
      <details className="ez-character-advanced">
        <summary>Réglages avancés</summary>
        <ReplySettings port={port} bot={bot} />
      </details>
      <DeleteCharacter port={port} bot={bot} />
    </div>
  );
}
function ReplySettings({ port, bot }: { port: Port; bot: BotView }) {
  const [replyStyle, setReplyStyle] = useState(bot.replyStyle),
    [contextSize, setContextSize] = useState(bot.contextSize);
  const action = useAction(port);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void action.perform({
          type: "bot.update",
          requestId: uid(),
          botId: bot.id,
          replyStyle,
          contextSize,
        });
      }}
    >
      <h3>Réponses</h3>
      <fieldset disabled={action.disabled}>
        <div className="ez-character-columns">
          <label>
            Style des réponses
            <select
              value={replyStyle}
              onChange={(e) => {
                const value = REPLY_STYLES.find((s) => s === e.target.value);
                if (value) setReplyStyle(value);
              }}
            >
              {REPLY_STYLES.map((s) => (
                <option key={s} value={s}>
                  {
                    {
                      concise: "Court",
                      normal: "Normal",
                      detailed: "Détaillé",
                    }[s]
                  }
                </option>
              ))}
            </select>
          </label>
          <label>
            Contexte relu
            <select
              value={contextSize}
              onChange={(e) => {
                const value = CONTEXT_SIZES.find((s) => s === e.target.value);
                if (value) setContextSize(value);
              }}
            >
              {CONTEXT_SIZES.map((s) => (
                <option key={s} value={s}>
                  {{ short: "Court", standard: "Standard", long: "Long" }[s]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button className="outline">
          Enregistrer les réponses
          <Check size={16} />
        </button>
      </fieldset>
      {action.feedback}
    </form>
  );
}
function MemoryEditor({
  port,
  botId,
  memory,
}: {
  port: Port;
  botId: string;
  memory: BotView["memories"][number];
}) {
  const [editing, setEditing] = useState(false),
    [text, setText] = useState(memory.text),
    [base, setBase] = useState(memory.updatedAt),
    [confirm, setConfirm] = useState(false);
  const action = useAction(port);
  return (
    <div className="ez-character-memory">
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action.perform(
              {
                type: "memory.update",
                requestId: uid(),
                botId,
                memoryId: memory.id,
                text,
                baseUpdatedAt: base,
              },
              () => setEditing(false),
            );
          }}
        >
          <fieldset disabled={action.disabled}>
            <label>
              Modifier le souvenir
              <textarea
                required
                maxLength={LIMITS.memoryChars}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </label>
            {base !== memory.updatedAt && (
              <div className="notice">
                <strong>Ce souvenir a été modifié ailleurs.</strong>
                <p>Valeur actuelle : {memory.text}</p>
                <button
                  type="button"
                  className="outline"
                  onClick={() => {
                    setText(memory.text);
                    setBase(memory.updatedAt);
                  }}
                >
                  Reprendre la version actuelle
                </button>
                <button
                  type="button"
                  className="outline"
                  onClick={() => setBase(memory.updatedAt)}
                >
                  Garder mon texte sur cette base
                </button>
              </div>
            )}
            <button className="outline">Enregistrer ce souvenir</button>
            <button
              type="button"
              className="outline"
              onClick={() => setEditing(false)}
            >
              Annuler
            </button>
          </fieldset>
        </form>
      ) : (
        <>
          <p>{memory.text}</p>
          <div className="actions">
            <button
              className="outline"
              onClick={() => {
                setText(memory.text);
                setBase(memory.updatedAt);
                setEditing(true);
              }}
            >
              Modifier le souvenir
            </button>
            <button className="outline" onClick={() => setConfirm(true)}>
              Supprimer le souvenir
            </button>
          </div>
        </>
      )}
      {confirm && (
        <div className="notice">
          <p>
            Supprimer définitivement ce souvenir de{" "}
            {port.view.bots.find((b) => b.id === botId)?.name} ?
          </p>
          <button
            className="outline"
            disabled={action.disabled}
            onClick={() =>
              void action.perform({
                type: "memory.delete",
                requestId: uid(),
                botId,
                memoryId: memory.id,
              })
            }
          >
            Confirmer la suppression du souvenir
          </button>
          <button className="outline" onClick={() => setConfirm(false)}>
            Conserver
          </button>
        </div>
      )}
      {action.feedback}
    </div>
  );
}
function DeleteCharacter({ port, bot }: { port: Port; bot: BotView }) {
  const [open, setOpen] = useState(false),
    [name, setName] = useState("");
  const action = useAction(port);
  const [counts, setCounts] = useState(() => bot.deletion);
  const countsChanged = Object.entries(counts).some(
    ([key, value]) => bot.deletion[key as keyof typeof counts] !== value,
  );
  return (
    <section className="ez-character-delete">
      <h3>Supprimer ce personnage</h3>
      <p>
        Cette suppression est définitive. Les copies exportées et les systèmes
        externes ne sont pas effacés.
      </p>
      {!open ? (
        <button
          className="outline"
          onClick={() => {
            setCounts(bot.deletion);
            setOpen(true);
          }}
        >
          Examiner la suppression
          <Trash2 size={15} />
        </button>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (countsChanged) return;
            void action.perform(
              {
                type: "bot.delete",
                requestId: uid(),
                botId: bot.id,
                confirmName: name,
                expected: counts,
              },
              (r) => {
                if (r.result.kind === "botDeleted")
                  port.go(
                    r.result.nextBotId
                      ? { page: "chat", botId: r.result.nextBotId }
                      : { page: "characters" },
                  );
              },
            );
          }}
        >
          <fieldset disabled={action.disabled}>
            <p>Éléments contrôlés au moment de l’ouverture :</p>
            <dl>
              {Object.entries(counts).map(([key, value]) => (
                <div key={key}>
                  <dt>{deletionLabels[key] ?? key}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            {countsChanged && (
              <div role="alert">
                <p>
                  Les éléments à supprimer ont changé. Vérifiez les nouveaux
                  décomptes.
                </p>
                <dl>
                  {Object.entries(bot.deletion).map(([key, value]) => (
                    <div key={key}>
                      <dt>{deletionLabels[key] ?? key}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
                <button
                  type="button"
                  onClick={() => {
                    setCounts(bot.deletion);
                    setName("");
                  }}
                >
                  Actualiser les décomptes
                </button>
              </div>
            )}
            <label>
              Recopier le nom « {bot.name} »
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <button
              className="black"
              disabled={countsChanged || name !== bot.name}
            >
              Supprimer définitivement {bot.name}
            </button>
            <button
              type="button"
              className="outline"
              onClick={() => setOpen(false)}
            >
              Annuler
            </button>
          </fieldset>
        </form>
      )}
      {action.feedback}
    </section>
  );
}
