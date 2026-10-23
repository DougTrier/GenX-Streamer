import type {
  BootstrapRecoveryActions,
  BootstrapRecoveryView,
  BootstrapSnapshot,
} from './bootstrap-boundary';

/** Constructed only on failure; normal startup creates no replacement chrome. */
export function createBootstrapRecoveryView(doc: Document): BootstrapRecoveryView {
  const dialog = doc.createElement('dialog');
  dialog.setAttribute('role', 'alertdialog');
  dialog.setAttribute('aria-label', 'GenX Streamer could not open');
  dialog.dataset.bootstrapRecovery = 'true';
  Object.assign(dialog.style, {
    boxSizing: 'border-box',
    width: 'min(440px, calc(100vw - 24px))',
    maxHeight: 'calc(100dvh - 24px)',
    overflow: 'auto',
    padding: '20px',
    background: '#071629',
    color: '#f0f5ff',
    border: '2px solid #00d9ff',
    borderRadius: '12px',
    fontFamily: 'sans-serif',
    fontSize: '16px',
  });
  const heading = doc.createElement('h2');
  heading.textContent = 'GenX Streamer could not finish opening';
  heading.style.fontSize = '20px';
  const message = doc.createElement('p');
  message.setAttribute('role', 'status');
  const buttons = doc.createElement('div');
  Object.assign(buttons.style, { display: 'flex', flexWrap: 'wrap', gap: '8px' });
  const button = (label: string) => {
    const node = doc.createElement('button');
    node.type = 'button';
    node.textContent = label;
    Object.assign(node.style, {
      minWidth: '44px',
      minHeight: '44px',
      padding: '8px 14px',
      font: 'inherit',
      color: '#f0f5ff',
      background: '#132c46',
      border: '1px solid #00d9ff',
      borderRadius: '6px',
    });
    buttons.append(node);
    return node;
  };
  const retry = button('Retry opening');
  const close = button('Close app');
  dialog.append(heading, message, buttons);
  let disposed = false,
    actions: BootstrapRecoveryActions | null = null;
  const cancel = (event: Event) => event.preventDefault();
  const retryClick = () => {
    void actions?.retry().catch(() => undefined);
  };
  const closeClick = () => {
    void actions?.close().catch(() => undefined);
  };
  dialog.addEventListener('cancel', cancel);
  retry.addEventListener('click', retryClick);
  close.addEventListener('click', closeClick);
  return {
    render(snapshot: BootstrapSnapshot, nextActions: BootstrapRecoveryActions) {
      if (disposed) return;
      actions = nextActions;
      retry.hidden = !snapshot.canRetry && snapshot.phase !== 'retrying';
      close.hidden = !snapshot.canClose && snapshot.phase !== 'closing';
      retry.disabled = close.disabled = snapshot.pending || snapshot.phase === 'disposing';
      message.textContent =
        snapshot.phase === 'retrying'
          ? 'Opening GenX Streamer…'
          : snapshot.phase === 'closing'
            ? 'Closing GenX Streamer…'
            : snapshot.reason === 'close-failed'
              ? 'Closing did not finish. Try Close again, or close and reopen GenX Streamer.'
              : snapshot.reason === 'retry-failed'
                ? 'Opening did not finish. Try again, or close and reopen GenX Streamer.'
                : snapshot.phase === 'disposing'
                  ? 'Finishing cleanup…'
                  : snapshot.canRetry
                    ? 'Try opening again. No recovery action will reset your saved channels.'
                    : 'Close and reopen GenX Streamer. This recovery screen does not reset your saved channels.';
      if (!dialog.isConnected) doc.body.append(dialog);
      if (!dialog.open) {
        dialog.showModal();
        if (!retry.hidden) retry.focus({ preventScroll: true });
        else if (!close.hidden) close.focus({ preventScroll: true });
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      actions = null;
      dialog.removeEventListener('cancel', cancel);
      retry.removeEventListener('click', retryClick);
      close.removeEventListener('click', closeClick);
      if (dialog.open) dialog.close();
      dialog.remove();
    },
  };
}
