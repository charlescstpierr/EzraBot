import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync,mkdtempSync,readFileSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const scenarios=[
  {id:'foreign_turn',file:'engine.js',before:/if \(event\.turnId !== turnId\)\s+return;/,after:'',test:'engine.test.js',pattern:'completed item from another turn'},
  {id:'nested_json',file:'partial-json.js',before:/if \(depth > 32\)\s+throw new Invalid\(\);/,after:'',test:'partial-json.test.js',pattern:'excessive nesting'},
  {id:'unaccepted_handoff',file:'store.js',before:'a.handoff_id === h.id && a.turn_id !== null',after:'a.handoff_id === h.id',test:'task.test.js',pattern:'handoffs are transmitted only'},
];
const results=[];
for(const s of scenarios){
  const dir=mkdtempSync(join(tmpdir(),'mino-background-negative-'));
  cpSync(join(root,'dist'),join(dir,'dist'),{recursive:true});
  symlinkSync(join(root,'node_modules'),join(dir,'node_modules'),'dir');
  symlinkSync(join(root,'assets'),join(dir,'assets'),'dir');
  writeFileSync(join(dir,'package.json'),'{"type":"module"}\n');
  const file=join(dir,'dist','src',s.file);const original=readFileSync(file,'utf8');
  const changed=original.replace(s.before,s.after);assert.notEqual(original,changed,'La mutation doit retirer la protection ciblée.');writeFileSync(file,changed);
  const run=spawnSync(process.execPath,['--test','--test-name-pattern='+s.pattern,join(dir,'dist','test',s.test)],{encoding:'utf8',timeout:15000});
  assert.equal(run.error,undefined);assert.notEqual(run.status,0,'La régression doit faire échouer le test.');
  assert.match(run.stdout,/fail 1/);results.push({case:s.id,detected:true});
}
const proof={passed:true,checkedAt:new Date().toISOString(),scope:'Each regression is reintroduced only in an isolated compiled copy. No production source or data touched. No model calls.',results};
writeFileSync(join(root,'docs/evidence/background-negative.json'),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));
