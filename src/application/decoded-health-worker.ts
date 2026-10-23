import { prepareDecodedHealth, type PrepareDecodedHealthInput } from './prepare-decoded-health';
self.onmessage = (event: MessageEvent<PrepareDecodedHealthInput>) => {
  void prepareDecodedHealth(event.data).then(
    (result) => self.postMessage({ ok: true, result }),
    () => self.postMessage({ ok: false }),
  );
};
