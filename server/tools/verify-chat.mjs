import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { openStore } from '../dist/src/store.js';
import { loadMascots } from '../dist/src/domain.js';

const root = new URL('../', import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'mino-editor-'));
const profile = join(dir, 'chrome');
const port = Number(process.env.MINO_CHAT_PORT ?? 4399);
const base = `http://127.0.0.1:${port}`;
const store = openStore({ path: join(dir, 'mino.sqlite'), mascots: loadMascots(new URL('assets/mascots.json', root)) });
const accepted = store.dispatch({ type: 'message.send', requestId: 'editor-fixture-seed', botId: 'mino', text: 'Texte de test', attachments: [] });
assert(accepted.ok);
const claim = store.claimNextJob();
assert(claim);
store.finishJob(claim, { kind: 'succeeded', reply: { reply: '## Exemple\n\n```js\nconst x = 1;\n```\n\n<script>window.__unsafe=true</script>\n\n![image](https://example.com/never-load.png)\n\n[x](javascript:alert(1))', deliverable: { title: 'Titre initial', body: 'Corps initial' } }, used: { model: 'test-fixture', effort: 'low', speed: 'standard' }, threadId: 'test-fixture', turnId: 'test-fixture' });
for (let i = 0; i < 14; i++) {
  const sent = store.dispatch({ type: 'message.send', requestId: 'chat-row-' + i, botId: 'mino', text: 'Question ' + i, attachments: [] });
  assert(sent.ok);
  const next = store.claimNextJob();
  assert(next);
  store.finishJob(next, { kind: 'succeeded', reply: { reply: ('Paragraphe de test. ').repeat(60), deliverable: null }, used: { model: 'test-fixture', effort: 'low', speed: 'standard' }, threadId: 'fixture-' + i, turnId: 'fixture-' + i });
}
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
const cli = join(dir, 'codex-fixture.mjs');
let fake = readFileSync(new URL('dist/test/fixtures/fake-app-server.js', root), 'utf8');
assert(fake.includes("const scenario = process.argv[2] ?? 'reply';"));
fake = fake.replace("const scenario = process.argv[2] ?? 'reply';", "const scenario = 'slow';").replace('const args = process.argv.slice(3);', 'const args = process.argv.slice(2);');
assert(fake.includes("case 'slow':"));
fake = fake.replace("case 'slow':", "case 'slow': notify('item/started', {threadId, turnId, item:{type:'reasoning',id:'r'}}); setTimeout(()=>notify('item/started', {threadId,turnId,item:{type:'agentMessage',id:'a',text:''}}), 600);");
writeFileSync(cli, '#!' + process.execPath + '\n' + fake);
chmodSync(cli, 0o700);
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
    const rect = await evaluate(`(()=>{const e=${expression};if(!e)throw Error('Bouton absent');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', ...rect, button: 'left', buttons: 1, clickCount: 1 });
    await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rect, button: 'left', buttons: 0, clickCount: 1 });
  }
  const view = async () => (await (await fetch(base + '/api/view?after=-1')).json());
  const work = async () => (await view()).works[0];
  await rpc('Page.enable');
  await rpc('Runtime.enable');
  await rpc('Page.navigate', { url: base });
  await until(() => evaluate(`Boolean(document.querySelector('.draft-editor'))`), Boolean, 'carte');

  assert.equal(await evaluate(`Boolean(document.querySelector('.md script,.md img'))`), false);
  assert.equal(await evaluate(`Boolean(window.__unsafe)`), false);
  assert.equal(await evaluate(`[...document.querySelectorAll('.md a')].some(a=>/^(javascript|data|file):/.test(a.href))`), false);
  assert.equal(await evaluate(`document.querySelector('.code-block code').textContent`), 'const x = 1;\n');
  assert((await evaluate(`document.querySelector('.code-block pre').getBoundingClientRect().height`)) < 130);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.wheel-bot[aria-pressed="true"]')).borderWidth`), '0px');
  await until(()=>evaluate(`(()=>{const r=document.querySelector('.wheel-bot[aria-pressed="true"]').getBoundingClientRect();return Math.abs(r.x+r.width/2-innerWidth/2)<1&&r.width>75&&r.width<95})()`),Boolean,'mascotte centrée à sa taille finale');
  const mascotRect=await evaluate(`(()=>{const r=document.querySelector('.wheel-bot[aria-pressed="true"]').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await rpc('Input.dispatchMouseEvent',{type:'mousePressed',...mascotRect,button:'left',buttons:1,clickCount:1});
  await until(()=>evaluate(`document.querySelector('#bot-fan').classList.contains('is-open')`),Boolean,'demi-lune après maintien');
  await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',...mascotRect,button:'left',buttons:0,clickCount:1});
  await evaluate(`document.querySelector('#bot-wheel').focus()`);
  await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight'});
  await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight'});
  await until(()=>evaluate(`document.querySelector('#prompt').placeholder`),s=>!s.includes('Mino'),'autre bot au clavier');
  await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowLeft',code:'ArrowLeft'});
  await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowLeft',code:'ArrowLeft'});
  await until(()=>evaluate(`document.querySelector('#prompt').placeholder`),s=>s.includes('Mino'),'retour au bot initial');
  await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});
  await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'});
  await until(()=>evaluate(`document.querySelector('#bot-fan').classList.contains('is-open')`),s=>s===false,'demi-lune fermée');
  await until(()=>evaluate(`document.querySelector('.wheel-bot[aria-pressed="true"]').getBoundingClientRect().width`),w=>w>75&&w<95,'mascotte au repos');
  await delay(400); // Let the hold gesture's accidental-click protection expire.
  await click(`document.querySelector('.wheel-bot[aria-pressed="true"]')`);
  await until(()=>evaluate(`document.querySelector('#play-dialog').open`),Boolean,'personnalisation par tap');
  assert.equal(await evaluate(`document.querySelectorAll('.shape-choice').length`),18);
  await click(`document.querySelector('#character-back')`);
  await click(`document.querySelector('#more')`);
  await until(()=>evaluate(`document.querySelectorAll('[data-play-action]').length`),n=>n===5,'menu complet dans l’en-tête');
  await click(`document.querySelector('[data-play-action="0"]')`);
  await until(()=>evaluate(`Boolean(document.querySelector('#search-input'))`),Boolean,'recherche depuis le menu');
  await fill('#search-input','exemple');
  await until(()=>evaluate(`document.querySelectorAll('.search-hit-row').length`),n=>n>0,'résultat de recherche');
  await click(`document.querySelector('.search-hit-row')`);
  await until(()=>evaluate(`document.querySelector('#play-dialog').open`),s=>s===false,'retour au fil');
  await click(`document.querySelector('#more')`);
  await click(`document.querySelector('[data-play-action="2"]')`);
  await until(()=>evaluate(`document.querySelector('#creations-drawer').open`),Boolean,'créations depuis le menu');
  await click(`document.querySelector('#creations-close')`);


  assert.equal(await evaluate(`document.querySelectorAll('.project-icon').length`), 0);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.assistant-message > .md')).backgroundColor`), 'rgba(0, 0, 0, 0)');
  assert.equal(await evaluate(`document.querySelector('.message-details').open`), false);
  await click(`document.querySelector('.message-details summary')`);
  assert.equal(await evaluate(`document.querySelector('.message-details').open`), true);
  assert((await evaluate(`document.querySelector('.message-details .ai-resolved').textContent`)).includes('test-fixture'));
  await click(`document.querySelector('.message-details summary')`);
  await rpc('Browser.grantPermissions', {origin:base,permissions:['clipboardReadWrite','clipboardSanitizedWrite']});
  await click(`document.querySelector('.message-copy')`);
  await until(()=>evaluate(`document.querySelector('#toast').textContent`),s=>s==='Copié','réponse copiée');
  assert.equal(await evaluate(`navigator.clipboard.readText()`),(await view()).messages.find(m=>m.role==='assistant').text);
  await evaluate(`document.querySelector('#messages').scrollTop=0`);
  const desktop=await rpc('Page.captureScreenshot',{format:'png'});
  writeFileSync(new URL('docs/evidence/chat-desktop.png',root),Buffer.from(desktop.data,'base64'));


  await fill('#prompt', Array.from({length:25},(_,i)=>'Ligne ' + i).join('\n'));
  const grown = await evaluate(`document.querySelector('#prompt').getBoundingClientRect().height`);
  assert(grown > 60 && grown <= 221);
  await fill('#prompt', 'ENVOI INITIAL');
  let paused = null;
  socket.addEventListener('message', event => {
    const value = JSON.parse(event.data);
    if (value.method === 'Fetch.requestPaused') paused = value.params.requestId;
  });
  await rpc('Fetch.enable', { patterns: [{urlPattern:'*/api/commands',requestStage:'Response'}] });
  await click(`document.getElementById('send')`);
  await until(async()=>paused,Boolean,'acquittement suspendu');
  await fill('#prompt', 'ENVOI INITIAL et la suite  ');
  await rpc('Fetch.continueResponse', {requestId:paused});
  await rpc('Fetch.disable');
  await until(()=>evaluate(`document.querySelector('#send').getAttribute('aria-label')`),s=>s==='Envoyer','envoi acquitté');
  assert.equal(await evaluate(`document.getElementById('prompt').value`), 'ENVOI INITIAL et la suite  ');
  await until(()=>evaluate(`document.querySelector('.run-status')?.dataset.presence`),s=>s==='writing','rédaction annoncée');
  const animation = await evaluate(`getComputedStyle(document.querySelector('.wheel-bot[aria-pressed="true"] svg')).animationName`);
  assert.equal(animation,'mino-write');
  await rpc('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await until(()=>evaluate(`getComputedStyle(document.querySelector('.wheel-bot[aria-pressed="true"] svg')).animationName`),s=>s==='none','mouvement réduit');
  await click(`[...document.querySelectorAll('.run-actions button')].find(b=>b.textContent==='Arrêter')`);
  await until(()=>evaluate(`document.querySelector('.run-status')?.textContent`),s=>s?.includes('Annulé'),'annulation visible');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.wheel-bot[aria-pressed="true"] svg')).animationName`),'none');

  paused = null;
  await rpc('Fetch.enable', { patterns: [{urlPattern:'*/api/commands',requestStage:'Request'}] });
  await click(`document.getElementById('send')`);
  await until(async()=>paused,Boolean,'envoi refusé suspendu');
  await rpc('Fetch.fulfillRequest', {requestId:paused,responseCode:413,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify({ok:false,message:'Refus de test'})).toString('base64')});
  await rpc('Fetch.disable');
  await until(()=>evaluate(`document.querySelector('#send').getAttribute('aria-label')`),s=>s==='Envoyer','refus affiché');
  await evaluate(`document.querySelector('#messages').scrollTop=500`);
  const before = await evaluate(`document.querySelector('#messages').scrollTop`);
  const html=await(await fetch(base)).text();
  const csrf=/name="mino-csrf" content="([a-f0-9]+)"/.exec(html)[1];
  await fetch(base+'/api/commands',{method:'POST',headers:{origin:base,'content-type':'application/json','x-mino-csrf':csrf},body:JSON.stringify({type:'bot.update',requestId:'chat-rename-check',botId:'mino',name:'Mino Test'})});
  await until(()=>evaluate(`document.querySelector('#prompt').placeholder`),s=>s.includes('Mino Test'),'vue mise à jour');
  assert.equal(await evaluate(`document.querySelector('#messages').scrollTop`),before);
  assert.equal(await evaluate(`document.querySelectorAll('.msg-enter').length`),0);
  await rpc('Page.reload',{ignoreCache:true});
  await until(()=>evaluate(`document.querySelector('#prompt')?.value`),s=>s==='ENVOI INITIAL et la suite  ','brouillon après reload');
  await rpc('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
  await until(()=>evaluate('innerWidth'),w=>w===390,'viewport mobile');
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
  const bottom=await evaluate(`document.querySelector('.composer').getBoundingClientRect().bottom`);
  assert(bottom <= 844 && bottom >= 810, 'composeur près du bord inférieur et entièrement visible');
  const screenshot=await rpc('Page.captureScreenshot',{format:'png'});
  writeFileSync(new URL('docs/evidence/chat-mobile.png',root),Buffer.from(screenshot.data,'base64'));
  const proof={checkedAt:new Date().toISOString(),browser:'Independent Chrome CDP after T3 click timeouts',fixture:'Controlled App Server and temporary SQLite. No model call.',checks:['safe Markdown and no remote image','code block fits its content','single centered header mascot with no ring','hold opens picker and arrows switch bots','tap opens profile with all18 characters','header menu keeps search and creations accessible','unboxed assistant replies','model attribution available under Details','copy whole response preserves raw text','composer grows up to220px','text typed while acknowledgement is paused stays whole','writing animation follows reported state','reduced-motion emulated disables the animation','cancel stops the animation','scroll position survives updates even after a refused send','old messages do not animate on update','draft survives reload','390px without horizontal overflow and composer above safe bottom margin'],animationObserved:animation,composerGrown:grown,scrollBefore:before,scrollAfter:before,mobile:{width:390,height:844,composerBottom:bottom},screenshot:'chat-mobile.png'};
  writeFileSync(new URL('docs/evidence/chat-browser.json',root),JSON.stringify(proof,null,2)+'\n');
  console.log(JSON.stringify(proof));
} finally {
  clearTimeout(readyTimer);
  socket?.close();
  chrome?.kill('SIGTERM');
  server.kill('SIGTERM');
  await serverExit;
}
