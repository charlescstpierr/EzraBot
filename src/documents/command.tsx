import { useRef, useState, type ReactNode } from "react";
import type { Command, RefusalCode } from "../../server/src/protocol";
import type { AppOutcome, CommandRunner } from "../port";

export type Failure =
  | { kind: "refused"; code: RefusalCode; message: string }
  | { kind: "rejected"; status: number; message: string }
  | { kind: "unknown"; message: string };

export type Sender = {
  sending: boolean;
  pendingUnknownCommand: Command | null;
  failure: Failure | null;
  send(command: Command): void;
  retry(): void;
};

const failureOf = (outcome: AppOutcome): Failure | null =>
  outcome.kind === "accepted"
    ? null
    : outcome.kind === "refused"
      ? { kind: "refused", code: outcome.code, message: outcome.message }
      : outcome.kind === "rejected"
        ? {
            kind: "rejected",
            status: outcome.status,
            message: outcome.message,
          }
        : { kind: "unknown", message: outcome.message };

export function useSender(
  run: CommandRunner,
  settled?: (command: Command, outcome: AppOutcome) => void,
): Sender {
  const busy = useRef(false);
  const pendingUnknownCommand = useRef<Command | null>(null);
  const onSettled = useRef(settled);
  onSettled.current = settled;
  const [state, setState] = useState<{
    sending: boolean;
    pendingUnknownCommand: Command | null;
    failure: Failure | null;
  }>({ sending: false, pendingUnknownCommand: null, failure: null });

  async function post(command: Command) {
    if (busy.current) return;
    busy.current = true;
    setState({
      sending: true,
      pendingUnknownCommand: pendingUnknownCommand.current,
      failure: null,
    });
    const outcome = await run.app(command);
    busy.current = false;
    pendingUnknownCommand.current = outcome.kind === "unknown" ? command : null;
    setState({
      sending: false,
      pendingUnknownCommand: pendingUnknownCommand.current,
      failure: failureOf(outcome),
    });
    onSettled.current?.(command, outcome);
  }
  return {
    ...state,
    send(command) {
      if (!pendingUnknownCommand.current) void post(command);
    },
    retry() {
      if (pendingUnknownCommand.current)
        void post(pendingUnknownCommand.current);
    },
  };
}

const FAILURE_KINDS: Record<Failure["kind"], string> = {
  refused: "Refusé par le service",
  rejected: "Demande rejetée",
  unknown: "Résultat inconnu",
};

export function FailureNote({ sender }: { sender: Sender }) {
  const failure = sender.failure;
  if (!failure) return null;
  return (
    <div className="ez-doc-alert" role="alert" data-failure={failure.kind}>
      <strong>
        {FAILURE_KINDS[failure.kind]}
        {failure.kind === "refused" && ` · ${failure.code}`}
        {failure.kind === "rejected" && ` · HTTP ${failure.status}`}
      </strong>
      <p>{failure.message}</p>
      {sender.pendingUnknownCommand && (
        <button
          type="button"
          className="ez-doc-btn"
          disabled={sender.sending}
          onClick={sender.retry}
        >
          Réessayer le même envoi
        </button>
      )}
    </div>
  );
}

export function CommandButton({
  run,
  make,
  children,
  primary = false,
  disabled = false,
  title,
  onAccepted,
}: {
  run: CommandRunner;
  make: () => Command;
  children: ReactNode;
  primary?: boolean;
  disabled?: boolean;
  title?: string;
  onAccepted?: (outcome: Extract<AppOutcome, { kind: "accepted" }>) => void;
}) {
  const sender = useSender(run, (_command, outcome) => {
    if (outcome.kind === "accepted") onAccepted?.(outcome);
  });
  return (
    <>
      <button
        type="button"
        className={primary ? "ez-doc-btn ez-doc-btn-primary" : "ez-doc-btn"}
        disabled={
          disabled || sender.sending || sender.pendingUnknownCommand !== null
        }
        title={title}
        onClick={() => sender.send(make())}
      >
        {children}
      </button>
      <FailureNote sender={sender} />
    </>
  );
}
