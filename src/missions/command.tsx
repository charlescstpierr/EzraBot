import { AgentCommandFeedback, useAgentCommand } from "../agent-outbox";
import type { AgentsOutcome } from "../port";

export const useMissionCommand = useAgentCommand;

export function CommandFeedback(props: {
  command: ReturnType<typeof useMissionCommand>;
  afterRetry?: (outcome: AgentsOutcome) => void;
}) {
  return <AgentCommandFeedback className="missions-error" {...props} />;
}
