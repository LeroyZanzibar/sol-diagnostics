"use client";
import {MonthlyEditor} from './MonthlyWorkspace';
export default function MonthlySettings({siteId}:{siteId:string}){return <div className="panel monthly-settings-panel"><MonthlyEditor key={siteId} siteId={siteId} mode="settings"/></div>;}
