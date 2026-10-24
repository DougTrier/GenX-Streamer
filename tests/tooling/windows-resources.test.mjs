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

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProcesses, assessProcessDelta, readPlaybackCounts, classifyResourceError } from '../../scripts/windows-resources.mjs';
const row=(pid,cpuSeconds,created='same')=>({pid,created,cpuSeconds,privateBytes:1000,workingBytes:2000,handles:3,threads:4});
test('strict parser accepts singleton/arrays and rejects missing, negative, oversized and duplicate samples',()=>{
  assert.deepEqual(parseProcesses(JSON.stringify(row(1,2))),[row(1,2)]);
  for(const value of [[],null,{...row(1,2),cpuSeconds:-1},{...row(1,2),threads:undefined},Array.from({length:129},(_,i)=>row(i+1,0)),[row(1,2),row(1,3)]])assert.throws(()=>parseProcesses(value));
});
test('whole-tree matched CPU sums native and renderer with explicit one-core/machine normalization',()=>{
  const result=assessProcessDelta([row(1,1),row(2,3)],[row(1,2),row(2,4)],1000,4);
  assert.equal(result.cpuSecondsDelta,2);assert.equal(result.cpuPercentOneCore,200);assert.equal(result.cpuPercentMachine,50);
  assert.equal(result.privateBytes,2000);assert.equal(result.workingBytes,4000);assert.equal(result.handles,6);assert.equal(result.threads,8);assert.equal(result.unmatchedProcesses,0);
});
test('PID reuse and new/exited processes remain explicit unmatched coverage, never negative CPU',()=>{
  const result=assessProcessDelta([row(1,100),row(2,4)],[row(1,1,'new'),row(3,2)],1000,8);
  assert.equal(result.cpuSecondsDelta,0);assert.equal(result.unmatchedProcesses,2);assert.equal(result.exitedProcesses,2);
  assert.deepEqual(result.perProcess.map(item=>item.cpuSecondsDelta),[null,null]);
});
test('a backwards CPU counter is unknown rather than fabricated growth or reclaimed negative use',()=>{
  const result=assessProcessDelta([row(1,10)],[row(1,9)],1000,2);
  assert.equal(result.unmatchedProcesses,1);assert.equal(result.cpuSecondsDelta,0);
});
test('invalid duration/core denominator and malformed JSON fail closed',()=>{
  for(const [elapsed,cores]of [[0,1],[-1,1],[Infinity,1],[1000,0],[1000,1.5]])assert.throws(()=>assessProcessDelta([row(1,1)],[row(1,2)],elapsed,cores));
  assert.throws(()=>parseProcesses('{bad'));
});

test('reads actual nested resource-owner contract and rejects absent/flat/malformed counters',()=>{
 const counts={controllerEngines:0,browserEngines:0,controllerTimers:0,initializationWaits:0,nativeLoads:0,nativeCancels:0};
 assert.deepEqual(readPlaybackCounts({schemaVersion:1,counts}),counts);
 for(const snapshot of [{schemaVersion:1,...counts},{schemaVersion:2,counts},{schemaVersion:1,counts:{...counts,nativeLoads:-1}},null])assert.throws(()=>readPlaybackCounts(snapshot));
 assert.equal(readPlaybackCounts({schemaVersion:1,counts:{...counts,controllerEngines:1}}).controllerEngines,1);
});
test('error categories expose only bounded static causes, never raw provider diagnostics',()=>{
 assert.equal(classifyResourceError(new Error('INCOMPLETE_HARNESS_CDP: background owner deadline')),'incomplete-cdp');
 assert.equal(classifyResourceError(Object.assign(new Error('secret'),{name:'TimeoutError'})),'observation-timeout');
 assert.equal(classifyResourceError(new Error('Background owned fixture networking continued.')),'background-network-active');
 assert.equal(classifyResourceError(new Error('https://secret.invalid/token')),'unclassified-redacted');
});
