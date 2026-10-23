import './fullscreen.css';
import { restoreRemoteFocus } from './remote-navigation';

/** Presentation follows acknowledged fullscreen state; it never owns playback. */
export function installFullscreenPresentation(root: HTMLElement): {
  set(active: boolean): void;
  dispose(): void;
} {
  let active = false;
  let disposed = false;
  let previous: HTMLElement | null = null;
  let lastControl: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let swallowedKey: string | null = null;
  const control = root.querySelector<HTMLElement>('#fullscreen-button');
  const dock = root.querySelector<HTMLElement>('.dock');
  const originalInert = dock?.inert ?? false;
  const visible = (node: HTMLElement | null): boolean => {
    if (
      !node?.isConnected ||
      node.closest('[hidden],[inert]') ||
      node.matches(':disabled,[aria-disabled="true"]') ||
      !node.matches('button,input,textarea,select,summary,[tabindex="0"]')
    )
      return false;
    const bounds = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return bounds.width > 0 && bounds.height > 0 && style.visibility !== 'hidden';
  };
  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const arm = (): void => {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      if (!active || disposed) return;
      if (root.querySelector('[data-video-quality-open="true"],[data-audio-tracks-open="true"]')) {
        arm();
        return;
      }
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && dock?.contains(focused)) {
        lastControl = focused;
        focused.blur();
      }
      if (dock) dock.inert = true;
      root.classList.add('fullscreen-dock-hidden');
    }, 3000);
  };
  const reveal = (focus: boolean): void => {
    if (!active || disposed) return;
    root.classList.remove('fullscreen-dock-hidden');
    if (dock) dock.inert = originalInert;
    if (focus) restoreRemoteFocus(visible(lastControl) ? lastControl : control, control);
    arm();
  };
  const keydown = (event: KeyboardEvent): void => {
    if (!active || disposed || event.key === 'Escape' || event.key === 'BrowserBack') return;
    // Open dialogs keep their own directional and editing boundaries.
    if (document.querySelector('dialog[open]')) return;
    const wakeKey = event.key.startsWith('Arrow') || ['Enter', ' ', 'Spacebar'].includes(event.key);
    if (
      swallowedKey === event.key ||
      (event.repeat && ['Enter', ' ', 'Spacebar'].includes(event.key))
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (wakeKey && root.classList.contains('fullscreen-dock-hidden')) {
      swallowedKey = event.key;
      event.preventDefault();
      event.stopImmediatePropagation();
      reveal(true);
      return;
    }
    if (wakeKey || event.key === 'Tab') reveal(false);
  };
  const keyup = (event: KeyboardEvent): void => {
    if (event.key !== swallowedKey) return;
    swallowedKey = null;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const motion = (): void => reveal(false);
  const focusin = (event: FocusEvent): void => {
    if (active && event.target instanceof HTMLElement && dock?.contains(event.target)) {
      lastControl = event.target;
      reveal(false);
    }
  };
  window.addEventListener('keydown', keydown, true);
  window.addEventListener('keyup', keyup, true);
  root.addEventListener('pointermove', motion);
  // A finger tap moves no pointer: without this, touch screens could never
  // bring the full-screen dock back (found with instant replay on the Galaxy
  // S25, October 21, 2026).
  root.addEventListener('pointerdown', motion);
  root.addEventListener('wheel', motion, { passive: true });
  root.addEventListener('focusin', focusin);
  const set = (next: boolean): void => {
    if (disposed || next === active) return;
    if (next) {
      previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      active = true;
      root.classList.add('viewing-fullscreen');
      if (!visible(previous)) restoreRemoteFocus(control);
      reveal(false);
    } else {
      active = false;
      clearTimer();
      swallowedKey = null;
      root.classList.remove('viewing-fullscreen', 'fullscreen-dock-hidden');
      if (dock) dock.inert = originalInert;
      restoreRemoteFocus(previous, control);
      previous = null;
      lastControl = null;
    }
  };
  return {
    set,
    dispose() {
      if (disposed) return;
      set(false);
      disposed = true;
      clearTimer();
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('keyup', keyup, true);
      root.removeEventListener('pointermove', motion);
      root.removeEventListener('pointerdown', motion);
      root.removeEventListener('wheel', motion);
      root.removeEventListener('focusin', focusin);
    },
  };
}
