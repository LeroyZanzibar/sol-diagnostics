// Stream large checkpoints in small JSON records. Compression bounds the R2 write
// buffer; reading records separately avoids a second full-size JSON string.
type StoredObject={body:ReadableStream<Uint8Array<ArrayBuffer>>;customMetadata?:Record<string,string>;json<T>():Promise<T>};
type Bucket={put(key:string,value:Uint8Array,options?:any):Promise<any>};
const FORMAT='gzip-json-records-v1';
const CHUNK=25;
type Part={path:string[];values:unknown[]};
function split(value:any,path:string[],parts:Part[]):any{
 if(Array.isArray(value)&&value.length>CHUNK){parts.push({path,values:value});return [];}
 if(value&&typeof value==='object'&&!Array.isArray(value))return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,split(item,[...path,key],parts)]));
 return value;
}
function byteStream(parts:Iterable<string>){
 const iterator=parts[Symbol.iterator](),encoder=new TextEncoder();
 return new ReadableStream<Uint8Array<ArrayBuffer>>({pull(controller){const next=iterator.next();if(next.done)controller.close();else controller.enqueue(encoder.encode(next.value));},cancel(){iterator.return?.();}});
}
export async function writeCheckpoint(bucket:Bucket,key:string,value:unknown,options:any={}){
 const parts:Part[]=[];const base=split(value,[],parts);
 function* records(){yield JSON.stringify({format:FORMAT,value:base})+'\n';for(const part of parts)for(let start=0;start<part.values.length;start+=CHUNK)yield JSON.stringify({path:part.path,values:part.values.slice(start,start+CHUNK)})+'\n';}
 const compressed=byteStream(records()).pipeThrough(new CompressionStream('gzip'));
 const bytes=new Uint8Array(await new Response(compressed).arrayBuffer());
 return bucket.put(key,bytes,{...options,httpMetadata:{contentType:'application/octet-stream'},customMetadata:{...options.customMetadata,checkpointFormat:FORMAT}});
}
export async function readCheckpoint<T>(object:StoredObject):Promise<T>{
 if(object.customMetadata?.checkpointFormat!==FORMAT)return object.json<T>();
 const reader=object.body.pipeThrough(new DecompressionStream('gzip')).getReader(),decoder=new TextDecoder();
 let pending='',value:any;const strings=new Map<string,string>();
 const intern=(item:any):any=>{if(typeof item==='string'){const cached=strings.get(item);if(cached!==undefined)return cached;strings.set(item,item);return item;}if(Array.isArray(item)){for(let i=0;i<item.length;i++)item[i]=intern(item[i]);}else if(item&&typeof item==='object')for(const key of Object.keys(item))item[key]=intern(item[key]);return item;};
 const consume=(line:string)=>{if(!line)return;const record=JSON.parse(line);if(value===undefined){if(record.format!==FORMAT)throw new Error('Unsupported analysis checkpoint.');value=intern(record.value);}else{let target=value;for(const key of record.path)target=target[key];for(const item of record.values)target.push(intern(item));}};
 try{for(;;){const next=await reader.read();if(next.done)break;pending+=decoder.decode(next.value,{stream:true});let end;while((end=pending.indexOf('\n'))>=0){consume(pending.slice(0,end));pending=pending.slice(end+1);}}pending+=decoder.decode();consume(pending);}finally{reader.releaseLock();}
 return value as T;
}
// The browser receives ordinary JSON. Only the server's transient serialization
// buffer is bounded; public response fields and calculations stay unchanged.
export function analysisJsonResponse(value:any,init:ResponseInit={}){
 function* json(item:any):Generator<string>{
  if(Array.isArray(item)&&item.length>CHUNK){yield '[';for(let start=0;start<item.length;start+=CHUNK){if(start)yield ',';const part=JSON.stringify(item.slice(start,start+CHUNK));yield part.slice(1,-1);}yield ']';}
  else if(item&&typeof item==='object'&&!Array.isArray(item)){yield '{';let first=true;for(const [key,child] of Object.entries(item)){if(child===undefined)continue;if(!first)yield ',';first=false;yield JSON.stringify(key)+':';yield* json(child);}yield '}';}
  else yield JSON.stringify(item)??'null';
 }
 const headers=new Headers(init.headers);headers.set('Content-Type','application/json');
 return new Response(byteStream(json(value)),{...init,headers});
}
