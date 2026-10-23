import './vpn-indicator.css';
import type { VpnStatusSource } from '../platform/vpn-status';

/** Where the wordmark's tagline ends ("…GETS OLD"), as a share of its width. */
const TAGLINE_END = 0.751;
/** The part of the wordmark "Streamer" covers on the right, which the shield stays clear of. */
const SCRIPT_END = 0.78;
/** The shield's vertical centre, as a share of the wordmark's height (the tagline row). */
const SHIELD_ROW = 0.8;
const POLL_MS = 15_000;

/**
 * The header's VPN shield (docs/vpn-indicator.md): green while a VPN
 * connection is up, red when none is, grey when the device cannot tell. It sits
 * below "Streamer", centred between the end of the tagline and the first
 * library button, and steps aside wherever there is no room for it.
 */
export function mountVpnIndicator(
  topbar: HTMLElement,
  source: VpnStatusSource,
  options: {
    setInterval?(callback: () => void, ms: number): number;
    clearInterval?(handle: number): void;
  } = {},
): () => void {
  const every = options.setInterval ?? ((callback, ms) => window.setInterval(callback, ms));
  const stop = options.clearInterval ?? ((handle) => window.clearInterval(handle));
  const shield = document.createElement('span');
  shield.id = 'vpn-status';
  shield.className = 'vpn-status';
  shield.setAttribute('role', 'img');
  shield.hidden = true;
  shield.innerHTML = `<svg viewBox="0 0 28 32" aria-hidden="true" focusable="false"><defs><linearGradient id="gx-vpn-glass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#22385d"/><stop offset=".6" stop-color="#111d36"/><stop offset="1" stop-color="#0a1328"/></linearGradient></defs><path class="vpn-shield" d="M14 1.6 25.6 6.1v8.4c0 7.6-4.9 13.2-11.6 16C7.3 27.7 2.4 22.1 2.4 14.5V6.1Z"/><path class="vpn-sheen" d="M14 3.8 23.4 7.5v4.6c-5.6.8-13.2.8-18.8 0V7.5Z"/><text class="vpn-text" x="14" y="21" text-anchor="middle">V</text></svg>`;
  topbar.append(shield);

  let state: 'connected' | 'off' | 'error' | null = null;
  const visible = (node: HTMLElement | null): node is HTMLElement =>
    !!node && !node.hidden && node.getClientRects().length > 0;
  const place = () => {
    const mark = topbar.querySelector<HTMLElement>('.brand-wordmark');
    const first = topbar.querySelector<HTMLElement>('.top-actions button');
    if (!state || !visible(mark) || !visible(first)) {
      shield.hidden = true;
      return;
    }
    const m = mark.getBoundingClientRect();
    const f = first.getBoundingClientRect();
    // A small badge: about a third of the wordmark's height (13-20px).
    const size = Math.round(Math.min(20, Math.max(13, m.height * 0.37)));
    const width = (size * 28) / 32;
    const clear = m.left + m.width * SCRIPT_END + width / 2 + 2;
    const centre = Math.max((m.left + m.width * TAGLINE_END + f.left) / 2, clear);
    // No room beside the library buttons (or they wrapped below): step aside.
    if (centre + width / 2 > f.left - 4 || f.top >= m.bottom) {
      shield.hidden = true;
      return;
    }
    shield.style.setProperty('--vpn-size', `${size}px`);
    shield.style.left = `${centre}px`;
    shield.style.top = `${m.top + m.height * SHIELD_ROW}px`;
    shield.hidden = false;
  };
  const show = (next: typeof state, label: string) => {
    state = next;
    if (next) shield.dataset.state = next;
    shield.setAttribute('aria-label', label);
    shield.title = label;
    place();
  };

  let generation = 0;
  let disposed = false;
  const check = async () => {
    if (disposed || document.hidden) return;
    const mine = ++generation;
    try {
      const status = await source.read();
      if (disposed || mine !== generation) return;
      if (status.connected)
        show('connected', `VPN connected${status.name ? ` · ${status.name}` : ''}`);
      else show('off', 'No VPN connected');
    } catch {
      if (disposed || mine !== generation) return;
      show('error', 'VPN status could not be checked');
    }
  };
  const timer = every(() => void check(), POLL_MS);
  const recheck = () => void check();
  const visibility = () => {
    if (!document.hidden) void check();
  };
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('online', recheck);
  window.addEventListener('offline', recheck);
  const layout = new ResizeObserver(() => place());
  layout.observe(topbar);
  window.addEventListener('resize', place);
  void check();
  return () => {
    if (disposed) return;
    disposed = true;
    generation++;
    stop(timer);
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('online', recheck);
    window.removeEventListener('offline', recheck);
    window.removeEventListener('resize', place);
    layout.disconnect();
    shield.remove();
  };
}
