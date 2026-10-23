import { migrateLegacyJson, prepareBackupImport, prepareTransfer } from './index';
import type { TransferRequest } from './worker';
self.onmessage = async (event: MessageEvent<TransferRequest>) => {
  try {
    const request = event.data;
    if (request.kind !== 'backup' && request.kind !== 'legacy' && request.kind !== 'export')
      throw new Error('Unsupported import operation.');
    const result =
      request.kind === 'export'
        ? prepareTransfer(request.record)
        : request.kind === 'backup'
          ? prepareBackupImport(request.text)
          : await migrateLegacyJson(request.text, request.options);
    self.postMessage({ ok: true, result });
  } catch (error) {
    // Our codecs emit fixed categories; never echo untrusted fields, URLs or serialized input.
    self.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : 'Import preparation failed.',
    });
  }
};
