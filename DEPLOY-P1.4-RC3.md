# P1.4-RC3: deploy and rollback (owner only, after the owner's explicit go-ahead)

**This package is not deploy approval and not approval of Block 2 training content.** Nobody but the owner deploys.

**Status 23 Nov 2026:** Claude's independent QA of P1.4-RC2 is done (CHANGES-P1.4-RC3.md). P1.4-RC3 is the corrected candidate: **GO for owner device review only.** It is not a release decision. Production stays on P1.3-RC3 (`b1de280e2a65`) until the owner decides otherwise.

P1.4-RC3 is P1.4-RC2 plus the fixes from Claude's independent QA (CHANGES-P1.4-RC3.md): photo + note matching, the meal-draft "restored" banner, and three Export for AI Coaching corrections. P1.4-RC2 was P1.4-RC1 plus Sprint B2 (unsaved meal draft recovery, owner decision M1; CHANGES-P1.4-RC2.md and CHANGES-SPRINT-B2-MEAL-DRAFT.md). P1.4-RC1 was P1.3-RC3 plus the Combined Value Sprint (CHANGES-P1.4-RC1.md):
- **A:** photo + note are one meal.
- **B:** workout draft recovery.
- **C:** the future-integrations fold.
- **D:** Export for AI Coaching.
- **B2 (new in RC2):** an unfinished meal is kept on this device in one new UI-only key `hyrox.ui.meal-draft` and offered with Resume / Discard.

