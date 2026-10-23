export interface ChannelActionsHost {
  category(id: string): { name: string; current: string; original: string } | null;
  saveCategory(id: string, category: string | null): Promise<void>;
  removeChannel(id: string): Promise<void>;
  notice(message: string): void;
}
const categories = [
  'Sports',
  'News',
  'Movies',
  'Action',
  'Drama',
  'Comedy',
  'Mystery',
  'Sci-Fi',
  'Kids',
  'Cartoons',
  'Documentary',
  'Music',
  'Entertainment',
  'Lifestyle',
  'Education',
  'Religious',
];

/** A bounded channel-specific menu. Category changes preserve provider metadata. */
export function mountChannelActions(host: ChannelActionsHost) {
  const dialog = document.createElement('dialog');
  dialog.id = 'channel-actions-dialog';
  dialog.className = 'channel-actions-dialog';
  const heading = document.createElement('h2');
  heading.id = 'channel-actions-heading';
  dialog.setAttribute('aria-labelledby', heading.id);
  const description = document.createElement('p');
  description.textContent = 'Choose a category for this channel.';
  const choices = document.createElement('div');
  choices.className = 'channel-category-choices';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Cancel';
  close.addEventListener('click', () => dialog.close());
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = 'Remove channel';
  remove.addEventListener('click', () => {
    const id = selectedId;
    if (!id || busy || disposed) return;
    const lease = generation;
    busy = true;
    remove.disabled = true;
    void host
      .removeChannel(id)
      .then(() => {
        if (!disposed && lease === generation) dialog.close();
      })
      .catch(() => {
        if (!disposed && lease === generation)
          host.notice('The channel could not be removed. Try again.');
      })
      .finally(() => {
        busy = false;
        if (!disposed) remove.disabled = false;
      });
  });
  dialog.append(heading, description, choices, remove, close);
  document.body.append(dialog);
  let disposed = false;
  let busy = false;
  let generation = 0;
  let selectedId: string | null = null;
  let returnId: string | null = null;
  dialog.addEventListener('close', () => {
    generation++;
    selectedId = null;
    const controls = document.querySelectorAll<HTMLButtonElement>('[data-channel-action="manage"]');
    (
      [...controls].find((control) => control.dataset.channelId === returnId) ??
      document.querySelector<HTMLElement>('#channel-list')
    )?.focus({ preventScroll: true });
  });
  choices.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
      'button[data-category]',
    );
    const id = selectedId;
    if (!button || !id || busy || disposed) return;
    const lease = generation;
    busy = true;
    for (const control of choices.querySelectorAll<HTMLButtonElement>('button'))
      control.disabled = true;
    void host
      .saveCategory(id, button.dataset.category || null)
      .then(() => {
        if (!disposed && lease === generation) dialog.close();
      })
      .catch(() => {
        if (!disposed && lease === generation)
          host.notice('The category could not be saved. Try again.');
      })
      .finally(() => {
        busy = false;
        if (!disposed)
          for (const control of choices.querySelectorAll<HTMLButtonElement>('button'))
            control.disabled = false;
      });
  });
  return {
    open(id: string) {
      if (disposed || busy) return;
      const channel = host.category(id);
      if (!channel) return;
      generation++;
      selectedId = returnId = id;
      heading.textContent = channel.name;
      choices.replaceChildren();
      const values: Array<[string, string | null]> = [
        [`Use source category (${channel.original || 'Uncategorized'})`, null],
        ...[...new Set([...categories, channel.current].filter(Boolean))].map(
          (value): [string, string] => [value, value],
        ),
      ];
      for (const [label, value] of values) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.category = value ?? '';
        button.textContent = label;
        button.setAttribute('aria-pressed', String(value === channel.current));
        choices.append(button);
      }
      dialog.showModal();
      choices.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
    },
    dispose() {
      disposed = true;
      generation++;
      dialog.remove();
    },
  };
}
