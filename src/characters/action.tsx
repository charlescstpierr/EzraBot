import { useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { Command } from "../../server/src/protocol";
import type { AppOutcome, Port } from "../port";

type Accepted = Extract<AppOutcome, { kind: "accepted" }>;
/** One command at a time. An unknown outcome keeps the same command, so a retry replays its requestId instead of duplicating it. */
export function useAction(port: Port) {
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
    busy,
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
            type="button"
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
