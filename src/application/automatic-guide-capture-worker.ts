import { captureAutomaticGuide, type AutomaticGuideSavedSnapshot } from './automatic-guide-capture';

self.onmessage = (event: MessageEvent<AutomaticGuideSavedSnapshot>) => {
  try {
    self.postMessage({ ok: true, value: captureAutomaticGuide(event.data) });
  } catch {
    self.postMessage({ ok: false, error: 'Saved channels could not prepare a program guide.' });
  }
};
