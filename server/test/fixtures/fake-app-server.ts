import { writeFileSync } from 'node:fs';
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

function startTurn(params: Record<string, unknown>) {
  const threadId = String(params.threadId);
  const turnId = `turn-${Date.now()}`;
  activeTurn = { threadId, turnId };
  if (scenario === 'usage-before-wrong-turn') usage(threadId, 'turn-elsewhere', 9000);
  if (scenario === 'early-item') agentMessage(threadId, turnId, REPLY);
  setTimeout(() => {
    notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', items: [] } });
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
        return;
    }
  }, 5);
  return { turn: { id: turnId, status: 'inProgress', items: [] } };
}

function handle(method: string, params: Record<string, unknown>): unknown {
  switch (method) {
    case 'initialize':
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
      const config = isRecord(params.config) ? params.config : {};
      if (params.ephemeral !== true || params.sandbox !== 'read-only' || config.web_search !== 'disabled') throw new Error('unsafe thread');
      return { thread: { id: `thread-${Date.now()}` }, model: params.model, modelProvider: 'openai', serviceTier: null };
    }
    case 'turn/start': {
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
  if (!isRecord(message) || typeof message.method !== 'string') return;
  if (message.id === undefined) return;
  try {
    send({ id: message.id, result: handle(message.method, isRecord(message.params) ? message.params : {}) });
  } catch {
    send({ id: message.id, error: { code: -32600, message: 'refused' } });
  }
});
