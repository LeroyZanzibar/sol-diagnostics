import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {DatabaseSync} from 'node:sqlite';

test('production CSV: authenticated downloads, preview, atomic apply, rollback, existing-site preservation and restart', {timeout:120000},async t=>{
 const directory=mkdtempSync(join(tmpdir(),'sol-sites-csv-')),password=randomUUID();
 const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const base=`http://127.0.0.1:${port}`,path='/api/site-settings/csv';let child,logs='';
 async function start(){
  child=spawn(process.execPath,['selfhost/server.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:String(port),SOL_DATA_DIR:directory,SOL_PASSWORD:password,SOL_USERNAME:'tester'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',d=>{logs+=d});child.stderr.on('data',d=>{logs+=d});
  for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error(logs);try{if((await fetch(base+'/healthz')).ok)return;}catch{}await new Promise(r=>setTimeout(r,50));}throw Error('Server did not start: '+logs);
 }
 async function stop(){if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}}
 t.after(async()=>{await stop();rmSync(directory,{recursive:true,force:true});});
 const headers={Authorization:'Basic '+Buffer.from(`tester:${password}`).toString('base64')};
 const readSites=async()=>(await(await fetch(base+'/api/site-settings',{headers})).json()).sites;
 async function csv(text,mode='preview',token){const response=await fetch(`${base}${path}?mode=${mode}`,{method:'POST',headers:{...headers,'Content-Type':'text/csv',...(token?{'X-Site-Preview-Token':token}:{})},body:text});return {status:response.status,data:await response.json()};}
 await start();
 for(const suffix of ['?download=template','?download=sites'])assert.equal((await fetch(base+path+suffix)).status,401);
 assert.equal((await fetch(base+path,{method:'POST',headers:{'Content-Type':'text/csv'},body:'name\nTest'})).status,401);
 assert.equal((await fetch(base+path,{method:'POST',headers:{...headers,Origin:'https://other.example','Content-Type':'text/csv'},body:'name\nTest'})).status,403);
 const template=await fetch(base+path+'?download=template',{headers});assert.equal(template.status,200);assert.match(template.headers.get('Content-Disposition'),/site-settings-template.csv/);assert.match(await template.text(),/^id,name,address,city,state,zip,country,latitude,longitude,expectedShading,expectedSnow,expectedProductionNotes\r\n$/);
 const text='\ufeffid,name,zip,expectedShading,expectedSnow,expectedProductionNotes\r\n,"Cedar, ""East""",02108,included,unknown,"First line\r\nSecond line"\r\n,West,00123,,,\r\n';
 let preview=await csv(text);assert.equal(preview.status,200,JSON.stringify(preview.data));assert.equal(preview.data.created,2);assert.deepEqual(await readSites(),[]);
 assert.equal((await csv(text,'apply')).status,409);
 let applied=await csv(text,'apply',preview.data.previewToken);assert.equal(applied.status,200,JSON.stringify(applied.data));assert.equal(applied.data.sites.length,2);
 let sites=await readSites();const east=sites.find(site=>site.name==='Cedar, "East"');assert.equal(east.zip,'02108');assert.equal(east.expectedProductionNotes,'First line\r\nSecond line');
 const db=new DatabaseSync(join(directory,'sol-diagnostics.sqlite'));
 db.prepare('UPDATE site_settings SET array_model_verified=1 WHERE id=?').run(east.id);
 db.exec("CREATE TRIGGER csv_failure BEFORE INSERT ON site_settings WHEN NEW.name='Fail' BEGIN SELECT RAISE(ABORT,'Injected failure'); END;");
 const failing=`id,name\n${east.id},Should roll back\n,Good new\n,Fail`;preview=await csv(failing);assert.equal(preview.status,200);
 assert.equal((await csv(failing,'apply',preview.data.previewToken)).status,500);sites=await readSites();assert.equal(sites.length,2);assert.equal(sites.find(s=>s.id===east.id).name,east.name);
 db.exec('DROP TRIGGER csv_failure');db.close();
 const update=`id,name,city,expectedShading,expectedSnow,expectedProductionNotes\n${east.id},Cedar renamed,Boston,,,\n,South,Albany,,,`;
 preview=await csv(update);applied=await csv(update,'apply',preview.data.previewToken);assert.equal(applied.status,200);assert.equal(applied.data.created,1);assert.equal(applied.data.updated,1);
 sites=await readSites();const saved=sites.find(s=>s.id===east.id);assert.equal(saved.expectedShading,'included');assert.equal(saved.expectedSnow,'unknown');assert.equal(saved.expectedProductionNotes,east.expectedProductionNotes);assert.equal(saved.arrayModelVerified,true);assert.equal(saved.zip,'02108');
 const before=sites;
 assert.equal((await csv(`id,name,latitude\n${east.id},Wrong,\n,Invalid,91`,'apply','bad')).status,400);assert.deepEqual(await readSites(),before);
 assert.equal((await csv('name\n'+ 'x'.repeat(1024*1024))).status,413);
 const exportResponse=await fetch(base+path+'?download=sites',{headers});const exported=await exportResponse.text();assert.match(exported,/02108/);assert.match(exported,new RegExp(east.id));assert.equal((await csv(exported)).data.updated,3);
 const theme=await fetch(base+'/api/user-settings',{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({firstName:'Local',lastName:'Analyst',title:'Manager',minimumIssueLossKwh:'',theme:'foundry'})});assert.equal(theme.status,200);
 await stop();await start();assert.deepEqual(await readSites(),before);assert.equal((await(await fetch(base+'/api/user-settings',{headers})).json()).user.theme,'foundry');
 t.diagnostic('CSV create/update and foundry preference persisted; real SQLite trigger failure rolled back every row.');
});
