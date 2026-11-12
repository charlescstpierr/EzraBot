import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {htmlDocument} from '../dist/src/html-artifact.js';

assert(!process.env.MINO_CODEX_BIN,'La preuve réelle exige le Codex officiel.');
const root=new URL('../',import.meta.url);
const dir=mkdtempSync(join(tmpdir(),'mino-html-real-'));
const port=Number(process.env.MINO_HTML_REAL_PORT??4396);
const base=`http://127.0.0.1:${port}`;
const out=new URL('docs/evidence/html-real.json',root);
writeFileSync(out,JSON.stringify({passed:false,checkedAt:new Date().toISOString(),phase:'starting'},null,2)+'\n');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,predicate,timeout=180000){const end=Date.now()+timeout;while(Date.now()<end){const v=await read();if(predicate(v))return v;await delay(100)}throw Error('Délai de vérification dépassé')}
const view=async()=>(await(await fetch(base+'/api/view?after=-1')).json());
async function start(){
  const child=spawn(process.execPath,['dist/src/main.js'],{cwd:root,env:{...process.env,MINO_DATA_DIR:dir,MINO_PORT:String(port)},stdio:['ignore','pipe','pipe']});
  child.stderr.resume();const exited=new Promise(resolve=>{child.once('exit',resolve);child.once('error',resolve)});
  try{
    await new Promise((resolve,reject)=>{
      const lines=createInterface({input:child.stdout});
      const timer=setTimeout(()=>{lines.close();reject(Error('Serveur indisponible'))},10000);
      lines.on('line',line=>{try{if(JSON.parse(line).event==='ready'){clearTimeout(timer);lines.close();resolve()}}catch{clearTimeout(timer);lines.close();reject(Error('Journal invalide'))}});
      child.once('error',()=>{clearTimeout(timer);lines.close();reject(Error('Démarrage impossible'))});
      child.once('exit',()=>{clearTimeout(timer);lines.close();reject(Error('Arrêt avant disponibilité'))});
    });
  }catch(error){if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;throw error;}
  return {stop:async()=>{child.kill('SIGTERM');await exited}};
}
let server;
let phase='startup';
try{
  server=await start();
  const page=await(await fetch(base)).text();
  const csrf=/name="mino-csrf" content="([a-f0-9]+)"/.exec(page)?.[1];assert(csrf);
  phase='one_actual_model_call';
  const response=await fetch(base+'/api/commands',{method:'POST',headers:{origin:base,'content-type':'application/json','x-mino-csrf':csrf},body:JSON.stringify({type:'message.send',requestId:crypto.randomUUID(),botId:'mino',text:'Crée une petite page HTML autonome en français avec un compteur qui commence à 0 et augmente au clic sur Ajouter. Compteur id="count", bouton id="increment". CSS et JavaScript intégrés, aucune ressource externe. Le fichier doit fonctionner directement. Titre du livrable : Compteur.',attachments:[]})});
  const accepted=await response.json();assert(accepted.ok);
  const id=accepted.result.workId;
  const done=await until(view,v=>['review','done','failed','cancelled'].includes(v.works.find(w=>w.id===id)?.state));
  const work=done.works.find(w=>w.id===id);assert.equal(work.state,'review','Une vraie version HTML doit être produite');
  const version=work.versions.at(-1);assert(version);
  const html=htmlDocument(version.body);assert(html);
  const message=done.messages.find(m=>m.role==='assistant'&&m.workId===id);assert(message?.stamp);
  phase='preview_and_download';
  const preview=await fetch(base+'/api/versions/'+version.id+'/preview',{headers:{'sec-fetch-dest':'iframe'}});assert.equal(preview.status,200);assert.equal(await preview.text(),html);
  const download=await fetch(base+'/api/versions/'+version.id+'/download');assert.equal(await download.text(),html);assert(download.headers.get('content-disposition').includes('.html'));
  await server.stop();server=null;
  phase='restart';
  server=await start();const restored=await view();
  assert.deepEqual(restored.works.find(w=>w.id===id).versions,work.versions);
  assert.deepEqual(restored.messages.find(m=>m.id===message.id),message);
  assert.equal(await(await fetch(base+'/api/versions/'+version.id+'/preview',{headers:{'sec-fetch-dest':'iframe'}})).text(),html);
  await server.stop();server=null;
  writeFileSync(new URL('docs/evidence/html-generated.html',root),html);
  const evidence={passed:true,checkedAt:new Date().toISOString(),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),engine:'Official Codex App Server, one actual model call, temporary SQLite.',stamp:message.stamp,versionId:version.id,htmlSha256:createHash('sha256').update(html).digest('hex'),artifact:'html-generated.html',checks:['real HTML deliverable created','saved version preview serves exact HTML','download is an HTML file','version and message persist after server restart','same HTML preview after restart'],usage:restored.works.find(w=>w.id===id).attempt?.usage??null,note:'Synthetic request only. No third-party message. Browser interaction with this exact artifact is checked separately.'};
  writeFileSync(out,JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));
}catch{writeFileSync(out,JSON.stringify({passed:false,checkedAt:new Date().toISOString(),phase,note:'Échec visible, aucun résultat de remplacement.'},null,2)+'\n');throw Error('La preuve HTML réelle a échoué. Voir html-real.json.');}
finally{if(server)await server.stop()}
