import {spawn} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';

export const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function until(read,predicate,label,timeout=12000){
  const end=Date.now()+timeout;
  while(Date.now()<end){const value=await read();if(predicate(value))return value;await delay(40)}
  throw Error('Condition non atteinte: '+label);
}

export async function browser(profile, options={}){
  rmSync(join(profile,'DevToolsActivePort'),{force:true});
  const chrome=spawn(process.env.MINO_CHROME_BIN??'google-chrome-stable',['--headless=new','--no-sandbox','--disable-gpu','--disable-extensions','--disable-background-networking','--no-first-run','--no-default-browser-check',`--user-data-dir=${profile}`,'--remote-debugging-port=0','--window-size=1280,900',...(options.args??[]),'about:blank'],{stdio:'ignore'});
  const exited=new Promise(resolve=>{chrome.once('exit',resolve);chrome.once('error',resolve)});
  let startupError=false;chrome.once('error',()=>{startupError=true});
  let socket;
  const pending=new Map();
  let sequence=0;
  try{
    await until(()=>{if(startupError)throw Error('Chrome indisponible');return existsSync(join(profile,'DevToolsActivePort'))},Boolean,'démarrage Chrome');
    const port=readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];
    const pages=await(await fetch(`http://127.0.0.1:${port}/json`)).json();const page=pages.find(p=>p.type==='page');if(!page)throw Error('Page Chrome absente');
    socket=new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',()=>reject(Error('Connexion Chrome impossible')),{once:true})});
    socket.addEventListener('message',event=>{
      const value=JSON.parse(event.data);const p=pending.get(value.id);if(!p)return;
      pending.delete(value.id);clearTimeout(p.timer);value.error?p.reject(Error('Commande navigateur refusée: '+p.method)):p.resolve(value.result);
    });
    socket.addEventListener('close',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Navigateur fermé'))}pending.clear()});
    function rpc(method,params={}){
      return new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(Error('Délai navigateur: '+method))},8000);pending.set(id,{resolve,reject,timer,method});socket.send(JSON.stringify({id,method,params}))});
    }
    async function evaluate(expression){const r=await rpc('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error('Exception du parcours navigateur: '+String(r.exceptionDetails.exception?.description??r.exceptionDetails.text).slice(0,1000));return r.result.value;}
    async function click(expression){
      await evaluate(`Promise.all([...document.querySelectorAll('dialog[open]')].flatMap(d=>d.getAnimations()).filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))`);
      const point=await evaluate(`(()=>{const e=${expression};if(!e)throw Error('Cible absente');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Cible invisible');return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await rpc('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',buttons:1,clickCount:1});await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',buttons:0,clickCount:1});
    }
    async function fill(selector,text){await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Champ absent');e.focus();e.select()})()`);await rpc('Input.insertText',{text});}
    async function key(key,code=key,modifiers=0){await rpc('Input.dispatchKeyEvent',{type:'keyDown',key,code,modifiers});await rpc('Input.dispatchKeyEvent',{type:'keyUp',key,code,modifiers});}
    async function clickText(text,scope='body'){await click(`[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(e=>e.textContent.trim()===${JSON.stringify(text)}&&e.getClientRects().length)`);}
    await rpc('Page.enable');await rpc('Runtime.enable');
    return{rpc,evaluate,click,clickText,fill,key,navigate:url=>rpc('Page.navigate',{url}),reload:()=>rpc('Page.reload',{ignoreCache:true}),screenshot:async path=>writeFileSync(path,Buffer.from((await rpc('Page.captureScreenshot',{format:'png'})).data,'base64')),close:async()=>{socket?.close();chrome.kill('SIGTERM');await exited}};
  }catch(error){socket?.close();chrome.kill('SIGTERM');await exited;throw error;}
}
