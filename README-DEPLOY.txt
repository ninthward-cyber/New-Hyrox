HYROX Command P1.4-RC3 deploy package (P1.4-RC2 + Claude independent QA fixes of 23 Nov 2026; built on P1.3-RC3, P1.1-RC2, P0-RC3 and RC2)
=========================================================================================================================================
This package is NOT deploy approval and NOT approval of Block 2 training content. Only the owner deploys, after the
owner's explicit go-ahead. Block 2 stays locked by the app's own date rule (draft and preview only before 11 Dec 2026;
approval needs the preview opened for the current draft; Monday start on or after 14 Dec). Nothing in this package
changes that rule, and the app has no date override, flag, query parameter or debug hook.

This folder is NOT a drag-and-drop folder. Dropping it (or a ZIP of it) on the Netlify Deploys page publishes only the
static files and the photo function will NOT exist. Deploy it with the Netlify CLI from this folder:

  npm ci
  netlify deploy --site <YOUR SITE ID> --dir publish --functions netlify/functions --message "P1.4-RC3 draft"
  netlify deploy --prod --site <YOUR SITE ID> --dir publish --functions netlify/functions --message "P1.4-RC3"

Full, exact steps are in DEPLOY-P1.4-RC3.md (delivered next to this ZIP; same steps as DEPLOY-P1.3-RC3.md): find out which build is live (it is NOT assumed),
export a backup first from the Home Screen icon, verify the ZIP hash, deploy a draft, then production, the iPhone smoke
test, and rollback. What changed is in CHANGES-P1.4-RC3.md (Claude independent QA fixes), CHANGES-P1.4-RC2.md (and CHANGES-SPRINT-B2-MEAL-DRAFT.md), CHANGES-P1.4-RC1.md (and CHANGES-SPRINT-A..D), CHANGES-P1.3-RC1.md, CHANGES-P1.3-RC2.md and CHANGES-P1.3-RC3.md.
The first rollback target is P1.3-RC3, the owner-confirmed live build of 23 Nov 2026 (source b1de280e2a65; DEPLOY-P1.3-RC3.md, SHA256SUMS-p1-3-rc3.txt), then P1.1-RC2 (DEPLOY-P1.1-RC2.md,
SHA256SUMS-p1-1-rc2.txt); older targets are listed in DEPLOY-P1.3-RC3.md and DEPLOY-RC2.md.
First-time server setup (restricted OpenAI key, owner code hash, environment variables) is unchanged since Phase 9:
DEPLOY-AND-SECURE-CONFIG-PHASE9.md. P1.4-RC3 (like P1.4-RC2, P1.4-RC1 and P1.3-RC3) needs no environment, secret, key, model, price or cap change and no data
migration (data version 2). After deploying, Settings > About this build shows the release name and a 12-character source
id; it must equal the "source id" line in SHA256SUMS-p1-4-rc3.txt.

