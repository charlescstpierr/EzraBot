import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { openStore } from '../dist/src/store.js';
import { loadMascots } from '../dist/src/domain.js';

const root = new URL('../', import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'mino-thread-browser-'));
const profile = join(dir, 'chrome');
const port = Number(process.env.MINO_THREADS_PORT ?? 4398);
const base = `http://127.0.0.1:${port}`;
writeFileSync(new URL('docs/evidence/bot-threads-browser.json',root),JSON.stringify({checkedAt:new Date().toISOString(),passed:false,note:'Parcours contrôlé en cours; aucune réussite actuelle.'},null,2)+'\n');
const store = openStore({path:join(dir,'mino.sqlite'),mascots:loadMascots(new URL('assets/mascots.json',root))});
let seedCount=0;
function seed(botId,text,reply,deliverable=null,mentions=[]) {
  const sent=store.dispatch({type:'message.send',requestId:'thread-seed-'+(++seedCount),botId,text,attachments:[],...(mentions.length?{mentions}:{})});
  assert(sent.ok,sent.message);const claim=store.claimNextJob();assert(claim);
  store.finishJob(claim,{kind:'succeeded',reply:{reply,deliverable},used:{model:'controlled-fixture',effort:'low',speed:'standard'},threadId:'seed-thread-'+seedCount,turnId:'seed-turn-'+seedCount});
  return sent.result.workId;
}
const minoWork=seed('mino','MINO_ARTIFACT_REQUEST','MINO_ONLY_RESPONSE',{title:'MINO_DELIVERABLE',body:'MINO_BODY'});
seed('nova','NOVA_THREAD_PRIVATE','NOVA_ONLY_RESPONSE',{title:'NOVA_DELIVERABLE',body:'NOVA_BODY'});
const guestWork=seed('mino','@Nova GUEST_ARTIFACT','GUEST_REPLY_IN_MINO',{title:'GUEST_DELIVERABLE',body:'GUEST_BODY'},[{botId:'nova',start:0,end:5}]);
for(let i=0;i<12;i++)seed('mino','MINO_HISTORY_'+i,('Historique synthétique '+i+'. ').repeat(30));
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
  const pending = new Map();
  socket.addEventListener('message', event => {
    const value = JSON.parse(event.data);
    const waiter = pending.get(value.id);
    if (waiter) {
      pending.delete(value.id);
      clearTimeout(waiter.timer);
      value.error ? waiter.reject(new Error('Échec CDP')) : waiter.resolve(value.result);
    }
  });
  function rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Délai CDP: ${method}`)); }, 5000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
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
  await rpc('Page.enable');await rpc('Runtime.enable');await rpc('Page.navigate',{url:base});
  await until(visible,t=>t.includes('MINO_ONLY_RESPONSE'),'fil de Mino');
  assert(!(await visible()).includes('NOVA_THREAD_PRIVATE'));
  await evaluate(`document.querySelector('#messages').scrollTop=500`);
  const minoScroll=await evaluate(`document.querySelector('#messages').scrollTop`);
  await fill('#prompt','BROUILLON MINO');
  await setBot('nova');
  await until(visible,t=>t.includes('NOVA_ONLY_RESPONSE'),'fil de Nova');
  assert(!(await visible()).includes('MINO_ONLY_RESPONSE'));
  assert(!(await visible()).includes('GUEST_REPLY_IN_MINO'));
  await fill('#prompt','BROUILLON NOVA');
  await setBot('mino');
  assert.equal(await prompt(),'BROUILLON MINO');
  assert.equal(await evaluate(`document.querySelector('#messages').scrollTop`),minoScroll);
  await fill('#prompt','');
  const before=(await view()).works.length;
  await chooseMention('Nova');
  assert.equal((await view()).works.length,before,'Entrée choisit le tag avant tout envoi');
  await rpc('Input.insertText',{text:'INVITED_BROWSER_CHECK'});
  const invited=await sendAndWait('INVITED_BROWSER_CHECK');
  const request=invited.messages.find(m=>m.role==='user'&&m.text.includes('INVITED_BROWSER_CHECK'));
  const jobs=invited.works.filter(w=>w.requestMessageId===request.id);
  assert.equal(jobs.length,1);assert.equal(jobs[0].botId,'nova');assert.equal(jobs[0].threadBotId,'mino');
  assert.equal(invited.messages.filter(m=>m.role==='user'&&m.text.includes('INVITED_BROWSER_CHECK')).length,1);
  assert(invited.messages.some(m=>m.role==='assistant'&&m.workId===jobs[0].id&&m.botId==='nova'&&m.threadBotId==='mino'));
  await setBot('nova');assert(!(await visible()).includes('INVITED_BROWSER_CHECK'));
  assert.equal(await prompt(),'BROUILLON NOVA');
  await setBot('mino');await fill('#prompt','');await chooseMention('Nova');
  await rpc('Input.insertText',{text:'MENTION_DRAFT_RELOAD'});
  assert((await post({type:'bot.update',botId:'nova',name:'Nova Deux'})).ok);
  await setBot('nova');await rpc('Page.reload',{ignoreCache:true});
  await until(visible,t=>t.includes('NOVA_ONLY_RESPONSE'),'fil après rechargement');
  await setBot('mino');
  await until(prompt,t=>t.includes('@Nova')&&t.includes('MENTION_DRAFT_RELOAD'),'brouillon avec tag');
  const restored=await sendAndWait('MENTION_DRAFT_RELOAD');
  const restoredMsg=restored.messages.find(m=>m.role==='user'&&m.text.includes('MENTION_DRAFT_RELOAD'));
  assert.equal(restored.works.find(w=>w.requestMessageId===restoredMsg.id).botId,'nova');

  await fill('#prompt','');await chooseMention('Nova');await chooseMention('Pixel',true);
  await rpc('Input.insertText',{text:'TWO_BOTS_BROWSER'});
  const multiple=await sendAndWait('TWO_BOTS_BROWSER');
  const multiMsg=multiple.messages.find(m=>m.role==='user'&&m.text.includes('TWO_BOTS_BROWSER'));
  assert.deepEqual(multiple.works.filter(w=>w.requestMessageId===multiMsg.id).map(w=>w.botId).sort(),['nova','pixel']);
  assert.equal(multiple.messages.filter(m=>m.role==='user'&&m.text.includes('TWO_BOTS_BROWSER')).length,1);
  await fill('#prompt','email@example.com EMAIL_NOT_A_TAG');
  const email=await sendAndWait('EMAIL_NOT_A_TAG');
  const emailMsg=email.messages.find(m=>m.role==='user'&&m.text.includes('EMAIL_NOT_A_TAG'));
  assert.equal(email.works.find(w=>w.requestMessageId===emailMsg.id).botId,'mino');
  await fill('#prompt','');await chooseMention('Nova');
  await evaluate(`document.querySelector('#prompt').setSelectionRange(0,0)`);
  await rpc('Input.insertText',{text:'`'});
  await evaluate(`{const e=document.querySelector('#prompt');e.setSelectionRange(e.value.length,e.value.length)}`);
  await rpc('Input.insertText',{text:'` CODE_TAG_INERT'});
  const code=await sendAndWait('CODE_TAG_INERT');
  const codeMsg=code.messages.find(m=>m.role==='user'&&m.text.includes('CODE_TAG_INERT'));
  assert.equal(code.works.find(w=>w.requestMessageId===codeMsg.id).botId,'mino');

  // A rejected save keeps the local card dirty while its pane is hidden.
  const fetchErrors=[];
  socket.addEventListener('message',event=>{
    const value=JSON.parse(event.data);if(value.method!=='Fetch.requestPaused')return;
    const data=value.params;
    let body;try{body=JSON.parse(data.request.postData||'{}')}catch{body={}}
    const command=body.type==='version.edit'
      ?rpc('Fetch.fulfillRequest',{requestId:data.requestId,responseCode:409,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify({ok:false,message:'Conflit synthétique du test'})).toString('base64')})
      :rpc('Fetch.continueRequest',{requestId:data.requestId});
    command.catch(e=>fetchErrors.push(e.message));
  });
  await rpc('Fetch.enable',{patterns:[{urlPattern:'*/api/commands',requestStage:'Request'}]});
  await fill(`[data-work-id="${minoWork}"] .draft-editor`,'MINO_DIRTY_HIDDEN');
  await setBot('nova');
  await until(()=>evaluate(`document.querySelector('[data-work-id="${minoWork}"]').dataset.keepDraft`),v=>v==='true','carte cachée protégée');
  await rpc('Fetch.disable');assert.deepEqual(fetchErrors,[]);
  async function refuseHiddenAcceptance(){
    await click(`document.querySelector('#work-toggle')`);
    const found=await evaluate(`[...document.querySelectorAll('#work-list .work-row')].find(r=>r.textContent.includes('MINO_DELIVERABLE'))?.textContent`);
    assert(found);
    await click(`[...[...document.querySelectorAll('#work-list .work-row')].find(r=>r.textContent.includes('MINO_DELIVERABLE')).querySelectorAll('button')].find(b=>b.textContent==='Valider')`);
    await until(()=>evaluate(`document.querySelector('#toast').textContent`),t=>t.includes('Enregistrez vos modifications'),'validation refusée sur autre fil');
    assert.equal((await view()).works.find(w=>w.id===minoWork).state,'review');
    await click(`document.querySelector('#work-drawer-close')`);
  }
  await refuseHiddenAcceptance();
  const sameContentWork=(await view()).works.find(w=>w.id===minoWork);
  assert((await post({type:'version.edit',workId:minoWork,baseVersionId:sameContentWork.versions.at(-1).id,title:sameContentWork.versions.at(-1).title,body:'MINO_DIRTY_HIDDEN'})).ok);
  await rpc('Page.reload',{ignoreCache:true});
  await until(visible,t=>t.includes('NOVA_ONLY_RESPONSE'),'autre fil rechargé sans carte de Mino');
  await refuseHiddenAcceptance();
  await click(`document.querySelector('#work-toggle')`);
  await click(`[...document.querySelectorAll('#work-list .work-row')].find(r=>r.textContent.includes('MINO_DELIVERABLE')).querySelector('.work-row-main')`);
  await until(prompt,v=>typeof v==='string','retour au fil de travail');
  await until(()=>evaluate(`document.querySelector('.wheel-bot[aria-pressed="true"]').dataset.botId`),id=>id==='mino','travail dans son fil');
  assert.equal(await evaluate(`document.querySelector('[data-work-id="${minoWork}"] .draft-editor').value`),'MINO_DIRTY_HIDDEN');

  await setBot('nova');
  await click(`document.querySelector('#more')`);
  await click(`document.querySelector('[data-play-action="2"]')`);
  await until(()=>evaluate(`document.querySelector('#creations-drawer').open`),Boolean,'créations');
  await click(`[...document.querySelectorAll('.creation-card')].find(c=>c.textContent.includes('GUEST_DELIVERABLE'))`);
  await click(`document.querySelector('#creation-in-chat')`);
  await until(()=>evaluate(`document.querySelector('.wheel-bot[aria-pressed="true"]').dataset.botId`),id=>id==='mino','création invitée dans fil propriétaire');
  assert.equal(await evaluate(`document.querySelector('[data-work-id="${guestWork}"] .card-title-input').value`),'GUEST_DELIVERABLE');
  await until(()=>evaluate(`(()=>{const r=document.querySelector('[data-work-id="${guestWork}"]').getBoundingClientRect();const v=document.querySelector('#messages').getBoundingClientRect();return r.bottom>v.top&&r.top<v.bottom})()`),Boolean,'création invitée visible');
  await click(`document.querySelector('#more')`);await click(`document.querySelector('[data-play-action="0"]')`);
  await fill('#search-input','NOVA_THREAD_PRIVATE');
  await until(()=>evaluate(`document.querySelectorAll('.search-hit-row').length`),n=>n>0,'recherche globale');
  await click(`document.querySelector('.search-hit-row')`);
  await until(()=>evaluate(`document.querySelector('.wheel-bot[aria-pressed="true"]').dataset.botId`),id=>id==='nova','recherche dans bon fil');
  assert((await visible()).includes('NOVA_THREAD_PRIVATE'));
  assert(!(await visible()).includes('MINO_ONLY_RESPONSE'));
  await setBot('mino');await fill('#prompt','');
  await rpc('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
  const renamed=(await view()).bots.find(b=>b.id==='nova');
  assert((await post({type:'bot.update',botId:'pixel',name:renamed.name,title:renamed.title,shape:renamed.shape,color:renamed.color})).ok);
  await rpc('Input.insertText',{text:'@No'});
  await until(()=>evaluate(`Boolean(document.querySelector('[role="listbox"] [role="option"]'))`),Boolean,'menu @ mobile');
  await until(()=>evaluate(`document.querySelectorAll('[role="listbox"] [role="option"]').length`),n=>n>=2,'homonymes proposés');
  const labels=await evaluate(`[...document.querySelectorAll('[role="listbox"] [role="option"]')].filter(e=>e.querySelector('strong')?.textContent===${JSON.stringify(renamed.name)}).map(e=>e.textContent)`);
  assert.equal(labels.length,2);assert.equal(new Set(labels).size,2,'les homonymes doivent être distinguables');
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
  const screenshot=await rpc('Page.captureScreenshot',{format:'png'});
  writeFileSync(new URL('docs/evidence/bot-mentions-mobile.png',root),Buffer.from(screenshot.data,'base64'));
  const proof={passed:true,checkedAt:new Date().toISOString(),fixture:'Temporary SQLite and controlled App Server. No real model call.',dataDir:dir,checks:['personal threads are distinct','scroll and drafts per thread','Enter chooses mention without sending','guest responds only in original thread','one user bubble and one work per target','mention keeps ID after rename and draft reload','two guests share one user bubble','email and tag wrapped in code stay inert','homonyms remain distinguishable','hidden dirty card blocks approval','unmounted restored draft blocks approval','work opens owner thread','guest creation opens owner thread','global search opens correct personal thread','390px mention menu without overflow'],mobileScreenshot:'bot-mentions-mobile.png'};
  writeFileSync(new URL('docs/evidence/bot-threads-browser.json',root),JSON.stringify(proof,null,2)+'\n');
  console.log(JSON.stringify(proof));
} finally {
  clearTimeout(readyTimer);socket?.close();chrome?.kill('SIGTERM');server.kill('SIGTERM');await serverExit;
}
