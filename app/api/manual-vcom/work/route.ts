import { getManualVcomRuntime } from '../../../../db/manual-vcom';
import { performanceJson } from '../../performance-data/service';
import { workManualVcom, manualVcomError } from '../controller';
export async function POST(request:Request) {
  try{
    const runtime=getManualVcomRuntime();
    if(!request.headers.get('oai-authenticated-user-id')||!runtime.verifyWorker(request.headers.get('x-sol-vcom-worker')))return performanceJson({error:'Private server worker authentication is required.',code:'worker-forbidden'},403);
    return performanceJson(await (runtime.runWork?runtime.runWork(()=>workManualVcom(request.signal)):workManualVcom(request.signal)));
  }catch(error){return manualVcomError(error);}
}
