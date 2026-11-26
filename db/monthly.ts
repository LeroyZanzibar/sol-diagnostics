import type {MonthlySnapshot,MonthlyPreview} from '../app/monthly-types';
import type {MonthlyConfiguration,UtilityValues} from '../app/monthly-domain.mjs';
type MonthlyRuntime={
  read(siteId:string):Promise<Omit<MonthlySnapshot,'confirmedLoss'|'unconfirmedLoss'>>;
  validateSelection(siteId:string,config:MonthlyConfiguration):Promise<void>;
  inputs:{
    saveUtility(siteId:string,revision:number,rows:Array<UtilityValues&{month:string}>):unknown;
    preview(siteId:string,revision:number,config:MonthlyConfiguration):MonthlyPreview;
    saveConfiguration(siteId:string,revision:number,config:MonthlyConfiguration,token:string):unknown;
  };
};
export function getMonthlyRuntime():MonthlyRuntime{
  const runtime=(globalThis as unknown as Record<symbol,{monthly?:MonthlyRuntime}>)[Symbol.for('sol-diagnostics.runtime')];
  if(!runtime?.monthly)throw Error('Monthly storage is unavailable.');return runtime.monthly;
}
