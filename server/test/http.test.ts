import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadMascots, type EngineOutcome, type UsageObservation } from '../src/domain.js';
import type { Engine, RunInput } from '../src/engine.js';
import { createHttpServer } from '../src/http.js';
import { DiagnosticsSchema, CommandResultSchema, type CommandResult, type AppView, type EngineStatus } from '../src/protocol.js';
import { openStore } from '../src/store.js';
import { createWorker } from '../src/worker.js';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const READY: EngineStatus = {
  state: 'ready',
  account: 'chatgpt',
  models: [{ id: 'fake', displayName: 'Fake', isDefault: true, efforts: ['low', 'high'], defaultEffort: 'low', speeds: [{ id: 'priority', name: 'Fast', description: '' }] }],
};

const HTML_PAGE = '<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>button{color:blue}</style></head><body><button onclick="this.textContent=1">0</button></body></html>';

function fakeEngine(): Engine & { aborted: string[]; emitUsage(observation: UsageObservation): void } {
  const aborted: string[] = [];
  const usage = new Set<(observation: UsageObservation) => void>();
  return {
    aborted,
    emitUsage(observation) { for (const listener of usage) listener(observation); },
    status: () => READY,
    catalog: async () => READY,
    close: async () => {},
    onUsage: listener => {
      usage.add(listener);
      return () => usage.delete(listener);
    },
    run: ({ turn, signal, onStage, onThread, onTurn }: RunInput) => new Promise<EngineOutcome>(done => {
      onThread('t1');
      onTurn('u1');
      onStage('writing');
      const request = turn.input.split('\n').at(-1) ?? '';
      if (request.includes('creation-html') || request.includes('legacy-html')) {
        const legacy = request.includes('legacy-html');
        done({ kind:'succeeded', reply:{reply:legacy ? 'Voici.\n```html\n'+HTML_PAGE+'\n```' : 'Voici ta page.',deliverable:legacy?null:{title:'Ma page',body:HTML_PAGE}}, used:{model:'fake',effort:'low',speed:'standard'},threadId:'html-thread',turnId:'html-turn' });
        return;
      }
      if (!request.includes('lent')) {
        done({ kind: 'succeeded', reply: { reply: 'Voici.', deliverable: { title: 'Titre', body: 'Corps' } }, used: { model: 'fake', effort: 'low', speed: 'standard' }, threadId: 't1', turnId: 'u1' });
        return;
      }
      signal.addEventListener('abort', () => {
        aborted.push(request);
        setTimeout(() => done({ kind: 'succeeded', reply: { reply: 'Réponse tardive', deliverable: null }, used: { model: 'fake', effort: 'low', speed: 'standard' }, threadId: 't2', turnId: 'u2' }), request.includes('très') ? 300 : 20);
      });
    }),
  };
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const address = probe.address();
  await new Promise<void>(r => probe.close(() => r()));
  return typeof address === 'object' && address ? address.port : 0;
}

