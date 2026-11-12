import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import type { CatalogModel } from './protocol.js';
import { AGENT_LIMITS, type AgentEngineStatus, type Usage } from './agent-protocol.js';
import { census, reap, type Census, type Liveness, type Proc } from './process-tree.js';
import { childEnv } from './child-env.js';

/**
 * Executor sessions on the official `codex app-server`.
 * Unlike the chat engine, the shell and file edits are allowed: the workspace-write sandbox limits writes to
 * the chosen project and cuts the network, but it does not limit reads. Approvals are never granted, and MCP,
 * apps, browser, computer use, native sub-agents, hooks and memories are off. Every thread start and resume
 * is checked against what Codex reports back; a different sandbox, folder, approval policy or model stops the attempt.
 */

export const AGENT_DISABLED_FEATURES = [
  'apps', 'plugins', 'browser_use', 'browser_use_external', 'in_app_browser', 'computer_use',
  'multi_agent', 'memories', 'hooks', 'image_generation', 'goals', 'tool_suggest', 'skill_search',
] as const;

export const AGENT_CONFIG_ARGS = [
  '-c', 'mcp_servers={}',
  '-c', 'web_search="disabled"',
  '-c', 'skills.bundled.enabled=false',
  '-c', 'skills.include_instructions=false',
] as const;

const ALLOWED_ITEMS = new Set(['userMessage', 'agentMessage', 'reasoning', 'contextCompaction', 'commandExecution', 'fileChange', 'plan']);

export type AgentSandbox = 'workspace-write' | 'read-only';

export type AgentEventInput =
  | { kind: 'agent_message'; data: { text: string } }
  | { kind: 'command_started'; data: { itemId: string; command: string; cwd: string } }
  | { kind: 'command'; data: { itemId: string; command: string; cwd: string; status: string; exitCode: number | null; durationMs: number | null; output: string } }
  | { kind: 'file_change'; data: { itemId: string; status: string; changes: { path: string; kind: string; diff: string }[] } }
  | { kind: 'plan'; data: { text: string } }
  | { kind: 'approval_declined'; data: { method: string; command: string | null; reason: string | null } }
  | { kind: 'blocked_tool'; data: { type: string } }
  | { kind: 'error'; data: { message: string; willRetry: boolean } };

export type AgentRunInput = {
  cwd: string;
  sandbox: AgentSandbox;
  /** Resume this native thread instead of starting one. */
  threadId: string | null;
  model: string | null;
  effort: string | null;
  developerInstructions: string;
  input: string;
  /** Constrains the final message of the turn; sent to Codex only when set. */
  outputSchema?: object | null;
  signal: AbortSignal;
  onThread(threadId: string, model: string, effort: string | null): void;
  onTurn(turnId: string): void;
  onEvent(event: AgentEventInput): void;
  onActivity(activity: string | null, text: string): void;
  onUsage(usage: Usage): void;
};

export type AgentRunOutcome =
  | { kind: 'completed'; finalText: string | null; threadId: string; turnId: string }
  /** Codex confirmed the interruption of the turn. */
  | { kind: 'stopped'; threadId: string | null; turnId: string | null }
  /** `effects` is false only when Codex answered that no turn was started, so nothing can have run. */
  | { kind: 'failed'; code: AgentErrorCode; message: string; effects: boolean }
  /** After `turn/start` was sent, Codex ended or stopped answering without a confirmed end: effects are unknown. */
  | { kind: 'interrupted'; message: string };

export const AGENT_ERRORS = {
  codex_missing: 'Codex est introuvable sur cet ordinateur. Installez Codex ou indiquez son chemin avec MINO_CODEX_BIN.',
  codex_start_failed: 'Codex n’a pas pu démarrer pour l’exécutant.',
  unsafe_config: 'Codex n’a pas confirmé la configuration limitée de l’exécutant (connecteurs, navigateur, sous-agents ou recherche web encore actifs). Mino refuse de lancer la tentative.',
  not_chatgpt: 'Codex n’est pas connecté avec un compte ChatGPT. Lancez « codex login ».',
  model_unavailable: 'Ce modèle ou cet effort n’est pas proposé par Codex.',
  model_changed: 'Codex a annoncé un autre modèle que celui choisi. Mino a arrêté la tentative.',
  sandbox_mismatch: 'Codex n’a pas confirmé le bac à sable demandé (dossier, écriture, réseau ou autorisations). Mino a arrêté la tentative avant le travail.',
  thread_refused: 'Codex a refusé d’ouvrir ou de reprendre la session de l’exécutant.',
  turn_refused: 'Codex a refusé de démarrer le tour.',
  blocked_tool: 'L’exécutant a utilisé un outil non autorisé. Mino a arrêté le tour.',
  turn_failed: 'Codex a signalé un échec du tour.',
  timeout: 'La tentative a dépassé la durée maximale. Mino a demandé son arrêt.',
  usage_limit: 'La limite d’utilisation de votre compte est atteinte.',
  unauthorized: 'La session Codex n’est plus valide. Relancez « codex login ».',
  tools_alive: 'Des outils lancés par une tentative précédente tournent encore ou n’ont pas pu être vérifiés. Mino ne relance pas Codex tant qu’ils ne sont pas confirmés arrêtés.',
} as const;
export type AgentErrorCode = keyof typeof AGENT_ERRORS;

