import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCodexEngine, type AgentText, type Engine, type ToolCall, type ToolReply, type TurnTools } from '../src/engine.js';
import { composeContext } from '../src/context.js';
import type { EngineOutcome } from '../src/domain.js';
import type { BotChoice } from '../src/protocol.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-app-server.js', import.meta.url));
const workDir = mkdtempSync(join(tmpdir(), 'mino-engine-'));
const { turn } = composeContext({
  bot: { name: 'Mino', title: 'test', instructions: '', replyStyle: 'concise', contextSize: 'short' },
  memories: [],
  exchanges: [],
  request: { text: 'Bonjour', attachments: [] },
});
const defaultChoice: BotChoice = { model: null, effort: null, speed: 'standard' };

function engineFor(scenario: string, overrides: { command?: string; turnTimeoutMs?: number; dynamicTools?: true } = {}): Engine {
  return createCodexEngine({
    ...(overrides.dynamicTools ? { dynamicTools: true as const } : {}),
    command: overrides.command ?? process.execPath,
    args: overrides.command ? [] : [fixture, scenario],
    workDir,
    clientVersion: 'test',
    turnTimeoutMs: overrides.turnTimeoutMs ?? 5000,
    requestTimeoutMs: 2000,
    interruptGraceMs: 500,
  });
}

async function runOnce(scenario: string, options: { choice?: BotChoice; signal?: AbortSignal; turnTimeoutMs?: number; command?: string } = {}): Promise<EngineOutcome> {
  const engine = engineFor(scenario, options);
  try {
    return await engine.run({ turn, choice: options.choice ?? defaultChoice, signal: options.signal ?? new AbortController().signal, onStage: () => {}, onThread: () => {}, onTurn: () => {} });
  } finally {
    await engine.close();
  }
}

function failureCode(outcome: EngineOutcome): string {
  assert.equal(outcome.kind, 'failed');
  return outcome.kind === 'failed' ? outcome.code : '';
}

test('a structured reply records the model actually used with its thread and turn', async () => {
  const outcome = await runOnce('deliverable');
  assert.equal(outcome.kind, 'succeeded');
  if (outcome.kind !== 'succeeded') return;
  assert.deepEqual(outcome.used, { model: 'fake-sol', effort: 'low', speed: 'standard' });
  assert.match(outcome.threadId, /^thread-/);
  assert.match(outcome.turnId, /^turn-/);
  assert.deepEqual(outcome.reply, { reply: 'Voici le texte.', deliverable: { title: 'Invitation', body: 'Viens samedi.' } });
});

test('the catalogue hides hidden models and keeps announced efforts and speeds', async () => {
  const engine = engineFor('reply');
  try {
    const status = await engine.catalog();
    assert.equal(status.state, 'ready');
    if (status.state !== 'ready') return;
    assert.deepEqual(status.models.map(m => m.id), ['fake-sol']);
    assert.deepEqual(status.models[0]?.efforts, ['low', 'high']);
    assert.deepEqual(status.models[0]?.speeds.map(s => s.id), ['priority']);
  } finally {
    await engine.close();
  }
});

test('an impossible model choice fails before any call instead of falling back', async () => {
  assert.equal(failureCode(await runOnce('reply', { choice: { model: 'other-model', effort: null, speed: 'standard' } })), 'choice_unavailable');
  assert.equal(failureCode(await runOnce('reply', { choice: { model: 'fake-sol', effort: 'ultra', speed: 'standard' } })), 'choice_unavailable');
  assert.equal(failureCode(await runOnce('reply', { choice: { model: 'fake-sol', effort: 'low', speed: 'turbo' } })), 'choice_unavailable');
});

