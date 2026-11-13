import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSource} from './source-module.mjs';
const time=loadSource('app/telemetry-time.ts');
const periods=loadSource('app/issue-periods.ts',[],time);
const axis=loadSource('app/timeline-axis.ts',[],{...time,...periods});
const event=(start,end,timezone='America/New_York')=>({startDateTime:start,endDateTime:end,timezone});

test('daily ticks cover leap months and preserve local midnight across DST',()=>{
 const march=axis.reviewMonthDays(Date.parse('2026-03-01T05:00:00Z'),'America/New_York');
 assert.equal(march.length,31);
 assert.equal(march[8].time-march[7].time,23*3600000);
 assert.equal(march[8].day,9);
 const november=axis.reviewMonthDays(Date.parse('2026-11-01T04:00:00Z'),'America/New_York');
 assert.equal(november[1].time-november[0].time,25*3600000);
 assert.equal(axis.reviewMonthDays(Date.parse('2028-02-01T00:00:00Z'),'UTC').length,29);
});
test('active months retain every day, omit empty months, and exclude an end boundary at midnight',()=>{
 const scale=axis.reviewTimelineScale([
  event('2026-01-29T13:00:00Z','2026-02-01T05:00:00Z'),
  event('2026-03-20T12:00:00Z','2026-03-20T13:00:00Z'),
 ]);
 assert.deepEqual(Array.from(scale.months,m=>axis.formatAxis(m.start,scale.timezone)),['Jan 2026','Mar 2026']);
 for(const month of scale.months){
  assert.equal(month.days[0].day,1);
  assert.equal(month.days.length,31);
  assert.ok(month.minWidth>=month.days.length*32+24);
 }
});
test('close same-row occurrences still expand the timeline and legacy dates keep wall-time days',()=>{
 const scale=axis.reviewTimelineScale([
  event('2026-06-20T08:00:00','2026-06-20T08:15:00'),
  event('2026-06-20T08:30:00','2026-06-20T08:45:00'),
 ]);
 assert.equal(scale.timezone,'UTC');
 const month=scale.months[0];
 assert.ok(month.minWidth>10000);
 assert.equal(month.days[19].time,Date.parse('2026-06-20T00:00:00Z'));
 assert.equal(axis.reviewTimelineScale([]),null);
});
test('close starts on different recurring rows do not expand the shared timeline',()=>{
 const first={...event('2026-06-20T08:00:00Z','2026-06-20T09:00:00Z','UTC'),rowId:'group-a'};
 const next={...event('2026-06-20T08:00:01Z','2026-06-20T09:00:01Z','UTC'),rowId:'group-b'};
 const simultaneous={...first,rowId:'group-c'};
 const separate=axis.reviewTimelineScale([first,next,simultaneous]);
 assert.equal(separate.months[0].minWidth,30*32+24);
 const same=axis.reviewTimelineScale([first,{...next,rowId:'group-a'}]);
 assert.ok(same.months[0].minWidth>10000);
 const nextMonth={...event('2026-07-20T08:00:00Z','2026-07-20T09:00:00Z','UTC'),rowId:'group-b'};
 const mixed=axis.reviewTimelineScale([first,next,nextMonth]);
 const [june,july]=mixed.months;
 assert.ok(Math.abs((june.minWidth-24)/(june.end-june.start)-(july.minWidth-24)/(july.end-july.start))<1e-10);
});
