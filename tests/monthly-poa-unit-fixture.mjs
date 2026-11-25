// Unit/render snapshots represent the authenticated service boundary; native
// proof construction lives separately in selfhost/monthly-poa-fixture.mjs.
export function selectedPoa(siteId='site'){
 const id=JSON.stringify(['measured-poa',1,siteId,'vcom','TEST1','301','SRAD','W/m²']);
 return {state:'selected',selectedSourceId:id,candidates:[{id,siteId,provider:'vcom',systemKey:'TEST1',deviceId:'301',measurement:'SRAD',unit:'W/m²',name:'POA South'}],reason:null};
}
