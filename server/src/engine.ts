import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import type { BotChoice, CatalogModel, EngineStatus, RunStage } from './protocol.js';
import { STANDARD_SPEED } from './protocol.js';
import type { ComposedTurn } from './context.js';
import type { Departure } from './admission.js';
import { childEnv } from './child-env.js';
import {
  ENGINE_ERRORS,
  engineFailure,
  parseEngineReply,
  resolveChoice,
  type EngineErrorCode,
  type EngineOutcome,
  type UsageObservation,
} from './domain.js';

export const DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'apps', 'plugins', 'browser_use', 'browser_use_external', 'in_app_browser',
  'computer_use', 'view_image', 'multi_agent', 'code_mode_host', 'skill_search', 'memories', 'hooks',
  'image_generation', 'goals', 'tool_suggest',
] as const;

export const CODEX_CONFIG_ARGS = [
  '-c', 'mcp_servers={}',
  '-c', 'web_search="disabled"',
  '-c', 'skills.include_instructions=false',
  '-c', 'skills.bundled.enabled=false',
  '-c', 'project_doc_max_bytes=0',
  '-c', 'skills.max_context_tokens=1',
] as const;

const ALLOWED_ITEMS = new Set(['userMessage', 'agentMessage', 'reasoning', 'contextCompaction']);

export type EngineOptions = {
  command: string;
  args?: readonly string[];
  workDir: string;
  clientVersion: string;
  turnTimeoutMs?: number;
  requestTimeoutMs?: number;
  interruptGraceMs?: number;
  /** Lets this instance register server-owned tools on a thread. Codex needs its experimental API for that, so only this instance turns it on. */
  dynamicTools?: true;
};

export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };
export type ToolCall = { callId: string; tool: string; arguments: unknown };
export type ToolReply = { success: boolean; text: string };

/** The only tools a turn may call. A call comes back to the server, which answers at once; nothing runs inside Codex. */
export type TurnTools = { specs: readonly ToolSpec[]; call(call: ToolCall): Promise<ToolReply> };

export type RunInput = {
  turn: ComposedTurn;
  /** Absent or empty: the turn has no tool and every request from Codex is refused, as before. */
  tools?: TurnTools;
  choice: BotChoice;
  signal: AbortSignal;
  onStage: (stage: RunStage) => void;
  /** Called once the thread exists and before the turn starts, so usage can always find its attempt. */
  onThread: (threadId: string) => void;
  onTurn: (turnId: string) => void;
  /**
   * The one-use permit of this call. The engine takes it in the same tick as the request that starts the turn:
   * a refusal is the call's outcome and nothing is sent.
   */
  depart: () => Departure;
  /** Agent text received so far for one item of this thread and turn. The completed item replaces what the fragments built. */
  onText?: (text: AgentText) => void;
};

export type AgentText = { threadId: string; turnId: string; itemId: string; text: string; final: boolean };

export type Engine = {
  status(): EngineStatus;
  catalog(): Promise<EngineStatus>;
  run(input: RunInput): Promise<EngineOutcome>;
  /** Usage notifications for any thread on the connection, including ones that arrive after a turn ended. */
  onUsage(listener: (observation: UsageObservation) => void): () => void;
  close(): Promise<void>;
};

const EnvelopeSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});

const ConfigReadSchema = z.object({
  config: z.object({
    features: z.record(z.string(), z.unknown()).nullish(),
    mcp_servers: z.record(z.string(), z.unknown()).nullish(),
    web_search: z.unknown().optional(),
    skills: z.object({ include_instructions: z.literal(false), max_context_tokens: z.literal(1), bundled: z.object({ enabled: z.literal(false) }) }),
    project_doc_max_bytes: z.literal(0),
  }),
});

const AccountSchema = z.object({ account: z.object({ type: z.string() }).nullable() });

const ModelListSchema = z.object({
  data: z.array(z.object({
    id: z.string(),
    displayName: z.string(),
    hidden: z.boolean(),
    isDefault: z.boolean(),
    supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })),
    defaultReasoningEffort: z.string(),
    serviceTiers: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })).default([]),
  })),
  nextCursor: z.string().nullable().optional(),
});