test('protocol failures become explicit failures, never replies', async () => {
  assert.equal(failureCode(await runOnce('invalid-output')), 'invalid_output');
  assert.equal(failureCode(await runOnce('tool')), 'tool_blocked');
  assert.equal(failureCode(await runOnce('approval')), 'request_refused');
  assert.equal(failureCode(await runOnce('token-refresh')), 'request_refused');
  assert.equal(failureCode(await runOnce('turn-failed')), 'usage_limit');
  assert.equal(failureCode(await runOnce('exit-mid-turn')), 'engine_exited');
  assert.equal(failureCode(await runOnce('hang', { turnTimeoutMs: 200 })), 'timeout');
});

test('the failure text shown to the person carries no raw upstream message', async () => {
  const outcome = await runOnce('turn-failed');
  assert.equal(outcome.kind, 'failed');
  if (outcome.kind === 'failed') assert.doesNotMatch(outcome.message, /raw upstream/);
});

test('startup refuses an API-key account, unconfirmed tool settings and a missing binary', async () => {
  assert.equal(failureCode(await runOnce('api-key')), 'not_chatgpt');
  assert.equal(failureCode(await runOnce('unsafe-config')), 'unsafe_config');
  for (const scenario of ['unsafe-context', 'unsafe-skill-budget', 'unsafe-bundled-skills', 'unsafe-project-docs']) {
    assert.equal(failureCode(await runOnce(scenario)), 'unsafe_config', scenario);
  }
  assert.equal(failureCode(await runOnce('reply', { command: join(workDir, 'no-such-codex') })), 'codex_missing');
});

test('aborting a running turn interrupts it and reports a cancellation', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  const outcome = await runOnce('slow', { signal: controller.signal });
  assert.equal(outcome.kind, 'cancelled');
});

type Seen = { texts: AgentText[]; turns: string[]; threads: string[] };
async function observe(scenario: string): Promise<{ outcome: EngineOutcome; seen: Seen }> {
  const engine = engineFor(scenario);
  const seen: Seen = { texts: [], turns: [], threads: [] };
  try {
    const outcome = await engine.run({
      turn, choice: defaultChoice, signal: new AbortController().signal, onStage: () => {},
      onThread: id => seen.threads.push(id), onTurn: id => seen.turns.push(id), onText: text => seen.texts.push(text),
    });
    return { outcome, seen };
  } finally {
    await engine.close();
  }
}

test('agent text arrives in growing states bound to the call thread, turn and item, and the completed item replaces it exactly', async () => {
  const { outcome, seen } = await observe('stream');
  assert.equal(outcome.kind, 'succeeded');
  if (outcome.kind !== 'succeeded') return;
  assert(seen.texts.length > 3, 'several received states');
  for (const text of seen.texts) {
    assert.equal(text.threadId, outcome.threadId);
    assert.equal(text.turnId, outcome.turnId);
    assert.equal(text.itemId, 'm-stream');
    assert.doesNotMatch(text.text, /BRUIT/);
  }
  const last = seen.texts.at(-1);
  assert.equal(last?.final, true);
  assert.deepEqual(JSON.parse(last?.text ?? ''), outcome.reply);
  for (const [i, text] of seen.texts.entries()) assert(last?.text.startsWith(text.text), `state ${i} is a prefix of the final item`);
  assert.equal(seen.texts.filter(t => t.final).length, 1);
});

test('a completed item replaces a partial reconstruction instead of being appended to it', async () => {
  const { outcome, seen } = await observe('reply');
  assert.equal(outcome.kind, 'succeeded');
  assert.deepEqual(seen.texts.map(t => [t.text.length, t.final]), [[5, false], [JSON.stringify({ reply: 'Bonjour depuis le faux moteur.', deliverable: null }).length, true]]);
});

test('a completed item from another turn or without a turn cannot replace the requested answer or its progress', async () => {
  const { outcome, seen } = await observe('wrong-item-turn');
  assert.equal(outcome.kind, 'succeeded');
  if (outcome.kind !== 'succeeded') return;
  assert.equal(outcome.reply.reply, 'Bonjour depuis le faux moteur.');
  assert.equal(outcome.reply.deliverable, null);
  for (const text of seen.texts) {
    assert.equal(text.turnId, outcome.turnId);
    assert.doesNotMatch(text.text, /WRONG_TURN|OTHER_TURN|MISSING_TURN/);
  }
});

