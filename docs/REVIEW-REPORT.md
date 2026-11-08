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
