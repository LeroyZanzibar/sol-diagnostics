import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {LocalDatabase,LocalBucket,LocalFixedLengthStream} from '../../selfhost/storage.mjs';
function fixture(t){const root=mkdtempSync(join(tmpdir(),'sol-storage-'));const db=new LocalDatabase(join(root,'db.sqlite'),resolve('drizzle'));const bucket=new LocalBucket(db,join(root,'objects'));t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});return {db,bucket,root};}
test('all schema migrations apply once; D1 rows, raw ordering and failed batches preserve data',async t=>{
  const {db,root}=fixture(t);
  await db.prepare('INSERT INTO site_settings(id,name) VALUES (?,?)').bind('a','Alpha').run();
  assert.deepEqual(await db.prepare('SELECT name,id FROM site_settings').raw(),[['Alpha','a']]);
  assert.equal(await db.prepare('SELECT name FROM site_settings').first('name'),'Alpha');
  await assert.rejects(db.batch([db.prepare("UPDATE site_settings SET name='Wrong'"),db.prepare('INSERT INTO nonexistent VALUES (1)')]));
  assert.equal((await db.prepare('SELECT * FROM site_settings').first()).name,'Alpha');
  const second=new LocalDatabase(join(root,'db.sqlite'),resolve('drizzle'));
  assert.deepEqual((await second.prepare('SELECT name FROM __sol_migrations ORDER BY name').all()).results.map(row=>row.name),readdirSync('drizzle').filter(name=>/^\d+.*\.sql$/.test(name)).sort());second.close();
});
test('files stream to disk, survive restart and retain content types and compressed checkpoint metadata',async t=>{
  const {db,bucket,root}=fixture(t),value='a,b\n'.repeat(300000);
  const saved=await bucket.put('mapped/site/file.csv',new Blob([value]).stream(),{httpMetadata:{contentType:'text/csv'},customMetadata:{checkpointFormat:'test'}});
  assert.equal(saved.size,Buffer.byteLength(value));assert.equal((await bucket.head(saved.key)).customMetadata.checkpointFormat,'test');
  const second=new LocalBucket(db,join(root,'objects'));assert.equal(await(await second.get(saved.key)).text(),value);
  const old=await bucket.get(saved.key);await bucket.put(saved.key,'new');assert.equal(await old.text(),value);assert.equal(await(await bucket.get(saved.key)).text(),'new');
});
test('failed streaming replacement preserves the old version and storage keys cannot escape the volume',async t=>{
  const {bucket,root}=fixture(t);await bucket.put('../../escape','safe');
  const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array([1]));c.error(Error('interrupted'));}});
  await assert.rejects(bucket.put('../../escape',stream));assert.equal(await(await bucket.get('../../escape')).text(),'safe');
  assert.equal(readFileSync(join(root,'db.sqlite')).subarray(0,6).toString(),'SQLite');
});
test('prefix listing paginates without wildcard expansion and supports bulk deletion',async t=>{
  const {bucket}=fixture(t);for(const key of ['a%/1','a%/2','abc/1'])await bucket.put(key,key);
  const page=await bucket.list({prefix:'a%/',limit:1});assert.equal(page.truncated,true);assert.equal(page.objects[0].key,'a%/1');
  const next=await bucket.list({prefix:'a%/',cursor:page.cursor,limit:1});assert.equal(next.truncated,false);assert.equal(next.objects[0].key,'a%/2');
  await bucket.delete(['a%/1','a%/2']);assert.deepEqual((await bucket.list({prefix:'a%/'})).objects,[]);
});
test('chunked uploads enforce their declared byte length',async()=>{
  const stream=new LocalFixedLengthStream(3);const write=new Blob(['abc']).stream().pipeTo(stream.writable);assert.equal(await new Response(stream.readable).text(),'abc');await write;
  const bad=new LocalFixedLengthStream(4);const result=new Response(bad.readable).text();const writing=new Blob(['abc']).stream().pipeTo(bad.writable);const settled=await Promise.allSettled([result,writing]);assert.ok(settled.every(r=>r.status==='rejected'));
});

