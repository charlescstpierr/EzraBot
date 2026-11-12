import {
  createContext,
  useContext,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { AgentCommand } from "../../server/src/agent-protocol";
import type { AgentsOutcome, Port } from "../port";
import { describeCommand } from "./describe";
import type { AgentOutbox } from "./store";
import "./agent-outbox.css";
export { OUTBOX_KEY, commandOwners, openAgentOutbox } from "./store";

const OutboxContext = createContext<AgentOutbox | null>(null);
export const AgentOutboxProvider = OutboxContext.Provider;
function useOutbox(): AgentOutbox {
  const outbox = useContext(OutboxContext);
  if (!outbox) throw Error("La boîte d’envoi des agents n’est pas ouverte.");
  return outbox;
}

export function useAgentCommand(port: Port) {
  const outbox = useOutbox();
  const pending = useRef<AgentCommand | null>(null);
  const busy = useRef(false);
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "sending" }
    | { kind: "result"; outcome: AgentsOutcome }
  >({ kind: "idle" });
  const held = useSyncExternalStore(
    outbox.subscribe,
    () => pending.current !== null && outbox.holds(pending.current),
  );
  async function transmit(command: AgentCommand): Promise<AgentsOutcome> {
    busy.current = true;
    setState({ kind: "sending" });
    const outcome = await port.run.agents(command);
    if (outcome.kind !== "unknown") pending.current = null;
    busy.current = false;
    setState({ kind: "result", outcome });
    return outcome;
  }
  const unresolved =
    state.kind === "result" && state.outcome.kind === "unknown";
  return {
    async send(command: AgentCommand): Promise<AgentsOutcome | null> {
      if (busy.current || (pending.current && outbox.holds(pending.current)))
        return null;
      pending.current = command;
      return transmit(command);
    },
    async retry(): Promise<AgentsOutcome | null> {
      const command = pending.current;
      if (busy.current || !command || !outbox.holds(command)) return null;
      return transmit(command);
    },
    sending: state.kind === "sending",
    locked: state.kind === "sending" || (unresolved && held),
    settledElsewhere: unresolved && !held,
    state,
  };
}

export function AgentCommandFeedback({
  command,
  afterRetry,
  className,
}: {
  command: ReturnType<typeof useAgentCommand>;
  afterRetry?: (outcome: AgentsOutcome) => void;
  className?: string;
}) {
  const { state } = command;
  if (state.kind === "sending") return <p role="status">Envoi en cours…</p>;
  if (state.kind !== "result" || state.outcome.kind === "accepted") return null;
  if (command.settledElsewhere)
    return (
      <p role="status">
        Cette commande a été réglée ailleurs. Vérifiez la liste avant de la
        renvoyer.
      </p>
    );
  const outcome = state.outcome;
  return (
    <div role="alert" className={className}>
      <p>
        {outcome.kind === "refused"
          ? `${outcome.code} · `
          : outcome.kind === "rejected"
            ? `HTTP ${outcome.status} · `
            : ""}
        {outcome.message}
      </p>
      {outcome.kind === "unknown" && (
        <button
          type="button"
          onClick={() => {
            void command.retry().then((result) => {
              if (result) afterRetry?.(result);
            });
          }}
        >
          Réessayer le même envoi
        </button>
      )}
    </div>
  );
}

function result(outcome: AgentsOutcome): string {
  if (outcome.kind === "accepted")
    return outcome.replayed
      ? "Le service avait déjà accepté cette commande. Rien n’a été exécuté deux fois."
      : "Le service a accepté cette commande.";
  if (outcome.kind === "refused")
    return `Commande refusée · ${outcome.code} · ${outcome.message}`;
  if (outcome.kind === "rejected")
    return `Commande rejetée · HTTP ${outcome.status} · ${outcome.message}`;
  return outcome.message;
}

export function AgentRecovery({ port }: { port: Port }) {
  const outbox = useOutbox();
  const pending = useSyncExternalStore(outbox.subscribe, outbox.pending);
  const [last, setLast] = useState<{
    command: AgentCommand;
    outcome: AgentsOutcome;
  } | null>(null);
  if (!pending.length && !last) return null;
  const names = {
    bots: port.view.bots,
    projects: port.agents?.projects ?? [],
    missions: port.agents?.missions ?? [],
  };
  return (
    <section
      className="agent-outbox"
      aria-label="Commandes en attente de confirmation"
    >
      {pending.map((entry) => {
        const { label, fields } = describeCommand(entry.command, names);
        return (
          <article key={entry.command.requestId}>
            <h2>Commande en attente · {label}</h2>
            <p>
              Le service n’a pas confirmé cette commande. Elle n’est jamais
              renvoyée sans vous.
            </p>
            <dl>
              {fields.map(([name, value]) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            {!entry.durable && (
              <p>
                <strong>
                  Ce navigateur ne peut pas conserver cette commande. Ne
                  rechargez pas et ne fermez pas la page avant la confirmation.
                </strong>
              </p>
            )}
            <button
              className="outline"
              disabled={entry.sending}
              onClick={() => {
                void port.run
                  .agents(entry.command)
                  .then((outcome) =>
                    setLast({ command: entry.command, outcome }),
                  );
              }}
            >
              Réessayer la commande en attente
            </button>
            {entry.sending && <p>Envoi en cours…</p>}
          </article>
        );
      })}
      {last && (
        <div className="agent-outbox-result">
          <p role="status">
            {describeCommand(last.command, names).label} ·{" "}
            {result(last.outcome)}
          </p>
          {last.outcome.kind === "accepted" &&
            last.command.type.startsWith("mission.") && (
              <button
                className="outline"
                onClick={() => {
                  if (last.outcome.kind === "accepted")
                    port.go({
                      page: "missions",
                      missionId: last.outcome.result.id,
                    });
                  setLast(null);
                }}
              >
                Ouvrir la mission
              </button>
            )}
          <button className="outline" onClick={() => setLast(null)}>
            Masquer ce résultat
          </button>
        </div>
      )}
    </section>
  );
}
