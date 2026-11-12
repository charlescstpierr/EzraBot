import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,cpSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createInterface} from 'node:readline';
import {openStore} from '../dist/src/store.js';
import {loadMascots} from '../dist/src/domain.js';

assert(!process.env.MINO_CODEX_BIN,'Cette preuve exige le vrai Codex sur PATH, sans exécutable de test.');
const root=new URL('../',import.meta.url);
const port=Number(process.env.MINO_MENTION_REAL_PORT??4396);
const base=`http://127.0.0.1:${port}`;
const dir=mkdtempSync(join(tmpdir(),'mino-real-mention-'));
const path=join(dir,'mino.sqlite');
const out=new URL('docs/evidence/bot-mention-real.json',root);
writeFileSync(out,JSON.stringify({checkedAt:new Date().toISOString(),passed:false,note:'Vérification en cours, aucune réussite actuelle.'},null,2)+'\n');
const mascots=loadMascots(new URL('assets/mascots.json',root));
let store=openStore({path,mascots});
let sequence=0;
function command(input){const value=store.dispatch({...input,requestId:'real-fixture-'+(++sequence)});assert(value.ok,value.message);return value.result;}
function seed(botId,text,answer){
  command({type:'message.send',botId,text,attachments:[]});const claim=store.claimNextJob();assert(claim);
  store.finishJob(claim,{kind:'succeeded',reply:{reply:answer,deliverable:null},used:{model:'controlled-seed',effort:'low',speed:'standard'},threadId:'seed-'+sequence,turnId:'seed-'+sequence});
}
command({type:'memory.create',botId:'mino',text:'MINO_MEMORY_NOT_FOR_NOVA_927'});
command({type:'memory.create',botId:'nova',text:'NOVA_OWN_MEMORY_146'});
command({type:'bot.update',botId:'mino',instructions:'MINO_INSTRUCTIONS_NOT_FOR_NOVA_538'});
command({type:'bot.update',botId:'nova',instructions:'NOVA_OWN_INSTRUCTIONS_260'});
seed('mino','Le code partagé dans ce fil est CEDRE-481.','Je retiens CEDRE-481 pour cette conversation.');
seed('nova','Dans ce fil personnel séparé, le code est PAVOT-773.','NOVA_OTHER_THREAD_773');
const result=command({type:'message.send',botId:'mino',text:'@Nova Quel est le code partagé dans ce fil ? Réponds uniquement avec ce code.',mentions:[{botId:'nova',start:0,end:5}],attachments:[]});
assert.equal(result.kind,'message');const workId=result.workId;store.close();

