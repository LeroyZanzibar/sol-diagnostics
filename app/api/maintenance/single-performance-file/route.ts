import { getDatabaseBinding,getBucketBinding } from "../../../../db/binding";
import { adoptSinglePerformanceFile,drainPerformanceFileCleanup } from "../../../../db/single-performance-file";
const headers={"Cache-Control":"private, no-store"};
export async function POST(request:Request){try{
 const payload=await request.json();
 if(payload.confirm!=="one-performance-file-per-site")return Response.json({error:"Exact operation confirmation is required."},{status:400,headers});
 if(typeof payload.siteId!=="string"||typeof payload.keepId!=="string")return Response.json({error:"A site and retained file are required."},{status:400,headers});
 const adopted=await adoptSinglePerformanceFile(getDatabaseBinding(),payload.siteId,payload.keepId);
 return Response.json({...adopted,cleanup:await drainPerformanceFileCleanup(getDatabaseBinding(),getBucketBinding())},{headers});
}catch(error){return Response.json({error:error instanceof Error?error.message:"Unable to keep the current file."},{status:409,headers});}}
