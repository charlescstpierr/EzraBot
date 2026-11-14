import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { AdmissionPolicy } from '../../src/admission-protocol.js';
import { loadMascots } from '../../src/domain.js';
import { createCodexEngine } from '../../src/engine.js';
import { createHttpServer } from '../../src/http.js';
import { openStore } from '../../src/store.js';
import { createActionDesk, type DeskEvent } from '../../src/tool-desk.js';
import { ToolsReplySchema, type PcView, type ToolProposalView, type ToolsReply, type ToolsReplyOf } from '../../src/tools-protocol.js';
import { createWorker } from '../../src/worker.js';
import { createFakeProvider, type FakeProvider } from './fake-composio.js';


const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const fixture = fileURLToPath(new URL('./fake-app-server.js', import.meta.url));
export const mascots = loadMascots(join(root, 'assets/mascots.json'));
const CSRF = 'c'.repeat(64);
export const rid = () => randomUUID();

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const address = probe.address();
  await new Promise<void>(r => probe.close(() => r()));
  return typeof address === 'object' && address ? address.port : 0;
}

type Options = { path?: string; scenario?: string; provider?: FakeProvider | null; policy?: AdmissionPolicy };

export async function start(options: Options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mino-tools-flow-'));
  const path = options.path ?? join(dir, 'mino.sqlite');
  const provider = options.provider === undefined ? createFakeProvider() : options.provider;
  const store = openStore({ path, mascots, serviceTools: provider !== null, ...(options.policy ? { policy: options.policy } : {}) });
  const engineOptions = { command: process.execPath, args: [fixture, options.scenario ?? 'tool-call'], workDir: dir, clientVersion: 'test', turnTimeoutMs: 5000, requestTimeoutMs: 2000, interruptGraceMs: 300 };
  const chat = createCodexEngine({ ...engineOptions, ...(provider ? { dynamicTools: true as const } : {}) });
  const doc = createCodexEngine({ ...engineOptions, args: [fixture, 'deliverable'] });
  const port = await freePort();
  const logs: DeskEvent[] = [];
  const desk = createActionDesk({ store, provider, port, wake: () => worker.kick(), log: entry => logs.push(entry), closeGraceMs: 50 });
  const worker = createWorker({ store, engines: { chat, doc }, tools: desk });
  const server: Server = createHttpServer({ store, worker, engine: chat, port, root, csrfToken: CSRF, actions: desk, longPollMs: 50 });
  await new Promise<void>(r => server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${port}`;
  const post = (route: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-mino-csrf': CSRF, ...headers }, body: JSON.stringify(body),
  });
  const view = async (): Promise<PcView> => (await (await fetch(`${base}/api/view`)).json()) as PcView;
  const read = (route: string) => fetch(`${base}/api/tools/${route}`, { headers: { 'x-mino-csrf': CSRF } });
  const until = async (check: (v: PcView) => boolean, what: string): Promise<PcView> => {
    for (let i = 0; i < 400; i += 1) {
      const current = await view();
      if (check(current)) return current;
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error(`condition never met: ${what}`);
  };
  const tools = async <K extends ToolsReply['kind']>(kind: K, response: Response): Promise<ToolsReplyOf<K>> => {
    const { ok, ...reply } = z.looseObject({ ok: z.boolean() }).parse(await response.json());
    assert.deepEqual([response.status, ok], [200, true], JSON.stringify(reply));
    const parsed = ToolsReplySchema.parse(reply);
    if (parsed.kind !== kind) throw new Error(`unexpected reply ${parsed.kind}`);
    return parsed as ToolsReplyOf<K>;
  };
  const command = (body: Record<string, unknown>) => post('/api/tools/commands', { requestId: rid(), ...body });
  const say = async (text: string, botId = 'nova') => {
    const response = await post('/api/commands', { type: 'message.send', requestId: rid(), botId, text, attachments: [] });
    assert.equal(response.status, 200);
  };
  /** Connects a synthetic account through the real routes and grants one action to a bot. */
  const connect = async (botId = 'nova', toolSlugs = ['GMAIL_SEND_EMAIL']) => {
    assert(provider);
    const link = await tools('link', await post('/api/tools/link', { serviceId: 'ac_synthetique_gmail', alias: 'Courriel de test' }));
    await tools('checked', await post(`/api/tools/links/${link.linkId}/check`, {}));
    const accountId = (await view()).tools.accounts.find(a => a.status === 'ACTIVE')?.id ?? '';
    const granted = await command({ type: 'tools.grant', botId, accountId, toolSlugs });
    assert.equal(granted.status, 200, await granted.clone().text());
    return accountId;
  };
  const proposal = async (text: string): Promise<ToolProposalView> => {
    const before = (await view()).tools.proposals.length;
    await say(text);
    const current = await until(v => v.tools.proposals.length > before, `a proposal for « ${text} »`);
    const found = current.tools.proposals.at(-1);
    assert(found);
    return found;
  };
  const approve = (target: ToolProposalView, requestId = rid()) => command({ type: 'tools.approve', requestId, proposalId: target.id, fingerprint: target.fingerprint });
  const stop = async () => {
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
    await Promise.all([worker.close(), desk.close()]);
    await Promise.all([chat.close(), doc.close()]);
    store.recoverInterrupted();
    store.close();
  };
  return { base, path, store, provider, desk, worker, logs, post, read, view, until, tools, command, say, connect, proposal, approve, stop };
}

export const find = (view: PcView, id: string) => {
  const found = view.tools.proposals.find(p => p.id === id);
  assert(found);
  return found;
};
