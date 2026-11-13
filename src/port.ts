import type {
  Command,
  CommandResult,
  RefusalCode,
} from "../server/src/protocol";
import type {
  PcView,
  ToolCommand,
  ToolRefusalCode,
  ToolResult,
} from "../server/src/tools-protocol";
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
export type AppOutcome = Outcome<PcView, CommandResult, RefusalCode>;
export type ToolsOutcome = Outcome<PcView, ToolResult, ToolRefusalCode>;
export type AgentsOutcome = Outcome<
  AgentsView,
  { id: string },
  AgentRefusalCode
>;
export type CommandRunner = {
  app(command: Command): Promise<AppOutcome>;
  agents(command: AgentCommand): Promise<AgentsOutcome>;
  /** Connected services: rights and decisions. PC only. */
  tools(command: ToolCommand): Promise<ToolsOutcome>;
};
export type Route =
  | { page: "chat"; botId: string; messageId?: string }
  | { page: "document"; workId: string; versionId?: string }
  | { page: "missions"; missionId?: string }
  | { page: "projects" }
  | { page: "characters"; botId?: string }
  | { page: "carnet" };
export type BotSheetTarget = { mode: "create" } | { mode: "edit"; botId: string };
export type Port = {
  view: PcView;
  agents: AgentsView | null;
  run: CommandRunner;
  go(route: Route): void;
  openBot(target: BotSheetTarget): void;
};
export type { MissionResponse } from "../server/src/agent-protocol";
