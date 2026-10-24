/*
 * Copyright 2026 Doug Trier
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
 * Share links (docs/share-links.md): what a "Watch News 24 on GenX Streamer"
 * link carries, how it is built and how an incoming one is checked.
 *
 * A link carries only a channel's name, logo address and public stream
 * address, or a GenXtra title's reference and name: nothing about the sender,
 * their device, network or accounts. The details travel in the address's
 * fragment (after #), which browsers never send to the web page's server.
 *
 * Paid TV is never shared: its stream addresses hold the account's user name
 * and password. The builder refuses any address that looks like an account's
 * (credentials in the address, account-style paths or query fields), and an
 * incoming link is held to the same rules, so a crafted link cannot carry one
 * either. Incoming links are untrusted: every field is checked here, names are
 * shown as text, and the native layer checks the stream's server is public
 * before anything is fetched (check_shared_destination).
 */

/** The web page a link opens when GenX Streamer is not installed (site/watch/). */
export const SHARE_PAGE = 'https://dougtrier.github.io/GenX-Streamer/watch/';
/** The app's own scheme: opens GenX Streamer directly (Windows, and Android's fallback). */
export const APP_SCHEME = 'genx';
/** Where people get GenX Streamer (the repository is private until the owner publishes it). */
export const DOWNLOAD_PAGE = 'https://github.com/DougTrier/GenX-Streamer/releases/latest';

const PAGE_HOST = 'dougtrier.github.io';
const PAGE_PATHS = new Set([
  '/GenX-Streamer/watch',
  '/GenX-Streamer/watch/',
  '/GenX-Streamer/watch/index.html',
]);
export const LIMITS = { link: 6000, address: 2048, name: 120 } as const;

export type SharedItem =
  | { kind: 'channel'; name: string; stream: string; logo: string | null }
  | { kind: 'title'; name: string; titleRef: string };

export type ShareRefusal =
  | 'share-name-invalid'
  | 'share-stream-invalid'
  | 'share-stream-private'
  | 'share-stream-account'
  | 'share-title-invalid'
  | 'share-link-invalid'
  | 'share-link-version';

export class ShareLinkError extends Error {
  constructor(readonly code: ShareRefusal) {
    super(code);
    this.name = 'ShareLinkError';
  }
}

// Bidirectional overrides and isolates could make a name read as something else.
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu;

/** A display name: visible characters only, single spaces, 1–120 characters. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 4 * LIMITS.name)
    throw new ShareLinkError('share-name-invalid');
  const name = raw.normalize('NFC').replace(HIDDEN, ' ').replace(/\s+/gu, ' ').trim();
  if (!name || [...name].length > LIMITS.name) throw new ShareLinkError('share-name-invalid');
  return name;
}

/** Query fields that carry an account, a session or a signature, never a public channel. */
const ACCOUNT_FIELDS = new Set([
  'username',
  'user',
  'login',
  'password',
  'pass',
  'passwd',
  'pwd',
  'token',
  'auth',
  'authorization',
  'key',
  'apikey',
  'api_key',
  'access_token',
  'sig',
  'signature',
  'session',
  'sessionid',
  'sid',
  'hdnts',
  'hdnea',
  'jwt',
  'secret',
  'mac',
]);
/** Xtream-style account paths: /live/<user>/<password>/<id>, and its movie, series and catch-up forms. */
const ACCOUNT_PATH = /^\/(?:live|movie|series|timeshift|streaming)\/[^/]+\/[^/]+\/./iu;
/** What a stream address may end in: playlists, transport streams and media files. */
const STREAM_EXTENSION =
  /\.(?:m3u8|m3u|ts|mts|m2ts|mp4|m4v|mov|mkv|webm|mp3|aac|m4a|ogg|oga|opus|flac)$/iu;

/**
 * A host GenX will not contact for a shared link: names that only exist on a
 * local network, and private, loopback, link-local, shared and reserved
 * addresses written out as numbers. The native check repeats this for the
 * addresses a name resolves to.
 */
export function privateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, '');
  if (!host || !host.includes('.') || host.startsWith('[')) {
    if (!host.startsWith('[')) return true;
    const v6 = host.slice(1, -1);
    // Only global unicast (2000::/3) is public; mapped IPv4 and every local range are not.
    return !/^[23][0-9a-f]{0,3}:/u.test(v6) || /^2001:(?:db8|0{0,4}):/u.test(v6);
  }
  if (
    /(?:^|\.)(?:localhost|local|lan|home|internal|intranet|corp|private|localdomain|test|invalid|example)$/u.test(
      host,
    ) ||
    host.endsWith('.home.arpa')
  )
    return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (!v4) return /^[\d.]+$/u.test(host);
  const [a, b, c] = v4.slice(1).map(Number) as [number, number, number, number];
  if (v4.slice(1).some((part) => Number(part) > 255)) return true;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function address(raw: unknown, schemes: readonly string[]): URL | null {
  if (typeof raw !== 'string' || !raw || raw.length > LIMITS.address) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/u.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!schemes.includes(url.protocol) || !url.hostname || url.href.length > LIMITS.address)
    return null;
  return url;
}