const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const TokenBreakdownSchema = z.object({
  inputTokens: tokenCount,
  cachedInputTokens: tokenCount,
  cacheWriteInputTokens: tokenCount.default(0),
  outputTokens: tokenCount,
  reasoningOutputTokens: tokenCount,
  totalTokens: tokenCount,
}).transform(b => ({
  input: b.inputTokens, cachedInput: b.cachedInputTokens, cacheWriteInput: b.cacheWriteInputTokens,
  output: b.outputTokens, reasoningOutput: b.reasoningOutputTokens, total: b.totalTokens,
}));
const TokenUsageUpdatedSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  tokenUsage: z.object({ last: TokenBreakdownSchema, total: TokenBreakdownSchema, modelContextWindow: tokenCount.nullable().optional() }),
}).transform((n): UsageObservation => ({
  threadId: n.threadId,
  turnId: n.turnId,
  usage: { last: n.tokenUsage.last, total: n.tokenUsage.total, modelContextWindow: n.tokenUsage.modelContextWindow ?? null },
}));

const ThreadStartSchema = z.object({ thread: z.object({ id: z.string() }), model: z.string() });
const TurnStartSchema = z.object({ turn: z.object({ id: z.string() }) });
const ThreadScopedSchema = z.object({ threadId: z.string() });
const ItemEventSchema = z.object({ threadId: z.string(), turnId: z.string(), item: z.object({
  type: z.string(), id: z.string().optional(), text: z.string().optional(), tool: z.string().optional(), namespace: z.string().nullish(),
}) });
const TOOL_CALL = 'item/tool/call';
const DYNAMIC_TOOL_ITEM = 'dynamicToolCall';
const SERVICE_TOOL_NAMESPACE = 'ezrabot_services';
const ToolCallSchema = z.object({
  threadId: z.string(), turnId: z.string(), callId: z.string().min(1).max(200), namespace: z.string().nullish(), tool: z.string(), arguments: z.unknown(),
});
const AgentDeltaSchema = z.object({ threadId: z.string(), turnId: z.string(), itemId: z.string(), delta: z.string() });
const AGENT_DELTA = 'item/agentMessage/delta';
const TurnStartedSchema = z.object({ threadId: z.string(), turn: z.object({ id: z.string() }) });
const ErrorEventSchema = z.object({ threadId: z.string(), willRetry: z.boolean(), error: z.object({ codexErrorInfo: z.unknown().optional() }) });
const TurnCompletedSchema = z.object({
  threadId: z.string(),
  turn: z.object({
    id: z.string(),
    status: z.string(),
    error: z.object({ codexErrorInfo: z.unknown().optional() }).nullable().optional(),
  }),
});

class RpcError extends Error {}
class StartFailure extends Error {
  constructor(readonly code: EngineErrorCode) {
    super(ENGINE_ERRORS[code]);
  }
}

/** A request Codex sent to Mino. It gets exactly one answer, whoever asks to send it and however often. */
type ServerRequest = { method: string; params: unknown; refuse(): void; respond(result: unknown): void };

type Listener = {
  notification: (method: string, params: unknown) => void;
  serverRequest: (request: ServerRequest) => void;
  exit: () => void;
};

