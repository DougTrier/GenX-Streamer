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
internal object TelevisionCapability {
  fun isTelevision(uiModeType:Int?,hasLeanback:Boolean,hasTelevision:Boolean=false):Boolean =
    uiModeType==android.content.res.Configuration.UI_MODE_TYPE_TELEVISION || hasLeanback || hasTelevision
}
