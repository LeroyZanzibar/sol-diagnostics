"use client";
import ImportProfiles from "./ImportProfiles";
import type {PerformanceDataset,PerformancePreview,PerformanceImportAudit} from '../db/performance-store';
import { isValidTimezone, type TimestampConvention } from "./telemetry-time";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent, PointerEvent as ReactPointerEvent } from "react";
import type { EquipmentAsset } from "./equipment";
import { CsvProcessor } from "./csv-worker-client";
import { uploadCsvParts } from "./upload-parts";
import { normalized, signalColumnsFor, suggestedMeasurement, suggestSignal, autoMapping, detectCsvFormat, detectTypes,
  type Mapping, type SignalMapping, type CsvFormat, type Validation } from "./telemetry-csv";

type ManagedSite = { id: string; name: string; location: string };
type ImportRecord = {
  id: string; siteId: string; fileName: string; fileSize: number; rowCount: number; validRows: number;
  warningCount: number; errorCount: number; status: string; detectedTypes: string; timestampStart: string | null;
  timestampEnd: string | null; createdAt: string; timezone?: string; validation?: string;
};

const EMPTY_MAPPING: Mapping = { timestamp: "", expectedProduction: "", equipment: "", measurement: "", value: "", unit: "" };
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const DIRECT_UPLOAD_LIMIT = 512 * 1024;
const measurements = ["Active power","DC power","Energy","Cumulative energy","POA irradiance","GHI irradiance","Module temperature","Ambient temperature","Wind speed","Availability","Status","Snow code","Other"];

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value: string | null, timezone?: string) {
  if (!value) return "—";
  if(!Number.isFinite(Date.parse(value)))return 'Unknown';
  return new Intl.DateTimeFormat("en", { month:"short", day:"numeric", year:"numeric", ...(timezone&&isValidTimezone(timezone) ? { timeZone: timezone } : {}) }).format(new Date(value));
}

async function readApiResponse(response:Response){
  const text=await response.text();let data:Record<string,unknown>={};
  if(text){try{data=JSON.parse(text) as Record<string,unknown>}catch{data={error:text}}}
  if(!response.ok)throw Object.assign(new Error(typeof data.error==="string"?data.error:`Import failed (${response.status}).`),{status:response.status});
  return data;
}

function createUploadId(){
  if(typeof crypto.randomUUID==="function")return crypto.randomUUID();
  const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);
  return [...bytes].map(value=>value.toString(16).padStart(2,"0")).join("");
}

