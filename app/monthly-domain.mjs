/** Exact decimal inputs and rational calculations. No input passes through Number. */
export const utilityFields = ['onPeak','offPeak','revenue','energyUsed','invoiceCost'];
export const baselineFields = ['production','revenue','insolation'];
export class MonthlyError extends Error {
  constructor(message, status=400, code='invalid-monthly-input') {super(message);this.name='MonthlyError';this.status=status;this.code=code;}
}
export function demand(condition,message,status=400,code) {if(!condition)throw new MonthlyError(message,status,code);}
const abs=n=>n<0n?-n:n;
function gcd(a,b){a=abs(a);b=abs(b);while(b){const t=a%b;a=b;b=t;}return a||1n;}
function rational(n,d=1n){if(d<0n){n=-n;d=-d;}const g=gcd(n,d);return {n:String(n/g),d:String(d/g)};}
export function fraction(value){
  if(value&&typeof value==='object'&&'n' in value)return value;
  const s=String(value),negative=s.startsWith('-'),[whole,decimal='']=(negative?s.slice(1):s).split('.');
  return rational(BigInt((whole||'0')+decimal)*(negative?-1n:1n),10n**BigInt(decimal.length));
}
export function add(...values){return values.reduce((a,b)=>rational(BigInt(a.n)*BigInt(b.d)+BigInt(b.n)*BigInt(a.d),BigInt(a.d)*BigInt(b.d)),fraction('0'));}
export function multiply(...values){return values.reduce((a,b)=>rational(BigInt(a.n)*BigInt(b.n),BigInt(a.d)*BigInt(b.d)),fraction('1'));}
function power(a,n){return rational(BigInt(a.n)**BigInt(n),BigInt(a.d)**BigInt(n));}
export function validateDecimal(value,signed=false,max='999999999999'){
  demand(typeof value==='string'&&value.length>0&&value.length<=20,'Use 1–20 characters for each numeric value.');
  demand((signed?/^-?(?:\d+(?:\.\d*)?|\.\d+)$/:/^(?:\d+(?:\.\d*)?|\.\d+)$/).test(value),'Use digits and one optional decimal point; only utility money fields permit a leading minus.');
  const x=fraction(value);demand(abs(BigInt(x.n))<=BigInt(max)*BigInt(x.d),`Value must be at most ${max} in magnitude.`);return value;
}
export function nullableDecimal(value,signed=false){return value===null||value===''?null:validateDecimal(value,signed);}
export function formatValue(value,places=0,group=false){
  if(value===null||value===undefined||value==='')return '—';
  const {n,d}=fraction(value),number=BigInt(n),den=BigInt(d),scale=10n**BigInt(places);
  const rounded=(abs(number)*scale*2n+den)/(den*2n);let digits=rounded.toString().padStart(places+1,'0');
  let whole=places?digits.slice(0,-places):digits;if(group)whole=whole.replace(/\B(?=(\d{3})+(?!\d))/g,',');
  return `${number<0n&&rounded!==0n?'-':''}${whole}${places?'.'+digits.slice(-places):''}`;
}
export function utilityTotal(onPeak,offPeak){const values=[onPeak,offPeak].filter(x=>x!==null&&x!==undefined&&x!=='');return values.length?add(...values.map(fraction)):null;}
export function emptyConfiguration(){return {operationsStart:null,degradation:null,irradianceChannelId:null,baselines:Object.fromEntries(Array.from({length:12},(_,i)=>[String(i+1),{production:null,revenue:null,insolation:null}]))};}
export function daysInMonth(year,month){return new Date(Date.UTC(year,month,0)).getUTCDate();}
export function validateMonth(month){demand(typeof month==='string'&&/^\d{4}-(0[1-9]|1[0-2])$/.test(month)&&month>='1900-01'&&month<='2100-12','Use a calendar month from 1900-01 through 2100-12.');return month;}
export function validateConfiguration(input){
  demand(input&&typeof input==='object'&&!Array.isArray(input),'Configuration is required.');
  const {operationsStart,degradation,irradianceChannelId,baselines}=input;
  if(operationsStart!==null){
    demand(typeof operationsStart==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(operationsStart)&&operationsStart>='1900-01-01'&&operationsStart<='2075-12-31','Operations start must be 1900-01-01 through 2075-12-31.');
    const [y,m,d]=operationsStart.split('-').map(Number);demand(m>=1&&m<=12&&d>=1&&d<=daysInMonth(y,m),'Operations start must be a valid calendar date.');
  }
  const rate=degradation===null||degradation===''?null:validateDecimal(degradation,false,'100');
  demand(irradianceChannelId===null||typeof irradianceChannelId==='string'&&irradianceChannelId.length>0&&irradianceChannelId.length<=2048,'Choose an exact irradiance channel.');
  demand(baselines&&typeof baselines==='object'&&Object.keys(baselines).length===12,'Supply twelve calendar-month baselines.');
  const normalized={};for(let m=1;m<=12;m++){const b=baselines[m];demand(b&&typeof b==='object','Each month requires three baseline fields.');normalized[m]=Object.fromEntries(baselineFields.map(k=>[k,nullableDecimal(b[k])]));}
  return {operationsStart,degradation:rate,irradianceChannelId,baselines:normalized};
}
export function horizon(start){if(!start)return [];const [y,m]=start.split('-').map(Number);return Array.from({length:300},(_,i)=>new Date(Date.UTC(y,m-1+i,1)).toISOString().slice(0,7));}
export function projectionRows(config){
  if(!config.operationsStart)return [];
  const [sy,sm,sd]=config.operationsStart.split('-').map(Number),degrade=config.degradation===null||config.degradation===''?null:add(fraction('1'),multiply(fraction(config.degradation),fraction('-0.01')));
  return horizon(config.operationsStart).map(month=>{
    const [y,m]=month.split('-').map(Number),days=daysInMonth(y,m),first=month===config.operationsStart.slice(0,7)?sd:1;
    const anniversaryDay=Math.min(sd,daysInMonth(y,sm));
    // At most two factors in a month. Compute from the original baseline, not
    // rounded yearly outputs (or a per-day chain of repeated additions).
    const base=config.baselines[m];
    const before=m===sm?Math.max(0,anniversaryDay-first):0,after=days-first+1-before;
    const age=Math.max(0,y-sy-(m<sm?1:0));
    // Missing degradation blocks only dependent forecasts, not the horizon or insolation.
    const weighted=degrade===null?null:base.production===null&&base.revenue===null?fraction('0'):add(
      multiply(fraction(String(before)),power(degrade,Math.max(0,age-1))),
      multiply(fraction(String(after)),power(degrade,age)));
    const factor=weighted===null?null:multiply(weighted,{n:'1',d:String(days)}),fractionDays={n:String(days-first+1),d:String(days)};
    return {month,operationalDays:days-first+1,days,production:base.production===null||factor===null?null:multiply(fraction(base.production),factor),revenue:base.revenue===null||factor===null?null:multiply(fraction(base.revenue),factor),insolation:base.insolation===null?null:multiply(fraction(base.insolation),fractionDays)};
  });
}
export function validateUtilityRows(rows){
  demand(Array.isArray(rows)&&rows.length>0&&rows.length<=300,'Save 1–300 monthly rows at a time.');const seen=new Set();
  return rows.map(row=>{demand(row&&typeof row==='object','Invalid monthly row.');const month=validateMonth(row.month);demand(!seen.has(month),'A month may appear only once.');seen.add(month);return {month,...Object.fromEntries(utilityFields.map(k=>[k,nullableDecimal(row[k],k==='revenue'||k==='invoiceCost')]))};});
}
