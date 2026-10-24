#!/system/bin/sh

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

# On the phone: Trier MPEG Video, FFmpeg and libmpeg2 decoding the same capture
# three times, whole process, frames discarded, pinned to a core group, at 1, 2
# and 4 threads. Prints pictures/s (wall) and cores used ((user + system) / wall).
# phone-compare.sh <capture> <cores mask> <rounds>
cd /data/local/tmp
cap=$1; mask=$2; rounds=${3:-2}
frames=$(( $(./tvb-lab "$cap" 1 16683 nohash | grep -oE '[0-9]+ frames out' | grep -oE '^[0-9]+') * 3 ))
measure() {  # label, command...
  label=$1; shift
  out=$( { time -p taskset $mask "$@" >/dev/null 2>&1; } 2>&1 )
  real=$(echo "$out" | awk '/^real/ {print $2}'); user=$(echo "$out" | awk '/^user/ {print $2}'); sys=$(echo "$out" | awk '/^sys/ {print $2}')
  awk -v l="$label" -v f=$frames -v r=$real -v u=$user -v s=$sys 'BEGIN { printf "%-22s %6.0f pictures/s  %4.2f cores used  (%.2f s)\n", l, f / r, (u + s) / r, r }'
}
echo "capture $cap, $frames pictures, cores mask $mask, $(dumpsys battery | grep -m1 'AC powered' | tr -d ' '), battery $(dumpsys battery | grep -m1 'level:' | tr -d ' ')"
for round in $(seq $rounds); do
  for t in 1 2 4; do
    TRIER_VIDEO_THREADS=$t measure "trier $t thread(s)" ./tvb-lab "$cap" 3 16683 nohash
    measure "ffmpeg $t thread(s)" ./ffmpeg-arm64 -hide_banner -threads $t -stream_loop 2 -i "$cap" -f null -
  done
  measure "libmpeg2 1 thread" ./tvb-lab speed-libmpeg2 "$cap" 3
done
