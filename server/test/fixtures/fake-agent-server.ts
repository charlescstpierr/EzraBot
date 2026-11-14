import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

// Test-only stand-in for `codex app-server` driving an executor. Spawned as `node fake-agent-server.js <scenario> app-server …`.
const [scenario = 'edit', procDir] = (process.argv[2] ?? 'edit').split('@');
// `coord@<dir>`: a turn with an outputSchema answers the next decision of <dir>/decisions.json; every turn is logged in <dir>/turns.jsonl.
const coordDir = scenario === 'coord' ? procDir : undefined;

/** `$child1` and `$cite1` name the first step and its citable attempt, as listed in the dossier the lead received. */
function leadAnswer(text: string): string {
  if (!coordDir) return '{}';
  const counter = join(coordDir, 'decision-n');
  const index = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
  writeFileSync(counter, String(index + 1));
  const script = JSON.parse(readFileSync(join(coordDir, 'decisions.json'), 'utf8')) as unknown[];
  const children = [...text.matchAll(/childId (msn_[\w-]+)/g)].map(m => m[1] ?? '');
  const cites = [...text.matchAll(/essai citable : (att_[\w-]+)/g)].map(m => m[1] ?? '');
  const raw = JSON.stringify(script[index] ?? 'plus de décision prévue');
  return typeof script[index] === 'string' ? String(script[index]) : raw.replace(/\$child(\d)/g, (_, i) => children[Number(i) - 1] ?? 'absent').replace(/\$cite(\d)/g, (_, i) => cites[Number(i) - 1] ?? 'absent');
}
// `immortal@<dir>`: a process listing in <dir> shows a child of this server that never ends, even after SIGKILL.
if (scenario === 'immortal' && procDir) {
  const fields = ['S', String(process.pid), ...Array<string>(17).fill('0'), '12345'];
  mkdirSync(join(procDir, '4194999'), { recursive: true });
  writeFileSync(join(procDir, '4194999', 'stat'), `4194999 (tool) ${fields.join(' ')} 0 0\n`);
}

/** A tool process started by the command or the turn, outliving this server unless Mino ends it. */
const tool = (cwd: string, file: string) =>
  spawn('sh', ['-c', `sleep 1; touch '${join(cwd, file)}'`], { detached: true, stdio: 'ignore' }).unref();
const disabled = new Set<string>();
process.argv.forEach((arg, i) => { const next = process.argv[i + 1]; if (arg === '--disable' && next) disabled.add(next); });

const envProbe = process.env.MINO_TEST_ENV_PROBE;
if (envProbe) writeFileSync(envProbe, JSON.stringify(Object.keys(process.env).filter(name => /composio|honcho/i.test(name))));

const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method: string, params: unknown) => send({ method, params });
let serverId = 5000;
const threads = new Map<string, string>();
let active: { threadId: string; turnId: string } | null = null;
let closingCwd: string | null = null;

function delayClose() {
  const current = active;
  if (!current || closingCwd) return;
  closingCwd = turnCwd.get(current.threadId) ?? null;
  if (closingCwd) writeFileSync(join(closingCwd, 'connection-closing.txt'), 'closing\n');
  setTimeout(() => {
    notify('turn/started', { threadId: current.threadId, turn: { id: current.turnId, status: 'inProgress', items: [] } });
    notify('turn/completed', { threadId: current.threadId, turn: { id: current.turnId, status: 'completed', error: null, items: [] } });
  }, 30);
  setTimeout(() => {
    if (closingCwd) writeFileSync(join(closingCwd, 'old-connection-closed.txt'), 'closed\n');
    process.exit(0);
  }, 180);
}
if (scenario === 'turn-late-close') process.on('SIGTERM', delayClose);

const MODELS = [{ id: 'fake-sol', displayName: 'Fake Sol', hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'low', serviceTiers: [] }];

function opened(threadId: string, params: Record<string, unknown>) {
  const cwd = String(params.cwd);
  const sandbox = scenario === 'wide-sandbox' ? { type: 'dangerFullAccess' }
    : params.sandbox === 'read-only' ? { type: 'readOnly', networkAccess: false }
      : { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false };
  return { thread: { id: threadId }, model: String(params.model), modelProvider: 'openai', serviceTier: null, cwd, approvalPolicy: params.approvalPolicy, sandbox, reasoningEffort: 'low' };
}

