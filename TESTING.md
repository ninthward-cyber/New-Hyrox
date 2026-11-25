# Testing (Phase 1)

## 1. Run the app
Open `index.html` directly in Chrome, Edge or Safari (double-click works; no server needed).

## 2. Unit tests (data layer, 50 tests)
Requires Node.js 18+ (tested on Node 24 and 26). From the repo folder:

    node --test tests/hyrox-data.test.js

Expected: 50 pass, 0 fail (includes data-loss regression tests).

## 3. Mobile screenshot (optional, Linux/Chrome)
    bash tests/mobile-check.sh
Writes tests/out/iphone-390x844.png (git-ignored).

## 4. Manual checks
- Desktop: DevTools device mode, iPhone 12/13/14 (390x844).
- Real iPhone Safari: follow tests/IPHONE-CHECKLIST.md. Opening on an iPhone needs the files on the phone
  or a host; hosting is NOT authorized yet.

## Notes
- Data lives in localStorage key `hyrox.v1` for the page's origin. Clearing site data deletes it; use
  "Export JSON backup" regularly.
- Dates use Asia/Qatar. Future dates are rejected.

# Testing (Phase 3)
- `node --test tests/*.test.js` → 245 tests (178 Phase 2 + 67 Phase 3).
- `python3 tests/fixtures/make_fixtures.py` regenerates the SYNTHETIC drawn food images (one with fake EXIF/GPS).
- E2E: `NODE_PATH=<dir>/node_modules npx playwright test -c tests/playwright.emergent.config.js` (WebKit iPhone-13 emulation + Chromium; not real Safari).
- AI adapter: `cd ai-test-backend && python3 -m pytest -q test_food_photo_adapter.py` (fake model, no network).
- Raw outputs from the Emergent run: `test-results/`.