/** How a sandboxed command ended, as far as Codex confirmed it. */
export type ExecOutcome =
  | { kind: 'exited'; exitCode: number; stdout: string; stderr: string }
  /** Codex answered with an error, or could not start: the command is not running. */
  | { kind: 'refused'; message: string }
  /** A stop was asked, Codex then answered, and every process Mino saw under it is confirmed ended. */
  | { kind: 'cancelled' }
  /** No answer: Mino closed its Codex connection, and the command may have kept running. */
  | { kind: 'unknown'; message: string };

export type ExecInput = { cwd: string; argv: string[]; sandbox: AgentSandbox; signal: AbortSignal; env?: Record<string, string | null>; timeoutMs?: number };

export type AgentEngine = {
  status(): AgentEngineStatus;
  catalog(): Promise<{ ok: true; models: CatalogModel[] } | { ok: false; message: string }>;
  run(input: AgentRunInput): Promise<AgentRunOutcome>;
  /** Runs an argv (no shell) inside a Codex sandbox on `cwd`, without a model call. Aborting asks Codex to terminate it. */
  exec(input: ExecInput): Promise<ExecOutcome>;
  close(): Promise<void>;
};

export type AgentEngineOptions = {
  command: string;
  args?: readonly string[];
  /** Private temporary folder handed to Codex as TMPDIR; /tmp itself stays read-only for the executor. */
  tmpDir: string;
  clientVersion: string;
  turnTimeoutMs?: number;
  requestTimeoutMs?: number;
  interruptGraceMs?: number;
  /** Where the process listing is read. Tests point it elsewhere to make it unreadable. */
  procRoot?: string;
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
  }),
});
const AccountSchema = z.object({ account: z.object({ type: z.string() }).nullable() });
const ModelListSchema = z.object({
  data: z.array(z.object({
    id: z.string(), displayName: z.string(), hidden: z.boolean(), isDefault: z.boolean(),
    supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })),
    defaultReasoningEffort: z.string(),
  })),
  nextCursor: z.string().nullable().optional(),
});
const SandboxSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('workspaceWrite'), writableRoots: z.array(z.string()), networkAccess: z.boolean() }),
  z.object({ type: z.literal('readOnly'), networkAccess: z.boolean() }),
  z.object({ type: z.literal('dangerFullAccess') }),
  z.object({ type: z.literal('externalSandbox') }),
]);
const ThreadOpenSchema = z.object({
  thread: z.object({ id: z.string() }),
  model: z.string(),
  cwd: z.string(),
  approvalPolicy: z.unknown(),
  sandbox: SandboxSchema,
  reasoningEffort: z.string().nullable().optional(),
});
const TurnStartSchema = z.object({ turn: z.object({ id: z.string() }) });
const Scoped = z.object({ threadId: z.string() });
const TurnStartedSchema = z.object({ threadId: z.string(), turn: z.object({ id: z.string() }) });
const ItemSchema = z.object({
  threadId: z.string(), turnId: z.string(),
  item: z.object({
    type: z.string(), id: z.string().optional(), text: z.string().optional(),
    command: z.string().optional(), cwd: z.string().optional(), status: z.string().optional(),
    exitCode: z.number().nullable().optional(), durationMs: z.number().nullable().optional(),
    aggregatedOutput: z.string().nullable().optional(),
    changes: z.array(z.object({ path: z.string(), kind: z.object({ type: z.string() }).passthrough(), diff: z.string().optional() })).optional(),
  }).passthrough(),
});
const DeltaSchema = z.object({ threadId: z.string(), turnId: z.string(), itemId: z.string(), delta: z.string() });
const ErrorSchema = z.object({ threadId: z.string(), willRetry: z.boolean(), error: z.object({ message: z.string().optional(), codexErrorInfo: z.unknown().optional() }) });
const CompletedSchema = z.object({
  threadId: z.string(),
  turn: z.object({ id: z.string(), status: z.string(), error: z.object({ message: z.string().optional(), codexErrorInfo: z.unknown().optional() }).nullable().optional() }),
});
const count = z.number().int().nonnegative();
const UsageSchema = z.object({
  threadId: z.string(), turnId: z.string(),
  tokenUsage: z.object({ last: z.object({ inputTokens: count, cachedInputTokens: count, outputTokens: count, reasoningOutputTokens: count, totalTokens: count }) }),
});
const ExecSchema = z.object({ exitCode: z.number(), stdout: z.string(), stderr: z.string() });

