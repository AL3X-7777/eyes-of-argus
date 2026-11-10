/**
 * @file Per-site adapters for the content script.
 *
 * `content.js` is generic; everything a site needs is described here by one adapter:
 *
 * | field           | meaning |
 * |-----------------|---------|
 * | `id`            | platform name |
 * | `test(host)`    | does this adapter handle the page's hostname? |
 * | `owns(key)`     | is this key shown on this site? (keeps the lookup map small) |
 * | `linkSel`       | CSS selector for links that can point at an account / site |
 * | `keyOf(a)`      | canonical key for a link, or null |
 * | `nameOf(a,key)` | optional display name (default: the link text) |
 * | `badgeEl(a)`    | optional element that carries the badge (default: the link, if text-only) |
 * | `cardSel`       | optional selector of the "card" around a post / result (for fading, and right-clicks) |
 * | `boxSel`        | optional wider selector used only for right-clicks (default `cardSel`) |
 * | `guessFromCard` | right-click anywhere in a card marks the card's first account link |
 * | `ignoreSel`     | optional: DOM changes inside this are ignored (e.g. the video player) |
 * | `pageTarget()`  | optional: the account the current page belongs to `{key, name, box?}` |
 * | `enrich(r,ctx)` | optional: add extra data to a resolved right-click target |
 *
 * Selectors for third-party sites can go stale when those sites change their markup;
 * the worst case is a missing badge or "No account found here", never a wrong mark:
 * every key still has to pass `Argus.normalizeKey`.
 *
 * Exposed as the frozen global `ArgusPlatforms`.
 */
