import { getBucketBinding } from "../../../../db/binding";
import { chunkKey, MAX_CHUNK_SIZE, uploadIdIsValid } from "../shared";

export async function PUT(request:Request){
  try{
    const url=new URL(request.url);const uploadId=url.searchParams.get("uploadId")||"";const part=Number(url.searchParams.get("part"));
    if(!uploadIdIsValid(uploadId)||!Number.isInteger(part)||part<1||part>256)return Response.json({error:"Invalid upload chunk."},{status:400});
    const declaredSize=Number(request.headers.get("content-length")||0);
    if(declaredSize>MAX_CHUNK_SIZE)return Response.json({error:"Upload chunks cannot exceed 512 KB."},{status:413});
    const body=await request.arrayBuffer();
    if(!body.byteLength||body.byteLength>MAX_CHUNK_SIZE)return Response.json({error:"Upload chunks must be between 1 byte and 512 KB."},{status:400});
    await getBucketBinding().put(chunkKey(uploadId,part),body,{httpMetadata:{contentType:"application/octet-stream"}});
    return Response.json({part,size:body.byteLength},{status:201});
  }catch(error){return Response.json({error:error instanceof Error?error.message:"Unable to upload this CSV chunk."},{status:500})}
}

export async function DELETE(request:Request){
  try{
    const uploadId=new URL(request.url).searchParams.get("uploadId")||"";
    if(!uploadIdIsValid(uploadId))return Response.json({error:"Invalid upload identifier."},{status:400});
    const bucket=getBucketBinding();let cursor:string|undefined;const keys:string[]=[];
    do{const page=await bucket.list({prefix:`upload-parts/${uploadId}/`,cursor});keys.push(...page.objects.map(item=>item.key));cursor=page.truncated?page.cursor:undefined}while(cursor);
    if(keys.length)await bucket.delete(keys);
    return Response.json({deleted:keys.length});
  }catch(error){return Response.json({error:error instanceof Error?error.message:"Unable to clean up upload chunks."},{status:500})}
}