export function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  const head = Math.floor(max * 0.4);
  const tail = max - head;
  return `${value.slice(0, head)}\n… [${value.length - max} caractères omis par Mino] …\n${value.slice(-tail)}`;
}

class RpcError extends Error {}

/** Appended to an unknown result: what Mino could confirm about the tools Codex had started. */
function toolsNote(verdict: Liveness): string {
  if (verdict === 'gone') return 'Les processus que Mino a relevés sous Codex sont arrêtés.';
  if (verdict === 'running') return 'Des processus relevés sous Codex tournent encore : Mino ne relancera pas Codex tant qu’ils tournent.';
  return 'Mino n’a pas pu vérifier que les outils lancés par Codex sont arrêtés.';
}

class Connection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private seq = 0;
  private closing: Promise<void> | null = null;
  private ending: Promise<Census> | null = null;
  private exitedProcess = false;
  alive = true;
  onNotification: ((method: string, params: unknown) => void) | null = null;
  onServerRequest: ((method: string, params: unknown) => void) | null = null;
  onExit: (() => void) | null = null;
  readonly spawned: Promise<void>;
  readonly exited: Promise<void>;

  private readonly procRoot: string;

  constructor(options: AgentEngineOptions) {
    this.procRoot = options.procRoot ?? '/proc';
    const args = [
      ...(options.args ?? []),
      'app-server', '--listen', 'stdio://',
      ...AGENT_DISABLED_FEATURES.flatMap(feature => ['--disable', feature]),
      ...AGENT_CONFIG_ARGS,
    ];
    mkdirSync(options.tmpDir, { recursive: true, mode: 0o700 });
    this.child = spawn(options.command, args, {
      cwd: options.tmpDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...childEnv(process.env), TMPDIR: options.tmpDir },
    });
    this.child.stderr.resume();
    this.child.stdin.on('error', () => {});
    this.spawned = new Promise((resolve, reject) => {
      this.child.once('spawn', () => resolve());
      this.child.once('error', error => reject(Object.assign(new Error('spawn'), { code: 'code' in error ? error.code : undefined })));
    });
    this.spawned.catch(() => {});
    this.child.once('exit', () => { this.exitedProcess = true; });
    this.exited = new Promise(resolve => {
      this.child.once('close', () => {
        this.alive = false;
        for (const waiter of this.pending.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(new RpcError('closed'));
        }
        this.pending.clear();
        this.onExit?.();
        resolve();
      });
    });
    createInterface({ input: this.child.stdout }).on('line', line => this.receive(line));
  }

  private send(value: unknown): void {
    if (this.alive) this.child.stdin.write(JSON.stringify(value) + '\n');
  }

  respond(id: number | string, result: unknown): void {
    this.send({ id, result });
  }

  respondError(id: number | string, message: string): void {
    this.send({ id, error: { code: -32000, message } });
  }

  private receive(line: string): void {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { return; }
    const parsed = EnvelopeSchema.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.id !== undefined && message.method !== undefined) {
      this.serverRequest(message.id, message.method, message.params);
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
    if (message.method !== undefined) this.onNotification?.(message.method, message.params);
  }

  /** Approvals are always declined: the sandbox decides, never an escalation. Anything else is refused. */
  private serverRequest(id: number | string, method: string, params: unknown): void {
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') this.respond(id, { decision: 'decline' });
    else if (method === 'execCommandApproval' || method === 'applyPatchApproval') this.respond(id, { decision: 'denied' });
    else this.respondError(id, 'Mino refuse cette demande pour un exécutant.');
    this.onServerRequest?.(method, params);
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

  /** The processes Codex runs for Mino right now. Once Codex has exited, its PID may name another process. */
  processes(): Census {
    if (this.child.pid === undefined) return { kind: 'seen', procs: [] };
    if (this.exitedProcess) return { kind: 'unknown', reason: 'Codex s’est arrêté avant le relevé' };
    return census(this.child.pid, this.procRoot);
  }

  /** Lists what runs under Codex, then closes it: the listing is the only way to find its tools afterwards. */
  end(): Promise<Census> {
    this.ending ??= (async () => {
      const seen = this.processes();
      const closed = this.kill();
      await reap([seen], this.procRoot);
      await closed;
      return seen;
    })();
    return this.ending;
  }

  private kill(): Promise<void> {
    if (this.closing) return this.closing;
    if (!this.alive) return this.exited;
    this.alive = false;
    const closeOutput = () => { this.child.stdout.destroy(); this.child.stderr.destroy(); };
    if (this.exitedProcess) closeOutput();
    else this.child.once('exit', closeOutput);
    this.child.stdin.end();
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    this.closing = this.exited.finally(() => clearTimeout(timer));
    return this.closing;
  }
}

