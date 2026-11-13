import {recurringViews,type RecurringIssue} from './recurring-issues';
import {combinedLoss,type ReviewFinding} from './review-groups';
import {localMoment} from './issue-periods';

/** Review presentation only: keep episode identities and loss-bearing events intact. */
export function inverterReviewCards(episodes:RecurringIssue[],visible:ReviewFinding[],originals:ReviewFinding[]){
 const starts=new Map(originals.map(issue=>[issue.id,localMoment(issue.startDateTime)]));
 const unique=[...new Map(visible.map(issue=>[issue.id,issue])).values()];
 const groups=recurringViews(episodes,unique);
 const equipmentIds=[...new Set(groups.map(group=>group.equipmentId))];
 return equipmentIds.map(equipmentId=>{
  const inverterGroups=groups.filter(group=>group.equipmentId===equipmentId).sort((a,b)=>localMoment(a.startDateTime)-localMoment(b.startDateTime)||a.id.localeCompare(b.id));
  const issues=unique.filter(issue=>issue.equipmentId===equipmentId).sort((a,b)=>(starts.get(a.id)??localMoment(a.startDateTime))-(starts.get(b.id)??localMoment(b.startDateTime))||a.id.localeCompare(b.id));
  return {equipmentId,equipmentName:inverterGroups[0].equipmentName,groups:inverterGroups,issues,...combinedLoss(issues)};
 }).sort((a,b)=>a.equipmentName.localeCompare(b.equipmentName,undefined,{numeric:true,sensitivity:'base'})||a.equipmentId.localeCompare(b.equipmentId));
}
export type InverterReviewCardData=ReturnType<typeof inverterReviewCards>[number];

/** Replace one inverter's selection atomically, never selecting filtered-out events. */
export function replaceInverterSelection(selected:string[],visible:ReviewFinding[],equipmentId:string,ids:string[],limit=500){
 const byId=new Map(visible.map(issue=>[issue.id,issue]));
 const retained=selected.filter(id=>byId.has(id)&&byId.get(id)!.equipmentId!==equipmentId);
 const allowed=ids.filter(id=>byId.get(id)?.equipmentId===equipmentId);
 const next=[...new Set([...retained,...allowed])];
 return next.length>limit?null:next;
}
