# hyrox-app
Private HYROX fitness, weight-loss, and nutrition tracking app (single user, iPhone Safari first).

Plain HTML/CSS/JS, no build step, no dependencies. Data is stored only in this browser (localStorage `hyrox.v1`).

- Run: open `index.html`, or `node tests/static-server.js` and browse http://127.0.0.1:4173/
- Unit tests: `node --test tests/*.test.js`
- E2E: see TESTING.md
- Phase 3 details, feature matrix, limitations: HANDOVER-PHASE3.md
- `ai-test-backend/` is an OPTIONAL isolated local test adapter for photo analysis. Do not deploy it.
