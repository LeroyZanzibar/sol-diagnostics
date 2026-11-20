import {after} from 'node:test';
import {resolve} from 'node:path';
import {LocalDatabase} from '../selfhost/storage.mjs';

// Existing review controller fixtures keep their synthetic analysis payloads,
// but admission/decision/audit writes now exercise the production SQLite adapter.
export function reviewDatabase(runIds=[]){
 const db=new LocalDatabase(':memory:',resolve('drizzle'));after(()=>db.close());
 for(const id of runIds)db.sqlite.prepare("INSERT INTO analysis_runs(id,site_id,import_id,parser_version,model_revision,status,analysis_object_key) VALUES (?,'site','input',28,'model','completed',?)").run(id,`analysis/${id}/result.json`);
 let reads=0,maxBatch=0;
 const prepare=db.prepare.bind(db),write=db.withSynchronousWrite.bind(db),batch=db.batch.bind(db);
 const counted=statement=>new Proxy(statement,{get(target,key){
  if(key==='bind')return (...values)=>counted(target.bind(...values));
  if(key==='first'||key==='all')return (...args)=>{reads++;return target[key](...args);};
  const value=target[key];return typeof value==='function'?value.bind(target):value;
 }});
 db.prepare=sql=>counted(prepare(sql));
 db.withSynchronousWrite=operation=>write(tx=>{
  let writes=0;const result=operation({...tx,first:(...args)=>{reads++;return tx.first(...args);},all:(...args)=>{reads++;return tx.all(...args);},run:(...args)=>{writes++;return tx.run(...args);}});
  maxBatch=Math.max(maxBatch,writes);return result;
 });
 db.batch=statements=>{maxBatch=Math.max(maxBatch,statements.length);return batch(statements);};
 Object.defineProperties(db,{reads:{get:()=>reads},maxBatch:{get:()=>maxBatch}});
 return db;
}
