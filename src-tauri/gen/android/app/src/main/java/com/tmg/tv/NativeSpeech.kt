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

package com.tmg.tv
import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import app.tauri.plugin.Invoke
class NativeSpeech(private val activity: MainActivity) {
 private var closing=false
 private val handler=Handler(Looper.getMainLooper())
 private val ownership=SpeechOwnership()
 private var cleanupOwner:String?=null
 private var owner:String?=null
 private var pending:Invoke?=null
 private var engine:SpeechRecognizer?=null
 private var deadline:Runnable?=null
 private fun local()=Build.VERSION.SDK_INT>=31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(activity)
 private fun granted()=activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO)==PackageManager.PERMISSION_GRANTED
 fun permissionAllowed(id:String)=!closing && !ownership.isCanceled(id)
 fun capabilities(invoke:Invoke) {invoke.resolveObject(mapOf("platform" to "android","onDeviceAvailable" to local(),"serviceAvailable" to SpeechRecognizer.isRecognitionAvailable(activity),"permissionGranted" to granted(),"cloudConsentRequired" to true))}
 fun start(id:String,language:String,allowCloud:Boolean,invoke:Invoke) {
  if(closing) {invoke.reject("application-closing");return}
  if(!id.matches(Regex("[A-Za-z0-9_-]{1,128}")) || language.length>64 || !language.matches(Regex("[a-zA-Z]{2,8}(-[a-zA-Z0-9]{1,8})*"))) {invoke.reject("speech-invalid-request");return}
  if(!activity.isViewingForeground()) {invoke.reject("speech-background");return}
  if(owner!=null || engine!=null) {invoke.reject("speech-busy");return}
  if(!granted()) {invoke.reject("speech-permission-required");return}
  val offline=local()
  if(!offline && !allowCloud) {invoke.reject("speech-on-device-unavailable");return}
  if(!offline && !SpeechRecognizer.isRecognitionAvailable(activity)) {invoke.reject("speech-provider-unavailable");return}
  val epoch=try {ownership.start(id)} catch(e:IllegalStateException) {invoke.reject(e.message ?: "speech-busy");return}
  owner=id;pending=invoke
  try {
   val recognizer=if(offline) SpeechRecognizer.createOnDeviceSpeechRecognizer(activity) else SpeechRecognizer.createSpeechRecognizer(activity);engine=recognizer
   recognizer.setRecognitionListener(object:RecognitionListener {
    override fun onReadyForSpeech(params:Bundle?) {}
    override fun onBeginningOfSpeech() {}
    override fun onRmsChanged(value:Float) {}
    override fun onBufferReceived(buffer:ByteArray?) {}
    override fun onEndOfSpeech() {}
    override fun onPartialResults(results:Bundle?) {}
    override fun onEvent(type:Int,params:Bundle?) {}
    override fun onError(error:Int) {if(ownership.active(id,epoch)) finish(null,when(error) {SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS->"speech-permission-denied";SpeechRecognizer.ERROR_NO_MATCH->"speech-no-match";SpeechRecognizer.ERROR_SPEECH_TIMEOUT->"speech-no-input";SpeechRecognizer.ERROR_RECOGNIZER_BUSY->"speech-provider-busy";SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED->"speech-language-unsupported";SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE->"speech-language-unavailable";SpeechRecognizer.ERROR_NETWORK,SpeechRecognizer.ERROR_NETWORK_TIMEOUT->"speech-network-failed";else->"speech-recognition-failed"})}
    override fun onResults(results:Bundle?) {
     if(!ownership.active(id,epoch)) return
     val text=results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim()
     if(text.isNullOrEmpty()) finish(null,"speech-no-match") else if(text.length>512 || text.any {it.isISOControl()}) finish(null,"speech-result-too-large") else finish(mapOf("requestId" to id,"text" to text,"provider" to if(offline) "android-on-device" else "android-system-service","cloudPossible" to !offline),null)
    }
   })
   val timeout=Runnable {if(ownership.active(id,epoch)) finish(null,"speech-timeout")};deadline=timeout;handler.postDelayed(timeout,15000)
   recognizer.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL,RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);putExtra(RecognizerIntent.EXTRA_LANGUAGE,language);putExtra(RecognizerIntent.EXTRA_MAX_RESULTS,1);putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS,false)})
  } catch(_:RuntimeException) {finish(null,"speech-provider-unavailable")}
 }
 fun end(id:String,invoke:Invoke) {if(owner!=id) {invoke.reject("speech-owner-mismatch");return};try {engine?.stopListening();invoke.resolve()} catch(_:RuntimeException) {finish(null,"speech-recognition-failed");invoke.reject("speech-recognition-failed")}}
 fun shutdown():Boolean {closing=true;return cancel()}
 fun cancel(id:String?=null):Boolean {
  if(ownership.cancel(id) || (engine!=null && (id==null || cleanupOwner==id))) {finish(null,"speech-canceled");return engine==null}
  return true
 }
 private fun finish(result:Map<String,Any>?,error:String?) {
  val resourceOwner=owner ?: cleanupOwner
  ownership.clear()
  val invoke=pending;pending=null;owner=null;deadline?.let {handler.removeCallbacks(it)};deadline=null
  val recognizer=engine
  try {recognizer?.cancel()} catch(_:RuntimeException) {}
  try {recognizer?.destroy();engine=null;cleanupOwner=null} catch(_:RuntimeException) {cleanupOwner=resourceOwner;invoke?.reject("speech-stop-unconfirmed");return}
  if(invoke!=null) {if(result!=null) invoke.resolveObject(result) else invoke.reject(error ?: "speech-canceled")}
 }
}
