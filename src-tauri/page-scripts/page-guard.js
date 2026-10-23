// Windows station pages are a viewer, not a browser: no right-click menu
// (Save as, Print, Inspect) and no save/print/open/view-source shortcuts.
(() => {
  addEventListener('contextmenu', (event) => event.preventDefault(), true);
  addEventListener(
    'keydown',
    (event) => {
      if ((event.ctrlKey || event.metaKey) && ['s', 'p', 'o', 'u'].includes(event.key.toLowerCase()))
        event.preventDefault();
    },
    true,
  );
})();
