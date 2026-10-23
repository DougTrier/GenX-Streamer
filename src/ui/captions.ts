import './captions.css';

/** Embedded subtitles another player can show (the native on-demand player). */
export interface SubtitleChoice {
  id: string;
  label: string;
  language: string;
  selected: boolean;
  supported: boolean;
}
export interface SubtitleChoices {
  tracks: readonly SubtitleChoice[];
  select(id: string | null): void;
}
const choices = new WeakMap<HTMLVideoElement, SubtitleChoices>();
export const SUBTITLE_CHOICES_CHANGE = 'subtitle-choices-change';
/** Publish (or clear with null) another player's subtitles for the CC button. */
export function setSubtitleChoices(video: HTMLVideoElement, value: SubtitleChoices | null): void {
  if (value) choices.set(video, value);
  else choices.delete(video);
  video.dispatchEvent(new Event(SUBTITLE_CHOICES_CHANGE));
}
/** A readable name for a subtitle: its label, else its language's name. */
export function subtitleName(choice: SubtitleChoice, index: number): string {
  if (choice.label) return choice.label;
  if (choice.language) {
    try {
      const name = new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }).of(
        choice.language,
      );
      if (name) return name;
    } catch {
      /* An unknown code keeps its plain form below. */
    }
    return choice.language;
  }
  return `Subtitles ${index + 1}`;
}
/** One native text-track renderer; no copied cues or secondary caption layer. */
export function installCaptions(video: HTMLVideoElement, button: HTMLButtonElement): () => void {
  let enabled = false;
  let disposed = false;
  let reconciling = false;
  const selectable = () =>
    [...video.textTracks].filter(
      (track) => track.kind === 'captions' || track.kind === 'subtitles',
    );
  const english = (track: TextTrack) => /^(en|eng)(-|$)/i.test(track.language);
  // Another player's subtitles: each press steps Off → first → next → … → Off.
  const external = () => {
    const provided = choices.get(video);
    if (!provided) return false;
    const usable = provided.tracks.filter((track) => track.supported);
    const on = usable.findIndex((track) => track.selected);
    button.disabled = usable.length === 0;
    button.setAttribute('aria-pressed', String(on >= 0));
    const label =
      on >= 0
        ? `Subtitles: ${subtitleName(usable[on]!, provided.tracks.indexOf(usable[on]!))}`
        : usable.length
          ? 'Subtitles off'
          : 'No subtitles';
    button.setAttribute('aria-label', label);
    button.title = label;
    return true;
  };
  const reconcile = () => {
    if (disposed || reconciling) return;
    if (external()) return;
    button.setAttribute('aria-label', 'Closed captions');
    button.removeAttribute('title');
    reconciling = true;
    try {
      const tracks = selectable();
      const preferred = tracks
        .map((track, index) => ({ track, index }))
        .sort(
          (a, b) =>
            Number(english(b.track)) - Number(english(a.track)) ||
            Number(b.track.kind === 'captions') - Number(a.track.kind === 'captions') ||
            a.index - b.index,
        )[0]?.track;
      for (const track of tracks) {
        const mode = enabled && track === preferred ? 'showing' : 'disabled';
        if (track.mode !== mode) track.mode = mode;
      }
      button.disabled = tracks.length === 0;
      button.setAttribute('aria-pressed', String(enabled && !!preferred));
    } finally {
      reconciling = false;
    }
  };
  const toggle = () => {
    if (disposed || button.disabled) return;
    const provided = choices.get(video);
    if (provided) {
      const usable = provided.tracks.filter((track) => track.supported);
      const on = usable.findIndex((track) => track.selected);
      provided.select(on + 1 < usable.length ? usable[on + 1]!.id : null);
      return;
    }
    enabled = !enabled;
    reconcile();
  };
  // The admitted engine owns cue cleanup. Native tracks can survive/reuse the
  // video element, so a new session must not inherit the prior user's On state.
  const reset = () => {
    if (disposed) return;
    enabled = false;
    reconcile();
  };
  button.textContent = 'CC';
  button.setAttribute('aria-label', 'Closed captions');
  button.addEventListener('click', toggle);
  video.addEventListener('caption-session-reset', reset);
  video.addEventListener(SUBTITLE_CHOICES_CHANGE, reconcile);
  video.textTracks.addEventListener('addtrack', reconcile);
  video.textTracks.addEventListener('removetrack', reconcile);
  video.textTracks.addEventListener('change', reconcile);
  reconcile();
  return () => {
    if (disposed) return;
    enabled = false;
    reconcile();
    disposed = true;
    button.removeEventListener('click', toggle);
    video.removeEventListener('caption-session-reset', reset);
    video.removeEventListener(SUBTITLE_CHOICES_CHANGE, reconcile);
    video.textTracks.removeEventListener('addtrack', reconcile);
    video.textTracks.removeEventListener('removetrack', reconcile);
    video.textTracks.removeEventListener('change', reconcile);
  };
}
