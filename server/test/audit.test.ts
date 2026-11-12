import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {engineFailure, loadMascots, type EngineOutcome} from '../src/domain.js';
import {openStore, type Store, type Claim} from '../src/store.js';
import type {Command, CommandResult} from '../src/protocol.js';

const mascots=loadMascots(new URL('../../assets/mascots.json',import.meta.url));
type CommandInput = {[T in Command['type']]: Omit<Extract<Command,{type:T}>,'requestId'>}[Command['type']];
function accepted(store:Store, command:CommandInput):CommandResult {
  const result=store.dispatch({...command,requestId:randomUUID()});
  assert(result.ok,result.ok?'':result.message);
  return result.result;
}
function sandbox(){const path=join(mkdtempSync(join(tmpdir(),'mino-audit-regression-')),'mino.sqlite');return {path,store:openStore({path,mascots})};}
function request(store:Store,reviewerBotId:string|null=null){
  const sent=accepted(store,{type:'message.send',botId:'mino',text:'Prépare une note',attachments:[],document:{reviewerBotId}});
  assert(sent.kind==='message'&&sent.taskId);return {taskId:sent.taskId,workId:sent.workId};
}
function claim(store:Store):Claim {const c=store.claimNext('doc');assert(c);return c;}
function success(body:string|null):EngineOutcome {return {kind:'succeeded',reply:{reply:body===null?'AVIS_CONFIRME':'BROUILLON_CONFIRME',deliverable:body===null?null:{title:'Note',body}},used:{model:'controlled-audit',effort:'low',speed:'standard'},threadId:'audit-thread',turnId:randomUUID()};}

test('a replaced goal absent from the context is never marked prepared or transmitted',()=>{
  const {store}=sandbox();
  try {
    const {taskId}=request(store);
    for(const text of ['OBJECTIF_REMPLACE_728','OBJECTIF_ACTUEL_936'])accepted(store,{type:'task.intent',taskId,intent:{kind:'change_goal',text}});
    accepted(store,{type:'task.intent',taskId,intent:{kind:'add_info',text:'PRECISION_CONSERVEE_417'}});
    const c=claim(store);
    assert(!c.turn.input.includes('OBJECTIF_REMPLACE_728'));
    assert(c.turn.input.includes('OBJECTIF_ACTUEL_936')&&c.turn.input.includes('PRECISION_CONSERVEE_417'));
    let events=store.view().tasks[0]?.events;assert(events);
    assert.deepEqual(events.map(e=>e.delivery.state),['superseded','prepared','prepared']);
    store.bindThread(c,'audit-thread');store.bindTurn(c,'audit-turn');
    events=store.view().tasks[0]?.events;assert(events);
    assert.deepEqual(events.map(e=>e.delivery.state),['superseded','sent','sent']);
    store.finishJob(c,success('Document selon objectif actuel.'));
    assert.equal(store.view().tasks[0]?.status,'finished','a superseded goal never demands an impossible future pass');
  }finally{store.close();}
});

test('a goal actually transmitted before its replacement retains its true receipt',()=>{
  const {store}=sandbox();
  try {
    const {taskId}=request(store);
    accepted(store,{type:'task.intent',taskId,intent:{kind:'change_goal',text:'OBJECTIF_DEJA_TRANSMIS_193'}});
    const c=claim(store);store.bindThread(c,'audit-thread');store.bindTurn(c,'audit-turn');
    accepted(store,{type:'task.intent',taskId,intent:{kind:'change_goal',text:'OBJECTIF_SUIVANT_287'}});
    assert.deepEqual(store.view().tasks[0]?.events.map(e=>e.delivery.state),['sent','waiting']);
  }finally{store.close();}
});

