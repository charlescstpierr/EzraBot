import { useRef, useState } from "react";
import { Plus, Check, Trash2, RefreshCw } from "lucide-react";
import catalogue from "../../server/assets/mascots.json";
import {
  CONTEXT_SIZES,
  REPLY_STYLES,
  LIMITS,
  type BotView,
  type Command,
} from "../../server/src/protocol";
import type { AppOutcome, Port } from "../port";
import { uid } from "../api";
import { Mascot } from "../Mascot";
import { ToolGrants } from "../tools";
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
type Accepted = Extract<AppOutcome, { kind: "accepted" }>;
function useAction(port: Port) {
  const lock = useRef(false),
    held = useRef<{
      command: Command;
      done?: (result: Accepted) => void;
    } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [uncertain, setUncertain] = useState(false);
  async function perform(command: Command, done?: (result: Accepted) => void) {
    if (lock.current) return;
    const action = held.current ?? { command, done };
    held.current = action;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await port.run.app(action.command);
      if (result.kind === "accepted") {
        held.current = null;
        setUncertain(false);
        action.done?.(result);
      } else {
        setError(result.message);
        if (result.kind === "unknown") setUncertain(true);
        else {
          held.current = null;
          setUncertain(false);
        }
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return {
    perform,
    disabled: busy || uncertain,
    feedback: (
      <>
        {error && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}
        {uncertain && (
          <button
            className="outline"
            disabled={busy}
            onClick={() => {
              if (held.current) void perform(held.current.command);
            }}
          >
            Réessayer la même action
            <RefreshCw size={15} />
          </button>
        )}
      </>
    ),
  };
}
function Appearance({
  name,
  setName,
  title,
  setTitle,
  shape,
  setShape,
  color,
  setColor,
}: {
  name: string;
  setName: (s: string) => void;
  title: string;
  setTitle: (s: string) => void;
  shape: string;
  setShape: (s: string) => void;
  color: string;
  setColor: (s: string) => void;
}) {
  return (
    <>
      <Mascot shape={shape} color={color} size={84} animated />
      <label>
        Son petit nom
        <input
          required
          maxLength={24}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label>
        Son rôle
        <input
          maxLength={60}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label>
        Sa forme
        <select value={shape} onChange={(e) => setShape(e.target.value)}>
          {catalogue.shapes.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Sa couleur
        <input
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
        />
      </label>
    </>
  );
}
export function CharacterCreate({ port }: { port: Port }) {
  const [name, setName] = useState(""),
    [title, setTitle] = useState(""),
    [shape, setShape] = useState("sprout"),
    [color, setColor] = useState("#8de343");
  const action = useAction(port);
  return (
    <div className="ez-character">
      <h2>Un nouveau compagnon.</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.perform(
            { type: "bot.create", requestId: uid(), name, title, shape, color },
            (r) => {
              if (r.result.kind === "bot")
                port.go({ page: "characters", botId: r.result.botId });
            },
          );
        }}
      >
        <fieldset disabled={action.disabled}>
          <Appearance
            {...{
              name,
              setName,
              title,
              setTitle,
              shape,
              setShape,
              color,
              setColor,
            }}
          />
          <button className="black">
            Créer le personnage
            <Plus size={16} />
          </button>
        </fieldset>
      </form>
      {action.feedback}
    </div>
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
          Créer un personnage
          <Plus size={16} />
        </button>
      </div>
    );
  return <Profile key={bot.id} port={port} bot={bot} />;
}
function Profile({ port, bot }: { port: Port; bot: BotView }) {
  const [name, setName] = useState(bot.name),
    [title, setTitle] = useState(bot.title),
    [shape, setShape] = useState(bot.shape),
    [color, setColor] = useState(bot.color),
    [instructions, setInstructions] = useState(bot.instructions),
    [replyStyle, setReplyStyle] = useState(bot.replyStyle),
    [contextSize, setContextSize] = useState(bot.contextSize),
    [memory, setMemory] = useState("");
  const profile = useAction(port),
    addMemory = useAction(port),
    reset = useAction(port);
  return (
    <div className="ez-character">
      <div className="ez-character-heading">
        <div>
          <span className="card-label">VOTRE COMPAGNON</span>
          <h2>Un compagnon à votre image.</h2>
        </div>
        <button
          className="outline"
          onClick={() => port.go({ page: "chat", botId: bot.id })}
        >
          Ouvrir son fil
        </button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void profile.perform({
            type: "bot.update",
            requestId: uid(),
            botId: bot.id,
            name,
            title,
            shape,
            color,
            instructions,
            replyStyle,
            contextSize,
          });
        }}
      >
        <fieldset disabled={profile.disabled}>
          <Appearance
            {...{
              name,
              setName,
              title,
              setTitle,
              shape,
              setShape,
              color,
              setColor,
            }}
          />
          <label>
            Consignes personnelles
            <textarea
              maxLength={LIMITS.botInstructionsChars}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
          </label>
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
          <button className="black">
            Enregistrer le profil
            <Check size={16} />
          </button>
        </fieldset>
      </form>
      {profile.feedback}
      <button
        className="outline"
        disabled={reset.disabled}
        onClick={() =>
          void reset.perform(
            {
              type: "bot.update",
              requestId: uid(),
              botId: bot.id,
              reset: true,
            },
            () => {
              setShape(bot.defaultShape);
              setColor(bot.defaultColor);
            },
          )
        }
      >
        Rétablir la forme et la couleur
        <RefreshCw size={15} />
      </button>
      {reset.feedback}
      <EngineSettings port={port} bot={bot} />
      <ToolGrants port={port} bot={bot} />
      <section>
        <h3>Sa mémoire</h3>
        <p>
          Ces souvenirs appartiennent uniquement à {bot.name}. {bot.memoryChars}{" "}
          / {LIMITS.memoryTotalChars} caractères.
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
      <DeleteCharacter port={port} bot={bot} />
    </div>
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
function EngineSettings({ port, bot }: { port: Port; bot: BotView }) {
  const [model, setModel] = useState(bot.choice.model ?? ""),
    [effort, setEffort] = useState(bot.choice.effort ?? ""),
    [speed, setSpeed] = useState(bot.choice.speed);
  const action = useAction(port);
  const engine = port.view.engine,
    models = engine.state === "ready" ? engine.models : [];
  const selected =
    models.find((m) => m.id === model) ?? models.find((m) => m.isDefault);
  return (
    <section>
      <h3>Moteur de réponse</h3>
      {engine.state !== "ready" ? (
        <p className="notice">
          Le catalogue du moteur est indisponible. Aucun réglage n’a été changé.
        </p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action.perform({
              type: "bot.configure",
              requestId: uid(),
              botId: bot.id,
              model: model || null,
              effort: effort || null,
              speed,
            });
          }}
        >
          <fieldset disabled={action.disabled}>
            <label>
              Modèle
              <select
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                  setEffort("");
                  setSpeed("standard");
                }}
              >
                <option value="">Choix par défaut du moteur</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Effort
              <select
                value={effort}
                onChange={(e) => setEffort(e.target.value)}
              >
                <option value="">Effort par défaut</option>
                {selected?.efforts.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Vitesse
              <select value={speed} onChange={(e) => setSpeed(e.target.value)}>
                <option value="standard">Standard</option>
                {selected?.speeds
                  .filter((s) => s.id !== "standard")
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </label>
            <button className="outline">
              Enregistrer le choix du moteur
              <Check size={16} />
            </button>
          </fieldset>
        </form>
      )}
      {action.feedback}
    </section>
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
