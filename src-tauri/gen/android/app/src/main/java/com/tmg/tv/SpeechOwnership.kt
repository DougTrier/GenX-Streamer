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
// Main-thread owner fence: callbacks cannot consume a later recording with a reused ID.
class SpeechOwnership {
 private var current:String?=null
 private var epoch=0L
 private val canceled=LinkedHashSet<String>()
 fun start(id:String):Long {
  check(current==null) {"speech-busy"}
  check(!canceled.remove(id)) {"speech-canceled"}
  check(epoch<Long.MAX_VALUE) {"speech-owner-exhausted"}
  current=id;return ++epoch
 }
 fun isCanceled(id:String)=canceled.contains(id)
 fun active(id:String,token:Long)=current==id && epoch==token
 fun clear() {current=null}
 fun cancel(id:String?):Boolean {
  if(id==null || current==id) {current=null;return true}
  if(canceled.size>=128) canceled.remove(canceled.first())
  canceled.add(id);return false
 }
}