function item(method: 'item/started' | 'item/completed', threadId: string, turnId: string, value: Record<string, unknown>) {
  notify(method, { threadId, turnId, item: value });
}

function usage(threadId: string, turnId: string, total: number) {
  const b = { inputTokens: total, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0, totalTokens: total + 10 };
  notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { last: b, total: b, modelContextWindow: 1000 } });
}

function runTurn(threadId: string, turnId: string, cwd: string, text: string) {
  notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', items: [] } });
  const command = { type: 'commandExecution', id: 'c1', command: 'node --test', cwd, status: 'inProgress', exitCode: null, durationMs: null, aggregatedOutput: null };
  item('item/started', threadId, turnId, command);
  if (scenario === 'exit-mid') { setTimeout(() => process.exit(3), 20); return; }
  if (scenario === 'hang' || scenario === 'deaf') return;
  if (scenario === 'mcp') { item('item/started', threadId, turnId, { type: 'mcpToolCall', id: 'm1' }); return; }
  if (scenario === 'approval') {
    send({ id: serverId++, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'c1', command: 'curl https://example.com', reason: 'réseau' } });
    return;
  }
  finishTurn(threadId, turnId, cwd, text, command);
}

function finishTurn(threadId: string, turnId: string, cwd: string, text: string, command: Record<string, unknown>) {
  item('item/completed', threadId, turnId, { ...command, status: 'completed', exitCode: 0, durationMs: 12, aggregatedOutput: '✔ 1 test' });
  writeFileSync(join(cwd, 'result.txt'), `fait: ${text.length}\n`);
  item('item/completed', threadId, turnId, { type: 'fileChange', id: 'f1', status: 'completed', changes: [{ path: join(cwd, 'result.txt'), kind: { type: 'add' }, diff: '+fait' }] });
  usage(threadId, turnId, 100);
  item('item/completed', threadId, turnId, { type: 'agentMessage', id: 'a1', text: `Rapport : result.txt écrit. ${text.includes('version 2') ? 'OBJECTIF_V2' : 'OBJECTIF_V1'}${text.includes('inspecte l’état réel') ? ' INSPECTION_DEMANDEE' : ''}` });
  usage(threadId, turnId, 50);
  notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', error: null, items: [] } });
  active = null;
}

const turnCwd = new Map<string, string>();
const slowChecks = new Map<string, number | string>();
/** `slow-observe`: the git commands right after the check never answer on their own. */
let heldGit = scenario === 'slow-initial-observe' && !existsSync('observing.txt') ? 3 : 0;