class StartFailure extends Error {
  constructor(readonly code: AgentErrorCode) { super(AGENT_ERRORS[code]); }
}

function configSafe(value: unknown): boolean {
  const parsed = ConfigReadSchema.safeParse(value);
  if (!parsed.success) return false;
  const { features, mcp_servers: servers, web_search: webSearch } = parsed.data.config;
  const featuresOff = AGENT_DISABLED_FEATURES.every(feature => features?.[feature] === false);
  const mcpOff = Object.values(servers ?? {}).every(server =>
    server !== null && typeof server === 'object' && 'enabled' in server && server.enabled === false);
  return featuresOff && mcpOff && webSearch === 'disabled';
}

function turnError(info: unknown): AgentErrorCode {
  if (info === 'usageLimitExceeded' || info === 'sessionBudgetExceeded') return 'usage_limit';
  if (info === 'unauthorized') return 'unauthorized';
  return 'turn_failed';
}

/** The exact sandbox Codex must confirm for this attempt. */
export function sandboxPolicy(cwd: string, sandbox: AgentSandbox): Record<string, unknown> {
  return sandbox === 'read-only'
    ? { type: 'readOnly', networkAccess: false }
    : { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: true };
}

/** True only if what Codex reports is no wider than the requested sandbox. */
export function confirmsSandbox(reported: z.infer<typeof ThreadOpenSchema>, cwd: string, sandbox: AgentSandbox, tmpDir: string): boolean {
  if (reported.cwd !== cwd) return false;
  if (reported.approvalPolicy !== 'never') return false;
  const box = reported.sandbox;
  if (sandbox === 'read-only') return box.type === 'readOnly' && !box.networkAccess;
  if (box.type !== 'workspaceWrite' || box.networkAccess) return false;
  const inside = (root: string, base: string) => root === base || root.startsWith(base.endsWith('/') ? base : base + '/');
  return box.writableRoots.every(root => inside(root, cwd) || inside(root, tmpDir));
}

