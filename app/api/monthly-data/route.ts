import {getMonthlyRuntime} from '../../../db/monthly';
import {readMonthlyConfirmedLoss} from './confirmed-loss';
import {MonthlyError,validateConfiguration,validateUtilityRows} from '../../monthly-domain.mjs';
export const dynamic='force-dynamic';
const respond=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'private, no-store'}});
function failure(error:unknown){
  // Native runtime adapters and bundled routes have distinct class identities.
  const e=error as {name?:string;status?:number;code?:string;message?:string};
  const known=e?.name==='MonthlyError'&&[400,404,409,413].includes(e.status||0)&&typeof e.code==='string'&&typeof e.message==='string';
  return known?respond({error:e.message,code:e.code},e.status):respond({error:'Unable to complete the monthly operation. Read saved data to verify any uncertain save outcome.'},500);
}
async function readSnapshot(siteId:string){
  const snapshot=await getMonthlyRuntime().read(siteId);
  return {...snapshot,confirmedLoss:await readMonthlyConfirmedLoss(siteId)};
}
export async function GET(request:Request){try{return respond(await readSnapshot(new URL(request.url).searchParams.get('siteId')||''));}catch(error){return failure(error);}}
export async function POST(request:Request){
  try{
    const reader=request.body?.getReader();if(!reader)throw new MonthlyError('A JSON body is required.');let size=0,text='';const decoder=new TextDecoder('utf-8',{fatal:true});
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>256*1024)throw new MonthlyError('Monthly request exceeds 256 KiB.',413);text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    let data;try{data=JSON.parse(text);}catch{throw new MonthlyError('Send a valid JSON request.');}
    if(!data||typeof data.siteId!=='string')throw new MonthlyError('An exact site ID is required.');
    const runtime=getMonthlyRuntime(),{siteId,revision,action}=data;
    if(action==='utility')runtime.inputs.saveUtility(siteId,revision,validateUtilityRows(data.rows));
    else if(action==='preview'||action==='configuration'){
      const configuration=validateConfiguration(data.configuration);await runtime.validateSelection(siteId,configuration);
      if(action==='preview')return respond(runtime.inputs.preview(siteId,revision,configuration));
      runtime.inputs.saveConfiguration(siteId,revision,configuration,data.previewToken);
    }else throw new MonthlyError('Choose a supported monthly action.');
    // The client also performs an independent GET. No fictitious cross-DB save.
    return respond(await readSnapshot(siteId));
  }catch(error){return failure(error);}
}
