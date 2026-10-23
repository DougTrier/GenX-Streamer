import {
  serializePlaylistExport,
  isPlaylistExportFailureCode,
  type PlaylistExportInput,
} from './playlist-export';
self.onmessage = (event: MessageEvent<PlaylistExportInput>) => {
  try {
    self.postMessage({ ok: true, result: serializePlaylistExport(event.data) });
  } catch (error) {
    const code =
      error instanceof Error && isPlaylistExportFailureCode(error.message)
        ? error.message
        : 'playlist-export-catalog-invalid';
    self.postMessage({ ok: false, code });
  }
};
