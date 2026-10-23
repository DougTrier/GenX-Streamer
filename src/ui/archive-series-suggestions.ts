import type { SeriesIdentity, SeriesShow } from '../platform/series-identity';

export type SeriesLookup = (query: string, signal: AbortSignal) => Promise<SeriesIdentity | null>;
const key = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
const years = (show: SeriesShow) =>
  show.premieredYear === undefined
    ? ''
    : show.endedYear !== undefined && show.endedYear !== show.premieredYear
      ? ` (${show.premieredYear}–${show.endedYear})`
      : ` (${show.premieredYear})`;

/**
 * Optional suggestion row for an explicit GenXtra Search. Choosing a title runs the
 * ordinary search for that exact text; nothing is admitted or played automatically.
 */
export function mountSeriesSuggestions(
  doc: Document,
  options: { lookup: SeriesLookup; choose(title: string): void },
) {
  const element = doc.createElement('div');
  element.className = 'gx-archive-series';
  element.hidden = true;
  element.setAttribute('role', 'group');
  element.setAttribute('aria-label', 'Show suggestions');
  let controller: AbortController | null = null;
  const clear = () => {
    controller?.abort();
    controller = null;
    element.replaceChildren();
    element.hidden = true;
  };
  const row = (label: string, shows: readonly SeriesShow[], query: string) => {
    const wanted = key(query);
    const items = shows.filter((show) => key(show.name) !== wanted);
    if (!items.length) return null;
    const line = doc.createElement('p');
    const caption = doc.createElement('span');
    caption.className = 'gx-archive-series-label';
    caption.textContent = label;
    line.append(caption);
    for (const show of items) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'gx-archive-series-chip';
      button.textContent = `${show.name}${years(show)}`;
      button.title = show.network ? `${show.name} · ${show.network}` : show.name;
      button.addEventListener('click', () => {
        clear();
        options.choose(show.name);
      });
      line.append(button);
    }
    return line;
  };
  return {
    element,
    clear,
    async show(query: string): Promise<void> {
      clear();
      const owned = new AbortController();
      controller = owned;
      // A failed optional lookup simply shows no suggestions.
      const identity: SeriesIdentity | null = await options
        .lookup(query, owned.signal)
        .catch(() => null);
      if (controller !== owned || owned.signal.aborted || !identity) return;
      const lines = [
        identity.person
          ? row(`Shows with ${identity.person.name}:`, identity.person.shows, query)
          : null,
        row('Search for:', identity.shows, query),
      ].filter((line): line is HTMLParagraphElement => line !== null);
      if (!lines.length) return;
      const note = doc.createElement('small');
      note.className = 'gx-archive-series-attribution';
      note.textContent = identity.attribution;
      element.replaceChildren(...lines, note);
      element.hidden = false;
    },
    dispose: clear,
  };
}
