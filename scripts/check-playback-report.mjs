// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
// Release preflight for exported, redacted in-app playback captures.
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
export function assessPlaybackReport(report, mode, minimumSeconds = 300) {
  const incomplete = (reason) => ({ mode, status: 'INCOMPLETE', reason });
  if (
    !report ||
    report.schemaVersion !== 1 ||
    !Array.isArray(report.records) ||
    report.records.length > 800 ||
    !['free', 'paid'].includes(mode)
  )
    return incomplete('Invalid or unsupported capture.');
  const groups = new Map();
  let sequence = 0;
  for (const entry of report.records) {
    const r = entry?.record,
      v = r?.values;
    if (!r || !v || r.mode !== mode || !Number.isFinite(entry.elapsedMs)) continue;
    if (r.event === 'state' || r.event === 'recovery' || r.event === 'error')
      sequence = v.channelSequence ?? sequence;
    if (!groups.has(sequence))
      groups.set(sequence, {
        events: [],
        start: null,
        end: null,
        frames: [],
        frameSamples: [],
        drops: [],
        buffering: 0,
        errors: 0,
        liveWindowRecoveries: 0,
        nativeSession: null,
        mismatches: 0,
      });
    const g = groups.get(sequence);
    g.events.push(entry);
    if (r.event === 'state' && v.state === 'playing' && g.start === null) g.start = entry.elapsedMs;
    if (g.start === null) continue;
    if (['sample', 'native-geometry'].includes(r.event)) g.end = entry.elapsedMs;
    if (['recovery', 'relay-error', 'decoder-error', 'error'].includes(r.event)) g.errors++;
    // Native Media3 can rejoin inside one session without a controller error.
    if (Number.isSafeInteger(v.liveWindowRecoveries)) {
      if (
        (Number.isSafeInteger(v.nativeSession) && v.nativeSession !== g.nativeSession) ||
        v.liveWindowRecoveries < g.liveWindowRecoveries
      )
        g.liveWindowRecoveries = 0;
      if (Number.isSafeInteger(v.nativeSession)) g.nativeSession = v.nativeSession;
    }
    if (
      Number.isSafeInteger(v.liveWindowRecoveries) &&
      v.liveWindowRecoveries > g.liveWindowRecoveries
    ) {
      g.errors += v.liveWindowRecoveries - g.liveWindowRecoveries;
      g.liveWindowRecoveries = v.liveWindowRecoveries;
    }
    if (r.event === 'state' && v.state === 'buffering' && entry.elapsedMs > g.start + 5000)
      g.buffering++;
    if ((v.aligned === false || v.surfaceAligned === false) && v.layoutPending !== true)
      g.mismatches++;
    const frames = v.totalFrames ?? v.renderedFrames;
    if (typeof frames === 'number' && frames >= 0) {
      g.frames.push(frames);
      g.frameSamples.push({ at: entry.elapsedMs, frames });
    }
    if (typeof v.droppedFrames === 'number' && v.droppedFrames >= 0) g.drops.push(v.droppedFrames);
  }
  const candidates = [...groups.values()]
    .filter((g) => g.start !== null && g.end !== null)
    .sort((a, b) => b.end - b.start - (a.end - a.start));
  const g = candidates[0];
  if (!g) return incomplete('No recorded video playback for this section.');
  const seconds = (g.end - g.start) / 1000;
  const advanced = g.frames.length > 1 && Math.max(...g.frames) > Math.min(...g.frames);
  const dropped = g.drops.length > 1 ? Math.max(...g.drops) - Math.min(...g.drops) : null;
  const frameDelta = advanced ? Math.max(...g.frames) - Math.min(...g.frames) : null;
  const dropPercent = dropped !== null && frameDelta > 0 ? (100 * dropped) / frameDelta : null;
  let maximumFrameSampleGapMs = 0,
    maximumFrozenMs = 0;
  let lastAdvance = g.frameSamples[0]?.at ?? 0;
  for (let i = 1; i < g.frameSamples.length; i++) {
    const previous = g.frameSamples[i - 1],
      current = g.frameSamples[i];
    maximumFrameSampleGapMs = Math.max(maximumFrameSampleGapMs, current.at - previous.at);
    if (current.frames !== previous.frames) lastAdvance = current.at;
    else maximumFrozenMs = Math.max(maximumFrozenMs, current.at - lastAdvance);
  }
  const reasons = [];
  if (seconds < minimumSeconds) reasons.push('Sustained interval is too short.');
  if (!advanced) reasons.push('Decoded/rendered frame progress is unverified.');
  if (maximumFrameSampleGapMs > 15_000)
    reasons.push('Frame observations contain a gap exceeding 15 seconds.');
  if (maximumFrozenMs > 15_000)
    reasons.push('Recorded frame counters stopped advancing for more than 15 seconds.');
  if (g.errors) reasons.push('Playback errors or automatic recovery occurred.');
  if (g.buffering) reasons.push('Mid-playback buffering occurred.');
  if (g.mismatches) reasons.push('Measured native bounds did not match expected placement.');
  if (dropPercent !== null && dropPercent > 5)
    reasons.push('Measured video frame drops exceeded 5 percent.');
  const failed =
    maximumFrozenMs > 15_000 ||
    g.errors > 0 ||
    g.buffering > 0 ||
    g.mismatches > 0 ||
    (dropPercent !== null && dropPercent > 5);
  return {
    mode,
    status: failed ? 'FAIL' : reasons.length ? 'INCOMPLETE' : 'PASS',
    observedSeconds: Math.round(seconds * 10) / 10,
    errors: g.errors,
    midplayBuffering: g.buffering,
    measuredBoundsMismatches: g.mismatches,
    framesAdvanced: advanced,
    maximumFrameSampleGapMs,
    maximumFrozenMs,
    droppedFrames: dropped,
    droppedFramePercent: dropPercent === null ? null : Math.round(dropPercent * 100) / 100,
    reasons,
    limits:
      'Decoder counters do not verify final GPU-composited pixels. Low-level driver logs and physical device checks remain required.',
  };
}
async function boundedJson(filename) {
  const size = (await stat(filename)).size;
  if (size > 1024 * 1024) throw Error('Playback report exceeds its bound.');
  return JSON.parse(await readFile(filename, 'utf8'));
}
export async function checkPlaybackReports({ free, paid, apk, version, output }) {
  const reports = await Promise.all([boundedJson(free), boundedJson(paid)]);
  const modes = reports.map((r, i) => assessPlaybackReport(r, i === 0 ? 'free' : 'paid'));
  const versionsMatch = reports.every(
    (r) =>
      r.version === version &&
      r.build ===
        version
          .split('.')
          .map(Number)
          .reduce((n, p, i) => n + p * [1_000_000, 1000, 1][i], 0),
  );
  const hash = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  for await (const chunk of createReadStream(apk)) hash.update(chunk);
  const result = {
    schemaVersion: 1,
    version,
    apkSha256: hash.digest('hex'),
    status: !versionsMatch
      ? 'FAIL'
      : modes.every((m) => m.status === 'PASS')
        ? 'PASS'
        : modes.some((m) => m.status === 'FAIL')
          ? 'FAIL'
          : 'INCOMPLETE',
    versionsMatch,
    modes,
    physicalAcceptance:
      'Separate owner confirmation is required for Fire TV/Flip 2 and the full view/channel-switch matrix.',
  };
  if (output) await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      const key = process.argv[i]?.replace(/^--/, '');
      if (
        !['free', 'paid', 'apk', 'version', 'output'].includes(key) ||
        !process.argv[i + 1] ||
        args[key]
      )
        throw Error('Use --free, --paid, --apk, --version and optional --output.');
      args[key] = process.argv[i + 1];
    }
    if (!args.free || !args.paid || !args.apk || !/^\d+\.\d+\.\d+$/.test(args.version ?? ''))
      throw Error('Free/Paid captures, APK and version are required.');
    const result = await checkPlaybackReports(args);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'PASS') process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
