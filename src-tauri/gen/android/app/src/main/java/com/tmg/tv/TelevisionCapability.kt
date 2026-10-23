package com.tmg.tv
internal object TelevisionCapability {
  fun isTelevision(uiModeType:Int?,hasLeanback:Boolean,hasTelevision:Boolean=false):Boolean =
    uiModeType==android.content.res.Configuration.UI_MODE_TYPE_TELEVISION || hasLeanback || hasTelevision
}
