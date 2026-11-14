import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import jsQR from 'jsqr';
import { browser, until, delay } from './lib/browser.mjs';
import { buildFingerprint } from './lib/build-fingerprint.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const { Resvg } = createRequire(new URL('../mobile/package.json', import.meta.url))('@resvg/resvg-js');
const certPath = process.env.MINO_VERIFY_CERT;
const keyPath = process.env.MINO_VERIFY_KEY;
const hostname = process.env.MINO_VERIFY_HOST;
assert(certPath && keyPath && hostname, 'Trusted certificate, key path and hostname required.');
const dir = mkdtempSync(join(tmpdir(), 'mino-safari-ui-'));
const port = Number(process.env.MINO_VERIFY_TLS_PORT ?? 4395);
const adminPort = Number(process.env.MINO_VERIFY_ADMIN_PORT ?? 4394);
const fixtureProject = process.env.MINO_VERIFY_AGENT_BUILD ? mkdtempSync(join(tmpdir(),'mino-fusion-project-')) : null;
const base = `https://${hostname}:${port}`;
const adminBase = `http://127.0.0.1:${adminPort}`;
const evidenceDir = resolve(process.env.MINO_VERIFY_EVIDENCE_DIR ?? join(root, 'docs/evidence'));
const threadMode = process.env.MINO_VERIFY_THREADS;
const clientDir = process.env.MINO_VERIFY_CLIENT_DIR ?? join(root, 'mobile/dist');
const threadShots = resolve(process.env.MINO_VERIFY_SHOTS_DIR ?? join(root, 'docs/mobile/fusion'));
const agentBuild = process.env.MINO_VERIFY_AGENT_BUILD;
const [{openStore},{openDevices},{createBrowserAdmission},{createHttpServer},{createDeviceServer},{createWorker},{loadMascots}] = await Promise.all(['store.js', 'devices.js', 'web-admission.js', 'http.js', 'device-http.js', 'worker.js', 'domain.js'].map(file=>import(join(agentBuild ?? root,'dist/src',file))));
const agentModules = agentBuild ? await Promise.all(['missions.js','agent-engine.js','agent-worker.js','agent-http.js','http.js','device-http.js'].map(file => import(join(agentBuild, 'dist/src', file)))) : null;
const evidence = { startedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), uncommittedBuild: true, build: buildFingerprint(root), clientSha256: createHash('sha256').update(readFileSync(join(clientDir, 'index.html'))).digest('hex'), model: 'controlled fixture, no model call', physicalSafariTested: false, hostResolution: 'Chrome process only: configured hostname maps to loopback', checks: [] };
evidence.serverSourceReference = agentBuild ?? 'c3c8e80, frozen dist; concurrent backend source excluded from this frontend verification';
if (agentBuild) evidence.isolatedBackend = Object.fromEntries(readdirSync(join(agentBuild,'dist/src')).filter(f=>f.endsWith('.js')).map(f=>['dist/src/'+f,createHash('sha256').update(readFileSync(join(agentBuild,'dist/src',f))).digest('hex')]));
evidence.sources = Object.fromEntries(['mobile/App.tsx','mobile/src/controller.ts','mobile/src/network.ts','mobile/src/platform.ts','mobile/src/browser.ts','mobile/src/chat.tsx','mobile/src/chat-viewport.ts','mobile/src/ChatMarkdown.tsx','mobile/src/chat-markdown.ts','web/device-admin.ts','web/devices.html','dist/web/device-admin.js'].map(file => [file, createHash('sha256').update(readFileSync(join(root, file))).digest('hex')]));
if (threadMode && threadMode !== 'before') for (const file of ['mobile/src/ThreadList.tsx','mobile/src/threads.ts','mobile/src/missions/Missions.tsx','mobile/src/missions/client.ts','mobile/src/generated/agent-protocol.ts']) evidence.sources[file] = createHash('sha256').update(readFileSync(join(root,file))).digest('hex');
const webBundle = /src="(\/_expo\/static\/js\/web\/[^"/]+\.js)"/.exec(readFileSync(join(clientDir, 'index.html'), 'utf8'))?.[1];
assert(webBundle);
evidence.clientBundleSha256 = createHash('sha256').update(readFileSync(join(clientDir, webBundle))).digest('hex');
let app;
let ui;
let pc;
let calls = 0;
let bootstrapFailures = 1;
let replyMode = 'plain';
function engine() {
  const status = { state: 'ready', account: 'chatgpt', models: [{ id: 'controlled-safari', displayName: 'Vérification contrôlée', isDefault: true, efforts: ['low'], defaultEffort: 'low', speeds: [] }] };
  return { status: () => status, catalog: async () => status, close: async () => {}, onUsage: () => () => {}, run: async (input) => {
    calls++;
    const threadId = randomUUID(), turnId = randomUUID();
    input.onThread(threadId); input.onTurn(turnId); input.onStage('writing');
    const departure = input.depart(); if (!departure.ok) return { kind: 'failed', code: 'admission_refused', message: departure.reason };
    if (replyMode === 'hold') {
      await new Promise(resolve => input.signal.aborted ? resolve() : input.signal.addEventListener('abort', resolve, { once: true }));
      return { kind: 'cancelled' };
    }
    await delay(180);
    return { kind: 'succeeded', reply: { reply: replyMode === 'rich' ? '**Un week-end sans courir.**\n\nVoici trois idées faciles à adapter.\n\n- Un café tranquille samedi matin.\n- Une promenade au bord de l’eau.\n- Un repas maison avec des amis.\n\n### Mon conseil\nGarde un seul rendez-vous prévu par jour. Le reste peut rester libre.\n\n```typescript\nconst programme = ["café", "promenade"];\n```\n\n| Moment | Idée |\n| --- | --- |\n| Matin | Café |\n| Après-midi | Promenade |' : 'Réponse synthétique pour vérifier Safari.', deliverable: null }, used: { model: 'controlled-safari', effort: 'low', speed: 'standard' }, threadId, turnId };
  } };
}
async function start() {
  const store = openStore({ path: join(dir, 'mino.sqlite'), mascots: loadMascots(join(root, 'assets/mascots.json')) });
  const devices = openDevices({ path: join(dir, 'devices.sqlite'), spaceId: store.view().spaceId, publicUrl: base });
  const admission = createBrowserAdmission(devices);
  const chat = engine();
  const worker = createWorker({ store, engines: { chat, doc: engine() } });
  let agents, missions, agentEngine, agentWorker;
  if (agentModules) {
    missions = agentModules[0].openMissions({path:join(dir,'missions.sqlite'),minoRoot:root,dataDir:dir});
    agentEngine = agentModules[1].createAgentEngine({command:process.execPath,args:[join(agentBuild,'dist/test/fixtures/fake-agent-server.js'),'edit'],tmpDir:join(dir,'agent-tmp'),clientVersion:'verify-fusion'});
    agentWorker = agentModules[2].createAgentWorker({missions,engine:agentEngine});
    agents = agentModules[3].createAgentRoutes({missions,worker:agentWorker,engine:agentEngine,longPollMs:500});
  }
  const httpServer = agentModules?.[4].createHttpServer ?? createHttpServer;
  const deviceServer = agentModules?.[5].createDeviceServer ?? createDeviceServer;
  const csrf = randomBytes(32).toString('hex');
  const local = httpServer({ agents, store, devices, browserAdmission: admission, worker, engine: chat, root, port: adminPort, csrfToken: csrf });
  const tls = deviceServer({ agents, store, devices, browserAdmission: admission, worker, engine: chat, publicUrl: base, cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8'), browserClientDir: clientDir, longPollMs: 500 });
  const handler = tls.listeners('request')[0]; assert(handler);
  tls.removeAllListeners('request');
  tls.on('request', (req, res) => {
    if (bootstrapFailures && req.url === '/m/browser/session') {
      bootstrapFailures--;
      res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ code: 'controlled_bootstrap_failure', message: 'Erreur initiale contrôlée de vérification.' }));
      return;
    }
    handler.call(tls, req, res);
  });
  for (const [server, listenPort] of [[local, adminPort], [tls, port]]) await new Promise((resolve, reject) => { server.once('error', reject); server.listen(listenPort, '127.0.0.1', resolve); });
  return { store, devices, admission, missions, agentEngine, async admin(path, body) { const res = await fetch(adminBase + path, { method: 'POST', headers: { origin: adminBase, 'content-type': 'application/json', 'x-mino-csrf': csrf }, body: JSON.stringify(body) }); const value = await res.json(); assert.equal(res.status, 200, value.message); return value; }, async close() {
    for (const server of [tls, local]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (agentWorker) await agentWorker.close();
    if (agentEngine) await agentEngine.close();
    if (missions) missions.close();
    await worker.close(); store.close(); devices.close();
  } };
}
async function settledClick(expression, target = ui) {
  await target.evaluate("Promise.all(document.getAnimations().filter(a=>a.playState==='running'&&a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))");
  await target.click(expression);
}
async function clickText(text, target = ui) {
  return settledClick(`(()=>{const visible=[...document.querySelectorAll('button,[role="button"]')].filter(e=>e.getClientRects().length&&!e.closest('[aria-hidden="true"]'));return visible.find(e=>e.textContent.trim()===${JSON.stringify(text)})??visible.find(e=>e.getAttribute('aria-label')===${JSON.stringify(text)})})()`, target);
}
async function textIncludes(text, target = ui) { return target.evaluate(`(document.body?.innerText ?? '').includes(${JSON.stringify(text)})`); }
const check = text => evidence.checks.push({ text, passed: true });
async function verifyThreads() {
  mkdirSync(threadShots, {recursive:true});
  let missionId;
  if (agentModules && threadMode !== 'before') {
    const project = fixtureProject;
    assert(project);
    if (!existsSync(join(project,'.git'))) {
      writeFileSync(join(project,'README.md'),'Café Boréal, données de test.\n');
      execFileSync('git',['init','-q'],{cwd:project});
      execFileSync('git',['config','core.fsmonitor','false'],{cwd:project});
      execFileSync('git',['add','.'],{cwd:project});
      execFileSync('git',['-c','user.name=Test','-c','user.email=test@mino.local','commit','-qm','initial'],{cwd:project});
    }
    const added = await app.admin('/api/agents/commands',{type:'project.add',requestId:randomUUID(),path:project,name:'Café Boréal',checkCommand:'true'});assert(added.ok);
    const created = await app.admin('/api/agents/commands',{type:'mission.create',requestId:randomUUID(),projectId:added.id,goal:'Préparer la page de préouverture du café',model:null,effort:null});assert(created.ok);missionId=created.id;
    await until(() => app.missions.view().missions.find(m=>m.id===missionId)?.status,s=>s==='review','real SQLite mission with controlled executor');
  }
  await settledClick("document.querySelector('[aria-label=\"Conversations\"]')");
  await until(() => textIncludes(threadMode === 'before' ? 'Vos bots' : 'Vos fils'), Boolean, 'thread list');
  if (threadMode === 'before') {
    await delay(500); await ui.screenshot(join(threadShots,'before-threads-390.png')); await clickText('Fermer'); return;
  }
  await until(() => textIncludes('Votre fil principal'), Boolean, 'main conversation section');
  if (agentModules) await until(() => textIncludes('Préparer la page de préouverture du café'), Boolean, 'project mission row');
  else await until(() => textIncludes('Les missions ne sont pas encore disponibles sur ce PC.'), Boolean, 'honest unavailable projects');
  await delay(500);
  await ui.screenshot(join(threadShots,`${threadMode}-threads-390.png`));
  assert.equal(await ui.evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
  await ui.fill('[aria-label="Rechercher un fil"]','Nóva');
  await until(() => ui.evaluate("!!document.querySelector('[aria-label=\"Ouvrir la conversation Nova\"]')"),Boolean,'accent-insensitive search');
  assert.equal(await ui.evaluate("!!document.querySelector('[aria-label=\"Ouvrir la conversation Mino\"]')"),false);
  await settledClick("document.querySelector('[aria-label=\"Ouvrir la conversation Nova\"]')");
  await until(() => ui.evaluate("document.querySelector('[aria-label=\"Message\"]')?.placeholder==='Écrire à Nova…'"),Boolean,'Nova conversation opened');
  await ui.fill('[aria-label="Message"]','Brouillon privé de Nova');
  await settledClick("document.querySelector('[aria-label=\"Conversations\"]')");
  await until(() => textIncludes('Vos fils'),Boolean,'back to list');
  assert.equal(await ui.evaluate("document.querySelector('[aria-label=\"Rechercher un fil\"]').value"),'Nóva');
  await clickText('Mon PC'); await until(()=>textIncludes('Déconnecter cet appareil'),Boolean,'PC panel from list');
  await clickText('Fermer'); await until(()=>textIncludes('Vos fils'),Boolean,'PC returns to list');
  await settledClick("document.querySelector('[aria-label=\"Créer un bot\"]')");
  await until(()=>textIncludes('Nouveau bot'),Boolean,'create panel from list');
  await clickText('Fermer'); await until(()=>textIncludes('Vos fils'),Boolean,'create returns to list');
  await clickText('Activité'); await until(()=>textIncludes('Missions des exécutants'),Boolean,'activity from list');
  await clickText('Carnet local'); await until(()=>textIncludes('Aucune publication locale.'),Boolean,'local notebook remains reachable');
  await clickText('Fermer'); await until(()=>textIncludes('Missions des exécutants'),Boolean,'notebook returns to activity');
  if (agentModules) {
    await clickText('Missions des exécutants'); await until(()=>textIncludes('Nouvelle mission'),Boolean,'mission list from activity');
    await clickText('Fermer'); await until(()=>textIncludes('Missions des exécutants'),Boolean,'mission list returns to activity');
  }
  await clickText('Fermer'); await until(()=>textIncludes('Vos fils'),Boolean,'activity returns to list');

  assert.equal(await ui.evaluate("document.querySelector('[aria-label=\"Rechercher un fil\"]').value"),'Nóva');

  await settledClick("document.querySelector('[aria-label=\"Effacer la recherche\"]')");
  if (missionId) {
    await ui.fill('[aria-label="Rechercher un fil"]','CAFE BOREAL');
    await until(() => ui.evaluate("!!document.querySelector('[aria-label=\"Ouvrir la mission Préparer la page de préouverture du café\"]')"),Boolean,'project search');
    await clickText('Votre avis');
    await delay(300); await ui.screenshot(join(threadShots,'after-projects-390.png'));
    await settledClick("document.querySelector('[aria-label=\"Ouvrir la mission Préparer la page de préouverture du café\"]')");
    await until(() => textIncludes('Fil de l’exécutant'),Boolean,'targeted mission opens');
    await until(() => textIncludes('Préparer la page de préouverture du café'),Boolean,'mission goal shown');
    assert.equal(await ui.evaluate("document.querySelector('[aria-label=\"Message\"]').placeholder"),'Écrire à Nova…');
    await delay(500);await ui.screenshot(join(threadShots,'after-mission-390.png'));
    await clickText('Fermer');
    await until(() => textIncludes('Vos fils'),Boolean,'return to filtered list');
    assert.equal(await ui.evaluate("document.querySelector('[aria-label=\"Rechercher un fil\"]').value"),'CAFE BOREAL');
    await settledClick("document.querySelector('[aria-label=\"Effacer la recherche\"]')");await clickText('Tous');
  }
  await until(()=>ui.evaluate("!!document.querySelector('[aria-label=\"Ouvrir la conversation Mino\"]')"),Boolean,'all conversations restored');
  await settledClick("document.querySelector('[aria-label=\"Ouvrir la conversation Mino\"]')");
  await until(() => ui.evaluate("document.querySelector('[aria-label=\"Message\"]')?.value==='Brouillon conservé après rechargement'"),Boolean,'Mino draft intact');
  await settledClick("document.querySelector('[aria-label=\"Conversations\"]')");await until(()=>textIncludes('Vos fils'),Boolean,'list again');
  await ui.rpc('Emulation.setDeviceMetricsOverride',{width:430,height:932,deviceScaleFactor:1,mobile:true});await delay(200);
  await ui.screenshot(join(threadShots,agentModules?'after-projects-430.png':`${threadMode}-threads-430.png`));
  await clickText('Fermer');
  await ui.rpc('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  check('Thread search and filters use real metadata, bot switching isolates drafts; PC and create panels return to the list with its query');
  if (missionId) check('Project mission is stored in isolated SQLite, executed by fake App Server, opened by exact missionId without changing selected bot; returning preserves query and chat draft');
}
async function verifyChat() {
  const input = '[aria-label="Message"]';
  const metrics = () => ui.evaluate(`(()=>{const el=document.querySelector('${input}'), dock=document.querySelector('[data-testid="chat-composer"]'), bar=document.querySelector('[data-testid="chat-composer-bar"]');return{field:el.getBoundingClientRect().height,dock:dock.getBoundingClientRect().height,font:getComputedStyle(el).fontSize,outline:getComputedStyle(el).outlineStyle,width:document.documentElement.scrollWidth,viewport:innerWidth,bar:getComputedStyle(bar).backgroundColor}})()`);
  await ui.fill(input, '');
  await until(metrics, m => m.dock <= 90, 'compact empty composer');
  assert.equal((await metrics()).font, '17px');
  assert.equal((await metrics()).outline, 'none');
  const multiline = 'Une première idée\nUne deuxième idée\nUne troisième idée\nUne quatrième idée\nUne cinquième idée\nUne sixième idée';
  await ui.fill(input, multiline);
  const grown = await until(metrics, m => m.field >= 90, 'composer grows with multiline text');
  assert(grown.field <= 128);
  assert.equal(grown.bar, 'rgb(0, 0, 0)');
  assert(grown.width <= grown.viewport);
  await ui.fill(input, 'Une idée');
  await until(metrics, m => m.field <= 26, 'composer shrinks to one line after editing');
  await ui.fill(input, multiline);
  await until(metrics, m => m.field >= 90, 'composer grows again after editing');
  await ui.evaluate(`window.__minoInput=document.querySelector('${input}');window.__minoInput.setSelectionRange(7,7)`);
  await delay(1100);
  assert.equal(await ui.evaluate(`document.activeElement===window.__minoInput&&window.__minoInput.selectionStart===7&&window.__minoInput.value===${JSON.stringify(multiline)}`), true);
  check('Multiline composer grows within its bound, uses 17px text, preserves input node, caret and draft across polling');
  await ui.screenshot(join(root, 'docs/mobile/chat/after-multiline.png'));
  await ui.evaluate(`(()=>{const v=visualViewport;window.__minoViewport={height:v.height,top:v.offsetTop};Object.defineProperty(v,'height',{configurable:true,value:470});Object.defineProperty(v,'offsetTop',{configurable:true,value:30});v.dispatchEvent(new Event('resize'))})()`);
  await until(() => ui.evaluate("document.querySelector('[data-testid=\"chat-composer\"]').getBoundingClientRect().bottom"), x => x <= 501, 'composer follows simulated keyboard viewport');
  assert.equal(await ui.evaluate('document.activeElement===window.__minoInput&&window.__minoInput.selectionStart===7'), true);
  await ui.screenshot(join(root, 'docs/mobile/chat/after-keyboard-viewport.png'));
  await ui.evaluate("delete visualViewport.height;delete visualViewport.offsetTop;visualViewport.dispatchEvent(new Event('resize'))");
  check('Simulated VisualViewport resize and offset preserve focus and keep composer visible; physical iOS keyboard not tested');
  await ui.fill(input, 'Tu as une idée pour un week-end tranquille ?');
  replyMode = 'rich';
  await ui.click("document.querySelector('[aria-label=\"Envoyer\"]')");
  await until(() => textIncludes('Un week-end sans courir.'), Boolean, 'formatted controlled reply');
  await delay(500);
  assert.equal(await ui.evaluate(`document.activeElement===window.__minoInput&&document.querySelector('${input}').value===''`), true);
  await until(metrics, m => m.field <= 26, 'composer collapses after send');
  assert.equal(await ui.evaluate("document.documentElement.scrollWidth<=innerWidth"), true);
  await ui.evaluate(`document.querySelector('${input}').blur()`);
  await ui.screenshot(join(root, 'docs/mobile/chat/after-rich-390.png'));
  await ui.rpc('Emulation.setDeviceMetricsOverride', {width:430,height:932,deviceScaleFactor:1,mobile:true});
  await delay(250);
  await ui.screenshot(join(root, 'docs/mobile/chat/after-rich-430.png'));
  assert.equal(await ui.evaluate("document.documentElement.scrollWidth<=innerWidth"), true);
  await ui.rpc('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:1,mobile:true});
  replyMode = 'hold';
  await ui.fill(input, 'Une autre idée ?');
  await ui.click("document.querySelector('[aria-label=\"Envoyer\"]')");
  await until(() => ui.evaluate("!!document.querySelector('[aria-label=\"Arrêter la réponse\"]')"), Boolean, 'stop on active work');
  const running = await until(() => app.store.view().works.find(w => w.state === 'running'), Boolean, 'controlled turn really running');
  const dotOpacity = () => ui.evaluate("[...document.querySelectorAll('[aria-label$=\"rédige\"] div')].filter(e=>e.getBoundingClientRect().width===4).map(e=>getComputedStyle(e).opacity)");
  const dotsBefore = await dotOpacity();
  await delay(170);
  const dotsAfter = await dotOpacity();
  assert.equal(dotsBefore.length, 3);
  assert.notDeepEqual(dotsBefore, dotsAfter);
  await ui.rpc('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await delay(100);
  const reducedBefore = await dotOpacity();
  await delay(170);
  assert.deepEqual(await dotOpacity(), reducedBefore);
  await ui.rpc('Emulation.setEmulatedMedia', { features: [] });
  check('Typing dots animate during a real active fixture turn and stop under reduced-motion preference');
  await ui.screenshot(join(root, 'docs/mobile/chat/after-typing.png'));
  await ui.click("document.querySelector('[aria-label=\"Arrêter la réponse\"]')");
  await until(() => app.store.view().works.find(w => w.id === running.id)?.state, s => s === 'cancelled', 'physical cancellation');
  await until(() => ui.evaluate("!!document.querySelector('[aria-label=\"Envoyer\"]')"), Boolean, 'send restored after stop');
  check('Formatted replies render lists/code/table without horizontal page overflow at 390 and 430px; send retains input focus; active-turn stop cancels actual worker');
  replyMode = 'plain';
}
try {
  app = await start();
  ui = await browser(join(dir, 'chrome'), { args: [`--host-resolver-rules=MAP ${hostname} 127.0.0.1`, '--no-proxy-server'] });
  pc = await browser(join(dir, 'pc-chrome'));
  await pc.navigate(adminBase + '/devices');
  await until(() => pc.evaluate("document.querySelector('#browser-window')?.disabled===false"), Boolean, 'PC admission button ready');
  await clickText('Afficher le QR', pc);
  await until(() => app.admission.expiresAt(), Boolean, 'admission opened by PC UI');
  await until(() => pc.evaluate("!!document.querySelector('#browser-qr svg')"), Boolean, 'connection QR rendered');
  const scanURL = await pc.evaluate("document.querySelector('#scan-url').href");
  assert.equal(new URL(scanURL).origin, base);
  assert.equal(new URL(scanURL).hash, '#connect');
  assert.match(new URL(scanURL).searchParams.get('launch') ?? '', /^[a-z0-9]+$/);
  const qrPixels = new Resvg(await pc.evaluate("document.querySelector('#browser-qr svg').outerHTML")).render();
  const decoded = jsQR(new Uint8ClampedArray(qrPixels.pixels), qrPixels.width, qrPixels.height);
  assert.equal(decoded?.data, scanURL);
  check('PC QR contains an ordinary HTTPS link and opens one admission window');
  await ui.rpc('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await ui.navigate(scanURL);
  await until(() => textIncludes('Associer le PC'), Boolean, 'HTTPS web client renders', 20000);
  assert.equal(await ui.evaluate('isSecureContext'), true);
  assert.equal(await ui.evaluate("document.body.innerText.includes('JSON du QR')"), false);
  assert.equal(bootstrapFailures, 0);
  check('Trusted HTTPS renders the exported client without Expo or QR');
  await until(() => app.devices.list().some(d => d.state === 'pending'), Boolean, 'pending device');
  const device = app.devices.list().find(d => d.state === 'pending'); assert(device);
  await until(() => textIncludes(device.confirmCode), Boolean, 'same confirmation code');
  assert.equal(await ui.evaluate('location.hash'), '');
  assert.equal(app.devices.list().length, 1);
  assert.equal(await ui.evaluate('document.cookie'), '');
  assert.equal(await ui.evaluate("JSON.stringify(localStorage).includes('__Host-mino-device')"), false);
  assert.equal(await ui.evaluate("fetch('/m/view',{headers:{'X-Mino-Web':'1'}}).then(r=>r.status)"), 403);
  check('Pending phone displays matching code and cannot read conversations; cookie is HttpOnly');
  await until(() => textIncludes(device.confirmCode, pc), Boolean, 'PC displays matching code');
  assert.equal(await pc.evaluate("!!document.querySelector('#browser-qr svg')"), false);
  assert.equal(await textIncludes('QR utilisé.', pc), true);
  await clickText('Connecter ce téléphone', pc);
  await until(() => app.devices.list().find(d => d.id === device.id)?.state === 'active', Boolean, 'PC approval button');
  await ui.navigate(base);
  await until(() => ui.evaluate("!!document.querySelector('[aria-label=\"Message\"]')"), Boolean, 'approved chat');
  check('QR automatically requests access, and one PC confirmation authorizes the phone');
  const cookies = await ui.rpc('Network.getCookies', { urls: [base] });
  const cookie = cookies.cookies.find(c => c.name === '__Host-mino-device'); assert(cookie?.httpOnly && cookie.secure && cookie.sameSite === 'Strict');
  assert(cookie.expires * 1000 > Date.now() + 29 * 86400000);
  await ui.fill('[aria-label="Message"]', 'Bonjour synthétique');
  await ui.evaluate("(()=>{const b=document.querySelector('[aria-label=\"Envoyer\"]');b.click();b.click()})()");
  await until(() => textIncludes('Réponse synthétique pour vérifier Safari.'), Boolean, 'controlled chat response');
  assert.equal(calls, 1);
  await ui.fill('[aria-label="Message"]', 'Brouillon conservé après rechargement');
  await until(() => ui.evaluate("JSON.stringify(localStorage).includes('Brouillon conservé après rechargement')"), Boolean, 'draft persisted');
  mkdirSync(join(evidenceDir, 'safari'), { recursive: true });
  await delay(450);
  await ui.evaluate("document.querySelector('[aria-label=\"Message\"]').blur()");
  if (!threadMode) await ui.screenshot(join(evidenceDir, 'safari/chat.png'));
  mkdirSync(join(root, 'docs/mobile/chat'), { recursive: true });
  if (!threadMode) await ui.screenshot(join(root, 'docs/mobile/chat/after-390.png'));
  evidence.layout = await ui.evaluate(`(()=>{const rect=e=>{const r=e.getBoundingClientRect();return{x:100*r.x/innerWidth,y:100*r.y/innerHeight,w:100*r.width/innerWidth,h:100*r.height/innerHeight}};return{messages:[...document.querySelectorAll('[data-testid="chat-message"]')].map(rect),composer:rect(document.querySelector('[data-testid="chat-composer"]'))}})()`);
  check('Double press sends one request through cookie-authenticated Store and worker; draft persists');
  await ui.reload();
  await until(() => ui.evaluate("document.querySelector('[aria-label=\"Message\"]')?.value==='Brouillon conservé après rechargement'"), Boolean, 'reload resumes draft');
  await app.close(); app = null;
  app = await start();
  await ui.reload();
  await until(() => textIncludes('Réponse synthétique pour vérifier Safari.'), Boolean, 'server restart preserves response');
  assert.equal(calls, 1);
  assert.equal(app.admission.expiresAt(), null);
  check('Browser reload and database reopen preserve approval, result and draft with no repeated execution');
  if (process.env.MINO_VERIFY_CHAT_UX === '1') await verifyChat();
  if (threadMode) await verifyThreads();
  await app.admin('/api/devices/browser-window', {});
  await app.admin('/api/devices/revoke', { deviceId: device.id });
  await until(() => textIncludes('Demander l’accès au PC'), Boolean, 'revocation returns to pairing');
  await ui.reload();
  await until(() => textIncludes('Demander l’accès au PC'), Boolean, 'revocation survives reload');
  assert.equal(await ui.evaluate("document.body.innerText.includes('Réponse synthétique pour vérifier Safari.')"), false);
  assert.equal(app.devices.list().some(d => d.state === 'pending'), false);
  assert(app.admission.expiresAt());
  check('PC revocation clears access and does not reclaim an open pairing window after reload');
  await app.admin('/api/devices/browser-window', {});
  await ui.evaluate("location.hash='connect'");
  await until(() => app.devices.list().some(d => d.state === 'pending'), Boolean, 'new pending session');
  const nextDevice = app.devices.list().find(d => d.state === 'pending'); assert(nextDevice);
  await until(() => textIncludes(nextDevice.confirmCode), Boolean, 'new confirmation received');
  await app.admin('/api/devices/approve', { pairingId: nextDevice.pairingId, deviceId: nextDevice.id, confirmCode: nextDevice.confirmCode });
  await until(() => ui.evaluate("!!document.querySelector('[aria-label=\"Message\"]')"), Boolean, 'new session approved');
  await ui.click("document.querySelector('[aria-label=\"Ordinateur connecté\"]')");
  await until(() => textIncludes('Déconnecter cet appareil'), Boolean, 'connection panel');
  await app.admin('/api/devices/browser-window', {});
  await clickText('Déconnecter cet appareil');
  await until(() => textIncludes('Cet appareil est déconnecté.'), Boolean, 'server-confirmed logout');
  assert.equal(app.devices.list().find(d => d.id === nextDevice.id)?.state, 'revoked');
  await ui.reload();
  await until(() => textIncludes('Demander l’accès au PC'), Boolean, 'logout survives reload');
  assert.equal(app.devices.list().some(d => d.state === 'pending'), false);
  assert(app.admission.expiresAt());
  check('Browser logout revokes its own server credential and never auto-claims an open pairing window');
  evidence.result = 'passed';
} catch (error) {
  evidence.result = 'failed'; evidence.failure = error instanceof Error ? error.message : 'Unknown verification error';
  if (ui) { try { evidence.page = await ui.evaluate('document.body.innerText.slice(0,1600)'); evidence.input = await ui.evaluate("(()=>{const e=document.querySelector('[aria-label=\"Message\"]');return e&&{value:e.value,html:e.outerHTML,scroll:e.scrollHeight,rect:e.getBoundingClientRect().toJSON()}})()"); await ui.screenshot(join(dir,'failure.png'));  } catch {} }
  throw error;
} finally {
  evidence.finishedAt = new Date().toISOString();
  if (ui) await ui.close();
  if (pc) await pc.close();
  if (app) await app.close();
  writeFileSync(join(evidenceDir, threadMode ? `fusion-${threadMode}.json` : 'safari-ui.json'), JSON.stringify(evidence, null, 2) + '\n');
  rmSync(dir, { recursive: true, force: true });
  if (fixtureProject) rmSync(fixtureProject, { recursive: true, force: true });
}
