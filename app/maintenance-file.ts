import * as XLSX from 'xlsx';
import {maintenanceHeader,parseMaintenanceSheet,MAX_MAINTENANCE_FILE_BYTES} from './maintenance-data';

export async function readMaintenanceFile(file:File){
  if(!/\.(csv|xlsx)$/i.test(file.name))throw Error('Choose a CSV or Excel (.xlsx) file.');
  if(file.size>MAX_MAINTENANCE_FILE_BYTES)throw Error('Choose a file smaller than 10 MB.');
  const workbook=XLSX.read(await file.arrayBuffer(),{type:'array',raw:true,cellDates:false,cellFormula:false,cellHTML:false,sheetRows:5032});
  const sheets=workbook.SheetNames.map(name=>({name,table:XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name],{header:1,raw:true,defval:'',blankrows:true})})).filter(sheet=>maintenanceHeader(sheet.table)>=0);
  if(!sheets.length)throw Error('No worksheet contains Date, Site, and Task columns.');
  if(sheets.length>1)throw Error('More than one worksheet has maintenance data. Upload one calendar sheet at a time, or export that sheet as CSV.');
  const sheet=workbook.Sheets[sheets[0].name];
  if(sheet['!fullref']&&XLSX.utils.decode_range(sheet['!fullref']).e.r>=5032)throw Error('The worksheet is too large. Use at most 5,000 maintenance rows.');
  return {...parseMaintenanceSheet(sheets[0].table,!!workbook.Workbook?.WBProps?.date1904),sheetName:sheets[0].name};
}
