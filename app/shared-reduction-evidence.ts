export type SharedContributor = {issueId:string;equipmentId:string;equipmentName:string;sourceStart:string;sourceEnd:string;
  originalLossKwh:number;sharedLossKwh:number;additionalLossKwh:number;actualKwh:number;expectedKwh:number};
export type SharedEvidenceRow = SharedContributor & {intervalCount:number};
export type SharedEvidenceInterval = SharedContributor & {timestamp:string;intervalMinutes:number;sharedFleetRatio:number};
/** Derived on demand from the immutable ledger, never duplicated into database review rows. */
export function sharedEvidencePage(issue:{intervalMinutes?:number;intervalLosses?:unknown[];sharedSourceEvents?:unknown;evidence?:Record<string,unknown>},offset=0,eventId=''){
  const sources=(issue.sharedSourceEvents||issue.evidence?.sharedSourceEvents||[]) as Pick<SharedContributor,'issueId'|'equipmentId'|'equipmentName'|'sourceStart'|'sourceEnd'>[];
  const points=(issue.intervalLosses||issue.evidence?.intervalLosses||[]) as {timestamp:string;intervalMinutes?:number;sharedFleetRatio:number;sharedContributors?:number[][]}[];
  const rows=new Map<string,SharedEvidenceRow>(),intervals:SharedEvidenceInterval[]=[];
  let intervalCount=0;
  for(const p of points)for(const tuple of p.sharedContributors||[]){
    const source=sources[tuple[0]];if(!source)continue;
    const c:SharedContributor={...source,actualKwh:tuple[1],expectedKwh:tuple[2],originalLossKwh:tuple[3],sharedLossKwh:tuple[4],additionalLossKwh:tuple[5]};
    if(eventId){
      if(c.issueId!==eventId)continue;
      if(intervalCount>=offset&&intervals.length<100)intervals.push({...c,timestamp:p.timestamp,intervalMinutes:p.intervalMinutes||issue.intervalMinutes||60,sharedFleetRatio:p.sharedFleetRatio});
      intervalCount++;continue;
    }
    let row=rows.get(c.issueId);
    if(!row){row={...c,intervalCount:0,originalLossKwh:0,sharedLossKwh:0,additionalLossKwh:0,actualKwh:0,expectedKwh:0};rows.set(c.issueId,row);}
    row.intervalCount++;for(const key of ['originalLossKwh','sharedLossKwh','additionalLossKwh','actualKwh','expectedKwh'] as const)row[key]+=c[key];
  }
  if(eventId)return {intervals,next:offset+100<intervalCount?offset+100:null,total:intervalCount};
  const all=[...rows.values()].sort((a,b)=>a.equipmentName.localeCompare(b.equipmentName)||a.sourceStart.localeCompare(b.sourceStart));
  return {rows:all.slice(offset,offset+30),next:offset+30<all.length?offset+30:null,total:all.length};
}
