import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openStore} from '../dist/src/store.js';
import {loadMascots} from '../dist/src/domain.js';
import {buildFingerprint} from './lib/build-fingerprint.mjs';

const root=new URL('../',import.meta.url);
const path=join(mkdtempSync(join(tmpdir(),'mino-approval-crash-')),'mino.sqlite');
const mascots=loadMascots(new URL('assets/mascots.json',root));
let store=openStore({path,mascots});
const send=command=>{const r=store.dispatch({requestId:randomUUID(),...command});assert(r.ok,r.message);return r.result;};
const work=send({type:'message.send',botId:'mino',text:'Rédige une note de test',attachments:[],document:{reviewerBotId:null}});
const claim=store.claimNext('doc');assert(claim);
store.finishJob(claim,{kind:'succeeded',reply:{reply:'Note enregistrée.',deliverable:{title:'Note exacte',body:'CORPS_EXACT_SYNTHETIQUE_372'}},used:{model:'controlled',effort:'low',speed:'standard'},threadId:'audit',turnId:'audit-turn'});
const version=store.view().works.find(w=>w.id===work.workId).versions[0];
const proposed=send({type:'publication.propose',workId:work.workId,versionId:version.id,destination:'carnet'});
const approval={type:'publication.approve',requestId:randomUUID(),proposalId:proposed.proposalId,action:'publish',destination:'carnet',versionId:version.id,payloadSha256:proposed.payloadSha256};store.close();
const child=String.raw`
import {DatabaseSync} from 'node:sqlite';
import {openStore} from './dist/src/store.js';
import {loadMascots} from './dist/src/domain.js';
const [path,encoded,phase]=process.argv.slice(1);
if(phase==='before_receipt'){
  const prepare=DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare=function(sql){
    const statement=prepare.call(this,sql);
    if(!sql.startsWith('INSERT INTO commands('))return statement;
    return new Proxy(statement,{get(target,key){if(key==='run')return()=>process.kill(process.pid,'SIGKILL');const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}});
  };
}
const store=openStore({path,mascots:loadMascots(new URL('./assets/mascots.json',import.meta.url))});
const outcome=store.dispatch(JSON.parse(encoded));if(!outcome.ok)throw Error('Commande refusée');process.kill(process.pid,'SIGKILL');
`;
const cases=[];
for(const [phase,expected] of [['before_receipt',[0,0,0]],['after_commit',[1,1,1]]]){
  const r=spawnSync(process.execPath,['--input-type=module','-e',child,path,JSON.stringify(approval),phase],{cwd:root,encoding:'utf8',timeout:10000});
  assert.equal(r.error,undefined);assert.equal(r.signal,'SIGKILL');
  const db=new DatabaseSync(path,{readOnly:true});
  const counts=['decisions','publications'].map(table=>db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n);
  counts.push(db.prepare('SELECT COUNT(*) AS n FROM commands WHERE request_id=?').get(approval.requestId).n);db.close();
  assert.deepEqual(counts,expected);cases.push({phase,counts});
}
store=openStore({path,mascots});
try{
  const replay=store.dispatch(approval);assert(replay.ok&&replay.replayed);
  const copy=store.view().carnet[0];assert.equal(copy.body,'CORPS_EXACT_SYNTHETIQUE_372');assert.equal(copy.payloadSha256,proposed.payloadSha256);
  assert.equal(store.view().carnet.length,1);
}finally{store.close();}
const proof={passed:true,checkedAt:new Date().toISOString(),codeSnapshot:buildFingerprint(root),scope:'Two actual SIGKILL signals target only child processes using synthetic temporary SQLite. Controlled result, no model or external message.',cases,replayReturnsSameReceipt:true,exactPublishedCopy:true};
writeFileSync(new URL('docs/evidence/audit-approval-crash.json',root),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify({passed:true,cases:cases.length}));
