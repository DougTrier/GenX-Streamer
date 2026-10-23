(() => {
  if (document.getElementById('genx-hide-ads')) return;
  const s = document.createElement('style');
  s.id = 'genx-hide-ads';
  s.textContent = '[id^="google_ads"],[id^="div-gpt-ad"],[id^="taboola"],.trc_related_container,.OUTBRAIN,iframe[src*="doubleclick"],iframe[src*="googlesyndication"],[data-ad-slot],[data-google-query-id],.adsbygoogle{display:none!important}';
  document.documentElement.appendChild(s);
})()
