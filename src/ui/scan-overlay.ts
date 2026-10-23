/**
 * Upright phones (owner's idea, October 18, 2026): while nothing plays, the
 * channel scan's progress and buttons float at the top left of the picture
 * panel instead of sitting in the channel list. When something plays, or on
 * wider layouts, the panel stays in the channel list as before.
 */
export function mountScanOverlay(app: HTMLElement): () => void {
  const scan = app.querySelector<HTMLElement>('#inline-source-scan');
  const screen = app.querySelector<HTMLElement>('#screen');
  if (!scan || !screen) return () => undefined;
  const portrait = window.matchMedia('(max-width: 650px) and (orientation: portrait)');
  let frame = 0;
  const clear = () => {
    if (scan.dataset.floating !== 'true') return;
    delete scan.dataset.floating;
    for (const property of ['top', 'left', 'max-width', 'max-height'])
      scan.style.removeProperty(property);
  };
  const place = () => {
    frame = 0;
    const floating =
      portrait.matches &&
      !scan.hidden &&
      app.dataset.playerIdle === 'true' &&
      !app.classList.contains('compact-content') &&
      !app.classList.contains('viewing-fullscreen') &&
      app.dataset.guidePanel !== 'open' &&
      screen.getClientRects().length > 0;
    if (!floating) {
      clear();
      return;
    }
    scan.dataset.floating = 'true';
    // Absolute within whatever box holds the panel, measured from the picture.
    const parent = (scan.offsetParent as HTMLElement | null) ?? document.body;
    const base = parent.getBoundingClientRect();
    const picture = screen.getBoundingClientRect();
    scan.style.top = `${Math.round(picture.top - base.top + parent.scrollTop + 8)}px`;
    scan.style.left = `${Math.round(picture.left - base.left + parent.scrollLeft + 8)}px`;
    scan.style.maxWidth = `${Math.max(0, Math.round(picture.width - 16))}px`;
    scan.style.maxHeight = `${Math.max(0, Math.round(picture.height - 16))}px`;
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(place);
  };
  const sizes = new ResizeObserver(schedule);
  sizes.observe(screen);
  sizes.observe(app);
  const changes = new MutationObserver(schedule);
  changes.observe(scan, { attributes: true, attributeFilter: ['hidden'] });
  changes.observe(app, {
    attributes: true,
    attributeFilter: ['class', 'data-player-idle', 'data-guide-panel'],
  });
  portrait.addEventListener('change', schedule);
  schedule();
  return () => {
    if (frame) cancelAnimationFrame(frame);
    sizes.disconnect();
    changes.disconnect();
    portrait.removeEventListener('change', schedule);
    clear();
  };
}
