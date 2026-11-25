# Progress HQ — Compact Emergent development source

This is a **purpose-built working-source subset** of offline Garmin t125u `c149d76` (`9f89031f3312`) based on the existing P1.4-RC3 app. It is **not a new app**, a complete archive of the original 465-file QA tree, or an authorized deploy package.

## How to upload under 100 GitHub files
- Easiest: upload this single ZIP **directly to Emergent**. No GitHub upload is needed if Emergent accepts the ZIP.
- If GitHub is required, **extract the outer ZIP locally first** and upload the original 98 files in this folder, preserving all nested paths. GitHub does **not** automatically extract a ZIP attached as one repository file. Use a separate private repository/folder, or explicitly instruct Emergent to treat this compact directory as the root and ignore any older conflicting files already in the GitHub repo.
- Do NOT unpack `tests/fixture-data.zip` before uploading to GitHub: that archive contains 90 synthetic fixture files, and unzipping it on your computer before web upload would push the count beyond 100. Unpack it only AFTER checkout/import on Emergent's development machine by running `python tools/unpack_fixture_data.py`.
- If the browser uploader flattens directory paths or has trouble with folder uploads, use GitHub Desktop/git CLI instead of guessing or losing paths.

## Start here
1. Read `EMERGENT_REQUIREMENTS.txt` in full (P0 Garmin security + reliability, P1 branding, P2 readiness).
2. Read `README.md`, `CHANGES-P1.4-RC3.md`, `DEPLOY-P1.4-RC3.md`, `DEPLOY-FILES.txt`, and `docs/garmin/OWNER_LOCKOUT_RECOVERY.md`.
3. Read the actual source in `src/`, `index.html`, `netlify/`, and the focused tests. Keep the existing plain-JS architecture. No React, MongoDB, FastAPI replacement, new site, or new localStorage origin.
4. Before running focused tests, run `python tools/unpack_fixture_data.py`. Synthetic original fixtures are archived into ONE file only to stay under GitHub's browser upload limit. Do not deploy these fixtures.
5. Run `node tests/static-server.js` and inspect the app locally. For **focused unit tests**, run `node --test` on the chosen `.test.js` files (e.g. `node --test tests/garmin-import.test.js tests/garmin-proxy.test.js tests/s6-auth-lockout.test.js`). For browser tests, the repository does not vendor Playwright: install it in an isolated test environment if allowed, then use the provided config. No live Garmin or photo calls.
6. Check runtime deploy assembly with `node tools/build-deploy-package.mjs ./build/compact-check` (the current baseline intentionally does NOT ship the Garmin proxy).

## Source and data integrity
- All included original files are copied **byte-for-byte** from the vetted t125u ZIP. App source identifier still reproduces as `9f89031f3312` before any edits. The original source tree has 20 app deploy paths from `DEPLOY-FILES.txt`; all are included here. `tests/fixture-data.zip` is synthetic test data only.
- This is **not the live app source branch** and must not replace live production. Current Home Screen app is P1.4-RC3 `bc52610dea29`; keep it running.
- Preserve the full localStorage key `hyrox.v1`, data version 2, same origin, rollback behavior, backup schema, old historical records and manually entered weight. Never claim a GitHub ZIP upload automatically extracts into files.
- Garmin feature OFF and S9 NO-GO until final QA/owner go-live. Shared owner-code auth S6 must be wired and verified for Garmin and photo before any live activation. Fix F-C2 and F-C3 fail-closed corruption issues. Keep logs/secrets free of real credentials.
- No real user data, provider credentials, payment, public demo, Netlify mutations, GitHub push, or production deployment. Use mocks. Owner approves live separately.
- **Priority order:** complete secure Garmin personal API connection and tests; visible Progress HQ rebrand as separate diff if safe; readiness as separate optional diff; no full multi-program redesign.

## Deliberate omissions / known limitations of this compact upload
- ~300 historical test scripts, previous release manuals, screenshots, raw test logs, and duplicate `food-db*.json` data mirrors were omitted to fit GitHub's upload limit. Thus **do not claim the original 1842-test/full 1407-case regression was rerun on this compact subset**. Grok/Claude will use the full original source and complete regressions after integration.
- A few legacy tests in this subset may depend on files or old vendor builds not included; if so log SKIP with reason, don't silently make files up. The full original archive remains retained by Command Center.
- The original offline import test harness and photo Function share some platform assumptions. Keep `netlify/lib/` and `netlify/functions/` files together. Inspect dependencies instead of importing a different framework.

## Required return
Return a ZIP of updated source with its `src/`, `netlify/`, `deploy/`, tests and a `HANDOVER.md` stating changed files, remaining risk, exact mock/Node/e2e results, and whether the feature remains OFF. Provide a patch/diff against this baseline. Absolutely no production deployment.
