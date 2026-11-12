import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../dist/src/store.js';
import {loadMascots} from '../dist/src/domain.js';
import {backgroundFixture} from './lib/background-fixture.mjs';
import {minoServer} from './lib/isolated-mino.mjs';
import {browser,until,delay} from './lib/browser.mjs';
import {buildFingerprint} from './lib/build-fingerprint.mjs';

const root=new URL('../',import.meta.url);
const codeSnapshot=buildFingerprint(root);
const dir=mkdtempSync(join(tmpdir(),'mino-background-browser-'));
const profile=join(dir,'chrome');
const evidence=new URL('docs/evidence/background-browser.json',root);
const port=Number(process.env.MINO_BACKGROUND_BROWSER_PORT??4390);
const store=openStore({path:join(dir,'mino.sqlite'),mascots:loadMascots(new URL('assets/mascots.json',root))});
assert(store.dispatch({type:'bot.update',requestId:crypto.randomUUID(),botId:'nova',instructions:'REVIEWER_PRIVATE_INSTRUCTIONS_193'}).ok);store.close();
let server,b;
let phase='startup';
const checks=[];
const write=proof=>writeFileSync(evidence,JSON.stringify(proof,null,2)+'\n');
write({passed:false,phase,checkedAt:new Date().toISOString()});
const evaluate=expression=>b.evaluate(expression);
const click=selector=>b.click(`document.querySelector(${JSON.stringify(selector)})`);
const visible=selector=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return Boolean(e&&!e.hidden&&e.getClientRects().length)})()`);
const domUntil=(expression,label,timeout=12000)=>until(()=>evaluate(expression),Boolean,label,timeout);
const getTask=async id=>(await server.view()).tasks.find(t=>t.id===id);
async function open(taskId){
  await domUntil(`document.querySelector('.task-card[data-task-id="${taskId}"] .task-open')`,'carte documentaire disponible');
  if(await evaluate(`document.querySelector('#doc-panel')?.dataset.taskId===${JSON.stringify(taskId)}&&!document.querySelector('#doc-panel').hidden`))return;
  await click(`.task-card[data-task-id="${taskId}"] .task-open`);
  await domUntil(`!document.querySelector('#doc-panel').hidden&&document.querySelector('#doc-panel').dataset.taskId===${JSON.stringify(taskId)}`,'panneau du bon document');
}
async function start(text,reviewer=null){
  await b.fill('#prompt',text);await click('#doc-mode');
  if(reviewer)await evaluate(`(()=>{const s=document.querySelector('#doc-reviewer');s.value=${JSON.stringify(reviewer)};s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await click('#send');
  const view=await until(server.view,v=>v.tasks.some(t=>t.goal===text),'tâche créée');
  const t=view.tasks.find(t=>t.goal===text);await open(t.id);return t.id;
}
try{
  server=await minoServer({root,dataDir:dir,port,codexBin:backgroundFixture(dir)});
  b=await browser(profile);await b.navigate(server.base);
  await domUntil(`document.querySelector('#doc-mode')&&!document.querySelector('#prompt').disabled`,'composeur prêt');
  phase='discoverability';
  await b.fill('#prompt','Peux-tu expliquer un plan de jardin ?');
  assert(!await visible('.doc-suggestion'));
  await b.fill('#prompt','Prépare un plan pour mon jardin');
  await until(()=>visible('.doc-suggestion'),Boolean,'suggestion documentaire');
  assert.equal(await evaluate(`document.querySelector('#doc-mode').getAttribute('aria-pressed')`),'false');
  checks.push('document suggestion requires a click and does not turn questions into tasks');

  phase='draft_before_first_version';
  const solo=await start('Prépare un document BROWSER_SLOW_280 pour vérifier mon édition avant le résultat.');
  await domUntil(`document.querySelector('.doc-stream')?.textContent.length>20`,'fragments visibles',22000);
  await b.fill('.doc-editor-title','Mon titre humain');await b.fill('.doc-editor-body','HUMAN_BROWSER_INITIAL_280');
  await evaluate(`window.__minoEditor=document.querySelector('.doc-editor-body');window.__minoEditor.setSelectionRange(7,7)`);
  const before=(await getTask(solo)).progress.chars;
  await until(()=>getTask(solo),t=>t.progress?.chars>before+40,'nouveaux fragments');
  assert(await evaluate(`document.activeElement===window.__minoEditor&&document.querySelector('.doc-editor-body')===window.__minoEditor&&window.__minoEditor.selectionStart===7&&window.__minoEditor.value==='HUMAN_BROWSER_INITIAL_280'`));
  await click('.doc-close');await open(solo);
  assert(await evaluate(`document.querySelector('.doc-editor-body')===window.__minoEditor&&window.__minoEditor.value==='HUMAN_BROWSER_INITIAL_280'`));
  await b.reload();await domUntil(`document.querySelector('.task-card')`,'fil rechargé');await open(solo);
  assert.equal(await evaluate(`document.querySelector('.doc-editor-body').value`),'HUMAN_BROWSER_INITIAL_280');
  assert.equal(await evaluate(`document.querySelector('.doc-editor-title').value`),'Mon titre humain');
  await click('.doc-save');
  await until(server.view,v=>v.works.find(w=>w.id===v.tasks.find(t=>t.id===solo).authorWorkId)?.versions.at(-1)?.body==='HUMAN_BROWSER_INITIAL_280','version humaine enregistrée');
  checks.push('focus cursor and human draft survive incoming fragments','panel close and reopen retain the same editor','reload restores a draft based on an empty document');

  phase='chat_and_information';
  await evaluate(`window.__minoTrace=[];for(const type of ['click','submit','invalid'])document.addEventListener(type,e=>window.__minoTrace.push({type,target:e.target.id,disabled:e.target.disabled}),true)`);
  await b.fill('#prompt','CHAT_PING_913');await click('#send');
  await until(server.view,v=>v.messages.some(m=>m.role==='assistant'&&m.text==='CHAT_PING_OK_913'),'chat répond');
  assert((await getTask(solo)).calls.some(c=>c.state==='running'));
  const layout=await evaluate(`(()=>{const p=document.querySelector('#doc-panel').getBoundingClientRect(),c=document.querySelector('#form').getBoundingClientRect();return{panelWidth:p.width,composerWidth:c.width,separate:c.right<=p.left+2,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
  assert(layout.separate&&layout.composerWidth>200&&!layout.overflow);
  await b.fill('#doc-intent-text','PENDING_INFO_845');await click('.doc-add-info');
  await domUntil(`document.querySelector('.doc-intent[data-delivery="waiting"]')`,'précision non transmise');
  const end=await until(()=>getTask(solo),t=>t.status==='needs_decision','proposition après édition',35000);
  await domUntil(`document.querySelector('#doc-panel').dataset.status==='needs_decision'&&document.querySelector('.doc-adopt')`,'proposition affichée');
  assert(end.proposals.some(p=>p.reason==='base_moved'));
  assert.equal(await evaluate(`document.querySelector('.doc-editor-body').value`),'HUMAN_BROWSER_INITIAL_280');
  assert(await visible('.doc-adopt'));
  await b.screenshot(new URL('docs/evidence/background-desktop.png',root).pathname);
  checks.push('desktop composer stays usable alongside document','chat responds while document runs','late information is visibly waiting','late result becomes a proposal and preserves the human version');
  await click('.doc-dismiss');
  await until(()=>getTask(solo),t=>t.status==='info_waiting','proposition écartée');

  phase='relay_without_tab';
  await click('.doc-close');
  const relay=await start('Prépare un document BROWSER_SLOW_280 à relire avec Nova.','nova');
  await until(()=>getTask(relay),t=>t.progress?.body?.length>20,'rédaction relayée',22000);
  await b.close();b=null;
  await until(()=>getTask(relay),t=>t.calls.some(c=>c.step==='synthesis'&&c.state==='running'),'poursuite sans onglet',40000);
  b=await browser(profile);await b.navigate(server.base);await domUntil(`document.querySelector('.task-card')`,'réouverture');await open(relay);
  await b.fill('.doc-editor-title','Édition pendant synthèse');await b.fill('.doc-editor-body','HUMAN_BROWSER_SYNTHESIS_280');await click('.doc-save');
  const conflicted=await until(()=>getTask(relay),t=>t.status==='needs_decision','conflit pendant synthèse',35000);
  await domUntil(`document.querySelector('#doc-panel').dataset.status==='needs_decision'&&document.querySelector('.doc-adopt')`,'conflit de synthèse affiché');
  const v=await server.view();assert.equal(v.works.find(w=>w.id===conflicted.authorWorkId).versions.at(-1).body,'HUMAN_BROWSER_SYNTHESIS_280');
  assert.equal(conflicted.calls.length,3);assert(conflicted.proposals.some(p=>p.reason==='base_moved'));
  await domUntil(`document.querySelectorAll('.doc-exchange').length===2`,'transmissions inspectables');
  checks.push('closing the browser does not stop the server task','selected reviewer and synthesis run in order','editing during synthesis preserves the human version','both recorded bot handoffs are visible');
  await click('.doc-adopt');await until(()=>getTask(relay),t=>t.status==='finished','proposition adoptée');
  await domUntil(`document.querySelector('#doc-panel').dataset.status==='finished'`,'version adoptée affichée');

  phase='publication';
  await domUntil(`document.querySelector('.doc-propose')&&!document.querySelector('.doc-propose').disabled`,'publication disponible');
  await click('.doc-propose');await domUntil(`document.querySelector('.doc-approve')`,'action exacte');
  assert(await evaluate(`document.querySelector('#doc-panel').textContent.includes('Carnet')`));
  await b.fill('.doc-editor-body','HUMAN_AFTER_PROPOSAL_280');await click('.doc-save');
  await domUntil(`!document.querySelector('.doc-approve')`,'ancienne approbation périmée');
  await click('.doc-propose');await domUntil(`document.querySelector('.doc-approve')`,'nouvelle proposition');await click('.doc-approve');
  const published=await until(server.view,v=>v.carnet.some(p=>p.body==='HUMAN_AFTER_PROPOSAL_280'),'publication locale');
  const copy=published.carnet.find(p=>p.body==='HUMAN_AFTER_PROPOSAL_280');assert(copy);
  await b.fill('.doc-editor-body','HUMAN_AFTER_PUBLICATION_280');await click('.doc-save');
  await until(server.view,v=>v.works.find(w=>w.id===conflicted.authorWorkId).versions.at(-1).body==='HUMAN_AFTER_PUBLICATION_280','édition après copie');
  assert.equal((await server.view()).carnet.find(p=>p.id===copy.id).body,'HUMAN_AFTER_PROPOSAL_280');
  checks.push('an edit invalidates the exact pending publication','approved local Carnet copy stays immutable');

  phase='mobile';
  await b.rpc('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await domUntil(`getComputedStyle(document.querySelector('.doc-back')).display!=='none'`,'retour mobile');
  await b.fill('.doc-editor-body','MOBILE_UNSAVED_280');await click('.doc-back');
  assert(!await visible('#doc-panel'));await b.fill('#prompt','MOBILE_CHAT_DRAFT_280');await open(relay);
  assert.equal(await evaluate(`document.querySelector('.doc-editor-body').value`),'MOBILE_UNSAVED_280');
  assert.equal(await evaluate(`document.querySelector('#prompt').value`),'MOBILE_CHAT_DRAFT_280');
  assert.equal(await evaluate(`document.documentElement.scrollWidth>innerWidth`),false);
  assert.equal(await evaluate(`document.querySelector('.doc-validate')?.disabled`),true);
  await b.screenshot(new URL('docs/evidence/background-mobile.png',root).pathname);
  checks.push('mobile switches between document and chat without losing either draft','unsaved edits block validation');
  const proof={passed:true,checkedAt:new Date().toISOString(),codeSnapshot,fixture:'Isolated headless Chrome, temporary SQLite, controlled App Server. No actual model call.',checks,layout,screenshots:['background-desktop.png','background-mobile.png'],note:'Fixtures deliberately control timing to exercise interactions. Real model behavior is verified separately.'};
  write(proof);console.log(JSON.stringify(proof));
}catch(error){
  let observed=null;
  if(b){await b.screenshot(new URL('docs/evidence/background-browser-failure.png',root).pathname).catch(()=>{});observed=await evaluate(`(()=>{const s=document.querySelector('#send'),r=s?.getBoundingClientRect();return{prompt:document.querySelector('#prompt')?.value,sendDisabled:s?.disabled,valid:document.querySelector('#form')?.checkValidity(),trace:window.__minoTrace,point:r?{x:r.x+r.width/2,y:r.y+r.height/2}:null,hit:r?document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,300):null,toast:document.querySelector('#toast')?.textContent}})()`).catch(()=>null);}
  write({passed:false,checkedAt:new Date().toISOString(),phase,observed,note:'Parcours navigateur incomplet.'});throw error;
}
finally{if(b)await b.close();if(server)await server.stop();}
