import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { openStore } from '../dist/src/store.js';
import { loadMascots } from '../dist/src/domain.js';

const root = new URL('../', import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'mino-editor-'));
const profile = join(dir, 'chrome');
const port = Number(process.env.MINO_EDITOR_PORT ?? 4393);
const base = `http://127.0.0.1:${port}`;
const store = openStore({ path: join(dir, 'mino.sqlite'), mascots: loadMascots(new URL('assets/mascots.json', root)) });
const accepted = store.dispatch({ type: 'message.send', requestId: 'editor-fixture-seed', botId: 'mino', text: 'Texte de test', attachments: [] });
assert(accepted.ok);
const claim = store.claimNextJob();
assert(claim);
store.finishJob(claim, { kind: 'succeeded', reply: { reply: 'Résultat contrôlé du test.', deliverable: { title: 'Titre initial', body: 'Corps initial' } }, used: { model: 'test-fixture', effort: 'low', speed: 'standard' }, threadId: 'test-fixture', turnId: 'test-fixture' });
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
const server = spawn(process.execPath, ['dist/src/main.js'], { cwd: root, env: { ...process.env, MINO_DATA_DIR: dir, MINO_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  await fill('.card-title-input', 'Titre modifié');
  await fill('.draft-editor', 'Corps modifié');
  await evaluate(`document.getElementById('prompt').focus()`);
  const successive = await until(work, w => w.versions.at(-1).title === 'Titre modifié' && w.versions.at(-1).body === 'Corps modifié', 'éditions successives');
  await fill('.draft-editor', 'BROUILLON LOCAL À CONSERVER');
  const latest = successive.versions.at(-1);
  const html = await (await fetch(base)).text();
  const csrf = /name="mino-csrf" content="([0-9a-f]+)"/.exec(html)?.[1];
  assert(csrf);
  const external = await (await fetch(base + '/api/commands', { method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'x-mino-csrf': csrf }, body: JSON.stringify({ type: 'version.edit', requestId: crypto.randomUUID(), workId: successive.id, baseVersionId: latest.id, title: 'Titre externe', body: 'CORPS EXTERNE' }) })).json();
  assert(external.ok);
  await click(`document.getElementById('work-toggle')`);
  await until(() => evaluate(`document.querySelector('.natural-card').textContent.includes('Votre saisie n’est pas enregistrée')`), Boolean, 'conflit préservé');
  const drawerAccept = `[...document.querySelectorAll('#work-list button')].find(e=>e.textContent==='Valider')`;
  await click(drawerAccept);
  await until(() => evaluate(`document.getElementById('toast').textContent`), text => text.includes('Enregistrez vos modifications'), 'validation bloquée');
  const blocked = await work();
  assert.equal(blocked.state, 'review');
  assert.equal(blocked.versions.at(-1).body, 'CORPS EXTERNE');
  assert.equal(await evaluate(`document.querySelector('.draft-editor').value`), 'BROUILLON LOCAL À CONSERVER');
  await click(`document.getElementById('work-drawer-close')`);
  await fill('#prompt', 'BROUILLON DE MESSAGE  ');
  await rpc('Page.reload', { ignoreCache: true });
  await until(() => evaluate(`document.querySelector('.draft-editor')?.value === 'BROUILLON LOCAL À CONSERVER'`), Boolean, 'brouillon du livrable après rechargement');
  await until(() => evaluate(`document.querySelector('.natural-card').textContent.includes('partait de la version')`), Boolean, 'conflit annoncé après rechargement');
  assert.equal(await evaluate(`document.getElementById('prompt').value`), 'BROUILLON DE MESSAGE  ');
  await click(`document.getElementById('work-toggle')`);
  await click(drawerAccept);
  await until(() => evaluate(`document.getElementById('toast').textContent`), text => text.includes('Enregistrez vos modifications'), 'validation bloquée après rechargement');
  assert.equal((await work()).state, 'review');
  await click(`document.getElementById('work-drawer-close')`);
  await click(`[...document.querySelectorAll('.card-note button')].find(e=>e.textContent==='Enregistrer ma saisie en nouvelle version')`);
  await until(work, w => w.versions.at(-1).body === 'BROUILLON LOCAL À CONSERVER', 'résolution');
  await until(() => evaluate(`document.querySelector('[data-work-id]')?.dataset.keepDraft === 'false'`), Boolean, 'résolution confirmée dans l’interface');
  await click(`document.getElementById('work-toggle')`);
  await click(drawerAccept);
  const completed = await until(work, w => w.state === 'done', 'validation après résolution');
  const result = { checkedAt: new Date().toISOString(), browser: 'Independent headless Chrome via CDP', fixture: 'Controlled result seeded in temporary SQLite; no model call', successiveVersion: successive.versions.at(-1).n, blockedState: blocked.state, retainedDraft: true, completedState: completed.state, finalVersion: completed.versions.at(-1).n, checks: ['successive title and body persisted', 'drawer validation refused during conflict', 'unsaved draft preserved', 'deliverable and message drafts survive a reload with the conflict announced', 'drawer validation still refused after reload', 'explicit resolution then drawer validation succeeds'] };
  writeFileSync(new URL('docs/evidence/browser-drawer-guard.json', root), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  clearTimeout(readyTimer);
  socket?.close();
  chrome?.kill('SIGTERM');
  server.kill('SIGTERM');
  await serverExit;
}