export default function TelemetryUploads({ sites, initialSiteId, onBack, notify, onImported }: { sites: ManagedSite[]; initialSiteId?:string; onBack: () => void; notify: (message: string) => void; onImported?:(siteId:string)=>void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const processorRef = useRef<CsvProcessor | null>(null);
  const equipmentRef = useRef<EquipmentAsset[]>([]);
  useEffect(() => () => { processorRef.current?.close(); processorRef.current = null; }, []);
  const [step, setStep] = useState(1);
  const [siteId, setSiteId] = useState(initialSiteId || sites[0]?.id || "");
  const [timezone, setTimezone] = useState("");
  const [timestampConvention, setTimestampConvention] = useState<TimestampConvention>("start");
  const timezoneOptions = useMemo(() => {
    try { return ["UTC", ...Intl.supportedValuesOf("timeZone")]; }
    catch { return ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "Europe/Berlin", "Asia/Tokyo"]; }
  }, []);
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  // Only the preview reaches React; the worker owns the full dataset.
  const [rows, setRows] = useState<string[][]>([]);
  const [rowCount, setRowCount] = useState(0);
  const [mapping, setMapping] = useState<Mapping>(EMPTY_MAPPING);
  const [formatOverride,setFormatOverride] = useState<CsvFormat|null>(null);
  const [detectedTypes, setDetectedTypes] = useState<string[]>([]);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [equipment,setEquipment] = useState<EquipmentAsset[]>([]);
  const [equipmentLoading, setEquipmentLoading] = useState(true);
  const [signalMappings,setSignalMappings] = useState<SignalMapping[]>([]);
  const [currentFile, setCurrentFile] = useState<ImportRecord|null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadProgress,setUploadProgress]=useState(0);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [dataset,setDataset]=useState<PerformanceDataset|null>(null);
  const [datasetLoading,setDatasetLoading]=useState(true);
  const [datasetError,setDatasetError]=useState('');
  const [datasetRevision,setDatasetRevision]=useState(0);
  const [imports,setImports]=useState<PerformanceImportAudit[]>([]);
  const [requiresMigration,setRequiresMigration]=useState(false);
  const [pendingPreview,setPendingPreview]=useState<PerformancePreview|null>(null);
  const [approveOverlap,setApproveOverlap]=useState(false);
  const [previewConflict,setPreviewConflict]=useState(false);
  const [commitUncertain,setCommitUncertain]=useState(false);
  const requestEpoch=useRef(0),operationBusy=useRef(false),currentSiteRef=useRef(siteId);
  currentSiteRef.current=siteId;
  const [mapColumnWidths,setMapColumnWidths] = useState([220,220,190,70]);
  const columnResizeRef=useRef<{index:number;startX:number;startWidth:number;pointerId:number}|null>(null);
  const selectedSite = sites.find(site => site.id === siteId);
  const detectedFormat=useMemo(()=>detectCsvFormat(headers,mapping),[headers,mapping]);
  const fileFormat=formatOverride||detectedFormat;
  const effectiveMapping=useMemo<Mapping>(()=>fileFormat==="wide"?{...EMPTY_MAPPING,timestamp:mapping.timestamp,expectedProduction:mapping.expectedProduction,unit:mapping.unit}:mapping,[fileFormat,mapping]);
  const activeSignalMappings=useMemo(()=>fileFormat==="long"?[]:signalMappings,[fileFormat,signalMappings]);

  const mappedSignalMappings=useMemo(()=>activeSignalMappings.filter(item=>item.equipmentId),[activeSignalMappings]);
  const retainedHeaders=useMemo(()=>{const retained=new Set([...Object.values(effectiveMapping).filter(Boolean),...mappedSignalMappings.map(item=>item.column)]);return headers.filter(header=>retained.has(header))},[headers,effectiveMapping,mappedSignalMappings]);
  const excludedHeaders=useMemo(()=>headers.filter(header=>!retainedHeaders.includes(header)),[headers,retainedHeaders]);
  const unmatchedEquipmentIds = useMemo(()=>{
    if(!effectiveMapping.equipment) return [];
    const index=headers.indexOf(effectiveMapping.equipment); const known=new Set(equipment.flatMap(asset=>[asset.externalId,asset.name,...asset.aliases].map(normalized)));
    return [...new Set(rows.slice(0,1000).map(row=>row[index]).filter(Boolean))].filter(value=>!known.has(normalized(value)));
  },[effectiveMapping.equipment,headers,rows,equipment]);
  const duplicateTargets = useMemo(()=>{const seen=new Set<string>(),duplicates=new Set<string>();activeSignalMappings.forEach(item=>{if(!item.equipmentId)return;const key=`${item.equipmentId}|${item.measurement}`;if(seen.has(key))duplicates.add(key);seen.add(key)});return duplicates.size},[activeSignalMappings]);
  const mappingConcerns = activeSignalMappings.filter(item=>!item.equipmentId||item.confidence==="low").length + unmatchedEquipmentIds.length + duplicateTargets;
  const measurementNormalization=useMemo(()=>{
    if(!mapping.measurement)return [];
    const index=headers.indexOf(mapping.measurement);
    return [...new Set(rows.slice(0,1000).map(row=>row[index]).filter(Boolean))].slice(0,8).map(source=>({source,normalized:suggestedMeasurement(source)}));
  },[mapping.measurement,headers,rows]);

  useEffect(() => {
    if(!siteId)return;
    const controller = new AbortController();
    setDatasetLoading(true);setDatasetError('');
    fetch(`/api/performance-data?siteId=${encodeURIComponent(siteId)}`, {cache:'no-store',signal:controller.signal}).then(readApiResponse).then(data => {
      if(controller.signal.aborted||currentSiteRef.current!==siteId)return;
      const saved=data.dataset as PerformanceDataset|undefined;
      if(!saved||saved.siteId!==siteId)throw new Error('Unable to load this site’s cumulative dataset.');
      setDataset(saved);setImports((data.imports||[]) as PerformanceImportAudit[]);setCurrentFile((data.legacyImport||null) as ImportRecord|null);setRequiresMigration(Boolean(data.requiresMigration));
      const sourceTimezone=saved.timezone||(data.legacyImport as ImportRecord|undefined)?.timezone;
      if(sourceTimezone&&isValidTimezone(sourceTimezone))setTimezone(current=>current||sourceTimezone);
    }).catch(reason=>{if(!controller.signal.aborted&&currentSiteRef.current===siteId)setDatasetError(reason instanceof Error?reason.message:'Unable to load performance data.');}).finally(()=>{if(!controller.signal.aborted&&currentSiteRef.current===siteId)setDatasetLoading(false);});
    return () => controller.abort();
  }, [siteId,datasetRevision]);
  useEffect(()=>()=>{requestEpoch.current++;},[]);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/equipment?siteId=${encodeURIComponent(siteId)}`, { signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then(data => {
        if (controller.signal.aborted) return;
        const next: EquipmentAsset[] = data?.equipment || [];
        equipmentRef.current = next;
        setEquipment(next);
        setSignalMappings(current => current.map(item => item.confidence === "high" && item.reason === "Confirmed by user"
          && next.some(asset => asset.id === item.equipmentId) ? item : suggestSignal(item.column, next)));
      }).catch(() => undefined).finally(() => { if (!controller.signal.aborted) setEquipmentLoading(false); });
    return () => controller.abort();
  }, [siteId]);

  function mappingForFormat(next:Mapping,format:CsvFormat){return format==="wide"?{...EMPTY_MAPPING,timestamp:next.timestamp,expectedProduction:next.expectedProduction,unit:next.unit}:next}
  function refreshSignalMappings(structuralMapping:Mapping,nextEquipment=equipment){setSignalMappings(signalColumnsFor(headers,structuralMapping).map(column=>signalMappings.find(item=>item.column===column)||suggestSignal(column,nextEquipment)))}
  function clearPreview(){requestEpoch.current++;setPendingPreview(null);setApproveOverlap(false);setPreviewConflict(false);setCommitUncertain(false);operationBusy.current=false;setBusy(false);}
  function changeSite(nextSiteId: string) { if (nextSiteId === siteId) return; clearPreview();currentSiteRef.current=nextSiteId;setEquipmentLoading(true); equipmentRef.current = []; setEquipment([]); setSiteId(nextSiteId); setDataset(null);setDatasetLoading(true);setImports([]);setRequiresMigration(false);setDatasetError('');setCurrentFile(null); setTimezone(""); setTimestampConvention("start"); setValidation(null);setStep(1); }
  function updateRole(key:keyof Mapping,value:string){clearPreview();setValidation(null);const next={...mapping,[key]:value};setMapping(next);refreshSignalMappings(mappingForFormat(next,fileFormat)); }
  function changeFormat(format:CsvFormat){clearPreview();setValidation(null);setFormatOverride(format);refreshSignalMappings(mappingForFormat(mapping,format))}
  function updateSignal(column:string,patch:Partial<SignalMapping>){clearPreview();setValidation(null);setSignalMappings(current=>current.map(item=>item.column===column?{...item,...patch,confidence:patch.equipmentId!==undefined?"high":item.confidence,reason:patch.equipmentId!==undefined?"Confirmed by user":item.reason}:item))}
  function resizeMapColumn(index:number,delta:number){setMapColumnWidths(current=>current.map((width,columnIndex)=>columnIndex===index?Math.min(480,Math.max(index===3?60:140,width+delta)):width))}
  function beginColumnResize(index:number,event:ReactPointerEvent<HTMLButtonElement>){columnResizeRef.current={index,startX:event.clientX,startWidth:mapColumnWidths[index],pointerId:event.pointerId};event.currentTarget.setPointerCapture(event.pointerId)}
  function moveColumnResize(event:ReactPointerEvent<HTMLButtonElement>){const resize=columnResizeRef.current;if(!resize||resize.pointerId!==event.pointerId)return;setMapColumnWidths(current=>current.map((width,index)=>index===resize.index?Math.min(480,Math.max(index===3?60:140,resize.startWidth+event.clientX-resize.startX)):width))}
  function endColumnResize(event:ReactPointerEvent<HTMLButtonElement>){if(columnResizeRef.current?.pointerId!==event.pointerId)return;columnResizeRef.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId)}

  async function chooseFile(nextFile?: File) {
    if (!nextFile || busy) return;
    clearPreview();
    const epoch=requestEpoch.current;
    setError("");
    if (!nextFile.name.toLowerCase().endsWith(".csv")) { setError("Choose a CSV file to continue."); return; }
    if (nextFile.size > MAX_FILE_SIZE) { setError("This first release accepts CSV files up to 100 MB."); return; }
    setBusy(true);
    setFile(null); setRows([]); setHeaders([]); setRowCount(0);
    try {
      processorRef.current?.close();
      const processor = new CsvProcessor();
      processorRef.current = processor;
      const parsed = await processor.load(nextFile);
      if(epoch!==requestEpoch.current||currentSiteRef.current!==siteId)return;
      const nextHeaders = parsed.headers;
      const nextRows = parsed.rows;
      setRowCount(parsed.rowCount);
      const nextMapping = autoMapping(nextHeaders);
      setFile(nextFile); setHeaders(nextHeaders); setRows(nextRows); setMapping(nextMapping);setFormatOverride(null);
      setSignalMappings(signalColumnsFor(nextHeaders,nextMapping).map(column=>suggestSignal(column,equipmentRef.current)));
      setDetectedTypes(detectTypes(nextHeaders, nextRows, nextMapping));
      setValidation(null);
    } catch (reason) {if(epoch===requestEpoch.current)setError(reason instanceof Error ? reason.message : "Unable to read this CSV."); }
    finally {if(epoch===requestEpoch.current)setBusy(false); }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault(); setDragging(false); void chooseFile(event.dataTransfer.files[0]);
  }

  async function advance() {

    setError("");
    if (step === 1 && (!file || !siteId || !timezone)) { setError("Select a site, timezone, and CSV file to continue."); return; }
    if (step === 1 && !isValidTimezone(timezone)) { setError("Choose a valid IANA source timezone, such as America/New_York or UTC."); return; }
    if (step === 3 && validation?.errors) { setError("Resolve the validation errors before continuing."); return; }
    if (step === 1) refreshSignalMappings(effectiveMapping);
    if (step === 2) {
      const epoch=requestEpoch.current;
      if (!mapping.timestamp) { setError("Map the timestamp column before validating the file."); return; }
      if (fileFormat==="long"&&(!mapping.equipment||!mapping.measurement||!mapping.value)) { setError("Long-format files require Equipment ID, Measurement, and Value mappings."); return; }
      if (fileFormat!=="long"&&!mappedSignalMappings.length) { setError(`${fileFormat==="hybrid"?"Hybrid":"Wide"}-format files require at least one telemetry column to be assigned to equipment.`); return; }
      setBusy(true);
      try {
        if (!processorRef.current) throw new Error("Choose a CSV file again.");
        const checked = await processorRef.current.validate(effectiveMapping, activeSignalMappings, equipment, timezone, timestampConvention,dataset?.intervalMinutes);
        if(epoch!==requestEpoch.current||currentSiteRef.current!==siteId)return;
        setValidation({ ...checked, warnings: checked.warnings + mappingConcerns });
        setDetectedTypes(detectTypes(headers, rows, effectiveMapping));
      } catch (reason) {
        if(epoch===requestEpoch.current)setError(reason instanceof Error ? reason.message : "Unable to validate the CSV.");
        return;
      } finally {if(epoch===requestEpoch.current)setBusy(false); }
    }
    setStep(value => Math.min(4, value + 1));
  }

  async function importFile() {
    if (!file || !validation || pendingPreview || busy || operationBusy.current || datasetLoading || datasetError || requiresMigration || !dataset || dataset.siteId!==siteId) return;
    if (validation.errors || validation.timezone !== timezone || validation.timestampConvention !== timestampConvention) { setError("Validate this file with the selected timezone and interval convention before importing."); return; }
    const epoch=requestEpoch.current;operationBusy.current=true;setBusy(true); setError("");
    try {
      if (!processorRef.current) throw new Error("Choose a CSV file again.");
      const filteredFile = await processorRef.current.prepare(effectiveMapping, activeSignalMappings);
      if(epoch!==requestEpoch.current||currentSiteRef.current!==siteId)return;
      const metadata={fileName:filteredFile.name,fileSize:filteredFile.size,siteId,timezone,mapping:effectiveMapping,detectedTypes,equipmentMapping:{signals:mappedSignalMappings,unmatchedEquipmentIds},validation};
      let data:Record<string,unknown>;
      if(filteredFile.size<=DIRECT_UPLOAD_LIMIT){
        const form=new FormData();form.append("file",filteredFile);form.append("siteId",siteId);form.append("timezone",timezone);form.append("mapping",JSON.stringify(effectiveMapping));form.append("detectedTypes",JSON.stringify(detectedTypes));form.append("equipmentMapping",JSON.stringify(metadata.equipmentMapping));form.append("validation",JSON.stringify(validation));
        const response=await fetch("/api/telemetry-imports",{method:"POST",body:form});
        if(response.status!==413)data=await readApiResponse(response);else data=await uploadInChunks(filteredFile,metadata);
      }else data=await uploadInChunks(filteredFile,metadata);
      if(epoch===requestEpoch.current&&currentSiteRef.current===siteId)acceptPreview(data.preview);
    } catch (reason) {if(epoch===requestEpoch.current)setError(reason instanceof Error ? reason.message : "Unable to preview the CSV."); }
    finally {if(epoch===requestEpoch.current){operationBusy.current=false;setBusy(false);setUploadProgress(0);} }
  }

  async function uploadInChunks(filteredFile:File,metadata:{fileName:string;fileSize:number;siteId:string;timezone:string;mapping:Mapping;detectedTypes:string[];equipmentMapping:{signals:SignalMapping[];unmatchedEquipmentIds:string[]};validation:Validation}){
    const uploadId = createUploadId();
    try {
      const totalChunks = await uploadCsvParts(filteredFile, uploadId, setUploadProgress);
      const response=await fetch("/api/telemetry-imports/finalize",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...metadata,uploadId,totalChunks})});
      const data=await readApiResponse(response);setUploadProgress(100);return data;
    }catch(reason){void fetch(`/api/telemetry-imports/chunk?uploadId=${encodeURIComponent(uploadId)}`,{method:"DELETE"}).catch(()=>undefined);throw reason}
  }

  function acceptPreview(value:unknown){
    const preview=value as PerformancePreview|undefined;
    if(!preview||preview.siteId!==siteId||preview.status!=='preview'||typeof preview.stageId!=='string'||!preview.stageId||typeof preview.previewToken!=='string'||!preview.previewToken||!Number.isInteger(preview.baseRevision)||preview.baseRevision<0||!preview.counts||!(['added','overlapping','changed','identical','blankPreserved'] as const).every(key=>Number.isSafeInteger(preview.counts[key])&&preview.counts[key]>=0)||!preview.metadata||!Array.isArray(preview.samples))throw new Error('The upload did not return a valid preview for this site. No Apply was requested.');
    setPendingPreview(preview);setApproveOverlap(false);setPreviewConflict(false);setCommitUncertain(false);
  }
  async function previewLegacy(){
    if(busy||operationBusy.current||datasetLoading||datasetError||!requiresMigration)return;
    const epoch=requestEpoch.current;operationBusy.current=true;setBusy(true);setError('');
    try{const data=await readApiResponse(await fetch('/api/performance-data',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'previewLegacy',siteId})}));if(epoch!==requestEpoch.current||currentSiteRef.current!==siteId)return;const saved=data.preview as PerformancePreview|undefined;if(saved?.status==='committed'&&saved.siteId===siteId&&saved.stageId)await finishCommitted(await readStage(saved),epoch);else acceptPreview(saved);}catch(reason){if(epoch===requestEpoch.current)setError(reason instanceof Error?reason.message:'Unable to preview the retained file.');}finally{if(epoch===requestEpoch.current){operationBusy.current=false;setBusy(false);}}
  }
  async function readStage(preview:PerformancePreview){
    const data=await readApiResponse(await fetch(`/api/performance-data?siteId=${encodeURIComponent(preview.siteId)}&stageId=${encodeURIComponent(preview.stageId)}`,{cache:'no-store'}));
    const saved=data.preview as PerformancePreview|undefined;
    if(!saved||saved.siteId!==preview.siteId||saved.stageId!==preview.stageId)throw new Error('Unable to verify this staged import.');
    return saved;
  }
  async function finishCommitted(saved:PerformancePreview,epoch:number){
    if(saved.status!=='committed'||!saved.result||!Number.isSafeInteger(saved.result.revision)||saved.result.revision<0)throw new Error('The staged import is not confirmed as committed.');
    const data=await readApiResponse(await fetch(`/api/performance-data?siteId=${encodeURIComponent(saved.siteId)}`,{cache:'no-store'}));
    const updated=data.dataset as PerformanceDataset|undefined;
    if(!updated||updated.siteId!==saved.siteId||!Number.isSafeInteger(updated.revision)||updated.revision<saved.result.revision)throw new Error('The commit is recorded, but cumulative data could not be verified. Check its status before continuing.');
    if(epoch!==requestEpoch.current||currentSiteRef.current!==saved.siteId)return;
    setDataset(updated);setImports((data.imports||[]) as PerformanceImportAudit[]);setRequiresMigration(Boolean(data.requiresMigration));setPendingPreview(null);setApproveOverlap(false);setPreviewConflict(false);setCommitUncertain(false);setError('');
    setStep(1);setFile(null);setHeaders([]);setRows([]);setMapping(EMPTY_MAPPING);setFormatOverride(null);setValidation(null);setDetectedTypes([]);setSignalMappings([]);setRowCount(0);
    processorRef.current?.close();processorRef.current=null;if(inputRef.current)inputRef.current.value='';
    notify(`Performance data applied and verified at revision ${saved.result.revision}. Omitted readings were preserved.`);onImported?.(saved.siteId);
  }
  async function checkCommit(){
    const preview=pendingPreview;if(!preview||preview.siteId!==siteId||busy||operationBusy.current)return;
    const epoch=requestEpoch.current;operationBusy.current=true;setBusy(true);setError('');
    try{const saved=await readStage(preview);if(epoch!==requestEpoch.current)return;if(saved.status==='committed')await finishCommitted(saved,epoch);else if(saved.status==='canceled'){clearPreview();setError('This preview was canceled. Create a new preview.');}else{setCommitUncertain(false);setError('This stage has not been applied. Review approval and explicitly retry Apply if needed.');}}catch(reason){if(epoch===requestEpoch.current)setError(reason instanceof Error?reason.message:'Unable to verify the import.');}finally{if(epoch===requestEpoch.current){operationBusy.current=false;setBusy(false);}}
  }
  async function applyPreview(){
    const preview=pendingPreview;
    if(!preview||preview.siteId!==siteId||currentSiteRef.current!==siteId||preview.status!=='preview'||previewConflict||busy||operationBusy.current||(preview.counts.overlapping>0&&!approveOverlap))return;
    const epoch=requestEpoch.current;operationBusy.current=true;setBusy(true);setError('');
    try{
      try{const data=await readApiResponse(await fetch('/api/performance-data',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'commit',siteId,stageId:preview.stageId,previewToken:preview.previewToken,approveOverlap})}));if(data.committed!==true)throw new Error('Apply acknowledgement was incomplete.');}
      catch(reason){if(epoch!==requestEpoch.current)return;if((reason as {status?:number}).status===409){setPreviewConflict(true);setApproveOverlap(false);setError(`${reason instanceof Error?reason.message:'Preview conflict.'} Discard this preview and create a new one; approval will not be replayed.`);return;}}
      // A lost acknowledgement is not proof of rollback. Read, never replay.
      const saved=await readStage(preview);
      if(epoch!==requestEpoch.current)return;
      if(saved.status==='committed')await finishCommitted(saved,epoch);
      else {setCommitUncertain(false);setError(saved.status==='canceled'?'This preview was canceled. Discard it and preview again.':'Apply was not confirmed. This stage is still pending; explicitly retry Apply or check its status.');if(saved.status==='canceled')setPreviewConflict(true);}
    }catch(reason){if(epoch===requestEpoch.current){setCommitUncertain(true);setError(`${reason instanceof Error?reason.message:'Unable to verify Apply.'} The outcome is uncertain. Check import status or explicitly retry this same stage; do not create a replacement upload.`);}}
    finally{if(epoch===requestEpoch.current){operationBusy.current=false;setBusy(false);}}
  }
  async function cancelPreview(){
    const preview=pendingPreview;if(!preview||preview.siteId!==siteId||busy||operationBusy.current)return;
    const epoch=requestEpoch.current;operationBusy.current=true;setBusy(true);setError('');
    try{await readApiResponse(await fetch('/api/performance-data',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'cancel',siteId,stageId:preview.stageId})}));const saved=await readStage(preview);if(epoch!==requestEpoch.current)return;if(saved.status==='committed')await finishCommitted(saved,epoch);else if(saved.status==='canceled')clearPreview();else throw new Error('Cancellation has not been confirmed.');}catch(reason){if(epoch===requestEpoch.current)setError(reason instanceof Error?reason.message:'Unable to cancel the preview.');}finally{if(epoch===requestEpoch.current){operationBusy.current=false;setBusy(false);}}
  }

  const roleFields: Array<[keyof Mapping,string,string]> = [
    ["timestamp","Timestamp","Required · date and time for each interval"],
    ["equipment","Equipment ID","Optional · inverter, meter, station, or device"],
    ["measurement","Measurement / tag","Optional · used by long-format files"],
    ["value","Value","Optional for wide-format files"],
    ["unit","Unit","Optional · kW, kWh, W/m², °C, and similar"],
  ];
  const visibleRoleFields=fileFormat==="wide"?roleFields.filter(([key])=>key==="timestamp"||key==="unit"):roleFields;
  const formatCopy:Record<CsvFormat,{label:string;description:string}>={
    long:{label:"Long format",description:"Each row identifies equipment, measurement, value, and optional unit."},
    wide:{label:"Wide format",description:"Each telemetry signal has its own column and is assigned below."},
    hybrid:{label:"Hybrid format",description:"Structural row fields and separate telemetry columns are both present."},
  };
  const mapTableStyle={"--signal-column":`${mapColumnWidths[0]}px`,"--equipment-column":`${mapColumnWidths[1]}px`,"--measurement-column":`${mapColumnWidths[2]}px`,"--match-column":`${mapColumnWidths[3]}px`} as CSSProperties;

  return <section className="upload-view" aria-labelledby="upload-title">
    <header className="settings-header upload-header"><div><p className="eyebrow">DATA MANAGEMENT</p><h1 id="upload-title">Performance data</h1><p>Add interval-meter, irradiance, inverter, and SCADA readings to a site's cumulative dataset.</p></div><button className="secondary-btn" onClick={onBack}>← Back to Findings</button></header>
    <ol className="import-steps" aria-label="CSV import progress">{["Upload","Map fields","Validate","Review"].map((label,index) => <li key={label} className={step===index+1?"active":step>index+1?"done":""}><span>{step>index+1?"✓":index+1}</span><div><small>STEP {index+1}</small><strong>{label}</strong></div></li>)}</ol>
    <div className="storage-note current-performance-file"><span>⌁</span><div><strong>Cumulative performance dataset</strong><p>{datasetLoading?'Loading cumulative coverage…':dataset?.revision?`Revision ${dataset.revision} · ${dataset.timestampCount.toLocaleString()} timestamps · ${dataset.readingCount.toLocaleString()} readings · ${dataset.channelCount} channels · ${formatDate(dataset.timestampStart,dataset.timezone)} – ${formatDate(dataset.timestampEnd,dataset.timezone)}`:'No readings have been applied to the cumulative dataset yet (revision 0).'}</p><p>Imports preserve omitted timestamps and channels, including within the uploaded date range. Blank or null values preserve saved readings; they do not clear them. Only supplied values at matching timestamps and channels can change existing readings, after explicit overlap approval. Partial uploads do not need every revenue meter.</p>{imports[0]&&<p>Latest source: {imports[0].metadata.source} · {imports[0].metadata.fileName} · {formatDate(imports[0].committedAt)} · revision {imports[0].revision}</p>}</div></div>
    {datasetError&&<div role="alert" className="import-error">{datasetError} <button className="secondary-btn" onClick={()=>setDatasetRevision(value=>value+1)}>Retry loading dataset</button></div>}
    {requiresMigration&&<div className="storage-note migration-required"><div><strong>Migration required</strong><p>Preview and apply the retained file {currentFile?.fileName||''} before importing additional readings. Its original file and saved analyses will be preserved. Preview does not change the cumulative dataset.</p><button className="secondary-btn" disabled={busy||datasetLoading||!!datasetError||!!pendingPreview} onClick={previewLegacy}>Preview retained file</button></div></div>}
    {pendingPreview&&pendingPreview.siteId===siteId&&<section className="panel performance-import-preview" aria-labelledby="performance-preview-title"><h2 id="performance-preview-title">Review staged import</h2><p><strong>{selectedSite?.name}</strong> · {pendingPreview.metadata.fileName} · {pendingPreview.metadata.source} · based on revision {pendingPreview.baseRevision}</p><p>{formatDate(pendingPreview.timestampStart,pendingPreview.metadata.timezone)} – {formatDate(pendingPreview.timestampEnd,pendingPreview.metadata.timezone)} · {pendingPreview.channelCount} channels. No readings are applied until you choose Apply.</p><dl className="import-preview-counts">{([['added','Added'],['overlapping','Overlapping'],['changed','Changed'],['identical','Identical'],['blankPreserved','Blank/null preserved']] as const).map(([key,label])=><div key={key}><dt>{label}</dt><dd>{pendingPreview.counts[key].toLocaleString()}</dd></div>)}</dl>
      {!!pendingPreview.samples.length&&<div className="table-wrap"><table><thead><tr><th>Timestamp</th><th>Equipment / channel</th><th>Saved value</th><th>Incoming value</th></tr></thead><tbody>{pendingPreview.samples.map((sample,index)=><tr key={index}><td>{sample.timestamp}</td><td>{sample.channel.equipmentId} / {sample.channel.measurement}</td><td>{sample.previous??'Blank'}</td><td>{sample.incoming??'Blank — preserved'}</td></tr>)}</tbody></table></div>}
      {pendingPreview.counts.overlapping>0&&<div className="overlap-approval"><p role="alert"><strong>Overlapping readings require approval.</strong> {pendingPreview.counts.changed} existing values would change; {pendingPreview.counts.identical} are identical. Omitted and blank values are preserved.</p><label><input type="checkbox" checked={approveOverlap} disabled={busy||previewConflict} onChange={event=>setApproveOverlap(event.target.checked)}/>I approve applying these overlapping readings to this site at revision {pendingPreview.baseRevision}.</label></div>}
      <div className="import-actions"><button className="secondary-btn" disabled={busy} onClick={cancelPreview}>Discard preview</button><button className="secondary-btn" disabled={busy} onClick={checkCommit}>Check import status</button><button className="primary-btn" disabled={busy||previewConflict||(pendingPreview.counts.overlapping>0&&!approveOverlap)} onClick={applyPreview}>{busy?'Verifying…':commitUncertain?'Retry Apply (same stage)':'Apply to cumulative dataset'}</button></div>
    </section>}
    <div className="upload-layout single-file-upload">
      <article className="panel import-panel">
        <fieldset disabled={busy} style={{ display: "contents" }}>
        {step === 1 && <><div className="import-heading"><div><p className="eyebrow">STEP 1 OF 4</p><h2>Select a site and CSV</h2><p>Telemetry types are detected from your headers and data after upload.</p></div><span className="auto-chip">Auto-detect types</span></div>
          <div className="upload-fields"><label className="field"><span>Destination site <em>*</em></span><select value={siteId} onChange={event=>changeSite(event.target.value)}>{sites.map(site=><option key={site.id} value={site.id}>{site.name} · {site.location}</option>)}</select></label><label className="field"><span>Source timezone <em>*</em></span><input aria-label="Source timezone" list="source-timezones" placeholder="Select an IANA timezone" value={timezone} onChange={event=>{clearPreview();setTimezone(event.target.value);setValidation(null)}} /><datalist id="source-timezones">{timezoneOptions.map(zone=><option key={zone} value={zone} />)}</datalist></label><label className="field"><span>Timestamps represent <em>*</em></span><select value={timestampConvention} onChange={event=>{clearPreview();setTimestampConvention(event.target.value as TimestampConvention);setValidation(null)}}><option value="start">Interval start</option><option value="end">Interval end</option></select></label></div><p>Use the source timezone for timestamps without an offset. Timestamps with an explicit UTC offset retain their exact instant. Interval end readings are assigned to the preceding interval.</p>
          <div className={`equipment-ready ${equipment.length?"ready":"missing"}`}><span>{equipment.length?"✓":"!"}</span><div><strong>{equipment.length?`${equipment.length} configured equipment nodes available for matching`:"No saved equipment model for this site"}</strong><p>{equipment.length?"IDs, aliases, and expected channels will guide the next step.":"You can continue, but equipment assignments will require manual review."}</p></div></div>
          <div className={`drop-zone ${dragging?"dragging":""} ${file?"has-file":""}`} onDragOver={event=>{event.preventDefault();setDragging(true)}} onDragLeave={()=>setDragging(false)} onDrop={handleDrop}>
            <input ref={inputRef} type="file" accept=".csv,text/csv" onChange={event=>void chooseFile(event.target.files?.[0])}/>
            {file ? <><span className="file-icon">CSV</span><div><strong>{file.name}</strong><p>{formatBytes(file.size)} · {rowCount.toLocaleString()} data rows</p></div><button type="button" className="secondary-btn" onClick={()=>inputRef.current?.click()}>Choose another file</button></> : <><span className="upload-icon">⇧</span><div><strong>{busy?"Reading CSV…":"Drop a CSV file here"}</strong><p>or click to browse · maximum 100 MB</p></div><button type="button" className="secondary-btn" onClick={()=>inputRef.current?.click()}>Choose file</button></>}
          </div>
          <div className="format-note"><span>i</span><div><strong>Long and wide formats are supported</strong><p>Use a header row and include at least one timestamp column. Telemetry categories do not need to be separated into different files.</p></div></div>
        </>}
        {step === 2 && <><ImportProfiles siteId={siteId} notify={notify} configuration={{headers,mapping:effectiveMapping,signalMappings,format:fileFormat,timezone,timestampConvention}} onApply={p=>{const needed=[...Object.values(p.mapping||{}),...(p.signalMappings||[]).filter((x:SignalMapping)=>x.equipmentId).map((x:SignalMapping)=>x.column)].filter(Boolean);if(needed.some(h=>!headers.includes(String(h)))||(p.signalMappings||[]).some((x:SignalMapping)=>x.equipmentId&&!equipment.some(a=>a.id===x.equipmentId))){setError("This profile needs columns or equipment that are unavailable. Check this file and site.");return;}clearPreview();setMapping(p.mapping);setSignalMappings(p.signalMappings||[]);setFormatOverride(p.format);setTimezone(p.timezone);setTimestampConvention(p.timestampConvention);setValidation(null);setError("");notify("Profile applied. Validate the file before importing.");}}/><div className="import-heading"><div><p className="eyebrow">STEP 2 OF 4</p><h2>Map CSV fields</h2><p>The controls below adapt to the structure detected in your file.</p></div><span className="file-badge">{file?.name}</span></div>
          <div className="format-detection"><div><span className="format-kicker">DETECTED FILE STRUCTURE</span><strong>{formatCopy[fileFormat].label}</strong><p>{formatCopy[fileFormat].description}</p></div><div className="format-options" role="group" aria-label="CSV file structure">{(["long","wide","hybrid"] as CsvFormat[]).map(format=><button key={format} className={fileFormat===format?"active":""} onClick={()=>changeFormat(format)}>{formatCopy[format].label.replace(" format","")}</button>)}</div></div>
          <section className="mapping-section" aria-labelledby="structure-mapping-title"><div className="mapping-section-head"><div><span>1</span><div><strong id="structure-mapping-title">CSV structure</strong><p>{fileFormat==="wide"?"Identify the timestamp and an optional shared unit column.":"Identify the columns that describe each row. Required fields are marked below."}</p></div></div><em>{visibleRoleFields.length} fields</em></div><div className="mapping-grid"><div className="mapping-head"><span>Destination field</span><span>CSV column</span></div>{visibleRoleFields.map(([key,label,help])=><div className="mapping-row" key={key}><div><strong>{label}</strong><small>{help}</small></div><select value={mapping[key]} onChange={event=>updateRole(key,event.target.value)}><option value="">Not mapped</option>{headers.map(header=><option key={header}>{header}</option>)}</select></div>)}</div></section>
          <section className="mapping-section" aria-labelledby="site-data-mapping-title"><div className="mapping-section-head"><div><span>2</span><div><strong id="site-data-mapping-title">Site-level data</strong><p>Map analytical inputs that apply to the whole site rather than a physical array-model node.</p></div></div><em>{mapping.expectedProduction?"1 mapped":"Optional"}</em></div><div className="mapping-grid"><div className="mapping-head"><span>Destination field</span><span>CSV column</span></div><div className="mapping-row"><div><strong>Expected Production</strong><small>Interval energy · fixed unit: kWh</small></div><select aria-label="Map Expected Production column" value={mapping.expectedProduction} onChange={event=>updateRole("expectedProduction",event.target.value)}><option value="">Not mapped</option>{headers.map(header=><option key={header}>{header}</option>)}</select></div></div></section>
          {fileFormat!=="long"&&<section className="mapping-section telemetry-assignment" aria-labelledby="telemetry-assignment-title"><div className="mapping-section-head"><div><span>2</span><div><strong id="telemetry-assignment-title">Telemetry column assignments</strong><p>Assign each signal column to configured equipment and a measurement. On larger screens, drag the column dividers to expand the table.</p></div></div><em>{mappedSignalMappings.length} mapped · {activeSignalMappings.length-mappedSignalMappings.length} excluded</em></div>
          {activeSignalMappings.length>0?<div className="equipment-mapping"><div className="equipment-map-title"><div><strong>Equipment & measurement mapping</strong><p>Suggestions use equipment IDs, aliases, types, and expected channels from the array model. Map onsite snow readings to a weather sensor named Snow sensor using Snow code. Only 70 indicates snow; one reading qualifies the whole local day.</p></div><span className={mappingConcerns?"concern":"clear"}>{mappingConcerns?`${mappingConcerns} concern${mappingConcerns===1?"":"s"}`:"All matched"}</span></div><div className="equipment-map-scroll"><div className="equipment-map-table" style={mapTableStyle}><div className="equipment-map-head"><span>CSV signal<button type="button" className="column-resizer" aria-label="Resize CSV signal column" onPointerDown={event=>beginColumnResize(0,event)} onPointerMove={moveColumnResize} onPointerUp={endColumnResize} onPointerCancel={endColumnResize} onKeyDown={event=>{if(event.key==="ArrowLeft")resizeMapColumn(0,-12);if(event.key==="ArrowRight")resizeMapColumn(0,12)}}/></span><span>Equipment<button type="button" className="column-resizer" aria-label="Resize equipment column" onPointerDown={event=>beginColumnResize(1,event)} onPointerMove={moveColumnResize} onPointerUp={endColumnResize} onPointerCancel={endColumnResize} onKeyDown={event=>{if(event.key==="ArrowLeft")resizeMapColumn(1,-12);if(event.key==="ArrowRight")resizeMapColumn(1,12)}}/></span><span>Measurement<button type="button" className="column-resizer" aria-label="Resize measurement column" onPointerDown={event=>beginColumnResize(2,event)} onPointerMove={moveColumnResize} onPointerUp={endColumnResize} onPointerCancel={endColumnResize} onKeyDown={event=>{if(event.key==="ArrowLeft")resizeMapColumn(2,-12);if(event.key==="ArrowRight")resizeMapColumn(2,12)}}/></span><span>Match</span></div>{activeSignalMappings.map(item=><div className={`equipment-map-row ${item.equipmentId?"mapped":"excluded"}`} key={item.column}><div><strong title={item.column}>{item.column}</strong><small>{item.equipmentId?item.reason:"Excluded unless assigned"}</small></div><label><span>Equipment</span><select aria-label={`Equipment for ${item.column}`} value={item.equipmentId} onChange={event=>updateSignal(item.column,{equipmentId:event.target.value})}><option value="">Exclude column</option>{equipment.map(asset=><option key={asset.id} value={asset.id}>{asset.name} · {asset.externalId}</option>)}</select></label><label><span>Measurement</span><select aria-label={`Measurement for ${item.column}`} value={item.measurement} disabled={!item.equipmentId} onChange={event=>updateSignal(item.column,{measurement:event.target.value})}>{measurements.map(value=><option key={value} value={value}>{value === "Energy" ? "Energy (interval kWh)" : value === "Cumulative energy" ? "Cumulative energy (convert first)" : value}</option>)}</select></label><i className={item.equipmentId?item.confidence:"low"}>{item.equipmentId?item.confidence:"excluded"}</i></div>)}</div></div></div>:<div className="no-signal-columns"><span>i</span><p>No separate telemetry columns remain after the structural fields above are mapped.</p></div>}</section>}
          {(fileFormat==="long"||fileFormat==="hybrid")&&<section className="mapping-section row-validation" aria-labelledby="row-validation-title"><div className="mapping-section-head"><div><span>{fileFormat==="long"?"2":"3"}</span><div><strong id="row-validation-title">Row-level identifier validation</strong><p>Check equipment identifiers and normalize measurement names found within the rows.</p></div></div></div>{mapping.equipment?<div className={`identifier-check ${unmatchedEquipmentIds.length?"concern":"clear"}`}><span>{unmatchedEquipmentIds.length?"!":"✓"}</span><div><strong>Equipment identifiers in rows</strong><p>{unmatchedEquipmentIds.length?`${unmatchedEquipmentIds.slice(0,5).join(", ")}${unmatchedEquipmentIds.length>5?"…":""} did not match configured IDs or aliases in the first 1,000 rows.`:"Sampled equipment identifiers match the site configuration."}</p></div></div>:<div className="no-signal-columns"><span>!</span><p>Map an Equipment ID column to validate row-level equipment identifiers.</p></div>}{mapping.measurement&&measurementNormalization.length>0&&<div className="normalization-preview"><strong>Measurement normalization preview</strong><div>{measurementNormalization.map(item=><span key={item.source}><b>{item.source}</b><i>→</i>{item.normalized}</span>)}</div></div>}</section>}

          <div className="preview-table"><div className="preview-title"><strong>Data preview</strong><span>First 4 rows</span></div><div className="table-wrap"><table><thead><tr>{headers.map(header=><th key={header}>{header}</th>)}</tr></thead><tbody>{rows.slice(0,4).map((row,index)=><tr key={index}>{headers.map((header,col)=><td key={header}>{row[col] || <em>empty</em>}</td>)}</tr>)}</tbody></table></div></div>
        </>}
        {step === 3 && validation && <><div className="import-heading"><div><p className="eyebrow">STEP 3 OF 4</p><h2>Validation results</h2><p>{validation.errors?"Resolve blocking issues before import.":validation.warnings?"Review the highlighted concerns before import.":"The file is ready for final review."}</p></div><span className={`validation-state ${validation.errors?"bad":validation.warnings?"warn":"good"}`}>{validation.errors?`${validation.errors} error${validation.errors===1?"":"s"}`:validation.warnings?`${validation.warnings} flag${validation.warnings===1?"":"s"}`:"Passed"}</span></div>
          <div className="validation-grid"><div><small>ROWS CHECKED</small><strong>{validation.checkedRows.toLocaleString()}</strong><span>{validation.validRows.toLocaleString()} valid</span></div><div><small>DATE RANGE</small><strong>{formatDate(validation.start, timezone)}</strong><span>to {formatDate(validation.end, timezone)}</span></div><div><small>INTERVAL</small><strong>{validation.interval}</strong><span>native cadence</span></div><div><small>SIGNALS</small><strong>{validation.signalColumns.length || (mapping.value?1:0)}</strong><span>measurement fields</span></div></div>
          <div className="detected-block"><div><strong>Detected data types</strong><p>Inferred from headers and sample values—not selected manually.</p></div><div>{detectedTypes.map(type=><span key={type}>{type}</span>)}</div></div>
          <div className="issue-list">{(validation.inconsistentIntervals > 0 || !validation.intervalMinutes) && <div className="issue error"><span>!</span><div><strong>Interval spacing</strong><p>{validation.intervalMinutes ? "The timestamps have inconsistent interval lengths. Convert all signals to one explicit cadence before importing; gaps may be whole multiples of that cadence." : "An interval duration could not be determined. Supply at least two timestamps with a consistent cadence."}</p></div></div>}{validation.cumulativeEnergySignals > 0 && <div className="issue error"><span>!</span><div><strong>Cumulative energy</strong><p>Cumulative energy readings must be converted to interval energy (kWh) before import. Map interval readings as Energy.</p></div></div>}<div className={validation.invalidTimestamps?"issue error":"issue ok"}><span>{validation.invalidTimestamps?"!":"✓"}</span><div><strong>Timestamp parsing</strong><p>{validation.invalidTimestamps?`${validation.invalidTimestamps} row(s) have invalid timestamps, including ${validation.ambiguousTimestamps} ambiguous and ${validation.nonexistentTimestamps} nonexistent local times. Supply an explicit UTC offset for repeated daylight-saving hours and correct nonexistent local times.`:"All timestamps parsed successfully."}</p></div></div><div className={validation.missingValues?"issue warning":"issue ok"}><span>{validation.missingValues?"!":"✓"}</span><div><strong>Missing values</strong><p>{validation.missingValues?`${validation.missingValues} row(s) have no mapped measurement value.`:"No completely empty measurement rows found."}</p></div></div><div className={validation.duplicateTimestamps?"issue warning":"issue ok"}><span>{validation.duplicateTimestamps?"!":"✓"}</span><div><strong>Duplicate intervals</strong><p>{validation.duplicateTimestamps?`${validation.duplicateTimestamps} duplicate timestamp and equipment pair(s) found.`:"No duplicate timestamp and equipment pairs found."}</p></div></div><div className={!validation.capacityCheckReady||validation.capacityExceededRows?"issue warning":"issue ok"}><span>{!validation.capacityCheckReady||validation.capacityExceededRows?"!":"✓"}</span><div><strong>Grid export capacity</strong><p>{validation.capacityCheckMessage}{validation.capacityExceededRows?` Maximum observed power was ${validation.maxObservedPowerKw.toLocaleString(undefined,{maximumFractionDigits:2})} kW.`:""}</p></div></div><div className={mappingConcerns?"issue warning":"issue ok"}><span>{mappingConcerns?"!":"✓"}</span><div><strong>Equipment consistency</strong><p>{mappingConcerns?`${mappingConcerns} mapping concern(s) remain${duplicateTargets?`, including ${duplicateTargets} duplicate equipment/measurement assignment(s)`:""}. You may import after review, or go back to adjust assignments.`:`All ${signalMappings.length||"row-level"} telemetry source(s) align with configured equipment.`}</p></div></div></div>
        </>}
        {step === 4 && validation && <><div className="import-heading"><div><p className="eyebrow">STEP 4 OF 4</p><h2>Review and preview</h2><p>Only mapped columns will be retained. Create a staged preview to compare these readings with the cumulative dataset before applying changes.</p></div><span className={`validation-state ${validation.warnings?"warn":"good"}`}>{validation.warnings?"Ready with flags":"Ready"}</span></div>
          <div className="review-card"><div><small>SITE</small><strong>{selectedSite?.name}</strong><span>{selectedSite?.location}</span></div><div><small>FILE</small><strong>{file?.name}</strong><span>{validation.totalRows.toLocaleString()} rows · {retainedHeaders.length} of {headers.length} columns retained</span></div><div><small>TIMEZONE</small><strong>{timezone}</strong><span>{timestampConvention === "end" ? "Interval end" : "Interval start"} · native cadence preserved</span></div><div><small>EQUIPMENT MAPPING</small><strong>{mappedSignalMappings.length} of {signalMappings.length||1} matched</strong><span>{excludedHeaders.length?`${excludedHeaders.length} unmapped column${excludedHeaders.length===1?"":"s"} excluded`:`Aligned with ${equipment.length} configured nodes`}</span></div></div>
          <div className={`identifier-check ${!validation.capacityCheckReady||validation.capacityExceededRows?"concern":"clear"}`}><span>{!validation.capacityCheckReady||validation.capacityExceededRows?"!":"✓"}</span><div><strong>Potential grid export: {validation.exportCapacityKw.toLocaleString(undefined,{maximumFractionDigits:2})} kWac</strong><p>{validation.capacityCheckMessage}</p></div></div>
          <div className="storage-note"><span>⌁</span><div><strong>Preview before applying</strong><p>Uploading only stages the mapped readings. Review added, changed and identical values, then explicitly approve any overlap. Omitted timestamps and channels and blank/null values preserve existing data.</p></div></div>
        </>}
        {error&&<div className="import-error" role="alert">{error}</div>}
        <footer className="import-actions"><button className="secondary-btn" disabled={busy||commitUncertain} onClick={()=>step===1?onBack():setStep(value=>value-1)}>{step===1?"Cancel":"← Back"}</button>{step<4?<button className="primary-btn" disabled={busy||datasetLoading||!!datasetError||requiresMigration||step===1&&!file||step===2&&equipmentLoading} onClick={advance}>{busy && step === 2 ? "Validating…" : "Continue"} <span>→</span></button>:<button className="primary-btn" disabled={busy||datasetLoading||!!datasetError||requiresMigration||!!pendingPreview||!!validation?.errors} onClick={importFile}>{busy?uploadProgress?`Uploading ${uploadProgress}%…`:"Preparing…":"Create import preview"}<span>→</span></button>}</footer>
        </fieldset>
      </article>

    </div>
  </section>;
}
