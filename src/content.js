/**
 * @file Content script of The Eyes of Argus (top frame of every supported site).
 *
 * Site-specific knowledge lives in `platforms.js`; this file is generic. Two jobs:
 * 1. **Show marks.** Every account link (or search result) on the page gets a
 *    `data-argus="ai pe"` attribute and its card a `data-argus-card` attribute;
 *    `content.css` turns those into badges, tinted names and faded cards. Setting
 *    attributes is the only DOM work, so the cost on the page stays tiny.
 * 2. **Resolve right-clicks.** When a menu item is chosen, work out which account or
 *    website was right-clicked and ask the background to change it (the background is
 *    the only part that writes marks; see background.js).
 *
 * Where a key's state comes from, highest priority first:
 * your own mark (yes / "not") → the subscribed shared list → the community list.
 */
(() => {
  'use strict';

  const api = globalThis.browser ?? globalThis.chrome;
  const A = globalThis.Argus;
  const { FLAGS, MSG } = A;

  /** Adapter for this site (see platforms.js); pages without one are left alone. */
  const site = globalThis.ArgusPlatforms.forHost(location.hostname);
  if (!site) return;
  const boxSel = site.boxSel || site.cardSel || null;

  /** A right-click older than this is not trusted for a menu action. */
  const TARGET_MAX_AGE_MS = 15000;
  const SCAN_DELAY_MS = 200;

  let local = {};      // your marks         { key: {ai, pe, name, uc, t} }
  let shared = {};     // subscribed list    { key: {ai, pe, name} }
  let community = {};  // community list     { key: [aiPct, aiVotes, pePct, peVotes, name?, overrideBits?] }
  let settings = { badges: true, tint: true, dim: false };
  let syncOn = false;
  let communityAll = {};

  /** @type {Map<string, {st: string, title: (string|null)}>} key → state shown on this site */
  const merged = new Map();
  /** Number of elements currently carrying our attributes (for the idle shortcut). */
  let taggedCount = 0;
  /** @type {?{el: Element, at: number}} */
  let lastTarget = null;
  /** Times used to decide whether `link[rel=canonical]` belongs to the current page. */
  let navStartAt = 0;
  let canonicalAt = 0;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  /** Recomputes `merged` from your marks, the shared list and the community list. */
  function rebuild() {
    merged.clear();
    // A mark saved with its UC… id also applies to /channel/UC… links
    const mine = { ...local };
    for (const v of Object.values(local)) if (v.uc && !mine[v.uc]) mine[v.uc] = v;

    const add = key => {
      if (merged.has(key) || !site.owns(key)) return;
      const l = mine[key], s = shared[key], c = community[key];
      const on = FLAGS.filter((f, i) => {
        const lv = A.val(l?.[f]);
        return lv ? lv > 0 : !!(s?.[f] || (c && c[i * 2] > 0));
      });
      if (on.length) merged.set(key, { st: on.join(' '), title: c ? communityTitle(c) : null });
    };
    for (const k in mine) add(k);
    for (const k in shared) add(k);
    for (const k in community) add(k);
  }

  /**
   * Hover text for a community entry.
   * @param {Array} c `[aiPct, aiVotes, pePct, peVotes, name?, overrideBits?]`
   * @returns {?string}
   */
  function communityTitle(c) {
    const o = Number(c[5]) || 0;
    const parts = [];
    if (c[0]) parts.push(o & 1 ? 'AI (set by list maintainer)' : `AI ${c[0]}% of ${c[1]} votes`);
    if (c[2]) parts.push(o & 2 ? 'PE-owned (set by list maintainer)' : `PE-owned ${c[2]}% of ${c[3]} votes`);
    return parts.length ? 'Eyes of Argus community: ' + parts.join(' · ') : null;
  }

  /** Applies the display settings as classes on <html> (CSS does the rest). */
  function applySettings() {
    const c = document.documentElement.classList;
    c.toggle('argus-badges', !!settings.badges);
    c.toggle('argus-tint', !!settings.tint);
    c.toggle('argus-dim', !!settings.dim);
  }

  // ---------------------------------------------------------------------------
  // Scanning
  // ---------------------------------------------------------------------------

  /**
   * Default badge element: the link itself, if it is a text link (not an avatar).
   * @param {Element} a
   * @returns {?Element}
   */
  function textLink(a) {
    return a.textContent.trim() !== '' && !a.querySelector('img, yt-img-shadow, yt-avatar-shape') ? a : null;
  }

  /**
   * Tags every marked link and card on the page, and untags anything that no longer
   * qualifies (sites reuse elements and change their href in place).
   */
  function scan() {
    scheduled = false;
    if (!merged.size && !taggedCount) return; // nothing marked and nothing to clean up

    /** @type {Map<Element, (string|null|undefined)>} confirmed element → hover text */
    const tagged = new Map();
    const cards = new Map();
    if (merged.size) {
      for (const a of document.querySelectorAll(site.linkSel)) {
        const key = site.keyOf(a);
        const m = key && merged.get(key);
        if (!m) continue;
        const el = site.badgeEl ? site.badgeEl(a) : textLink(a);
        if (el) {
          if (el.dataset.argus !== m.st) el.dataset.argus = m.st;
          if (m.title && el.title !== m.title) { el.title = m.title; el.dataset.argusTitle = '1'; }
          tagged.set(el, m.title);
        }
        const card = site.cardSel && a.closest(site.cardSel);
        if (card) cards.set(card, m.st);
      }
    }
    for (const [card, st] of cards) {
      if (card.dataset.argusCard !== st) card.dataset.argusCard = st;
      if (!tagged.has(card)) tagged.set(card, undefined);
    }
    // Clean up everything tagged earlier that this pass didn't confirm
    for (const el of document.querySelectorAll('[data-argus], [data-argus-card], [data-argus-title]')) {
      if (tagged.has(el)) {
        if (el.dataset.argusTitle && !tagged.get(el)) { el.removeAttribute('title'); delete el.dataset.argusTitle; }
        if (el.dataset.argusCard && !cards.has(el)) delete el.dataset.argusCard;
        continue;
      }
      delete el.dataset.argus;
      delete el.dataset.argusCard;
      if (el.dataset.argusTitle) { el.removeAttribute('title'); delete el.dataset.argusTitle; }
    }
    taggedCount = tagged.size;
  }

  let scheduled = false;
  /** Schedules one scan; many mutations in a burst cause a single scan. */
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(scan, { timeout: 500 });
      else scan();
    }, SCAN_DELAY_MS);
  }

  /** @param {MutationRecord[]} records */
  function onMutations(records) {
    let relevant = false;
    for (const r of records) {
      const t = r.target;
      if (t.nodeName === 'LINK' && t.rel === 'canonical') canonicalAt = Date.now();
      for (const n of r.addedNodes) if (n.nodeName === 'LINK' && n.rel === 'canonical') canonicalAt = Date.now();
      if (!relevant && !(site.ignoreSel && t.closest && t.closest(site.ignoreSel))) relevant = true;
    }
    if (relevant && (merged.size || taggedCount)) schedule();
  }

  new MutationObserver(onMutations).observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['href'],
  });
  document.addEventListener('yt-navigate-start', () => { navStartAt = Date.now(); });
  document.addEventListener('yt-navigate-finish', schedule);

  // ---------------------------------------------------------------------------
  // Right-click → account or website
  // ---------------------------------------------------------------------------

  document.addEventListener('contextmenu', e => { lastTarget = { el: e.target, at: Date.now() }; }, true);

  /**
   * @param {?Element} a
   * @returns {?{key: string, name: string}}
   */
  function fromAnchor(a) {
    const key = a && site.keyOf(a);
    if (!key) return null;
    return { key, name: site.nameOf ? site.nameOf(a, key) : a.textContent.trim() };
  }

  /**
   * Works out what a right-clicked element belongs to.
   * @param {Element} el
   * @returns {?{key: string, name: string, uc: string}} null when unsure
   */
  function resolve(el) {
    const box = boxSel ? el.closest(boxSel) : null;
    const direct = fromAnchor(el.closest('a[href]'));
    if (direct) return finish(direct, box);

    if (box) {
      if (site.guessFromCard) {
        for (const a of box.querySelectorAll(site.linkSel)) {
          const r = fromAnchor(a);
          if (r) return finish(r, box);
        }
      }
      return null; // inside a card but unsure whose: don't guess
    }
    const page = site.pageTarget && site.pageTarget();
    return page ? finish({ key: page.key, name: page.name }, page.box || null) : null;
  }

  /**
   * Fills in the display name and any site-specific extras (YouTube's `UC…` id).
   * @param {{key: string, name: string}} r
   * @param {?Element} box card to look for a name in
   */
  function finish(r, box) {
    if (!r.name && box) {
      for (const a of box.querySelectorAll(site.linkSel)) {
        if (site.keyOf(a) === r.key && a.textContent.trim()) { r.name = a.textContent.trim(); break; }
      }
    }
    r.name = r.name || r.key;
    if (site.enrich) site.enrich(r, { canonicalFresh: canonicalAt >= navStartAt });
    return r;
  }

  /** Menu action → flag changes and the confirmation text. */
  const ACTIONS = {
    ai:    { changes: { ai: 1 },        msg: 'marked as AI' },
    pe:    { changes: { pe: 1 },        msg: 'marked as private-equity owned' },
    notai: { changes: { ai: -1 },       msg: 'marked as not AI' },
    notpe: { changes: { pe: -1 },       msg: 'marked as not PE-owned' },
    clear: { changes: { ai: 0, pe: 0 }, msg: 'cleared' },
  };

  /**
   * Handles a menu click forwarded by the background.
   * @param {string} action one of the ACTIONS keys
   */
  async function onMenu(action) {
    if (!Object.hasOwn(ACTIONS, action)) return;
    const a = ACTIONS[action];
    const target = lastTarget && Date.now() - lastTarget.at < TARGET_MAX_AGE_MS ? lastTarget.el : null;
    lastTarget = null; // one right-click, one action
    const t = target && target.closest ? resolve(target) : null;
    if (!t) { toast('Nothing to mark here. Right-click an account name, a post or a search result', true); return; }
    try {
      const res = await api.runtime.sendMessage({ type: MSG.MARK, key: t.key, name: t.name, uc: t.uc, changes: a.changes });
      if (res?.ok) toast(`${t.name} ${a.msg}`);
      else toast(`Couldn't save: ${res?.error || 'unknown error'}`, true);
    } catch {
      toast('Couldn\'t save: the extension was updated. Reload this page', true);
    }
  }

  api.runtime.onMessage.addListener(msg => {
    if (msg?.type === MSG.MENU) onMenu(msg.action);
  });

  // ---------------------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------------------

  let toastEl, toastTimer;
  /**
   * Shows a short confirmation at the bottom of the page.
   * @param {string} text
   * @param {boolean} [warn] amber border for problems
   */
  function toast(text, warn) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'argus-toast';
      toastEl.setAttribute('role', 'status');
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = '👁 ' + text;
    toastEl.classList.toggle('warn', !!warn);
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
  }

  // ---------------------------------------------------------------------------
  // Load and live updates
  // ---------------------------------------------------------------------------

  /** Shows the community list only while sync is on. */
  const refreshCommunity = () => { community = syncOn ? communityAll : {}; };

  api.storage.local.get(['marks', 'sharedList', 'settings', 'sync', 'community']).then(d => {
    local = d.marks || {};
    shared = d.sharedList?.channels || {};
    settings = { ...settings, ...(d.settings || {}) };
    syncOn = !!d.sync?.enabled;
    communityAll = d.community?.c || {};
    refreshCommunity();
    rebuild(); applySettings(); schedule();
  });

  api.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch.settings) { settings = { ...settings, ...(ch.settings.newValue || {}) }; applySettings(); }
    if (!(ch.marks || ch.sharedList || ch.sync || ch.community)) return;
    if (ch.marks) local = ch.marks.newValue || {};
    if (ch.sharedList) shared = ch.sharedList.newValue?.channels || {};
    if (ch.sync) syncOn = !!ch.sync.newValue?.enabled;
    if (ch.community) communityAll = ch.community.newValue?.c || {};
    refreshCommunity();
    rebuild(); schedule();
  });
})();
