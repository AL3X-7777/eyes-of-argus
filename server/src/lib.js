/**
 * @file Pure helpers for the sync server (no Cloudflare bindings), so they can be
 * unit-tested in Node.
 */
import '../../src/shared.js';

/** Shared client/server helpers (key validation, hashing). */
export const A = globalThis.Argus;

/** Milliseconds in a day. */
export const DAY = 86400e3;

/**
 * @param {unknown} v
 * @param {number} d default
 * @returns {number}
 */
const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(+v) ? +v : d);

/**
 * Server settings from `wrangler.toml` `[vars]`, with safe defaults.
 * @param {Object} env Worker environment
 */
export function cfg(env) {
  return {
    powBits: Math.min(num(env.POW_BITS, 18), A.LIMITS.POW_MAX_BITS),
    minVotes: num(env.MIN_VOTES, 15),
    minAgree: num(env.MIN_AGREE, 70),
    warmupMs: num(env.WARMUP_DAYS, 3) * DAY,
    maxPerNet: num(env.MAX_PER_NET, 2),
    votesPerDay: num(env.VOTES_PER_DAY, 1000),
    votesPerNetDay: num(env.VOTES_PER_NET_DAY, 5000),
    regPerNetDay: num(env.REG_PER_NET_DAY, 5),
    maxPerRun: num(env.MAX_PER_RUN, 1800),
  };
}

/**
 * Expands an IPv6 address to 8 groups of 4 hex digits.
 * @param {string} ip
 * @returns {string[]|null}
 */
function expandV6(ip) {
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = ip.includes('::') && tail ? tail.split(':') : [];
  const fill = ip.includes('::') ? 8 - h.length - t.length : 0;
  const all = [...h, ...Array(Math.max(fill, 0)).fill('0'), ...t];
  if (all.length !== 8 || !all.every(g => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  return all.map(g => g.toLowerCase().padStart(4, '0'));
}

/**
 * The "network" an address belongs to, for rate limits: the full IPv4 address, or the
 * /56 prefix of an IPv6 address (one home connection usually gets a /56 or /64, so
 * hashing the full IPv6 address would give one user endless "networks").
 * @param {string} ip
 * @returns {string}
 */
export function netOf(ip) {
  const s = String(ip || '').trim();
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  if (!s.includes(':')) return s || 'unknown';
  const g = expandV6(s);
  return g ? `${g[0]}:${g[1]}:${g[2]}:${g[3].slice(0, 2)}::/56` : 'unknown-v6';
}

/**
 * Whether a POST may be processed. Web pages always send an `Origin` header on
 * cross-site requests; only extension origins (or none, e.g. command-line tools) are
 * accepted, so a website can't use its visitors' browsers to register or vote.
 * @param {Request} req
 * @returns {boolean}
 */
export function originAllowed(req) {
  const o = req.headers.get('origin');
  return !o || /^(chrome-extension|moz-extension|safari-web-extension):\/\//.test(o);
}

/**
 * Reads a JSON body: requires `content-type: application/json` (which forces a CORS
 * preflight that web pages can't pass) and refuses bodies over `LIMITS.MAX_BODY`.
 * @param {Request} req
 * @returns {Promise<{ok: true, body: any}|{ok: false, status: number, error: string}>}
 */
export async function readJson(req) {
  if (!(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    return { ok: false, status: 415, error: 'content-type must be application/json' };
  }
  const max = A.LIMITS.MAX_BODY;
  if (Number(req.headers.get('content-length') || 0) > max) return { ok: false, status: 413, error: 'body too large' };
  const text = await req.text();
  if (text.length > max) return { ok: false, status: 413, error: 'body too large' };
  try { return { ok: true, body: JSON.parse(text) }; } catch { return { ok: false, status: 400, error: 'invalid JSON' }; }
}

/**
 * Constant-time string comparison (both sides hashed first, so lengths match).
 * Uses Workers' `crypto.subtle.timingSafeEqual` when available.
 * @param {string} a
 * @param {string} b
 * @returns {Promise<boolean>}
 */
export async function safeEqual(a, b) {
  const enc = s => crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  const [x, y] = await Promise.all([enc(a), enc(b)]);
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(x, y);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}

/**
 * Splits an array into chunks.
 * @template T
 * @param {T[]} arr
 * @param {number} n
 * @returns {T[][]}
 */
export function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * Turns one channel's weighted tally into its community entry.
 * @param {Object} t per flag `{up, down, n}` (weighted up/down, raw count)
 * @param {Object} [ov] admin override (1 show, 0 hide)
 * @param {string} name
 * @param {{minVotes: number, minAgree: number}} c
 * @returns {{entry: Array|null, raw: Object, total: number}} entry null = not shown
 */
export function score(t, ov, name, c) {
  const out = [];
  const raw = {};
  let overrides = 0, total = 0;
  A.FLAGS.forEach((f, i) => {
    const r = t?.[f] || {};
    const up = r.up || 0, down = r.down || 0, n = r.n || 0;
    total += n;
    const pct = up + down > 0 ? Math.round((100 * up) / (up + down)) : 0;
    raw[f] = { pct, n };
    let shown = up + down >= c.minVotes && pct >= c.minAgree;
    if (ov?.[f] === 1) { shown = true; overrides |= 1 << i; }
    if (ov?.[f] === 0) shown = false;
    out.push(shown ? Math.max(pct, ov?.[f] === 1 && !pct ? 100 : 1) : 0, n);
  });
  if (!out[0] && !out[2]) return { entry: null, raw, total };
  const entry = [...out, name || ''];
  if (overrides) entry.push(overrides);
  return { entry, raw, total };
}