Contents
  publish/            the 20 static app files listed in DEPLOY-FILES.txt (index.html, src/ai/photo-ai.js,
                      src/data/food-db.js, src/data/food-db-us.js, src/data/hyrox-fibersodium.js, src/data/hyrox-blocks.js,
                      src/data/hyrox-coach.js, src/data/hyrox-coach-export.js, src/data/hyrox-data.js, src/data/hyrox-foodcalc.js, src/data/hyrox-morning.js,
                      src/data/hyrox-foodsearch.js, src/data/hyrox-nutrition.js, src/data/hyrox-plan.js,
                      src/data/hyrox-wellness.js, src/integrations/stubs.js, src/integrations/garmin-import.js, src/ui/app.js, src/ui/app-ext.js, src/ui/style.css)
  netlify/functions/  food-photo.mjs only. The Garmin proxy endpoint (garmin-personal-proxy*) is left OUT of the deploy package until S7/S9 (pending CC confirmation, Claude decision 2 / Dawit verdict 2). The stub stays in the source tree for offline tests.
  netlify/lib/        function modules (no secrets), including auth-lockout-shared.mjs. garmin-personal-proxy* is not copied. The pre-Garmin P1.4-RC3 package had the 19 static app files plus food-photo.mjs.
  netlify.toml        publish folder, functions folder, /api/food-photo/* routing
  package.json        one dependency: @netlify/blobs (durable budget + rate limit); package-lock.json pins it
  tools/make-owner-code.mjs   generates your owner access code and the hash for Netlify

P1.4-RC3 changes against P1.4-RC2 (Claude independent QA, 23 Nov 2026; three separate commits; app files src/ai/photo-ai.js,
src/ui/app-ext.js, src/data/hyrox-coach-export.js; see CHANGES-P1.4-RC3.md):
  - photo + note: a food named in the note is no longer taken as "accounted for" by an item that only shares a word with it
    ("chicken salad" by "Chicken soup"); "w/" separates foods; yoghurt = yogurt.
  - meal draft: after Resume, switching the input path and discarding no longer leaves "Unsaved meal restored" on the new meal.
  - Export for AI Coaching: "Share again" is not offered where a file cannot be shared ("Download again" instead); the Garmin
    intensity minutes typed in the morning log are in the snapshot under Steps; the panel says names are always included.
  No new storage key, no data-version change, no migration, no new network call, no environment or secret change.

P1.4-RC2 changes against P1.4-RC1 (Sprint B2, owner decision M1, 23 Nov 2026; one separate commit; src/ui/app-ext.js only;
see CHANGES-SPRINT-B2-MEAL-DRAFT.md):
  - an unfinished meal (description, items, portions, quantities, edits) is auto-saved on this device in ONE new UI-only
    key, hyrox.ui.meal-draft (bounded size). On reopening, Today offers Resume or Discard; nothing is restored without Resume.
  - photos, the owner access code and credentials are never stored in it; photos must be attached again after Resume.
  - it is cleared only by a verified save or an explicit Discard; it never counts toward a day total until confirmed.
  - hyrox.v1, data version 2, backups and restore are untouched (backups never include the draft); no migration.
    Older builds ignore the key harmlessly (tested on P1.3-RC3, P1.1-RC2, P11.2 and RC1).

P1.4-RC1 changes against P1.3-RC3 (combined value sprint, 23 Nov 2026; four separate commits; see CHANGES-P1.4-RC1.md):
  - A (photo + note): src/ai/photo-ai.js, netlify/lib/openai.mjs and netlify/lib/handler.mjs changed ON PURPOSE (see
    CHANGES-SPRINT-A-PHOTO-NOTE.md); "byte-identical to RC2" below no longer holds for these three files, which are pinned
    to their sprint hashes in tests/p0-sprint-pins.js. No key, model, price, cap or origin change;
  - B (draft recovery): the unsaved-workout draft (same key hyrox.ui.workout-draft) now says which day it is from, offers
    Resume / Discard, warns about another open tab and about a newer saved session. Meal drafts were NOT persisted in RC1 (added in P1.4-RC2);
  - C (settings): the not-active integration stubs moved into a closed "Advanced / Future integrations" section;
  - D (P1.4): Settings > Export for AI Coaching: a read-only JSON snapshot of chosen categories and dates, handed to the
    iPhone share sheet or downloaded. ONE new file, src/data/hyrox-coach-export.js. No upload, sync, OAuth or network call.
P1.4-RC1 itself added no storage key, no data-version change, no migration.

P1.3-RC3 changes against P1.3-RC2 (src/data/hyrox-coach.js, src/ui/app-ext.js; see CHANGES-P1.3-RC3.md):
  - an own target below the provisional floor is refused (no tick, no clamping); one already stored stays and is flagged;
  - computed estimates are shown rounded to the nearest 50 kcal; suggestions, stored targets and calculations stay exact.

P1.3-RC2 changes against P1.3-RC1 (kept; independent review; src/data/hyrox-coach.js, src/ui/app-ext.js, src/ui/style.css
(rules appended only), index.html; see CHANGES-P1.3-RC2.md):
  - review weeks are Monday-Sunday like the training plan; Monday is review day;
  - planned sessions that were not logged are unknown, never "skipped", and no longer turn the status amber;
  - an own target below the provisional floor is never shown as "on track" and needs an extra tick to confirm;
  - if the coach part of the app fails to load, the app says so instead of quietly showing the provisional reference;
  - the diet reference is 2,400 kcal / protein 190 g (protein floor 170 g); earlier notes that said "carbs 170 g" are corrected.

P1.3-RC1 changes against P1.1-RC2 (kept; index.html, src/ui/app.js, src/ui/app-ext.js, src/ui/style.css (rules appended only)
and ONE new file, src/data/hyrox-coach.js; see CHANGES-P1.3-RC1.md):
  - Home closeout: "All food & drink entered" / "Day is incomplete" for today sit directly under Nutrition on Home.
    History keeps the per-date controls. Nothing is declared automatically;
  - Settings > Nutrition Coach: off until you turn it on. Profile (height, age, sex for the equation, activity), goal,
    your own target with a confirm screen (Cancel writes nothing), history, an approximate starting estimate
    (Mifflin-St Jeor x activity) and, after 3 qualifying weeks of complete food days and weigh-ins, a personal estimate.
    A lower target is only proposed after checks and is never applied without your confirmation;
  - Home status line (coach on only) for the last completed week, and Trends > Weekly review (coach).
  All thresholds and factors are provisional and listed as owner decisions in CHANGES-P1.3-RC1.md.
No new storage key: the coach is one optional field (nutritionCoach) inside the existing settings record; older builds
keep it untouched (tested). Restore preview says when a backup would replace or remove it.

P1.1-RC2 change against P1.1-RC1 (kept; see CHANGES-P1.1-RC2.md):
  - F-1 fixed: a quantity typed in Add foods can no longer be lost to a late search redraw and stored as 1x.
    (Correction to its notes: when you tap a result before the list caught up, the list is redrawn at the tap.)

P1.1-RC1 changes against P0-RC3 (kept; src/data/hyrox-morning.js and UI; see CHANGES-P1.1-RC1.md): Add > Morning log,
Garmin intensity minutes as typed (weekly sum, never estimated), Settings > Units kg or lb (stored weights stay kg).
In P1.1, Today (Home) was unchanged; P1.3 adds the closeout and the coach status line there.

P0-RC3 changes against RC2 (kept; see CHANGES-P0-RC3.md and DEPLOY-P0-RC3.md): one meal surface on Today, the diary on
Add > Meal, Settings > About this build, the backup download note.
The data layer, nutrition, plan, Block 2 lock (src/data/hyrox-blocks.js), wellness, estimator, food data, photo AI
and every netlify/ file are still byte-identical to RC2 (checked against tests/fixtures/rc2-unchanged-pins.json).
src/ui/style.css keeps every P0-RC3 rule byte-for-byte; P1.3 only appends its own rules at the end.

Nothing in this package contains a secret. Never serve or deploy ai-test-backend/, tests/ or test-results/.
