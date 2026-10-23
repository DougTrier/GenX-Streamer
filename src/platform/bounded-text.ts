/** Match native UTF-8 byte limits without allocating encoded copies for large catalogs. */
export function boundedUtf8Text(
  value: unknown,
  limit: number,
  allowEmpty = false,
): value is string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > limit)
    return false;
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes++;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(++index);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
      bytes += 4;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
    else bytes += 3;
    if (bytes > limit) return false;
  }
  return true;
}