test('synchronous shared snapshot blocks same-connection and independent model writers until callback returns',async t=>{
 const {db,root}=fixture(t);await db.prepare("INSERT INTO site_settings(id,name) VALUES ('a','Before')").run();
 const other=new LocalDatabase(join(root,'db.sqlite'),resolve('drizzle'));t.after(()=>other.close());other.sqlite.exec('PRAGMA busy_timeout=1');
 let ran=false,queued,reader;
 const result=db.withSynchronousRead(read=>{
  reader=read;assert.equal(read.first('SELECT name FROM site_settings WHERE id=?','a').name,'Before');
  assert.equal(read.all('SELECT id FROM site_settings').length,1);
  queued=Promise.resolve().then(async()=>{ran=true;await db.batch([db.prepare("UPDATE site_settings SET name='Queued' WHERE id='a'")]);});
  assert.throws(()=>db.sqlite.prepare("UPDATE site_settings SET name='Reentrant' WHERE id='a'").run(),/readonly/i);
  assert.throws(()=>read.all("UPDATE site_settings SET name='Not a read' RETURNING id"),/readonly/i);
  assert.throws(()=>other.sqlite.prepare("UPDATE site_settings SET name='Other connection' WHERE id='a'").run(),/locked/i);
  assert.equal(ran,false);assert.equal(read.first('SELECT name FROM site_settings WHERE id=?','a').name,'Before');
  return 17;
 });
 assert.equal(result,17);assert.equal(ran,false);assert.throws(()=>reader.first('SELECT 1'),/active|closed/i);
 await queued;assert.equal((await db.prepare("SELECT name FROM site_settings WHERE id='a'").first()).name,'Queued');
 await other.prepare("UPDATE site_settings SET name='After guard' WHERE id='a'").run();
 assert.equal((await db.prepare("SELECT name FROM site_settings WHERE id='a'").first()).name,'After guard');
});
test('synchronous shared snapshot refuses async callbacks, releases failed guards and revokes escaped readers',async t=>{
 const {db}=fixture(t);let entered=false,reader;
 assert.throws(()=>db.withSynchronousRead(async()=>{entered=true;}),/synchronous/i);assert.equal(entered,false);
 assert.throws(()=>db.withSynchronousRead(read=>{reader=read;throw Error('injected');}),/injected/);
 assert.throws(()=>reader.all('SELECT 1'),/active|closed/i);
 assert.throws(()=>db.withSynchronousRead(()=>Promise.resolve(1)),/synchronous/i);
 assert.throws(()=>db.withSynchronousRead(()=>db.withSynchronousRead(()=>1)),/active|nested|transaction/i);
 await db.prepare("INSERT INTO site_settings(id,name) VALUES ('after','After failures')").run();
 assert.equal(db.withSynchronousRead(read=>read.first("SELECT name FROM site_settings WHERE id='after'").name),'After failures');
});

test('synchronous shared writer commits admission and changes atomically, blocks competing writers, and revokes handles',async t=>{
 const {db,root}=fixture(t),other=new LocalDatabase(join(root,'db.sqlite'),resolve('drizzle'));t.after(()=>other.close());other.sqlite.exec('PRAGMA busy_timeout=1');
 let handle,ran=false,queued,reentrant;
 const receipt=db.withSynchronousWrite(tx=>{
  handle=tx;assert.equal(tx.first("SELECT id FROM site_settings WHERE id='site'"),null);
  assert.equal(tx.run('INSERT INTO site_settings(id,name) VALUES (?,?)','site','Committed').changes,1);
  assert.equal(tx.all('SELECT id FROM site_settings').length,1);
  assert.throws(()=>other.sqlite.exec('BEGIN IMMEDIATE'),/locked/);
  assert.throws(()=>db.withSynchronousRead(()=>1),/active/);
  assert.throws(()=>db.withSynchronousWrite(()=>1),/active/);
  reentrant=db.prepare("UPDATE site_settings SET name='Reentrant'").run();
  queued=Promise.resolve().then(()=>{ran=true;return other.prepare("UPDATE site_settings SET name='Next writer'").run();});
  assert.equal(ran,false);return {id:'site'};
 });
 assert.deepEqual(receipt,{id:'site'});assert.equal(ran,false);assert.throws(()=>handle.first('SELECT 1'),/no longer active/);
 await assert.rejects(reentrant,/active synchronous writer/);await queued;assert.equal((await db.prepare("SELECT name FROM site_settings WHERE id='site'").first()).name,'Next writer');
});

test('synchronous shared writer rejects async callbacks and rolls back throws or thenable results',async t=>{
 const {db}=fixture(t);let entered=false,handle;
 assert.throws(()=>db.withSynchronousWrite(async()=>{entered=true;}),/synchronous/);assert.equal(entered,false);
 assert.throws(()=>db.withSynchronousWrite(tx=>{handle=tx;tx.run("INSERT INTO site_settings(id,name) VALUES ('site','Rolled back')");throw Error('injected');}),/injected/);
 assert.equal(await db.prepare('SELECT id FROM site_settings').first(),null);assert.throws(()=>handle.run("DELETE FROM site_settings"),/no longer active/);
 assert.throws(()=>db.withSynchronousWrite(tx=>{tx.run("INSERT INTO site_settings(id,name) VALUES ('site','Rolled back too')");return Promise.resolve(1);}),/synchronous/);
 assert.equal(await db.prepare('SELECT id FROM site_settings').first(),null);
 db.withSynchronousWrite(tx=>tx.run("INSERT INTO site_settings(id,name) VALUES ('site','After rollback')"));
 assert.equal((await db.prepare('SELECT name FROM site_settings').first()).name,'After rollback');
});
