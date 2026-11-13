import {DatabaseSync} from 'node:sqlite';
import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync, readFileSync, readdirSync} from 'node:fs';
import {open, rename, unlink, readdir} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {Readable} from 'node:stream';

// Implements the D1 subset used by the existing application, including Drizzle's
// raw positional rows and atomic batches. Analysis SQL and calculations stay intact.
export class LocalDatabase {
  constructor(filename, migrations) {
    this.sqlite=new DatabaseSync(filename);
    this.sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.sqlite.exec('CREATE TABLE IF NOT EXISTS __sol_migrations(name TEXT PRIMARY KEY, hash TEXT NOT NULL)');
    for(const name of readdirSync(migrations).filter(n=>/^\d+.*\.sql$/.test(n)).sort()){
      const sql=readFileSync(join(migrations,name),'utf8'),hash=createHash('sha256').update(sql).digest('hex');
      const applied=this.sqlite.prepare('SELECT hash FROM __sol_migrations WHERE name=?').get(name);
      if(applied){if(applied.hash!==hash)throw Error(`Applied migration changed: ${name}. Restore the matching application version.`);continue;}
      this.sqlite.exec('BEGIN IMMEDIATE');
      try{this.sqlite.exec(sql);this.sqlite.prepare('INSERT INTO __sol_migrations VALUES (?,?)').run(name,hash);this.sqlite.exec('COMMIT');}
      catch(error){this.sqlite.exec('ROLLBACK');throw error;}
    }
    this.sqlite.exec('CREATE TABLE IF NOT EXISTS __sol_objects(key TEXT PRIMARY KEY,path TEXT NOT NULL,size INTEGER NOT NULL,etag TEXT NOT NULL,uploaded TEXT NOT NULL,http TEXT NOT NULL,custom TEXT NOT NULL)');
  }
  prepare(sql){return new LocalStatement(this,sql,[]);}
  async batch(statements){
    // No await inside the transaction: another request cannot join a partial batch.
    this.sqlite.exec('BEGIN IMMEDIATE');
    try{const results=statements.map(s=>{if(s.db!==this)throw Error('Mixed database batch');return s.execute('all');});this.sqlite.exec('COMMIT');return results;}
    catch(error){this.sqlite.exec('ROLLBACK');throw error;}
  }
  async exec(sql){this.sqlite.exec(sql);return {count:1,duration:0};}
  close(){this.sqlite.close();}
}
class LocalStatement {
  constructor(db,sql,values){Object.assign(this,{db,sql,values});}
  bind(...values){return new LocalStatement(this.db,this.sql,values.map(v=>v===undefined?null:typeof v==='boolean'?Number(v):v instanceof ArrayBuffer?new Uint8Array(v):v));}
  execute(mode){
    const start=performance.now(),stmt=this.db.sqlite.prepare(this.sql);
    if(mode==='raw'){stmt.setReturnArrays(true);return stmt.all(...this.values);}
    const columns=stmt.columns();
    const rows=columns.length?stmt.all(...this.values):[];
    const changes=columns.length?{changes:0,lastInsertRowid:0}:stmt.run(...this.values);
    return {success:true,results:rows,meta:{changes:Number(changes.changes),last_row_id:Number(changes.lastInsertRowid),duration:performance.now()-start,rows_read:rows.length,rows_written:Number(changes.changes)}};
  }
  async all(){return this.execute('all');}
  async run(){return this.execute('run');}
  async first(column){const row=this.execute('all').results[0];return row?(column===undefined?row:row[column]??null):null;}
  async raw(options){const rows=this.execute('raw');if(options?.columnNames)rows.unshift(this.db.sqlite.prepare(this.sql).columns().map(c=>c.name));return rows;}
}

