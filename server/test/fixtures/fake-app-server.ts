import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

// Test-only stand-in for `codex app-server`, driven by a scenario name.
// Mino spawns it as `node fake-app-server.js <scenario> app-server --listen stdio:// --disable …`.
const scenario = process.argv[2] ?? 'reply';
const args = process.argv.slice(3);
const disabled = new Set<string>();
args.forEach((arg, i) => {
  const next = args[i + 1];
  if (arg === '--disable' && next) disabled.add(next);
});

const envProbe = process.env.MINO_TEST_ENV_PROBE;
if (envProbe) writeFileSync(envProbe, JSON.stringify(Object.keys(process.env).filter(name => /composio/i.test(name))));

const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method: string, params: unknown) => send({ method, params });
let serverRequestId = 1000;
let activeTurn: { threadId: string; turnId: string } | null = null;
let experimentalApi = false;
/** Tools registered on each thread, as the real App Server keeps them. */
const threadTools = new Map<string, string[]>();
/** Requests this fake sent to Mino and the answers it got back, so a scenario can wait for the real answer. */
const answers = new Map<string | number, { count: number; settle: (answer: Record<string, unknown>) => void }>();
/** Report turns already failed once, for a request that asks for a fragile report. */
const fragileReports = new Set<string>();

const MODELS = [
  { id: 'fake-sol', displayName: 'Fake Sol', hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'low', serviceTiers: [{ id: 'priority', name: 'Fast', description: '2x' }] },
  { id: 'fake-hidden', displayName: 'Hidden', hidden: true, isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low', serviceTiers: [] },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function complete(threadId: string, turnId: string, status: string, error: unknown = null) {
  notify('turn/completed', { threadId, turn: { id: turnId, status, error, items: [] } });
  activeTurn = null;
}

function agentMessage(threadId: string, turnId: string, text: string) {
  notify('item/started', { threadId, turnId, item: { type: 'reasoning', id: 'r1', summary: [], content: [] } });
  notify('item/completed', { threadId, turnId, item: { type: 'reasoning', id: 'r1', summary: [], content: [] } });
  notify('item/started', { threadId, turnId, item: { type: 'agentMessage', id: 'm1', text: '' } });
  notify('item/agentMessage/delta', { threadId, turnId, itemId: 'm1', delta: text.slice(0, 5) });
  notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: 'm1', text } });
}

function counts(base: number) {
  return { inputTokens: base, cachedInputTokens: base / 2, cacheWriteInputTokens: 0, outputTokens: base / 10, reasoningOutputTokens: base / 20, totalTokens: base + base / 10 };
}

function usage(threadId: string, turnId: string, total: number, last = total) {
  notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { last: counts(last), total: counts(total), modelContextWindow: 258400 } });
}

function streamed(threadId: string, turnId: string, text: string, pieces: number, everyMs: number, done: () => void) {
  notify('item/started', { threadId, turnId, item: { type: 'agentMessage', id: 'm-stream', text: '' } });
  const size = Math.ceil(text.length / pieces);
  let at = 0;
  const tick = () => {
    if (activeTurn?.turnId !== turnId) return;
    notify('item/agentMessage/delta', { threadId, turnId: 'turn-elsewhere', itemId: 'm-stream', delta: 'BRUIT' });
    notify('item/agentMessage/delta', { threadId: 'thread-elsewhere', turnId, itemId: 'm-stream', delta: 'BRUIT' });
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'm-stream', delta: text.slice(at, at + size) });
    at += size;
    if (at < text.length) {
      setTimeout(tick, everyMs);
      return;
    }
    notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: 'm-stream', text } });
    done();
  };
  tick();
}

const STREAMED = JSON.stringify({ reply: 'Plan prêt 🌱.', deliverable: { title: 'Plan « été »', body: '# Plan\n\n' + Array.from({ length: 12 }, (_, i) => `- Étape ${i + 1} : préparer \"la suite\" \\ ${'é'.repeat(i)}`).join('\n') } });

const REPLY = JSON.stringify({ reply: 'Bonjour depuis le faux moteur.', deliverable: null });

function ask(id: string | number, method: string, params: unknown): Promise<Record<string, unknown>> {
  return new Promise(settle => {
    answers.set(id, { count: 0, settle });
    send({ id, method, params });
  });
}

