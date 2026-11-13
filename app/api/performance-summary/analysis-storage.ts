// Internal checkpoints share timestamp strings across equipment. The on-disk
// dictionary also avoids parsing hundreds of thousands of duplicate strings.
type Point={timestamp:string;energyKwh:number};
export function packSummary<T extends {equipmentProduction?:any[]}>(summary:T){
 const timestamps:string[]=[],indexes=new Map<string,number>();
 const index=(timestamp:string)=>{let id=indexes.get(timestamp);if(id===undefined){id=timestamps.length;indexes.set(timestamp,id);timestamps.push(timestamp);}return id;};
 return {...summary,snapshotFormat:1,timestampDictionary:timestamps,equipmentProduction:(summary.equipmentProduction||[]).map(({intervalProduction,...item})=>({...item,intervalTuples:(intervalProduction||[]).map((p:Point)=>[index(p.timestamp),p.energyKwh])}))};
}
export function unpackSummary<T>(input:any):T{
 if(input.snapshotFormat!==1)return input;
 const {snapshotFormat,timestampDictionary,...summary}=input;
 summary.equipmentProduction=summary.equipmentProduction.map(({intervalTuples,...item}:any)=>({...item,intervalProduction:intervalTuples.map(([index,energyKwh]:[number,number])=>({timestamp:timestampDictionary[index],energyKwh}))}));
 return summary;
}

// Keep interval ledgers once in the immutable analysis, not in every SQL row
// or a separate R2 object per issue. Save requests read only this compact index.
export function compactIssueEvidence(evidence: Record<string, unknown> | undefined, resultKey: string) {
  const { intervalLosses, sharedSourceEvents, ...details } = evidence || {};
  return { ...details, evidenceKey: resultKey, evidenceFormat: "analysis-result" };
}

export function issueSaveIndex<T extends { evidence?: Record<string, unknown>; intervalLosses?: unknown; sharedSourceEvents?: unknown }>(
  issues: T[], resultKey: string,
) {
  return issues.map(({ intervalLosses, sharedSourceEvents, ...issue }) => ({
    ...issue, evidence: compactIssueEvidence(issue.evidence, resultKey),
  }));
}
