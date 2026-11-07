# Brick Sorter: development guide

Read this before changing the app. The visual and wording rules live in [STYLE.md](STYLE.md); this file covers how the code is organised and how to ship a change safely.

## What it is

A phone-only static PWA for one person sorting a loose LEGO collection back into sets. Live at https://alexpett.github.io/brick-sorter/ (GitHub Pages, served from `main`). No build step, no framework, no server. Data stays on the phone in IndexedDB, with an optional Google Sheet backup through an Apps Script web app.

## Layout

| Path | Purpose |
| --- | --- |
| `index.html` | Shell: header, `#view`, tab bar, `#dlg` dialog, `#toast`, undo pill. |
| `css/style.css` | All styles. Tokens in `:root`, dark mode via `prefers-color-scheme`. |
| `js/app.js` | Router (`routes`, `route()`), Sets list and set page, Settings, boot. |
| `js/screens/home.js` | Home (Overview), Bricks found, streak. |
| `js/screens/scan.js` | Log bricks: describe a brick, camera, type filter, saving to bins. |
| `js/screens/sorter.js` | Sorting flow, `offerUndo()`, undo pill, `dominantColour`. |
| `js/screens/bins.js` | Store tab, bin pages, Missing / Found / pick lists, `confirmAbandon`, editing a row. |
| `js/bins.js` | Bin model and rules: `loadContext`, `allocate`, `saveToBins`, `moveLine`, `deleteStorageBin`, `snapshotAll` / `restoreSnapshot`. |
| `js/db.js` | IndexedDB wrapper: `get`, `put`, `putMany`, `all`, `byIndex`, `getSetting`, `setSetting`. |
| `js/sync.js` | Google Sheet backup. `SETTING_KEYS` is a whitelist of settings that sync. |
| `js/rebrickable.js`, `js/themes.js` | Rebrickable API and the cached theme tree. |
| `js/recog.js` | Brickognize camera recognition. |
| `js/order.js` | Builds the Rebrickable wanted-list order text. |
| `js/setpic.js`, `js/swatch.js` | Set pictures with brick-icon fallback; colour wall. |
| `js/ui.js` | `$`, `esc`, `fmt`, `toast`, `openDialog`, `ask`, `notify`, `stepperHtml`, `ago`. |
| `data/` | Parts, colours and categories derived from Rebrickable downloads (`tools/build-data.py`). |
| `apps-script/` | Google Apps Script backup endpoint and `SETUP.md`. |
| `sw.js` | Service worker, network-first, versioned cache. |

## Rules of the codebase

- Vanilla ES modules, no dependencies, no bundler.
- Every string put into `innerHTML` goes through `esc()`.
- User-facing text says **bricks**, not pieces. The stored key stays `pieces`; do not rename stored keys.
- Removing is called **Remove**. Removing a storage bin soft-deletes the bricks in it.
- Records are never hard-deleted: set `deleted: true` and `updated` to the current ISO time so sync and undo work. Newest `updated` wins on sync.
- Use `ask()` for confirmations. Pass `warn: 'This cannot be undone.'` whenever data is lost for good.
- Reversible bulk changes go through `withUndo` (bin pages) or `offerUndo` (sorter), which use `bins.snapshotAll()` and `restoreSnapshot()`.
- Official LEGO colour names only.
- Colours come from CSS tokens, never hex values. See STYLE.md.
- Tap targets are 44px or more. Icon-only buttons need an `aria-label`.
- Do not store API keys in the repo. The Rebrickable key is pasted into Settings and kept on the device.

## Shipping a change

1. Edit code and CSS.
2. If you add a JS file, add it to `SHELL` in `sw.js`.
3. Bump `CACHE` in `sw.js` (`brick-sorter-vNN`). The phone updates after the app is reopened twice.
4. Run the full test suite (below).
5. Commit, push to `main`, and check `git ls-remote origin main` matches `git rev-parse HEAD`.
6. Update the testing checklist document for anything the owner should check by hand.

## Tests

Tests are Playwright scripts kept outside the repo (`scratchpad/test/test*.js`, listed in `all.txt`). Each serves the repo on port 8123, mocks Rebrickable, and prints `PASS` / `FAIL` lines.

- Run with `bash runsel.sh test test2 …` and read the output; judge by exit code and the number of `FAIL` lines.
- Known timing flakes: `test3` (sync retry), `test9`, `test20`, `test24`. Rerun before treating them as real.
- Tests that mock Rebrickable must answer `/themes/` as well.
- When wording changes, update the matching expectations in the same commit.

## Adding a feature: checklist

- [ ] Wording follows STYLE.md (bricks, Remove, plain verbs).
- [ ] Works in dark mode and at 360px wide.
- [ ] Destructive action? Confirmation with the cannot-be-undone line, or Undo.
- [ ] New persisted setting that should sync? Add it to `SETTING_KEYS` in `js/sync.js`.
- [ ] New records have `updated` and soft deletes.
- [ ] Cache version bumped; new files precached.
- [ ] Tests added or updated.

## Decisions already made

- No pencil or Create-order action on the set page.
- No backup-file export or import feature.
- No swatch extras.
- Overview stays off the tab bar; it is reached from Home and the menu.
- Phone only. Do not design for desktop widths.
- Buttons are lozenges (fully rounded).
- Selected chips and the Undo pill are grey, not amber or red.

## Rebrickable notes

- Sets carry `theme_id`; `/themes/` gives name and `parent_id`. The app shows the top-level theme and caches the tree in the `themes` setting.
- Part, colour and category names in `data/` come from the Rebrickable downloads. Refresh with `python3 tools/build-data.py <csv folder>`.
- Camera recognition uses Brickognize, limited to five requests per second per IP.
