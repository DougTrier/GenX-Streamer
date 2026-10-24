/*
 * Copyright 2026 Doug Trier
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

process.env.GENX_APPROVED_FLIP_SERIAL = 'fixture-flip';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAppUid,parseUidProcesses,parseProcStat,cpuDelta,parsePss,parsePower,parseWindowFlags,parseAndroidOptions,runRestoreCycle,assessTerminalResources,requireOriginalPair,waitForOwnedEndpoint,drainOwnedObserver,classifyAndroidResourceError } from '../../scripts/android-resources.mjs';

test('complete symbolic window flags prove cleared state while incomplete or mixed coverage stays unknown',()=>{
 const owned='Window #0 Window{abc com.tmg.tv/.MainActivity}:\n mAttrs fl=LAYOUT_IN_SCREEN\n HARDWARE_ACCELERATED DRAWS_SYSTEM_BAR_BACKGROUNDS\n pfl=NO_MOVE_ANIMATION';
 assert.deepEqual(parseWindowFlags(owned),{ownedWindows:1,keepScreenOn:false});
 assert.equal(parseWindowFlags(owned.replace('LAYOUT_IN_SCREEN','KEEP_SCREEN_ON LAYOUT_IN_SCREEN')).keepScreenOn,true);
 assert.equal(parseWindowFlags(owned.split('\n pfl=')[0]).keepScreenOn,null);
 assert.equal(parseWindowFlags(owned+'\nWindow #1 Window{def com.tmg.tv/.MainActivity}:\n unavailable').keepScreenOn,null);
 assert.equal(parseWindowFlags(owned+'\nWindow #1 Window{def other.app/.MainActivity}:\n KEEP_SCREEN_ON').keepScreenOn,false);
});
test('device ownership requires approved serial and one exact APK identity before any runtime',()=>{
 const base=['fixture-flip','--physical-approved','--expected-apk-sha256='+ 'a'.repeat(64)];
 assert.equal(parseAndroidOptions(base).serial,'fixture-flip');
 for(const args of [[],['other',...base.slice(1)],base.slice(0,2),[...base,base[2]],[...base,'--seconds=4'],[...base,'--interval=0'],[...base,'--seconds=10','--seconds=20']])assert.throws(()=>parseAndroidOptions(args));
});
test('UID parser refuses ambiguous identity and process coverage excludes different UID',()=>{
 assert.equal(parseAppUid('userId=10432'),10432);assert.throws(()=>parseAppUid('userId=10432 userId=10433'));
 assert.deepEqual(parseUidProcesses('PID UID NAME\n1 10432 com.tmg.tv\n2 99001 isolated-renderer\n3 10432 com.tmg.tv:helper',10432),[{pid:1,uid:10432},{pid:3,uid:10432}]);
 assert.throws(()=>parseUidProcesses('1 10432 com.tmg.tv\n1 10432 duplicate',10432));
});
test('proc stat handles command parentheses, preserves start identity and rejects wrong PID',()=>{
 const fields=Array(20).fill('0');fields[0]='S';fields[11]='100';fields[12]='20';fields[19]='900';
 assert.deepEqual(parseProcStat('12 (app (worker)) '+fields.join(' '),12),{pid:12,userTicks:100,systemTicks:20,startTicks:900});
 assert.throws(()=>parseProcStat('12 (app) '+fields.join(' '),13));
});
test('CPU deltas use observed tick rate and core count, never attribute reused PIDs',()=>{
 const before={pid:1,userTicks:10,systemTicks:10,startTicks:100},after={...before,userTicks:60};
 assert.deepEqual(cpuDelta(before,after,1000,100,4),{status:'measured',cpuSeconds:0.5,percentOneCore:50,percentMachine:12.5});
 assert.equal(cpuDelta(before,{...after,startTicks:101},1000,100,4).status,'identity-changed');
 assert.throws(()=>cpuDelta(before,after,1000,0,4));
});
test('PSS/RSS absent sensors remain null and older TOTAL line is supported',()=>{
 assert.deepEqual(parsePss('TOTAL PSS: 123 TOTAL RSS: 456'),{pssKiB:123,rssKiB:456});
 assert.deepEqual(parsePss('  TOTAL 123 0 0'),{pssKiB:123,rssKiB:null});
 assert.deepEqual(parsePss('Permission denied'),{pssKiB:null,rssKiB:null});
});
test('wake lock observations are UID-scoped and absent dump stays unknown',()=>{
 assert.equal(parsePower('Wake Locks: size=2\n PARTIAL_WAKE_LOCK uid=10432\n PARTIAL_WAKE_LOCK uid=10433',10432).wakeLockCount,1);
 assert.equal(parsePower('Permission denied',10432).wakeLockCount,null);
});
test('window flag observations require owned window and distinguish explicit flag from unknown',()=>{
 assert.equal(parseWindowFlags('Window #0 Window{abc com.tmg.tv/.MainActivity}:\n mAttrs fl=80').keepScreenOn,true);
 assert.equal(parseWindowFlags('Window #0 Window{abc other.app/.MainActivity}:\n KEEP_SCREEN_ON').keepScreenOn,null);
 assert.equal(parseWindowFlags('Window #0 Window{abc com.tmg.tv/.MainActivity}:\n hidden').keepScreenOn,null);
});

test('restoration waits first actual exit and only writes in a newly launched idle instance',async()=>{
 const calls=[];let finish;const stopped=new Promise(resolve=>{finish=resolve;});let stops=0;
 const work=runRestoreCycle({stop:async()=>{calls.push('stop');if(++stops===1)await stopped;},launchIdle:async()=>calls.push('new-idle'),restore:async()=>calls.push('restore')});
 await Promise.resolve();assert.deepEqual(calls,['stop']);finish();await work;
 assert.deepEqual(calls,['stop','new-idle','restore','stop']);
});
test('unconfirmed first exit forbids restore and failed restore still closes the idle instance',async()=>{
 const calls=[];await assert.rejects(runRestoreCycle({stop:async()=>{throw new Error('unconfirmed')},launchIdle:async()=>calls.push('launch'),restore:async()=>calls.push('write')}));assert.deepEqual(calls,[]);
 await assert.rejects(runRestoreCycle({stop:async()=>calls.push('stop'),launchIdle:async()=>calls.push('launch'),restore:async()=>{calls.push('write');throw new Error('failure')}}));assert.deepEqual(calls,['stop','launch','write','stop']);
});

test('terminal resource assessment requires all owned zero counts before clean measurement',()=>{
 const closed={activeSockets:0,activeResponses:0,timers:0};assert.equal(assessTerminalResources(closed,0).clean,true);
 for(const fixture of [undefined,{}, {...closed,timers:undefined},{...closed,activeSockets:1},{...closed,activeResponses:1},{...closed,timers:1}])assert.equal(assessTerminalResources(fixture,0).clean,false);
 assert.equal(assessTerminalResources(closed,1).clean,false);assert.equal(assessTerminalResources(closed,undefined).clean,false);
});
test('original canonical pair must contain valid object strings before any import',()=>{
 const pair={catalog:'{"channels":[],"sources":[]}',preferences:'{"version":1}'};assert.equal(requireOriginalPair(pair),pair);
 for(const bad of [undefined,{...pair,catalog:null},{...pair,preferences:''},{...pair,catalog:'private invalid'},{...pair,preferences:'null'},{...pair,catalog:'[]'}])assert.throws(()=>requireOriginalPair(bad));
});


test('cold endpoint refusal retries the same endpoint before one settled connection',async()=>{
 let clock=0, probes=0, connects=0;const attempts=[];
 const endpoint=Object.freeze({port:63097});
 const handle=await waitForOwnedEndpoint({now:()=>clock,sleep:async(ms)=>{clock+=ms;},deadlineMs:20000,
  probe:async()=>{assert.equal(endpoint.port,63097);if(++probes===1)throw new Error('ECONNREFUSED');return probes>=3;},
  connect:async(budget)=>{connects++;assert.equal(budget,10000);return endpoint;},onAttempt:(attempt)=>attempts.push(attempt)});
 assert.equal(handle,endpoint);assert.equal(connects,1);assert.equal(probes,3);assert.deepEqual(attempts,[1,2,3]);
});
test('readiness deadline removes the owned mapping and never invents an observer',async()=>{
 let clock=0, connects=0, removed=0, closed=0;
 await assert.rejects(waitForOwnedEndpoint({now:()=>clock,sleep:async(ms)=>{clock+=ms;},deadlineMs:250,
  probe:async()=>false,connect:async()=>{connects++;}}),/Owned observer readiness timed out/);
 await drainOwnedObserver({removeForward:async()=>{removed++;},settle:async()=>{},close:async()=>{closed++;}});
 assert.equal(clock,250);assert.equal(connects,0);assert.equal(removed,1);assert.equal(closed,1);
});
test('outer connect timeout is fatal: pending actual connection remains owned until late handle closes',async()=>{
 let connects=0, browser, finish;const calls=[];
 const actual=new Promise(resolve=>{finish=resolve;}).then(handle=>{browser=handle;calls.push('connected');});
 await assert.rejects(waitForOwnedEndpoint({probe:async()=>true,connect:async()=>{
  connects++;throw new Error('Observer deadline.');
 }}),/Observer deadline/);
 let drained=false;
 const cleanup=drainOwnedObserver({removeForward:async()=>calls.push('remove'),settle:async()=>{await actual;calls.push('settled');},
  close:async()=>{await browser.close();}}).then(()=>{drained=true;});
 await Promise.resolve();await Promise.resolve();assert.equal(drained,false);assert.equal(connects,1);assert.deepEqual(calls,['remove']);
 finish({close:async()=>calls.push('closed')});await cleanup;
 assert.deepEqual(calls,['remove','connected','settled','closed']);assert.equal(drained,true);
});
test('observer drain removes mapping even on failed settlement and refuses a clean claim',async()=>{
 const calls=[];
 await assert.rejects(drainOwnedObserver({removeForward:async()=>calls.push('remove'),settle:async()=>{calls.push('settle');throw new Error('pending');},close:async()=>calls.push('close')}),/Observer settlement unconfirmed/);
 assert.deepEqual(calls,['remove','settle','close']);
 await assert.rejects(drainOwnedObserver({removeForward:async()=>{throw new Error('mapping retained');},settle:async()=>calls.push('joined'),close:async()=>calls.push('closed')}),/Observer settlement unconfirmed/);
 assert.deepEqual(calls.slice(-2),['joined','closed']);
});
test('measurement diagnostics classify static known stages without exposing provider errors',()=>{
 assert.equal(classifyAndroidResourceError(new Error('Owned observer readiness timed out.')),'observer-readiness-timeout');
 assert.equal(classifyAndroidResourceError(new Error('Observer deadline.')),'observer-operation-timeout');
 assert.equal(classifyAndroidResourceError(new Error('Native app readiness timed out.')),'app-ready-timeout');
 assert.equal(classifyAndroidResourceError(new Error('https://private.invalid/secret')),'unclassified-redacted');
 assert.equal(classifyAndroidResourceError({code:1,stderr:'private'}),'adb-command-refused');
});
