'use client';
import {useEffect,useRef,type ReactNode} from 'react';
export default function ReviewModal({title,busy=false,onClose,children}:{title:string;busy?:boolean;onClose:()=>void;children:ReactNode}){
 const dialog=useRef<HTMLDivElement>(null),close=useRef<HTMLButtonElement>(null);
 useEffect(()=>{const previous=document.activeElement as HTMLElement,overflow=document.body.style.overflow;document.body.style.overflow='hidden';close.current?.focus();return()=>{document.body.style.overflow=overflow;previous?.focus();};},[]);
 return <div className="review-overlay" onKeyDown={e=>{
  if(e.key==='Escape'&&!busy)onClose();
  if(e.key==='Tab'){const items=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]')||[]).filter(el=>el.getClientRects().length);const first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
 }}><div ref={dialog} className="review-dialog" role="dialog" aria-modal="true" aria-labelledby="group-review-title"><header><div><p className="eyebrow">ANALYST WORKFLOW</p><h2 id="group-review-title">{title}</h2></div><button ref={close} className="secondary-btn" onClick={onClose} disabled={busy}>Close</button></header>{children}</div></div>;
}
