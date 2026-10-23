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
