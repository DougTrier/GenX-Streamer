// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';import assert from 'node:assert/strict';
import { assessPlaybackReport } from '../../scripts/check-playback-report.mjs';
const record=(elapsedMs,event,values)=>({elapsedMs,record:{mode:'paid',event,values}});
const capture=(extra=[])=>({schemaVersion:1,records:[record(0,'state',{state:'playing',channelSequence:1}),...Array.from({length:121},(_,i)=>record(1000+i*5000,'sample',{totalFrames:60+i*300,droppedFrames:i<120?1:2})),...extra,record(602000,'sample',{totalFrames:36120,droppedFrames:2})].sort((a,b)=>a.elapsedMs-b.elapsedMs)});

test('long decoded playback can pass without pretending unmeasured compositor alignment is verified',()=>{const r=assessPlaybackReport(capture(),'paid');assert.equal(r.status,'PASS');assert.match(r.limits,/GPU/);});
test('the default release interval requires five full minutes of observed playback',()=>{
 const five=capture();five.records=five.records.filter(e=>e.elapsedMs<=300000);five.records.push(record(300000,'sample',{totalFrames:18000,droppedFrames:1}));
 assert.equal(assessPlaybackReport(five,'paid').status,'PASS');
 const short={...five,records:five.records.filter(e=>e.elapsedMs<300000)};short.records.push(record(299000,'sample',{totalFrames:17940,droppedFrames:1}));
 assert.equal(assessPlaybackReport(short,'paid').status,'INCOMPLETE');
});
test('recovery and repeated buffering are release failures even when the last state is Playing',()=>{for(const extra of [[record(30000,'recovery',{channelSequence:1})],[record(30000,'state',{state:'buffering',channelSequence:1})]])assert.equal(assessPlaybackReport(capture(extra),'paid').status,'FAIL');});
test('a frozen picture or short successful start does not pass',()=>{assert.equal(assessPlaybackReport({schemaVersion:1,records:[record(0,'state',{state:'playing'}),record(602000,'sample',{totalFrames:0})]},'paid').status,'INCOMPLETE');assert.equal(assessPlaybackReport(capture(),'paid',700).status,'INCOMPLETE');});
test('stable measured misalignment fails; an unfinished layout is identified separately',()=>{assert.equal(assessPlaybackReport(capture([record(10000,'native-geometry',{aligned:false})]),'paid').status,'FAIL');assert.equal(assessPlaybackReport(capture([record(10000,'native-geometry',{aligned:false,layoutPending:true})]),'paid').status,'PASS');});

test('a later frozen picture fails even if frames advanced earlier',()=>{
 const r=capture();
 for(const entry of r.records) if(entry.elapsedMs>300000 && entry.record.event==='sample') entry.record.values.totalFrames=18000;
 assert.equal(assessPlaybackReport(r,'paid').status,'FAIL');
});
test('sparse endpoint observations cannot stand in for sustained coverage',()=>{
 const r=capture();r.records=r.records.filter((e)=>e.elapsedMs<2000||e.elapsedMs>601000);
 assert.equal(assessPlaybackReport(r,'paid').status,'INCOMPLETE');
});

 test('native live-window rejoins fail the gate even if controller stays Playing',()=>{
   const r=assessPlaybackReport(capture([record(30000,'native-geometry',{liveWindowRecoveries:1}),record(35000,'native-geometry',{liveWindowRecoveries:1}),record(40000,'native-geometry',{liveWindowRecoveries:2})]),'paid');
   assert.equal(r.status,'FAIL');assert.equal(r.errors,2);
 });

test('counts recoveries across native session replacement as well as within one session',()=>{
 const r=assessPlaybackReport(capture([record(30000,'native-geometry',{nativeSession:1,liveWindowRecoveries:2}),record(35000,'native-geometry',{nativeSession:2,liveWindowRecoveries:0}),record(40000,'native-geometry',{nativeSession:2,liveWindowRecoveries:1})]),'paid');
 assert.equal(r.status,'FAIL');assert.equal(r.errors,3);
});
