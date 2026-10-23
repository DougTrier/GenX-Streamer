(() => {
  // Low-memory TVs only (PageController): sites are told VP9 and AV1 do not
  // play, so they send H.264, which the TV decodes in far less memory.
  const other = (type) => /vp0?9|av01|av1/i.test(String(type));
  const source = window.MediaSource;
  if (source?.isTypeSupported) {
    const supported = source.isTypeSupported.bind(source);
    source.isTypeSupported = (type) => !other(type) && supported(type);
  }
  const capabilities = navigator.mediaCapabilities;
  if (capabilities?.decodingInfo) {
    const decoding = capabilities.decodingInfo.bind(capabilities);
    capabilities.decodingInfo = (config) =>
      other(config?.video?.contentType)
        ? Promise.resolve({ supported: false, smooth: false, powerEfficient: false })
        : decoding(config);
  }
  const canPlay = HTMLMediaElement.prototype.canPlayType;
  HTMLMediaElement.prototype.canPlayType = function (type) {
    return other(type) ? '' : canPlay.call(this, type);
  };
})();
