import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSource} from './source-module.mjs';
import {LocalDatabase} from '../selfhost/storage.mjs';

const csv=loadSource('app/site-settings-csv.ts');
const plain=value=>JSON.parse(JSON.stringify(value));
const existing={id:'existing',name:'Existing',address:'Keep address',city:'Boston',state:'MA',zip:'02108',country:'US',latitude:'42',longitude:'-71',expectedShading:'included',expectedSnow:'unknown',expectedProductionNotes:'Keep notes',arrayModelVerified:1,updatedAt:'before'};
function fixture(t){
 const db=new LocalDatabase(':memory:','drizzle');t.after(()=>db.close());
 db.sqlite.prepare('INSERT INTO site_settings(id,name,address,city,state,zip,country,latitude,longitude,expected_shading,expected_snow,expected_production_notes,array_model_verified,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values(existing));
 const api=loadSource('app/api/site-settings/csv/route.ts',[],{...csv,getDatabaseBinding:()=>db});
 return {db,api};
}
const request=(text,mode='preview',token)=>new Request(`https://example.test/api/site-settings/csv?mode=${mode}`,{method:'POST',headers:{'Content-Type':'text/csv',...(token?{'X-Site-Preview-Token':token}:{})},body:text});
const read=async(db)=>(await db.prepare('SELECT * FROM site_settings ORDER BY id').all()).results;

test('theme display name changes without changing stored foundry identity',()=>{
 const themes=loadSource('app/themes.ts');assert.equal(themes.themes.find(t=>t.id==='foundry').name,'Light - alternate');assert.equal(themes.isThemeId('foundry'),true);
});

test('CSV handles BOM, CRLF, quoted commas, escaped quotes, multiline and postal zeroes',()=>{
 const text='\ufeffid,name,zip,expectedProductionNotes\r\n,"North, ""Field""",02108,"Line one\r\nLine two"\r\n';
 const plan=csv.planSiteCsv(text,[]);assert.equal(plan.errors.length,0);assert.equal(plan.rows[0].site.name,'North, "Field"');assert.equal(plan.rows[0].site.zip,'02108');assert.equal(plan.rows[0].site.expectedProductionNotes,'Line one\r\nLine two');
 assert.equal(csv.planSiteCsv(csv.sitesToCsv([plan.rows[0].site]),[plan.rows[0].site]).errors.length,0);
});

test('CSV rejects structural, enum, numeric, country and ID errors with source rows',()=>{
 const invalid=['name,name\na,b','name,typo\na,b','id\nexisting','name\n"unfinished','name\nno"quote','name\n"done"tail','name,zip\na,123','name,latitude\na,91','name,longitude\na,NaN','name,latitude\na,0x10','name,expectedSnow\na,yes','name,country\na,XX','id,name\nmissing,Test','id,name\nexisting,One\nexisting,Two','name\n','name\n'+ 'a'.repeat(201),'name\n'+Array(501).fill('Test').join('\n')];
 for(const text of invalid){const plan=csv.planSiteCsv(text,[existing]);assert.ok(plan.errors.length,text);assert.ok(plan.errors.every(e=>e.row>=1),text);}
 assert.equal(csv.planSiteCsv('id,name,latitude\nexisting,,', [existing]).rows[0].site.name,'Existing');
 assert.ok(csv.planSiteCsv('name\n'+ 'x'.repeat(csv.SITE_CSV_MAX_BYTES),[]).errors.length);
 assert.equal(csv.planSiteCsv('name,latitude,longitude\nEdge,-90,180',[]).errors.length,0);
 const maximum=csv.planSiteCsv('name\n'+Array(500).fill('Same name').join('\n'),[]);assert.equal(maximum.errors.length,0);assert.equal(new Set(maximum.rows.map(r=>r.site.id)).size,500);
 assert.equal(csv.planSiteCsv('name,latitude,longitude\nEdge,90,-180',[]).errors.length,0);
 assert.ok(csv.planSiteCsv('id,name\n existing,Name',[existing]).errors.length);
 assert.equal(csv.planSiteCsv('name,expectedProductionNotes,latitude\n"A\nB",notes,91',[]).errors[0].row,2);
});

test('template is header-only and downloads contain exact IDs and safely escaped strings',async t=>{
 const {api}=fixture(t);
 const template=await api.GET(new Request('https://example.test/api/site-settings/csv?download=template'));
 assert.equal(template.status,200);assert.match(template.headers.get('Content-Disposition'),/template.csv/);assert.equal((await template.text()).replace(/^\ufeff/,'').trim(),csv.SITE_CSV_HEADERS.join(','));
 const exported=await api.GET(new Request('https://example.test/api/site-settings/csv?download=sites'));
 const text=await exported.text();assert.match(text,/existing/);assert.match(text,/02108/);assert.equal(exported.headers.get('Cache-Control'),'private, no-store');
 const dangerous={...existing,name:'=HYPERLINK("bad")'};const encoded=csv.sitesToCsv([dangerous]);assert.match(encoded,/'=HYPERLINK/);assert.equal(csv.planSiteCsv(encoded,[dangerous]).rows[0].site.name,dangerous.name);
});

test('preview writes nothing; explicit apply updates and creates atomically preserving optional settings and array state',async t=>{
 const {db,api}=fixture(t),before=plain(await read(db));
 const text='id,name,city,zip,expectedShading\r\nexisting,Renamed,,,\r\n,New site,New York,00123,unknown\r\n';
 const preview=await api.POST(request(text));assert.equal(preview.status,200);const plan=await preview.json();assert.equal(plan.created,1);assert.equal(plan.updated,1);assert.deepEqual(plain(await read(db)),before);
 const applied=await api.POST(request(text,'apply',plan.previewToken));assert.equal(applied.status,200);const result=await applied.json();assert.equal(result.sites.length,2);
 const saved=(await read(db)).find(s=>s.id==='existing');assert.equal(saved.name,'Renamed');assert.equal(saved.city,'Boston');assert.equal(saved.expected_shading,'included');assert.equal(saved.expected_snow,'unknown');assert.equal(saved.expected_production_notes,'Keep notes');assert.equal(saved.array_model_verified,1);
 assert.equal((await read(db)).find(s=>s.id==='new-site').zip,'00123');
 assert.equal((await api.POST(request(text,'apply',plan.previewToken))).status,409);
});

test('invalid rows, malformed requests, stale previews and missing confirmation never partially write',async t=>{
 const {db,api}=fixture(t),before=plain(await read(db));
 for(const text of ['id,name,latitude\nexisting,Changed,\n,Invalid,91','id,name\nexisting,Changed\nmissing,Nope']){
  assert.equal((await api.POST(request(text))).status,400);assert.equal((await api.POST(request(text,'apply','bad'))).status,400);assert.deepEqual(plain(await read(db)),before);
 }
 const text='id,name\nexisting,Changed\n,New';const preview=await(await api.POST(request(text))).json();
 assert.equal((await api.POST(request(text,'apply'))).status,409);
 db.sqlite.prepare("UPDATE site_settings SET city='Changed elsewhere' WHERE id='existing'").run();
 assert.equal((await api.POST(request(text,'apply',preview.previewToken))).status,409);assert.equal((await read(db)).length,1);
 assert.equal((await api.POST(request(text,'bad'))).status,400);
 assert.equal((await api.POST(new Request('https://example.test/api/site-settings/csv',{method:'POST',body:JSON.stringify({csv:text})}))).status,415);
 assert.equal((await api.POST(new Request('https://example.test/api/site-settings/csv',{method:'POST',headers:{'Content-Type':'text/csv'},body:new Uint8Array([0xff,0xfe])}))).status,400);
 assert.equal((await api.POST(request('x'.repeat(csv.SITE_CSV_MAX_BYTES+1)))).status,413);
});

test('database write failure rolls back earlier updates and creates in the same batch',async t=>{
 const {db,api}=fixture(t),before=plain(await read(db));
 const text='id,name\nexisting,Changed\n,First new\n,Fail new';const preview=await(await api.POST(request(text))).json();
 db.sqlite.exec("CREATE TRIGGER reject_test_site BEFORE INSERT ON site_settings WHEN NEW.name='Fail new' BEGIN SELECT RAISE(ABORT,'Injected write failure'); END;");
 const response=await api.POST(request(text,'apply',preview.previewToken));assert.equal(response.status,500);assert.deepEqual(plain(await read(db)),before);
});

test('apply guards concurrent edits between snapshot and batch and rolls back',async t=>{
 const {db,api}=fixture(t);const text='id,name\nexisting,Changed\n,New';const preview=await(await api.POST(request(text))).json();const batch=db.batch.bind(db);
 db.batch=async statements=>{db.sqlite.prepare("UPDATE site_settings SET city='Concurrent' WHERE id='existing'").run();return batch(statements)};
 assert.equal((await api.POST(request(text,'apply',preview.previewToken))).status,500);const rows=await read(db);assert.equal(rows.length,1);assert.equal(rows[0].name,'Existing');assert.equal(rows[0].city,'Concurrent');
});
