# Code review report: The Eyes of Argus v0.2.0 → v0.3.0

## How the review worked
1. An independent review agent read the whole project (it changed nothing) and scored it out of 100
   against a fixed rubric, starting from 0. It ran the tests and its own probe scripts to confirm
   bugs instead of guessing.
2. I fixed the findings. Every one of the original 17 tests had to keep passing, so current
   behaviour stayed the same.
3. Every fix that can be tested got a regression test.

**Score before: 50/100.** The estimate after the fixes is in the last section.

## Findings and what was done

| # | Severity | Problem | Status |
|---|---|---|---|
| F1 | High | One person could put a mark on any channel for everyone (5 fake installs) | **Fixed.** 15 weighted votes needed, new installs weigh 0 for 3 days, max 2 counted votes per channel per network |
| F2 | High | Any website could register and vote through its visitors' browsers | **Fixed.** JSON-only POSTs and extension-only `Origin`; CORS kept for reading only |
| F3 | High | A crash or a big backlog part-way through a recount lost snapshot updates; free-plan query limit exceeded | **Fixed.** At most 1,800 channels per run; snapshot written before dirty flags are cleared |
| F4 | High | Votes arriving during a recount were dropped | **Fixed.** `rev` counter; dirty flag only cleared if unchanged |
| F5 | High | One rejected vote blocked the community download forever | **Fixed.** Upload and download are independent; rejected batches dropped; daily-limit batches kept |
| F6 | High | On Firefox for Android the background crashed (no menus API) | **Fixed.** Guarded; Android shows badges and syncs (view-only) |
| F7 | Medium | Badges were left on links YouTube reused for videos | **Fixed** |
| F8 | Medium | Right-clicking in an iframe marked the previous target | **Fixed.** Top frame only, target valid 15 s, used once |
| F9 | Medium | Every sync made every YouTube tab reload the whole list | **Fixed.** Separate `communityMeta` key |
| F10 | Medium | Marks cleared while sync was off stayed on the server forever | **Fixed.** Turning sync on replaces all your server votes |
| F11 | Medium | No way to delete your data on the server | **Fixed.** `POST /forget`, offered when turning sync off; retried if offline |
| F12 | Medium | Import was O(n²) writes, accepted invalid keys, and turned other people's lists into your votes | **Fixed.** One write, keys validated, shared lists not voted |
| F13 | Medium | Export lost "Not" choices and UC ids | **Fixed.** Lossless `mine` section, still compatible |
| F14 | Medium | Tabs, settings and sync could overwrite each other's changes | **Fixed.** Background is the only writer, through one serialized queue |
| F15 | Medium | Wrong UC id possible after in-page navigation | **Fixed.** Canonical link only trusted if set after the last navigation |
| F16 | Medium | Full rescans while the video player changes the page | **Mostly fixed.** Player mutations ignored, idle-time scans, instant skip when nothing is marked. Not done: rescanning only the changed parts of the page |
| F17 | Medium | Snapshot design would outgrow the free plan | **Mostly fixed.** Edge cache, rewritten only when changed, 6 h client interval. For very large scale, use a public R2 bucket (documented) |
| F18 | Medium | Puzzle restarted from zero when the worker stopped; difficulty uncapped | **Fixed.** Capped at 22 bits, progress saved, keep-alive |
| F19 | Medium | IPv6 bypassed per-network limits | **Fixed.** Grouped by /56 |
| F20 | Medium | Permission prompts could fail silently | **Fixed.** Only from clicks, errors shown, old server permission removed |
| F21–F24 | Low | Late votes waited 30 min; anyone could rename channels; huge bodies parsed; admin token compared non-constant-time | **Fixed** |
| F25 | Low | Firefox data-collection declaration | **Changed** to optional `websiteActivity`, requested when sync is turned on. Check this against AMO policy before publishing |
| F26 | Low | Key normalization copied 4 times, inconsistently | **Fixed.** One `normalizeKey` (decode, NFC, lowercase, validate) used everywhere, server included |
| F27 | Low | Admin-forced marks showed "1% of 0 votes" | **Fixed.** Shows "set by list maintainer" |
| F28 | Low | Accessibility gaps on the settings page | **Fixed.** Labels, live regions, focus outlines |
| F29 | Low | Server address with a query string broke | **Fixed** |
| F30 | Low | Duplication, unfinished refactor, version defined twice | **Fixed.** `shared.js`; version only in `package.json` |
| F31 | Low | Lint and docs scripts broken, no CI | **Fixed.** ESLint config, JSDoc config, GitHub Actions workflow |

## Results
- **Tests:** 26 passing (was 17), including regression tests for F2–F5, F7, F8, F10, F12, F13, F19, F26, F27 and F29.
- **Lint:** ESLint 0 problems; Mozilla's add-on linter 0 errors and 0 warnings.
- **Docs:** every function has JSDoc. `docs/ARCHITECTURE.md` covers storage keys, messages, file formats and the server API. `server/README.md` has the threat model, data retention and free-plan budget. The generated API reference is in `docs/api/`.

## Score after the fixes
My own estimate with the same rubric: **about 86/100**.

| Category | Before | After (estimate) |
|---|---|---|
| Correctness & bugs | 13/25 | 23 |
| Security & privacy | 7/20 | 16 |
| Performance | 8/15 | 12 |
| Code quality | 9/15 | 13 |
| Robustness | 5/10 | 9 |
| Tests & tooling | 5/10 | 8 |
| Documentation | 3/5 | 5 |

