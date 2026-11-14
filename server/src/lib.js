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
 * Technical settings from `wrangler.toml` `[vars]`, with safe defaults. The vote rules
 * are not here: they are edited in the moderation dashboard (see {@link RULE_DEFAULTS}).
 * @param {Object} env Worker environment
 */
export function cfg(env) {
  return {
    powBits: Math.min(num(env.POW_BITS, 18), A.LIMITS.POW_MAX_BITS),
    votesPerDay: num(env.VOTES_PER_DAY, 1000),
    votesPerNetDay: num(env.VOTES_PER_NET_DAY, 5000),
    regPerNetDay: num(env.REG_PER_NET_DAY, 5),
    maxPerRun: Math.min(num(env.MAX_PER_RUN, 900), 1800), // free plan: 50 queries and 10 ms CPU per run
  };
}

/**
 * Vote rules and their allowed ranges. Stored in the `settings` table once changed in
 * the dashboard; these are the values used until then.
 *
 * A mark shows for everyone when it has at least `minVotes` "yes" votes and the "not"
 * votes don't outnumber them by more than `notFactor` to one. With the defaults
 * (1 and 2): one vote marks, and a mark with 2 yes votes needs 5 "not" votes to go.
 */
export const RULE_DEFAULTS = Object.freeze({ minVotes: 1, notFactor: 2, warmupDays: 0, maxPerNet: 2 });
const RULE_RANGES = { minVotes: [1, 1000], notFactor: [0.5, 100], warmupDays: [0, 30], maxPerNet: [1, 100] };

/**
 * Merges stored or submitted rule values over the defaults, dropping anything out of range.
 * @param {Object} raw e.g. `{minVotes: "3"}`
 * @returns {{minVotes: number, notFactor: number, warmupDays: number, maxPerNet: number}}
 */
export function cleanRules(raw) {
  const out = { ...RULE_DEFAULTS };
  for (const [k, [lo, hi]] of Object.entries(RULE_RANGES)) {
    const v = Number(raw?.[k]);
    if (raw?.[k] !== undefined && raw[k] !== '' && Number.isFinite(v) && v >= lo && v <= hi) out[k] = k === 'notFactor' ? v : Math.round(v);
  }
  return out;
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
  const g = expandV6(s.replace(/%.*$/, '')); // drop a zone id like %eth0
  return g ? `${g[0]}:${g[1]}:${g[2]}:${g[3].slice(0, 2)}::/56` : s; // unparsable: its own bucket
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
  const bytes = await req.arrayBuffer(); // bytes, not characters: multi-byte text can't slip past
  if (bytes.byteLength > max) return { ok: false, status: 413, error: 'body too large' };
  try { return { ok: true, body: JSON.parse(new TextDecoder().decode(bytes)) }; } catch { return { ok: false, status: 400, error: 'invalid JSON' }; }
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
 * Applies the vote rules to one flag of one channel.
 * @param {Object} [r] weighted tally `{up, down, n}`
 * @param {number|null} [o] moderator override: 1 always show, 0 never show
 * @param {{minVotes: number, notFactor: number}} rules
 * @returns {{shown: boolean, forced: boolean, pct: number, votes: number, up: number, down: number, n: number}}
 */
export function scoreFlag(r, o, rules) {
  const up = r?.up || 0, down = r?.down || 0, n = r?.n || 0;
  const pct = up + down > 0 ? Math.round((100 * up) / (up + down)) : 0;
  // "not" votes need more than notFactor times the yes votes to remove a mark
  let shown = up >= rules.minVotes && down <= (rules.notFactor ?? RULE_DEFAULTS.notFactor) * up;
  const forced = o === 1;
  if (forced) shown = true;
  if (o === 0) shown = false;
  return { shown, forced, pct: shown ? Math.max(pct, forced && !pct ? 100 : 1) : 0, votes: Math.round(up + down), up, down, n };
}

/**
 * Turns one channel's tallies into what is published and what the dashboard shows.
 * @param {Object} t per flag `{up, down, n}`
 * @param {Object} [ov] moderator overrides per flag
 * @param {Object} rules vote rules
 * @param {string[]} [ids] every category id (the first two are the built-in ones)
 * @returns {{entry: ?Array, extra: ?Object, tally: Object, total: number}}
 *   `entry`: `[aiPct, aiVotes, pePct, peVotes, "", overrideBits?]` or null;
 *   `extra`: `{<id>: [pct, votes]}` for other categories that are shown, or null;
 *   `tally`: `{<id>: [yes, no, shown]}` for the dashboard
 */
export function score(t, ov, rules, ids = A.FLAGS) {
  const tally = {};
  const out = [];
  let extra = null, overrides = 0, total = 0;
  for (const id of ids) {
    const s = scoreFlag(t?.[id], ov?.[id], rules);
    total += s.n;
    if (s.n || s.shown) tally[id] = [s.up, s.down, s.shown ? 1 : 0];
    const builtin = A.FLAGS.indexOf(id);
    if (builtin >= 0) {
      out[builtin * 2] = s.pct; out[builtin * 2 + 1] = s.votes;
      if (s.forced) overrides |= 1 << builtin;
    } else if (s.shown) {
      (extra ||= {})[id] = [s.pct, s.votes];
    }
  }
  let entry = null;
  if (out[0] || out[2]) {
    entry = [out[0] || 0, out[1] || 0, out[2] || 0, out[3] || 0, '']; // fifth slot kept for older extensions; names are never published
    if (overrides) entry.push(overrides);
  }
  return { entry, extra, tally, total };
}

/**
 * JSON response.
 * @param {any} data
 * @param {number} [status]
 * @param {Object} [headers]
 * @returns {Response}
 */
export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
