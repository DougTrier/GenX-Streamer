// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { isTauri } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import {
  playbackTrace,
  playbackTraceMode,
  recordPlaybackState,
  recordPlaybackTrace,
  traceEnabled,
  traceInterrupted,
  traceInterruptionReason,
  webTraceActive,
  type PlaybackTraceReport,
} from '../../diagnostics/playback-trace';
import { readVideoQuality } from '../../platform/browser-engine';
import type { PlaybackSnapshot } from '../../playback/controller';
export function installPlaybackDiagnostics(host: {
  button: HTMLButtonElement;
  app: HTMLElement;
  video: HTMLVideoElement;
  screen: HTMLElement;
  snapshot(): PlaybackSnapshot;
}) {
  const doc = host.app.ownerDocument;
  const dialog = doc.createElement('dialog');
  dialog.className = 'gx-event-history';
  dialog.setAttribute('aria-label', 'Playback diagnostics');
  const title = doc.createElement('h2');
  title.textContent = 'Playback diagnostics';
  const explanation = doc.createElement('p');
  explanation.textContent =
    'Record Free TV, Paid TV, GenXtra and Web Stream for up to 15 minutes. Start replaces the previous capture. Reports include playback quality, errors and measured player bounds. Account details and stream addresses are excluded.';
  const status = doc.createElement('p');
  status.setAttribute('role', 'status');
  status.style.overflowWrap = 'anywhere';
  status.style.maxHeight = '6lh';
  status.tabIndex = 0;
  const summary = doc.createElement('pre');
  summary.tabIndex = 0;
  summary.style.cssText =
    'white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;min-height:44px;max-height:40vh;';
  summary.setAttribute('aria-label', 'Capture summary');
  const actions = doc.createElement('div');
  actions.className = 'dialog-actions';
  let closed = false,
    busy = false,
    work: Promise<void> = Promise.resolve();
  const busyButtons: HTMLButtonElement[] = [];
  let lastReport: PlaybackTraceReport | null = null;
  const render = (report: PlaybackTraceReport) => {
    lastReport = report;
    const mismatches = report.records.filter(
      (r) =>
        (r.record.values.aligned === false || r.record.values.surfaceAligned === false) &&
        r.record.values.layoutPending !== true,
    ).length;
    const buffering = report.records.filter(
      (r) => r.record.event === 'state' && r.record.values.state === 'buffering',
    ).length;
    const errors = report.records.filter((r) =>
      ['relay-error', 'decoder-error', 'recovery', 'error'].includes(r.record.event),
    ).length;
    status.textContent = traceInterrupted()
      ? `Recording could not continue (${traceInterruptionReason() ?? 'unknown'}). Export available evidence, then start again.`
      : report.active
        ? 'Recording. Reproduce the problem, then Stop and export.'
        : 'Recording stopped. The latest report stays on this device.';
    summary.textContent = `Version ${report.version} · build ${report.build}\n${report.records.length} retained observations · ${report.droppedEvents} older observations removed\n${errors} error/recovery observations · ${buffering} buffering transitions · ${mismatches} measured view-bound mismatches\nNative surface bounds are measured; final composited video pixels require visual confirmation.\nBrowser-only frame metrics are unavailable for third-party Web Stream pages.`;
  };
  const run = (operation: () => Promise<void>) => {
    if (closed || busy) return;
    busy = true;
    // Disabling the remote's focused action drops focus onto BODY in WebView.
    // Close stays usable during work, and completion never reclaims focus.
    if (dialog.open && busyButtons.some((button) => button === doc.activeElement))
      close.focus({ preventScroll: true });
    busyButtons.forEach((button) => {
      button.disabled = true;
    });
    work = operation()
      .catch(() => {
        if (!closed) status.textContent = 'Diagnostics could not finish. Retry this action.';
      })
      .finally(() => {
        busy = false;
        if (!closed)
          busyButtons.forEach((button) => {
            button.disabled = false;
          });
      });
  };
  const button = (text: string, action: () => void) => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.addEventListener('click', action);
    actions.append(b);
    if (text !== 'Close') busyButtons.push(b);
    return b;
  };
  button('Start 15-minute capture', () =>
    run(async () => {
      render(await playbackTrace.start());
      sample();
    }),
  );
  button('Stop recording', () => run(async () => render(await playbackTrace.stop())));
  button('Refresh summary', () => run(async () => render(await playbackTrace.read())));
  button('Export report', () =>
    run(async () => {
      const report = await playbackTrace.read();
      render(report);
      if (isTauri() && /Android/i.test(navigator.userAgent)) {
        const receipt = await playbackTrace.exportAndroid();
        if (!closed)
          status.textContent = `Saved report: ${receipt.path}. Copy this file from the device using ADB or an available file manager.`;
      } else if (isTauri()) {
        const destination = await save({
          title: 'Export playback diagnostics',
          defaultPath: 'GenX-playback-diagnostics.json',
          filters: [{ name: 'Diagnostic report', extensions: ['json'] }],
        });
        if (destination) {
          await writeTextFile(destination, JSON.stringify(report, null, 2));
          if (!closed) status.textContent = 'Playback diagnostic report saved.';
        }
      } else {
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
        );
        const link = doc.createElement('a');
        link.href = url;
        link.download = 'GenX-playback-diagnostics.json';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    }),
  );
  button('Clear report', () => run(async () => render(await playbackTrace.clear())));
  const close = button('Close', () => {
    dialog.close();
    host.button.focus();
  });
  dialog.append(title, explanation, actions, status, summary);
  doc.body.append(dialog);
  const open = () => {
    if (closed) return;
    dialog.showModal();
    close.focus({ preventScroll: true });
    run(async () => render(await playbackTrace.read()));
  };
  host.button.addEventListener('click', open);
  const webError = (event: Event) => {
    const data = (event as CustomEvent<unknown>).detail;
    if (!data || typeof data !== 'object') return;
    const raw = data as Record<string, unknown>;
    if (
      typeof raw.code !== 'number' ||
      !Number.isInteger(raw.code) ||
      raw.code < -1000 ||
      raw.code > 599
    )
      return;
    recordPlaybackTrace('web', 'error', {
      code: raw.fatal === true ? 'decode' : 'network',
      mainFrame: raw.mainFrame === true,
      ...(raw.http === true ? { httpStatus: raw.code } : { nativeErrorCode: raw.code }),
    });
  };
  const webClosed = () => {
    recordPlaybackTrace('web', 'navigation', { state: 'closed' });
  };
  window.addEventListener('genx-page-diagnostic', webError);
  window.addEventListener('genx-page-closed', webClosed);
  const box = (element: HTMLElement): number[] => {
    const b = element.getBoundingClientRect();
    return [b.left, b.top, b.width, b.height];
  };
  const finite = (n: unknown): number | null =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
  let lastGeometry = '';
  const geometryKey = () =>
    JSON.stringify([
      box(host.screen),
      box(host.video),
      innerWidth,
      innerHeight,
      devicePixelRatio,
      host.app.classList.contains('expanded'),
      host.app.classList.contains('viewing-fullscreen'),
      !!doc.fullscreenElement,
      doc.documentElement.dataset.nativeVideo === 'on',
      webTraceActive(),
    ]);
  function sample() {
    if (closed || !traceEnabled()) return;
    lastGeometry = geometryKey();
    const snapshot = host.snapshot();
    recordPlaybackState(snapshot);
    const native = doc.documentElement.dataset.nativeVideo === 'on';
    const quality = readVideoQuality(host.video);
    let frames: number | null = null,
      dropped: number | null = null;
    if (!native && !webTraceActive()) {
      const reading = host.video.getVideoPlaybackQuality?.();
      frames = finite(reading?.totalVideoFrames);
      dropped = finite(reading?.droppedVideoFrames);
    }
    recordPlaybackTrace(webTraceActive() ? 'web' : playbackTraceMode(snapshot), 'sample', {
      engine: webTraceActive() ? 'web-page' : native ? 'media3' : 'webview',
      state: snapshot.state,
      expectedCss: box(host.screen),
      actualCss: native || webTraceActive() ? null : box(host.video),
      viewport: [innerWidth, innerHeight],
      dpr: devicePixelRatio,
      expanded: host.app.classList.contains('expanded'),
      fullscreen: host.app.classList.contains('viewing-fullscreen') || !!doc.fullscreenElement,
      videoWidth: !native && !webTraceActive() ? finite(host.video.videoWidth) : null,
      videoHeight: !native && !webTraceActive() ? finite(host.video.videoHeight) : null,
      totalFrames: frames,
      droppedFrames: dropped,
      positionMs: !native && !webTraceActive() ? finite(host.video.currentTime * 1000) : null,
      bufferedAheadMs: finite(
        quality?.bufferedAheadSeconds == null ? null : quality.bufferedAheadSeconds * 1000,
      ),
      bandwidthEstimate: finite(quality?.bandwidthEstimate),
      ttfbEstimate: finite(quality?.ttfbEstimate),
      ...(quality ? { autoQuality: quality.auto } : {}),
      selectedLevel: finite(quality?.currentLevel),
      availableLevelCount: finite(quality?.availableLevelCount),
      renditionBitrate: finite(
        quality?.availableLevels.find((level) => level.index === quality.currentLevel)?.bitrate,
      ),
      pixelPositionVerified: false,
    });
  }
  const timer = setInterval(sample, 5000);
  let queued = 0;
  const changed = () => {
    if (queued || !traceEnabled()) return;
    queued = requestAnimationFrame(() => {
      queued = 0;
      // Player progress updates may reassign unchanged classes every frame.
      // Only an actual geometry/mode change warrants an extra sample.
      if (geometryKey() !== lastGeometry) sample();
    });
  };
  const observer = new MutationObserver(changed);
  observer.observe(host.app, {
    attributes: true,
    attributeFilter: [
      'class',
      'data-content-library',
      'data-guide-panel',
      'data-vod',
      'data-play-mode',
    ],
  });
  window.addEventListener('resize', changed);
  doc.addEventListener('fullscreenchange', changed);
  return {
    async dispose() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      if (queued) cancelAnimationFrame(queued);
      observer.disconnect();
      window.removeEventListener('resize', changed);
      doc.removeEventListener('fullscreenchange', changed);
      host.button.removeEventListener('click', open);
      window.removeEventListener('genx-page-diagnostic', webError);
      window.removeEventListener('genx-page-closed', webClosed);
      await work;
      await playbackTrace.dispose();
      dialog.close();
      dialog.remove();
    },
    sample,
    get report() {
      return lastReport;
    },
  };
}
