"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { equipmentLabels, starterEquipment } from "./equipment";
import type { EquipmentAsset, EquipmentType } from "./equipment";
import { arrayCapacityModel } from "./array-capacity";

type ManagedSite = { id:string; name:string; location:string; arrayModelVerified:boolean };

function EquipmentIcon({type}:{type:EquipmentType}) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {type==="revenue_meter"&&<><path d="M12 2v20M2 6h20M3 10h18M5 6v4M19 6v4M7 10l5 5 5-5"/></>}
    {type==="transformer"&&<><rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><path d="M6 9v9h9M9 6h9v9"/></>}
    {type==="inverter"&&<path d="m13 2-10 12h9l-1 8 10-12h-9l1-8Z"/>}
    {type==="module_group"&&<><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2m-3-9-1.5 1.5M5.5 18.5 4 20m0-16 1.5 1.5M18.5 18.5 20 20"/></>}
    {type==="weather_sensor"&&<><path d="M12 2v2m-5.1.9 1.4 1.4M3 12h2m-.1-7.1 1.4 1.4M20 8l1-1M16 5l1-2"/><path d="M8 12a4 4 0 1 1 7-2"/><path d="M8 20a4 4 0 0 1-.5-8 5 5 0 0 1 9.5 2h1a3 3 0 0 1 0 6Z"/></>}
  </svg>;
}

function equipmentId() {
  return globalThis.crypto?.randomUUID?.() ?? `equipment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`;
}

function uniqueCopyName(value:string,items:EquipmentAsset[]) {
  const root=value.replace(/\s+copy(?:\s+\d+)?$/i,"");
  const used=new Set(items.map(item=>item.name.toLowerCase()));
  let index=1, candidate=`${root} copy`;
  while(used.has(candidate.toLowerCase())){index+=1;candidate=`${root} copy ${index}`}
  return candidate;
}

function uniqueCopyExternalId(value:string,items:EquipmentAsset[]) {
  const root=value.replace(/-COPY(?:-\d+)?$/i,"");
  const used=new Set(items.map(item=>item.externalId.toLowerCase()));
  let index=1, candidate=`${root}-COPY`;
  while(used.has(candidate.toLowerCase())){index+=1;candidate=`${root}-COPY-${index}`}
  return candidate;
}

function newAsset(siteId:string,type:EquipmentType,parentId:string|null,index:number):EquipmentAsset {
  const id = equipmentId();
  const defaults:Record<EquipmentType,Partial<EquipmentAsset>> = {
    revenue_meter:{ name:"Main revenue meter", externalId:"MTR-001", acLineLossPercent:"", transformerLossPercent:"", channels:["Energy","Active power"] },
    transformer:{ name:`Transformer ${index}`, externalId:`TX-${String(index).padStart(2,"0")}`, nameplateKva:"", pvCeilingOverrideEnabled:false, pvCeilingOverrideKw:"", notes:"", channels:[] },
    inverter:{ name:`Inverter ${String(index).padStart(2,"0")}`, externalId:`INV-${String(index).padStart(2,"0")}`, acRatedCapacityKw:"", maxDcCapacityKw:"", channels:["AC power","DC power","Energy","Availability"] },
    module_group:{ name:`Array block ${index}`, externalId:`ARRAY-${index}`, moduleRatedCapacityW:"", channels:["DC power","String current"], quantity:1 },
    weather_sensor:{ name:`Weather sensor ${index}`, externalId:`WS-${String(index).padStart(2,"0")}`, channels:["POA irradiance"] },
  };
  return { id,siteId,parentId,type,name:"New equipment",externalId:`EQ-${index}`,manufacturer:"",model:"",capacityKw:"",acRatedCapacityKw:"",maxDcCapacityKw:"",moduleRatedCapacityW:"",acLineLossPercent:"",transformerLossPercent:"",quantity:1,aliases:[],channels:[],position:index,...defaults[type] };
}