/** Runs git for real, like the sandboxed `command/exec`, but without any sandbox: tests only. */
function runGit(argv: string[], cwd: string, overrides: Record<string, string | null>) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) { if (value === null) delete env[key]; else env[key] = value; }
  const result = spawnSync(argv[0] ?? 'git', argv.slice(1), { cwd, env, encoding: 'utf8' });
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const input = createInterface({ input: process.stdin });
if (scenario === 'turn-late-close') input.on('close', delayClose);
input.on('line', line => {
  const message = JSON.parse(line) as { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown };
  if (message.method === undefined) {
    if (scenario === 'approval' && active && message.result && JSON.stringify(message.result).includes('decline')) {
      const cwd = turnCwd.get(active.threadId) ?? '.';
      finishTurn(active.threadId, active.turnId, cwd, 'après refus', { type: 'commandExecution', id: 'c1', command: 'curl https://example.com', cwd, status: 'declined' });
    }
    return;
  }
  const params = message.params ?? {};
  if (process.env.MINO_TEST_RPC_PROBE) appendFileSync(process.env.MINO_TEST_RPC_PROBE, message.method + '\n');
  if (closingCwd) writeFileSync(join(closingCwd, 'request-during-close.txt'), String(message.method));
  const reply = (result: unknown) => send({ id: message.id, result });
  switch (message.method) {
    case 'initialize': return reply({ userAgent: 'fake' });
    case 'initialized': return;
    case 'config/read': return reply({ config: { features: Object.fromEntries([...disabled].map(f => [f, false])), mcp_servers: {}, web_search: 'disabled' } });
    case 'account/read': return reply({ account: { type: 'chatgpt' } });
    case 'model/list': return reply({ data: MODELS, nextCursor: null });
    case 'thread/start': {
      const id = `thread-${threads.size + 1}`;
      threads.set(id, String(params.cwd));
      return reply(opened(id, params));
    }
    case 'thread/resume': {
      const id = String(params.threadId);
      threads.set(id, String(params.cwd));
      return reply(opened(id, params));
    }
    case 'turn/start': {
      const threadId = String(params.threadId);
      const turnId = `turn-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
      const cwd = String(params.cwd ?? threads.get(threadId));
      turnCwd.set(threadId, cwd);
      active = { threadId, turnId };
      if (scenario === 'turn-late-close') return;
      if (scenario === 'turn-silent' || scenario === 'turn-garbled') {
        writeFileSync(join(cwd, 'effect.txt'), 'the turn acted\n');
        tool(cwd, 'tool-after.txt');
        setTimeout(() => writeFileSync(join(cwd, 'alive-after.txt'), 'still running\n'), 1500);
        if (scenario === 'turn-garbled') reply({ turn: 42 });
        return;
      }
      reply({ turn: { id: turnId, status: 'inProgress', items: [] } });
      const text = JSON.stringify((params.input as unknown[])[0] ?? '');
      if (coordDir) {
        const prompt = String(((params.input as { text?: string }[])[0] ?? {}).text ?? '');
        appendFileSync(join(coordDir, 'turns.jsonl'), JSON.stringify({ threadId, schema: params.outputSchema !== undefined, at: Date.now(), prompt }) + '\n');
        if (params.outputSchema !== undefined) {
          const answer = leadAnswer(prompt);
          setTimeout(() => {
            notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', items: [] } });
            item('item/completed', threadId, turnId, { type: 'agentMessage', id: 'a1', text: answer });
            usage(threadId, turnId, 40);
            notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', error: null, items: [] } });
            active = null;
          }, 5);
          return;
        }
      }
      setTimeout(() => runTurn(threadId, turnId, cwd, text), 5);
      return;
    }
    case 'turn/interrupt': {
      reply({});
      if (scenario === 'deaf' || !active) return;
      notify('turn/completed', { threadId: active.threadId, turn: { id: active.turnId, status: 'interrupted', error: null, items: [] } });
      active = null;
      return;
    }
    case 'command/exec': {
      const argv = params.command as string[];
      const cwd = String(params.cwd);
      if (argv[0] === 'git' && heldGit > 0) {
        heldGit -= 1;
        if (message.id !== undefined) slowChecks.set(String(params.processId), message.id);
        writeFileSync('observing.txt', 'held\n');
        return;
      }
      if (argv[0] === 'git') return reply(runGit(argv, cwd, (params.env ?? {}) as Record<string, string | null>));
      if (argv[0] === 'make-report') {
        writeFileSync(join(cwd, 'report.txt'), 'written by the check\n');
        return reply({ exitCode: 0, stdout: 'report written', stderr: '' });
      }
      if (argv[0] === 'slow') {
        if (message.id !== undefined) slowChecks.set(String(params.processId), message.id);
        // Like Codex 0.167, the terminate below answers without ending the command's own processes.
        tool(cwd, 'late-check.txt');
        return;
      }
      if (argv[0] === 'hold') { tool(cwd, 'late-hold.txt'); return; }
      if (argv[0] === 'hold-pipe') {
        spawn('sh', ['-c', `sleep 1; touch '${join(cwd, 'late-hold.txt')}'`], { detached: true, stdio: ['ignore', process.stdout, process.stderr] }).unref();
        return;
      }
      if (scenario === 'slow-observe' && argv[0] === 'true') heldGit = 3;
      return reply({ exitCode: argv[0] === 'true' ? 0 : 1, stdout: `ran ${argv.join(' ')}`, stderr: '' });
    }
    case 'command/exec/terminate': {
      reply({});
      const pending = slowChecks.get(String(params.processId));
      if (scenario === 'deaf-check' || pending === undefined) return;
      slowChecks.delete(String(params.processId));
      return send({ id: pending, result: { exitCode: 143, stdout: '', stderr: 'terminated' } });
    }
    default: return send({ id: message.id, error: { code: -32601, message: 'unknown' } });
  }
});