test('items received before turn acceptance wait for the matching accepted turn', async () => {
  const { outcome, seen } = await observe('early-item');
  assert.equal(outcome.kind, 'succeeded');
  if (outcome.kind !== 'succeeded') return;
  assert.equal(outcome.reply.reply, 'Bonjour depuis le faux moteur.');
  assert.equal(seen.texts.at(-1)?.turnId, outcome.turnId);
  assert.equal(seen.texts.at(-1)?.final, true);
});

test('a turn the App Server refuses never reports a turn id, so nothing is called transmitted', async () => {
  const { outcome, seen } = await observe('reject-turn');
  assert.equal(failureCode(outcome), 'rpc_refused');
  assert.equal(seen.threads.length, 1);
  assert.deepEqual(seen.turns, []);
  assert.deepEqual(seen.texts, []);
});

test('two engine instances run two turns at the same time, each on its own connection', async () => {
  const chat = engineFor('reply');
  const doc = engineFor('stream');
  try {
    const order: string[] = [];
    const run = (engine: Engine, name: string) => engine.run({ turn, choice: defaultChoice, signal: new AbortController().signal, onStage: () => {}, onThread: () => {}, onTurn: () => {} })
      .then(outcome => { order.push(name); return outcome; });
    const [a, b] = await Promise.all([run(doc, 'doc'), run(chat, 'chat')]);
    assert.equal(a.kind, 'succeeded');
    assert.equal(b.kind, 'succeeded');
    assert.deepEqual(order, ['chat', 'doc']);
  } finally {
    await Promise.all([chat.close(), doc.close()]);
  }
});

const SPEC = { name: 'GMAIL_SEND_EMAIL', description: 'Action synthétique de test.', inputSchema: { type: 'object', properties: {} } };
const MAIL = { to: 'personne@exemple.invalid', subject: 'Bonjour', body: 'Texte synthétique du faux moteur.' };

function gateway(answer: (call: ToolCall) => ToolReply | Promise<ToolReply> = () => ({ success: true, text: 'PROPOSITION-ENREGISTRÉE' })) {
  const events: string[] = [];
  const calls: ToolCall[] = [];
  const tools: TurnTools = {
    specs: [SPEC],
    async call(call) {
      events.push('call');
      calls.push(call);
      await new Promise(resolve => setTimeout(resolve, 15));
      return answer(call);
    },
  };
  return { events, calls, tools };
}

async function runWithTools(scenario: string, tools: TurnTools | undefined, events: string[] = [], dynamicTools = true): Promise<EngineOutcome> {
  const engine = engineFor(scenario, dynamicTools ? { dynamicTools: true } : {});
  try {
    return await engine.run({ turn, choice: defaultChoice, signal: new AbortController().signal, onStage: () => {}, onThread: () => {}, onTurn: () => events.push('turn'), ...(tools ? { tools } : {}) });
  } finally {
    await engine.close();
  }
}

const replyText = (outcome: EngineOutcome): string => {
  assert.equal(outcome.kind, 'succeeded', outcome.kind === 'failed' ? outcome.code : outcome.kind);
  return outcome.kind === 'succeeded' ? outcome.reply.reply : '';
};

test('a registered tool call is answered exactly once, with a string or a number request id, and the model gets that answer before it replies', async () => {
  for (const scenario of ['tool-call', 'tool-call-number-id']) {
    const { calls, tools } = gateway();
    assert.match(replyText(await runWithTools(scenario, tools)), /Réponse de l’outil \(true, 1 réponse\) : PROPOSITION-ENREGISTRÉE/, scenario);
    assert.deepEqual(calls, [{ callId: 'call-1', tool: 'GMAIL_SEND_EMAIL', arguments: MAIL }], scenario);
  }
});

