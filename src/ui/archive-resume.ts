export type ArchiveResumeChoice = 'resume' | 'restart' | 'cancel';

/** One transient choice owned by the current selection signal. */
export function chooseArchiveResume(
  title: string,
  positionMs: number,
  signal: AbortSignal,
  completed = false,
): Promise<ArchiveResumeChoice> {
  if (signal.aborted) return Promise.resolve('cancel');
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const dialog = document.createElement('dialog');
  dialog.className = 'archive-resume-dialog';
  dialog.setAttribute('aria-label', 'Resume this video');
  const heading = document.createElement('h2');
  heading.textContent = completed ? 'Watch this video again?' : 'Pick up where you left off?';
  const name = document.createElement('p');
  name.textContent = title;
  const seconds = Math.floor(positionMs / 1000);
  const timestamp = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const actions = document.createElement('div');
  actions.className = 'dialog-actions';
  dialog.append(heading, name, actions);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (choice: ArchiveResumeChoice) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      dialog.removeEventListener('cancel', cancel);
      dialog.removeEventListener('close', closed);
      if (dialog.open) dialog.close();
      dialog.remove();
      if (opener?.isConnected && !opener.closest('[hidden],[inert]'))
        opener.focus({ preventScroll: true });
      resolve(signal.aborted ? 'cancel' : choice);
    };
    const abort = () => finish('cancel');
    const cancel = (event: Event) => {
      event.preventDefault();
      finish('cancel');
    };
    const closed = () => finish('cancel');
    const choices: ReadonlyArray<readonly [ArchiveResumeChoice, string]> = completed
      ? [
          ['restart', 'Watch again'],
          ['cancel', 'Cancel'],
        ]
      : [
          ['resume', `Resume from ${timestamp}`],
          ['restart', 'Start over'],
          ['cancel', 'Cancel'],
        ];
    for (const [choice, label] of choices) {
      const action = document.createElement('button');
      action.type = 'button';
      action.textContent = label;
      action.dataset.resumeChoice = choice;
      action.addEventListener('click', () => finish(choice), { once: true });
      actions.append(action);
    }
    signal.addEventListener('abort', abort, { once: true });
    dialog.addEventListener('cancel', cancel);
    dialog.addEventListener('close', closed);
    document.body.append(dialog);
    try {
      dialog.showModal();
      actions.querySelector<HTMLButtonElement>('button')?.focus();
    } catch {
      // A failed modal attachment cannot leave a selection waiting forever.
      finish('cancel');
    }
  });
}
