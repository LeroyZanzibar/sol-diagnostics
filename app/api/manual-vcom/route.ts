import { readBoundedJson } from '../../performance-ingest';
import { performanceJson, requiredText } from '../performance-data/service';
import { manualVcomWorkspace, mutateManualVcom, manualVcomError } from './controller';
export async function GET(request:Request) {
  try { const query=new URL(request.url).searchParams;return performanceJson(await manualVcomWorkspace(requiredText(query.get('siteId'),'site ID'),query.has('jobId')?requiredText(query.get('jobId'),'job ID'):undefined)); }
  catch(error){return manualVcomError(error);}
}
export async function POST(request:Request) {
  try {
    const actor=request.headers.get('oai-authenticated-user-email')||request.headers.get('oai-authenticated-user-id');
    if(!actor)return performanceJson({error:'An authenticated actor is required.',code:'authentication-required'},401);
    const payload=await readBoundedJson(request,2*1024*1024);
    return performanceJson(await mutateManualVcom(payload,actor),payload.action==='start'?202:200);
  }catch(error){return manualVcomError(error);}
}