Nobody independent has checked this estimate; a second agent review was skipped to save usage.

**What's still missing to reach 90 or more:**
- automated tests for the settings page UI;
- rescanning only the changed parts of the page;
- an approval step for newly shown community marks, or a threshold that scales with the number of voters;
- a test in real Firefox and Chrome on live YouTube.

---

# Second review: v0.3.0 → v0.3.1

A second, independent review agent checked v0.3.0. It confirmed the earlier fixes hold, but scored the code
**76/100**, lower than my own estimate of about 86. It also found 12 new issues, all fixed in v0.3.1:

| # | Problem | Fix |
|---|---|---|
| N1 (High) | Votes from new installs were never recounted after their warm-up, so community marks would almost never appear at launch | Channels with warm-up votes stay queued for recounting |
| N2 | A channel from an imported list stayed "not your vote" even after you marked it yourself | Your own change removes the import tag |
| N3 | Turning sync off during the first registration could still upload votes | A generation counter stops running uploads; deletion is queued even before registration finishes |
| N4 | Backups dropped the import tag, so re-importing turned other people's lists into your votes | Tag exported and respected on import |
| N5 | The replace flag could be cleared by an older sync | Cleared only by the sync that matches it (token) |
| N6 | Changing server left your votes on the old one, under the same ID | Old server gets a delete request; new server gets a new anonymous ID |
| N7 | Votes made offline could wait up to 6 hours | Retry every 5 minutes while anything is waiting, and on browser start |
| N8 | Edge cache could serve an old list for 5 minutes | Cache time cut to 60 seconds |
| N9 | YouTube tabs could send settings-level messages | Tabs may only send marks |
| N10 | Hover text mixed weighted % with a raw vote count | Count shows only votes that counted |
| N11 | A second permission prompt after a refusal could never work in Firefox | Removed |
| N12 | Recount size not capped; odd IPv6 addresses shared one rate-limit bucket | Capped at 1,800; own bucket each |

**Results:** 30 tests pass, including 4 new ones for N1, N2/N4, N3/N6 and N9. ESLint and Mozilla's add-on linter report no problems.

**Still open:**
- automated tests for the settings page UI;
- a smoke test of the Chromium build in a real browser;
- rescanning only the changed parts of the page.

The reviewer estimated about +10 points for these fixes, which would put the code in the mid-80s. That figure hasn't been checked by a third review.

---

# Third round: v0.3.1 → v0.4.0 (independent functional and security test)

v0.4.0 adds X, Reddit, Instagram, TikTok, Twitch, Facebook and search results (Google, Bing,
DuckDuckGo). An independent agent then tested it: it wrote 32 new tests, probed a local sync server,
and loaded the Chrome build into a real Chrome. It worked on a copy and changed nothing in the project.

| # | Severity | Problem | Fix |
|---|---|---|---|
| Q1 | Critical | In a real browser the settings page could not import, delete all marks or control sync: the check added for N9 also blocked the settings page, because it too runs in a tab. The simulated tests had missed it | Pages are told apart by address; tests now send realistic senders; a real-browser smoke test is part of the repo |
| Q2 | High | Importing a file someone else exported overwrote your marks and sent their opinions as your votes | Two buttons: "Import list" (never your votes) and "Restore backup" |
| Q3 | Medium | Right-click on help/developer subdomains (help.x.com/en) marked a fake account (`x:en`) | Adapters and the manifest list exact hosts only |
| Q4 | Medium | A search result for a YouTube channel or X profile marked the whole platform | Such results are keyed by the account; the platform itself can't be marked |
| Q5 | Low | A look-alike domain could pose as a Google redirect | Redirects only unwrapped on the search engine's own host |
| Q6, Q7 | Low | `.`/`..` accepted as account names; a UC id accepted on non-YouTube keys | Stricter patterns; UC ids only on YouTube handles |
| Q8 | Low | Right-click inside web components (shadow DOM) found nothing | Right-clicks now resolve through shadow roots. Badges inside shadow roots are still not drawn |
| Q9, Q10 | Low | A page's own tooltip was lost; message types like `constructor` got an answer | Tooltip restored; own-property lookup |
| Q11 | Low | The first voter fixed a channel's public name | Names are no longer published |
| Q12 | Low | Channels with warm-up votes clogged the recount queue | A `recheck_at` time replaces staying in the queue |
| Q13 | Low | Body size limit counted characters, not bytes | Counts bytes |
| Q14 | Store | Chrome build asked for host permissions it didn't need | Removed for Chrome (kept for Firefox, which needs them to run content scripts) |

**Probed and found sound:** no HTML injection anywhere (names, keys, community data, import files);
prototype-pollution keys rejected; hostile links (`javascript:`, userinfo tricks, IPs, ports)
handled; marks don't leak between platforms; other extensions and web pages can't send messages;
the server's origin, content-type, SQL, admin, rate-limit, forget and replace handling all held.

**Results:** 68 tests pass (was 30). The real-Chrome smoke test passes 13 of 13 checks: service
worker, settings page including Import and Delete all, badges on YouTube, Google, X and Reddit
pages, the right-click path, and no access for page scripts.

**Not verified:**
- Live sites. Tests use locally served pages with the sites' known markup; the selectors for X,
  Instagram, TikTok, Twitch, Facebook and the search engines have not been checked against the live sites.
- Firefox in a real browser (only Mozilla's linter and the simulated tests).
- A vote-stuffing attacker with many networks over several days (see the threat model).