Before you deploy:
- The live build is P1.3-RC3, source `b1de280e2a65` (owner-confirmed 23 Nov 2026). Still check A before anything else; if it shows something different, stop and report.
- Site: `hyrox-phase7-private-test` (ID `99f0deb7-0526-46f6-b432-9c3bfc2c86d2`, origin https://hyrox-phase7-private-test.netlify.app).
  - It is the same origin as before, so saved data stays.
  - Never deploy to another origin to "test with real data". Never clear site data.
- Zip: `hyrox-app-p1-4-rc3-deploy.zip`, sha256 `8f21d88f8aec08d0351889487caa4c14692756a6031a25bde512f38bb2daadc7`.
  - **Source id `bc52610dea29`.**
  - Every file's sha256 is in `SHA256SUMS-p1-4-rc3.txt`.
  - The zip unpacks to one folder, `hyrox-p1-4-rc3-deploy/`.
- No env change, no migration, data version 2. ONE new UI-only storage key, `hyrox.ui.meal-draft` (an unsaved meal on this device; never in hyrox.v1 or a backup).
  - 19 static app files; one is new: `src/data/hyrox-coach-export.js`.
  - The photo function's prompt and request changed (A).
  - The key, model, caps, reserve and origin checks did not change.
- **Timing:** Block 2 benchmark 11 Dec, first start Mon 14 Dec. Do not deploy in that week.

## A. Read-only: confirm what is live now
Settings → About this build on the Home Screen icon. If it shows a source id, compare it with this table; otherwise use
Netlify → site → Deploys → Published deploy → file browser sizes:
| Source id | `src/ui/app-ext.js` | `src/ui/style.css` | Live build |
|---|---|---|---|
| `bc52610dea29` | 427372 | 46015 | P1.4-RC3 (this candidate) |
| `bcbc7b4d2959` | 425996 | 46015 | P1.4-RC2 (Grok; superseded by RC3, never deployed unless you did) |
| `f7f66257b5fa` | 408364 | 46015 | P1.4-RC1 (never deployed unless you did) |
| `b1de280e2a65` | 381646 | 45241 | P1.3-RC3 (expected: the live build) |
| `686c3be0836b` | 381896 | 45241 | P1.3-RC2 (never approved for release) |
| `d0d7d8ab86a1` | 378757 | 44680 | P1.3-RC1 (Grok; never approved for release) |
| `3079cb300d1f` | 331044 | 42553 | P1.1-RC2 |
| `6c43fa133f2b` | 329333 | 42553 | P1.1-RC1 |
| shown | 308980 | 42553 | P0-RC3 |
| none | 303150 | 42154 | RC2 |
| none | 302942 | 42154 | RC1 |
| none | 258287 | 41683 | Claude P11.2 |
| none | 223896 | 39561 | Claude P11 |
| anything else | | | stop and report |
Write down the published deploy ID: it is the fastest rollback target.

## B. Backup first (mandatory)
iPhone → the **Home Screen icon** → Settings → **Export JSON backup**. Keep the file and check it is in Files. Do this before a draft deploy too, and again before any production change. Never clear the phone's website data.

## C. Deploy
```powershell
cd $HOME\Downloads
Get-FileHash .\hyrox-app-p1-4-rc3-deploy.zip -Algorithm SHA256   # must equal its line in SHA256SUMS-p1-4-rc3.txt, otherwise STOP
Expand-Archive .\hyrox-app-p1-4-rc3-deploy.zip -DestinationPath .\hyrox-p1-4-rc3 -Force
cd .\hyrox-p1-4-rc3\hyrox-p1-4-rc3-deploy
npm ci
npx netlify-cli login
npx netlify-cli sites:list --json | ConvertFrom-Json | Where-Object { $_.id -eq '99f0deb7-0526-46f6-b432-9c3bfc2c86d2' } | Select-Object name, url, id
# must show hyrox-phase7-private-test, otherwise STOP
npx netlify-cli deploy --site 99f0deb7-0526-46f6-b432-9c3bfc2c86d2 --dir publish --functions netlify/functions --message "P1.4-RC3 draft"
```
Draft URL (new Safari tab, not the icon): synthetic data only, quick look, then clear that tab's website data. Then, only
with your explicit go-ahead, production:
`npx netlify-cli deploy --prod --site 99f0deb7-0526-46f6-b432-9c3bfc2c86d2 --dir publish --functions netlify/functions --message "P1.4-RC3"`.

## D. Smoke test on the Home Screen icon (real iPhone; all browser tests ran in Chrome emulation, not Safari)

Run DEPLOY-P1.3-RC3.md section D steps 1–14 first. Step 2 now expects `Build P1.4-RC3 · source bc52610dea29`. Then:

15. **Photo + note (A).** Do this only if you choose to spend one photo analysis; it is a paid call.
    1. Take a photo with a note that names two foods.
    2. Check that every named food is listed once, with where it came from.
    3. A food that is not matched shows "Not accounted for". Confirm stays blocked until you add or acknowledge it.
    4. *RC3:* the owner's case — photo of strawberry yogurt, note "3 eggs, 2 pork patties and strawberry yogurt". Expect yogurt once, and eggs and pork patties either listed (marked as from your note) or flagged "Not accounted for". Check the egg and patty **portions**: the app does not compare the quantity in your note ("3 eggs") with the item's portion. Unknown values must show as unknown, never 0.
    5. *What the live model returns is unverified:* no paid call was made in QA.
16. **Workout draft (B).**
    1. Start a workout, type a title, then close the app from the app switcher.
    2. Reopen. The yellow note says "You have an unsaved workout…".
    3. Tap **Resume unsaved workout**, then **Save**. There is exactly one workout, and the note is gone.
    4. Repeat, but choose **Discard… → Yes**. Nothing is saved.
17. **Settings (C).** "Advanced / Future integrations (5, none active)" is closed. Open it: every item says "Not active". Photo analysis still works.
18. **Export for AI Coaching (D).** Settings → Export for AI Coaching → Last 14 days → **Create snapshot**.
    1. The iPhone share sheet should appear. Choose **Save to Files** and save it in your private Drive folder.
    2. The app must say "handed to the share sheet". It never says "uploaded", "synced" or "saved to Drive".
    3. Open the file in Files. It is a `.json` named `hyrox-coaching-YYYYMMDD-HHMMSS-xxxx.json`.
    4. Cancel once. The app says "Share cancelled", and the snapshot stays ready with **Share again**, **Download instead** and **Discard**.
    4a. *RC3:* under "What to include" the panel says names are always included. Open the saved file: `steps.daily` rows carry `garminIntensityMin` for days where you typed Garmin minutes (your number, unchanged), and `null` where you did not.
    4b. *RC3:* if the iPhone cannot share the file, the app downloads it instead, says so, and offers **Download again** (no "Share again").
    5. *This is the first real test of the share sheet with a JSON file (CE-D-02).*
19. **Restore refuses a snapshot.** Settings → Restore → pick the coaching JSON. It is refused as "not a HYROX tracker backup", and nothing changes.
20. **Unsaved meal (B2, new in RC2).**
    1. Add → Meal → Type it: type a description and one item with a portion. Do NOT confirm. Close the app from the app switcher.
    2. Reopen the Home Screen icon. Today shows "You have an unsaved meal on this device…" with **Resume unsaved meal** and **Discard…**. The day totals did not change.
    3. **Resume**: the description, item and portion are back. **Confirm I ate this**: exactly one meal; the note is gone.
    4. Repeat with a photo attached (no analysis needed): after reopening, the note says the photo must be attached again; Resume shows no photo.
    5. Repeat and choose **Discard… → Yes, discard it**: nothing is saved.
    5a. *Owner decision 23 Nov:* type a meal, tap **Save draft** (then repeat with **I ate this (confirm later)**). Close and reopen: Today offers NO "unsaved meal" note (the local copy was cleared because the record was saved), the day totals did not change, and History shows the meal with **Review & confirm**. Open it, change a number, **Confirm I ate this**: exactly one meal, counted once.
    5b. *RC3:* Resume an unsaved meal, switch from "Type it" to "Describe it", choose **Discard it**: the form is blank and there is no "Unsaved meal restored" banner.
    5c. *Known limit:* in **Add foods**, a food you added with "Add to meal" is kept; a search or a quantity you typed but did not add is lost if the app is closed (it is kept when you only switch tabs).
    6. *First real test of iOS `pagehide` saving when the app is swiped away (not verifiable in Chrome emulation).*

## E. Rollback (no env change, no migration)
Export a backup first. Fastest: Netlify → Deploys → the deploy ID from A → Publish deploy. From a zip (check the hash; same
`npm ci` + `deploy --prod` as in C):
| Order | Target | SHA256 |
|---|---|---|
| 0 | **P1.3-RC3** `hyrox-app-p1-3-rc3-deploy.zip` — the live build today and the rollback target (Export for AI Coaching and the A/B/C changes disappear; all data stays stored; an unsaved meal draft is ignored but stays stored) | `b59332a2162ec2d7f4b5ce79c538ccdf34d72ace2df4d57a28229fdaead82c17` |
| 1 | P1.1-RC2 `hyrox-app-p1-1-rc2-deploy.zip` (coach and closeout disappear; their data stays stored) | `56f7a2c12c998d0c48ce9632764cf77454bd89e56ffab6f5f3411d60ccb2e143` |
| 2 | P1.1-RC1 `hyrox-app-p1-1-rc1-deploy.zip` (F-1 present again) | `661aa5b546a72c2e3c9cf54d146da1ac1d00df5280e0e0788b0f3a532833a14c` |
| 3 | P0-RC3 `hyrox-app-p0-rc3-deploy.zip` | `34251d47a6978d80ddac6f4fa157399c8163f083816ea02002e5822fee1593cb` |
| 4 | RC2 `hyrox-app-rc2-deploy.zip` | `3662afd4c1a059a9a2935d6152d6620c44bf23c38cb4032a1361a3ee1d5153cb` |
| 5 | RC1 `hyrox-app-rc1-deploy.zip` | `129583156454de49c3acbf5e2a4d7bae08124ac1862c982f6c6e7b646f409d7c` |
| 6 | Claude P11.2 `hyrox-app-phase11-2-deploy-claude.zip` | `c85d82479e02a6e20a585ac9b9a9418b4ba736792cc98136e011f403b1b85e61` |
P1.4-RC3 rollback was re-run by Claude on P1.3-RC3, P1.1-RC2, P0-RC3, RC2 and Claude P11.2 app copies (Chrome emulation, CHANGES-P1.4-RC3.md). P1.4-RC3 changed no stored shape against RC2, so the RC2 statement holds (CHANGES-P1.4-RC2.md QA-G6): older builds ignore `hyrox.ui.meal-draft` harmlessly (never shown, never counted, never in their backups, left byte-identical); back on P1.4-RC2/RC3 the unsaved meal is still offered with Resume. P1.4-RC1 rollback, still valid (QA-F6): RC3, P1.1-RC2, Claude P11.2 and RC1 open P1.4-RC1 storage with every
record, export it in their backup, restore a P1.4-RC1 backup, and keep the A item bases/acknowledgements and the B draft;
P1.4-RC1 opens what they wrote back and restores their backups. Older builds simply ignore the new optional fields.
What an older build does with P1.3 data (tested in Chrome emulation with P1.1-RC2, RC1 and Claude P11.2 app copies; re-run
for P1.3-RC2 in the independent review):
the coach field, My Foods, favourites and the lb preference stay stored, survive that build's own settings save and its
backup export; roll forward again and P1.3 shows the same confirmed target. The older build does not show the coach.
Do not use "Replace the saved settings" (damaged-settings repair) on P11.2 or older: it keeps only the fields that build
knows and would drop the coach (existing caution, DEPLOY-RC2.md section E). Those cautions and DEPLOY-P0-RC3.md section E
still apply.
Rolling back to P1.3-RC1 or RC2 is not recommended; if either is ever live, the stored data is the same shape and P1.3-RC3
reads it unchanged (a below-floor target confirmed in RC2 stays stored and is shown as an amber concern).
