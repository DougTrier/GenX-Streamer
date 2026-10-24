# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile
# GenX Streamer (release builds, docs/release-signing.md): the Rust core and
# Tauri call GenX's Kotlin by name over JNI and reflection (activity id and
# lifecycle, plugin commands and their argument classes, the Trier decoder
# and native video bridges). R8 cannot see those calls, and removing or
# renaming one aborts the app at start-up (S25, October 24, 2026: tao's
# onActivityCreate could not find WryActivity.getId). Keep GenX's own classes
# whole; libraries are still shrunk with their own rules.
-keep class com.tmg.tv.** { *; }
-keep class app.tauri.** { *; }
-keep @app.tauri.annotation.TauriPlugin class * { *; }
-keep @app.tauri.annotation.InvokeArg class * { *; }
-keepclassmembers class * {
    @app.tauri.annotation.Command *;
    @android.webkit.JavascriptInterface *;
}
-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod
