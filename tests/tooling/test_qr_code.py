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

"""GenX's QR encoder (src/sharing/qr-code.ts), read back by an independent
decoder (OpenCV's QRCodeDetector): every version GenX may use, at the sizes a
phone camera would see."""

import json
from pathlib import Path
import shutil
import subprocess
import unittest

try:
    import cv2
    import numpy
except ImportError:  # pragma: no cover - reported as a skip
    cv2 = None

ROOT = Path(__file__).resolve().parents[2]
SAMPLES = [
    'http://192.168.1.20:49152/q1w2e3r4t5y6u7i8o9p0aa/',
    'http://10.0.0.5:5000/AbCdEfGhIjKlMnOpQrStUv/',
    'GenX',
    'https://dougtrier.github.io/GenX-Streamer/watch/#v=1&c=ch&n=News+24&s=https%3A%2F%2Fcdn.example.com%2Fnews24%2Findex.m3u8',
    'x' * 150,
    'https://dougtrier.github.io/GenX-Streamer/watch/#v=1&c=ch&n=Channel&s=' + 'a' * 600,
    'y' * 997,
    'Grüße · GenX Streamer ✓',
]


def encode(texts):
    script = (
        "const { encodeQr } = await import('./src/sharing/qr-code.ts');"
        "const texts = JSON.parse(process.argv[1]);"
        "console.log(JSON.stringify(texts.map((t) => encodeQr(t).map((r) => r.map(Number)))));"
    )
    output = subprocess.run(
        [shutil.which('node') or 'node', '--experimental-strip-types', '--no-warnings',
         '--input-type=module', '-e', script, json.dumps(texts)],
        cwd=ROOT, capture_output=True, text=True, encoding='utf-8', timeout=60, check=True,
    ).stdout
    return json.loads(output)


@unittest.skipIf(cv2 is None, 'OpenCV (cv2) is not installed')
class QrCodeTests(unittest.TestCase):
    def test_every_code_reads_back_exactly(self):
        for text, matrix in zip(SAMPLES, encode(SAMPLES)):
            size = len(matrix)
            self.assertEqual((size - 17) % 4, 0)
            self.assertTrue(21 <= size <= 117, size)
            modules = numpy.array(matrix, dtype=numpy.uint8)
            image = numpy.pad((1 - modules) * 255, 4, constant_values=255)
            image = cv2.resize(image, None, fx=8, fy=8, interpolation=cv2.INTER_NEAREST)
            decoded, points, _ = cv2.QRCodeDetector().detectAndDecode(image)
            self.assertIsNotNone(points, text)
            self.assertEqual(decoded, text)

    def test_text_too_long_is_refused(self):
        with self.assertRaises(subprocess.CalledProcessError):
            encode(['x' * 998])


if __name__ == '__main__':
    unittest.main()
