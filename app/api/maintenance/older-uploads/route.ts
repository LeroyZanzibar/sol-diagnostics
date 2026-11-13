import { getBucketBinding,getDatabaseBinding } from "../../../../db/binding";
import { OLDER_UPLOAD_CLEANUP,olderUploadInventory,removeOlderUpload } from "../../../../db/older-upload-cleanup";
const headers={"Cache-Control":"private, no-store"};
export async function GET(){try{return Response.json(await olderUploadInventory(getDatabaseBinding(),getBucketBinding()),{headers});}catch(error){return Response.json({error:error instanceof Error?error.message:"Unable to inspect uploads."},{status:500,headers});}}
export async function DELETE(request:Request){try{
  const payload=await request.json();
  if(payload.confirm!==OLDER_UPLOAD_CLEANUP||typeof payload.importId!=="string")return Response.json({error:"Exact cleanup confirmation and upload ID are required."},{status:400,headers});
  return Response.json(await removeOlderUpload(getDatabaseBinding(),getBucketBinding(),payload.importId),{headers});
}catch(error){return Response.json({error:error instanceof Error?error.message:"Cleanup paused; retry safely."},{status:409,headers});}}
