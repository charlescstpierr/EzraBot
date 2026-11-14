import { useRef, useState, type ReactNode } from "react";
import { Check, Plus, RefreshCw } from "lucide-react";
import {
  LIMITS,
  type BotView,
  type MessageView,
} from "../../server/src/protocol";
import type {
  MemoryCommand,
  Provenance,
  ScopeView,
  SyncState,
} from "../../server/src/memory-protocol";
import { getProvenance, uid } from "../api";
import type { Port } from "../port";
import "./style.css";

type Identity = { requestId: string; botId: string };

function useMemoryCommand(port: Port, botId: string) {
  const lock = useRef(false),
    held = useRef<{ command: MemoryCommand; done?: () => void } | null>(null);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [uncertain, setUncertain] = useState(false);
  async function execute(action: NonNullable<typeof held.current>) {
    if (lock.current) return;
    held.current = action;
    lock.current = true;
    setBusy(true);
    setMessage("");
    try {
      const outcome = await port.run.memory(action.command);
      if (outcome.kind === "unknown") {
        setMessage(outcome.message);
        setUncertain(true);
        return;
      }
      held.current = null;
      setUncertain(false);
      if (outcome.kind === "accepted") action.done?.();
      else setMessage(outcome.message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return {
    send(build: (identity: Identity) => MemoryCommand, done?: () => void) {
      if (held.current) return;
      void execute({ command: build({ requestId: uid(), botId }), done });
    },
    locked: busy || uncertain,
    feedback: (
      <>
        {message && (
          <p className="notice" role="alert">
            {message}
          </p>
        )}
        {uncertain && (
          <button
            type="button"
            className="outline"
            disabled={busy}
            onClick={() => {
              if (held.current) void execute(held.current);
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

const NO_BUDGET =
  "Ce serveur ne déclare aucun budget « honcho » : aucun appel ne partira tant que MINO_BUDGETS ne le nomme pas.";

const STATES: Record<ScopeView["state"], string> = {
  preparing: "Préparation de l’espace Honcho en cours.",
  active: "Mémoire active.",
  withdrawal_pending:
    "Oubli en cours. La mémoire est fermée, les demandes de retrait partent vers Honcho.",
  withdrawal_unverified:
    "Mémoire fermée après un oubli. Honcho a reçu les demandes de retrait, mais EzraBot ne peut pas prouver l’effacement. Elle reste fermée jusqu’à l’ouverture d’un nouvel espace vide.",
  reset_pending: "Préparation d’un nouvel espace vide en cours.",
};

const NOTES: Record<string, string> = {
  budget:
    "Le plafond d’appels Honcho de ce serveur est atteint ou absent. Rien ne part pour le moment.",
  workspace_not_new:
    "Honcho connaissait déjà le nom d’espace proposé. Il est refusé : un espace doit être neuf.",
  interrupted:
    "EzraBot s’est arrêté pendant une demande à Honcho. Son résultat est inconnu.",
  timeout: "Honcho n’a pas répondu à temps. Le résultat est inconnu.",
  purge_unverified: "",
};
const noteText = (note: string | null): string =>
  note === null
    ? ""
    : (NOTES[note] ??
      `Honcho n’a pas répondu comme prévu (${note}). Rien n’est renvoyé automatiquement.`);

const SYNC: Record<SyncState, string> = {
  pending: "envoi en attente",
  verified: "copie vérifiée",
  uncertain: "copie incertaine",
  failed: "envoi refusé",
};

const plural = (n: number, one: string, many: string) =>
  `${n} ${n > 1 ? many : one}`;

function Limits() {
  return (
    <ul className="ez-memory-limits">
      <li>
        Un projet de mémoire appartient à un seul personnage. Rien n’est partagé
        avec un autre personnage.
      </li>
      <li>
        Vos demandes écrites dans sa conversation après votre accord, et vos
        déclarations, sont envoyées à Honcho. Les réponses des personnages et
        les fichiers joints ne sont pas envoyés.
      </li>
      <li>
        La mémoire sert dans la conversation de ce personnage. Les documents,
        les comptes rendus d’action et ses réponses dans une autre conversation
        partent sans mémoire.
      </li>
      <li>
        Dès votre accord, ses souvenirs locaux ne sont plus envoyés au moteur.
        Vous choisissez ceux à importer comme déclarations.
      </li>
      <li>
        Si Honcho ne répond pas ou si le budget est épuisé, le personnage répond
        sans aucune mémoire.
      </li>
      <li>
        Oublier ferme la mémoire tout de suite et demande le retrait à Honcho.
        EzraBot ne peut pas prouver que Honcho a tout effacé.
      </li>
      <li>
        La mémoire se règle sur cet ordinateur. Le téléphone montre seulement
        son état.
      </li>
      <li>
        Ce choix ne se défait pas. Pour repartir, il faut oublier puis ouvrir un
        nouvel espace vide.
      </li>
    </ul>
  );
}

function Consent({ port, bot }: { port: Port; bot: BotView }) {
  const [label, setLabel] = useState(""),
    [read, setRead] = useState(false);
  const action = useMemoryCommand(port, bot.id);
  const status = port.view.memory.status;
  if (status.state !== "ready") return null;
  return (
    <section className="ez-memory">
      <h3>Passer à la mémoire Honcho</h3>
      <p>
        Honcho devient alors la seule mémoire longue de {bot.name}. Rien n’est
        envoyé avant votre accord.
      </p>
      <Limits />
      {status.budget === null && <p className="notice">{NO_BUDGET}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          action.send((id) => ({
            ...id,
            type: "memory.enable",
            label,
            acknowledged: true,
          }));
        }}
      >
        <fieldset disabled={action.locked}>
          <label>
            Nom du projet de mémoire
            <input
              required
              maxLength={60}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Par exemple : Jardin de Nova"
            />
          </label>
          <label className="ez-memory-check">
            <input
              type="checkbox"
              required
              checked={read}
              onChange={(e) => setRead(e.target.checked)}
            />
            J’ai lu ces limites et j’accepte l’envoi à Honcho pour {bot.name}.
          </label>
          <button className="black">
            Activer la mémoire Honcho
            <Check size={16} />
          </button>
        </fieldset>
      </form>
      {action.feedback}
    </section>
  );
}

function Declaration({
  port,
  bot,
  item,
}: {
  port: Port;
  bot: BotView;
  item: ScopeView["declarations"][number];
}) {
  const [text, setText] = useState(item.text),
    [mode, setMode] = useState<"read" | "correct" | "exclude">("read");
  const action = useMemoryCommand(port, bot.id);
  return (
    <div className="ez-memory-item">
      <p>{item.text}</p>
      <small>
        Révision {item.revision} · {SYNC[item.sync]}
      </small>
      {mode === "correct" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            action.send(
              (id) => ({
                ...id,
                type: "memory.correct",
                declarationId: item.declarationId,
                baseRevision: item.revision,
                text,
              }),
              () => setMode("read"),
            );
          }}
        >
          <fieldset disabled={action.locked}>
            <label>
              Texte corrigé
              <textarea
                required
                maxLength={LIMITS.memoryChars}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </label>
            <button className="outline">Enregistrer la correction</button>
            <button
              type="button"
              className="outline"
              onClick={() => setMode("read")}
            >
              Annuler
            </button>
          </fieldset>
        </form>
      )}
      {mode === "exclude" && (
        <div>
          <p>
            Exclure cette déclaration de la mémoire de {bot.name} ? La copie
            déjà envoyée reste chez Honcho jusqu’à un oubli, mais elle ne sert
            plus.
          </p>
          <button
            className="black"
            disabled={action.locked}
            onClick={() =>
              action.send((id) => ({
                ...id,
                type: "memory.exclude",
                target: {
                  kind: "declaration",
                  declarationId: item.declarationId,
                },
              }))
            }
          >
            Confirmer l’exclusion
          </button>
          <button className="outline" onClick={() => setMode("read")}>
            Conserver
          </button>
        </div>
      )}
      {mode === "read" && (
        <div>
          <button
            className="outline"
            onClick={() => {
              setText(item.text);
              setMode("correct");
            }}
          >
            Corriger
          </button>
          <button className="outline" onClick={() => setMode("exclude")}>
            Exclure
          </button>
        </div>
      )}
      {action.feedback}
    </div>
  );
}

function LocalMemories({ port, bot }: { port: Port; bot: BotView }) {
  const [chosen, setChosen] = useState<string[]>([]);
  const action = useMemoryCommand(port, bot.id);
  const memoryIds = chosen.filter((id) =>
    bot.memories.some((memory) => memory.id === id),
  );
  if (!bot.memories.length) return null;
  return (
    <form
      className="ez-memory-local"
      onSubmit={(e) => {
        e.preventDefault();
        if (memoryIds.length)
          action.send(
            (id) => ({ ...id, type: "memory.import", memoryIds }),
            () => setChosen([]),
          );
      }}
    >
      <fieldset disabled={action.locked}>
        <h4>Anciens souvenirs locaux</h4>
        <p>
          Ils ne sont plus envoyés au moteur. Cochez ceux à importer : chacun
          devient une déclaration envoyée à Honcho et quitte cette liste.
        </p>
        {bot.memories.map((memory) => (
          <label key={memory.id} className="ez-memory-check">
            <input
              type="checkbox"
              checked={memoryIds.includes(memory.id)}
              onChange={(e) =>
                setChosen((current) =>
                  e.target.checked
                    ? [...current, memory.id]
                    : current.filter((id) => id !== memory.id),
                )
              }
            />
            {memory.text}
          </label>
        ))}
        <button className="outline" disabled={!memoryIds.length}>
          Importer la sélection comme déclarations
        </button>
      </fieldset>
      {action.feedback}
    </form>
  );
}

function Confirmed({
  title,
  children,
  label,
  button,
  acknowledge,
  locked,
  onConfirm,
}: {
  title: string;
  children: ReactNode;
  label: string;
  button: string;
  /** When set, the person also ticks this sentence before the button works. */
  acknowledge?: string;
  locked: boolean;
  onConfirm(confirmLabel: string): void;
}) {
  const [typed, setTyped] = useState(""),
    [read, setRead] = useState(false);
  return (
    <form
      className="ez-memory-danger"
      onSubmit={(e) => {
        e.preventDefault();
        onConfirm(typed);
      }}
    >
      <fieldset disabled={locked}>
        <h4>{title}</h4>
        {children}
        <label>
          Recopier le nom du projet « {label} »
          <input
            required
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </label>
        {acknowledge && (
          <label className="ez-memory-check">
            <input
              type="checkbox"
              required
              checked={read}
              onChange={(e) => setRead(e.target.checked)}
            />
            {acknowledge}
          </label>
        )}
        <button className="black" disabled={typed.trim() !== label}>
          {button}
        </button>
      </fieldset>
    </form>
  );
}

function Project({
  port,
  bot,
  scope,
}: {
  port: Port;
  bot: BotView;
  scope: ScopeView;
}) {
  const [text, setText] = useState("");
  const action = useMemoryCommand(port, bot.id),
    declare = useMemoryCommand(port, bot.id);
  const status = port.view.memory.status;
  const open = scope.state === "preparing" || scope.state === "active";
  const { pending, verified, uncertain, failed } = scope.messages;
  const note = noteText(scope.note);
  return (
    <section className="ez-memory">
      <h3>Mémoire Honcho · projet « {scope.label} »</h3>
      <p role="status">{STATES[scope.state]}</p>
      {note && <p className="notice">{note}</p>}
      {status.state === "ready" &&
        (status.budget === null ? (
          <p className="notice">{NO_BUDGET}</p>
        ) : (
          <p>
            Appels Honcho aujourd’hui : {status.budget.calls} sur{" "}
            {status.budget.callsPerDay}.
          </p>
        ))}
      {scope.state === "active" && (
        <p>
          Vos demandes dans cette conversation :{" "}
          {plural(verified, "copie vérifiée", "copies vérifiées")}, {pending} en
          attente, {plural(uncertain, "incertaine", "incertaines")},{" "}
          {plural(failed, "refusée", "refusées")}.
        </p>
      )}
      {scope.resumable && (
        <button
          className="outline"
          disabled={action.locked}
          onClick={() =>
            action.send((id) => ({ ...id, type: "memory.resume" }))
          }
        >
          Reprendre ce qui est incertain ou en échec
          <RefreshCw size={15} />
        </button>
      )}
      {open && (
        <>
          <h4>Déclarations</h4>
          <p>
            Corriger ou exclure une déclaration retire aussi du contexte les
            anciennes réponses composées avec elle.
          </p>
          {scope.declarations.map((item) => (
            <Declaration
              key={`${item.declarationId}:${item.revision}`}
              port={port}
              bot={bot}
              item={item}
            />
          ))}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const captured = text;
              declare.send(
                (id) => ({ ...id, type: "memory.declare", text }),
                () =>
                  setText((current) => (current === captured ? "" : current)),
              );
            }}
          >
            <fieldset disabled={declare.locked}>
              <label>
                Une déclaration à retenir
                <textarea
                  required
                  maxLength={LIMITS.memoryChars}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Un fait ou une préférence, dit par vous…"
                />
              </label>
              <button className="outline">
                Ajouter la déclaration
                <Plus size={16} />
              </button>
            </fieldset>
          </form>
          {declare.feedback}
          <LocalMemories port={port} bot={bot} />
        </>
      )}
      {!!scope.excludedMessageIds.length && (
        <>
          <h4>Demandes exclues de la mémoire</h4>
          <ul className="ez-memory-links">
            {scope.excludedMessageIds.map((messageId, index) => (
              <li key={messageId}>
                <button
                  className="outline"
                  onClick={() =>
                    port.go({ page: "chat", botId: bot.id, messageId })
                  }
                >
                  Ouvrir la demande exclue {index + 1}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {scope.state === "active" && (
        <Confirmed
          title="Oublier cette mémoire"
          label={scope.label}
          button={`Oublier la mémoire de ${bot.name}`}
          locked={action.locked}
          onConfirm={(confirmLabel) =>
            action.send((id) => ({
              ...id,
              type: "memory.forget",
              confirmLabel,
            }))
          }
        >
          <p>
            La mémoire est fermée tout de suite : plus aucune déclaration ni
            aucune ancienne demande n’est rappelée ou relue. EzraBot demande
            ensuite le retrait à Honcho. Vos messages restent affichés dans la
            conversation. L’effacement chez Honcho ne peut pas être prouvé.
          </p>
        </Confirmed>
      )}
      {scope.state === "withdrawal_unverified" && (
        <Confirmed
          title="Ouvrir un nouvel espace vide"
          label={scope.label}
          button="Ouvrir un nouvel espace vide"
          acknowledge="Je confirme repartir d’un espace vide. Aucune ancienne déclaration ni ancienne demande n’y sera envoyée."
          locked={action.locked}
          onConfirm={(confirmLabel) =>
            action.send((id) => ({
              ...id,
              type: "memory.reset",
              confirmLabel,
              acknowledged: true,
            }))
          }
        >
          <p>
            EzraBot crée un espace Honcho au nom neuf, jamais utilisé. L’ancien
            espace n’est plus jamais lu ni écrit. Seules vos nouvelles demandes
            et vos nouvelles déclarations y seront envoyées.
          </p>
        </Confirmed>
      )}
      {action.feedback}
    </section>
  );
}

/** The memory part of a character page once the server has Honcho: its project, or the consent that creates it. */
export function HonchoMemory({ port, bot }: { port: Port; bot: BotView }) {
  const scope = port.view.memory.scopes.find((s) => s.botId === bot.id);
  return scope ? (
    <Project port={port} bot={bot} scope={scope} />
  ) : (
    <Consent port={port} bot={bot} />
  );
}

const RECALLS: Record<
  Exclude<Provenance["recall"], "none" | "used">,
  string
> = {
  empty: "Mémoire consultée : aucune source retenue pour cette réponse.",
  unavailable:
    "Réponse composée sans mémoire : Honcho n’a pas pu être consulté.",
  suspended: "Réponse composée sans mémoire : elle est suspendue.",
};

function Sources({
  port,
  message,
  count,
}: {
  port: Port;
  message: MessageView;
  count: number;
}) {
  const [shown, setShown] = useState<Provenance | null>(null),
    [error, setError] = useState("");
  const action = useMemoryCommand(port, message.threadBotId);
  async function load() {
    setError("");
    try {
      setShown(await getProvenance(message.id));
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Lecture impossible.",
      );
    }
  }
  return (
    <div className="ez-memory-trace">
      <button
        className="outline"
        aria-expanded={shown !== null}
        onClick={() => (shown ? setShown(null) : void load())}
      >
        Mémoire utilisée : {plural(count, "source", "sources")}
      </button>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {shown && (
        <ol aria-label="Sources de mémoire de cette réponse">
          {shown.sources.map((source, index) => (
            <li key={index}>
              {source.state === "withdrawn" ? (
                <p>
                  {source.kind === "declaration"
                    ? "Déclaration"
                    : "Demande antérieure"}{" "}
                  retirée depuis. Son texte n’est plus affiché.
                </p>
              ) : (
                <>
                  <small>
                    {source.kind === "declaration"
                      ? `Déclaration, révision ${source.revision}`
                      : `Votre demande du ${new Date(source.createdAt).toLocaleDateString("fr-CA")}`}
                  </small>
                  <p>{source.text}</p>
                  {source.messageId !== null && (
                    <button
                      className="outline"
                      onClick={() =>
                        port.go({
                          page: "chat",
                          botId: message.threadBotId,
                          messageId: source.messageId ?? undefined,
                        })
                      }
                    >
                      Ouvrir la demande d’origine
                    </button>
                  )}
                  {source.declarationId !== null && (
                    <button
                      className="outline"
                      onClick={() =>
                        port.go({
                          page: "characters",
                          botId: message.threadBotId,
                        })
                      }
                    >
                      Ouvrir les déclarations
                    </button>
                  )}
                  <button
                    className="outline"
                    disabled={action.locked}
                    onClick={() =>
                      action.send(
                        (id) => ({
                          ...id,
                          type: "memory.exclude",
                          target:
                            source.declarationId !== null
                              ? {
                                  kind: "declaration",
                                  declarationId: source.declarationId,
                                }
                              : {
                                  kind: "message",
                                  messageId: source.messageId ?? "",
                                },
                        }),
                        () => void load(),
                      )
                    }
                  >
                    Exclure de la mémoire
                  </button>
                </>
              )}
            </li>
          ))}
          {!!shown.omitted && (
            <li>
              {plural(
                shown.omitted,
                "autre source rappelée n’a pas été incluse",
                "autres sources rappelées n’ont pas été incluses",
              )}{" "}
              : la mémoire envoyée est bornée.
            </li>
          )}
        </ol>
      )}
      {action.feedback}
    </div>
  );
}

function Exclusion({
  port,
  message,
  scope,
}: {
  port: Port;
  message: MessageView;
  scope: ScopeView;
}) {
  const [asked, setAsked] = useState(false);
  const action = useMemoryCommand(port, message.threadBotId);
  if (scope.excludedMessageIds.includes(message.id))
    return (
      <small className="ez-memory-trace">
        Demande exclue de la mémoire Honcho.
      </small>
    );
  if (
    (scope.state !== "preparing" && scope.state !== "active") ||
    !scope.authorizedMessageIds.includes(message.id)
  )
    return null;
  return (
    <div className="ez-memory-trace">
      {asked ? (
        <>
          <p>
            Exclure cette demande de la mémoire ? Elle ne sera plus rappelée ni
            relue, et les réponses composées avec elle quittent le contexte.
          </p>
          <button
            className="black"
            disabled={action.locked}
            onClick={() =>
              action.send(
                (id) => ({
                  ...id,
                  type: "memory.exclude",
                  target: { kind: "message", messageId: message.id },
                }),
                () => setAsked(false),
              )
            }
          >
            Confirmer l’exclusion
          </button>
          <button className="outline" onClick={() => setAsked(false)}>
            Conserver
          </button>
        </>
      ) : (
        <button className="ez-memory-quiet" onClick={() => setAsked(true)}>
          Exclure de la mémoire
        </button>
      )}
      {action.feedback}
    </div>
  );
}

/** Under a message of a thread whose character has a Honcho project: how the recall of a reply ended, or the exclusion of a request. */
export function MemoryTrace({
  port,
  message,
}: {
  port: Port;
  message: MessageView;
}) {
  if (message.role === "user") {
    const scope = port.view.memory.scopes.find(
      (s) => s.botId === message.threadBotId,
    );
    return scope ? (
      <Exclusion port={port} message={message} scope={scope} />
    ) : null;
  }
  const recall = port.view.memory.recalls[message.id];
  if (!recall) return null;
  return recall.state === "used" ? (
    <Sources port={port} message={message} count={recall.sources} />
  ) : (
    <small className="ez-memory-trace">{RECALLS[recall.state]}</small>
  );
}
