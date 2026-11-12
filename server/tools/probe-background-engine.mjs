import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {DISABLED_FEATURES,CODEX_CONFIG_ARGS} from '../dist/src/engine.js';
import {composeContext} from '../dist/src/context.js';
import {EngineReplySchema} from '../dist/src/protocol.js';

assert(!process.env.MINO_CODEX_BIN,'La sonde exige le Codex officiel.');
const root=new URL('../',import.meta.url);
const dir=mkdtempSync(join(tmpdir(),'mino-background-probe-'));
const out=new URL('docs/evidence/background-engine-probe.json',root);
writeFileSync(out,JSON.stringify({passed:false,checkedAt:new Date().toISOString(),phase:'starting'},null,2)+'\n');
const allowed=new Set(['userMessage','agentMessage','reasoning','contextCompaction']);
const traces=[];
class Probe {
  constructor(lane){
    this.lane=lane;this.pending=new Map();this.seq=0;this.notify=()=>{};
    this.cwd=join(dir,lane);mkdirSync(this.cwd);
    this.child=spawn('codex',['app-server','--listen','stdio://',...DISABLED_FEATURES.flatMap(n=>['--disable',n]),...CODEX_CONFIG_ARGS],{cwd:this.cwd,stdio:['pipe','pipe','pipe']});
    this.child.stderr.resume();
    this.exited=new Promise(resolve=>{this.child.once('exit',resolve);this.child.once('error',resolve)});
    const close=()=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('App Server fermé'))}this.pending.clear();};
    this.child.once('error',close);this.child.once('exit',close);
    createInterface({input:this.child.stdout}).on('line',line=>{
      let value;try{value=JSON.parse(line)}catch{this.child.kill();return;}
      const p=this.pending.get(value.id);
      if(p){this.pending.delete(value.id);clearTimeout(p.timer);value.error?p.reject(Error('RPC refusé')):p.resolve(value.result);}
      else if(value.id!==undefined){this.send({id:value.id,error:{code:-32000,message:'Action indisponible'}});this.notify('serverRequest',{});}
      else this.notify(value.method,value.params);
    });
  }
  send(value){this.child.stdin.write(JSON.stringify(value)+'\n')}
  rpc(method,params){return new Promise((resolve,reject)=>{const id=++this.seq;const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Délai RPC'))},30000);this.pending.set(id,{resolve,reject,timer});this.send({id,method,params})})}
  async prepare(){
    await this.rpc('initialize',{clientInfo:{name:'mino_probe',version:'0.1.0'},capabilities:{experimentalApi:false}});this.send({method:'initialized',params:{}});
    const {config}=await this.rpc('config/read',{includeLayers:false});assert(DISABLED_FEATURES.every(n=>config.features?.[n]===false));assert.equal(config.web_search,'disabled');assert(Object.values(config.mcp_servers??{}).every(s=>s.enabled===false));
    const {account}=await this.rpc('account/read',{refreshToken:false});assert.equal(account?.type,'chatgpt');
    const catalog=await this.rpc('model/list',{includeHidden:false});this.model=catalog.data.find(m=>m.isDefault&&!m.hidden);assert(this.model);
  }
  async run(request){
    const turn=composeContext({bot:{name:this.lane,title:'',instructions:'',replyStyle:'concise',contextSize:'short'},memories:[],exchanges:[],request:{text:request,attachments:[]}}).turn;
    const started=await this.rpc('thread/start',{model:this.model.id,cwd:this.cwd,sandbox:'read-only',approvalPolicy:'untrusted',ephemeral:true,baseInstructions:turn.baseInstructions,config:{mcp_servers:{},web_search:'disabled'}});
    assert.equal(started.model,this.model.id);const threadId=started.thread.id;
    let acknowledge;const accepted=new Promise(resolve=>{acknowledge=resolve});
    const result=new Promise((resolve,reject)=>{
      let finalText=null,finalItem=null;const deltas=new Map(),counts=new Map();let begunAt=null,firstDeltaAt=null,turnId=null;
      const timer=setTimeout(()=>reject(Error('Délai du tour')),180000);
      this.notify=(method,p)=>{
        if(method==='serverRequest'){clearTimeout(timer);reject(Error('Outil inattendu'));return;}
        if(p?.threadId!==threadId)return;
        const at=Date.now();
        if(method==='item/agentMessage/delta'&&typeof p.delta==='string'&&typeof p.itemId==='string'){
          if(firstDeltaAt===null)firstDeltaAt=at;
          deltas.set(p.itemId,(deltas.get(p.itemId)??'')+p.delta);counts.set(p.itemId,(counts.get(p.itemId)??0)+1);
        }
        if(method==='item/started'||method==='item/completed'){
          if(!allowed.has(p.item?.type)){clearTimeout(timer);reject(Error('Item non autorisé'));return;}
          if(method==='item/completed'&&p.item.type==='agentMessage'){finalText=p.item.text;finalItem=p.item.id;}
        }
        if(method==='model/rerouted'){clearTimeout(timer);reject(Error('Modèle changé'));return;}
        if(method==='turn/started'){begunAt=at;turnId=p.turn.id;acknowledge();}
        if(method==='turn/completed'){
          clearTimeout(timer);
          try{
            assert.equal(p.turn.status,'completed');assert.equal(typeof finalText,'string');
            const reply=EngineReplySchema.parse(JSON.parse(finalText));
            const streamed=deltas.get(finalItem)??'';
            resolve({lane:this.lane,threadId,turnId:p.turn.id,model:this.model.id,effort:this.model.defaultReasoningEffort,speed:'standard',begunAt,firstDeltaAt,completedAt:at,deltaCount:counts.get(finalItem)??0,streamedChars:streamed.length,finalChars:finalText.length,streamMatchesFinal:streamed===finalText,reply});
          }catch{reject(Error('Réponse ou stream invalide'));}
        }
        if(['turn/started','turn/completed','item/started','item/completed'].includes(method))traces.push({lane:this.lane,method,at});
      };
      this.rpc('turn/start',{threadId,input:[{type:'text',text:turn.input}],model:this.model.id,effort:this.model.defaultReasoningEffort,serviceTierForTurn:'default',sandboxPolicy:{type:'readOnly',networkAccess:false},approvalPolicy:'untrusted',outputSchema:turn.outputSchema}).then(r=>{turnId=r.turn.id;if(begunAt===null)begunAt=Date.now();acknowledge()},e=>{clearTimeout(timer);reject(e)});
    });
    result.catch(()=>{});
    return {accepted,result};
  }
  async close(){this.child.stdin.end();this.child.kill('SIGTERM');await this.exited;}
}
const doc=new Probe('document');const chat=new Probe('chat');
try{
  await Promise.all([doc.prepare(),chat.prepare()]);
  const writing=await doc.run('Rédige un plan complet de 850 mots environ pour lancer un jardin communautaire. Douze sections concrètes avec actions, responsabilités, calendrier et critères de réussite. Produis le texte complet dans le livrable, sans outil ni recherche.');
  await writing.accepted;
  const conversation=await chat.run('Réponds seulement MINO_CHAT_OK_372, sans livrable.');
  const [document,answer]=await Promise.all([writing.result,conversation.result]);
  assert(document.reply.deliverable?.body.length>3000);assert(answer.reply.reply.includes('MINO_CHAT_OK_372'));
  const overlap=answer.begunAt<document.completedAt&&document.begunAt<answer.completedAt;
  const chatBeforeDocument=answer.completedAt<document.completedAt;
  const progressive=document.deltaCount>1&&document.streamMatchesFinal&&document.firstDeltaAt<document.completedAt;
  const compact=v=>{const {reply,...meta}=v;return{...meta,replyChars:reply.reply.length,documentChars:reply.deliverable?.body.length??0}};
  const proof={checkedAt:new Date().toISOString(),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),passed:overlap&&chatBeforeDocument&&progressive,topology:'Two independent official Codex App Server connections, same local ChatGPT session, one turn per connection.',overlap,chatBeforeDocument,progressive,document:compact(document),chat:compact(answer),traces,note:'Two actual model calls. Synthetic prompts. No third-party message, tool, secret, or simulated timing.'};
  writeFileSync(out,JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));assert(proof.passed,'Les capacités doivent être réellement prouvées');
}catch{const old=JSON.parse((await import('node:fs')).readFileSync(out,'utf8'));if(old.phase)writeFileSync(out,JSON.stringify({passed:false,checkedAt:new Date().toISOString(),phase:'failed',note:'Capacités non vérifiées. Aucun repli simulé.'},null,2)+'\n');throw Error('La sonde de concurrence et de rédaction n’a pas passé.');}
finally{await Promise.all([doc.close(),chat.close()]);}
