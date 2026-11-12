import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCodexEngine } from '../dist/src/engine.js';
import { composeContext } from '../dist/src/context.js';

if (!process.argv.includes('--live')) {
  console.error('Ce test utilise un vrai tour Codex. Lancez-le avec --live pour tester un outil neutre, sans Composio ni action externe.');
  process.exit(2);
}

const name = 'EZRABOT_TRANSPORT_PROBE';
const seed = `probe_${randomUUID()}`;
const acknowledgement = `ACK_${randomUUID()}`;
const calls = [];
const workDir = mkdtempSync(join(tmpdir(), 'ezrabot-dynamic-probe-'));
const engine = createCodexEngine({ command: 'codex', workDir, clientVersion: 'dynamic-probe', dynamicTools: true, requestTimeoutMs: 15_000, turnTimeoutMs: 90_000, interruptGraceMs: 1_000 });
try {
  const { turn } = composeContext({
    bot: { name: 'Sonde', title: 'Vérification neutre du transport', instructions: '', replyStyle: 'concise', contextSize: 'short' },
    memories: [], exchanges: [],
    request: { text: `Vérification technique sans service externe. Appelle une seule fois ${name} avec seed=${seed}. Cet outil neutre renvoie un accusé synthétique sans exécuter d’action. Après l’appel, inclue l’accusé exact reçu dans reply et mets deliverable à null.`, attachments: [] },
    tools: { names: [name] },
  });
  const result = await engine.run({
    turn, choice: { model: null, effort: null, speed: 'standard' }, signal: new AbortController().signal,
    onStage: () => {}, onThread: () => {}, onTurn: () => {},
    tools: {
      specs: [{ name, description: 'Sonde locale sans Composio ni effet externe. Retourne seulement un accusé synthétique.', inputSchema: { type: 'object', properties: { seed: { type: 'string', enum: [seed] } }, required: ['seed'], additionalProperties: false } }],
      call: async call => {
        calls.push(call);
        return { success: true, text: `Accusé de transport : ${acknowledgement}. Aucun service externe ni compte n’a été appelé. Termine ton JSON avec cet accusé dans reply et deliverable:null.` };
      },
    },
  });
  const matched = calls.length === 1 && calls[0].tool === name && calls[0].arguments?.seed === seed;
  const verified = result.kind === 'succeeded' && matched && result.reply.reply.includes(acknowledgement) && result.reply.deliverable === null;
  console.log(JSON.stringify({ verified, outcome: result.kind, calls: calls.length, argumentsMatch: matched, acknowledgementMatch: verified, model: result.kind === 'succeeded' ? result.used.model : null, code: result.kind === 'failed' ? result.code : null, composioCalled: false }));
  if (!verified) process.exitCode = 1;
} finally {
  try {
    await engine.close();
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
