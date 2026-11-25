'use client';
import {useState} from 'react';
import {combinedLoss,type ReviewFinding} from './review-groups';
import type {IssueReview} from './issue-review';
import BulkReviewDialog,{reviewEnergy} from './BulkReviewDialog';
export default function ReviewWorkbench({siteId,runId,visible,originals,reviews,selected,onClear,onUpdated,readOnly}:{siteId:string;runId:string;visible:ReviewFinding[];originals:ReviewFinding[];reviews:Record<string,IssueReview>;selected:string[];onClear:()=>void;onUpdated:(rows:(IssueReview&{eventKey:string})[])=>void;readOnly:boolean}){
 const [bulk,setBulk]=useState<ReviewFinding[]|null>(null);
 const originalById=new Map(originals.map(i=>[i.id,i])),selection=visible.filter(i=>selected.includes(i.id)),loss=combinedLoss(selection);
 return <section className="review-workbench" aria-label="Grouped analyst review">
  <header><div><p className="eyebrow">REVIEW WORKSPACE</p><h3>Review findings together</h3><p>Select visible findings from the table to review them together.</p></div></header>
  <div className="bulk-review-bar"><div><strong>{selection.length} findings selected</strong><span>{reviewEnergy(loss.known)} in this reporting period{loss.unknown?` · ${loss.unknown} unknown`:''}</span></div><div className="review-actions"><button className="secondary-btn" disabled={!selection.length} onClick={onClear}>Clear selection</button><button className="primary-btn" disabled={readOnly||!selection.length} onClick={()=>{if(!readOnly&&selection.length)setBulk(selection.map(i=>originalById.get(i.id)||i));}}>Review selected…</button></div></div>
  <p className="selection-help">Select findings using the table checkboxes. Up to 500 per action. Changing filters clears the selection.{readOnly?' Select the published current analysis in Manage Analyses to edit reviews.':''}</p>
  {bulk&&<BulkReviewDialog siteId={siteId} runId={runId} findings={bulk} reviews={reviews} onUpdated={onUpdated} onClose={()=>{setBulk(null);onClear();}}/>}
 </section>;
}
