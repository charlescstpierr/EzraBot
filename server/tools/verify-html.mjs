import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { openStore } from '../dist/src/store.js';
import { loadMascots } from '../dist/src/domain.js';

const root = new URL('../', import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'mino-html-browser-'));
const profile = join(dir, 'chrome');
const port = Number(process.env.MINO_HTML_PORT ?? 4394);
const base = `http://127.0.0.1:${port}`;
writeFileSync(new URL('docs/evidence/html-browser.json',root),JSON.stringify({checkedAt:new Date().toISOString(),passed:false,note:'Parcours contrôlé en cours; aucune réussite actuelle.'},null,2)+'\n');
const trapRequests=[];
const trap=createServer((req,res)=>{trapRequests.push(req.url);res.writeHead(200,{'access-control-allow-origin':'*'});res.end('trap')});
await new Promise(resolve=>trap.listen(0,'127.0.0.1',resolve));
const trapUrl='http://127.0.0.1:'+trap.address().port;
const pageHtml=`<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>body{font:18px system-ui;background:#f4f6f0;padding:30px}button{padding:14px 24px;background:#222;color:white;border:0;border-radius:14px}h1{font-size:28px}</style></head><body><h1>Une vraie page</h1><p>Compteur : <strong id="count">0</strong></p><button id="increment">Ajouter</button><button id="navigate">Navigation externe</button><img src="${trapUrl}/pixel"><script>
window.probe={};
try { parent.document.body.dataset.pwned='yes'; probe.parentReadable=true } catch {probe.parentBlocked=true}
try {localStorage.setItem('pwned','yes');probe.storageReadable=true} catch {probe.storageBlocked=true}
fetch('/api/view').then(()=>probe.apiReadable=true).catch(()=>probe.apiBlocked=true);
fetch('${trapUrl}/fetch').then(()=>probe.networkAllowed=true).catch(()=>probe.networkBlocked=true);
document.querySelector('#increment').onclick=()=>{const e=document.querySelector('#count');e.textContent=Number(e.textContent)+1};
document.querySelector('#navigate').onclick=()=>{location.href='${trapUrl}/navigation'};
<\/script></body></html>`;
const store = openStore({path:join(dir,'mino.sqlite'),mascots:loadMascots(new URL('assets/mascots.json',root))});
let seedCount=0;
function seed(botId,text,reply,deliverable=null,mentions=[]) {
  const sent=store.dispatch({type:'message.send',requestId:'thread-seed-'+(++seedCount),botId,text,attachments:[],...(mentions.length?{mentions}:{})});
  assert(sent.ok,sent.message);const claim=store.claimNextJob();assert(claim);
  store.finishJob(claim,{kind:'succeeded',reply:{reply,deliverable},used:{model:'controlled-fixture',effort:'low',speed:'standard'},threadId:'seed-thread-'+seedCount,turnId:'seed-turn-'+seedCount});
  return sent.result.workId;
}
const htmlWork=seed('mino','Créer une page HTML','Voici la page.',{title:'Compteur',body:pageHtml});
const legacyWork=seed('nova','Ancienne réponse HTML','Voici.\n```html\n'+pageHtml+'\n```');
const recordedRealHtml=process.env.MINO_REAL_HTML ? readFileSync(process.env.MINO_REAL_HTML,'utf8') : null;
const realWork=recordedRealHtml ? seed('pixel','Recorded real HTML artifact','Page réellement produite par Codex.',{title:'Compteur réel',body:recordedRealHtml}) : null;
store.close();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, predicate, label) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(50);
  }
  throw new Error(`Condition non atteinte: ${label}`);
}
const cli=join(dir,'codex-fixture.mjs');
let fake=readFileSync(new URL('dist/test/fixtures/fake-app-server.js',root),'utf8');
assert(fake.includes("const scenario = process.argv[2] ?? 'reply';"));
fake=fake.replace("const scenario = process.argv[2] ?? 'reply';","const scenario = 'reply';").replace('const args = process.argv.slice(3);','const args = process.argv.slice(2);');
writeFileSync(cli,'#!'+process.execPath+'\n'+fake);chmodSync(cli,0o700);
const server = spawn(process.execPath, ['dist/src/main.js'], { cwd: root, env: { ...process.env, MINO_DATA_DIR: dir, MINO_PORT: String(port), MINO_CODEX_BIN: cli }, stdio: ['ignore', 'pipe', 'pipe'] });
server.stderr.resume();
const serverExit = new Promise(resolve => server.once('exit', resolve));
let chrome;
let socket;
let readyTimer;
const browserErrors=[];
let diagnose;
try {
  await new Promise((resolve, reject) => {
    readyTimer = setTimeout(() => reject(new Error('Serveur de test indisponible')), 10_000);
    createInterface({ input: server.stdout }).on('line', line => {
      try { if (JSON.parse(line).event === 'ready') resolve(); } catch { reject(new Error('Journal invalide')); }
    });
    server.once('error', () => reject(new Error('Démarrage impossible')));
    server.once('exit', () => reject(new Error('Arrêt avant disponibilité')));
  });
  clearTimeout(readyTimer);
  chrome = spawn(process.env.MINO_CHROME_BIN ?? 'google-chrome-stable', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
  let chromeError = false;
  chrome.once('error', () => { chromeError = true; });
  await until(async () => {
    if (chromeError) throw new Error('Chrome introuvable; définissez MINO_CHROME_BIN');
    return existsSync(join(profile, 'DevToolsActivePort'));
  }, Boolean, 'Chrome');
  const debugPort = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
  const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
  const page = pages.find(page => page.type === 'page');
  assert(page);
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let seq = 0;
  const contexts=new Map();
  const pending = new Map();
  socket.addEventListener('message', event => {
    const value = JSON.parse(event.data);
    if(value.method==='Log.entryAdded'&&value.params.entry.level==='error')browserErrors.push(value.params.entry.text);
    if(value.method==='Runtime.executionContextCreated'&&value.params.context.auxData?.isDefault)contexts.set((value.sessionId??'root')+':'+value.params.context.id,{id:value.params.context.id,frameId:value.params.context.auxData.frameId,sessionId:value.sessionId});
    const waiter = pending.get(value.id);
    if (waiter) {
      pending.delete(value.id);
      clearTimeout(waiter.timer);
      value.error ? waiter.reject(new Error('Échec CDP')) : waiter.resolve(value.result);
    }
  });
  function rpc(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Délai CDP: ${method}`)); }, 5000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId?{sessionId}:{}) }));
    });
  }
  async function evaluate(expression) {
    const response = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error('Exception dans le parcours navigateur');
    return response.result.value;
  }
  async function fill(selector, text) {
    await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.select()})()`);
    await rpc('Input.insertText', { text });
  }
  async function click(expression) {
    await evaluate(`Promise.all([...document.querySelectorAll('dialog[open]')].flatMap(d=>d.getAnimations()).map(a=>a.finished.catch(()=>{})))`);
    const rect = await evaluate(`(()=>{const e=${expression};if(!e)throw Error('Bouton absent');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', ...rect, button: 'left', buttons: 1, clickCount: 1 });
    await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rect, button: 'left', buttons: 0, clickCount: 1 });
  }
  const view=async()=>(await(await fetch(base+'/api/view?after=-1')).json());
  const visible=()=>evaluate(`document.querySelector('#messages')?.innerText??''`);
  const prompt=()=>evaluate(`document.querySelector('#prompt').value`);
  const csrf=/name="mino-csrf" content="([a-f0-9]+)"/.exec(await(await fetch(base)).text())[1];
  const post=async command=>(await(await fetch(base+'/api/commands',{method:'POST',headers:{origin:base,'content-type':'application/json','x-mino-csrf':csrf},body:JSON.stringify({...command,requestId:crypto.randomUUID()})})).json());
  async function key(key,code=key){await rpc('Input.dispatchKeyEvent',{type:'keyDown',key,code});await rpc('Input.dispatchKeyEvent',{type:'keyUp',key,code});}
  async function setBot(id){
    if(await evaluate(`document.querySelector('.wheel-bot[aria-pressed="true"]').dataset.botId`)===id)return;
    await click(`document.querySelector('#bot-trigger')`);
    await until(()=>evaluate(`document.querySelector('#bot-fan').classList.contains('is-open')`),Boolean,'choix des bots');
    await delay(700); // Wait for the existing semicircle transition before pointing at another bot.
    await click(`document.querySelector('.wheel-bot[data-bot-id="${id}"]')`);
    await until(()=>evaluate(`document.querySelector('.wheel-bot[aria-pressed="true"]').dataset.botId`),v=>v===id,'changement de fil');
    assert.equal(await evaluate(`document.querySelector('#play-dialog').open`),false,'choisir un autre bot ouvre son fil');
    await until(view,v=>v.activeBotId===id,'sélection persistée');
  }
  async function chooseMention(name,pointer=false){
    await rpc('Input.insertText',{text:'@'+name});
    await until(()=>evaluate(`Boolean(document.querySelector('[role="listbox"] [role="option"]'))`),Boolean,'suggestion @');
    if(pointer)await click(`document.querySelector('[role="listbox"] [aria-selected="true"]')`);else await key('Enter');
    await until(prompt,v=>v.includes('@'+name),'mention choisie');
  }
  async function sendAndWait(marker){
    await click(`document.querySelector('#send')`);
    return until(view,v=>{
      const m=v.messages.find(m=>m.role==='user'&&m.text.includes(marker));
      return Boolean(m&&v.works.filter(w=>w.requestMessageId===m.id).every(w=>w.state==='done'));
    },'réponse contrôlée');
  }
  diagnose=async()=>({frames:await rpc('Page.getFrameTree'),targets:await rpc('Target.getTargets'),contexts:[...contexts],errors:browserErrors,iframe:await evaluate(`(()=>{const f=document.querySelector('iframe');return f?{src:f.src,rect:f.getBoundingClientRect().toJSON(),hidden:f.hidden}:null})()`)});
  await rpc('Log.enable');
  await rpc('Page.enable');await rpc('Runtime.enable');await rpc('Page.navigate',{url:base});
  await until(()=>evaluate(`Boolean(document.querySelector('[data-work-id="${htmlWork}"] iframe'))`),Boolean,'aperçu HTML par défaut');
  const attached=new Map();
  async function frameEval(expression){
    const source=await evaluate(`(()=>{const f=document.querySelector('#play-dialog[open] iframe')??[...document.querySelectorAll('iframe')].find(f=>f.getBoundingClientRect().width>0);return f?.src})()`);
    const targets=await rpc('Target.getTargets');
    const target=targets.targetInfos.filter(t=>t.type==='iframe'&&t.url===source).at(-1);
    let sessionId;
    let context;
    if(target){
      sessionId=attached.get(target.targetId);
      if(!sessionId){sessionId=(await rpc('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId;attached.set(target.targetId,sessionId);await rpc('Runtime.enable',{},sessionId);}
      context=[...contexts.values()].findLast(c=>c.sessionId===sessionId)?.id;
    } else {
      const tree=await rpc('Page.getFrameTree');
      const child=tree.frameTree.childFrames?.filter(f=>f.frame.url===source).at(-1);
      context=child?[...contexts.values()].findLast(c=>!c.sessionId&&c.frameId===child.frame.id)?.id:undefined;
    }
    if(!context)return null;
    const r=await rpc('Runtime.evaluate',{expression,contextId:context,returnByValue:true,awaitPromise:true},sessionId);
    if(r.exceptionDetails)throw Error('Exception dans le document HTML');
    return r.result.value;
  }
  await until(()=>frameEval(`document.querySelector('#count')?.textContent`),v=>v==='0','HTML réellement rendu');
  assert.equal(await evaluate(`(()=>{const card=document.querySelector('[data-work-id="${htmlWork}"]');return [...card.querySelectorAll('.card-note')].some(n=>n.textContent.includes('Aperçu de la version enregistrée')&&n.getClientRects().length>0)})()`),false,'une version propre ne demande pas un enregistrement');
  await until(()=>frameEval('window.probe'),v=>v?.apiBlocked&&v.networkBlocked,'réseau bloqué');
  assert.deepEqual(await frameEval('window.probe'),{parentBlocked:true,storageBlocked:true,apiBlocked:true,networkBlocked:true});
  assert.equal(await evaluate('document.body.dataset.pwned??null'),null);
  await frameEval(`document.querySelector('#increment').click()`);
  assert.equal(await frameEval(`document.querySelector('#count').textContent`),'1','JavaScript local interactif');
  const work=(await view()).works.find(w=>w.id===htmlWork);
  const downloaded=await fetch(base+'/api/versions/'+work.versions.at(-1).id+'/download');
  assert(downloaded.headers.get('content-disposition').includes('.html'));
  assert.equal(await downloaded.text(),pageHtml);
  await click(`document.querySelector('[data-work-id="${htmlWork}"] .html-tabs button:last-child')`);
  await fill(`[data-work-id="${htmlWork}"] .draft-editor`,pageHtml.replace('id="count">0','id="count">7'));
  await click(`document.querySelector('[data-work-id="${htmlWork}"] .html-tabs button:first-child')`);
  await until(view,v=>v.works.find(w=>w.id===htmlWork).versions.length===2,'nouvelle version HTML');
  await until(()=>frameEval(`document.querySelector('#count')?.textContent`),v=>v==='7','aperçu actualisé après enregistrement');
  await click(`document.querySelector('[data-work-id="${htmlWork}"] .html-tools button:first-child')`);
  await until(()=>evaluate(`document.querySelector('#play-dialog').open`),Boolean,'aperçu agrandi');
  await until(()=>frameEval(`document.querySelector('#count')?.textContent`),v=>v==='7','page agrandie');
  const screen=await rpc('Page.captureScreenshot',{format:'png'});writeFileSync(new URL('docs/evidence/html-preview.png',root),Buffer.from(screen.data,'base64'));
  await click(`document.querySelector('#play-dialog .play-close')`);
  await until(()=>evaluate(`document.querySelectorAll('#play-dialog iframe').length`),n=>n===0,'aperçu fermé arrêté');
  await rpc('Page.reload',{ignoreCache:true});
  await until(()=>frameEval(`document.querySelector('#count')?.textContent`),v=>v==='7','HTML conservé après rechargement');
  await setBot('nova');
  await until(()=>evaluate(`Boolean(document.querySelector('.assistant-message iframe'))`),Boolean,'ancienne réponse avec aperçu');
  await until(()=>frameEval(`document.querySelector('#count')?.textContent`),v=>v==='0','ancien bloc HTML rendu');
  await frameEval(`document.querySelector('#navigate').click()`);
  await until(()=>evaluate('document.readyState'),v=>v==='complete','parent toujours disponible');
  assert.equal(trapRequests.length,0,'aucune requête externe, image, fetch ou navigation');
  assert.equal(await evaluate('location.href'),base+'/');
  await rpc('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
  let recordedRealArtifact=null;
  if(realWork){
    await setBot('mino');
    await setBot('pixel');
    await until(()=>frameEval(`document.querySelector('#count')?.textContent.trim()`),v=>v==='0','compteur du vrai livrable généré');
    await frameEval(`document.querySelector('#increment').click()`);
    await until(()=>frameEval(`document.querySelector('#count')?.textContent.trim()`),v=>v==='1','interaction avec le vrai livrable généré');
    recordedRealArtifact={sha256:createHash('sha256').update(recordedRealHtml).digest('hex'),rendered:true,counterClickWorks:true,note:'Exact artifact from html-real.json, replayed in the isolated browser fixture without an additional model call.'};
    if(await evaluate(`document.querySelector('#bot-trigger').getAttribute('aria-expanded')==='true'`))await click(`document.querySelector('#bot-trigger')`);
    await evaluate(`Promise.all(document.querySelector('#bot-fan').getAnimations({subtree:true}).filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))`);
    const realScreen=await rpc('Page.captureScreenshot',{format:'png'});writeFileSync(new URL('docs/evidence/html-real-preview.png',root),Buffer.from(realScreen.data,'base64'));
  }
  const proof={passed:true,recordedRealArtifact,checkedAt:new Date().toISOString(),fixture:'Synthetic HTML in temporary SQLite, controlled App Server, loopback-only network trap. No actual model call.',checks:['HTML preview shown by default','local button JavaScript works','opaque origin blocks parent DOM and storage','CSP blocks API reads and external fetch and images','parent CSP blocks external frame navigation','download is exact .html source','Code edits create a version and update preview','enlarged preview works and stops on close','reload retains HTML','legacy assistant HTML block previews','390px has no horizontal page overflow'],trapRequests:trapRequests.length,screenshot:'html-preview.png'};
  writeFileSync(new URL('docs/evidence/html-browser.json',root),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));

} catch(error) {if(diagnose)console.log(JSON.stringify(await diagnose()));throw error;
} finally {
  clearTimeout(readyTimer);socket?.close();chrome?.kill('SIGTERM');server.kill('SIGTERM');await serverExit;await new Promise(resolve=>trap.close(resolve));
}
