import { decodeSavedHealth, decodeSavedHealthOnly, evaluateHealthHistory } from './health-history';
import type { HistoryRequest } from './health-history-read';
self.onmessage = async (event: MessageEvent<HistoryRequest>) => {
  try {
    const request = event.data;
    if (request.kind !== 'decode' && request.kind !== 'decode-health' && request.kind !== 'page')
      throw new Error('Unsupported saved check operation.');
    const value =
      request.kind === 'decode'
        ? decodeSavedHealth(request.snapshot)
        : request.kind === 'decode-health'
          ? decodeSavedHealthOnly(request.snapshot)
          : await evaluateHealthHistory(request.snapshot, request.query, request.context);
    self.postMessage({ ok: true, value });
  } catch (error) {
    self.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : 'Saved checks could not be read.',
    });
  }
};
