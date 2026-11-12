import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

export function buildFingerprint(root){
  const dir=root instanceof URL?fileURLToPath(root):root;
  const files=[...readdirSync(join(dir,'dist/src')).filter(x=>x.endsWith('.js')).map(x=>'dist/src/'+x),'dist/web/app.js','web/index.html','web/mino.css','assets/prototype.css','assets/mascots.json','assets/symbols.svg','package-lock.json'].sort();
  return Object.fromEntries(files.map(file=>[file,createHash('sha256').update(readFileSync(join(dir,file))).digest('hex')]));
}