/** The document version Mino put in the turn when the person prepared the action from one. */
const sourceText = (input: string): string | null => /Texte complet :\n([\s\S]*?)\n--- fin de la version source ---/.exec(input)?.[1] ?? null;

/** Synthetic arguments built from the person's request, so a test steers the action through its message. A source version becomes the body. */
function toolArguments(tool: string, request: string, input: string): Record<string, unknown> {
  if (tool === 'GMAIL_SEND_EMAIL') return { to: 'personne@exemple.invalid', subject: request, body: sourceText(input) ?? 'Texte synthétique du faux moteur.' };
  if (tool === 'SLACK_SEND_MESSAGE') return { channel: '#synthetique', text: request };
  if (tool === 'GMAIL_FETCH_EMAILS') return { query: request };
  return {};
}

const EARLY_ID = 'outil-précoce';
const TOOL_SCENARIOS = new Set(['tool-call', 'tool-call-number-id', 'tool-call-early', 'tool-call-twice', 'tool-call-then-fail', 'tool-call-hang',
  'tool-call-owned-namespace', 'tool-call-no-namespace', 'tool-item-foreign-namespace', 'tool-item-no-namespace', 'tool-call-wrong-turn', 'tool-call-wrong-thread', 'tool-call-namespace', 'tool-call-unknown-tool', 'tool-item-foreign', 'tool-then-approval']);

/**
 * A turn that calls one registered tool, waits for Mino's real answer, and only then writes its reply.
 * The reply quotes the answer and how many answers arrived, so a test sees what the round trip carried.
 */
async function toolTurn(threadId: string, turnId: string, input: string, early: Promise<Record<string, unknown>> | null) {
  const registered = threadTools.get(threadId) ?? [];
  const request = input.split('\n').at(-1) ?? '';
  const tool = scenario === 'tool-call-unknown-tool' ? 'COMPOSIO_MULTI_EXECUTE_TOOL' : registered[0] ?? 'AUCUN_OUTIL';
  const params = {
    threadId: scenario === 'tool-call-wrong-thread' ? 'thread-elsewhere' : threadId,
    turnId: scenario === 'tool-call-wrong-turn' ? 'turn-elsewhere' : turnId,
    callId: 'call-1', namespace: scenario === 'tool-call-namespace' ? 'autre' : scenario === 'tool-call-no-namespace' ? null : 'ezrabot_services', tool, arguments: toolArguments(tool, request, input),
  };
  const item = { type: 'dynamicToolCall', id: 'tool-1', namespace: scenario === 'tool-item-foreign-namespace' ? 'autre' : scenario === 'tool-item-no-namespace' ? null : 'ezrabot_services', tool: scenario === 'tool-item-foreign' ? 'shell' : registered[0] ?? tool, arguments: params.arguments, status: 'inProgress', contentItems: null, success: null, durationMs: null };
  notify('item/started', { threadId, turnId, item });
  if (scenario === 'tool-item-foreign' || scenario === 'tool-item-foreign-namespace' || scenario === 'tool-item-no-namespace') return;
  const id = scenario === 'tool-call-number-id' ? serverRequestId++ : `outil-${serverRequestId++}`;
  const answer = await (early ?? ask(id, 'item/tool/call', params));
  const answered = early ? EARLY_ID : id;
  if (isRecord(answer.error)) return;
  const result = isRecord(answer.result) ? answer.result : {};
  const items = Array.isArray(result.contentItems) ? result.contentItems : [];
  const text = isRecord(items[0]) ? String(items[0].text) : '';
  let second = '';
  if (scenario === 'tool-call-twice') {
    const again = await ask(`outil-${serverRequestId++}`, 'item/tool/call', { ...params, callId: 'call-2', arguments: { ...params.arguments, subject: 'Autre objet' } });
    second = ` | deuxième appel : ${isRecord(again.result) ? String(again.result.success) : 'refusé'}`;
  }
  await new Promise(resolve => setTimeout(resolve, 20));
  notify('item/completed', { threadId, turnId, item: { ...item, status: 'completed', contentItems: items, success: result.success === true } });
  if (scenario === 'tool-then-approval') {
    send({ id: serverRequestId++, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'c1' } });
    return;
  }
  if (scenario === 'tool-call-hang') return;
  if (scenario === 'tool-call-then-fail') {
    notify('error', { threadId, turnId, willRetry: false, error: { message: 'raw upstream text', codexErrorInfo: 'serverOverloaded' } });
    return complete(threadId, turnId, 'failed', { message: 'raw upstream text', codexErrorInfo: 'serverOverloaded' });
  }
  const count = answers.get(answered)?.count ?? 0;
  agentMessage(threadId, turnId, JSON.stringify({ reply: `Je propose ${tool}. Réponse de l’outil (${String(result.success)}, ${count} réponse) : ${text}${second}`, deliverable: null }));
  complete(threadId, turnId, 'completed');
}