export default function ArrayConfiguration({ sites, initialSiteId, onBack, notify, onSaved, onVerificationChange }:{ sites:ManagedSite[]; initialSiteId?:string; onBack:()=>void; notify:(message:string)=>void; onSaved?:(siteId:string)=>void; onVerificationChange:(siteId:string,verified:boolean)=>void }) {
  const [siteId,setSiteId] = useState(initialSiteId||sites[0]?.id||"");
  const [equipment,setEquipment] = useState<EquipmentAsset[]>([]);
  const [selectedId,setSelectedId] = useState("");
  const [loading,setLoading] = useState(true);
  const [saving,setSaving] = useState(false);
  const [dirty,setDirty] = useState(false);
  const [verified,setVerified] = useState(false);
  const [loadError,setLoadError] = useState(false);
  const [message,setMessage] = useState("");
  const [hierarchyZoom,setHierarchyZoom] = useState(1);
  const [stageSize,setStageSize] = useState({width:0,height:0});
  const [isPanning,setIsPanning] = useState(false);
  const viewportRef=useRef<HTMLDivElement>(null);
  const stageRef=useRef<HTMLDivElement>(null);
  const zoomRef=useRef(1);
  const panRef=useRef<{pointerId:number;clientX:number;clientY:number;scrollLeft:number;scrollTop:number}|null>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const selected = equipment.find(item=>item.id===selectedId) || null;
  const duplicateIdPeers = selected ? equipment.filter(item=>item.id!==selected.id&&item.externalId.trim().toLowerCase()===selected.externalId.trim().toLowerCase()) : [];
  const meter = equipment.find(item=>item.type==="revenue_meter");
  const inverters = equipment.filter(item=>item.type==="inverter").sort((a,b)=>a.position-b.position);
  const transformers = equipment.filter(item=>item.type==="transformer").sort((a,b)=>a.position-b.position);
  const capacityModel = useMemo(()=>arrayCapacityModel(equipment),[equipment]);
  const selectedTransformer = capacityModel.branches.find(branch=>branch.id===selectedId);
  const unassignedInverters = inverters.filter(item=>capacityModel.unassignedIds.includes(item.id));
  const sensors = equipment.filter(item=>item.type==="weather_sensor").sort((a,b)=>a.position-b.position);
  const modules = useMemo(()=>equipment.filter(item=>item.type==="module_group"),[equipment]);
  const site = sites.find(item=>item.id===siteId);
  const inverterDcCapacityKw = (inverterId:string) => modules.filter(item=>item.parentId===inverterId).reduce((sum,item)=>sum+(Number(item.moduleRatedCapacityW)||0)*item.quantity/1000,0);
  const inverterAcContributionKw = (inverter:EquipmentAsset) => Math.min(inverterDcCapacityKw(inverter.id),Math.max(0,Number(inverter.acRatedCapacityKw)||0));
  const installedInverterCapacityKw = inverters.reduce((sum,inverter)=>sum+Math.max(0,Number(inverter.acRatedCapacityKw)||0),0);
  const wholeKw = (value:number) => value.toLocaleString(undefined,{maximumFractionDigits:0});
  const totalInverterAcCapacityKw = inverters.reduce((sum,inverter)=>sum+inverterAcContributionKw(inverter),0);
  const acLineLossPercent = Math.min(100,Math.max(0,Number(meter?.acLineLossPercent)||0));
  const transformerLossPercent = Math.min(100,Math.max(0,Number(meter?.transformerLossPercent)||0));
  const potentialGridExportKw = capacityModel.gridExportKw ?? 0;
  const selectedDcCapacityKw = selected?.type==="inverter" ? inverterDcCapacityKw(selected.id) : 0;
  const selectedMaxDcCapacityKw = selected?.type==="inverter" ? Number(selected.maxDcCapacityKw)||0 : 0;
  const dcCapacityExceeded = selected?.type==="inverter" && selectedMaxDcCapacityKw>0 && selectedDcCapacityKw>selectedMaxDcCapacityKw;

  const fitHierarchy=useCallback(()=>{
    const viewport=viewportRef.current,stage=stageRef.current;if(!viewport||!stage)return;
    const width=Math.max(stage.scrollWidth,stage.offsetWidth),height=Math.max(stage.scrollHeight,stage.offsetHeight);
    if(!width||!height)return;
    const next=Math.min(1,Math.max(.25,Math.min((viewport.clientWidth-28)/width,(viewport.clientHeight-28)/height)));
    zoomRef.current=next;setStageSize({width,height});setHierarchyZoom(next);
    window.requestAnimationFrame(()=>viewport.scrollTo({left:0,top:0}));
  },[]);

  const applyHierarchyZoom=useCallback((requested:number,clientX?:number,clientY?:number)=>{
    const viewport=viewportRef.current,stage=stageRef.current;if(!viewport||!stage)return;
    const current=zoomRef.current;
    const next=Math.min(1.6,Math.max(.25,requested));
    if(Math.abs(next-current)<.001)return;
    const rect=viewport.getBoundingClientRect();
    const anchorX=clientX===undefined?viewport.clientWidth/2:clientX-rect.left;
    const anchorY=clientY===undefined?viewport.clientHeight/2:clientY-rect.top;
    const contentX=(viewport.scrollLeft+anchorX)/current;
    const contentY=(viewport.scrollTop+anchorY)/current;
    setStageSize({width:Math.max(stage.scrollWidth,stage.offsetWidth),height:Math.max(stage.scrollHeight,stage.offsetHeight)});
    zoomRef.current=next;setHierarchyZoom(next);
    window.requestAnimationFrame(()=>viewport.scrollTo({left:Math.max(0,contentX*next-anchorX),top:Math.max(0,contentY*next-anchorY)}));
  },[]);

  function changeHierarchyZoom(delta:number){applyHierarchyZoom(Number((zoomRef.current+delta).toFixed(2)))}
  function beginHierarchyPan(event:ReactPointerEvent<HTMLDivElement>){
    if(event.pointerType==="touch"||event.button!==0||(event.target as HTMLElement).closest("button,input,select,textarea,a"))return;
    const viewport=viewportRef.current;if(!viewport)return;
    panRef.current={pointerId:event.pointerId,clientX:event.clientX,clientY:event.clientY,scrollLeft:viewport.scrollLeft,scrollTop:viewport.scrollTop};
    event.currentTarget.setPointerCapture(event.pointerId);setIsPanning(true);
  }
  function moveHierarchyPan(event:ReactPointerEvent<HTMLDivElement>){
    const start=panRef.current,viewport=viewportRef.current;if(!start||!viewport||start.pointerId!==event.pointerId)return;
    viewport.scrollLeft=start.scrollLeft-(event.clientX-start.clientX);viewport.scrollTop=start.scrollTop-(event.clientY-start.clientY);
  }
  function endHierarchyPan(event:ReactPointerEvent<HTMLDivElement>){
    if(panRef.current?.pointerId!==event.pointerId)return;
    panRef.current=null;setIsPanning(false);
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
  }

  useEffect(()=>{
    if(!siteId) return;
    const controller = new AbortController();
    setLoading(true); setLoadError(false);
    fetch(`/api/equipment?siteId=${encodeURIComponent(siteId)}`, { signal: controller.signal, cache: "no-store" }).then(async response=>{
      const data=await response.json();
      if(controller.signal.aborted) return;
      if(!response.ok) throw new Error(data.error || "Unable to load equipment.");
      const next=data.equipment.length?data.equipment as EquipmentAsset[]:starterEquipment(siteId);
      setEquipment(next); setSelectedId(next[0]?.id||""); setVerified(Boolean(data.verified));
      onVerificationChange(siteId, Boolean(data.verified)); setDirty(!data.equipment.length);
      setMessage(data.equipment.length ? "" : "Starter configuration loaded — review and save it for this site.");
    }).catch(reason=>{
      if(controller.signal.aborted) return;
      setEquipment([]); setSelectedId(""); setDirty(false); setLoadError(true);
      setMessage(reason instanceof Error ? reason.message : "Unable to load equipment. Select the site again to retry.");
    }).finally(()=>{if(!controller.signal.aborted) setLoading(false)});
    return () => controller.abort();
  },[siteId,onVerificationChange]);

  const hierarchyRevision=equipment.map(item=>`${item.id}:${item.parentId||""}`).join("|");
  useEffect(()=>{if(loading)return;const frame=window.requestAnimationFrame(fitHierarchy);return()=>window.cancelAnimationFrame(frame)},[loading,siteId,hierarchyRevision,fitHierarchy]);
  useEffect(()=>{if(loading)return;const viewport=viewportRef.current;if(!viewport)return;let frame=0;const observer=new ResizeObserver(()=>{window.cancelAnimationFrame(frame);frame=window.requestAnimationFrame(fitHierarchy)});observer.observe(viewport);return()=>{observer.disconnect();window.cancelAnimationFrame(frame)}},[fitHierarchy,loading]);
  useEffect(()=>{if(loading)return;const viewport=viewportRef.current;if(!viewport)return;const handleWheel=(event:WheelEvent)=>{event.preventDefault();const delta=event.deltaMode===1?event.deltaY*18:event.deltaY;applyHierarchyZoom(zoomRef.current*Math.exp(-delta*.0015),event.clientX,event.clientY)};viewport.addEventListener("wheel",handleWheel,{passive:false});return()=>viewport.removeEventListener("wheel",handleWheel)},[applyHierarchyZoom,loading]);

  function changeSite(nextSiteId:string) { if(nextSiteId===siteId)return; setLoading(true); setLoadError(false); setEquipment([]); setSelectedId(""); setDirty(false); setVerified(Boolean(sites.find(item=>item.id===nextSiteId)?.arrayModelVerified)); setMessage(""); setSiteId(nextSiteId); }
  function patchSelected(field:keyof EquipmentAsset,value:string|number|boolean|string[]|null) {
    setEquipment(current=>current.map(item=>item.id===selectedId?{...item,[field]:value}:item)); setDirty(true); setVerified(false);
  }
  function assignInverters(ids:string[],parentId:string|null) {
    setEquipment(current=>current.map(item=>item.type==="inverter"&&ids.includes(item.id)?{...item,parentId}:item));
    setDirty(true); setVerified(false);
  }
  function add(type:EquipmentType,parentId:string|null=null) {
    let index=type==="transformer"?transformers.length+1:equipment.length+1;
    if(type==="transformer")while(equipment.some(item=>item.externalId.toLowerCase()===`tx-${String(index).padStart(2,"0")}`))index++;
    const next = {...newAsset(siteId,type,parentId,index),position:equipment.length+1};
    setEquipment(current=>[...current,next]); setSelectedId(next.id); setDirty(true); setVerified(false);
  }
  function duplicateSelectedInverter() {
    if(selected?.type!=="inverter")return;
    const childModules=modules.filter(item=>item.parentId===selected.id).sort((a,b)=>a.position-b.position);
    if(equipment.length+childModules.length+1>500){setMessage("This duplicate would exceed the 500-node limit for a site.");return}
    const duplicate:EquipmentAsset={...selected,id:equipmentId(),name:uniqueCopyName(selected.name,equipment),externalId:uniqueCopyExternalId(selected.externalId,equipment),aliases:[],position:equipment.length+1,updatedAt:undefined};
    const created:EquipmentAsset[]=[duplicate];
    const duplicatedModules=childModules.map((module,index)=>{
      const reference=[...equipment,...created];
      const copy:EquipmentAsset={...module,id:equipmentId(),parentId:duplicate.id,name:uniqueCopyName(module.name,reference),externalId:uniqueCopyExternalId(module.externalId,reference),aliases:[],position:equipment.length+index+2,updatedAt:undefined};
      created.push(copy); return copy;
    });
    setEquipment(current=>[...current,duplicate,...duplicatedModules]); setSelectedId(duplicate.id); setDirty(true); setVerified(false);
    setMessage(`${selected.name} duplicated with ${childModules.length} module configuration${childModules.length===1?"":"s"}. New aliases are blank to avoid CSV matching conflicts.`);
  }
  function removeSelected() {
    if(!selected || loading || saving) return;
    const descendants = new Set([selected.id]);
    let changed=true; while(changed){changed=false;equipment.forEach(item=>{if(item.parentId&&descendants.has(item.parentId)&&!descendants.has(item.id)){descendants.add(item.id);changed=true}})}
    if(!window.confirm(`Remove ${selected.name}${descendants.size>1?` and ${descendants.size-1} child node(s)`:""}?`)) return;
    const next=equipment.filter(item=>!descendants.has(item.id)); setEquipment(next); setSelectedId(next[0]?.id||""); setDirty(true); setVerified(false);
  }
  function handleModelKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "Delete" || event.repeat || event.defaultPrevented || event.nativeEvent.isComposing ||
        event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || loading || saving || !selected) return;
    const target = event.target;
    if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return;
    event.preventDefault();
    removeSelected();
  }
  async function save() {
    if(loading || saving || loadError) return;
    setSaving(true); setMessage("");
    try {
      const response=await fetch("/api/equipment",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({siteId,equipment,verified})});
      const data=await response.json(); if(!response.ok) throw new Error(data.error);
      setEquipment(data.equipment); setVerified(Boolean(data.verified)); onVerificationChange(siteId, Boolean(data.verified)); setDirty(false);
      const adjustments=(data.idAdjustments||[]) as Array<{name:string;from:string;to:string}>;
      const nodeIdAdjustments=(data.nodeIdAdjustments||[]) as Array<{name:string;from:string;to:string}>;
      if(adjustments.length)setMessage(`Saved. ${adjustments.map(item=>`${item.name}: ${item.from} → ${item.to}`).join(" · ")} Equipment IDs were made unique so CSV signals remain unambiguous.`);
      else if(nodeIdAdjustments.length)setMessage(`Saved. ${nodeIdAdjustments.length} internal equipment ID${nodeIdAdjustments.length===1?" was":"s were"} reassigned to prevent a cross-site database conflict.`);
      onSaved?.(siteId);
      notify(`${site?.name} equipment configuration saved`);
    } catch(reason){setMessage(reason instanceof Error?reason.message:"Unable to save configuration.")}
    finally{setSaving(false)}
  }
  const totalModules=modules.reduce((sum,item)=>sum+item.quantity,0);
  const totalCapacity=modules.reduce((sum,item)=>sum+(Number(item.moduleRatedCapacityW)||0)*item.quantity/1000,0);

  function renderInverter(inverter:EquipmentAsset) {
    return <div className="inverter-row" key={inverter.id}><span className="inverter-feed"/><div className="inverter-node"><Node item={inverter} dcRatedCapacityKw={inverterDcCapacityKw(inverter.id)} selected={selectedId===inverter.id} onSelect={setSelectedId}/></div><span className="module-feed"/><div className="module-row">{modules.filter(item=>item.parentId===inverter.id).map(item=><Node key={item.id} item={item} selected={selectedId===item.id} onSelect={setSelectedId}/>)}<button className="add-node compact" onClick={()=>add("module_group",inverter.id)}>＋ Module group</button></div></div>;
  }

  return <section className="array-view" aria-labelledby="array-title" onKeyDown={handleModelKeyDown}>
    <header className="settings-header array-header"><div><p className="eyebrow">ASSET CONFIGURATION</p><h1 id="array-title">Array & equipment model</h1><p>Define how power flows through the site and which devices record each measurement.</p></div><div className="array-header-actions"><label className="region-select"><span>SITE</span><select value={siteId} disabled={saving} onChange={event=>changeSite(event.target.value)}>{sites.map(item=><option key={item.id} value={item.id}>{item.name}{item.arrayModelVerified?" ✅":""}</option>)}</select></label><button className="secondary-btn" onClick={onBack}>← Overview</button><label className="model-verified"><input type="checkbox" disabled={loading||saving||loadError||!capacityModel.complete} checked={verified&&capacityModel.complete} onChange={event=>{setVerified(event.target.checked);setDirty(true)}}/><span>Verified</span></label><button className="primary-btn" disabled={loading||loadError||!dirty||saving} onClick={save}>{saving?"Saving…":"Save model"}<span>✓</span></button></div></header>
    <div className="model-summary"><div><span className="summary-icon meter">M</span><p><small>REVENUE METERS</small><strong>{meter?1:0}</strong></p></div><div><span className="summary-icon inverter">↯</span><p><small>INVERTERS</small><strong>{inverters.length}</strong></p></div><div><span className="summary-icon modules">▦</span><p><small>MODULES</small><strong>{totalModules.toLocaleString()}</strong></p></div><div><span className="summary-icon sensor">☼</span><p><small>WEATHER SENSORS</small><strong>{sensors.length}</strong></p></div><div className="summary-capacity"><dl className="capacity-metrics">
      <div><dt>Installed inverter capacity</dt><dd>{inverters.length?`${wholeKw(installedInverterCapacityKw)} kWac`:"Not set"}</dd></div>
      <div><dt>Estimated export after losses</dt><dd>{!capacityModel.complete?"Incomplete model":inverters.length?`${wholeKw(potentialGridExportKw)} kWac`:"Not set"}</dd></div>
      {transformers.length>0&&<div className="transformer-metric"><dt>PV ceiling after transformers</dt><dd>{capacityModel.pvCeilingKw===null?"Incomplete model":`${wholeKw(capacityModel.pvCeilingKw)} kWac`}</dd></div>}
      <div><dt>DC configured</dt><dd>{modules.length?`${wholeKw(totalCapacity)} kWdc`:"Not set"}</dd></div>
    </dl></div></div>
    {message&&<div className="model-message" role="status">{message}</div>}
    {capacityModel.hasTransformers&&!capacityModel.complete&&<div className="model-message" role="status"><strong>Complete transformer configuration before analysis.</strong><ul>{capacityModel.issues.map(issue=><li key={issue}>{issue}</li>)}</ul><span>You can save this draft; verification stays off until the configuration is complete.</span></div>}
    <div className="array-layout">
      <article className="panel topology-panel">
        <div className="topology-head"><div><p className="eyebrow">POWER HIERARCHY</p><h2>{site?.name}</h2><p>Select any node to edit its identity, aliases, and telemetry channels.</p></div><div className="topology-legend"><span><i className="power-line"/> Power path</span><span><i className="data-line"/> Measurement only</span></div></div>
        <div className="array-node-toolbar"><button className="secondary-btn" disabled={loading||saving||loadError||!meter} onClick={()=>add("transformer",meter?.id||null)}>＋ Add transformer</button><span>Meter / POI → transformers → assigned inverters → modules</span></div>
        <div className="mobile-equipment-picker"><label className="field"><span>Select equipment</span><select value={selectedId} disabled={loading || loadError} onChange={event => setSelectedId(event.target.value)}><option value="">Choose equipment…</option>{equipment.map(item => <option key={item.id} value={item.id}>{item.name} · {item.externalId}</option>)}</select></label><button className="secondary-btn" disabled={!selected} onClick={() => { inspectorRef.current?.scrollIntoView({ block: "start", behavior: "instant" }); inspectorRef.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true }); }}>Edit selected</button></div>
        {loading?<div className="topology-empty">Loading equipment model…</div>:loadError?<div className="topology-empty">Equipment model could not be loaded.</div>:<div className="topology-canvas">
          <div className="power-pane">
            <div className="zoom-controls" role="group" aria-label="Power hierarchy zoom controls"><span className="canvas-hint">Drag or swipe to pan · Use − / + to zoom</span><button aria-label="Zoom out" disabled={hierarchyZoom<=.25} onClick={()=>changeHierarchyZoom(-.1)}>−</button><output aria-label="Current zoom">{Math.round(hierarchyZoom*100)}%</output><button aria-label="Zoom in" disabled={hierarchyZoom>=1.6} onClick={()=>changeHierarchyZoom(.1)}>+</button><button className="fit-view" onClick={fitHierarchy} aria-label="Reset and fit hierarchy view" title="Fit model"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M3 3l6 6m12-6-6 6M3 21l6-6m12 6-6-6"/></svg></button></div>
            <div className={`power-viewport ${isPanning?"is-panning":""}`} ref={viewportRef} onPointerDown={beginHierarchyPan} onPointerMove={moveHierarchyPan} onPointerUp={endHierarchyPan} onPointerCancel={endHierarchyPan}>
              <div className="topology-zoom-space" style={{width:stageSize.width?stageSize.width*hierarchyZoom:undefined,height:stageSize.height?stageSize.height*hierarchyZoom:undefined}}><div className="topology-stage" ref={stageRef} style={{transform:`scale(${hierarchyZoom})`}}><div className={`power-tree ${transformers.length?"with-transformers":""}`}>
                <div className="hierarchy-meter"><span className="tier-label">GRID / PCC</span>{meter?<Node item={meter} grossAcCapacityKw={totalInverterAcCapacityKw} gridExportCapacityKw={capacityModel.gridExportKw} selected={selectedId===meter.id} onSelect={setSelectedId}/>:<button className="add-node primary" onClick={()=>add("revenue_meter")}>＋ Add revenue meter</button>}</div>
                {meter&&<div className="meter-elbow"/>}
                {transformers.length>0?<>
                  <div className="transformer-column-headings"><span>TRANSFORMERS</span><span>POWER CONVERSION</span><span>MODULE CONFIGURATIONS</span></div>
                  <div className="transformer-list">{transformers.map(transformer=><div className="transformer-branch" key={transformer.id}><span className="inverter-feed"/><Node item={transformer} selected={selectedId===transformer.id} onSelect={setSelectedId}/><div className="transformer-inverters"><div className="inverter-list">{inverters.filter(item=>item.parentId===transformer.id).map(renderInverter)}</div><div className="add-inverter-row"><span/><button className="add-node inverter-add" onClick={()=>add("inverter",transformer.id)}>＋ Add inverter</button></div></div></div>)}</div>
                  {unassignedInverters.length>0&&<div className="unassigned-inverters"><p>Inverters awaiting transformer assignment</p><div className="inverter-list">{unassignedInverters.map(renderInverter)}</div></div>}
                </>:<div className="horizontal-inverter-tier"><div className="tree-column-headings"><span>POWER CONVERSION</span><span>MODULE CONFIGURATIONS</span></div><div className="inverter-list">{inverters.map(renderInverter)}</div>{meter&&<div className="add-inverter-row"><span/><button className="add-node inverter-add" onClick={()=>add("inverter",meter.id)}>＋ Add inverter</button></div>}</div>}

              </div></div></div>
            </div>
          </div>
          <aside className="sensor-rail"><span className="tier-label">ENVIRONMENTAL MEASUREMENT</span><div className="sensor-connector"/><div className="sensor-list">{sensors.map(sensor=><Node key={sensor.id} item={sensor} selected={selectedId===sensor.id} onSelect={setSelectedId}/>)}<button className="add-node sensor-add" onClick={()=>add("weather_sensor")}>＋ Add sensor</button></div></aside>
        </div>}
      </article>
      <aside ref={inspectorRef} className="panel inspector-panel">{selected?<><div className="inspector-head"><span className={`node-icon ${selected.type}`}><EquipmentIcon type={selected.type}/></span><div><p className="eyebrow">SELECTED NODE</p><h2>{equipmentLabels[selected.type]}</h2></div><button className="trash-delete" aria-label="Delete selected equipment" title="Delete selected equipment (Delete)" aria-keyshortcuts="Delete" disabled={loading||saving} onClick={removeSelected}>🗑</button></div>
        {selected.type==="inverter"&&<div className="duplicate-strip"><button className="duplicate-inverter" onClick={duplicateSelectedInverter}><span>⧉</span><span><strong>Duplicate inverter</strong><small>Copy inverter and all module configurations</small></span></button></div>}
        <div className="inspector-fields"><label className="field"><span>Display name <em>*</em></span><input value={selected.name} onChange={event=>patchSelected("name",event.target.value)}/></label><label className={`field ${duplicateIdPeers.length?"equipment-id-conflict":""}`}><span>Equipment ID / SCADA tag <em>*</em></span><input value={selected.externalId} onChange={event=>patchSelected("externalId",event.target.value)}/><small>{duplicateIdPeers.length?`Also used by ${duplicateIdPeers.map(item=>item.name).join(", ")}. The secondary tag will be made unique when saved.`:"Primary key used during CSV matching"}</small></label><div className="inspector-grid"><label className="field"><span>Manufacturer</span><input value={selected.manufacturer} onChange={event=>patchSelected("manufacturer",event.target.value)}/></label><label className="field"><span>Model</span><input value={selected.model} onChange={event=>patchSelected("model",event.target.value)}/></label></div>
          {selected.type==="transformer"&&<>
            <label className="field"><span>Connected to</span><select value={selected.parentId||""} onChange={event=>patchSelected("parentId",event.target.value||null)}><option value="">Select meter / POI…</option>{meter&&<option value={meter.id}>{meter.name} · {meter.externalId}</option>}</select></label>
            <div className="capacity-section"><p className="capacity-title">TRANSFORMER CAPACITY</p>
              <label className="field"><span>Nameplate rating (kVA)</span><input type="number" min="0" step="any" value={selected.nameplateKva||""} onChange={event=>patchSelected("nameplateKva",event.target.value)}/><small>Default kWac ceiling at power factor 1.0. Applies only to assigned inverters.</small></label>
              <div className="calculated-capacity"><span>ASSIGNED PV INVERTER NAMEPLATE</span><strong>{(selectedTransformer?.inverterKw||0).toLocaleString()} kWac</strong></div>
              <label className="transformer-override"><input type="checkbox" checked={Boolean(selected.pvCeilingOverrideEnabled)} onChange={event=>patchSelected("pvCeilingOverrideEnabled",event.target.checked)}/><span>Override PV ceiling through transformer</span></label>
              {selected.pvCeilingOverrideEnabled&&<label className="field"><span>Manual PV ceiling through transformer (kWac)</span><input type="number" min="0" step="any" value={selected.pvCeilingOverrideKw||""} onChange={event=>patchSelected("pvCeilingOverrideKw",event.target.value)}/><small>Use the approved operating ceiling, including any planned overdrive. The stored kVA nameplate remains unchanged.</small></label>}
              <div className="calculated-capacity export-capacity"><span>PV CEILING THROUGH TRANSFORMER</span><strong>{selectedTransformer?.pvCeilingKw==null?"Not configured":`${selectedTransformer.pvCeilingKw.toLocaleString()} kWac`}</strong><small>Lesser of assigned inverter AC capacity and {selected.pvCeilingOverrideEnabled?"the manual ceiling":"nameplate kVA at power factor 1.0"}.</small></div>
            </div>
            <div className="transformer-assignments"><p className="capacity-title">ASSIGNED INVERTERS</p><button className="secondary-btn" disabled={!unassignedInverters.length} onClick={()=>assignInverters(unassignedInverters.map(item=>item.id),selected.id)}>Assign all unassigned ({unassignedInverters.length})</button><div>{inverters.map(inverter=><label key={inverter.id}><input type="checkbox" checked={inverter.parentId===selected.id} onChange={event=>assignInverters([inverter.id],event.target.checked?selected.id:null)}/><span><strong>{inverter.name} · {inverter.externalId}</strong><small>{inverter.acRatedCapacityKw||"—"} kWac · {transformers.find(item=>item.id===inverter.parentId)?.name||"Unassigned"}</small></span></label>)}</div><small>Checking an inverter moves it to this transformer. Each inverter has one assignment.</small></div>
            <label className="field"><span>Notes</span><textarea rows={2} value={selected.notes||""} onChange={event=>patchSelected("notes",event.target.value)}/></label>
          </>}
          {selected.type==="inverter"&&transformers.length>0&&<label className="field"><span>Assigned transformer</span><select value={transformers.some(item=>item.id===selected.parentId)?selected.parentId||"":""} onChange={event=>patchSelected("parentId",event.target.value||null)}><option value="">Select transformer…</option>{transformers.map(item=><option key={item.id} value={item.id}>{item.name} · {item.externalId}</option>)}</select></label>}
          {selected.type==="revenue_meter"&&<div className="capacity-section revenue-capacity"><p className="capacity-title">GRID EXPORT CAPACITY</p><label className="field calculated-field"><span>Modeled AC capacity before site losses (kWac)</span><input readOnly value={capacityModel.modeledGrossKw===null?"Incomplete model":capacityModel.modeledGrossKw.toLocaleString(undefined,{maximumFractionDigits:2})}/><small>Connected DC capped by inverter AC ratings, then by each configured transformer ceiling.</small></label><div className="inspector-grid"><label className="field"><span>AC line losses (%)</span><input type="number" min="0" max="100" step="any" value={selected.acLineLossPercent} onChange={event=>patchSelected("acLineLossPercent",event.target.value)}/></label><label className="field"><span>Transformer losses (%)</span><input type="number" min="0" max="100" step="any" value={selected.transformerLossPercent} onChange={event=>patchSelected("transformerLossPercent",event.target.value)}/></label></div><div className="calculated-capacity export-capacity"><span>POTENTIAL UTILITY GRID EXPORT</span><strong>{capacityModel.complete?`${potentialGridExportKw.toLocaleString(undefined,{maximumFractionDigits:2})} kWac`:"Incomplete model"}</strong><small>{(capacityModel.modeledGrossKw||0).toLocaleString(undefined,{maximumFractionDigits:2})} × {(1-acLineLossPercent/100).toFixed(4)} line factor × {(1-transformerLossPercent/100).toFixed(4)} transformer factor</small></div><p className="capacity-note">Revenue-meter active power—or interval-average power derived from mapped energy—will be checked against this ceiling during CSV validation.</p></div>}
          {selected.type==="inverter"&&<div className="capacity-section"><p className="capacity-title">INVERTER CAPACITY</p><label className="field"><span>AC rated capacity (kWac)</span><input type="number" min="0" step="any" value={selected.acRatedCapacityKw} onChange={event=>patchSelected("acRatedCapacityKw",event.target.value)}/><small>Manually configured nameplate AC capacity</small></label><label className={`field calculated-field ${dcCapacityExceeded?"capacity-over":""}`}><span>DC rated capacity (kWdc) {dcCapacityExceeded&&<i className="capacity-alert" tabIndex={0} aria-label="DC capacity discrepancy" data-tooltip={`Calculated DC capacity (${selectedDcCapacityKw.toLocaleString(undefined,{maximumFractionDigits:2})} kWdc) exceeds the configured maximum (${selectedMaxDcCapacityKw.toLocaleString(undefined,{maximumFractionDigits:2})} kWdc).`}>!</i>}</span><input readOnly value={selectedDcCapacityKw.toLocaleString(undefined,{maximumFractionDigits:2})}/><small>Calculated from all connected module configurations</small></label><label className="field"><span>Maximum DC capacity (kWdc)</span><input type="number" min="0" step="any" value={selected.maxDcCapacityKw} onChange={event=>patchSelected("maxDcCapacityKw",event.target.value)}/><small>Manual inverter DC input limit</small></label></div>}
          {selected.type==="module_group"&&<div className="capacity-section"><p className="capacity-title">MODULE CONFIGURATION</p><div className="inspector-grid"><label className="field"><span>Rated module capacity (W)</span><input type="number" min="0" step="any" value={selected.moduleRatedCapacityW} onChange={event=>patchSelected("moduleRatedCapacityW",event.target.value)}/></label><label className="field"><span>Module quantity</span><input type="number" min="1" value={selected.quantity} onChange={event=>patchSelected("quantity",Number(event.target.value))}/></label></div><div className="calculated-capacity"><span>CALCULATED GROUP CAPACITY</span><strong>{(((Number(selected.moduleRatedCapacityW)||0)*selected.quantity)/1000).toLocaleString(undefined,{maximumFractionDigits:2})} kWdc</strong><small>Rated watts × module quantity</small></div></div>}
          <label className="field"><span>Matching aliases</span><textarea value={selected.aliases.join(", ")} onChange={event=>patchSelected("aliases",event.target.value.split(",").map(value=>value.trim()).filter(Boolean))} placeholder="INV01, Inverter 1, PCS-A"/><small>Alternate names that may appear in uploaded column headers</small></label><label className="field"><span>Expected telemetry channels</span><textarea value={selected.channels.join(", ")} onChange={event=>patchSelected("channels",event.target.value.split(",").map(value=>value.trim()).filter(Boolean))} placeholder="AC power, Energy, Availability"/><small>Used to score and validate incoming measurements</small></label>
        </div><div className="matching-preview"><span>◎</span><div><strong>Matching fingerprint</strong><p>{[selected.externalId,selected.name,...selected.aliases].filter(Boolean).join(" · ")}</p></div></div></>:<div className="inspector-empty"><span>◎</span><strong>Select equipment</strong><p>Choose a node in the hierarchy to configure it.</p></div>}</aside>
    </div>
  </section>;
}

