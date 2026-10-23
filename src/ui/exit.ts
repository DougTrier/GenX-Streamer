/** The visible Exit action uses the same joined native cleanup as window Close. */
export function mountExit(
  button: HTMLButtonElement,
  host: { native(): boolean; request(): Promise<void>; notice(message: string): void },
): () => void {
  let pending = false;
  let disposed = false;
  const exit = () => {
    if (pending || disposed) return;
    if (!host.native()) {
      host.notice('Close this browser tab to exit the preview.');
      return;
    }
    pending = true;
    button.disabled = true;
    void host.request().catch(() => {
      pending = false;
      if (!disposed) {
        button.disabled = false;
        host.notice('Closing could not start. Try Exit app again.');
      }
    });
  };
  button.addEventListener('click', exit);
  return () => {
    disposed = true;
    button.removeEventListener('click', exit);
  };
}
