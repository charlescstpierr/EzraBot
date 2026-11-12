import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { openStore } from '../dist/src/store.js';
import { loadMascots } from '../dist/src/domain.js';

const root = new URL('../', import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'mino-delete-browser-'));
const profile = join(dir, 'chrome');
const port = Number(process.env.MINO_DELETE_PORT ?? 4397);
const base = `http://127.0.0.1:${port}`;
writeFileSync(new URL('docs/evidence/bot-deletion-browser.json',root),JSON.stringify({checkedAt:new Date().toISOString(),passed:false,note:'Parcours contrôlé en cours; aucune réussite actuelle.'},null,2)+'\n');
const store = openStore({path:join(dir,'mino.sqlite'),mascots:loadMascots(new URL('assets/mascots.json',root))});
let seedCount=0;
function seed(botId,text,reply,deliverable=null,mentions=[],attachments=[]) {
  const sent=store.dispatch({type:'message.send',requestId:'thread-seed-'+(++seedCount),botId,text,attachments,...(mentions.length?{mentions}:{})});
  assert(sent.ok,sent.message);const claim=store.claimNextJob();assert(claim);
  store.finishJob(claim,{kind:'succeeded',reply:{reply,deliverable},used:{model:'controlled-fixture',effort:'low',speed:'standard'},threadId:'seed-thread-'+seedCount,turnId:'seed-turn-'+seedCount});
  return sent.result.workId;
}
const minoWork=seed('mino','KEEP_OWNER_REQUEST','KEEP_OWNER_REPLY');
const ownWork=seed('nova','PRIVATE_REQUEST','PRIVATE_REPLY',{title:'PRIVATE_TITLE',body:'PRIVATE_BODY'},[],[{name:'private.txt',text:'PRIVATE_FILE'}]);
seed('nova','@Pixel PRIVATE_GUEST_REQUEST','PRIVATE_GUEST_REPLY',null,[{botId:'pixel',start:0,end:6}]);
const guestWork=seed('mino','@Nova KEEP_SHARED_REQUEST','KEEP_SHARED_REPLY',{title:'KEEP_SHARED_TITLE',body:'KEEP_SHARED_BODY'},[{botId:'nova',start:0,end:5}]);
function command(input){const r=store.dispatch({...input,requestId:crypto.randomUUID()});assert(r.ok,r.message);return r.result;}
command({type:'memory.create',botId:'nova',text:'PRIVATE_MEMORY'});
function publish(workId){const v=store.view().works.find(w=>w.id===workId).versions.at(-1);const p=command({type:'publication.propose',workId,versionId:v.id,destination:'carnet'});command({type:'publication.approve',proposalId:p.proposalId,versionId:v.id,destination:'carnet',action:'publish',payloadSha256:p.payloadSha256});}
publish(ownWork);publish(guestWork);
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
let restarted;
let restartedExit;
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
  await until(visible,t=>t.includes('KEEP_OWNER_REPLY'),'fil initial');
  await fill('#prompt','');await chooseMention('Nova');await rpc('Input.insertText',{text:'MENTION_KEPT_DRAFT'});
  await setBot('nova');await fill('#prompt','PRIVATE_OWN_DRAFT');
  const before=await view();
  await evaluate(`localStorage.setItem('mino.draft.v2|'+encodeURIComponent(${JSON.stringify(before.spaceId)})+'|other-writer-123|prompt:nova',JSON.stringify({nonce:'other',savedAt:1,content:{text:'PRIVATE_OTHER_WRITER',files:[]}}))`);
  async function openDelete(){
    await click(`document.querySelector('.wheel-bot[aria-pressed="true"]')`);
    await until(()=>evaluate(`Boolean(document.querySelector('#character-more'))`),Boolean,'fiche du bot');
    await click(`document.querySelector('#character-more')`);
    await click(`document.querySelector('[data-play-action="3"]')`);
    await until(()=>evaluate(`Boolean(document.querySelector('#delete-confirm'))`),Boolean,'confirmation');
  }
  await openDelete();
  const confirmation=await evaluate(`document.querySelector('#play-dialog').innerText`);
  for(const text of ['Nova','Effacé','Conservé ailleurs','Bot supprimé','sauvegarde','service','1 fichier joint'])assert(confirmation.includes(text));
  assert(await evaluate(`document.querySelector('#delete-go').disabled`));
  await fill('#delete-confirm','AUTRE NOM');assert(await evaluate(`document.querySelector('#delete-go').disabled`));
  await click(`document.querySelector('#delete-cancel')`);
  assert.deepEqual((await view()).bots,before.bots,'annuler ne supprime rien');
  await click(`document.querySelector('#character-more')`);await click(`document.querySelector('[data-play-action="3"]')`);
  assert((await post({type:'memory.create',botId:'nova',text:'PRIVATE_NEW_MEMORY'})).ok);
  await fill('#delete-confirm','Nova');await click(`document.querySelector('#delete-go')`);
  await until(()=>evaluate(`document.querySelector('#delete-status')?.textContent??''`),t=>t.length>0&&!t.includes('en cours'),'périmètre périmé annoncé');
  assert((await view()).bots.some(b=>b.id==='nova'),'un périmètre changé refuse la suppression');
  await rpc('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
  const screen=await rpc('Page.captureScreenshot',{format:'png'});writeFileSync(new URL('docs/evidence/bot-deletion-confirmation.png',root),Buffer.from(screen.data,'base64'));
  await fill('#delete-confirm','Nova');await click(`document.querySelector('#delete-go')`);
  const deleted=await until(view,v=>!v.bots.some(b=>b.id==='nova'),'suppression terminée');
  assert.equal(deleted.erasure,'complete');
  assert(!existsSync(join(dir,'mino.sqlite.pre-v2')),'sauvegarde gérée retirée');
  assert(!JSON.stringify(deleted).includes('PRIVATE_'));
  assert(deleted.messages.some(m=>m.workId===guestWork&&m.text==='KEEP_SHARED_REPLY'));
  assert(deleted.works.some(w=>w.id===guestWork&&w.versions.at(-1).body==='KEEP_SHARED_BODY'));
  assert(deleted.carnet.some(p=>p.workId===guestWork));
  await until(visible,t=>t.includes('KEEP_SHARED_REPLY'),'contribution partagée conservée');
  assert((await visible()).includes('Bot supprimé'));
  assert((await prompt()).includes('@Nova'));
  await until(()=>evaluate(`document.querySelector('#send').disabled`),Boolean,'mention disparue bloque l’envoi');
  assert((await evaluate(`document.querySelector('.mention-recipients').textContent`)).includes('supprimé'));
  assert(!(await evaluate(`Object.values(localStorage).join('')`)).includes('PRIVATE_'));
  await click(`[...document.querySelectorAll('.mention-recipients button')].find(b=>b.textContent==='Retirer la mention')`);
  assert((await prompt()).includes('@Nova'),'le retrait explicite conserve le texte');
  assert.equal(await evaluate(`document.querySelector('#send').disabled`),false);
  await rpc('Page.reload',{ignoreCache:true});
  await until(visible,t=>t.includes('KEEP_SHARED_REPLY'),'rechargement');
  assert(!(await evaluate(`Object.values(localStorage).join('')`)).includes('PRIVATE_'));
  for(const id of ['mino','pixel']){const v=await view();const bot=v.bots.find(b=>b.id===id);const r=await post({type:'bot.delete',botId:id,confirmName:bot.name,expected:bot.deletion});assert(r.ok);assert(r.result.erased);}
  await until(()=>evaluate(`document.querySelector('.wheel-bot[aria-pressed="true"]')?.dataset.botId`),id=>id==='atlas','dernier bot');
  await openDelete();await fill('#delete-confirm','Atlas');await click(`document.querySelector('#delete-go')`);
  await until(view,v=>v.bots.length===0,'dernier bot effacé');
  await until(()=>evaluate(`document.querySelector('#empty-bots').hidden`),v=>v===false,'état vide');
  assert(await evaluate(`document.querySelector('#prompt').disabled`));
  server.kill('SIGTERM');await serverExit;
  restarted=spawn(process.execPath,['dist/src/main.js'],{cwd:root,env:{...process.env,MINO_DATA_DIR:dir,MINO_PORT:String(port),MINO_CODEX_BIN:cli},stdio:['ignore','ignore','ignore']});
  restartedExit=new Promise(resolve=>restarted.once('exit',resolve));
  const restored=await until(async()=>{try{return await view()}catch{return null}},v=>v?.bots?.length===0,'redémarrage vide');
  assert.equal(restored.activeBotId,'');
  await click(`document.querySelector('#empty-create')`);await fill('#new-bot-name','Reborn');await click(`document.querySelector('#new-bot-form button[type="submit"]')`);
  const created=await until(view,v=>v.bots.length===1&&v.bots[0].name==='Reborn','nouveau bot après état vide');
  assert(!['mino','nova','pixel','atlas'].includes(created.bots[0].id));
  const proof={passed:true,checkedAt:new Date().toISOString(),fixture:'Temporary SQLite, controlled App Server, no actual model call.',checks:['confirmation names exact bot and scope','wrong name disabled','cancel preserves bot','changed counts refused and refreshed','390px confirmation without page overflow','private thread, memories, own versions and Carnet removed','guest contributions kept anonymously in original thread','all scoped writer drafts purged','dead mention blocks until explicit removal','reload keeps erasure','last bot deletion produces empty disabled composer','restart never reseeds','new bot creation after empty state'],confirmationScreenshot:'bot-deletion-confirmation.png'};
  writeFileSync(new URL('docs/evidence/bot-deletion-browser.json',root),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));

} finally {
  clearTimeout(readyTimer);socket?.close();chrome?.kill('SIGTERM');server.kill('SIGTERM');await serverExit;if(restarted){restarted.kill('SIGTERM');await restartedExit;}
}
