import { UploadConflictError } from "../../../../db/single-performance-file";
import { getBucketBinding } from "../../../../db/binding";
import { chunkKey, csvHeaders, MAX_CHUNKS, MAX_FILE_SIZE, retainImport, uploadIdIsValid, validateImport, type ImportMetadata } from "../shared";

type FinalizeRequest=ImportMetadata&{uploadId:string;totalChunks:number};

function concatenate(parts:R2ObjectBody[]){
  let index=0;let reader:ReadableStreamDefaultReader<Uint8Array>|null=null;
  return new ReadableStream<Uint8Array>({
    async pull(controller){
      while(index<parts.length){reader??=parts[index].body.getReader();const result=await reader.read();if(!result.done){controller.enqueue(result.value);return}reader.releaseLock();reader=null;index+=1}
      controller.close();
    },
    async cancel(reason){if(reader)await reader.cancel(reason)}
  });
}

function fixedLengthStream(length:number){
  const Stream=(globalThis as unknown as {FixedLengthStream:new(length:number)=>{readable:ReadableStream<Uint8Array>;writable:WritableStream<Uint8Array>}}).FixedLengthStream;
  if(!Stream)throw new Error("The upload service could not prepare the completed CSV stream.");
  return new Stream(length);
}

export async function POST(request:Request){
  const bucket=getBucketBinding();let temporaryKeys:string[]=[];
  try{
    const payload=await request.json() as FinalizeRequest;
    if(!uploadIdIsValid(payload.uploadId)||!Number.isInteger(payload.totalChunks)||payload.totalChunks<1||payload.totalChunks>MAX_CHUNKS)return Response.json({error:"Invalid chunked upload."},{status:400});
    if(!Number.isFinite(payload.fileSize)||payload.fileSize<1||payload.fileSize>MAX_FILE_SIZE)return Response.json({error:"CSV files must be between 1 byte and 100 MB."},{status:400});
    temporaryKeys=Array.from({length:payload.totalChunks},(_,index)=>chunkKey(payload.uploadId,index+1));
    const first=await bucket.get(temporaryKeys[0]);
    if(!first)return Response.json({error:"The first CSV chunk is missing. Please retry the import."},{status:400});
    const uploadedHeaders=csvHeaders(await first.text());
    const validationError=await validateImport(payload,uploadedHeaders);
    if(validationError)return Response.json({error:validationError},{status:400});
    const parts:R2ObjectBody[]=[];let totalSize=0;
    for(const key of temporaryKeys){const part=await bucket.get(key);if(!part)return Response.json({error:"One or more CSV chunks are missing. Please retry the import."},{status:400});parts.push(part);totalSize+=part.size}
    if(totalSize!==payload.fileSize)return Response.json({error:"The uploaded CSV size did not match the source file. Please retry the import."},{status:400});
    const fixed=fixedLengthStream(totalSize);const piping=concatenate(parts).pipeTo(fixed.writable);
    const record=await retainImport(payload,fixed.readable,uploadedHeaders);
    await piping;
    const completedKeys=temporaryKeys;temporaryKeys=[];
    await bucket.delete(completedKeys).catch(()=>undefined);
    return Response.json({import:record},{status:201});
  }catch(error){return Response.json({error:error instanceof Error?error.message:"Unable to finalize the CSV import."},{status:error instanceof UploadConflictError?409:500})}
  finally{if(temporaryKeys.length)await bucket.delete(temporaryKeys).catch(()=>undefined)}
}
