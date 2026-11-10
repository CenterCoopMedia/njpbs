import { it as test } from "vitest";
import { strict as assert } from "node:assert";
import * as h from "../src/lib/schedule-workspace";
import type { BroadcastAiring } from "../src/data/broadcast-schedule";
const source = {coverageStart:'2026-10-01',coverageEnd:'2026-11-05',label:'Test packet',received:'2026-09-16',timezone:'America/New_York'};
const airing: BroadcastAiring = {date:'2026-10-01',time:'5:30 a.m.',station:'NJ PBS',program:'One-on-One',episode:'2951',title:'Guests and community',premiere:false,detailsStatus:'provided',status:'scheduled'};
const slot = (overrides: Partial<BroadcastAiring>) => ({...airing,...overrides});
test('coverage is not mistaken for a live feed',()=>{
 assert.equal(h.scheduleCoverageState(source,'2026-09-18'),'upcoming');
 assert.equal(h.scheduleCoverageState(source,'2026-10-01'),'covered');
 assert.equal(h.scheduleCoverageState(source,'2026-11-05'),'covered');
 assert.equal(h.scheduleCoverageState(source,'2026-11-06'),'expired');
});
test('Eastern date stays on the preceding day before local midnight',()=>{
 assert.equal(h.todayInTimeZone('America/New_York',new Date('2026-10-01T02:00:00Z')),'2026-09-30');
 assert.equal(h.todayInTimeZone('America/New_York',new Date('2026-11-01T06:30:00Z')),'2026-11-01');
});
test('noon and midnight sort correctly',()=>{
 for(const [time,value] of [['12 a.m.',0],['12:30 a.m.',30],['5:30 a.m.',330],['12 p.m.',720],['1 p.m.',780],['11:30 p.m.',1410],['NOON',720],['midnight',0]] as const) assert.equal(h.broadcastTimeMinutes(time),value,time);
});
test('unknown or invalid source times are retained, not guessed',()=>{
 for(const value of ['TBD','25:00','13 p.m.','7:99 p.m.','']) assert.equal(h.broadcastTimeMinutes(value),Number.POSITIVE_INFINITY,value);
});
test('search is case insensitive and combines terms across fields',()=>{
 assert.equal(h.filterBroadcastAirings([airing],{query:'community 2951'}).length,1);
 assert.equal(h.filterBroadcastAirings([airing],{query:'NJ pbs'}).length,1);
 assert.equal(h.filterBroadcastAirings([airing],{query:'unknown'}).length,0);
 assert.equal(h.filterBroadcastAirings([airing],{query:'   '}).length,1);
});
test('station and program filters intersect rather than union',()=>{
 const values=[airing,slot({station:'Thirteen'}),slot({program:'State of Affairs'})];
 assert.deepEqual(h.filterBroadcastAirings(values,{station:'NJ PBS',program:'One-on-One'}),[airing]);
});
test('preemptions and pending descriptions remain distinguishable',()=>{
 const values=[airing,slot({status:'preempted'}),slot({detailsStatus:'pending'}),slot({premiere:true})];
 assert.equal(h.filterBroadcastAirings(values,{status:'preempted'}).length,1);
 assert.equal(h.filterBroadcastAirings(values,{status:'pending'}).length,1);
 assert.equal(h.filterBroadcastAirings(values,{status:'premieres'}).length,1);
});
test('grouping retains every slot and merges episode notes conservatively',()=>{
 const values=[airing,slot({time:'12 a.m.',station:'Thirteen',status:'preempted',premiere:true,detailsStatus:'pending'})];
 const result=h.groupEpisodeAirings(values);
 assert.equal(result.length,1); assert.equal(result[0].slots.length,2);
 assert.equal(result[0].premiere,true); assert.equal(result[0].detailsStatus,'pending');
 assert.equal(result[0].slots[0].time,'12 a.m.'); assert.equal(result[0].slots[0].status,'preempted');
 assert.equal(values[0],airing);
});
test('different programs and episodes do not collapse into one row',()=>{
 assert.equal(h.groupEpisodeAirings([airing,slot({program:'Other program'}),slot({episode:'2952'})]).length,3);
});
test('chronological grouping is stable without mutating the source',()=>{
 const values=[slot({time:'11 p.m.',episode:'late'}),slot({time:'TBD',episode:'unknown'}),slot({time:'12 a.m.',episode:'early'})];
 const before=JSON.stringify(values);
 assert.deepEqual(h.groupEpisodeAirings(values).map(g=>g.episode),['early','late','unknown']);
 assert.equal(JSON.stringify(values),before);
});
test('unknown status query is treated as all slots',()=>{
 assert.equal(h.parseScheduleStatus('unexpected'),'all');
 assert.equal(h.parseScheduleStatus(null),'all');
 assert.equal(h.parseScheduleStatus('preempted'),'preempted');
});
