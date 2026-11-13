import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
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
  const second=new LocalDatabase(join(root,'db.sqlite'),resolve('drizzle'));assert.equal((await second.prepare('SELECT COUNT(*) n FROM __sol_migrations').first()).n,19);second.close();
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