class Connection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private seq = 0;
  alive = true;
  listener: Listener | null = null;
  readonly spawned: Promise<void>;
  readonly exited: Promise<void>;

  constructor(options: EngineOptions, private readonly observe: (method: string, params: unknown) => void) {
    const args = [
      ...(options.args ?? []),
      'app-server', '--listen', 'stdio://',
      ...DISABLED_FEATURES.flatMap(feature => ['--disable', feature]),
      ...CODEX_CONFIG_ARGS,
      ...(options.dynamicTools ? ['-c', `features.code_mode={enabled=false,direct_only_tool_namespaces=["${SERVICE_TOOL_NAMESPACE}"]}`] : []),
    ];
    this.child = spawn(options.command, args, { cwd: options.workDir, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv(process.env) });
    this.child.stderr.resume();
    this.child.stdin.on('error', () => {});
    this.spawned = new Promise((resolve, reject) => {
      this.child.once('spawn', () => resolve());
      this.child.once('error', error => {
        const code = 'code' in error ? error.code : undefined;
        reject(new StartFailure(code === 'ENOENT' || code === 'EACCES' ? 'codex_missing' : 'codex_start_failed'));
      });
    });
    this.spawned.catch(() => {});
    this.exited = new Promise(resolve => {
      this.child.once('close', () => {
        this.alive = false;
        for (const waiter of this.pending.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(new RpcError('closed'));
        }
        this.pending.clear();
        this.listener?.exit();
        resolve();
      });
    });
    createInterface({ input: this.child.stdout }).on('line', line => this.receive(line));
  }

  private send(value: unknown): void {
    if (this.alive) this.child.stdin.write(JSON.stringify(value) + '\n');
  }

  private receive(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }
    const parsed = EnvelopeSchema.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.id !== undefined && message.method !== undefined) {
      const id = message.id;
      let answered = false;
      const answerOnce = (body: { result: unknown } | { error: { code: number; message: string } }) => {
        if (answered) return;
        answered = true;
        this.send({ id, ...body });
      };
      const request: ServerRequest = {
        method: message.method,
        params: message.params,
        refuse: () => answerOnce({ error: { code: -32000, message: 'Mino refuse toute action, tout outil et toute autorisation.' } }),
        respond: result => answerOnce({ result }),
      };
      if (this.listener) this.listener.serverRequest(request);
      else request.refuse();
      return;
    }
    if (message.id !== undefined) {
      const waiter = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
      if (!waiter || typeof message.id !== 'number') return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error !== undefined) waiter.reject(new RpcError('refused'));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method !== undefined) {
      this.observe(message.method, message.params);
      this.listener?.notification(message.method, message.params);
    }
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.alive) return Promise.reject(new RpcError('closed'));
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError('timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  async kill(): Promise<void> {
    if (!this.alive) return;
    this.child.stdin.end();
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    await this.exited;
    clearTimeout(timer);
  }
}

function turnErrorCode(info: unknown): EngineErrorCode {
  if (typeof info === 'string') {
    switch (info) {
      case 'usageLimitExceeded':
      case 'sessionBudgetExceeded':
        return 'usage_limit';
      case 'unauthorized':
        return 'unauthorized';
      case 'modelNotFound':
        return 'model_not_found';
      case 'rateLimitExceeded':
      case 'serverOverloaded':
      case 'policyCapacityUnavailable':
      case 'internalServerError':
        return 'overloaded';
      case 'contextWindowExceeded':
        return 'too_long';
      default:
        return 'turn_failed';
    }
  }
  if (info !== null && typeof info === 'object') {
    if ('httpConnectionFailed' in info || 'responseStreamConnectionFailed' in info || 'responseStreamDisconnected' in info) {
      return 'connection_failed';
    }
  }
  return 'turn_failed';
}

function checkConfig(value: unknown): boolean {
  const parsed = ConfigReadSchema.safeParse(value);
  if (!parsed.success) return false;
  const { features, mcp_servers: servers, web_search: webSearch } = parsed.data.config;
  const featuresOff = DISABLED_FEATURES.every(feature => features?.[feature] === false);
  const mcpOff = Object.values(servers ?? {}).every(server =>
    server !== null && typeof server === 'object' && 'enabled' in server && server.enabled === false);
  return featuresOff && mcpOff && webSearch === 'disabled';
}