export class LocalBucket {
  constructor(db,directory){this.db=db;this.directory=resolve(directory);mkdirSync(this.directory,{recursive:true});}
  validate(key){if(typeof key!=='string'||!key||Buffer.byteLength(key)>1024)throw Error('Invalid storage key');return key;}
  metadata(row){return {key:row.key,size:row.size,etag:row.etag,httpEtag:`"${row.etag}"`,uploaded:new Date(row.uploaded),httpMetadata:JSON.parse(row.http),customMetadata:JSON.parse(row.custom)};}
  async put(key,value,options={}){
    this.validate(key);
    const filename=randomUUID(),temporary=join(this.directory,filename+'.tmp'),target=join(this.directory,filename);
    let source;
    if(typeof value==='string'||value instanceof ArrayBuffer||ArrayBuffer.isView(value))source=Readable.from([typeof value==='string'?Buffer.from(value):value instanceof ArrayBuffer?Buffer.from(value):Buffer.from(value.buffer,value.byteOffset,value.byteLength)]);
    else if(value instanceof Blob)source=value.stream();
    else if(value?.getReader)source=value;
    else throw Error('Unsupported storage body');
    const hash=createHash('sha256');let size=0;
    let handle;
    try{
      handle=await open(temporary,'wx',0o600);
      for await(const chunk of source){
        size+=chunk.length;hash.update(chunk);
        for(let offset=0;offset<chunk.length;){const written=await handle.write(chunk,offset,chunk.length-offset);if(!written.bytesWritten)throw Error('File write made no progress');offset+=written.bytesWritten;}
      }
      await handle.sync();await handle.close();handle=null;
      await rename(temporary,target);
      const dir=await open(this.directory,'r');try{await dir.sync();}finally{await dir.close();}
      const old=this.db.sqlite.prepare('SELECT path FROM __sol_objects WHERE key=?').get(key);
      const row={key,path:filename,size,etag:hash.digest('hex'),uploaded:new Date().toISOString(),http:JSON.stringify(options.httpMetadata||{}),custom:JSON.stringify(options.customMetadata||{})};
      this.db.sqlite.prepare('INSERT INTO __sol_objects VALUES (?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET path=excluded.path,size=excluded.size,etag=excluded.etag,uploaded=excluded.uploaded,http=excluded.http,custom=excluded.custom').run(...Object.values(row));
      if(old)await unlink(join(this.directory,old.path)).catch(()=>{});
      return this.metadata(row);
    }catch(error){await handle?.close().catch(()=>{});await unlink(temporary).catch(()=>{});await unlink(target).catch(()=>{});throw error;}
  }
  async head(key){const row=this.db.sqlite.prepare('SELECT * FROM __sol_objects WHERE key=?').get(this.validate(key));return row?this.metadata(row):null;}
  async get(key){
    // Open before yielding to another request's replacement/delete. Existing readers
    // retain the old inode while all new readers see the committed object version.
    this.validate(key);
    for(let attempt=0;attempt<3;attempt++){
      const row=this.db.sqlite.prepare('SELECT * FROM __sol_objects WHERE key=?').get(key);if(!row)return null;
      let file;try{file=await open(join(this.directory,row.path),'r');}catch(error){if(error.code==='ENOENT')continue;throw error;}
      const body=Readable.toWeb(file.createReadStream()),response=new Response(body);
      return {...this.metadata(row),body:response.body,get bodyUsed(){return response.bodyUsed;},text:()=>response.text(),json:()=>response.json(),arrayBuffer:()=>response.arrayBuffer(),writeHttpMetadata(headers){for(const [key,value] of Object.entries(JSON.parse(row.http)))headers.set(key.replace(/[A-Z]/g,m=>'-'+m.toLowerCase()),value);}};
    }
    throw Error('Stored object changed repeatedly; retry this operation.');
  }
  async delete(keys){for(const key of Array.isArray(keys)?keys:[keys]){this.validate(key);const row=this.db.sqlite.prepare('SELECT path FROM __sol_objects WHERE key=?').get(key);this.db.sqlite.prepare('DELETE FROM __sol_objects WHERE key=?').run(key);if(row)await unlink(join(this.directory,row.path)).catch(error=>{if(error.code!=='ENOENT')throw error;});}}
  async list({prefix='',cursor='',limit=1000}={}){
    limit=Math.max(1,Math.min(1000,Number(limit)||1000));
    const after=cursor?Buffer.from(cursor,'base64url').toString('utf8'):'';
    const rows=this.db.sqlite.prepare('SELECT * FROM __sol_objects WHERE substr(key,1,?)=? AND key>? ORDER BY key LIMIT ?').all(prefix.length,prefix,after,limit+1);
    const truncated=rows.length>limit,objects=rows.slice(0,limit).map(row=>this.metadata(row));
    return {objects,truncated,cursor:truncated?Buffer.from(objects.at(-1).key).toString('base64url'):undefined,delimitedPrefixes:[]};
  }
  async collectOrphans(){const retained=new Set(this.db.sqlite.prepare('SELECT path FROM __sol_objects').all().map(r=>r.path));for(const name of await readdir(this.directory))if(!retained.has(name))await unlink(join(this.directory,name));}
}

export class LocalFixedLengthStream extends TransformStream {
  constructor(length){let seen=0;super({transform(chunk,controller){seen+=chunk.byteLength;if(seen>length)throw Error('Upload exceeded its declared length');controller.enqueue(chunk);},flush(){if(seen!==length)throw Error('Upload did not match its declared length');}});}
}
