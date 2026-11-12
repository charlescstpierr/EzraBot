import { useRef, useState } from "react";
import type { AgentCommand } from "../../server/src/agent-protocol";
import type { AgentsOutcome, Port } from "../port";

export function useMissionCommand(port: Port) {
  const pending = useRef<AgentCommand | null>(null);
  const busy = useRef(false);
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "sending" }
    | { kind: "result"; outcome: AgentsOutcome }
  >({ kind: "idle" });
  async function send(command: AgentCommand): Promise<AgentsOutcome | null> {
    if (busy.current || pending.current) return null;
    pending.current = command;
    return transmit();
  }
  async function transmit(): Promise<AgentsOutcome | null> {
    if (busy.current || !pending.current) return null;
    busy.current = true;
    setState({ kind: "sending" });
    let outcome: AgentsOutcome;
    try {
      outcome = await port.run.agents(pending.current);
    } catch {
      outcome = {
        kind: "unknown",
        message: "Confirmation non reçue. Réessayez le même envoi.",
      };
    }
    if (outcome.kind !== "unknown") pending.current = null;
    busy.current = false;
    setState({ kind: "result", outcome });
    return outcome;
  }
  return {
    send,
    retry: transmit,
    locked:
      state.kind === "sending" ||
      (state.kind === "result" && state.outcome.kind === "unknown"),
    state,
  };
}

export function CommandFeedback({
  command,
  afterRetry,
}: {
  command: ReturnType<typeof useMissionCommand>;
  afterRetry?: (outcome: AgentsOutcome) => void;
}) {
  const { state } = command;
  if (state.kind === "sending") return <p role="status">Envoi en cours…</p>;
  if (state.kind !== "result" || state.outcome.kind === "accepted") return null;
  const outcome = state.outcome;
  return (
    <div role="alert" className="missions-error">
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
