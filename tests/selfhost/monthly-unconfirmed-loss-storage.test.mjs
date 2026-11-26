import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readdirSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {LocalDatabase} from '../../selfhost/storage.mjs';
import {emptyConfiguration} from '../../app/monthly-domain.mjs';
const plain=v=>JSON.parse(JSON.stringify(v));
test('chronological 0023 upgrade adds derived storage without changing monthly strings, existing cache or migration ledger',t=>{
 const root=mkdtempSync(join(tmpdir(),'unconfirmed-upgrade-')),previous=join(root,'through-0023'),path=join(root,'shared.sqlite');mkdirSync(previous);t.after(()=>rmSync(root,{recursive:true,force:true}));
 const migrations=resolve('drizzle'),names=readdirSync(migrations).filter(n=>/^\d+.*\.sql$/.test(n)).sort(),prefix=names.filter(n=>n<'0024');assert.equal(prefix.at(-1),'0023_chart_views.sql');for(const n of prefix)copyFileSync(join(migrations,n),join(previous,n));
 let db=new LocalDatabase(path,previous);
 const originals=()=>Object.fromEntries(['site_settings','monthly_configuration','monthly_utility','monthly_rollups','chart_views'].map(name=>[name,plain(db.sqlite.prepare(`SELECT * FROM ${name}`).all())]));
 try{
 db.sqlite.exec("INSERT INTO site_settings(id,name) VALUES('retained','Synthetic retained');");
 db.sqlite.prepare('INSERT INTO monthly_configuration VALUES(?,?,?,?)').run('retained',7,JSON.stringify(emptyConfiguration()),'2026-01-01');
 db.sqlite.prepare('INSERT INTO monthly_utility(site_id,month,on_peak,off_peak,unpaid_energy,revenue) VALUES(?,?,?,?,?,?)').run('retained','2026-01','123.00000000000001',null,'0','-1.2500');
 db.sqlite.prepare('INSERT INTO monthly_rollups VALUES(?,?,?,?,?,?)').run('retained',8,'null',2,'{"retained":"telemetry cache"}','2026-01-01');
 const before=originals(),ledger=plain(db.sqlite.prepare('SELECT * FROM __sol_migrations ORDER BY name').all());db.close();db=null;
 for(let i=0;i<2;i++){
 db=new LocalDatabase(path,migrations);assert.deepEqual(originals(),before);const current=plain(db.sqlite.prepare('SELECT * FROM __sol_migrations ORDER BY name').all());assert.deepEqual(current.map(r=>r.name),names);assert.deepEqual(current.slice(0,ledger.length),ledger);
 assert.deepEqual(plain(db.sqlite.prepare('PRAGMA table_info(monthly_unconfirmed_loss)').all()).map(r=>[r.name,r.type,r.notnull,r.pk]),[['site_id','TEXT',1,1],['calculation_version','INTEGER',1,0],['publication_identity','TEXT',1,0],['review_identity','TEXT',1,0],['payload_json','TEXT',1,0]]);
 const foreign=plain(db.sqlite.prepare('PRAGMA foreign_key_list(monthly_unconfirmed_loss)').all());assert.equal(foreign[0].table,'site_settings');assert.equal(foreign[0].on_delete,'CASCADE');
 const payload='{"state":"current","analysisRunId":"synthetic","timezone":"UTC","months":{"2026-01":{"value":{"n":"41","d":"4"},"state":"complete","unconfirmedCount":1,"unknownCount":0,"reason":null}},"reason":null}';
 if(i===0)db.sqlite.prepare('INSERT INTO monthly_unconfirmed_loss VALUES(?,?,?,?,?)').run('retained',1,'publication','review',payload);
 assert.equal(db.sqlite.prepare('SELECT payload_json FROM monthly_unconfirmed_loss WHERE site_id=?').get('retained').payload_json,payload);assert.equal(db.sqlite.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);db.close();db=null;
 }
 }finally{db?.close();}
});