test('service tools are directly visible in their owned namespace while the code execution host stays disabled', async () => {
  const { calls, tools } = gateway();
  assert.match(replyText(await runWithTools('tool-call-owned-namespace', tools)), /PROPOSITION-ENREGISTRÉE/);
  assert.equal(calls.length, 1);
});

test('a tool call that arrives before the turn is acknowledged waits for the turn identity, then is answered once', async () => {
  const { calls, events, tools } = gateway();
  assert.match(replyText(await runWithTools('tool-call-early', tools, events)), /\(true, 1 réponse\) : PROPOSITION-ENREGISTRÉE/);
  assert.deepEqual(events, ['turn', 'call']);
  assert.equal(calls.length, 1);
});

test('a tool call for another turn, another thread, a namespace or an unregistered tool is refused and stops the turn without reaching the gateway', async () => {
  for (const scenario of ['tool-call-wrong-turn', 'tool-call-wrong-thread', 'tool-call-namespace', 'tool-call-no-namespace', 'tool-call-unknown-tool']) {
    const { calls, tools } = gateway();
    assert.equal(failureCode(await runWithTools(scenario, tools)), 'request_refused', scenario);
    assert.equal(calls.length, 0, scenario);
  }
});

test('with tools registered, a native approval request is still refused and a foreign tool item still blocks the turn', async () => {
  const approval = gateway();
  assert.equal(failureCode(await runWithTools('tool-then-approval', approval.tools)), 'request_refused');
  assert.equal(approval.calls.length, 1);
  for (const scenario of ['tool-item-foreign', 'tool-item-foreign-namespace', 'tool-item-no-namespace']) {
    const foreign = gateway();
    assert.equal(failureCode(await runWithTools(scenario, foreign.tools)), 'tool_blocked');
    assert.equal(foreign.calls.length, 0);
  }
});

test('every call goes to the gateway, whose refusal or failure is returned to the model as a failed tool answer', async () => {
  const twice = gateway(call => call.callId === 'call-1' ? { success: true, text: 'PREMIÈRE' } : { success: false, text: 'UNE SEULE' });
  assert.match(replyText(await runWithTools('tool-call-twice', twice.tools)), /PREMIÈRE \| deuxième appel : false/);
  assert.deepEqual(twice.calls.map(call => call.callId), ['call-1', 'call-2']);
  const broken = gateway(() => { throw new Error('panne synthétique'); });
  assert.match(replyText(await runWithTools('tool-call', broken.tools)), /\(false, 1 réponse\) : Action refusée/);
});

test('an engine without the tool option keeps the experimental API off and refuses a run that offers tools before any thread starts', async () => {
  const probe = join(workDir, 'init-probe.json');
  process.env.MINO_TEST_INIT_PROBE = probe;
  try {
    assert.equal(replyText(await runWithTools('reply', undefined, [], false)), 'Bonjour depuis le faux moteur.');
    assert.deepEqual(JSON.parse(readFileSync(probe, 'utf8')), { experimentalApi: false });
    const { calls, tools } = gateway();
    assert.equal(failureCode(await runWithTools('tool-call', tools, [], false)), 'rpc_refused');
    assert.equal(calls.length, 0);
    assert.equal(replyText(await runWithTools('tool-call', undefined)), 'Bonjour depuis le faux moteur.', 'no tool offered, no tool registered');
    assert.deepEqual(JSON.parse(readFileSync(probe, 'utf8')), { experimentalApi: true }, 'only the instance created for tools announces the experimental API');
    assert.equal(failureCode(await runWithTools('reply', gateway().tools)), 'rpc_refused', 'the fake refuses tools in every scenario that does not expect them');
  } finally {
    delete process.env.MINO_TEST_INIT_PROBE;
  }
});