(function (root) {
  'use strict';

  const A = root.Argus;

  /**
   * Path and query of a link, if it points at the given site.
   * Relative links are handled without constructing a URL (this runs for many links).
   * @param {Element} a
   * @param {RegExp} hostRe hostnames that count as "this site"
   * @returns {{path: string, search: string}|null}
   */
  function pathOf(a, hostRe) {
    const href = a.getAttribute('href');
    if (!href) return null;
    if (href[0] === '/' && href[1] !== '/') {
      const cut = href.search(/[?#]/);
      const q = href.indexOf('?');
      return { path: cut < 0 ? href : href.slice(0, cut), search: q < 0 ? '' : href.slice(q).split('#')[0] };
    }
    if (!/^(https?:)?\/\//i.test(href)) return null;
    let u;
    try { u = new URL(href, 'https://x.invalid'); } catch { return null; }
    return hostRe.test(u.hostname) ? { path: u.pathname, search: u.search } : null;
  }

  /**
   * Builds `fromPath` for sites whose profile address is `/<name>`: the first path
   * segment is the account unless it is one of the site's own pages.
   * @param {string} prefix key prefix, e.g. `"x"`
   * @param {string[]} reserved first segments that are not accounts
   * @param {string[]} [tabs] second segments still on the profile (e.g. `"reels"`)
   * @returns {function(string, boolean): (string|null)} (path, anyDepth) → key
   */
  function firstSegment(prefix, reserved, tabs = []) {
    const no = new Set(reserved);
    const ok = new Set(tabs);
    return (path, anyDepth) => {
      const seg = path.split('/').filter(Boolean);
      if (!seg.length || no.has(seg[0].toLowerCase())) return null;
      if (!anyDepth && seg.length > 1 && !(seg.length === 2 && ok.has(seg[1].toLowerCase()))) return null;
      return A.normalizeKey(`${prefix}:${seg[0]}`);
    };
  }

  /** @param {string} key @returns {string} the part after the prefix */
  const idOf = key => key.slice(key.indexOf(':') + 1);

  // ---------------------------------------------------------------------------
  // YouTube
  // ---------------------------------------------------------------------------

  const YT_CARD = [
    'ytd-rich-item-renderer', 'ytd-video-renderer', 'ytd-grid-video-renderer',
    'ytd-compact-video-renderer', 'ytd-playlist-video-renderer', 'ytd-channel-renderer',
    'ytd-playlist-panel-video-renderer', 'ytd-reel-item-renderer', 'yt-lockup-view-model',
    'ytm-shorts-lockup-view-model',
  ].join(',');
  const YT_OWNER = 'ytd-video-owner-renderer, ytd-watch-metadata';

  const youtube = {
    id: 'youtube',
    test: host => /(^|\.)youtube\.com$/.test(host),
    owns: key => !key.includes(':'),
    linkSel: 'a[href*="/@"], a[href*="/channel/UC"]',
    cardSel: YT_CARD,
    boxSel: `${YT_CARD}, ${YT_OWNER}`,
    guessFromCard: true,
    ignoreSel: '#movie_player, ytd-player',
    keyOf: a => A.keyFromHref(a.getAttribute('href')),
    /** The channel page's own channel, or the owner of the video being watched. */
    pageTarget() {
      const pageKey = A.keyFromHref(root.location.pathname);
      if (pageKey) {
        const h = root.document.querySelector('yt-page-header-view-model h1, #page-header h1, #channel-name #text');
        return { key: pageKey, name: h?.textContent.trim() || '' };
      }
      if (root.location.pathname === '/watch') {
        const a = root.document.querySelector('ytd-watch-metadata ytd-video-owner-renderer a[href]');
        const key = a && A.keyFromHref(a.getAttribute('href'));
        if (key) return { key, name: a.textContent.trim(), box: root.document.querySelector('ytd-video-owner-renderer') };
      }
      return null;
    },
    /**
     * On the channel's own page YouTube exposes its permanent `UC…` id in the canonical
     * link; it is only trusted if it was set after the last in-page navigation started.
     */
    enrich(r, ctx) {
      if (!r.key.startsWith('@') || A.keyFromHref(root.location.pathname) !== r.key || !ctx.canonicalFresh) return;
      const m = root.document.querySelector('link[rel="canonical"]')?.href.match(/\/channel\/(UC[\w-]{22})/);
      if (m) r.uc = m[1];
    },
  };

  // ---------------------------------------------------------------------------
  // Social platforms
  // ---------------------------------------------------------------------------

  /**
   * Adapter for a site where accounts live at `/<name>`.
   * @param {Object} o `{id, hostRe, linkSel, cardSel, reserved, tabs, guessFromCard, at}`
   */
  function profileSite(o) {
    const fromPath = firstSegment(o.id, o.reserved, o.tabs);
    return {
      id: o.id,
      test: host => o.hostRe.test(host),
      owns: key => key.startsWith(o.id + ':'),
      linkSel: o.linkSel,
      cardSel: o.cardSel,
      guessFromCard: !!o.guessFromCard,
      keyOf(a) {
        const p = pathOf(a, o.hostRe);
        return p && fromPath(p.path, false);
      },
      pageTarget() {
        const key = fromPath(root.location.pathname, true);
        return key ? { key, name: (o.at ? '@' : '') + idOf(key) } : null;
      },
    };
  }

  const x = profileSite({
    id: 'x',
    hostRe: /(^|\.)(x|twitter)\.com$/,
    // Author names of posts and user lists only; @mentions inside post text are not
    // badged (but can still be right-clicked).
    linkSel: '[data-testid="User-Name"] a[href^="/"], [data-testid="UserCell"] a[href^="/"]',
    cardSel: 'article, [data-testid="UserCell"]',
    guessFromCard: true,
    at: true,
    reserved: ['home', 'explore', 'notifications', 'messages', 'i', 'settings', 'search', 'compose', 'hashtag',
      'login', 'logout', 'signup', 'tos', 'privacy', 'jobs', 'about', 'intent', 'share', 'account', 'help',
      'download', 'premium', 'communities', 'lists', 'bookmarks', 'topics', 'trends', 'grok', 'verified-orgs'],
  });

  const instagram = profileSite({
    id: 'instagram',
    hostRe: /(^|\.)instagram\.com$/,
    linkSel: 'a[href^="/"]',
    cardSel: 'article',
    guessFromCard: true,
    at: true,
    tabs: ['reels', 'tagged', 'saved'],
    reserved: ['explore', 'reels', 'reel', 'p', 'tv', 'direct', 'accounts', 'stories', 'about', 'legal', 'developer',
      'api', 'web', 'challenge', 'emails', 'your_activity', 'graphql', 'privacy', 'session', 'press', 'directory',
      'locations', 'audio', 'static', 'ads'],
  });

  const twitch = profileSite({
    id: 'twitch',
    hostRe: /(^|\.)twitch\.tv$/,
    linkSel: 'a[href^="/"]',
    cardSel: 'article',
    guessFromCard: true,
    tabs: ['videos', 'about', 'schedule', 'clips', 'home'],
    reserved: ['directory', 'videos', 'settings', 'subscriptions', 'inventory', 'drops', 'wallet', 'friends', 'search',
      'downloads', 'turbo', 'jobs', 'p', 'store', 'prime', 'user', 'popout', 'moderator', 'u', 'team', 'teams', 'embed',
      'privacy', 'legal', 'login', 'signup', 'payments', 'following', 'broadcast', 'collections', 'event', 'events', 'bits'],
  });

  const HOST_FB = /(^|\.)facebook\.com$/;
  const fbPath = firstSegment('facebook', ['watch', 'marketplace', 'groups', 'gaming', 'events', 'pages', 'friends',
    'messages', 'notifications', 'bookmarks', 'login', 'help', 'settings', 'stories', 'reel', 'reels', 'photo',
    'photos', 'videos', 'hashtag', 'share', 'sharer', 'privacy', 'policies', 'ads', 'business', 'me', 'home.php',
    'profile.php', 'permalink.php', 'story.php', 'l.php', 'dialog', 'plugins', 'search', 'saved', 'memories',
    'feeds', 'fundraisers', 'games', 'live', 'people', 'public', 'places', 'login.php', 'recover', 'checkpoint',
    'photo.php', 'watch.php', 'groups.php', 'legal', 'careers', 'directory', 'ajax', 'tr', 'flx', 'nd'], ['about', 'posts']);
  /** @param {string} path @param {string} search @param {boolean} anyDepth */
  const fbKey = (path, search, anyDepth) => {
    if (/^\/profile\.php\/?$/.test(path)) {
      const id = new URLSearchParams(search).get('id');
      return id && /^\d{1,30}$/.test(id) ? `facebook:${id}` : null;
    }
    return fbPath(path, anyDepth);
  };
  const facebook = {
    id: 'facebook',
    test: host => HOST_FB.test(host),
    owns: key => key.startsWith('facebook:'),
    linkSel: 'a[href*="facebook.com/"], a[href^="/"]',
    cardSel: '[role="article"]',
    guessFromCard: false, // shared posts and comments make "the" author of a card ambiguous
    keyOf(a) {
      const p = pathOf(a, HOST_FB);
      return p && fbKey(p.path, p.search, false);
    },
    pageTarget() {
      const key = fbKey(root.location.pathname, root.location.search, true);
      return key ? { key, name: idOf(key) } : null;
    },
  };

  const HOST_TT = /(^|\.)tiktok\.com$/;
  /**
   * @param {string} path
   * @param {boolean} anyDepth also accept pages below a profile (videos)
   * @returns {string|null}
   */
  const ttKey = (path, anyDepth) => {
    const m = path.match(anyDepth ? /^\/@([^/?#]+)/ : /^\/@([^/?#]+)\/?$/);
    return m ? A.normalizeKey('tiktok:' + m[1]) : null;
  };
  const tiktok = {
    id: 'tiktok',
    test: host => HOST_TT.test(host),
    owns: key => key.startsWith('tiktok:'),
    linkSel: 'a[href*="/@"]',
    cardSel: 'article, [data-e2e="recommend-list-item-container"], [data-e2e="search_top-item"]',
    guessFromCard: true,
    keyOf(a) {
      const p = pathOf(a, HOST_TT);
      return p && ttKey(p.path, false);
    },
    pageTarget() {
      const key = ttKey(root.location.pathname, true);
      return key ? { key, name: '@' + idOf(key) } : null;
    },
  };

  const HOST_RD = /(^|\.)reddit\.com$/;
  /**
   * @param {string} path
   * @param {boolean} anyDepth also accept pages below a subreddit (posts)
   * @returns {string|null} `reddit:u/name` or `reddit:r/sub`
   */
  const rdKey = (path, anyDepth) => {
    let m = path.match(/^\/(?:user|u)\/([^/?#]+)/i);
    if (m) return A.normalizeKey('reddit:u/' + m[1]);
    m = path.match(anyDepth ? /^\/r\/([^/?#]+)/i : /^\/r\/([^/?#]+)\/?$/i);
    return m ? A.normalizeKey('reddit:r/' + m[1]) : null;
  };
  const reddit = {
    id: 'reddit',
    test: host => HOST_RD.test(host),
    owns: key => key.startsWith('reddit:'),
    linkSel: 'a[href*="/user/"], a[href*="/u/"], a[href*="/r/"]',
    cardSel: 'shreddit-post, article, .thing',
    guessFromCard: false, // a post names both its subreddit and its author
    keyOf(a) {
      const p = pathOf(a, HOST_RD);
      return p && rdKey(p.path, false);
    },
    pageTarget() {
      const key = rdKey(root.location.pathname, true);
      return key ? { key, name: idOf(key) } : null;
    },
  };

  // ---------------------------------------------------------------------------
  // Search engines: each result is marked by its website (`site:example.com`)
  // ---------------------------------------------------------------------------

  /**
   * The real destination of a search-result link, unwrapping the engines' redirect links.
   * @param {Element} a
   * @returns {string|null} absolute http(s) URL
   */
  function destination(a) {
    const href = a.getAttribute('href');
    if (!href) return null;
    let u;
    try { u = new URL(href, root.location.href); } catch { return null; }
    const h = u.hostname;
    if (/(^|\.)google\.[a-z.]+$/.test(h) && u.pathname === '/url') {
      return u.searchParams.get('q') || u.searchParams.get('url');
    }
    if (/(^|\.)duckduckgo\.com$/.test(h) && u.pathname.startsWith('/l/')) return u.searchParams.get('uddg');
    if (/(^|\.)bing\.com$/.test(h) && u.pathname.startsWith('/ck/')) {
      const raw = u.searchParams.get('u') || '';
      if (!raw.startsWith('a1')) return null;
      try { return root.atob(raw.slice(2).replace(/-/g, '+').replace(/_/g, '/')); } catch { return null; }
    }
    return u.href;
  }

  /**
   * Adapter for a search-results page.
   * @param {Object} o `{id, hostRe, linkSel, cardSel, badgeEl}`
   */
  function searchSite(o) {
    return {
      id: o.id,
      test: host => o.hostRe.test(host),
      owns: key => key.startsWith('site:'),
      linkSel: o.linkSel,
      cardSel: o.cardSel,
      guessFromCard: true,
      badgeEl: o.badgeEl,
      keyOf(a) {
        const dest = destination(a);
        const key = dest && A.siteKey(dest);
        // links back to the results page itself are not results
        return key && idOf(key) !== root.location.hostname.replace(/^www\./, '') ? key : null;
      },
      nameOf: (_a, key) => idOf(key),
    };
  }

  const google = searchSite({
    id: 'google',
    hostRe: /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/,
    linkSel: 'a[href]:has(h3)',
    cardSel: '.MjjYud, div.g, [data-sokoban-container]',
    badgeEl: a => a.querySelector('h3'),
  });

  const bing = searchSite({
    id: 'bing',
    hostRe: /(^|\.)bing\.com$/,
    linkSel: 'li.b_algo h2 a[href]',
    cardSel: 'li.b_algo',
  });

  const duckduckgo = searchSite({
    id: 'duckduckgo',
    hostRe: /(^|\.)duckduckgo\.com$/,
    linkSel: 'a[data-testid="result-title-a"], a.result__a',
    cardSel: 'article, .result',
  });

  const list = Object.freeze([youtube, x, reddit, instagram, tiktok, twitch, facebook, google, bing, duckduckgo]);

  root.ArgusPlatforms = Object.freeze({
    list,
    /**
     * @param {string} host page hostname
     * @returns {Object|null} the adapter for that site
     */
    forHost: host => list.find(p => p.test(host)) || null,
  });
})(globalThis);