/** A turn without tools in a tool scenario: an ordinary reply, or the report of a receipt read from the input. */
function plainTurn(threadId: string, turnId: string, input: string) {
  const state = /état : ([a-z_]+)/.exec(input)?.[1];
  const request = /Demande initiale de la personne :\n([^\n]*)/.exec(input)?.[1] ?? '';
  if (state && request.includes('rapport fragile') && !fragileReports.has(request)) {
    fragileReports.add(request);
    notify('error', { threadId, turnId, willRetry: false, error: { message: 'raw upstream text', codexErrorInfo: 'serverOverloaded' } });
    return complete(threadId, turnId, 'failed', { message: 'raw upstream text', codexErrorInfo: 'serverOverloaded' });
  }
  const asked = input.split('\n').at(-1) ?? '';
  agentMessage(threadId, turnId, state
    ? JSON.stringify({ reply: `Compte rendu : l’action est dans l’état ${state}.`, deliverable: null })
    : asked.includes('note synthétique')
      ? JSON.stringify({ reply: 'Voici la note.', deliverable: { title: 'Note synthétique', body: 'Première version de la note synthétique.' } })
      : REPLY);
  complete(threadId, turnId, 'completed');
}

function startTurn(params: Record<string, unknown>) {
  const threadId = String(params.threadId);
  const turnId = `turn-${Date.now()}-${serverRequestId++}`;
  activeTurn = { threadId, turnId };
  const first = Array.isArray(params.input) && isRecord(params.input[0]) ? String(params.input[0].text) : '';
  const withTools = TOOL_SCENARIOS.has(scenario) && (threadTools.get(threadId)?.length ?? 0) > 0;
  // Sent before this function returns, so it reaches Mino before the answer to turn/start.
  const early = scenario === 'tool-call-early' && withTools
    ? ask(EARLY_ID, 'item/tool/call', { threadId, turnId, callId: 'call-1', namespace: 'ezrabot_services', tool: threadTools.get(threadId)?.[0], arguments: toolArguments(threadTools.get(threadId)?.[0] ?? '', first.split('\n').at(-1) ?? '', first) })
    : null;
  if (scenario === 'usage-before-wrong-turn') usage(threadId, 'turn-elsewhere', 9000);
  if (scenario === 'early-item') agentMessage(threadId, turnId, REPLY);
  setTimeout(() => {
    notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', items: [] } });
    if (TOOL_SCENARIOS.has(scenario)) {
      if (withTools) void toolTurn(threadId, turnId, first, early);
      else plainTurn(threadId, turnId, first);
      return;
    }
    switch (scenario) {
      case 'early-item':
        return complete(threadId, turnId, 'completed');
      case 'wrong-item-turn':
        agentMessage(threadId, turnId, REPLY);
        agentMessage(threadId, 'turn-elsewhere', JSON.stringify({ reply: 'WRONG_TURN_ACCEPTED', deliverable: { title: 'Foreign', body: 'OTHER_TURN_BODY' } }));
        notify('item/completed', { threadId, item: { type: 'agentMessage', id: 'missing-turn', text: 'MISSING_TURN' } });
        return complete(threadId, turnId, 'completed');
      case 'reply':
        agentMessage(threadId, turnId, JSON.stringify({ reply: 'Bonjour depuis le faux moteur.', deliverable: null }));
        return complete(threadId, turnId, 'completed');
      case 'deliverable':
        agentMessage(threadId, turnId, JSON.stringify({ reply: 'Voici le texte.', deliverable: { title: 'Invitation', body: 'Viens samedi.' } }));
        return complete(threadId, turnId, 'completed');
      case 'invalid-output':
        agentMessage(threadId, turnId, JSON.stringify({ reply: 'Sans livrable', extra: true }));
        return complete(threadId, turnId, 'completed');
      case 'tool':
        notify('item/started', { threadId, turnId, item: { type: 'commandExecution', id: 'c1', command: 'ls' } });
        return;
      case 'approval':
        send({ id: serverRequestId++, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'c1' } });
        return;
      case 'token-refresh':
        send({ id: serverRequestId++, method: 'account/chatgptAuthTokens/refresh', params: { reason: 'unauthorized' } });
        return;
      case 'turn-failed':
        notify('error', { threadId, turnId, willRetry: false, error: { message: 'raw upstream text', codexErrorInfo: 'usageLimitExceeded' } });
        return complete(threadId, turnId, 'failed', { message: 'raw upstream text', codexErrorInfo: 'usageLimitExceeded' });
      case 'exit-mid-turn':
        process.exit(3);
        return;
      case 'usage-before-wrong-turn':
      case 'usage-before':
        usage(threadId, turnId, 1000);
        agentMessage(threadId, turnId, REPLY);
        usage(threadId, turnId, 1200, 200);
        return complete(threadId, turnId, 'completed');
      case 'usage-after':
        agentMessage(threadId, turnId, REPLY);
        complete(threadId, turnId, 'completed');
        setTimeout(() => usage(threadId, turnId, 2000), 40);
        return;
      case 'usage-noise': {
        const { cacheWriteInputTokens: _omitted, ...withoutCacheWrite } = counts(3000);
        notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { last: withoutCacheWrite, total: withoutCacheWrite } });
        notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { last: counts(-5), total: counts(-5), modelContextWindow: null } });
        notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: counts(1) } });
        usage('thread-elsewhere', turnId, 9000);
        usage(threadId, 'turn-elsewhere', 9000);
        agentMessage(threadId, turnId, REPLY);
        return complete(threadId, turnId, 'completed');
      }
      case 'usage-failed':
        usage(threadId, turnId, 500);
        notify('error', { threadId, turnId, willRetry: false, error: { message: 'raw upstream text', codexErrorInfo: 'serverOverloaded' } });
        return complete(threadId, turnId, 'failed', { message: 'raw upstream text', codexErrorInfo: 'serverOverloaded' });
      case 'no-usage':
        agentMessage(threadId, turnId, REPLY);
        return complete(threadId, turnId, 'completed');
      case 'stream':
        return streamed(threadId, turnId, STREAMED, 12, 25, () => complete(threadId, turnId, 'completed'));
      case 'stream-cut':
        return streamed(threadId, turnId, STREAMED.slice(0, 80) + '"}', 6, 10, () => complete(threadId, turnId, 'completed'));
      case 'hang':
      case 'slow':
        return;
      default:
        // `item:<type>`: Codex starts an item of that type, as it would for a shell command, a file change or a web search.
        if (scenario.startsWith('item:')) notify('item/started', { threadId, turnId, item: { type: scenario.slice(5), id: 'x1' } });
        return;
    }
  }, 5);
  return { turn: { id: turnId, status: 'inProgress', items: [] } };
}

