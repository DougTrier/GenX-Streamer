// Windows station pages: a site's own full-screen button would take over the
// whole GenX window. GenX's Full screen is the one full-screen control on
// every site, so the page's own requests are refused.
(() => {
  const refuse = function () {
    return Promise.reject(new TypeError("Use GenX's Full screen button."));
  };
  for (const proto of [Element.prototype, HTMLElement.prototype]) {
    proto.requestFullscreen = refuse;
    proto.webkitRequestFullscreen = refuse;
    proto.webkitRequestFullScreen = refuse;
  }
  if (window.HTMLVideoElement) HTMLVideoElement.prototype.webkitEnterFullscreen = refuse;
  for (const name of ['fullscreenEnabled', 'webkitFullscreenEnabled'])
    Object.defineProperty(Document.prototype, name, { get: () => false, configurable: true });
})();
