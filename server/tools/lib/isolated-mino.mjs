import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {tmpdir} from 'node:os';
import {resolve,sep} from 'node:path';

export async function minoServer({root,dataDir,port,codexBin}){
  if(typeof dataDir!=='string'||!resolve(dataDir).startsWith(resolve(tmpdir())+sep+'mino-'))throw Error('La vérification exige un dossier temporaire Mino.');
  const child=spawn(process.execPath,['dist/src/main.js'],{cwd:root,env:{...process.env,MINO_DATA_DIR:dataDir,MINO_PORT:String(port),...(codexBin?{MINO_CODEX_BIN:codexBin}:{})},stdio:['ignore','pipe','pipe']});
  child.stderr.resume();
  const exited=new Promise(resolve=>{child.once('exit',resolve);child.once('error',resolve)});
  try{
    await new Promise((resolve,reject)=>{
      const lines=createInterface({input:child.stdout});
      const timer=setTimeout(()=>{lines.close();reject(Error('Serveur isolé indisponible'))},10000);
      lines.on('line',line=>{try{if(JSON.parse(line).event==='ready'){clearTimeout(timer);lines.close();resolve()}}catch{clearTimeout(timer);lines.close();reject(Error('Journal invalide'))}});
      child.once('error',()=>{clearTimeout(timer);lines.close();reject(Error('Démarrage isolé impossible'))});child.once('exit',()=>{clearTimeout(timer);lines.close();reject(Error('Arrêt avant disponibilité'))});
    });
    const base='http://127.0.0.1:'+port;
    const page=await(await fetch(base)).text();const csrf=/name="mino-csrf" content="([a-f0-9]+)"/.exec(page)?.[1];if(!csrf)throw Error('Session isolée absente');
    return{base,view:async()=>(await(await fetch(base+'/api/view?after=-1')).json()),diagnostics:async()=>(await(await fetch(base+'/api/diagnostics')).json()),post:async command=>(await(await fetch(base+'/api/commands',{method:'POST',headers:{origin:base,'content-type':'application/json','x-mino-csrf':csrf},body:JSON.stringify({requestId:crypto.randomUUID(),...command})})).json()),stop:async(signal='SIGTERM')=>{if(child.exitCode===null&&child.signalCode===null)child.kill(signal);await exited}};
  }catch(error){if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;throw error;}
}
