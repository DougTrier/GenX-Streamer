import { isTauri } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { MAX_PLAYLIST_BYTES } from '../catalog/parser';
import type { PlaylistExportResult } from '../catalog/playlist-export';
import { boundedUtf8Text } from './bounded-text';

export interface PlaylistFileReceipt {
  status: 'saved' | 'canceled' | 'download-started';
  filename: string;
}
/** Injected platform seam; the native destination is obtained exclusively from the user picker. */
export interface PlaylistFileTransport {
  isNative(): boolean;
  pickSave(filename: string): Promise<string | null>;
  writeText(destination: string, text: string): Promise<void>;
  download(result: PlaylistExportResult): Promise<void>;
}
async function browserDownload(result: PlaylistExportResult): Promise<void> {
  const url = URL.createObjectURL(new Blob([result.text], { type: result.mimeType }));
  let anchor: HTMLAnchorElement | undefined;
  try {
    anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = result.filename;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    // Keep the URL alive through the activation task, then join owned URL/element cleanup.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  } finally {
    try {
      anchor?.remove();
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}
const platform: PlaylistFileTransport = {
  isNative: isTauri,
  pickSave: (filename) =>
    save({
      title: 'Export channels',
      defaultPath: filename,
      filters: [{ name: 'M3U channel list', extensions: ['m3u'] }],
    }),
  writeText: (destination, text) => writeTextFile(destination, text),
  download: browserDownload,
};
function snapshot(result: PlaylistExportResult): PlaylistExportResult {
  if (
    !result ||
    result.schemaVersion !== 1 ||
    result.mimeType !== 'audio/x-mpegurl' ||
    result.filename !== 'genx-channels.m3u' ||
    !boundedUtf8Text(result.text, MAX_PLAYLIST_BYTES) ||
    !result.text.startsWith('#EXTM3U\n') ||
    !result.text.endsWith('\n') ||
    !Number.isSafeInteger(result.byteLength) ||
    result.byteLength < 8 ||
    result.byteLength > MAX_PLAYLIST_BYTES ||
    !Number.isSafeInteger(result.channelCount) ||
    result.channelCount < 0 ||
    result.channelCount > 100000 ||
    !Number.isSafeInteger(result.streamCount) ||
    result.streamCount < result.channelCount ||
    result.streamCount > 100000
  )
    throw new Error('playlist-save-invalid-export');
  return {
    schemaVersion: 1,
    text: result.text,
    mimeType: result.mimeType,
    filename: result.filename,
    channelCount: result.channelCount,
    streamCount: result.streamCount,
    byteLength: result.byteLength,
  };
}
/** Caller retains this entire promise through close. Aborting cannot dismiss an OS picker or undo an admitted write. */
export async function savePlaylistExport(
  result: PlaylistExportResult,
  signal: AbortSignal,
  transport: PlaylistFileTransport = platform,
): Promise<PlaylistFileReceipt> {
  const captured = snapshot(result);
  const canceled = (): PlaylistFileReceipt => ({ status: 'canceled', filename: captured.filename });
  if (signal.aborted) return canceled();
  if (!transport.isNative()) {
    try {
      await transport.download(captured);
    } catch {
      throw new Error('playlist-save-download-failed');
    }
    return { status: 'download-started', filename: captured.filename };
  }
  let destination: string | null;
  try {
    destination = await transport.pickSave(captured.filename);
  } catch {
    throw new Error('playlist-save-picker-failed');
  }
  // Await actual picker resolution, then refuse to admit the write if canceled in the meantime.
  if (destination === null || signal.aborted) return canceled();
  if (!boundedUtf8Text(destination, 16384) || /[\r\n]/u.test(destination))
    throw new Error('playlist-save-picker-invalid');
  try {
    await transport.writeText(destination, captured.text);
  } catch {
    throw new Error('playlist-save-write-failed');
  }
  // A successful write acknowledged after cancellation is still a real saved file.
  return { status: 'saved', filename: captured.filename };
}