let threadParams: Record<string, unknown> = {};

function handle(method: string, params: Record<string, unknown>): unknown {
  switch (method) {
    case 'initialize':
      experimentalApi = isRecord(params.capabilities) && params.capabilities.experimentalApi === true;
      if (process.env.MINO_TEST_INIT_PROBE) writeFileSync(process.env.MINO_TEST_INIT_PROBE, JSON.stringify(params.capabilities ?? null));
      return { userAgent: 'fake', codexHome: '/nonexistent', platformFamily: 'unix', platformOs: 'linux' };
    case 'config/read': {
      const features = Object.fromEntries([...disabled].map(name => [name, scenario === 'unsafe-config' ? true : false]));
      return { config: { features, skills: { max_context_tokens: scenario !== 'unsafe-skill-budget' && args.includes('skills.max_context_tokens=1') ? 1 : 10000, include_instructions: scenario === 'unsafe-context' || !args.includes('skills.include_instructions=false'), bundled: { enabled: scenario === 'unsafe-bundled-skills' || !args.includes('skills.bundled.enabled=false') } }, project_doc_max_bytes: scenario !== 'unsafe-project-docs' && args.includes('project_doc_max_bytes=0') ? 0 : 32768, mcp_servers: {}, web_search: args.includes('web_search="disabled"') ? 'disabled' : 'live' }, origins: {}, layers: null };
    }
    case 'account/read':
      return { account: { type: scenario === 'api-key' ? 'apiKey' : 'chatgpt' }, requiresOpenaiAuth: true };
    case 'model/list':
      return { data: MODELS, nextCursor: null };
    case 'thread/start': {
      threadParams = params;
      const config = isRecord(params.config) ? params.config : {};
      if (params.ephemeral !== true || params.sandbox !== 'read-only' || config.web_search !== 'disabled') throw new Error('unsafe thread');
      const dynamicTools = Array.isArray(params.dynamicTools) ? params.dynamicTools : [];
      // Like the real App Server: tools are refused without the experimental capability, and no scenario outside the tool ones expects any.
      if (dynamicTools.length && (!experimentalApi || !TOOL_SCENARIOS.has(scenario))) throw new Error('dynamicTools refused');
      if (scenario === 'tool-call-owned-namespace' && (!process.argv.includes('features.code_mode={enabled=false,direct_only_tool_namespaces=["ezrabot_services"]}') || !dynamicTools.some(tool => isRecord(tool) && tool.type === 'namespace' && tool.name === 'ezrabot_services'))) throw new Error('service tools need their directly visible namespace');
      if (dynamicTools.some(tool => !isRecord(tool) || tool.type !== 'namespace' || tool.name !== 'ezrabot_services' || !Array.isArray(tool.tools))) throw new Error('bad tool namespace');
      const functions = dynamicTools.flatMap(tool => isRecord(tool) && Array.isArray(tool.tools) ? tool.tools : []);
      if (functions.some((tool: unknown) => !isRecord(tool) || tool.type !== 'function' || typeof tool.name !== 'string' || typeof tool.description !== 'string' || !isRecord(tool.inputSchema))) throw new Error('bad tool spec');
      const threadId = `thread-${Date.now()}-${serverRequestId++}`;
      threadTools.set(threadId, functions.map((tool: unknown) => isRecord(tool) ? String(tool.name) : ''));
      return { thread: { id: threadId }, model: params.model, modelProvider: 'openai', serviceTier: null };
    }
    case 'turn/start': {
      if (process.env.MINO_TEST_BOUNDARY_PROBE) writeFileSync(process.env.MINO_TEST_BOUNDARY_PROBE, JSON.stringify({ argv: args, thread: threadParams, turn: params }));
      if (scenario === 'reject-turn') throw new Error('turn refused');
      const sandbox = isRecord(params.sandboxPolicy) ? params.sandboxPolicy : {};
      if (sandbox.type !== 'readOnly' || sandbox.networkAccess !== false || !isRecord(params.outputSchema)) throw new Error('unsafe turn');
      return startTurn(params);
    }
    case 'turn/interrupt': {
      const turn = activeTurn;
      if (turn) {
        setTimeout(() => {
          complete(turn.threadId, turn.turnId, 'interrupted');
          if (scenario === 'slow') setTimeout(() => usage(turn.threadId, turn.turnId, 700), 20);
        }, 5);
      }
      return {};
    }
    default:
      throw new Error('unknown method');
  }
}

createInterface({ input: process.stdin }).on('line', line => {
  const message: unknown = JSON.parse(line);
  if (!isRecord(message)) return;
  if (typeof message.method !== 'string') {
    const waiting = typeof message.id === 'string' || typeof message.id === 'number' ? answers.get(message.id) : undefined;
    if (waiting) {
      waiting.count += 1;
      waiting.settle(message);
    }
    return;
  }
  if (message.id === undefined) return;
  if (process.env.MINO_TEST_RPC_PROBE) appendFileSync(process.env.MINO_TEST_RPC_PROBE, message.method + '\n');
  try {
    send({ id: message.id, result: handle(message.method, isRecord(message.params) ? message.params : {}) });
  } catch {
    send({ id: message.id, error: { code: -32600, message: 'refused' } });
  }
});
