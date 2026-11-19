// TEST ONLY. No application module imports this file. Intercepts the fixed
// official VCOM origin under an explicit Node --import preload; never adds a
// configurable production endpoint, bypasses app auth, or contacts live VCOM.
import {appendFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LocalDatabase} from '../../selfhost/storage.mjs';
export const fixtureAuth={mode:'basic',apiKey:'synthetic-vcom-key-only',username:'synthetic-vcom-user-only',password:'synthetic-vcom-password-only'};
export const fixtureLogin={username:'fixture',password:'synthetic-local-password-2026'};
export const fixtureSiteId='cedar-creek-synthetic';
export const fixtureMappings=[{sourceId:'simulation:expected',equipmentId:'@site',measurement:'Expected Production'},{sourceId:'irradiance:combined',equipmentId:'weather',measurement:'Irradiance'},...['101','102'].map((id,i)=>({sourceId:`inverter:${id}:E_INT`,equipmentId:`inv${i+1}`,measurement:'Energy'})),{sourceId:'meter:201:M_E_INT_EXP',equipmentId:'meter',measurement:'Energy'},{sourceId:'meter:201:M_E_INT_IMP',equipmentId:'meter',measurement:'Other'}];
export function syntheticMetadata(){
 const base='/systems/TEST1',map={
  [base]:{data:{name:'Synthetic Cedar Creek Solar',timezone:{name:'UTC'}}},
  [`${base}/inverters`]:{data:[{id:'101',name:'Inverter 1'},{id:'102',name:'Inverter 2'}]},
  [`${base}/meters`]:{data:[{id:'201',name:'Revenue meter'}]},
  [`${base}/sensors`]:{data:[{id:'301',name:'POA South'}]}
 };
 // Response envelopes and exact paths follow provider-owned tests/vcom-provider.test.mjs.
 for(const [family,id,abbrs,unit,aggregation] of [['inverters','101',['E_INT'],'Wh','SUM'],['inverters','102',['E_INT'],'kWh','SUM'],['meters','201',['M_E_INT_EXP','M_E_INT_IMP'],'kWh','SUM'],['sensors','301',['SRAD'],'W/m²','AVG']]){
  const path=`${base}/${family}/${id}/abbreviations`;map[path]={data:abbrs};for(const abbr of abbrs)map[`${path}/${abbr}`]={data:{unit,aggregation,precision:3,description:'Synthetic offline test metadata'}};
 }
 return map;
}
export function syntheticPayload(url){
 const u=new URL(url),path=u.pathname.replace(/^\/v2/,''),metadata=syntheticMetadata();if(metadata[path])return metadata[path];
 if(!path.startsWith('/systems/TEST1/'))throw Error('Synthetic fixture supports only exact TEST1.');
 const start=Date.parse(u.searchParams.get('from')),to=Date.parse(u.searchParams.get('to'));
 if(!Number.isFinite(start)||!Number.isFinite(to)||to<start)throw Error('Synthetic fixture requires the provider date-bounded query.');
 const satellite=path.endsWith('/satellite/irradiance'),end=satellite?to:to+1000,iso=t=>new Date(t).toISOString(),H=3600000;
 if(path.endsWith('/calculations/simulation'))return {data:Array.from({length:(end-start)/300000},(_,i)=>({timestamp:iso(start+i*300000),expected:i===0?null:12}))};
 if(satellite)return {data:Array.from({length:(end-start)/H+1},(_,i)=>({timestamp:iso(start+i*H),value:i===2?null:i===1?0:500}))};
 if(path.endsWith('/inverters/bulk/measurements'))return Object.fromEntries(Array.from({length:(end-start)/H},(_,i)=>[iso(start+(i+1)*H),{'101':{E_INT:2000},'102':{E_INT:3}}]));
 const match=/\/(meters|sensors)\/(201|301)\/abbreviations\/(M_E_INT_EXP|M_E_INT_IMP|SRAD)\/measurements$/.exec(path);
 if(match)return {data:{[match[2]]:{[match[3]]:Array.from({length:(end-start)/H},(_,i)=>({timestamp:iso(start+(i+1)*H),value:match[3]==='SRAD'?600:match[3]==='M_E_INT_IMP'?-1:5}))}}};
 throw Error(`Unsupported synthetic fixture path: ${path}`);
}
export function createSyntheticVcomFetch({fallback=globalThis.fetch,onRequest=()=>{},tracePath=null}={}){
 return async(input,init={})=>{
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  if(url.origin!=='https://api.meteocontrol.de')return fallback(input,init);
  const headers=new Headers(init.headers),expected='Basic '+Buffer.from(`${fixtureAuth.username}:${fixtureAuth.password}`).toString('base64');
  if(headers.get('x-api-key')!==fixtureAuth.apiKey||headers.get('authorization')!==expected)return new Response('{"error":"synthetic credentials rejected"}',{status:401});
  onRequest(url);if(tracePath)appendFileSync(tracePath,JSON.stringify({synthetic:true,path:url.pathname,query:Object.fromEntries(url.searchParams),at:new Date().toISOString()})+'\n',{mode:0o600});
  return new Response(JSON.stringify(syntheticPayload(url)),{headers:{'Content-Type':'application/json'}});
 };
}
export function seedSyntheticSite(directory){
 const root=resolve(directory);mkdirSync(root,{recursive:true,mode:0o700});const dbPath=join(root,'sol-diagnostics.sqlite');
 if(existsSync(dbPath))throw Error('Refusing to seed an existing database. Use a NEW isolated fixture directory.');
 const db=new LocalDatabase(dbPath,resolve('drizzle'));
 try{
  db.sqlite.prepare('INSERT INTO site_settings(id,name,country,latitude,longitude,array_model_verified) VALUES(?,?,?,?,?,1)').run(fixtureSiteId,'Synthetic Cedar Creek Solar','US','35.2','-80.8');
  const insert=db.sqlite.prepare('INSERT INTO equipment_assets(id,site_id,type,name,external_id,parent_id,ac_rated_capacity_kw,max_dc_capacity_kw,nameplate_kva,module_rated_capacity_w,quantity) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  insert.run('meter',fixtureSiteId,'revenue_meter','Revenue meter','201',null,'200','','','',1);
  insert.run('transformer',fixtureSiteId,'transformer','Transformer','T1','meter','','','200','',1);
  for(let i=1;i<=2;i++){insert.run(`inv${i}`,fixtureSiteId,'inverter',`Inverter ${i}`,String(100+i),'transformer','100','150','','',1);insert.run(`modules${i}`,fixtureSiteId,'module_group',`Modules ${i}`,`MOD${i}`,`inv${i}`,'','','','400',300);}
  insert.run('weather',fixtureSiteId,'weather_sensor','Weather station','301',null,'','','','',1);
 }finally{db.close();}
 return {synthetic:true,siteId:fixtureSiteId,systemKey:'TEST1',login:fixtureLogin,credentials:fixtureAuth,mappings:fixtureMappings,selectedPoaSourceId:'poa:301',fromDate:'2026-01-01',throughDate:'2026-01-01'};
}
if(process.env.SOL_TEST_VCOM_FIXTURE==='1')globalThis.fetch=createSyntheticVcomFetch({tracePath:process.env.SOL_TEST_VCOM_TRACE||null});
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)&&process.argv[2]==='--seed'){
 if(!process.argv[3])throw Error('Pass a NEW isolated synthetic data directory.');console.log(JSON.stringify(seedSyntheticSite(process.argv[3]),null,2));
}
