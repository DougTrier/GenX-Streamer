/** Discovery only: explicit HTML references are candidates, never playback or availability proof. */
export const MAX_DISCOVERY_BYTES = 2 * 1024 * 1024;
export const MAX_DISCOVERY_CANDIDATES = 1000;
export interface DiscoveryCandidate {
  key: string;
  url: string;
  role: 'link' | 'media-candidate';
  label: string;
  mime?: string;
  provenance: { pageUrl: string; responseUrl: string };
}
export interface DiscoveryPage {
  pageUrl: string;
  responseUrl?: string;
  html: string;
}
export interface DiscoveryResult {
  candidates: DiscoveryCandidate[];
  unsupportedReason: string | null;
}
export class DiscoveryInputError extends Error {
  constructor(
    public readonly code:
      'page-url' | 'byte-limit' | 'candidate-limit' | 'malformed-html' | 'field-limit',
  ) {
    super(
      {
        'page-url': 'Choose a complete HTTP or HTTPS page URL without embedded credentials.',
        'byte-limit': 'The supplied page exceeds the 2 MiB discovery limit.',
        'candidate-limit': 'The supplied page exceeds 1,000 distinct discovery candidates.',
        'malformed-html':
          'The supplied page could not be read safely. Choose an explicit source URL instead.',
        'field-limit': 'A supplied page reference exceeds its metadata or URL limits.',
      }[code],
    );
    this.name = 'DiscoveryInputError';
  }
}
const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  nbsp: ' ',
  colon: ':',
  sol: '/',
  period: '.',
};
function entities(value: string, strict = false): string | null {
  let invalid = false;
  const decoded = value.replace(
    /&(#x[\da-f]+|#\d+|[a-z][\da-z]+);/gi,
    (_all: string, key: string) => {
      if (key[0] === '#') {
        const code = Number.parseInt(
          key.slice(key[1]?.toLowerCase() === 'x' ? 2 : 1),
          key[1]?.toLowerCase() === 'x' ? 16 : 10,
        );
        return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
          ? String.fromCodePoint(code)
          : '\uFFFD';
      }
      if (Object.hasOwn(ENTITIES, key)) return ENTITIES[key];
      invalid = true;
      return `&${key};`;
    },
  );
  return strict && invalid ? null : decoded;
}
function webUrl(input: string, base?: string): string | null {
  try {
    const parsed = new URL(input, base);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
      return null;
    parsed.hash = '';
    return parsed.href;
  } catch {
    return null;
  }
}
interface Tag {
  name: string;
  closing: boolean;
  attributes: Map<string, string>;
  end: number;
}
/** Quote-aware finite tokenizer; no document construction, scripts, resource fetches or HTML embedding. */
function tag(html: string, start: number): Tag | null {
  let position = start + 1;
  if (html[position] === '!' || html[position] === '?') return null;
  const closing = html[position] === '/';
  if (closing) position++;
  const matched = /^[a-z][\da-z:-]*/i.exec(html.slice(position));
  if (!matched) return null;
  const name = matched[0].toLowerCase();
  position += matched[0].length;
  const attributes = new Map<string, string>();
  while (position < html.length) {
    while (/\s/.test(html[position] ?? '')) position++;
    if (html[position] === '>') return { name, closing, attributes, end: position + 1 };
    if (html[position] === '/' && html[position + 1] === '>')
      return { name, closing, attributes, end: position + 2 };
    const attr = /^[^\s"'<>/=]+/.exec(html.slice(position));
    if (!attr) throw new DiscoveryInputError('malformed-html');
    const key = attr[0].toLowerCase();
    position += attr[0].length;
    while (/\s/.test(html[position] ?? '')) position++;
    let value = '';
    if (html[position] === '=') {
      position++;
      while (/\s/.test(html[position] ?? '')) position++;
      const quote = html[position];
      if (quote === '"' || quote === "'") {
        const end = html.indexOf(quote, position + 1);
        if (end < 0) throw new DiscoveryInputError('malformed-html');
        value = html.slice(position + 1, end);
        position = end + 1;
      } else {
        const unquoted = /^[^\s>]+/.exec(html.slice(position));
        if (!unquoted) throw new DiscoveryInputError('malformed-html');
        value = unquoted[0];
        position += value.length;
      }
    }
    // HTML takes the first duplicate attribute; later attacker-controlled attributes cannot replace it.
    if (!attributes.has(key)) attributes.set(key, value);
  }
  throw new DiscoveryInputError('malformed-html');
}
export function extractPageCandidates(page: DiscoveryPage): DiscoveryResult {
  if (
    typeof page.html !== 'string' ||
    new TextEncoder().encode(page.html).byteLength > MAX_DISCOVERY_BYTES
  )
    throw new DiscoveryInputError('byte-limit');
  const pageUrl = webUrl(page.pageUrl);
  const responseUrl = webUrl(page.responseUrl ?? page.pageUrl);
  if (!pageUrl || !responseUrl) throw new DiscoveryInputError('page-url');
  const provenance = { pageUrl, responseUrl };
  const candidates: DiscoveryCandidate[] = [];
  const seen = new Set<string>();
  const lower = page.html.toLowerCase();
  const blocked: string[] = [];
  let position = 0;
  let activeAnchor: DiscoveryCandidate | null = null;
  let anchorText = '';
  const finishAnchor = () => {
    if (activeAnchor) {
      if (!activeAnchor.label)
        activeAnchor.label = (entities(anchorText) ?? anchorText).replace(/\s+/g, ' ').trim();
      if (activeAnchor.label.length > 512) throw new DiscoveryInputError('field-limit');
      activeAnchor = null;
      anchorText = '';
    }
  };
  // Deduplication waits for complete link metadata, preserving distinct labels for the same URL.
  const finalize = () => {
    const unique: DiscoveryCandidate[] = [];
    for (const candidate of candidates) {
      const key = JSON.stringify([
        pageUrl,
        responseUrl,
        candidate.url,
        candidate.role,
        candidate.label,
        candidate.mime ?? null,
      ]);
      if (seen.has(key)) continue;
      seen.add(key);
      if (unique.length >= MAX_DISCOVERY_CANDIDATES)
        throw new DiscoveryInputError('candidate-limit');
      unique.push({ ...candidate, key });
    }
    return unique;
  };
  while (position < page.html.length) {
    const open = page.html.indexOf('<', position);
    if (open < 0) {
      if (!blocked.length && activeAnchor) anchorText += page.html.slice(position);
      break;
    }
    if (!blocked.length && activeAnchor) anchorText += page.html.slice(position, open);
    if (page.html.startsWith('<!--', open)) {
      const end = page.html.indexOf('-->', open + 4);
      if (end < 0) throw new DiscoveryInputError('malformed-html');
      position = end + 3;
      continue;
    }
    if (page.html[open + 1] === '!' || page.html[open + 1] === '?') {
      const end = page.html.indexOf('>', open + 2);
      if (end < 0) throw new DiscoveryInputError('malformed-html');
      position = end + 1;
      continue;
    }
    const parsed = tag(page.html, open);
    if (!parsed) {
      position = open + 1;
      continue;
    }
    position = parsed.end;
    if (['script', 'style', 'textarea', 'title'].includes(parsed.name) && !parsed.closing) {
      const close = new RegExp(`</${parsed.name}(?=[\\s>])`, 'g');
      close.lastIndex = position;
      const end = close.exec(lower);
      if (!end) throw new DiscoveryInputError('malformed-html');
      position = end.index;
      continue;
    }
    if (['template', 'iframe', 'object', 'noscript', 'svg', 'math'].includes(parsed.name)) {
      if (!parsed.closing) blocked.push(parsed.name);
      else {
        const index = blocked.lastIndexOf(parsed.name);
        if (index >= 0) blocked.splice(index);
      }
      continue;
    }
    if (blocked.length) continue;
    if (parsed.name === 'a' && parsed.closing) {
      finishAnchor();
      continue;
    }
    if (parsed.closing) continue;
    const role = ['video', 'audio', 'source'].includes(parsed.name)
      ? 'media-candidate'
      : ['a', 'link'].includes(parsed.name)
        ? 'link'
        : null;
    if (!role) continue;
    if (parsed.name === 'a') finishAnchor();
    const raw = parsed.attributes.get(role === 'link' ? 'href' : 'src');
    if (!raw) continue;
    const decoded = entities(raw, true);
    const url = decoded === null ? null : webUrl(decoded, responseUrl);
    if (!url) continue;
    if (url.length > 16384) throw new DiscoveryInputError('field-limit');
    const label = (
      entities(parsed.attributes.get('title') ?? parsed.attributes.get('aria-label') ?? '') ?? ''
    )
      .replace(/\s+/g, ' ')
      .trim();
    if (label.length > 512) throw new DiscoveryInputError('field-limit');
    const mime = parsed.attributes.get('type');
    if (mime && mime.length > 128) throw new DiscoveryInputError('field-limit');
    const candidate: DiscoveryCandidate = {
      key: '',
      url,
      role,
      label,
      provenance: { ...provenance },
      // Author-supplied hint only; format admission requires later response inspection.
      ...(mime ? { mime } : {}),
    };
    candidates.push(candidate);
    if (parsed.name === 'a') activeAnchor = candidate;
  }
  finishAnchor();
  const result = finalize();
  return {
    candidates: result,
    unsupportedReason: result.length
      ? null
      : 'No explicit web or media references were found. This page may require scripts, sign-in or an explicit source URL.',
  };
}
