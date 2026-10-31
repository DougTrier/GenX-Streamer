# Copyright 2026 Doug Trier
# SPDX-License-Identifier: Apache-2.0

"""Run Tao's actual size helper through JNI, without requiring an Android device.

Legacy fixtures intentionally have no WindowMetrics class or modern method.
Modern fixtures return different dimensions and throw if the legacy API is used.
This is API-dispatch coverage, not Android/Fire OS launch or playback proof.
"""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class WindowMetricsJniTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        java_home = Path(os.environ.get("JAVA_HOME", "C:/Program Files/Android/Android Studio/jbr"))
        cls.java = shutil.which("java") or str(java_home / "bin/java.exe")
        cls.javac = shutil.which("javac") or str(java_home / "bin/javac.exe")
        if not shutil.which("cargo") or not Path(cls.java).exists() or not Path(cls.javac).exists():
            raise unittest.SkipTest("JNI regression needs Cargo and a JDK")
        cls.temp = tempfile.TemporaryDirectory(prefix="genx-window-metrics-")
        cls.addClassCleanup(cls.temp.cleanup)
        cls.base = Path(cls.temp.name)
        source = (ROOT / "src-tauri/vendor/tao/src/platform_impl/android/mod.rs").read_text("utf8")
        helper = source[source.index("fn window_manager_size("):source.index("\nimpl MonitorHandle {")]
        (cls.base / "src").mkdir()
        (cls.base / "Cargo.toml").write_text('''[package]
name = "genx-window-metrics-jni-test"
version = "0.0.0"
edition = "2021"
[lib]
name = "genx_window_metrics_jni_test"
crate-type = ["cdylib"]
[dependencies]
jni = "=0.21.1"
''', encoding="utf8")
        (cls.base / "src/lib.rs").write_text('''struct PhysicalSize<T> { width: T, height: T }
impl<T> PhysicalSize<T> {
  fn new(width: T, height: T) -> Self { Self { width, height } }
}
''' + helper + '''
#[no_mangle]
pub extern "system" fn Java_MetricsProbe_measure(
  mut env: jni::JNIEnv, _: jni::objects::JClass, manager: jni::objects::JObject,
) -> jni::sys::jlong {
  match window_manager_size(&mut env, &manager) {
    Ok(size) => ((size.width as i64) << 32) | size.height as i64,
    Err(_) => -1, // Leave any Java exception pending so the test fails visibly.
  }
}
''', encoding="utf8")
        cls.target = ROOT / "src-tauri/target/window-metrics-jni-tests"
        subprocess.run(["cargo", "build", "--offline", "--manifest-path", str(cls.base / "Cargo.toml"),
                        "--target-dir", str(cls.target)], check=True, cwd=ROOT)
        filename = ("genx_window_metrics_jni_test.dll" if sys.platform == "win32" else
                    "libgenx_window_metrics_jni_test.dylib" if sys.platform == "darwin" else
                    "libgenx_window_metrics_jni_test.so")
        cls.library = cls.target / "debug" / filename

    def check_sdk(self, sdk, modern, width, height):
        folder = self.base / f"api-{sdk}"
        files = {
            "android/os/Build.java": f"""package android.os;
public class Build {{ public static class VERSION {{ public static int SDK_INT = {sdk}; }} }}""",
            "android/util/DisplayMetrics.java": """package android.util;
public class DisplayMetrics { public int widthPixels; public int heightPixels; }""",
            "android/view/Display.java": f"""package android.view;
public class Display {{ public void getRealMetrics(android.util.DisplayMetrics m) {{
  m.widthPixels = {width}; m.heightPixels = {height};
}} }}""",
            "android/view/WindowManager.java": """package android.view;
public class WindowManager { public Display getDefaultDisplay() { return new Display(); } }""",
            "amazon/view/AmazonWindowManagerImpl.java": """package amazon.view;
public class AmazonWindowManagerImpl extends android.view.WindowManager {}""",
            "MetricsProbe.java": """public class MetricsProbe {
  private static native long measure(Object manager);
  public static void main(String[] args) {
    System.load(args[0]);
    long size = measure(new amazon.view.AmazonWindowManagerImpl());
    long expected = (Long.parseLong(args[1]) << 32) | Long.parseLong(args[2]);
    if (size != expected) throw new AssertionError("wrong dimensions: " + size);
    System.out.println("dimensions=" + (size >>> 32) + "x" + (size & 0xffffffffL));
  }
}""",
        }
        if modern:
            files.update({
                "android/view/WindowManager.java": """package android.view;
public class WindowManager {
  public WindowMetrics getCurrentWindowMetrics() { return new WindowMetrics(); }
  public Display getDefaultDisplay() { throw new AssertionError("legacy API on modern Android"); }
}""",
                "android/view/WindowMetrics.java": """package android.view;
public class WindowMetrics { public android.graphics.Rect getBounds() { return new android.graphics.Rect(); } }""",
                "android/graphics/Rect.java": f"""package android.graphics;
public class Rect {{ public int width() {{ return {width}; }} public int height() {{ return {height}; }} }}""",
            })
        paths = []
        for relative, text in files.items():
            path = folder / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf8")
            paths.append(str(path))
        subprocess.run([self.javac, "-d", str(folder), *paths], check=True)
        result = subprocess.run([self.java, "-Xcheck:jni", "-cp", str(folder), "MetricsProbe",
                                 str(self.library), str(width), str(height)],
                                check=True, text=True, capture_output=True)
        self.assertIn(f"dimensions={width}x{height}", result.stdout)
        self.assertEqual(result.stderr, "")

    def test_legacy_apis_never_resolve_window_metrics(self):
        for sdk, width, height in [(24, 1280, 720), (28, 1920, 1080), (29, 1080, 1920)]:
            with self.subTest(sdk=sdk):
                self.check_sdk(sdk, False, width, height)

    def test_api_30_boundary_and_newer_keep_current_window_bounds(self):
        for sdk in [30, 36]:
            with self.subTest(sdk=sdk):
                self.check_sdk(sdk, True, 960, 540)


if __name__ == "__main__":
    unittest.main()