// Probe an identical closed database copy before making the one paid model call.
const probePath=join(mkdtempSync(join(tmpdir(),'mino-mention-context-')),'mino.sqlite');cpSync(path,probePath);
const probe=openStore({path:probePath,mascots});const planned=probe.claimNextJob();assert(planned);assert.equal(planned.botId,'nova');
const input=planned.turn.baseInstructions+'\n'+planned.turn.input;
assert(input.includes('CEDRE-481'));assert(input.includes('NOVA_OWN_MEMORY_146'));assert(input.includes('NOVA_OWN_INSTRUCTIONS_260'));
for(const forbidden of ['MINO_MEMORY_NOT_FOR_NOVA_927','MINO_INSTRUCTIONS_NOT_FOR_NOVA_538','PAVOT-773','NOVA_OTHER_THREAD_773'])assert(!input.includes(forbidden));
probe.close();const probeDb=new DatabaseSync(probePath);const expectedHash=probeDb.prepare('SELECT context_sha256 FROM attempts WHERE id=?').get(planned.attemptId).context_sha256;probeDb.close();
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,predicate,label,timeout=180000){const end=Date.now()+timeout;while(Date.now()<end){const value=await read();if(predicate(value))return value;await delay(150)}throw new Error('Délai dépassé: '+label)}
const view=async()=>(await(await fetch(base+'/api/view?after=-1')).json());
async function start(){
  const child=spawn(process.execPath,['dist/src/main.js'],{cwd:root,env:{...process.env,MINO_DATA_DIR:dir,MINO_PORT:String(port)},stdio:['ignore','pipe','pipe']});
  child.stderr.resume();const exited=new Promise(resolve=>{child.once('exit',resolve);child.once('error',resolve)});
  try {
    await new Promise((resolve,reject)=>{
      const lines=createInterface({input:child.stdout});
      const timer=setTimeout(()=>{lines.close();reject(new Error('Serveur indisponible'))},10000);
      lines.on('line',line=>{
        try { if(JSON.parse(line).event==='ready'){clearTimeout(timer);lines.close();resolve()} }
        catch {clearTimeout(timer);lines.close();reject(new Error('Journal invalide'))}
      });
      child.once('error',()=>{clearTimeout(timer);lines.close();reject(new Error('Démarrage impossible'))});
      child.once('exit',()=>{clearTimeout(timer);lines.close();reject(new Error('Arrêt avant disponibilité'))});
    });
  } catch(error) {
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    await exited;
    throw error;
  }
  return {stop:async()=>{child.kill('SIGTERM');await exited}};
}
let running;
let phase='startup';
try{
  running=await start();
  phase='real_reply';
  const done=await until(view,v=>['done','review','failed','cancelled'].includes(v.works.find(w=>w.id===workId)?.state),'réponse réelle');
  const work=done.works.find(w=>w.id===workId);assert(['done','review'].includes(work.state),'Le moteur doit réussir, sans réponse simulée');
  assert.equal(work.botId,'nova');assert.equal(work.threadBotId,'mino');
  assert.equal(done.works.filter(w=>w.requestMessageId===work.requestMessageId).length,1);
  const response=done.messages.find(m=>m.role==='assistant'&&m.workId===workId);assert(response);assert((response.text+'\n'+(work.versions.at(-1)?.body??'')).includes('CEDRE-481'));
  assert.equal(response.botId,'nova');assert.equal(response.threadBotId,'mino');
  assert.equal(done.messages.filter(m=>m.role==='user'&&m.id===work.requestMessageId).length,1);
  assert.equal(response.stamp.threadId,work.attempt.threadId);assert.equal(response.stamp.turnId,work.attempt.turnId);
  await running.stop();running=null;
  phase='context_hash';
  const db=new DatabaseSync(path);const actualHash=db.prepare('SELECT context_sha256 FROM attempts WHERE work_id=? ORDER BY n DESC LIMIT 1').get(workId).context_sha256;db.close();
  assert.equal(actualHash,expectedHash,'Le contexte réellement enregistré doit être celui de la copie vérifiée');
  phase='restart';
  running=await start();const restored=await view();
  assert.deepEqual(restored.messages.find(m=>m.id===response.id),response);
  assert.equal(restored.works.find(w=>w.id===workId).threadBotId,'mino');
  assert(!restored.messages.filter(m=>m.threadBotId==='nova').some(m=>m.id===response.id));
  await running.stop();running=null;
  const evidence={checkedAt:new Date().toISOString(),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),engine:'Official Codex App Server, one actual model call; preceding history controlled synthetic seeds.',passed:true,reply:response.text,deliverable:work.versions.at(-1)??null,actorBotId:response.botId,threadBotId:response.threadBotId,stamp:response.stamp,contextChecks:{currentThreadIncluded:true,actorMemoryAndInstructionsIncluded:true,ownerMemoryAndInstructionsExcluded:true,otherPersonalThreadExcluded:true,actualContextHashMatchesProbe:true},restart:{responseAndAttributionKept:true,guestPersonalThreadUnchanged:true},usage:restored.works.find(w=>w.id===workId).attempt?.usage??null,note:'Synthetic context only. No third-party message. No billing or token saving claim.'};
  writeFileSync(out,JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));
}catch{
  writeFileSync(out,JSON.stringify({checkedAt:new Date().toISOString(),passed:false,phase,note:'Le parcours réel invité a échoué. Aucun succès ni résultat de remplacement.'},null,2)+'\n');
  throw new Error('Échec du parcours réel invité. Consulter la preuve sans secret.');
}finally{if(running)await running.stop()}