async function start(longPollMs = 50) {
  const port = await freePort();
  const store = openStore({ path: join(mkdtempSync(join(tmpdir(), 'mino-http-')), 'mino.sqlite'), mascots: loadMascots(join(root, 'assets/mascots.json')) });
  const engine = fakeEngine();
  const worker = createWorker({ store, engines: { chat: engine, doc: engine } });
  const loggedTypes: string[] = [];
  const server: Server = createHttpServer({ store, worker, engine, port, root, csrfToken: 'a'.repeat(64), longPollMs, log: entry => loggedTypes.push(entry.type) });
  await new Promise<void>(r => server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${port}`;
  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, 'x-mino-csrf': 'a'.repeat(64), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const view = async (): Promise<AppView> => (await (await fetch(`${base}/api/view`)).json()) as AppView;
  const until = async (check: (v: AppView) => boolean): Promise<AppView> => {
    for (let i = 0; i < 200; i += 1) {
      const current = await view();
      if (check(current)) return current;
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error('condition never met');
  };
  const stop = async () => {
    await worker.close();
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
    store.close();
  };
  return { base, post, view, until, stop, engine, loggedTypes };
}

test('the first snapshot does not wait for a change on an empty thread', async () => {
  const app = await start(60_000);
  try {
    const response = await fetch(app.base + '/api/view', { signal: AbortSignal.timeout(1500) });
    assert.equal(response.status, 200);
    const view = await response.json() as AppView;
    assert.equal(view.messages.length, 0);
  } finally {
    await app.stop();
  }
});

test('an invalid command cannot copy arbitrary client text into the log', async () => {
  const app = await start();
  try {
    assert.equal((await app.post({ type: 'PRIVATE_LOG_CANARY', requestId: 'req-unknown-type' })).status, 422);
    assert.deepEqual(app.loggedTypes, ['unknown']);
  } finally {
    await app.stop();
  }
});

test('a storage failure stops the worker and reports a fatal failure', async () => {
  const store = openStore({ path: join(mkdtempSync(join(tmpdir(), 'mino-worker-')), 'mino.sqlite'), mascots: loadMascots(join(root, 'assets/mascots.json')) });
  store.close();
  let fatal = 0;
  const events: string[] = [];
  const worker = createWorker({ store, engines: (e => ({ chat: e, doc: e }))(fakeEngine()), log: entry => events.push(entry.event), onFatal: () => { fatal += 1; } });
  worker.kick();
  await worker.idle();
  worker.kick();
  await worker.idle();
  assert.equal(fatal, 1);
  assert.deepEqual(events, ['worker.error']);
  await worker.close();
});

test('a message sent over HTTP is answered by the worker and shown as a reviewable result', async () => {
  const app = await start();
  try {
    const response = await app.post({ type: 'message.send', requestId: 'req-00000001', botId: 'mino', text: 'Rédige un titre', attachments: [] });
    assert.equal(response.status, 200);
    const done = await app.until(v => v.works[0]?.state === 'review');
    const answer = done.messages.find(m => m.role === 'assistant');
    assert.equal(answer?.text, 'Voici.');
    assert.deepEqual(answer?.stamp, { model: 'fake', effort: 'low', speed: 'standard', threadId: 't1', turnId: 'u1' });
  } finally {
    await app.stop();
  }
});

test('cancelling a running call aborts it and its late reply is discarded', async () => {
  const app = await start();
  try {
    await app.post({ type: 'message.send', requestId: 'req-00000002', botId: 'mino', text: 'Réponds lentement', attachments: [] });
    const running = await app.until(v => v.works[0]?.state === 'running');
    const workId = running.works[0]?.id ?? '';
    assert.equal((await app.post({ type: 'work.cancel', requestId: 'req-00000003', workId })).status, 200);
    await new Promise(r => setTimeout(r, 80));
    const after = await app.view();
    assert.deepEqual(app.engine.aborted, ['Réponds lentement']);
    assert.equal(after.works[0]?.state, 'cancelled');
    assert.equal(after.messages.filter(m => m.role === 'assistant').length, 0);
  } finally {
    await app.stop();
  }
});

test('a model setting must exist in the announced catalogue to be saved', async () => {
  const app = await start();
  try {
    const impossible = await app.post({ type: 'bot.configure', requestId: 'req-00000004', botId: 'nova', model: 'fake', effort: 'ultra', speed: 'standard' });
    assert.equal(impossible.status, 422);
    const saved = await app.post({ type: 'bot.configure', requestId: 'req-00000005', botId: 'nova', model: 'fake', effort: 'high', speed: 'priority' });
    assert.equal(saved.status, 200);
    const nova = (await app.view()).bots.find(b => b.id === 'nova');
    assert.deepEqual(nova?.choice, { model: 'fake', effort: 'high', speed: 'priority' });
  } finally {
    await app.stop();
  }
});

test('writes need the local origin and session token, and only allowlisted files are served', async () => {
  const app = await start();
  try {
    const command = { type: 'bot.select', requestId: 'req-00000006', botId: 'pixel' };
    assert.equal((await app.post(command, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await app.post(command, { 'x-mino-csrf': 'b'.repeat(64) })).status, 403);
    assert.equal((await app.post('x'.repeat(12 * 1024 * 1024 + 1))).status, 413);
    assert.equal((await app.view()).activeBotId, 'mino');
    assert.equal((await app.post(command)).status, 200);
    assert.equal((await app.view()).activeBotId, 'pixel');
    for (const path of ['/src/store.ts', '/data/mino.sqlite', '/package.json', '/web/app.ts', '/dist/src/main.js']) {
      assert.equal((await fetch(app.base + path)).status, 404, path);
    }
    assert.equal((await fetch(app.base + '/assets/prototype.css')).status, 200);
    const page = await (await fetch(app.base + '/')).text();
    assert.match(page, /name="mino-csrf" content="a{64}"/);
  } finally {
    await app.stop();
  }
});

test('deleting a bot is refused while its call is still stopping, even once the work shows cancelled, then succeeds', async () => {
  const app = await start();
  try {
    await app.post({ type: 'message.send', requestId: 'req-00000010', botId: 'nova', text: 'Réponds très lentement', attachments: [] });
    const running = await app.until(v => v.works[0]?.state === 'running');
    assert.equal((await app.post({ type: 'work.cancel', requestId: 'req-00000011', workId: running.works[0]?.id ?? '' })).status, 200);
    const stopping = await app.view();
    assert.equal(stopping.works[0]?.state, 'cancelled');
    const nova = stopping.bots.find(b => b.id === 'nova');
    const command = { type: 'bot.delete', requestId: 'req-00000012', botId: 'nova', confirmName: 'Nova', expected: nova?.deletion };
    const refused = await app.post(command);
    assert.equal(refused.status, 409);
    assert.equal(((await refused.json()) as { code: string }).code, 'busy');
    await new Promise(r => setTimeout(r, 400));
    assert.deepEqual(app.engine.aborted, ['Réponds très lentement']);
    const accepted = await app.post(command);
    assert.equal(accepted.status, 200);
    const body = await accepted.json() as { result: unknown; view: AppView };
    assert.deepEqual(body.result, { kind: 'botDeleted', botId: 'nova', nextBotId: 'mino', erased: true });
    assert.deepEqual(body.view.bots.map(b => b.id), ['mino', 'pixel', 'atlas']);
    assert.deepEqual(body.view.purged.botIds, ['nova']);
    assert.equal(body.view.messages.length, 0);
  } finally {
    await app.stop();
  }
});


const previewFetch = (url: string) => fetch(url, {headers:{'sec-fetch-dest':'iframe'}});

async function acceptedResult(response: Response): Promise<CommandResult> {
  const value: unknown = await response.json();
  assert(typeof value === 'object' && value !== null && 'ok' in value && value.ok === true && 'result' in value);
  return CommandResultSchema.parse(value.result);
}

test('HTML versions preview in a sandbox, download as HTML and keep approval, restoration and frozen publication behavior', async () => {
  const app = await start();
  try {
    assert.equal((await app.post({type:'message.send',requestId:'html-test-1',botId:'mino',text:'creation-html',attachments:[]})).status,200);
    const view = await app.until(v=>v.works[0]?.state==='review');
    const work = view.works[0];assert(work);
    const v1 = work.versions[0];assert(v1);
    const preview = await previewFetch(`${app.base}/api/versions/${v1.id}/preview`);
    assert.equal(preview.status,200);assert.equal(await preview.text(),HTML_PAGE);
    assert.equal((await fetch(`${app.base}/api/versions/${v1.id}/preview`)).status,403);
    assert.equal((await fetch(`${app.base}/api/versions/${v1.id}/preview`,{headers:{'sec-fetch-dest':'document'}})).status,403);
    const policy = preview.headers.get('content-security-policy') ?? '';
    for(const directive of ["sandbox allow-scripts", "connect-src 'none'", "form-action 'none'", "frame-src 'none'", "frame-ancestors 'self'"])assert(policy.includes(directive));
    assert(!policy.includes('allow-same-origin'));
    const download = await fetch(`${app.base}/api/versions/${v1.id}/download`);
    assert.match(download.headers.get('content-type')??'',/^text\/html/);
    assert.match(download.headers.get('content-disposition')??'',/\.html/);
    assert.equal(await download.text(),HTML_PAGE);
    const proposed = await acceptedResult(await app.post({type:'publication.propose',requestId:'html-test-p1',workId:work.id,versionId:v1.id,destination:'carnet'}));assert(proposed.kind==='proposal');
    assert((await acceptedResult(await app.post({type:'version.edit',requestId:'html-test-e1',workId:work.id,baseVersionId:v1.id,title:'Modifiée',body:HTML_PAGE.replace('>0<','>7<')}))).kind==='version');
    assert.equal((await app.post({type:'publication.approve',requestId:'html-test-a1',proposalId:proposed.proposalId,action:'publish',destination:'carnet',versionId:v1.id,payloadSha256:proposed.payloadSha256})).status,409);
    const restored = await acceptedResult(await app.post({type:'version.restore',requestId:'html-test-r1',workId:work.id,versionId:v1.id}));assert(restored.kind==='version');
    const versionId = restored.versionId;
    assert.equal(await(await previewFetch(`${app.base}/api/versions/${versionId}/preview`)).text(),HTML_PAGE);
    const prop = await acceptedResult(await app.post({type:'publication.propose',requestId:'html-test-p2',workId:work.id,versionId,destination:'carnet'}));assert(prop.kind==='proposal');
    const approved = await acceptedResult(await app.post({type:'publication.approve',requestId:'html-test-a2',proposalId:prop.proposalId,action:'publish',destination:'carnet',versionId,payloadSha256:prop.payloadSha256}));assert(approved.kind==='decision');
    assert((await acceptedResult(await app.post({type:'version.edit',requestId:'html-test-e2',workId:work.id,baseVersionId:versionId,title:'Encore',body:HTML_PAGE.replace('>0<','>9<')}))).kind==='version');
    assert.equal(await(await previewFetch(`${app.base}/api/publications/${approved.publicationId}/preview`)).text(),HTML_PAGE);
    assert.equal(await(await fetch(`${app.base}/api/publications/${approved.publicationId}/download`)).text(),HTML_PAGE);
    const normal = await fetch(`${app.base}/`);
    assert.match(normal.headers.get('content-security-policy')??'',/frame-src 'self'/);
    assert.match(normal.headers.get('content-security-policy') ?? '', /font-src 'self' data:/);
    assert(!((normal.headers.get('content-security-policy')??'').includes("script-src 'unsafe-inline'")));
  } finally {await app.stop();}
});

test('an old assistant HTML code block has a preview and a download; user messages and missing or plain documents do not execute', async () => {
  const app = await start();
  try {
    assert.equal((await app.post({type:'message.send',requestId:'legacy-html-1',botId:'mino',text:'legacy-html',attachments:[]})).status,200);
    const view = await app.until(v=>v.works[0]?.state==='done');
    const answer = view.messages.find(m=>m.role==='assistant');const request = view.messages.find(m=>m.role==='user');assert(answer&&request);
    assert.equal(await(await previewFetch(`${app.base}/api/messages/${answer.id}/preview`)).text(),HTML_PAGE);
    assert.equal(await(await fetch(`${app.base}/api/messages/${answer.id}/download`)).text(),HTML_PAGE);
    assert.equal((await previewFetch(`${app.base}/api/messages/${request.id}/preview`)).status,404);
    assert.equal((await previewFetch(`${app.base}/api/versions/missing/preview`)).status,404);
  } finally {await app.stop();}
});


test('diagnostics expose only allowlisted metadata and keep late usage on the completed attempt', async () => {
  const app = await start();
  try {
    await acceptedResult(await app.post({type:'bot.update',requestId:'diag-profile',botId:'mino',name:'SECRET_PROFILE',instructions:'SECRET_INSTRUCTIONS'}));
    await acceptedResult(await app.post({type:'memory.create',requestId:'diag-memory',botId:'mino',text:'SECRET_MEMORY'}));
    await acceptedResult(await app.post({type:'message.send',requestId:'diag-message',botId:'mino',text:'SECRET_PROMPT',attachments:[{name:'SECRET_FILE',text:'SECRET_FILE_CONTENT'}]}));
    const completed = await app.until(v=>v.works[0]?.state==='review');const work=completed.works[0];assert(work);
    const version=work.versions[0];assert(version);
    await acceptedResult(await app.post({type:'version.edit',requestId:'diag-version',workId:work.id,baseVersionId:version.id,title:'SECRET_TITLE',body:'SECRET_BODY'}));
    const before=DiagnosticsSchema.parse(await(await fetch(app.base+'/api/diagnostics')).json());
    assert.equal(before.schemaVersion,1);assert.equal(before.spaceId,completed.spaceId);assert.equal(before.works[0]?.requestMessageId,work.requestMessageId);assert.equal(before.works[0]?.actorBotId,'mino');assert.equal(before.works[0]?.threadBotId,'mino');
    const attempt=before.attempts[0];assert(attempt);assert.equal(attempt.state,'succeeded');assert.equal(attempt.threadId,'t1');assert.equal(attempt.turnId,'u1');assert.equal(attempt.requested.model,null);assert.equal(attempt.used?.model,'fake');assert(attempt.plan?.memory.chars);
    assert(!JSON.stringify(before).includes('SECRET_'));
    const counts={input:3,cachedInput:0,cacheWriteInput:0,output:2,reasoningOutput:0,total:5};
    const waiting=fetch(app.base+'/api/diagnostics?after='+before.rev);
    app.engine.emitUsage({threadId:'t1',turnId:'u1',usage:{last:counts,total:counts,modelContextWindow:null}});
    const after=DiagnosticsSchema.parse(await(await waiting).json());assert(after.rev>before.rev);
    assert.equal(after.attempts[0]?.id,attempt.id);assert.equal(after.attempts[0]?.state,'succeeded');assert.deepEqual(after.attempts[0]?.usage?.last,counts);
    assert(!JSON.stringify(after).includes('SECRET_'));
  } finally {await app.stop();}
});

test('image retrieval requires the session, keeps bytes private, and rejects large command bodies', async () => {
  const app = await start();
  try {
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMioAAAAASUVORK5CYII=';
    assert.equal((await app.post({type:'message.send',requestId:'image-http-11',botId:'pixel',text:'',attachments:[{kind:'image',name:'test.png',mimeType:'image/png',base64}]})).status,200);
    const view = await app.view();
    const file = view.messages.find(m=>m.role==='user')?.attachments[0]; assert(file);
    const url = `${app.base}/api/attachments/${file.id}`;
    assert.equal((await fetch(url)).status,403);
    assert.equal((await fetch(url,{headers:{cookie:`mino-images=${'a'.repeat(64)}`}})).status,403);
    const home = await fetch(app.base);
    const cookie = home.headers.get('set-cookie')!;
    assert(!cookie.includes('a'.repeat(64)));
    assert(cookie.includes('HttpOnly')); assert(cookie.includes('SameSite=Strict'));
    assert.equal((await fetch(url,{headers:{cookie, origin:'http://evil.example'}})).status,403);
    const response = await fetch(url,{headers:{cookie}});
    assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');
    assert.equal(response.headers.get('cache-control'),'private, no-store');
    assert.equal(Buffer.from(await response.arrayBuffer()).toString('base64'),base64);
    assert(!JSON.stringify(view).includes(base64));
  } finally {await app.stop();}
});

test('creation validates an explicit model but legacy creation works offline', async () => {
  const app = await start();
  const command = { type: 'bot.create', requestId: 'create-model-001', name: 'Modèle choisi', title: '', shape: 'sprout', color: '#8de343', model: 'fake' };
  try {
    const before = (await app.view()).bots.length;
    const saved = await app.post(command);
    assert.equal(saved.status, 200);
    assert.equal((await app.post(command)).status, 200);
    assert.equal((await app.view()).bots.length, before + 1);
    assert.deepEqual((await app.view()).bots.find(b => b.name === command.name)?.choice, { model: 'fake', effort: null, speed: 'standard' });
    assert.equal((await app.post({ ...command, requestId: 'create-model-002', model: 'absent' })).status, 422);
    app.engine.catalog = async () => ({ state: 'unavailable', message: 'Offline' });
    assert.equal((await app.post({ ...command, requestId: 'create-model-003' })).status, 422);
    assert.equal((await app.view()).bots.length, before + 1);
    const { model, ...legacy } = command;
    assert.equal((await app.post({ ...legacy, requestId: 'create-model-004' })).status, 200);
    assert.equal((await app.post({ ...legacy, model: null, requestId: 'create-model-005' })).status, 200);
  } finally { await app.stop(); }
});
