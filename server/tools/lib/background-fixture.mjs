import {writeFileSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {DISABLED_FEATURES} from '../../dist/src/engine.js';

export function backgroundFixture(dataDir){
  const path=join(dataDir,'codex-background-fixture.mjs');
  const source=String.raw`
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
import {join} from 'node:path';
const features=Object.fromEntries(DISABLED.map(n=>[n,false]));
let sequence=0;
const threads=new Map();const turns=new Map();
const send=v=>{if(!process.stdout.destroyed)process.stdout.write(JSON.stringify(v)+'\n')};
const reply=(id,result)=>send({id,result});
const notify=(method,params)=>send({method,params});
const model={id:'controlled-background',displayName:'Controlled fixture',hidden:false,isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}],defaultReasoningEffort:'low',serviceTiers:[]};
function finish(t,status='completed'){
  clearInterval(t.timer);
  if(status==='completed')notify('item/completed',{threadId:t.threadId,turnId:t.id,item:{id:t.itemId,type:'agentMessage',text:t.raw}});
  notify('turn/completed',{threadId:t.threadId,turn:{id:t.id,status,error:status==='failed'?{message:'Controlled failure',codexErrorInfo:{usageLimitExceeded:true}}:null}});
  setTimeout(()=>notify('thread/tokenUsage/updated',{threadId:t.threadId,turnId:t.id,tokenUsage:{last:{inputTokens:100,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:50,reasoningOutputTokens:0,totalTokens:150},total:{inputTokens:100,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:50,reasoningOutputTokens:0,totalTokens:150},modelContextWindow:40000}}),40);
}
function run(id,p){
  const thread=threads.get(p.threadId);const input=p.input.map(i=>i.text??'').join('\n');
  const actor=thread.base.includes('REVIEWER_PRIVATE_INSTRUCTIONS_193')?'reviewer':'author';
  const current={id:'turn-'+(++sequence),threadId:p.threadId,itemId:'item-'+sequence,timer:null};
  const isChat=Boolean(p.outputSchema?.properties?.deliverable?.anyOf);
  const request=input.split(/Demande actuelle :\n|Demande initiale de la personne :\n/).at(-1);
  const isReview=actor==='reviewer';
  const synthesis=input.includes('REVIEW_PUBLIC_TOKEN_729');
  const applied=input.includes('PENDING_INFO_845');
  const goal=input.includes('NEW_GOAL_618');
  const body=synthesis?'# Synthèse\n\nREVIEW_PUBLIC_TOKEN_729\n\n'+('Une action finale issue de la rédaction et de la relecture.\n\n').repeat(26):'# Plan\n\nAUTHOR_DRAFT_VISIBLE_531\n\n'+('Une action concrète, son responsable et son critère de réussite.\n\n').repeat(34);
  const result=isChat?{reply:'CHAT_PING_OK_913',deliverable:null}:isReview?{reply:'Avis partagé. La rédaction contient AUTHOR_DRAFT_VISIBLE_531. Ajoute REVIEW_PUBLIC_TOKEN_729 à la synthèse.',deliverable:null}:{reply:'Voici le document.',deliverable:{title:'Document contrôlé',body:body+(applied?'\nAPPLIED_INFO_845':'')+(goal?'\nNEW_GOAL_618_APPLIED':'')}};
  current.raw=JSON.stringify(result);turns.set(current.id,current);
  appendFileSync(join(DATA_DIR,'calls.jsonl'),JSON.stringify({threadId:p.threadId,turnId:current.id,actor,input,baseInstructions:thread.base,model:p.model,effort:p.effort,speed:p.serviceTierForTurn})+'\n',{mode:0o600});
  reply(id,{turn:{id:current.id,status:'inProgress',items:[]}});
  notify('turn/started',{threadId:p.threadId,turn:{id:current.id,status:'inProgress',items:[]}});
  notify('item/started',{threadId:p.threadId,turnId:current.id,item:{id:current.itemId,type:'agentMessage',text:''}});
  if(request.includes('CONTROLLED_FAILURE_906')){setTimeout(()=>finish(current,'failed'),100);return;}
  const size=isChat?current.raw.length:request.includes('BROWSER_SLOW_280')&&!isReview?8:24;let at=0;
  current.timer=setInterval(()=>{
    const delta=current.raw.slice(at,at+size);at+=delta.length;
    if(delta)notify('item/agentMessage/delta',{threadId:p.threadId,turnId:current.id,itemId:current.itemId,delta});
    if(at>=current.raw.length)finish(current);
  },isChat?35:isReview?25:55);
}
createInterface({input:process.stdin}).on('line',line=>{
  const v=JSON.parse(line);const p=v.params??{};
  switch(v.method){
    case 'initialize':reply(v.id,{userAgent:'controlled-background-fixture'});break;
    case 'initialized':break;
    case 'config/read':reply(v.id,{config:{features,mcp_servers:{},web_search:'disabled',project_doc_max_bytes:0,skills:{include_instructions:false,max_context_tokens:1,bundled:{enabled:false}}}});break;
    case 'account/read':reply(v.id,{account:{type:'chatgpt'}});break;
    case 'model/list':reply(v.id,{data:[model],nextCursor:null});break;
    case 'thread/start':{const id='thread-'+process.pid+'-'+(++sequence);threads.set(id,{base:p.baseInstructions??''});reply(v.id,{thread:{id},model:p.model??model.id});break;}
    case 'turn/start':run(v.id,p);break;
    case 'turn/interrupt':{reply(v.id,{});const t=turns.get(p.turnId);if(t){clearInterval(t.timer);setTimeout(()=>finish(t,'interrupted'),900);}break;}
    default:if(v.id!==undefined)reply(v.id,{});
  }
});
process.stdin.on('end',()=>process.exit(0));
process.stdout.on('error',()=>process.exit(0));
`;
  writeFileSync(path,'#!'+process.execPath+'\nconst DISABLED='+JSON.stringify(DISABLED_FEATURES)+';\nconst DATA_DIR='+JSON.stringify(dataDir)+';\n'+source);
  chmodSync(path,0o700);
  return path;
}
