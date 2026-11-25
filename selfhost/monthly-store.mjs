import {createHmac,randomBytes} from 'node:crypto';
import {demand,emptyConfiguration,validateConfiguration,validateUtilityRows,projectionRows,horizon,modelDcCapacity} from '../app/monthly-domain.mjs';

const configurationSQL='SELECT revision,configuration_json FROM monthly_configuration WHERE site_id=?';
export class MonthlyStore {
  #previewKey=randomBytes(32);
  constructor(database){this.database=database;}
  assertSite(read,siteId){demand(typeof siteId==='string'&&siteId.length>0&&siteId.length<=512,'An exact site ID is required.');demand(read.first('SELECT id FROM site_settings WHERE id=?',siteId),'This site is not available.',404,'site-not-found');}
  snapshot(read,siteId){
    this.assertSite(read,siteId);const config=read.first(configurationSQL,siteId);
    const utility=Object.fromEntries(read.all('SELECT month,on_peak,off_peak,unpaid_energy,revenue,energy_used,invoice_cost FROM monthly_utility WHERE site_id=? ORDER BY month',siteId).map(r=>[r.month,{onPeak:r.on_peak,offPeak:r.off_peak,unpaidEnergy:r.unpaid_energy,revenue:r.revenue,energyUsed:r.energy_used,invoiceCost:r.invoice_cost}]));
    // Read model capacity under the same shared-database snapshot as the inputs.
    // Verification, AC ratings and losses do not gate installed module DC kWp.
    const capacity=modelDcCapacity(read.all('SELECT id,type,parent_id AS parentId,module_rated_capacity_w AS moduleRatedCapacityW,quantity FROM equipment_assets WHERE site_id=? ORDER BY id',siteId));
    return {siteId,revision:config?.revision??0,configuration:config?{...JSON.parse(config.configuration_json),poaSourceId:JSON.parse(config.configuration_json).poaSourceId??null}:emptyConfiguration(),utility,capacity};
  }
  read(siteId){return this.database.withSynchronousRead(read=>this.snapshot(read,siteId));}
  assertRevision(current,revision){demand(Number.isSafeInteger(revision)&&revision>=0,'An edit revision is required.');demand(current.revision===revision,'Monthly data changed in another session. Reload before editing.',409,'monthly-conflict');}
  writeConfiguration(write,siteId,revision,configuration){write.run('INSERT INTO monthly_configuration VALUES (?,?,?,?) ON CONFLICT(site_id) DO UPDATE SET revision=excluded.revision,configuration_json=excluded.configuration_json,updated_at=excluded.updated_at',siteId,revision,JSON.stringify(configuration),new Date().toISOString());}
  saveUtility(siteId,revision,input){
    const rows=validateUtilityRows(input);
    return this.database.withSynchronousWrite(write=>{
      const current=this.snapshot(write,siteId);this.assertRevision(current,revision);
      for(const row of rows)write.run('INSERT INTO monthly_utility (site_id,month,on_peak,off_peak,unpaid_energy,revenue,energy_used,invoice_cost) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(site_id,month) DO UPDATE SET on_peak=excluded.on_peak,off_peak=excluded.off_peak,unpaid_energy=excluded.unpaid_energy,revenue=excluded.revenue,energy_used=excluded.energy_used,invoice_cost=excluded.invoice_cost',siteId,row.month,row.onPeak,row.offPeak,row.unpaidEnergy,row.revenue,row.energyUsed,row.invoiceCost);
      this.writeConfiguration(write,siteId,revision+1,current.configuration);return this.snapshot(write,siteId);
    });
  }
  token(siteId,revision,configuration){return createHmac('sha256',this.#previewKey).update(JSON.stringify(['monthly-impact-v1',siteId,revision,configuration])).digest('hex');}
  preview(siteId,revision,input){
    const configuration=validateConfiguration(input),current=this.read(siteId);this.assertRevision(current,revision);
    const before=new Map(projectionRows(current.configuration).map(row=>[row.month,row])),after=new Map(projectionRows(configuration).map(row=>[row.month,row]));
    const months=[...new Set([...before.keys(),...after.keys()])].sort();
    const impact=months.filter(month=>JSON.stringify(before.get(month))!==JSON.stringify(after.get(month))).map(month=>({month,before:before.get(month)??null,after:after.get(month)??null}));
    const displayed=new Set(horizon(configuration.operationsStart));
    return {siteId,revision,configuration,token:this.token(siteId,revision,configuration),impact,retainedOutsideWindow:Object.keys(current.utility).filter(month=>!displayed.has(month)),sourceChanged:current.configuration.poaSourceId!==configuration.poaSourceId};
  }
  saveConfiguration(siteId,revision,input,token){
    const configuration=validateConfiguration(input);
    demand(typeof token==='string'&&token===this.token(siteId,revision,configuration),'Review the exact projection impact before saving.',409,'impact-required');
    return this.database.withSynchronousWrite(write=>{
      const current=this.snapshot(write,siteId);this.assertRevision(current,revision);this.writeConfiguration(write,siteId,revision+1,configuration);return this.snapshot(write,siteId);
    });
  }
}
