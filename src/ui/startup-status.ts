import type { createStartupObserver } from '../application/startup-observer';
import './startup-status.css';

export type StartupSnapshot = ReturnType<ReturnType<typeof createStartupObserver>['snapshot']>;
export interface StartupStatusView {
  render(snapshot: StartupSnapshot): void;
  dispose(): void;
}

const messages: Partial<Record<StartupSnapshot['pendingStages'][number], string>> = {
  'read-record-pair':
    'Opening your saved channels and shows. Checking a large library can take a little longer.',
  'health-decode': 'Preparing your saved channels and shows.',
  preferences: 'Restoring your viewing preferences.',
  'apply-settings': 'Restoring your viewing preferences.',
  'retry-storage': 'Retrying your saved library.',
  'scan-checkpoint-summary': 'Restoring your saved scan progress.',
};

/** Fixed application copy only; never renders errors, paths, media or native payloads. */
export function createStartupStatus(doc: Document): StartupStatusView {
  const node = doc.createElement('section');
  node.dataset.startupStatus = 'true';
  node.setAttribute('role', 'status');
  node.setAttribute('aria-label', 'Opening saved library');
  node.setAttribute('aria-live', 'polite');
  node.setAttribute('aria-atomic', 'true');
  const heading = doc.createElement('h2');
  const message = doc.createElement('p');
  node.append(heading, message);
  // The viewing shell is inert until the checked saved-data read finishes.
  // Keep this announcement outside that shell without creating a focus target.
  doc.body.append(node);
  let disposed = false;
  return {
    render(snapshot) {
      if (disposed) return;
      const app = doc.getElementById('app');
      if (app) app.dataset.startup = snapshot.state;
      if (snapshot.state === 'completed' || snapshot.state === 'cancelled') {
        node.remove();
        return;
      }
      heading.textContent =
        snapshot.state === 'failed' ? 'Saved library needs attention' : 'Opening your library…';
      node.setAttribute(
        'aria-label',
        snapshot.state === 'failed' ? 'Saved library needs attention' : 'Opening saved library',
      );
      message.textContent =
        snapshot.state === 'failed'
          ? 'Your saved library is not ready. Use the recovery controls to retry.'
          : (messages[snapshot.pendingStages.at(-1)!] ??
            'Preparing GenX Streamer. Your saved library is not ready yet.');
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      node.remove();
    },
  };
}
