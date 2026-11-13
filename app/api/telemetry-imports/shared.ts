import { currentImportId, stagePerformanceFile, commitPerformanceFile, retireFailedUpload, drainPerformanceFileCleanup, UploadConflictError } from "../../../db/single-performance-file";
import { depotCleanupInProgress } from "../../../db/depot-performance-cleanup";
import { meterMappingError } from "../../meter-mapping";
import { isValidTimezone } from "../../telemetry-time";
import { eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { getBucketBinding, getDatabaseBinding } from "../../../db/binding";
import { equipmentAssets, siteSettings, telemetryImports } from "../../../db/schema";

export const MAX_FILE_SIZE = 100 * 1024 * 1024;
export const MAX_CHUNKS = 256;
export const MAX_CHUNK_SIZE = 512 * 1024;

export type ImportMetadata = {
  fileName: string;
  fileSize: number;
  siteId: string;
  timezone: string;
  mapping: Record<string,string>;
  equipmentMapping: { signals?:Array<{ column?:string;equipmentId?:string;measurement?:string }>; unmatchedEquipmentIds?:unknown[] };
  detectedTypes: string[];
  validation: Record<string,unknown>;
  replacesImportId?: string;
};

export function csvHeaders(text:string){
  const headers:string[]=[];let cell="",quoted=false;
  for(let index=0;index<text.length;index+=1){const char=text[index];if(char==='"'){if(quoted&&text[index+1]==='"'){cell+='"';index+=1}else quoted=!quoted}else if(char===","&&!quoted){headers.push(cell.trim());cell=""}else if((char==="\n"||char==="\r")&&!quoted){headers.push(cell.trim());break}else cell+=char}
  if(!headers.length&&cell)headers.push(cell.trim());
  if(headers[0])headers[0]=headers[0].replace(/^\uFEFF/,"");
  return headers;
}

export function uploadIdIsValid(value:string){return /^[a-f0-9-]{20,64}$/i.test(value)}
export function chunkKey(uploadId:string,part:number){return `upload-parts/${uploadId}/${String(part).padStart(6,"0")}`}

export async function validateImport(metadata:ImportMetadata,uploadedHeaders:string[]){
  const {fileName,fileSize,siteId,timezone,mapping,equipmentMapping,validation}=metadata;
  if(!fileName||!siteId||!timezone)return "A site, timezone, and CSV file are required.";
  if(!isValidTimezone(timezone))return "Choose a valid IANA source timezone, such as America/New_York or UTC.";
  if(validation.timestampConvention !== undefined && validation.timestampConvention !== "start" && validation.timestampConvention !== "end")return "Select whether timestamps represent interval start or interval end.";
  if(validation.timezone !== undefined && validation.timezone !== timezone)return "Validate the CSV again with the selected source timezone.";
  const [site]=await getDb().select({id:siteSettings.id}).from(siteSettings).where(eq(siteSettings.id,siteId)).limit(1);
  if(!site)return "This site is not available.";
  if(!fileName.toLowerCase().endsWith(".csv"))return "Only CSV files can be imported.";
  if(!fileSize||fileSize>MAX_FILE_SIZE)return "CSV files must be between 1 byte and 100 MB.";
  if(!mapping.timestamp)return "A timestamp mapping is required.";
  if(Number(validation.errors||0)>0)return "Resolve validation errors before importing.";
  const signals=Array.isArray(equipmentMapping.signals)?equipmentMapping.signals:[];
  if(signals.some(signal=>signal.equipmentId&&signal.measurement==="Cumulative energy")||Number(validation.cumulativeEnergySignals||0)>0)return "Cumulative energy readings must be converted to interval energy (kWh) before import. Map interval readings as Energy.";
  const allowedColumns=new Set([...Object.values(mapping).filter(Boolean),...signals.filter(item=>item.equipmentId&&item.column).map(item=>item.column as string)]);
  if(!uploadedHeaders.includes(mapping.timestamp))return "The filtered CSV must include its mapped timestamp column.";
  const unexpectedColumns=uploadedHeaders.filter(header=>!allowedColumns.has(header));
  if(unexpectedColumns.length)return `The CSV still contains unmapped columns: ${unexpectedColumns.slice(0,5).join(", ")}. Return to mapping and try again.`;
  if([...allowedColumns].some(column=>!uploadedHeaders.includes(column)))return "One or more mapped columns are missing from the filtered CSV.";
  const configured=await getDb().select().from(equipmentAssets).where(eq(equipmentAssets.siteId,siteId));
  const meterError=meterMappingError(configured,mapping,signals);
  if(meterError)return meterError;
  const assignedIds=[...new Set(signals.map(item=>item.equipmentId).filter((value):value is string=>!!value))];
  if(assignedIds.length){
    const known=new Set(configured.map(item=>item.id));
    if(assignedIds.some(id=>!known.has(id)))return "One or more equipment assignments no longer exist in this site configuration. Review the mappings and try again.";
  }
  return "";
}

export async function retainImport(metadata:ImportMetadata,body:ReadableStream<Uint8Array>,uploadedHeaders:string[]){
  const {fileName,fileSize,siteId,timezone,mapping,equipmentMapping,detectedTypes,validation}=metadata;
  if (await depotCleanupInProgress(getDatabaseBinding(),siteId)) throw new Error("Depot performance data is being removed. Retry the upload after cleanup completes.");
  const database=getDatabaseBinding();
  const previousId=await currentImportId(database,siteId);
  if(metadata.replacesImportId!==undefined&&metadata.replacesImportId!==previousId)throw new UploadConflictError("The current file changed. Refresh the upload page before replacing it.");
  const id=crypto.randomUUID();const date=new Date();
  const safeName=fileName.replace(/[^a-zA-Z0-9._-]/g,"-").slice(-120);
  const objectKey=`mapped/${siteId}/${date.getUTCFullYear()}/${String(date.getUTCMonth()+1).padStart(2,"0")}/${id}-${safeName}`;
  const bucket=getBucketBinding();
  await stagePerformanceFile(database,siteId,objectKey);
  try{await bucket.put(objectKey,body,{httpMetadata:{contentType:"text/csv"},customMetadata:{siteId,importId:id,timezone,columnCount:String(uploadedHeaders.length)}});}
  catch(error){await retireFailedUpload(database,objectKey).catch(()=>undefined);throw error;}
  const record={id,siteId,fileName,objectKey,fileSize,rowCount:Number(validation.totalRows||0),validRows:Number(validation.validRows||0),warningCount:Number(validation.warnings||0),errorCount:Number(validation.errors||0),status:"imported",timezone,mapping:JSON.stringify({roles:mapping,equipment:equipmentMapping}),detectedTypes:JSON.stringify(detectedTypes),validation:JSON.stringify(validation),timestampStart:String(validation.start||"")||null,timestampEnd:String(validation.end||"")||null,createdAt:date.toISOString()};
  try{await commitPerformanceFile(database,record,previousId);}
  catch(error){
    // A lost acknowledgement can follow a successful commit. Never delete the
    // new object until the database confirms it did not become the current file.
    const committed=await database.prepare("SELECT id FROM telemetry_imports WHERE id = ? AND site_id = ?").bind(id,siteId).first();
    if(!committed){await retireFailedUpload(database,objectKey).catch(()=>undefined);throw error;}
  }
  await drainPerformanceFileCleanup(database,bucket).catch(()=>undefined);
  return record;
}