export function createAgentEngine(options: AgentEngineOptions): AgentEngine {
  const requestTimeout = options.requestTimeoutMs ?? 30_000;
  const turnTimeout = options.turnTimeoutMs ?? 20 * 60_000;
  const interruptGrace = options.interruptGraceMs ?? 15_000;
  let state: AgentEngineStatus = { state: 'idle' };
  let connection: Connection | null = null;
  let starting: Promise<{ connection: Connection; models: CatalogModel[] }> | null = null;
  let models: CatalogModel[] = [];
  let busy = false;
  /** Processes Mino killed but could not confirm ended. While any is left, Codex is not started again. */
  let lingering: Proc[] = [];

  async function sweep(censuses: Census[]): Promise<Liveness> {
    const result = await reap(censuses, options.procRoot);
    const known = new Set(lingering.map(p => `${p.pid}:${p.start}`));
    lingering = [...lingering, ...result.left.filter(p => !known.has(`${p.pid}:${p.start}`))];
    return result.verdict;
  }

  async function start(): Promise<{ connection: Connection; models: CatalogModel[] }> {
    const conn = new Connection(options);
    try {
      try { await conn.spawned; } catch (error) {
        const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
        throw new StartFailure(code === 'ENOENT' || code === 'EACCES' ? 'codex_missing' : 'codex_start_failed');
      }
      await conn.request('initialize', { clientInfo: { name: 'mino-agents', title: 'Mino exécutants', version: options.clientVersion }, capabilities: { experimentalApi: false } }, requestTimeout);
      conn.notify('initialized', {});
      if (!configSafe(await conn.request('config/read', { includeLayers: false }, requestTimeout))) throw new StartFailure('unsafe_config');
      const account = AccountSchema.safeParse(await conn.request('account/read', { refreshToken: false }, requestTimeout));
      if (!account.success || account.data.account?.type !== 'chatgpt') throw new StartFailure('not_chatgpt');
      const listed: CatalogModel[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const parsed = ModelListSchema.safeParse(await conn.request('model/list', { limit: 100, cursor }, requestTimeout));
        if (!parsed.success) throw new StartFailure('codex_start_failed');
        for (const model of parsed.data.data) {
          if (model.hidden) continue;
          listed.push({ id: model.id, displayName: model.displayName, isDefault: model.isDefault, efforts: model.supportedReasoningEfforts.map(e => e.reasoningEffort), defaultEffort: model.defaultReasoningEffort, speeds: [] });
        }
        cursor = parsed.data.nextCursor ?? null;
        if (!cursor) break;
      }
      return { connection: conn, models: listed };
    } catch (error) {
      await sweep([await conn.end()]);
      if (error instanceof StartFailure) throw error;
      throw new StartFailure('codex_start_failed');
    }
  }

  async function ensure(): Promise<{ ok: true; connection: Connection } | { ok: false; code: AgentErrorCode }> {
    if (connection?.alive) return { ok: true, connection };
    if (connection) await sweep([await connection.end()]);
    if (lingering.length) {
      lingering = (await reap([{ kind: 'seen', procs: lingering }], options.procRoot)).left;
      if (lingering.length) {
        state = { state: 'unavailable', message: AGENT_ERRORS.tools_alive };
        return { ok: false, code: 'tools_alive' };
      }
    }
    if (connection?.alive) return { ok: true, connection };
    state = { state: 'starting' };
    starting ??= start();
    try {
      const ready = await starting;
      connection = ready.connection;
      models = ready.models;
      state = { state: 'ready' };
      connection.onExit = () => { state = { state: 'idle' }; };
      return { ok: true, connection };
    } catch (error) {
      const code = error instanceof StartFailure ? error.code : 'codex_start_failed';
      state = { state: 'unavailable', message: AGENT_ERRORS[code] };
      return { ok: false, code };
    } finally {
      starting = null;
    }
  }

  function resolveModel(model: string | null, effort: string | null): { model: string; effort: string } | null {
    const chosen = model === null ? models.find(m => m.isDefault) ?? models[0] : models.find(m => m.id === model);
    if (!chosen) return null;
    const usedEffort = effort ?? chosen.defaultEffort;
    if (!chosen.efforts.includes(usedEffort)) return null;
    return { model: chosen.id, effort: usedEffort };
  }

  async function runTurn(input: AgentRunInput): Promise<AgentRunOutcome> {
    const fail = (code: AgentErrorCode, effects = false, message: string = AGENT_ERRORS[code]): AgentRunOutcome => ({ kind: 'failed', code, message, effects });
    const ready = await ensure();
    if (!ready.ok) return fail(ready.code);
    if (input.signal.aborted) return { kind: 'stopped', threadId: input.threadId, turnId: null };
    const choice = resolveModel(input.model, input.effort);
    if (!choice) return fail('model_unavailable');
    const conn = ready.connection;
    const params = {
      model: choice.model,
      cwd: input.cwd,
      sandbox: input.sandbox,
      approvalPolicy: 'never',
      developerInstructions: input.developerInstructions,
      config: { mcp_servers: {}, web_search: 'disabled' },
    };
    let threadId: string;
    try {
      const raw = input.threadId
        ? await conn.request('thread/resume', { threadId: input.threadId, ...params, excludeTurns: true }, requestTimeout)
        : await conn.request('thread/start', { ...params, ephemeral: false, serviceName: 'mino' }, requestTimeout);
      const opened = ThreadOpenSchema.safeParse(raw);
      if (!opened.success) return fail('thread_refused');
      if (opened.data.model !== choice.model) return fail('model_changed');
      if (!confirmsSandbox(opened.data, input.cwd, input.sandbox, options.tmpDir)) return fail('sandbox_mismatch');
      threadId = opened.data.thread.id;
      input.onThread(threadId, choice.model, choice.effort);
    } catch {
      return fail('thread_refused');
    }

    return new Promise<AgentRunOutcome>(resolve => {
      let phase: 'active' | 'closing' | 'settled' = 'active';
      let turnId: string | null = null;
      let stopping: AgentRunOutcome | null = null;
      let exitMessage = 'Codex s’est arrêté pendant le tour. Le résultat est inconnu ; des fichiers ont pu être modifiés.';
      let graceTimer: NodeJS.Timeout | null = null;
      let finalText: string | null = null;
      let lastError: AgentErrorCode | null = null;
      let liveText = '';
      let spent: Usage = { input: 0, cachedInput: 0, output: 0, reasoningOutput: 0, total: 0 };
      let activity: string | null = 'Démarrage du tour';
      const early: { method: string; params: unknown }[] = [];
      input.onActivity(activity, '');

      const settle = (outcome: AgentRunOutcome) => {
        if (phase === 'settled') return;
        phase = 'settled';
        clearTimeout(deadline);
        if (graceTimer) clearTimeout(graceTimer);
        input.signal.removeEventListener('abort', onAbort);
        conn.onNotification = null;
        conn.onServerRequest = null;
        conn.onExit = () => { state = { state: 'idle' }; };
        input.onActivity(null, '');
        resolve(outcome);
      };
      const finish = (outcome: AgentRunOutcome) => {
        if (phase === 'active') settle(outcome);
      };
      const interrupt = () => {
        if (turnId) conn.request('turn/interrupt', { threadId, turnId }, requestTimeout).catch(() => {});
      };
      /** The turn may be running without Mino knowing it: end the process before releasing the executor. */
      const abandon = (message: string) => {
        if (phase !== 'active') return;
        phase = 'closing';
        exitMessage = message;
        conn.onNotification = null;
        conn.onServerRequest = null;
        void conn.end().then(seen => sweep([seen])).then(verdict => settle({ kind: 'interrupted', message: `${message} ${toolsNote(verdict)}` }));
      };
      /** Asks Codex to stop. Only its `turn/completed` confirms; otherwise the result stays unknown. */
      const stop = (outcome: AgentRunOutcome) => {
        if (stopping || phase !== 'active') return;
        stopping = outcome;
        interrupt();
        graceTimer = setTimeout(() => abandon('Codex n’a pas confirmé l’arrêt à temps. Mino a fermé sa connexion ; des fichiers ont pu être modifiés.'), interruptGrace);
      };
      const onAbort = () => stop({ kind: 'stopped', threadId, turnId });
      const deadline = setTimeout(() => stop(fail('timeout', true)), turnTimeout);

      const handle = (method: string, params: unknown) => {
        if (method === 'thread/tokenUsage/updated') {
          const usage = UsageSchema.safeParse(params);
          if (usage.success && usage.data.turnId === turnId) {
            const l = usage.data.tokenUsage.last;
            spent = { input: spent.input + l.inputTokens, cachedInput: spent.cachedInput + l.cachedInputTokens, output: spent.output + l.outputTokens, reasoningOutput: spent.reasoningOutput + l.reasoningOutputTokens, total: spent.total + l.totalTokens };
            input.onUsage(spent);
          }
          return;
        }
        if (method === 'item/agentMessage/delta') {
          const delta = DeltaSchema.safeParse(params);
          if (delta.success && delta.data.turnId === turnId) {
            liveText = clip(liveText + delta.data.delta, AGENT_LIMITS.eventOutputChars);
            input.onActivity(activity, liveText);
          }
          return;
        }
        if (method === 'item/started' || method === 'item/completed') {
          const event = ItemSchema.safeParse(params);
          if (!event.success || event.data.turnId !== turnId) return;
          const item = event.data.item;
          if (!ALLOWED_ITEMS.has(item.type)) {
            input.onEvent({ kind: 'blocked_tool', data: { type: item.type } });
            stop(fail('blocked_tool', true));
            return;
          }
          if (method === 'item/started') {
            if (item.type === 'commandExecution') {
              activity = `Commande : ${clip(item.command ?? '', 160)}`;
              input.onEvent({ kind: 'command_started', data: { itemId: item.id ?? '', command: clip(item.command ?? '', 2000), cwd: item.cwd ?? '' } });
            } else if (item.type === 'fileChange') activity = 'Modification de fichiers';
            else if (item.type === 'reasoning') activity = 'Réflexion';
            else if (item.type === 'agentMessage') { activity = 'Rédaction'; liveText = ''; }
            input.onActivity(activity, liveText);
            return;
          }
          if (item.type === 'agentMessage' && item.text !== undefined) {
            finalText = item.text;
            input.onEvent({ kind: 'agent_message', data: { text: clip(item.text, AGENT_LIMITS.finalTextChars) } });
          } else if (item.type === 'commandExecution') {
            input.onEvent({ kind: 'command', data: {
              itemId: item.id ?? '', command: clip(item.command ?? '', 2000), cwd: item.cwd ?? '', status: item.status ?? 'unknown',
              exitCode: item.exitCode ?? null, durationMs: item.durationMs ?? null, output: clip(item.aggregatedOutput ?? '', AGENT_LIMITS.eventOutputChars),
            } });
          } else if (item.type === 'fileChange') {
            input.onEvent({ kind: 'file_change', data: {
              itemId: item.id ?? '', status: item.status ?? 'unknown',
              changes: (item.changes ?? []).map(change => ({ path: change.path, kind: change.kind.type, diff: clip(change.diff ?? '', AGENT_LIMITS.eventDiffChars) })),
            } });
          } else if (item.type === 'plan' && item.text) input.onEvent({ kind: 'plan', data: { text: clip(item.text, AGENT_LIMITS.eventOutputChars) } });
          return;
        }
        if (method === 'error') {
          const event = ErrorSchema.safeParse(params);
          if (!event.success) return;
          input.onEvent({ kind: 'error', data: { message: clip(event.data.error.message ?? 'Erreur signalée par Codex', 1000), willRetry: event.data.willRetry } });
          if (!event.data.willRetry) lastError = turnError(event.data.error.codexErrorInfo);
          return;
        }
        if (method === 'model/rerouted') {
          stop(fail('model_changed', true));
          return;
        }
        if (method === 'turn/completed') {
          const event = CompletedSchema.safeParse(params);
          if (!event.success || (turnId !== null && event.data.turn.id !== turnId)) return;
          const status = event.data.turn.status;
          if (status === 'completed' && !stopping) finish({ kind: 'completed', finalText, threadId, turnId: event.data.turn.id });
          else if (status === 'interrupted' || stopping) {
            finish(stopping && stopping.kind === 'failed' ? stopping : { kind: 'stopped', threadId, turnId: event.data.turn.id });
          } else {
            const info = event.data.turn.error?.codexErrorInfo;
            const code = info === undefined || info === null ? lastError ?? 'turn_failed' : turnError(info);
            finish(fail(code, true, event.data.turn.error?.message ? `${AGENT_ERRORS[code]} (${clip(event.data.turn.error.message, 400)})` : AGENT_ERRORS[code]));
          }
        }
      };

      const knowTurn = (id: string) => {
        if (phase !== 'active' || turnId !== null) return;
        turnId = id;
        input.onTurn(id);
        for (const pending of early.splice(0)) handle(pending.method, pending.params);
      };

      conn.onServerRequest = (method, params) => {
        const command = params !== null && typeof params === 'object' && 'command' in params && typeof params.command === 'string' ? clip(params.command, 500) : null;
        const reason = params !== null && typeof params === 'object' && 'reason' in params && typeof params.reason === 'string' ? clip(params.reason, 500) : null;
        input.onEvent({ kind: 'approval_declined', data: { method, command, reason } });
      };
      conn.onExit = () => {
        state = { state: 'idle' };
        finish({ kind: 'interrupted', message: `${exitMessage} ${toolsNote('unknown')}` });
      };
      conn.onNotification = (method, params) => {
        const scoped = Scoped.safeParse(params);
        if (!scoped.success || scoped.data.threadId !== threadId) return;
        if (method === 'turn/started') {
          const ev = TurnStartedSchema.safeParse(params);
          if (ev.success) knowTurn(ev.data.turn.id);
          return;
        }
        if (turnId === null) {
          early.push({ method, params });
          return;
        }
        handle(method, params);
      };
      input.signal.addEventListener('abort', onAbort);

      const delivered = conn.alive;
      conn.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: input.input }],
        model: choice.model,
        effort: choice.effort,
        cwd: input.cwd,
        sandboxPolicy: sandboxPolicy(input.cwd, input.sandbox),
        approvalPolicy: 'never',
        ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
      }, requestTimeout).then(result => {
        const parsed = TurnStartSchema.safeParse(result);
        if (parsed.success) {
          knowTurn(parsed.data.turn.id);
          if (stopping) interrupt();
        } else if (turnId === null) abandon('Codex a répondu de façon illisible au démarrage du tour. Mino a fermé sa connexion ; le résultat est inconnu.');
      }, (error: unknown) => {
        if (turnId !== null) return;
        if (!delivered) finish(fail('codex_start_failed'));
        else if (error instanceof RpcError && error.message === 'refused') finish(stopping?.kind === 'stopped' ? stopping : fail('turn_refused'));
        else if (error instanceof RpcError && error.message === 'timeout') abandon('Codex n’a pas confirmé le démarrage du tour. Mino a fermé sa connexion ; le résultat est inconnu.');
      });
      if (input.signal.aborted) onAbort();
    });
  }

  return {
    status: () => state,
    async catalog() {
      const ready = await ensure();
      return ready.ok ? { ok: true, models } : { ok: false, message: AGENT_ERRORS[ready.code] };
    },
    async run(input) {
      if (busy) throw new Error('L’exécutant ne traite qu’une tentative à la fois.');
      busy = true;
      try { return await runTurn(input); } finally { busy = false; }
    },
    async exec({ cwd, argv, sandbox, signal, env, timeoutMs = AGENT_LIMITS.checkTimeoutMs }) {
      const ready = await ensure();
      if (!ready.ok) return { kind: 'refused', message: AGENT_ERRORS[ready.code] };
      if (signal.aborted) return { kind: 'cancelled' };
      const conn = ready.connection;
      const processId = `mino_${randomUUID()}`;
      const answer = conn.request('command/exec', {
        command: argv, cwd, processId, timeoutMs, outputBytesCap: 200_000, sandboxPolicy: sandboxPolicy(cwd, sandbox), ...(env ? { env } : {}),
      }, timeoutMs + requestTimeout).then(raw => ({ raw }), (error: unknown) => ({ error }));
      let graceTimer: NodeJS.Timeout | null = null;
      let atStop: Census = { kind: 'seen', procs: [] };
      const graceOver = new Promise<'grace'>(resolve => {
        const onAbort = () => {
          atStop = conn.processes();
          conn.request('command/exec/terminate', { processId }, requestTimeout).catch(() => {});
          graceTimer = setTimeout(() => resolve('grace'), interruptGrace);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        void answer.then(() => signal.removeEventListener('abort', onAbort));
      });
      const first = await Promise.race([answer, graceOver]);
      if (graceTimer) clearTimeout(graceTimer);
      /** No confirmed end: close Codex, and end what was seen under it, at the stop and right before closing. */
      const lost = async (message: string): Promise<ExecOutcome> => {
        const verdict = await sweep([atStop, await conn.end()]);
        return { kind: 'unknown', message: `${message} ${toolsNote(verdict)}` };
      };
      /** Codex answered after the stop. Cancelled only once every process seen under it is confirmed ended. */
      const stopped = async (): Promise<ExecOutcome> => {
        const verdict = await sweep([atStop, conn.processes()]);
        if (verdict === 'gone') return { kind: 'cancelled' };
        return lost(verdict === 'running'
          ? 'La commande tournait encore après l’arrêt demandé. Mino a fermé sa connexion ; elle a pu continuer.'
          : 'Codex a répondu à l’arrêt, mais Mino n’a pas pu lire la liste des processus pour le confirmer. Mino a fermé sa connexion ; la commande a pu continuer.');
      };
      if (first === 'grace') return lost('Codex n’a pas confirmé l’arrêt de la commande. Mino a fermé sa connexion ; la commande a pu continuer.');
      if ('error' in first) {
        if (first.error instanceof RpcError && first.error.message === 'refused') return signal.aborted ? stopped() : { kind: 'refused', message: 'Codex a refusé la commande.' };
        return lost('Codex n’a pas rendu le résultat de la commande. Mino a fermé sa connexion ; la commande a pu continuer.');
      }
      if (signal.aborted) return stopped();
      const parsed = ExecSchema.safeParse(first.raw);
      if (!parsed.success) return lost('Codex a rendu un résultat illisible pour la commande. Mino a fermé sa connexion.');
      return { kind: 'exited', exitCode: parsed.data.exitCode, stdout: parsed.data.stdout, stderr: parsed.data.stderr };
    },
    async close() {
      const conn = connection;
      connection = null;
      if (conn) await sweep([await conn.end()]);
    },
  };
}