function Node({item,selected,onSelect,dcRatedCapacityKw=0,grossAcCapacityKw=0,gridExportCapacityKw=0}:{item:EquipmentAsset;selected:boolean;onSelect:(id:string)=>void;dcRatedCapacityKw?:number;grossAcCapacityKw?:number;gridExportCapacityKw?:number|null}) {
  const detail=item.type==="transformer"?`${item.nameplateKva||"—"} kVA${item.pvCeilingOverrideEnabled?` · ${item.pvCeilingOverrideKw||"—"} kWac override`:""}`:item.type==="module_group"?`${item.quantity.toLocaleString()} × ${item.moduleRatedCapacityW||"—"} W`:item.type==="inverter"?`${item.acRatedCapacityKw||"—"} kWac · ${dcRatedCapacityKw.toLocaleString(undefined,{maximumFractionDigits:1})} kWdc`:item.type==="revenue_meter"?`${gridExportCapacityKw===null?"Incomplete export model":`${gridExportCapacityKw.toLocaleString(undefined,{maximumFractionDigits:1})} kW export`} · ${grossAcCapacityKw.toLocaleString(undefined,{maximumFractionDigits:1})} kW gross`:"";
  return <button className={`equipment-node ${item.type} ${selected?"selected":""}`} onClick={()=>onSelect(item.id)} aria-pressed={selected}><span className={`node-icon ${item.type}`}><EquipmentIcon type={item.type}/></span><span><small>{equipmentLabels[item.type]} · {item.externalId}</small><strong>{item.name}</strong>{detail&&<em>{detail}</em>}</span></button>;
}
