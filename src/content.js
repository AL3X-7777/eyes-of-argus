// The Eyes of Argus — content script (runs on youtube.com)
(() => {
  const api = globalThis.browser ?? chrome;

  // Elements YouTube uses for a single video/channel "card"
  const CARD_SEL = [
    'ytd-rich-item-renderer', 'ytd-video-renderer', 'ytd-grid-video-renderer',
    'ytd-compact-video-renderer', 'ytd-playlist-video-renderer', 'ytd-channel-renderer',
    'ytd-playlist-panel-video-renderer', 'ytd-reel-item-renderer', 'yt-lockup-view-model',
    'ytm-shorts-lockup-view-model'
  ].join(',');
  const OWNER_SEL = 'ytd-video-owner-renderer, ytd-watch-metadata';
  const LINK_SEL = 'a[href*="/@"], a[href*="/channel/UC"]';
  const FLAGS = ['ai', 'pe'];

  let local = {};      // your marks         { key: {ai: 1|-1|0, pe: 1|-1|0, name, uc, t} }
  let shared = {};     // subscribed list    { key: {ai: bool, pe: bool, name} }
  let community = {};  // sync snapshot      { key: [aiPct, aiVotes, pePct, peVotes, name] }
  let settings = { badges: true, tint: true, dim: false };
  let syncOn = false;
  const merged = new Map();  // key -> { st: 'ai pe', title }
  let lastTarget = null;

  // 1 = yes, -1 = "not" (you disagree), 0 = no opinion. Older versions stored true/false.
  const val = x => (x === true || x === 1 ? 1 : x === -1 ? -1 : 0);

  // ---------- helpers ----------
  function keyFromHref(href) {
    if (!href) return null;
    let u;
    try { u = new URL(href, 'https://www.youtube.com'); } catch { return null; }
    if (!/(^|\.)youtube\.com$/.test(u.hostname)) return null;
    let m = u.pathname.match(/^\/(@[^/?#]+)/);
    if (m) { try { return decodeURIComponent(m[1]).toLowerCase(); } catch { return m[1].toLowerCase(); } }
    m = u.pathname.match(/^\/channel\/(UC[\w-]{22})/);
    return m ? m[1] : null;
  }

  function rebuild() {
    merged.clear();
    // A local mark saved with its UC… id also applies to /channel/UC… links
    const localBy = { ...local };
    for (const [k, v] of Object.entries(local)) if (v.uc && !localBy[v.uc]) localBy[v.uc] = v;

    const keys = new Set([...Object.keys(shared), ...Object.keys(community), ...Object.keys(localBy)]);
    for (const key of keys) {
      const l = localBy[key], s = shared[key], c = community[key];
      const on = {};
      for (const f of FLAGS) {
        const lv = val(l?.[f]);
        on[f] = lv ? lv > 0 : !!(s?.[f] || (c && c[f === 'ai' ? 0 : 2] > 0));
      }
      const st = FLAGS.filter(f => on[f]).join(' ');
      if (!st) continue;
      let title = null;
      if (c) {
        const parts = [];
        if (c[0]) parts.push(`AI ${c[0]}% of ${c[1]} votes`);
        if (c[2]) parts.push(`PE-owned ${c[2]}% of ${c[3]} votes`);
        if (parts.length) title = 'Eyes of Argus community: ' + parts.join(' · ');
      }
      merged.set(key, { st, title });
    }
  }

  function applySettings() {
    const c = document.documentElement.classList;
    c.toggle('argus-badges', !!settings.badges);
    c.toggle('argus-tint', !!settings.tint);
    c.toggle('argus-dim', !!settings.dim);
  }

  // ---------- scanning (cheap: only sets attributes, CSS does the rest) ----------
  function scan() {
    scheduled = false;
    const cards = new Map();
    for (const a of document.querySelectorAll(LINK_SEL)) {
      const m = merged.get(keyFromHref(a.getAttribute('href')));
      const st = m ? m.st : '';
      const isText = st && a.textContent.trim() !== '' && !a.querySelector('img, yt-img-shadow, yt-avatar-shape');
      const want = isText ? st : '';
      if ((a.dataset.argus || '') !== want) {
        if (want) a.dataset.argus = want; else delete a.dataset.argus;
      }
      const title = want && m.title;
      if (title) {
        if (a.title !== title) { a.title = title; a.dataset.argusTitle = '1'; }
      } else if (a.dataset.argusTitle) {
        a.removeAttribute('title'); delete a.dataset.argusTitle;
      }
      const card = a.closest(CARD_SEL);
      if (card && (st || !cards.has(card))) cards.set(card, st);
    }
    for (const [card, st] of cards) {
      if ((card.dataset.argusCard || '') !== st) {
        if (st) card.dataset.argusCard = st; else delete card.dataset.argusCard;
      }
    }
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(scan, 150);
  }

  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['href']
  });
  document.addEventListener('yt-navigate-finish', schedule);

  // ---------- figuring out which channel was right-clicked ----------
  document.addEventListener('contextmenu', e => { lastTarget = e.target; }, true);

  function fromAnchor(a) {
    const key = a && keyFromHref(a.getAttribute('href'));
    return key ? { key, name: a.textContent.trim() } : null;
  }

  function resolve(el) {
    if (el instanceof Element) {
      const direct = fromAnchor(el.closest('a[href]'));
      if (direct) return finish(direct, el.closest(CARD_SEL) || el.closest(OWNER_SEL));

      const box = el.closest(CARD_SEL) || el.closest(OWNER_SEL);
      if (box) {
        for (const a of box.querySelectorAll(LINK_SEL)) {
          const r = fromAnchor(a);
          if (r) return finish(r, box);
        }
        return null; // inside a card but no channel link — don't guess
      }
    }
    // On a channel page: the channel itself
    const pageKey = keyFromHref(location.pathname);
    if (pageKey) {
      const h = document.querySelector('yt-page-header-view-model h1, #page-header h1, #channel-name #text');
      return finish({ key: pageKey, name: h?.textContent.trim() || '' }, null);
    }
    // On a watch page: the video's owner
    if (location.pathname === '/watch') {
      const owner = fromAnchor(document.querySelector('ytd-watch-metadata ytd-video-owner-renderer a[href]'));
      if (owner) return finish(owner, document.querySelector('ytd-video-owner-renderer'));
    }
    return null;
  }

  function finish(r, box) {
    if (!r.name && box) {
      for (const a of box.querySelectorAll(LINK_SEL)) {
        if (keyFromHref(a.getAttribute('href')) === r.key && a.textContent.trim()) { r.name = a.textContent.trim(); break; }
      }
    }
    r.name = r.name || r.key;
    // On the channel's own page YouTube exposes its permanent UC… id; remember it
    if (r.key.startsWith('@') && keyFromHref(location.pathname) === r.key) {
      const m = document.querySelector('link[rel="canonical"]')?.href.match(/\/channel\/(UC[\w-]{22})/);
      if (m) r.uc = m[1];
    }
    return r;
  }

  // ---------- applying a mark ----------
  const ACTIONS = {
    ai:    { set: { ai: 1 },        msg: 'marked as AI' },
    pe:    { set: { pe: 1 },        msg: 'marked as private-equity owned' },
    notai: { set: { ai: -1 },       msg: 'marked as not AI' },
    notpe: { set: { pe: -1 },       msg: 'marked as not PE-owned' },
    clear: { set: { ai: 0, pe: 0 }, msg: 'cleared' },
  };

  async function apply(t, action) {
    const a = ACTIONS[action];
    if (!a) return;
    const { marks = {}, queue = {} } = await api.storage.local.get(['marks', 'queue']);
    const old = marks[t.key] || {};
    const e = { ai: val(old.ai), pe: val(old.pe), name: t.name, uc: t.uc || old.uc, t: Date.now() };
    const changed = [];
    for (const [f, v] of Object.entries(a.set)) {
      if (e[f] !== v) changed.push(f);
      e[f] = v;
    }
    if (!e.uc) delete e.uc;
    if (e.ai || e.pe) marks[t.key] = e; else delete marks[t.key];

    const save = { marks };
    if (syncOn && changed.length) {
      for (const f of changed) {
        for (const k of [t.key, e.uc].filter(Boolean)) {
          queue[`${k}|${f}`] = { k, f, v: e[f], name: t.name, t: e.t };
        }
      }
      save.queue = queue;
    }
    await api.storage.local.set(save);
    toast(`${t.name} ${a.msg}`);
  }

  api.runtime.onMessage.addListener(msg => {
    if (msg?.type !== 'argus-menu') return;
    const t = resolve(lastTarget);
    if (!t) { toast('No channel found here. Right-click the channel name or a video', true); return; }
    apply(t, msg.action);
  });

  // ---------- toast ----------
  let toastEl, toastTimer;
  function toast(text, warn) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'argus-toast';
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = '👁 ' + text;
    toastEl.classList.toggle('warn', !!warn);
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
  }

  // ---------- load + live updates ----------
  api.storage.local.get(['marks', 'sharedList', 'settings', 'sync', 'community']).then(d => {
    local = d.marks || {};
    shared = d.sharedList?.channels || {};
    settings = { ...settings, ...(d.settings || {}) };
    syncOn = !!d.sync?.enabled;
    community = (syncOn && d.community?.c) || {};
    rebuild(); applySettings(); schedule();
  });

  api.storage.onChanged.addListener(async (ch, area) => {
    if (area !== 'local') return;
    if (ch.marks) local = ch.marks.newValue || {};
    if (ch.sharedList) shared = ch.sharedList.newValue?.channels || {};
    if (ch.settings) { settings = { ...settings, ...(ch.settings.newValue || {}) }; applySettings(); }
    if (ch.sync || ch.community) {
      const d = await api.storage.local.get(['sync', 'community']);
      syncOn = !!d.sync?.enabled;
      community = (syncOn && d.community?.c) || {};
    }
    if (ch.marks || ch.sharedList || ch.sync || ch.community) { rebuild(); schedule(); }
  });
})();
