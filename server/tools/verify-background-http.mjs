import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openStore} from '../dist/src/store.js';
import {loadMascots} from '../dist/src/domain.js';
import {DiagnosticsSchema} from '../dist/src/protocol.js';
import {backgroundFixture} from './lib/background-fixture.mjs';
import {minoServer} from './lib/isolated-mino.mjs';
import {until,delay} from './lib/browser.mjs';

const root=new URL('../',import.meta.url);
const dir=mkdtempSync(join(tmpdir(),'mino-background-http-'));
const port=Number(process.env.MINO_BACKGROUND_PORT??4391);
const evidence=new URL('docs/evidence/background-http.json',root);
writeFileSync(evidence,JSON.stringify({passed:false,checkedAt:new Date().toISOString(),phase:'starting'},null,2)+'\n');
const mascots=loadMascots(new URL('assets/mascots.json',root));
const store=openStore({path:join(dir,'mino.sqlite'),mascots});
function seed(command){const r=store.dispatch({...command,requestId:crypto.randomUUID()});assert(r.ok,r.message);return r.result;}
seed({type:'bot.update',botId:'mino',instructions:'AUTHOR_PRIVATE_INSTRUCTIONS_106'});
seed({type:'memory.create',botId:'mino',text:'AUTHOR_PRIVATE_MEMORY_106'});
seed({type:'bot.update',botId:'nova',instructions:'REVIEWER_PRIVATE_INSTRUCTIONS_193'});
seed({type:'memory.create',botId:'nova',text:'REVIEWER_PRIVATE_MEMORY_193'});
seed({type:'message.send',botId:'nova',text:'REVIEWER_OTHER_THREAD_PRIVATE_193',attachments:[]});
const old=store.claimNextJob();assert(old);store.finishJob(old,{kind:'succeeded',reply:{reply:'REVIEWER_OTHER_THREAD_ANSWER_193',deliverable:null},used:{model:'controlled-seed',effort:'low',speed:'standard'},threadId:'seed-thread',turnId:'seed-turn'});
store.close();
const cli=backgroundFixture(dir);
let server;
let phase='startup';
const checks=[];
const accepted=async command=>{const r=await server.post(command);assert(r.ok,r.message);return r;};
const task=async id=>(await server.view()).tasks.find(t=>t.id===id);
const current=(view,t)=>view.works.find(w=>w.id===t.authorWorkId)?.versions.at(-1);
async function startTask(marker,reviewerBotId=null){
  const r=await accepted({type:'message.send',botId:'mino',text:marker,attachments:[],document:{reviewerBotId}});
  const v=await server.view();const t=v.tasks.find(t=>t.requestMessageId===r.result.messageId);assert(t);return t.id;
}
async function progress(id){return until(()=>task(id),t=>t?.progress?.body?.length>20&&t.calls.some(c=>c.state==='running'),'texte documentaire reçu',20000);}
async function settled(id){return until(()=>task(id),t=>t&&t.calls.length&&!t.calls.some(c=>c.state==='running')&&!['queued','running'].includes(t.status),'tâche réglée',30000);}
try{
  server=await minoServer({root,dataDir:dir,port,codexBin:cli});
  phase='solo_progress_and_chat';
  const solo=await startTask('DOCUMENT_REQUEST_SOLO_531');
  const one=await progress(solo);const prefixes=new Set([one.progress.body]);
  await until(()=>task(solo),t=>{if(t?.progress?.body)prefixes.add(t.progress.body);return prefixes.size>=2&&t.calls.some(c=>c.state==='running')},'deux états réellement reçus',18000);
  const chat=await accepted({type:'message.send',botId:'mino',text:'CHAT_PING_913',attachments:[]});
  const chatDone=await until(server.view,v=>v.works.find(w=>w.id===chat.result.workId)?.state==='done','chat pendant document');
  assert(chatDone.tasks.find(t=>t.id===solo).calls.some(c=>c.state==='running'));
  await accepted({type:'task.intent',taskId:solo,intent:{kind:'add_info',text:'PENDING_INFO_845'}});
  const end=await settled(solo);const doc=current(await server.view(),end);assert(doc);
  for(const prefix of prefixes)assert(doc.body.startsWith(prefix));
  assert.equal(end.events.find(e=>e.text==='PENDING_INFO_845').delivery.state,'waiting');
  assert.equal(end.calls.length,1);assert.equal(end.status,'info_waiting');
  checks.push('two real received snapshots in a single controlled call','chat completes while document still runs','late information is not falsely transmitted','solo uses exactly one call');

  phase='human_base_conflict';
  const conflict=await startTask('DOCUMENT_REQUEST_HUMAN_CONFLICT_531');await progress(conflict);
  await accepted({type:'task.edit',taskId:conflict,baseVersionId:null,title:'Version humaine',body:'HUMAN_EXACT_VERSION_531'});
  const conflicting=await settled(conflict);const head=current(await server.view(),conflicting);
  assert.equal(head.body,'HUMAN_EXACT_VERSION_531');const proposal=conflicting.proposals.find(p=>p.state==='open');assert.equal(proposal?.reason,'base_moved');
  const adopt={type:'doc.adopt',requestId:crypto.randomUUID(),proposalId:proposal.id,seenVersionId:head.id,seenRevision:conflicting.revision};
  await accepted(adopt);const replay=await accepted(adopt);assert(replay.replayed);
  assert.equal((await server.view()).works.find(w=>w.id===conflicting.authorWorkId).versions.length,2);
  checks.push('human edit before first generated version survives','proposal adoption is explicit and idempotent');

  phase='goal_revision';
  const changed=await startTask('DOCUMENT_REQUEST_OLD_GOAL_531');await progress(changed);
  await accepted({type:'task.intent',taskId:changed,intent:{kind:'change_goal',text:'NEW_GOAL_618'}});
  const stale=await settled(changed);assert(stale.proposals.some(p=>p.reason==='goal_changed'));
  assert.equal(current(await server.view(),stale),undefined);
  await accepted({type:'task.continue',taskId:changed});
  const revised=await settled(changed);assert(current(await server.view(),revised).body.includes('NEW_GOAL_618_APPLIED'));
  assert.equal(revised.calls.length,2);assert.equal(revised.events.find(e=>e.kind==='change_goal').delivery.state,'sent');
  checks.push('changed goal prevents old result promotion','explicit continuation uses the new goal and records actual delivery');

  phase='bot_relay';
  const relay=await startTask('DOCUMENT_REQUEST_RELAY_531','nova');
  const relayed=await settled(relay);
  assert.deepEqual(relayed.calls.map(c=>c.step),['draft','review','synthesis']);
  assert.deepEqual(relayed.calls.map(c=>c.botId),['mino','nova','mino']);
  assert.equal(relayed.calls.length,3);assert.equal(relayed.maxCalls,3);
  assert(relayed.handoffs.some(h=>h.fromStep==='draft'&&h.readBy.some(r=>r.botId==='nova'&&r.step==='review')));
  assert(relayed.handoffs.some(h=>h.fromStep==='review'&&h.readBy.some(r=>r.botId==='mino'&&r.step==='synthesis')));
  assert(current(await server.view(),relayed).body.includes('REVIEW_PUBLIC_TOKEN_729'));
  const records=readFileSync(join(dir,'calls.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  const review=records.find(r=>r.actor==='reviewer');assert(review);
  assert(review.input.includes('AUTHOR_DRAFT_VISIBLE_531'));assert((review.input+review.baseInstructions).includes('REVIEWER_PRIVATE_MEMORY_193'));
  for(const secret of ['AUTHOR_PRIVATE_MEMORY_106','AUTHOR_PRIVATE_INSTRUCTIONS_106','REVIEWER_OTHER_THREAD_PRIVATE_193'])assert(!(review.input+review.baseInstructions).includes(secret));
  const synthesis=records.find(r=>r.actor==='author'&&r.input.includes('REVIEW_PUBLIC_TOKEN_729'));assert(synthesis);
  for(const secret of ['REVIEWER_PRIVATE_MEMORY_193','REVIEWER_PRIVATE_INSTRUCTIONS_193','REVIEWER_OTHER_THREAD_PRIVATE_193'])assert(!(synthesis.input+synthesis.baseInstructions).includes(secret));
  checks.push('A result is transmitted to B and B review is reused by A','actor memories and instructions stay isolated','three-call relay budget is enforced');

  phase='failure';
  const failed=await startTask('DOCUMENT_REQUEST_CONTROLLED_FAILURE_906');const failure=await settled(failed);
  assert.equal(failure.status,'stopped');assert.equal(current(await server.view(),failure),undefined);
  assert(failure.calls.some(c=>c.state==='failed'));
  checks.push('provider failure stays visible without a replacement document');

  phase='cancel_and_physical_guard';
  const cancelled=await startTask('DOCUMENT_REQUEST_CANCEL_531');await progress(cancelled);
  await accepted({type:'task.intent',taskId:cancelled,intent:{kind:'cancel'}});
  const visible=await server.view();const author=visible.bots.find(b=>b.id==='mino');
  const blocked=await server.post({type:'bot.delete',botId:'mino',confirmName:author.name,expected:author.deletion});
  assert(!blocked.ok&&blocked.code==='busy','physical call still protects the bot after logical cancellation');
  await until(server.diagnostics,d=>!d.activeWorkIds.includes(visible.tasks.find(t=>t.id===cancelled).authorWorkId),'arrêt physique');
  assert.equal((await task(cancelled)).status,'cancelled');
  checks.push('cancellation stops the chain','logical cancellation does not bypass physical deletion guard');

  phase='restart';
  const restarting=await startTask('DOCUMENT_REQUEST_RESTART_531');const partial=await progress(restarting);
  await accepted({type:'task.intent',taskId:restarting,intent:{kind:'add_info',text:'PENDING_INFO_845'}});
  await server.stop('SIGKILL');server=null;
  server=await minoServer({root,dataDir:dir,port,codexBin:cli});
  const recovered=await task(restarting);assert.equal(recovered.status,'stopped');assert.equal(recovered.calls.length,1);
  assert(recovered.progress.body.startsWith(partial.progress.body));assert.equal(recovered.events.at(-1).delivery.state,'waiting');
  await accepted({type:'task.continue',taskId:restarting});await progress(restarting);
  const secondChat=await accepted({type:'message.send',botId:'mino',text:'CHAT_PING_913 after restart',attachments:[]});
  const afterChat=await until(server.view,v=>v.works.find(w=>w.id===secondChat.result.workId)?.state==='done','chat concurrent après reprise');
  assert(afterChat.tasks.find(t=>t.id===restarting).calls.some(c=>c.state==='running'));
  const resumed=await settled(restarting);assert.equal(resumed.calls.length,2);assert(current(await server.view(),resumed).body.includes('APPLIED_INFO_845'));
  assert.equal(resumed.events.at(-1).delivery.state,'sent');
  checks.push('restart preserves partial text and unsent information','interrupted task never auto-restarts','explicit resume sends pending information','both lanes remain concurrent after restart');

  phase='metadata_and_purge';
  await delay(100);
  const metadata=DiagnosticsSchema.parse(await server.diagnostics());assert(!JSON.stringify(metadata).includes('PRIVATE_'));assert(metadata.attempts.some(a=>a.usage?.last.total===150));
  const beforeDelete=await server.view();const owner=beforeDelete.bots.find(b=>b.id==='mino');
  const erased=await accepted({type:'bot.delete',botId:'mino',confirmName:owner.name,expected:owner.deletion});assert(erased.result.erased);
  const left=await server.view();assert(!left.tasks.some(t=>t.threadBotId==='mino'));assert(left.bots.find(b=>b.id==='nova').memories.some(m=>m.text==='REVIEWER_PRIVATE_MEMORY_193'));
  await server.stop();server=null;
  const db=new DatabaseSync(join(dir,'mino.sqlite'));assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM purge_target').get().n,0);db.close();
  const file=readFileSync(join(dir,'mino.sqlite')).toString('latin1');assert(!file.includes('AUTHOR_PRIVATE_MEMORY_106'));assert(!file.includes('AUTHOR_PRIVATE_INSTRUCTIONS_106'));
  checks.push('metadata omits contents and preserves late usage','new task data is purged with its owner without harming another bot','SQLite links and purge gates remain valid');
  const recordedCalls=readFileSync(join(dir,'calls.jsonl'),'utf8').trim().split('\n').filter(Boolean).length;
  const proof={passed:true,checkedAt:new Date().toISOString(),fixture:'Temporary SQLite and controlled App Server only. No actual model call.',checks,recordedCalls,note:'Context capture contains synthetic canaries only and stays in the private temporary fixture. Operational proofs do not assert universal response quality.'};
  writeFileSync(evidence,JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));
}catch(error){writeFileSync(evidence,JSON.stringify({passed:false,checkedAt:new Date().toISOString(),phase,note:'Validation not completed. No replacement success.'},null,2)+'\n');throw error;}
finally{if(server)await server.stop()}
