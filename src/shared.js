/**
 * @file Shared helpers for every part of The Eyes of Argus.
 *
 * Loaded first in every context:
 * - the YouTube content script (`manifest.content_scripts`),
 * - the background (Firefox event page via `background.scripts`, Chromium service
 *   worker via `importScripts`),
 * - the settings page (`<script>` tag),
 * - the Cloudflare Worker (`import '../../src/shared.js'`), so that client and server
 *   agree on what a valid channel key is and how proof-of-work is checked.
 *
 * Nothing here touches the DOM or extension APIs, so it is safe in all of them.
 * Everything is exposed on one frozen global, `globalThis.Argus`.
 */
(function (root) {
  'use strict';

  /**
   * The two things a channel can be marked as.
   * @type {ReadonlyArray<'ai'|'pe'>}
   */
  const FLAGS = Object.freeze(['ai', 'pe']);

  /**
   * Message types exchanged between the extension's parts. The background is the
   * only part that writes marks, the vote queue and sync settings; the content script
   * and the settings page ask it to through these messages.
   * @enum {string}
   */
  const MSG = Object.freeze({
    /** background → content: a context-menu item was clicked `{action}` */
    MENU: 'argus-menu',
    /** content/options → background: change one channel `{key, name, uc, changes}` */
    MARK: 'argus-mark',
    /** options → background: merge an exported/shared file `{data}` */
    IMPORT: 'argus-import',
    /** options → background: delete all of your marks */
    WIPE: 'argus-wipe',
    /** options → background: turn sync on/off or change server `{enabled, server, withdraw}` */
    SYNC_CONFIG: 'argus-sync-config',
    /** options → background: sync right now */
    SYNC_NOW: 'argus-sync-now',
    /** options → background: (re)download the subscribed shared list */
    UPDATE_LIST: 'argus-update-list',
  });

  /** Tunables that client and server must agree on. */
  const LIMITS = Object.freeze({
    /** Highest proof-of-work difficulty the extension will ever attempt. */
    POW_MAX_BITS: 22,
    /** Votes per request to `/votes`. */
    MAX_BATCH: 100,
    /** Longest channel name stored or sent. */
    MAX_NAME: 100,
    /** Largest request body the server reads, in bytes. */
    MAX_BODY: 64 * 1024,
  });

  // YouTube handles: letters/digits of any script plus . _ - and middle dot. YouTube
  // allows 3–30 characters; 1–100 are accepted so unusual or legacy handles still work.
  // Control, format (zero-width) and whitespace characters are rejected.
  const HANDLE_RE = /^@[\p{L}\p{N}\p{M}._\-·]{1,100}$/u;
  const UC_RE = /^UC[\w-]{22}$/;

  /**
   * Keys outside YouTube carry a platform prefix: `x:handle`, `reddit:u/name`,
   * `reddit:r/sub`, `instagram:handle`, `tiktok:handle`, `twitch:name`, `facebook:name`
   * and `site:example.com` (a website, as marked from a search result). The part after
   * the prefix is always lowercase. YouTube keys keep their original unprefixed form
   * (`@handle`, `UC…`) so marks made by earlier versions stay valid.
   * @type {Object<string, {re: RegExp, label: string, url: function(string): string}>}
   */
  const PLATFORMS = Object.freeze({
    x:         { re: /^[a-z0-9_]{1,15}$/, label: 'X', url: id => `https://x.com/${id}` },
    reddit:    { re: /^(u\/[a-z0-9_-]{3,20}|r\/[a-z0-9_]{2,21})$/, label: 'Reddit', url: id => `https://www.reddit.com/${id.startsWith('u/') ? 'user/' + id.slice(2) : id}` },
    instagram: { re: /^(?=.{1,30}$)[a-z0-9_](?:[a-z0-9._]*[a-z0-9_])?$/, label: 'Instagram', url: id => `https://www.instagram.com/${id}/` },
    tiktok:    { re: /^(?=.{2,24}$)[a-z0-9_](?:[a-z0-9._]*[a-z0-9_])?$/, label: 'TikTok', url: id => `https://www.tiktok.com/@${id}` },
    twitch:    { re: /^[a-z0-9_]{3,25}$/, label: 'Twitch', url: id => `https://www.twitch.tv/${id}` },
    facebook:  { re: /^(?=.{1,60}$)[a-z0-9](?:[a-z0-9.]*[a-z0-9])?$/, label: 'Facebook', url: id => (/^\d+$/.test(id) ? `https://www.facebook.com/profile.php?id=${id}` : `https://www.facebook.com/${id}`) },
    site:      { re: /^(?=.{4,100}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/, label: 'Website', url: id => `https://${id}/` },
  });

  /**
   * Turns page, user or network input into a canonical key, or null if invalid.
   *
   * YouTube handles are percent-decoded, Unicode-normalized (NFC) and lowercased, so
   * `/@%C3%89cole`, `@École` and `@école` are all `@école`. `UC…` ids are
   * case-sensitive and returned unchanged. Prefixed keys (see {@link PLATFORMS}) are
   * lowercased and checked against their platform's pattern.
   *
   * @param {unknown} k
   * @returns {string|null} e.g. `"@nileblue"`, `"UCxxxxxxxxxxxxxxxxxxxxxx"`, `"x:nasa"`, `"site:example.com"`
   */
  function normalizeKey(k) {
    if (typeof k !== 'string') return null;
    let t = k.trim();
    if (UC_RE.test(t)) return t;
    if (!t.startsWith('@')) {
      const i = t.indexOf(':');
      if (i < 1 || t.length > 120) return null;
      const prefix = t.slice(0, i).toLowerCase(), id = t.slice(i + 1).toLowerCase();
      return Object.hasOwn(PLATFORMS, prefix) && PLATFORMS[prefix].re.test(id) ? `${prefix}:${id}` : null;
    }
    if (t.includes('%')) {
      try { t = decodeURIComponent(t); } catch { return null; }
    }
    t = t.normalize('NFC').toLowerCase();
    return HANDLE_RE.test(t) ? t : null;
  }

  /**
   * @param {unknown} k
   * @returns {boolean} true for a canonical `UC…` channel id
   */
  function isChannelId(k) {
    return typeof k === 'string' && UC_RE.test(k);
  }

  /**
   * The platform a canonical key belongs to.
   * @param {string} key
   * @returns {string} `"youtube"` or a {@link PLATFORMS} prefix
   */
  function platformOf(key) {
    const i = key.indexOf(':');
    return i > 0 ? key.slice(0, i) : 'youtube';
  }

  /**
   * Human-readable platform name for a key, e.g. `"YouTube"`, `"Website"`.
   * @param {string} key
   * @returns {string}
   */
  function labelForKey(key) {
    return PLATFORMS[platformOf(key)]?.label || 'YouTube';
  }

  /**
   * The public address of the thing a key stands for.
   * @param {string} key canonical key
   * @returns {string}
   */
  function urlForKey(key) {
    const p = PLATFORMS[platformOf(key)];
    if (p) return p.url(key.slice(key.indexOf(':') + 1));
    return key.startsWith('@') ? `https://www.youtube.com/${key}` : `https://www.youtube.com/channel/${key}`;
  }

  /**
   * The `site:` key for a web address (as used for search results): the hostname
   * without a leading `www.`. Only http(s) addresses qualify.
   * @param {string} url absolute URL
   * @returns {string|null} e.g. `"site:example.com"`
   */
  function siteKey(url) {
    let u;
    try { u = new URL(url); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return normalizeKey('site:' + u.hostname.replace(/^www\./, '').replace(/\.$/, ''));
  }

  /**
   * Extracts the channel key from a YouTube link (relative or absolute).
   * Links to other sites, videos, playlists etc. give null.
   * @param {string|null|undefined} href
   * @returns {string|null}
   */
  function keyFromHref(href) {
    if (!href) return null;
    let u;
    try { u = new URL(href, 'https://www.youtube.com'); } catch { return null; }
    if (!/(^|\.)youtube\.com$/.test(u.hostname)) return null;
    let m = u.pathname.match(/^\/(@[^/?#]+)/);
    if (m) return normalizeKey(m[1]);
    m = u.pathname.match(/^\/channel\/(UC[\w-]{22})(?:[/?#]|$)/);
    return m ? m[1] : null;
  }

  /**
   * Reads a stored flag as a vote: 1 = yes, -1 = "not" (you disagree), 0 = no opinion.
   * Version 0.1 stored booleans, so `true` still means yes.
   * @param {unknown} x
   * @returns {number}
   */
  function val(x) {
    if (x === true || x === 1) return 1;
    if (x === -1) return -1;
    return 0;
  }

  /**
   * Cleans a channel display name: strips control/format characters, trims, caps length.
   * @param {unknown} s
   * @returns {string} possibly empty
   */
  function cleanName(s) {
    if (typeof s !== 'string') return '';
    return s.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, LIMITS.MAX_NAME);
  }

  /**
   * Validates a sync-server address and returns its canonical base (origin + path,
   * no trailing slash, no query or hash), or null. Only https is accepted, except
   * http on localhost / 127.0.0.1 for running the server locally.
   * @param {unknown} url
   * @returns {string|null} e.g. `"https://argus.example.workers.dev"`
   */
  function serverBase(url) {
    if (typeof url !== 'string') return null;
    let u;
    try { u = new URL(url.trim()); } catch { return null; }
    const local = u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname);
    if (u.protocol !== 'https:' && !local) return null;
    return u.origin + u.pathname.replace(/\/+$/, '');
  }

  /**
   * Key of one entry in the vote queue: one pending vote per channel and flag.
   * @param {string} k channel key
   * @param {string} f flag
   * @returns {string} e.g. `"@nileblue|ai"`
   */
  function queueKey(k, f) {
    return `${k}|${f}`;
  }

  /**
   * Checks one community-list entry: `[aiPct, aiVotes, pePct, peVotes, name?, overrideBits?]`.
   * @param {unknown} e
   * @returns {boolean}
   */
  function isCommunityEntry(e) {
    if (!Array.isArray(e) || e.length < 4 || e.length > 6) return false;
    for (let i = 0; i < 4; i++) if (!Number.isInteger(e[i]) || e[i] < 0 || e[i] > 1e9) return false;
    if (e.length > 4 && typeof e[4] !== 'string') return false;
    if (e.length > 5 && !(Number.isInteger(e[5]) && e[5] >= 0 && e[5] <= 3)) return false;
    return true;
  }

  /**
   * @param {ArrayBuffer|Uint8Array} buf
   * @returns {string} lowercase hex
   */
  function toHex(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (const b of bytes) s += b.toString(16).padStart(2, '0');
    return s;
  }

  /**
   * SHA-256 of a UTF-8 string, as hex. Uses WebCrypto (browsers, Workers, Node 20+).
   * @param {string} s
   * @returns {Promise<string>}
   */
  async function sha256hex(s) {
    return toHex(await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  }

  /**
   * Number of leading zero bits in a hex string (proof-of-work difficulty check).
   * @param {string} hex
   * @returns {number}
   */
  function zeroBits(hex) {
    let bits = 0;
    for (const ch of hex) {
      const v = parseInt(ch, 16);
      if (v === 0) { bits += 4; continue; }
      return bits + Math.clz32(v) - 28;
    }
    return bits;
  }

  root.Argus = Object.freeze({
    FLAGS, MSG, LIMITS,
    normalizeKey, isChannelId, keyFromHref, platformOf, labelForKey, urlForKey, siteKey, val, cleanName, serverBase, queueKey,
    isCommunityEntry, toHex, sha256hex, zeroBits,
  });
})(globalThis);
