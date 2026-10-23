import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('android_tv', ROOT/'scripts/check-android-tv.py')
TV = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TV)


class AndroidTvAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='GenX-tv-admission-')
        self.addCleanup(self.temp.cleanup)
        self.manifest = Path(self.temp.name)/'AndroidManifest.xml'
        self.banner = Path(self.temp.name)/'tv_banner.png'
        self.xml = (ROOT/'src-tauri/gen/android/app/src/main/AndroidManifest.xml').read_text(encoding='utf-8')
        self.manifest.write_text(self.xml, encoding='utf-8')
        self.banner.write_bytes((ROOT/'src-tauri/gen/android/app/src/main/res/drawable-xhdpi/tv_banner.png').read_bytes())

    def test_actual_selected_metadata_and_banner(self):
        TV.check_source(self.manifest, self.banner)

    def test_required_touchscreen_refuses_tv_admission(self):
        self.manifest.write_text(self.xml.replace('android.hardware.touchscreen" android:required="false"', 'android.hardware.touchscreen" android:required="true"'), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'optional touchscreen'):
            TV.check_source(self.manifest, self.banner)

    def test_missing_banner_or_tv_launcher_refuses(self):
        for broken in [self.xml.replace('android:banner="@drawable/tv_banner"', ''), self.xml.replace('android.intent.category.LEANBACK_LAUNCHER', 'android.intent.category.DEFAULT')]:
            self.manifest.write_text(broken, encoding='utf-8')
            with self.assertRaises(ValueError):
                TV.check_source(self.manifest, self.banner)

    def test_wrong_banner_dimensions_refuse(self):
        data = bytearray(self.banner.read_bytes())
        data[16:20] = (180).to_bytes(4, 'big')
        self.banner.write_bytes(data)
        with self.assertRaisesRegex(ValueError, '320x180'):
            TV.check_source(self.manifest, self.banner)

    def test_current_and_legacy_aapt_minimum_sdk_not_target_sdk(self):
        for field in ['minSdkVersion', 'sdkVersion']:
            self.assertEqual(TV.minimum_sdk(f"{field}:'24'\ntargetSdkVersion:'36'\n"), 24)

    def test_missing_changed_or_ambiguous_packaged_minimum_sdk_refuses(self):
        for badging in ["targetSdkVersion:'24'\n", "minSdkVersion:'23'\n",
                        "minSdkVersion:'25'\n", "minSdkVersion:'24'\nsdkVersion:'24'\n"]:
            with self.assertRaisesRegex(ValueError, 'minimum SDK'):
                TV.minimum_sdk(badging)


if __name__ == '__main__':
    unittest.main()
