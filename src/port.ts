import type {
  AppView,
  Command,
  CommandResult,
  RefusalCode,
} from "../server/src/protocol";
import type {
  AgentCommand,
  AgentRefusalCode,
  AgentsView,
} from "../server/src/agent-protocol";

export type Outcome<V, R, C extends string> =
  | { kind: "accepted"; view: V; result: R; replayed: boolean }
  | { kind: "refused"; view: V; code: C; message: string }
  | { kind: "rejected"; status: number; message: string }
  | { kind: "unknown"; message: string };
export type AppOutcome = Outcome<AppView, CommandResult, RefusalCode>;
export type AgentsOutcome = Outcome<
  AgentsView,
  { id: string },
  AgentRefusalCode
>;
export type CommandRunner = {
  app(command: Command): Promise<AppOutcome>;
  agents(command: AgentCommand): Promise<AgentsOutcome>;
};
export type Route =
  | { page: "chat"; botId: string; messageId?: string }
  | { page: "document"; workId: string; versionId?: string }
  | { page: "missions"; missionId?: string }
  | { page: "projects" }
  | { page: "characters"; botId?: string }
  | { page: "carnet" };
export type Port = {
  view: AppView;
  agents: AgentsView | null;
  run: CommandRunner;
  go(route: Route): void;
};
export type { MissionResponse } from "../server/src/agent-protocol";
