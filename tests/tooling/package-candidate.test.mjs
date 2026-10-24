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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { packageCandidate, verifyCandidate, sha256 } from '../../scripts/package-candidate.mjs';
async function fixture(run){const root=await mkdtemp(path.join(os.tmpdir(),'GenX package ü space '));try{
 const exe=path.join(root,'sample Windows.exe');const bytes=Buffer.alloc(512);bytes.write('MZ');bytes.writeUInt32LE(128,60);bytes.write('PE\0\0',128,'binary');bytes.writeUInt16LE(0x8664,132);bytes.writeUInt16LE(1,134);bytes.writeUInt16LE(240,148);bytes.writeUInt16LE(0x20b,152);await writeFile(exe,bytes);
 const apk=path.join(root,'sample Android.apk');apkFixture(apk);const options={windowsExe:exe,androidApk:apk,outputDir:path.join(root,'candidate'),windowsProfile:'debug',androidProfile:'debug',version:'0.1.0'};
 await run({root,exe,apk,options});
 }finally{assert.ok(root.startsWith(path.join(os.tmpdir(),'GenX package ü space ')));await rm(root,{recursive:true,force:true});}}
function apkFixture(filename,variant='normal'){execFileSync('python',['-B','-X','utf8','-c',String.raw`
import zipfile,sys,pathlib
with zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_DEFLATED) as z:
 z.writestr('AndroidManifest.xml', b'binary manifest fixture')
 z.writestr('classes.dex', b'dex fixture')
 z.writestr('lib/arm64-v8a/libfixture.so', b'ELF fixture')
 v=sys.argv[2]
 if v=='ratio': z.writestr('bomb',bytes(1000000))
 if v=='traversal': z.writestr('../escape',b'x')
 if v=='backslash': z.writestr('folder\\escape',b'x')
 if v=='manifest': z.writestr('AndroidManifest.xml',bytes(8388609))
 if v=='entries':
  for i in range(10000):z.writestr(str(i),b'x')
if sys.argv[2]=='backslash':
 p=pathlib.Path(sys.argv[1]);p.write_bytes(p.read_bytes().replace(b'folder/escape',b'folder'+bytes([92])+b'escape'))
`,filename,variant],{windowsHide:true,stdio:'pipe'});}
test('fixed ZIP bytes repeat with identical inputs, spaces/Unicode paths; unchanged APK and honest manifest',async()=>fixture(async({options,root,apk})=>{
 const first=await packageCandidate(options);const second=await packageCandidate({...options,outputDir:path.join(root,'candidate two ü')});
 const a=await readFile(path.join(first.directory,'GenX-Streamer-0.1.0-Windows-x64-portable.zip'));const b=await readFile(path.join(second.directory,'GenX-Streamer-0.1.0-Windows-x64-portable.zip'));assert.deepEqual(a,b);
 assert.equal(await sha256(apk),await sha256(path.join(first.directory,'GenX-Streamer-0.1.0-Android-arm64.apk')));
 const manifest=await verifyCandidate(first.directory);assert.equal(manifest.releaseAcceptance,false);assert.equal(manifest.signatureStatus,'unverified');assert.match(manifest.profiles.authority,/caller-declared/);assert.equal(manifest.appIdentifier,'com.tmg.tv');assert.equal(manifest.noticesStatus,'missing');
 const receipt=JSON.parse(await readFile(path.join(first.directory,'receipt.json'),'utf8'));assert.equal(receipt.exitCode,0);assert.equal(receipt.releaseAcceptance,false);assert.equal(receipt.inputHashes.android,await sha256(apk));
 const entries=JSON.parse(execFileSync('python',['-c',"import zipfile,json,sys;z=zipfile.ZipFile(sys.argv[1]);print(json.dumps([[i.filename,list(i.date_time)] for i in z.infolist()]))",path.join(first.directory,'GenX-Streamer-0.1.0-Windows-x64-portable.zip')],{encoding:'utf8',windowsHide:true}));assert.deepEqual(entries.map(e=>e[0]),['GenX Streamer.exe','README.txt','tmg-portable.flag']);assert.ok(entries.every(e=>JSON.stringify(e[1])==='[1980,1,1,0,0,0]'));
}));
test('tampered binary hash fails verification',async()=>fixture(async({options})=>{const result=await packageCandidate(options);await writeFile(path.join(result.directory,'GenX-Streamer-0.1.0-Android-arm64.apk'),'tampered');await assert.rejects(verifyCandidate(result.directory),/checksum/);}));
test('missing/nonfile inputs and invalid PE fail without publishing',async()=>fixture(async({options,root,exe})=>{
 await assert.rejects(packageCandidate({...options,windowsExe:path.join(root,'missing')}));await assert.rejects(packageCandidate({...options,windowsExe:root}),/regular file/);await writeFile(exe,'MZ only');await assert.rejects(packageCandidate(options),/PE structure/);
}));
test('invalid APK, traversal, compression, manifest and entry-count limits fail closed',async()=>fixture(async({options,apk})=>{
 await writeFile(apk,'PK invalid');await assert.rejects(packageCandidate(options),/APK or ZIP/);
 for(const variant of ['ratio','traversal','backslash','manifest','entries']){apkFixture(apk,variant);await assert.rejects(packageCandidate(options),/APK or ZIP/,variant);}
}));
test('existing destination never gets replaced or modified',async()=>fixture(async({options})=>{await mkdir(options.outputDir);const sentinel=path.join(options.outputDir,'user-data');await writeFile(sentinel,'keep');await assert.rejects(packageCandidate(options),/already exists/);assert.equal(await readFile(sentinel,'utf8'),'keep');}));
test('final-inputs requires notices and release declarations but still cannot certify a release',async()=>fixture(async({options,root})=>{
 await assert.rejects(packageCandidate({...options,mode:'final-inputs'}),/require/);await assert.rejects(packageCandidate({...options,mode:'final-inputs',windowsProfile:'release',androidProfile:'release'}),/notices/);
 const notices=path.join(root,'reviewed notices.txt');await writeFile(notices,'Fixture notices; not real licensing evidence');const result=await packageCandidate({...options,mode:'final-inputs',windowsProfile:'release',androidProfile:'release',notices});assert.equal(result.manifest.releaseAcceptance,false);assert.equal(result.manifest.noticesStatus,'included-completeness-unverified');assert.equal(result.manifest.signatureStatus,'unverified');assert.ok(result.manifest.pendingEvidence.includes('physical Windows and Android playback'));
}));
test('windows-only packages the ZIP alone and names the Android release as pending',async()=>fixture(async({options})=>{const {androidApk,androidProfile,...windows}=options;void androidApk;void androidProfile;const result=await packageCandidate({...windows,mode:'windows-only'});assert.deepEqual(result.manifest.artifacts.map(a=>a.platform),['windows','windows-exe']);assert.equal(result.manifest.profiles.android,null);assert.ok(result.manifest.pendingEvidence[0].startsWith('Android release APK'));assert.equal(result.manifest.releaseAcceptance,false);await verifyCandidate(result.directory);await assert.rejects(packageCandidate({...options,mode:'windows-only',outputDir:options.outputDir+'-2'}),/required|profiles/);}));
test('release files carry version and platform, and SHA256SUMS lists every one',async()=>fixture(async({options,exe,apk})=>{
 const result=await packageCandidate(options);
 const names=['GenX-Streamer-0.1.0-Windows-x64-portable.zip','GenX-Streamer-0.1.0-Windows-x64.exe','GenX-Streamer-0.1.0-Android-arm64.apk'];
 assert.deepEqual(result.manifest.artifacts.map(a=>a.name),names);
 assert.equal(result.manifest.version,'0.1.0');
 const sums=(await readFile(path.join(result.directory,'SHA256SUMS'),'utf8')).trim().split(/\r?\n/u);
 assert.equal(sums.length,3);
 for(const name of names)assert.ok(sums.includes(`${await sha256(path.join(result.directory,name))}  ${name}`),name);
 // The bare exe is the input exe, byte for byte; the APK too.
 assert.equal(await sha256(path.join(result.directory,names[1])),await sha256(exe));
 assert.equal(await sha256(path.join(result.directory,names[2])),await sha256(apk));
 await assert.rejects(packageCandidate({...options,version:'1.0',outputDir:options.outputDir+'-v'}),/x\.y\.z/);
}));
