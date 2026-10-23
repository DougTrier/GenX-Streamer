import { readVideoQuality, setVideoQuality } from '../platform/browser-engine';
import './video-quality.css';

export interface VideoQualityAdapter {
  read: typeof readVideoQuality;
  set: typeof setVideoQuality;
}

/** Presents advertised renditions; never creates a decoder or estimates available quality. */
export function installVideoQuality(
  video: HTMLVideoElement,
  container: HTMLElement,
  adapter: VideoQualityAdapter = { read: readVideoQuality, set: setVideoQuality },
): () => void {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'video-quality-button';
  button.setAttribute('aria-label', 'Video quality');
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  const menu = document.createElement('div');
  menu.className = 'video-quality-menu';
  menu.role = 'menu';
  menu.setAttribute('aria-label', 'Available video quality');
  menu.hidden = true;
  container.append(button, menu);
  let disposed = false;
  const eligible = () =>
    !button.disabled &&
    !button.closest('[inert]') &&
    button.getClientRects().length > 0 &&
    getComputedStyle(button).visibility !== 'hidden';
  const close = (restore = false) => {
    const ownedFocus = menu.contains(document.activeElement);
    if (!menu.hidden) menu.hidden = true;
    delete container.dataset.videoQualityOpen;
    button.setAttribute('aria-expanded', 'false');
    if (restore && ownedFocus && eligible()) button.focus({ preventScroll: true });
  };
  const optionLabel = (
    level: NonNullable<ReturnType<typeof readVideoQuality>>['availableLevels'][number],
  ) => {
    const resolution = level.height ? `${level.height}p` : 'Resolution unknown';
    return `${resolution}${level.bitrate ? ` · ${Number((level.bitrate / 1_000_000).toFixed(2))} Mbps` : ''}`;
  };
  const refresh = () => {
    if (disposed) return;
    const state = adapter.read(video);
    const levels = state?.availableLevels ?? [];
    button.disabled = !state || (!levels.length && !state.levelsTruncated);
    const current = levels.find((level) => level.index === state?.currentLevel);
    button.textContent =
      state?.auto === false
        ? `Quality${current?.height ? ` · ${current.height}p` : ''} ▴`
        : `Auto${current?.height ? ` · ${current.height}p` : ''} ▴`;
    button.title = state?.levelsTruncated
      ? 'Too many renditions to safely show. Choose Auto to let the player adapt.'
      : button.disabled
        ? 'Quality selection is unavailable for this stream.'
        : 'Choose Auto or an advertised stream rendition. Availability does not guarantee smooth playback.';
    if (button.disabled || !eligible()) {
      close();
      menu.replaceChildren();
      return;
    }
    const focused = (document.activeElement as HTMLElement | null)?.dataset.quality;
    const fragment = document.createDocumentFragment();
    for (const choice of [
      { index: null, label: 'Auto' },
      ...(state?.levelsTruncated ? [] : levels).map((level) => ({
        index: level.index,
        label: optionLabel(level),
      })),
    ]) {
      const option = document.createElement('button');
      option.type = 'button';
      option.role = 'menuitemradio';
      option.dataset.quality = choice.index === null ? 'auto' : String(choice.index);
      const label = document.createElement('span');
      label.textContent = choice.label;
      option.append(label);
      option.title = choice.label;
      option.setAttribute(
        'aria-checked',
        String(
          choice.index === null
            ? state?.auto
            : state?.auto === false && state.currentLevel === choice.index,
        ),
      );
      option.addEventListener('click', () => {
        if (disposed || !eligible() || menu.hidden) return;
        const changed = adapter.set(video, choice.index);
        close(true);
        refresh();
        if (!changed) button.title = 'Quality could not change. Try again.';
      });
      fragment.append(option);
    }
    menu.replaceChildren(fragment);
    if (!menu.hidden && focused)
      [...menu.querySelectorAll<HTMLButtonElement>('button')]
        .find((item) => item.dataset.quality === focused)
        ?.focus({ preventScroll: true });
  };
  const open = () => {
    if (disposed || !eligible()) return;
    if (!menu.hidden) {
      close(true);
      return;
    }
    refresh();
    if (button.disabled) return;
    const rect = button.getBoundingClientRect();
    const width = Math.min(280, innerWidth - 16);
    const height = Math.max(0, rect.top - 12);
    if (height < 44) return;
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, rect.right - width))}px`;
    menu.style.bottom = `${innerHeight - rect.top + 4}px`;
    menu.style.maxHeight = `${height}px`;
    menu.hidden = false;
    container.dataset.videoQualityOpen = 'true';
    button.setAttribute('aria-expanded', 'true');
    (
      menu.querySelector<HTMLButtonElement>('[aria-checked="true"]') ??
      menu.querySelector<HTMLButtonElement>('button')
    )?.focus();
  };
  const keys = (event: KeyboardEvent) => {
    if (menu.hidden) return;
    const items = [...menu.querySelectorAll<HTMLButtonElement>('button')];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      close(true);
    } else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[next]?.focus();
      items[next]?.scrollIntoView({ block: 'nearest' });
    }
  };
  const outside = (event: Event) => {
    if (!container.contains(event.target as Node)) close();
  };
  const geometry = () => close(true);
  const requestedClose = () => close(true);
  // Only an open menu needs its button to stay usable. Measuring on every
  // attribute change anywhere in the app forced a layout each time while
  // video played: 0.8 s of every 8 s on the Sansui (October 19, 2026).
  const observer = new MutationObserver(() => {
    if (!menu.hidden && !eligible()) close();
  });
  observer.observe(container.closest('#app') ?? container, {
    attributes: true,
    subtree: true,
    attributeFilter: ['inert', 'class', 'hidden'],
  });
  button.addEventListener('click', open);
  container.addEventListener('video-quality-close', requestedClose);
  menu.addEventListener('keydown', keys);
  video.addEventListener('video-quality-change', refresh);
  document.addEventListener('pointerdown', outside);
  document.addEventListener('focusin', outside);
  document.addEventListener('keydown', keys, true);
  window.addEventListener('resize', geometry);
  refresh();
  return () => {
    if (disposed) return;
    close();
    disposed = true;
    observer.disconnect();
    button.removeEventListener('click', open);
    container.removeEventListener('video-quality-close', requestedClose);
    menu.removeEventListener('keydown', keys);
    video.removeEventListener('video-quality-change', refresh);
    document.removeEventListener('pointerdown', outside);
    document.removeEventListener('focusin', outside);
    document.removeEventListener('keydown', keys, true);
    window.removeEventListener('resize', geometry);
    button.remove();
    menu.remove();
  };
}
