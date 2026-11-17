# LocalGram

An offline Nonogram (Picross) puzzle game. It is a Progressive Web App (PWA):
open it once while online, add it to your home screen, and it works offline like a native app.
No app store, no backend, no build step. It uses plain HTML, CSS and JavaScript.

## Features

- 5×5, 10×10 and 15×15 grids.
- **Daily** puzzle (seeded by the local date, the same on every device) and **Random** mode.
- Every puzzle is generated in code and checked with a line solver, so it has a **unique solution reachable by logic alone**.
- Tap to fill, Fill/X toggle, drag to paint (the stroke locks to its row or column), undo/redo, restart, timer.
- Optional "Check mistakes" highlighting, clue dimming, haptics, and a win celebration with the solved picture.
- Light/dark theme follows the system setting.
- All state lives in `localStorage`: the puzzle in progress (one per mode and size), completed puzzles, best times and settings.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page markup |
| `style.css` | Styles (mobile-first, dark mode) |
| `game.js` | **Core** (RNG, line solver, generator; testable in Node) + **App** (UI) |
| `sw.js` | Service worker: pre-caches assets, serves cache-first |
| `manifest.webmanifest` | Install metadata |
| `icons/` | 192/512 px icons (`python3 icons/make_icons.py` regenerates them; needs Pillow) |
| `tests/` | Generator tests (Node) and end-to-end test (Playwright) |

## Run locally

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000/>. Service workers work on `localhost` without HTTPS.

To test on your phone over Wi-Fi, use `http://<your-computer-ip>:8000/`. The game works, but offline mode
and installation need HTTPS, so use GitHub Pages for those (below).

## Tests

```sh
node tests/generator.test.js
```

This generates 280 puzzles across all sizes. For each one it checks that the generator is deterministic, the line
solver solves it, and an independent brute-force solver finds **exactly one** solution.

End-to-end test (needs Playwright with Chromium). It runs in a Pixel 7 viewport and checks the layout, drag lock, undo,
service worker registration, solving and the win dialog, and an offline reload:

```sh
mkdir -p /tmp/site && ln -s "$PWD" /tmp/site/localgram      # serve from a sub-folder, like GitHub Pages
python3 -m http.server 8123 --directory /tmp/site &
node tests/e2e.js http://localhost:8123/localgram/ [screenshot-dir]
```

## Deploy free on GitHub Pages

Service workers require HTTPS, and GitHub Pages provides it.

1. Push this repository to GitHub, with the app files at the repository root of `main`.
2. Go to **Settings → Pages**. Under *Build and deployment*, set *Source* to **Deploy from a branch**, then choose
   branch `main` and folder `/ (root)`, and save.
3. After a minute or so the app is live at `https://<user>.github.io/<repo>/`. All paths are relative,
   so the sub-folder works as is.

### Shipping updates

1. Change the files.
2. **Bump `CACHE_VERSION` in `sw.js`** (for example `v1` → `v2`). Without this, installed copies keep the old cache.
3. Push. The next time an installed app opens online, it downloads the new version. A toast then offers a reload. Progress is kept.

## Install on your phone

Open the GitHub Pages URL once while online, then:

- **Android (Chrome):** tap the ⋮ menu and choose **Add to Home screen** or **Install app**.
- **iOS / iPadOS (Safari):** tap **Share** and choose **Add to Home Screen**. On iOS 26 and later, other browsers can do this too.

Launch it from the home-screen icon. Once it has loaded once, it also works in airplane mode.

> Note: iOS Safari does not support the Vibration API, so the "Vibration" option is hidden there.
> iOS may also clear a home-screen app's storage if it goes unused for many weeks.

## Development workflow (trunk-based)

- `main` is the trunk and is always deployable, because GitHub Pages serves it directly.
- Make small, frequent commits. Use short-lived branches (hours to a day) or commit straight to `main`.
- CI (`.github/workflows/ci.yml`) runs the generator tests on every push and pull request. Keep it green.
- Hide unfinished features behind a setting or flag instead of keeping long-lived branches.
- Bump `CACHE_VERSION` in every release that changes the files.

## Extending

- Generator difficulty: change `DENSITY` in `game.js` (lower values give sparser, usually harder puzzles).
- New grid sizes: add a button in `index.html` and a `DENSITY` entry. The layout and the solver work with any size.
- The storage format is versioned by its key (`localgram:v1`). Change the key if you make an incompatible change.
