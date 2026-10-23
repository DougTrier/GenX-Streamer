/** Parse only explicit known requested system-bar representations. Missing baseline is unknown. */
export function parseRequestedBars(line) {
  if (typeof line !== 'string' || line.length > 1024) return null;
  const numericMarkers = [...line.matchAll(/mRequestedVisibleTypes\s*=/gi)];
  const formMarkers = [...line.matchAll(/mRequestedVisibilities:|Requested visibilities:/g)];
  if (numericMarkers.length) {
    if (numericMarkers.length !== 1 || formMarkers.length) return null;
    const numeric = /mRequestedVisibleTypes=(0x[0-9a-f]+|\d+)(?=$|[\s,}])/i.exec(line);
    if (!numeric) return null;
    const bits = Number(numeric[1]);
    if (!Number.isSafeInteger(bits) || bits < 0 || bits > 0xffffffff) return null;
    return { statusVisible: !!(bits & 1), navigationVisible: !!(bits & 2) };
  }
  if (formMarkers.length !== 1) return null;
  const values = (type) => [
    ...line.matchAll(
      new RegExp(`(?:${type})\\s*[:=]\\s*(true|false|visible|invisible)(?=$|[\\s,}])`, 'g'),
    ),
  ];
  const status = values('ITYPE_STATUS_BAR|statusBars');
  const navigation = values('ITYPE_NAVIGATION_BAR|navigationBars');
  if (status.length !== 1 || navigation.length !== 1) return null;
  const visible = (value) => value === 'true' || value === 'visible';
  return { statusVisible: visible(status[0][1]), navigationVisible: visible(navigation[0][1]) };
}
