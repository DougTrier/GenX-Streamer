# Copyright 2026 Doug Trier
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Verify explicit TV admission and selected banner; optional actual APK inspection."""
import argparse
import json
from pathlib import Path
import re
import struct
import subprocess
import xml.etree.ElementTree as ET
import zipfile

ANDROID = '{http://schemas.android.com/apk/res/android}'


def banner_size(data):
    if len(data) < 33 or data[:8] != b'\x89PNG\r\n\x1a\n' or data[12:16] != b'IHDR':
        raise ValueError('TV banner PNG refused')
    if struct.unpack('>II', data[16:24]) != (320, 180):
        raise ValueError('TV banner must be 320x180')


def check_source(manifest, banner):
    tree = ET.parse(manifest).getroot()
    for feature in ['android.hardware.touchscreen', 'android.software.leanback']:
        matches = [n for n in tree.findall('uses-feature') if n.get(ANDROID+'name') == feature]
        if len(matches) != 1 or matches[0].get(ANDROID+'required') != 'false':
            raise ValueError('Explicit optional touchscreen and leanback declarations required')
    app = tree.find('application')
    if app is None or app.get(ANDROID+'banner') != '@drawable/tv_banner':
        raise ValueError('Selected TV banner reference required')
    categories = app.findall('activity/intent-filter/category')
    if not any(n.get(ANDROID+'name') == 'android.intent.category.LEANBACK_LAUNCHER' for n in categories):
        raise ValueError('TV launcher entry required')
    banner_size(Path(banner).read_bytes())


def minimum_sdk(badging):
    # Current aapt2 reports minSdkVersion; older versions used sdkVersion.
    values = re.findall(r"^(?:minSdkVersion|sdkVersion):'(\d+)'[ \t]*$", badging, re.MULTILINE)
    if len(values) != 1 or int(values[0]) != 24:
        raise ValueError('Packaged supported minimum SDK changed or was ambiguous')
    return 24


def check_apk(apk, aapt2):
    badging = subprocess.run([str(aapt2), 'dump', 'badging', str(apk)], check=True, capture_output=True, text=True, timeout=30).stdout
    tree = subprocess.run([str(aapt2), 'dump', 'xmltree', str(apk), '--file', 'AndroidManifest.xml'], check=True, capture_output=True, text=True, timeout=30).stdout
    if "uses-feature-not-required: name='android.hardware.touchscreen'" not in badging:
        raise ValueError('Packaged TV touchscreen admission refused')
    if 'leanback-launchable-activity:' not in badging or 'android:banner' not in tree:
        raise ValueError('Packaged TV launcher/banner metadata refused')
    sdk = minimum_sdk(badging)
    with zipfile.ZipFile(apk) as archive:
        names = archive.namelist()
        banners = [n for n in names if re.fullmatch(r'res/drawable-xhdpi(?:-v\d+)?/tv_banner\.png', n)]
        if len(banners) != 1:
            raise ValueError('Packaged selected banner missing or ambiguous')
        banner_size(archive.read(banners[0]))
        abis = sorted({n.split('/')[1] for n in names if re.fullmatch(r'lib/[^/]+/libtmg_tv_lib\.so', n)})
        if not abis:
            raise ValueError('Packaged native playback library missing')
    return {'minimumSdk': sdk, 'nativeAbis': abis, 'bannerPixels': [320, 180]}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    root = Path(__file__).resolve().parents[1]
    parser.add_argument('--apk', type=Path)
    parser.add_argument('--aapt2', type=Path)
    args = parser.parse_args()
    check_source(root/'src-tauri/gen/android/app/src/main/AndroidManifest.xml', root/'src-tauri/gen/android/app/src/main/res/drawable-xhdpi/tv_banner.png')
    result = {'status': 'PASS', 'scope': 'SOURCE_METADATA_ONLY'}
    if args.apk:
        if not args.aapt2:
            parser.error('--apk requires explicit --aapt2')
        result.update(check_apk(args.apk, args.aapt2), scope='PACKAGED_METADATA_ONLY')
    print(json.dumps(result))
