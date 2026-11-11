# Chrome Web Store listing (copy and paste)

**Package to upload:** `dist/eyes-of-argus-chrome-<version>.zip`

## Store listing tab
- **Name:** Eyes of Argus
- **Summary (max 132 characters):**
  Mark YouTube channels, social accounts and search results that use AI or are owned by private equity. Works offline.
- **Category:** Tools (or "Social & Communication")
- **Language:** English

**Description:**

Eyes of Argus lets you label who is behind what you watch and read.

Right-click any link, a YouTube channel, a social media account or a search result and mark it as:
• AI: the channel, account or site relies on AI-generated content
• PE: owned by private equity

Marked channels and sites get a small badge everywhere they appear, so you recognise them at a glance. You can also tint their names or fade their videos and posts.

Works on:
• YouTube
• X (Twitter), Reddit, Instagram, TikTok, Twitch, Facebook
• Google, Bing and DuckDuckGo results (a result marks its whole website)

Features:
• Mark any link on any website from the right-click menu; optionally show badges on every site
• A channel with both marks is shown half purple, half amber
• Works offline: your marks are stored in your browser, no account needed
• Export and import your marks, or subscribe to a list someone else maintains
• Optional community sync: share your marks as anonymous votes with a sync server you choose, and see marks that enough people agree on
• Disagree with a community mark? "Not AI" / "Not PE-owned" hides it for you and counts as a vote against it
• No ads, no analytics, no tracking. Open source (MIT)

The marks are opinions of the people who set them. Check the facts yourself before relying on a label.

Source code: https://github.com/AL3X-7777/eyes-of-argus

## Graphics
- Icon 128×128: `src/icons/icon128.png`
- Screenshots 1280×800: `store/screenshots/` (add one real screenshot of YouTube with the right-click menu open; a headless browser can't capture that menu)
- Small promo tile 440×280: `store/promo-tile-440x280.png`

## Privacy practices tab
- **Single purpose:** Lets users label channels, accounts and websites as AI-reliant or private-equity owned, and shows those labels as badges on supported sites.
- **Privacy policy URL:** https://github.com/AL3X-7777/eyes-of-argus/blob/main/PRIVACY.md
- **Remote code:** No. All code is in the package.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `contextMenus` | Adds the "Eyes of Argus" right-click menu used to mark the channel, account or search result under the cursor. |
| `storage` | Stores the user's marks, settings and the optional downloaded lists locally. |
| `unlimitedStorage` | The optional community list can exceed the default 10 MB local storage quota. |
| `scripting` | Only used when the user turns on "Show badges on every website": registers the extension's own content script (the same files as in the package) for all https sites. No remote code. |
| `alarms` | Periodically refreshes the optional shared list and community list, and retries sending votes made offline. |
| Site access via content scripts (YouTube, X, Reddit, Instagram, TikTok, Twitch, Facebook, Google/Bing/DuckDuckGo search; no `host_permissions` are requested) | The content script reads links on these pages to draw badges next to marked channels, accounts and results, and to identify what the user right-clicked. No page content is collected or transmitted. |
| Optional host permission `https://*/*` | Never requested at install. Requested at runtime in two cases: (1) for one origin only, when the user enters the address of a shared list or sync server; (2) for all https sites, when the user turns on "Show badges on every website", so badges can be drawn next to links on any page. |

**Data usage:** the extension collects nothing by default. With community sync turned on by the
user, votes (which channel or site, which flag, yes/no) are sent to the server the user entered.
The closest category in the form is "User activity"; tick it if you operate a public sync server,
and certify the three statements (no selling, no unrelated use, no creditworthiness use).
