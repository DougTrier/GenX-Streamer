import { exportGrabberChannels, grabberSummary } from '../platform/guide-grabber';

/** Settings-only control; never part of the viewing flow and never automatic. */
export function installGuideGrabberExport(
  doc: Document,
  run: typeof exportGrabberChannels = exportGrabberChannels,
): { dispose(): void } {
  const button = doc.getElementById('export-guide-grabber') as HTMLButtonElement | null;
  const status = doc.getElementById('guide-grabber-status');
  let controller: AbortController | null = null;
  if (!button || !status) return { dispose() {} };
  const click = () => {
    if (controller) return;
    const owned = new AbortController();
    controller = owned;
    button.disabled = true;
    status.textContent = 'Preparing a seven-day guide channel list for your saved channels…';
    void run(owned.signal)
      .then(({ result, saved }) => {
        if (owned.signal.aborted) return;
        status.textContent =
          result.channels && !saved
            ? 'Save canceled. Your channels and guide settings are unchanged.'
            : grabberSummary(result, saved);
      })
      .catch(() => {
        if (!owned.signal.aborted)
          status.textContent =
            'The guide channel list could not be prepared. Check the connection and try again.';
      })
      .finally(() => {
        if (controller === owned) controller = null;
        button.disabled = false;
      });
  };
  button.addEventListener('click', click);
  return {
    dispose() {
      controller?.abort();
      button.removeEventListener('click', click);
    },
  };
}