export function createCodexEngine(options: EngineOptions): Engine {
  const requestTimeout = options.requestTimeoutMs ?? 30_000;
  const turnTimeout = options.turnTimeoutMs ?? 5 * 60_000;
  const interruptGrace = options.interruptGraceMs ?? 5_000;
  let status: EngineStatus = { state: 'starting' };
  let connection: Connection | null = null;
  let starting: Promise<{ connection: Connection; models: CatalogModel[] }> | null = null;
  let models: CatalogModel[] = [];
  let active = false;
  const usageListeners = new Set<(observation: UsageObservation) => void>();
  const observe = (method: string, params: unknown) => {
    if (method !== 'thread/tokenUsage/updated') return;
    const parsed = TokenUsageUpdatedSchema.safeParse(params);
    if (!parsed.success) return;
    for (const listener of usageListeners) listener(parsed.data);
  };

  async function start(): Promise<{ connection: Connection; models: CatalogModel[] }> {
    const conn = new Connection(options, observe);
    try {
      await conn.spawned;
      await conn.request('initialize', {
        clientInfo: { name: 'mino', title: 'Mino', version: options.clientVersion },
        capabilities: { experimentalApi: options.dynamicTools === true },
      }, requestTimeout);
      conn.notify('initialized', {});
      if (!checkConfig(await conn.request('config/read', { includeLayers: false }, requestTimeout))) throw new StartFailure('unsafe_config');
      const account = AccountSchema.safeParse(await conn.request('account/read', { refreshToken: false }, requestTimeout));
      if (!account.success || account.data.account?.type !== 'chatgpt') throw new StartFailure('not_chatgpt');
      const listed: CatalogModel[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const parsed = ModelListSchema.safeParse(await conn.request('model/list', { limit: 100, cursor }, requestTimeout));
        if (!parsed.success) throw new StartFailure('codex_start_failed');
        for (const model of parsed.data.data) {
          if (model.hidden) continue;
          listed.push({
            id: model.id,
            displayName: model.displayName,
            isDefault: model.isDefault,
            efforts: model.supportedReasoningEfforts.map(effort => effort.reasoningEffort),
            defaultEffort: model.defaultReasoningEffort,
            speeds: model.serviceTiers.filter(tier => tier.id !== STANDARD_SPEED),
          });
        }
        cursor = parsed.data.nextCursor ?? null;
        if (!cursor) break;
      }
      return { connection: conn, models: listed };
    } catch (error) {
      await conn.kill();
      if (error instanceof StartFailure) throw error;
      throw new StartFailure('codex_start_failed');
    }
  }

  async function ensure(): Promise<{ ok: true; connection: Connection } | { ok: false; code: EngineErrorCode }> {
    if (connection?.alive) return { ok: true, connection };
    starting ??= start();
    try {
      const ready = await starting;
      connection = ready.connection;
      models = ready.models;
      status = { state: 'ready', account: 'chatgpt', models };
      return { ok: true, connection };
    } catch (error) {
      const code = error instanceof StartFailure ? error.code : 'codex_start_failed';
      status = { state: 'unavailable', message: ENGINE_ERRORS[code] };
      return { ok: false, code };
    } finally {
      starting = null;
    }
  }

  async function run(input: RunInput): Promise<EngineOutcome> {
    if (active) throw new Error('Le moteur ne traite qu’un appel à la fois.');
    active = true;
    try {
      return await runTurn(input);
    } finally {
      active = false;
    }
  }

  async function runTurn({ turn, choice, signal, onStage, onThread, onTurn, onText, depart, tools: offered }: RunInput): Promise<EngineOutcome> {
    const tools = offered?.specs.length ? offered : null;
    if (tools && !options.dynamicTools) return engineFailure('rpc_refused', 'Ce moteur n’accepte aucun outil de service. Mino n’a pas lancé l’appel.');
    const toolNames = new Set(tools?.specs.map(spec => spec.name));
    const ready = await ensure();
    if (!ready.ok) return engineFailure(ready.code);
    if (signal.aborted) return { kind: 'cancelled' };
    const resolution = resolveChoice(models, choice);
    if (!resolution.ok) return engineFailure('choice_unavailable', resolution.message);
    const used = resolution.choice;
    const conn = ready.connection;
    let threadId: string;
    try {
      const started = ThreadStartSchema.safeParse(await conn.request('thread/start', {
        model: used.model,
        cwd: options.workDir,
        sandbox: 'read-only',
        approvalPolicy: 'untrusted',
        ephemeral: true,
        baseInstructions: turn.baseInstructions,
        config: { mcp_servers: {}, web_search: 'disabled' },
        ...(tools ? { dynamicTools: [{ type: 'namespace', name: SERVICE_TOOL_NAMESPACE, description: 'Actions de service proposées par EzraBot, soumises à confirmation sur le PC.', tools: tools.specs.map(spec => ({ type: 'function', name: spec.name, description: spec.description, inputSchema: spec.inputSchema })) }] } : {}),
      }, requestTimeout));
      if (!started.success) return engineFailure('rpc_refused');
      if (started.data.model !== used.model) {
        return engineFailure('rpc_refused', 'Codex a annoncé un autre modèle que celui choisi. Mino a arrêté l’appel.');
      }
      threadId = started.data.thread.id;
      onThread(threadId);
    } catch {
      return engineFailure(conn.alive ? 'rpc_refused' : 'engine_exited');
    }

    return new Promise<EngineOutcome>(resolve => {
      let settled = false;
      let turnId: string | null = null;
      let finalText: string | null = null;
      let lastErrorCode: EngineErrorCode | null = null;
      let aborting: EngineOutcome | null = null;
      let graceTimer: NodeJS.Timeout | null = null;
      const received = new Map<string, string>();
      const early: z.infer<typeof AgentDeltaSchema>[] = [];
      const earlyItems: { method: string; event: z.infer<typeof ItemEventSchema> }[] = [];
      let resolveTurnKnownOrSettled = () => {};
      const turnKnownOrSettled = new Promise<void>(resolve => { resolveTurnKnownOrSettled = resolve; });
      const accept = (delta: z.infer<typeof AgentDeltaSchema>) => {
        if (delta.turnId !== turnId) return;
        const text = (received.get(delta.itemId) ?? '') + delta.delta;
        received.set(delta.itemId, text);
        onText?.({ threadId, turnId: delta.turnId, itemId: delta.itemId, text, final: false });
      };
      const knowTurn = (id: string) => {
        if (turnId !== null) return;
        turnId = id;
        resolveTurnKnownOrSettled();
        for (const delta of early.splice(0)) accept(delta);
        for (const item of earlyItems.splice(0)) acceptItem(item.method, item.event);
      };

      const acceptItem = (method: string, event: z.infer<typeof ItemEventSchema>) => {
        if (event.turnId !== turnId) return;
        const { type, text, id: itemId } = event.item;
        const ownToolCall = type === DYNAMIC_TOOL_ITEM && event.item.tool !== undefined && toolNames.has(event.item.tool) && event.item.namespace === SERVICE_TOOL_NAMESPACE;
        if (!ALLOWED_ITEMS.has(type) && !ownToolCall) {
          stop(engineFailure('tool_blocked'));
          return;
        }
        if (method === 'item/started' && type === 'reasoning') onStage('thinking');
        if (method === 'item/started' && type === 'agentMessage') onStage('writing');
        if (method === 'item/completed' && type === 'agentMessage' && text !== undefined) {
          finalText = text;
          if (itemId !== undefined) {
            received.set(itemId, text);
            onText?.({ threadId, turnId: event.turnId, itemId, text, final: true });
          }
        }
      };

      const finish = (outcome: EngineOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (graceTimer) clearTimeout(graceTimer);
        signal.removeEventListener('abort', onAbort);
        conn.listener = null;
        resolveTurnKnownOrSettled();
        resolve(outcome);
      };
      const interrupt = () => {
        if (turnId) conn.request('turn/interrupt', { threadId, turnId }, requestTimeout).catch(() => {});
      };
      const stop = (outcome: EngineOutcome) => {
        if (aborting || settled) return;
        aborting = outcome;
        interrupt();
        graceTimer = setTimeout(() => {
          void conn.kill();
          finish(outcome);
        }, interruptGrace);
      };
      const onAbort = () => stop({ kind: 'cancelled' });
      const deadline = setTimeout(() => stop(engineFailure('timeout')), turnTimeout);

      const refuse = (request: ServerRequest) => {
        request.refuse();
        stop(engineFailure('request_refused'));
      };
      const answerToolCall = async (request: ServerRequest, call: z.infer<typeof ToolCallSchema>, offer: TurnTools) => {
        await turnKnownOrSettled;
        if (settled || aborting || call.turnId !== turnId) return refuse(request);
        const reply = await offer.call({ callId: call.callId, tool: call.tool, arguments: call.arguments })
          .catch((): ToolReply => ({ success: false, text: 'Action refusée : le service est indisponible. Rien n’a été enregistré.' }));
        request.respond({ contentItems: [{ type: 'inputText', text: reply.text }], success: reply.success });
      };

      conn.listener = {
        serverRequest: request => {
          const call = tools && request.method === TOOL_CALL ? ToolCallSchema.safeParse(request.params) : null;
          if (!tools || !call?.success || call.data.threadId !== threadId || call.data.namespace !== SERVICE_TOOL_NAMESPACE || !toolNames.has(call.data.tool) || aborting || settled) {
            return refuse(request);
          }
          void answerToolCall(request, call.data, tools);
        },
        exit: () => finish(aborting ?? engineFailure('engine_exited')),
        notification: (method, params) => {
          const scoped = ThreadScopedSchema.safeParse(params);
          if (!scoped.success || scoped.data.threadId !== threadId) return;
          if (method === AGENT_DELTA) {
            const delta = AgentDeltaSchema.safeParse(params);
            if (!delta.success || aborting || settled) return;
            if (turnId === null) early.push(delta.data);
            else accept(delta.data);
            return;
          }
          if (method === 'turn/started') {
            const started = TurnStartedSchema.safeParse(params);
            if (started.success) knowTurn(started.data.turn.id);
            return;
          }
          if (method === 'model/rerouted') {
            stop(engineFailure('rpc_refused', 'Codex a voulu changer de modèle pendant l’appel. Mino l’a arrêté.'));
            return;
          }
          if (method === 'item/started' || method === 'item/completed') {
            const event = ItemEventSchema.safeParse(params);
            if (!event.success) return;
            if (turnId === null) earlyItems.push({ method, event: event.data });
            else acceptItem(method, event.data);
            return;
          }
          if (method === 'error') {
            const event = ErrorEventSchema.safeParse(params);
            if (event.success && !event.data.willRetry) lastErrorCode = turnErrorCode(event.data.error.codexErrorInfo);
            return;
          }
          if (method === 'turn/completed') {
            const event = TurnCompletedSchema.safeParse(params);
            if (!event.success) {
              finish(aborting ?? engineFailure('invalid_output'));
              return;
            }
            if (aborting) {
              finish(aborting);
              return;
            }
            const completed = event.data.turn;
            if (turnId !== null && completed.id !== turnId) {
              finish(engineFailure('rpc_refused', 'Codex a terminé un autre tour que celui lancé. Mino n’a rien enregistré.'));
              return;
            }
            if (completed.status === 'completed') {
              const reply = finalText === null ? null : parseEngineReply(finalText);
              finish(reply ? { kind: 'succeeded', reply, used, threadId, turnId: completed.id } : engineFailure('invalid_output'));
            } else if (completed.status === 'interrupted') {
              finish(signal.aborted ? { kind: 'cancelled' } : engineFailure('turn_failed'));
            } else {
              const info = completed.error?.codexErrorInfo;
              finish(engineFailure(info === undefined || info === null ? lastErrorCode ?? 'turn_failed' : turnErrorCode(info)));
            }
          }
        },
      };
      signal.addEventListener('abort', onAbort);

      const departure = depart();
      if (!departure.ok) {
        finish(engineFailure('admission_refused', departure.reason));
        return;
      }
      conn.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: turn.input }],
        model: used.model,
        effort: used.effort,
        serviceTierForTurn: used.speed === STANDARD_SPEED ? 'default' : used.speed,
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        approvalPolicy: 'untrusted',
        outputSchema: turn.outputSchema,
      }, requestTimeout).then(result => {
        const parsed = TurnStartSchema.safeParse(result);
        if (!parsed.success) {
          finish(engineFailure('rpc_refused'));
          return;
        }
        if (turnId !== null && turnId !== parsed.data.turn.id) {
          stop(engineFailure('rpc_refused', 'Codex a annoncé deux tours différents. Mino a arrêté l’appel.'));
          return;
        }
        onTurn(parsed.data.turn.id);
        knowTurn(parsed.data.turn.id);
        if (aborting) interrupt();
      }, () => finish(aborting ?? engineFailure(conn.alive ? 'rpc_refused' : 'engine_exited')));
      if (signal.aborted) onAbort();
    });
  }

  return {
    status: () => status,
    async catalog() {
      await ensure();
      return status;
    },
    run,
    onUsage(listener) {
      usageListeners.add(listener);
      return () => usageListeners.delete(listener);
    },
    async close() {
      const conn = connection;
      connection = null;
      await conn?.kill();
    },
  };
}