/** A public stream address a link may carry, normalized; throws the reason it may not. */
export function shareableStream(raw: unknown): string {
  const url = address(raw, ['http:', 'https:']);
  if (!url) throw new ShareLinkError('share-stream-invalid');
  if (url.username || url.password || ACCOUNT_PATH.test(url.pathname))
    throw new ShareLinkError('share-stream-account');
  for (const field of url.searchParams.keys())
    if (ACCOUNT_FIELDS.has(field.toLowerCase())) throw new ShareLinkError('share-stream-account');
  if (privateHost(url.hostname)) throw new ShareLinkError('share-stream-private');
  const last = url.pathname.split('/').pop() ?? '';
  if (last.includes('.') && !STREAM_EXTENSION.test(last))
    throw new ShareLinkError('share-stream-invalid');
  url.hash = '';
  return url.href;
}

/** A logo address a link may carry (https, public, no credentials), or null. */
export function shareableLogo(raw: unknown): string | null {
  const url = address(raw, ['https:']);
  if (!url || url.username || url.password || url.port || privateHost(url.hostname)) return null;
  url.hash = '';
  return url.href;
}

/** A GenXtra title reference: the 64-character fingerprint of its archive item. */
export function titleReference(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/u.test(raw))
    throw new ShareLinkError('share-title-invalid');
  return raw;
}

function fields(item: SharedItem): URLSearchParams {
  const params = new URLSearchParams({ v: '1' });
  if (item.kind === 'channel') {
    params.set('c', 'ch');
    params.set('n', cleanName(item.name));
    params.set('s', shareableStream(item.stream));
    const logo = item.logo === null ? null : shareableLogo(item.logo);
    if (logo) params.set('l', logo);
  } else {
    params.set('c', 'gx');
    params.set('n', cleanName(item.name));
    params.set('t', titleReference(item.titleRef));
  }
  return params;
}

export interface ShareMessage {
  /** The https link: opens GenX Streamer where it is installed, the web page elsewhere. */
  link: string;
  /** The app-scheme link, for the web page's "Open in GenX Streamer". */
  appLink: string;
  title: string;
  text: string;
}

/** The link and message for something being watched; throws ShareLinkError when it may not be shared. */
export function buildShareMessage(item: SharedItem): ShareMessage {
  const params = fields(item).toString();
  const link = `${SHARE_PAGE}#${params}`;
  if (link.length > LIMITS.link) throw new ShareLinkError('share-link-invalid');
  const name = cleanName(item.name);
  return {
    link,
    appLink: `${APP_SCHEME}://watch?${params}`,
    title: name,
    text: `Watch ${name} on GenX Streamer: ${link}`,
  };
}

const KNOWN = new Set(['v', 'c', 'n', 's', 'l', 't']);

/** Reads an incoming link (https page link or genx://); throws ShareLinkError when it is not a valid one. */
export function parseShareLink(raw: unknown): SharedItem {
  if (typeof raw !== 'string' || !raw || raw.length > LIMITS.link)
    throw new ShareLinkError('share-link-invalid');
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ShareLinkError('share-link-invalid');
  }
  if (url.username || url.password || url.port) throw new ShareLinkError('share-link-invalid');
  if (url.protocol === `${APP_SCHEME}:`) {
    if (url.hostname !== 'watch' || !['', '/'].includes(url.pathname))
      throw new ShareLinkError('share-link-invalid');
  } else if (url.protocol === 'https:') {
    if (url.hostname !== PAGE_HOST || !PAGE_PATHS.has(url.pathname))
      throw new ShareLinkError('share-link-invalid');
  } else throw new ShareLinkError('share-link-invalid');
  const text = url.hash.length > 1 ? url.hash.slice(1) : url.search.slice(1);
  const params = new URLSearchParams(text);
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!KNOWN.has(key) || seen.has(key)) throw new ShareLinkError('share-link-invalid');
    seen.add(key);
  }
  if (params.get('v') !== '1') throw new ShareLinkError('share-link-version');
  const name = cleanName(params.get('n'));
  if (params.get('c') === 'ch' && !params.has('t'))
    return {
      kind: 'channel',
      name,
      stream: shareableStream(params.get('s')),
      logo: params.has('l') ? shareableLogo(params.get('l')) : null,
    };
  if (params.get('c') === 'gx' && !params.has('s') && !params.has('l'))
    return { kind: 'title', name, titleRef: titleReference(params.get('t')) };
  throw new ShareLinkError('share-link-invalid');
}

/** What the viewer is told when a link cannot be used: plain, truthful, no internals. */
export function shareRefusalMessage(code: ShareRefusal | string): string {
  switch (code) {
    case 'share-stream-account':
      return 'This channel cannot be shared: its address belongs to an account. Paid TV channels are never shared.';
    case 'share-stream-private':
      return 'This link points to a private or local network address, so GenX Streamer will not open it.';
    case 'share-link-version':
      return 'This link was made by a newer GenX Streamer. Update GenX Streamer to open it.';
    case 'share-name-invalid':
    case 'share-stream-invalid':
    case 'share-title-invalid':
    case 'share-link-invalid':
    default:
      return 'This link is not a valid GenX Streamer share link.';
  }
}