for(const stopping of ['failure','cancellation','restart'] as const){
  test(`a confirmed document stays usable after synthesis ${stopping} without restarting the call`,()=>{
    const fixture=sandbox();let store=fixture.store;
    try {
      const {taskId,workId}=request(store,'pixel');
      store.finishJob(claim(store),success('TEXTE_CONFIRME_913'));
      store.finishJob(claim(store),success(null));
      const synthesis=claim(store);
      if(stopping==='failure')store.finishJob(synthesis,engineFailure('turn_failed'));
      else if(stopping==='cancellation')accepted(store,{type:'task.intent',taskId,intent:{kind:'cancel'}});
      else {store.close();store=openStore({path:fixture.path,mascots});assert.equal(store.recoverInterrupted(),1);}
      const t=store.view().tasks.find(t=>t.id===taskId);assert(t);
      assert.equal(t.status,stopping==='cancellation'?'cancelled':'stopped');
      assert.equal(store.claimNext('doc'),null,'no automatic call, including after failure');
      const work=store.view().works.find(w=>w.id===workId);assert(work);
      assert.equal(work.versions[0]?.body,'TEXTE_CONFIRME_913');
      assert.equal(work.state,'review','available content and stopped execution have distinct states');
      assert.equal(store.view().messages.filter(m=>m.role==='assistant').length,2);
      const version=work.versions[0];assert(version);
      const proposal=accepted(store,{type:'publication.propose',workId,versionId:version.id,destination:'carnet'});assert(proposal.kind==='proposal');
      accepted(store,{type:'publication.approve',proposalId:proposal.proposalId,action:'publish',destination:'carnet',versionId:version.id,payloadSha256:proposal.payloadSha256});
      assert.equal(store.view().carnet[0]?.body,'TEXTE_CONFIRME_913');
      assert.equal(store.view().tasks[0]?.calls.length,3,'publishing never spends a new model call');
      assert.equal(store.view().tasks[0]?.calls.at(-1)?.state,stopping==='restart'?'interrupted':stopping==='failure'?'failed':'cancelled');
    }finally{store.close();}
  });
}

test('a manual document after a failed first call can be validated and restored while the failure stays recorded',()=>{
  const {store}=sandbox();
  try {
    const {taskId,workId}=request(store);store.finishJob(claim(store),engineFailure('turn_failed'));
    assert.equal(store.view().works.find(w=>w.id===workId)?.state,'failed');
    const edit=accepted(store,{type:'task.edit',taskId,baseVersionId:null,title:'Note humaine',body:'VERSION_HUMAINE_1'});assert(edit.kind==='version');
    accepted(store,{type:'work.accept',workId});
    const second=accepted(store,{type:'task.edit',taskId,baseVersionId:edit.versionId,title:'Note humaine',body:'VERSION_HUMAINE_2'});assert(second.kind==='version');
    accepted(store,{type:'version.restore',workId,versionId:edit.versionId});
    const work=store.view().works.find(w=>w.id===workId);assert(work);
    assert.equal(work.versions.at(-1)?.body,'VERSION_HUMAINE_1');
    assert.equal(work.attempt?.state,'failed');
    assert.equal(store.view().tasks[0]?.calls.length,1);
  }finally{store.close();}
});

test('startup recovers an already stopped legacy document without inventing an interruption or a new call',()=>{
  const fixture=sandbox();let store=fixture.store;
  try {
    const {workId}=request(store);store.finishJob(claim(store),success('ANCIEN_DOCUMENT_CONFIRME'));
    store.close();
    const db=new DatabaseSync(fixture.path);db.prepare("UPDATE works SET state='failed' WHERE id=?").run(workId);db.close();
    store=openStore({path:fixture.path,mascots});
    assert.equal(store.recoverInterrupted(),0);
    assert.equal(store.view().works.find(w=>w.id===workId)?.state,'review');
    const rev=store.view().rev;
    assert.equal(store.recoverInterrupted(),0);assert.equal(store.view().rev,rev,'recovery converges without repeated writes');
    accepted(store,{type:'work.accept',workId});
    assert.equal(store.view().tasks[0]?.calls.length,1);
  }finally{store.close();}
});

test('cancelling a queued document with a human version keeps it usable without starting a call',()=>{
  const {store}=sandbox();
  try {
    const {taskId,workId}=request(store);
    const version=accepted(store,{type:'task.edit',taskId,baseVersionId:null,title:'Note',body:'AVANT_PREMIER_APPEL'});assert(version.kind==='version');
    accepted(store,{type:'task.intent',taskId,intent:{kind:'cancel'}});
    assert.equal(store.view().tasks[0]?.status,'cancelled');
    assert.equal(store.view().works.find(w=>w.id===workId)?.state,'review');
    assert.equal(store.claimNext('doc'),null);
    accepted(store,{type:'publication.propose',workId,versionId:version.versionId,destination:'carnet'});
    assert.equal(store.view().tasks[0]?.calls.length,0);
  }finally{store.close();}
});
