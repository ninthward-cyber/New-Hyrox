# P1.4-RC3: P1.4-RC2 + fixes from Claude's independent QA — CHANGES + QA record

**Date:** 23 Nov 2026 (Asia/Qatar). **Status: candidate, NOT DEPLOYED. GO for owner device review only; not a release decision.**
Production stays on the owner-confirmed P1.3-RC3 (source `b1de280e2a65`). Nobody but the owner deploys.
All browser results are Chrome mobile emulation at 320 and 390 px. **Not Safari, not a physical iPhone.** Synthetic data only.
No live photo, Garmin or paid call was made. No Netlify, GitHub or Google Cloud write. The Garmin key was never requested or seen.

| | |
|---|---|
| Reviewed input | Grok P1.4-RC2, source `bcbc7b4d2959`, commit `7992c08`; source ZIP sha256 `6885208d…7689` verified; git bundle head equals the ZIP; bundle baseline `aa8d48d` is byte-identical to P1.3-RC3 |
| Release label | `P1.4-RC3` |
| **Source id** | **`bc52610dea29`** (sha256 over the 19 DEPLOY-FILES app files) |
| Deploy ZIP | `hyrox-app-p1-4-rc3-deploy.zip`, sha256 `8f21d88f8aec08d0351889487caa4c14692756a6031a25bde512f38bb2daadc7` (built twice from a clean `git archive`; byte-identical) |
| App-file sizes | `src/ui/app-ext.js` 427372 B, `src/ui/style.css` 46015 B (RC2: 425996 / 46015) |
| App files changed vs RC2 | `src/ai/photo-ai.js`, `src/ui/app-ext.js`, `src/data/hyrox-coach-export.js`, `index.html` (label). Data layer, Block 2, plan, server files: byte-identical |
| Storage | No new key, no data-version change (v2), no migration, no new network call, no env or secret change |

## Commits on top of `7992c08` (oldest first; each separate and revertible)
| Commit | What |
|---|---|
| `4bd9cab` | **A1** photo + note matching (`src/ai/photo-ai.js`); fail-first unit tests; one deliberate assertion re-pointed and marked |
| `bff3080` | **B2-1** stale "Unsaved meal restored" banner (`src/ui/app-ext.js`); browser tests incl. GUARD tests for the owner decision of 23 Nov |
| `b4fa922` | **D1–D3** coaching export (`src/ui/app-ext.js`, `src/data/hyrox-coach-export.js`); fail-first unit and browser tests |
| `efa99c5` | Release label P1.4-RC3, build folder, README-DEPLOY; label tests re-pointed and marked |
| `768993a` | Byte pin of `photo-ai.js` re-pointed and marked (tests only) |
| (docs) | This file and DEPLOY-P1.4-RC3.md. Docs only; source id unchanged |

## Findings fixed in RC3
| ID | Severity | File / line (RC3) | Reproduction on RC2 | Fix | Fail-first test |
|---|---|---|---|---|---|
| A1 | Medium | `src/ai/photo-ai.js` 531–538 (`matches`), 503, split rule | Note "chicken salad, chicken soup"; the model returns only "Chicken soup". RC2 shows nothing "Not accounted for", so the salad is lost without a warning. Same for "2 pork patties" vs "Pork chop". "eggs w/ cheese": cheese never checked. "Greek yoghurt" vs "Greek yogurt": false flag | More than half of a food's words must match unless its own noun matches; "w/" separates foods; one spelling for yogurt | `tests/p1-4-rc3-claude-qa-photo-note.test.js` (2 fail on RC2, 1 guard) |
| D2 | Medium | `src/data/hyrox-coach-export.js` 141–150, 257–263 | Type Garmin intensity minutes in the morning log, create a snapshot: the minutes are not in the file, although its note says they are typed by the owner | `steps.daily[].garminIntensityMin` = OBSERVED value, `null` (not recorded) or INVALID (never 0); label "Steps and intensity minutes" | `tests/p1-4-rc3-claude-qa-export.test.js`; browser spec |
| B2-1 | Low | `src/ui/app-ext.js` 2441 | Resume an unsaved meal → switch "Type it" to "Describe it" → "Discard it": the banner "Unsaved meal restored" stays on the blank meal and on new text | The draft link is reset with the form | `tests/e2e/p1-4-rc3-claude-qa.spec.js` |
| D1 | Low | `src/ui/app-ext.js` 4378–4410 | Where a file cannot be shared, the download fallback runs and the panel still offers "Share again" (which downloads again) | Only "Download again" there; "Share again" + "Download instead" where sharing works | `tests/e2e/p1-4-rc3-claude-qa-export.spec.js` |
| D3 | Low | `src/ui/app-ext.js` 4426 | With "Free-text notes" off, food names, session titles and exercise names still go out; the panel did not say so | One line under "What to include" says it | same spec |

Trade-off of A1, stated plainly: an item named "Pork sausage" no longer covers "2 pork patties" (one acknowledge tap);
"Pork sausage patty" still does. A wrong "not accounted for" costs one tap; a wrong "accounted for" loses a food.

## Findings NOT fixed (open; for owner / Command Center)
| ID | Severity | What | Why not fixed now |
|---|---|---|---|
| A2 | Medium | The quantity in the note is not compared with the item's portion: note "3 eggs", model item "Eggs, 1 egg" is not flagged. The portion is shown for review before Confirm | Needs a design choice (show the note phrase beside the item, or a mismatch rule); a rushed rule would add false warnings |
| A3 | Low | The server does not check that an item marked "from the note" really is in the note. Such items keep their numbers, capped at medium confidence and labelled | Model behaviour; owner review before Confirm is the control |
| A4 | Unknown | What the live model returns for photo + note is unverified | No paid call allowed |
| B2-2 | Low | Add foods: a food added with "Add to meal" is kept in the draft at once. A search or a quantity typed but not yet added survives a tab switch but is lost when the app is closed; Resume opens the meal form, not the foods screen | Small loss, larger change; Grok's interpretation 3 is corrected here |
| B2-3 | Low | While an unsaved meal is still open in the Add tab, Today shows no "unsaved meal" note (it appears after the app is reopened) | Observation; not a data risk |
| Q1 | Unknown | Grok's first sprint stress run gave 291/295. Not reproduced: 295/295 on RC2, 385/385 on RC3, and the three named tests passed 140/140 under 3× and 5× CPU overload. The original failure reasons were not kept, so the cause is unknown, not "box load" | Nothing to fix without evidence |

## Verdicts asked for in the QA brief
| Item | Verdict |
|---|---|
| Interpretation 1: "Save draft" and "I ate this (confirm later)" clear the local copy | **Accept.** Matches the owner decision of 23 Nov. The copy is cleared only after `putRecord` reports a save verified by read-back; a failed save keeps it; the stored record reopens with "Review & confirm", edits, and confirms as one meal (GUARD tests) |
| Interpretation 2: a form returned to its start state removes this session's own stored copy | **Accept.** Only this session's own, not-resumed copy; a waiting earlier draft is never removed; it cannot touch a saved record |
| Interpretation 3: Add-foods quantity kept "once Done adds the item" | **Corrected:** see B2-2 |
| Interpretation 4: a waiting draft blocks auto-save of a new meal | **Accept** (said on screen) |
| `omittedByOwner` instead of `omitted` in the snapshot | **Accept.** The restore code treats an `omitted` key as an emergency-copy marker; the rename keeps a snapshot refused as "not a HYROX backup". Explained in `semantics` |
| Direct Drive upload (OAuth) | **Deferral confirmed.** Not implemented, not added |
| "Share again" after download fallback | **Fixed** (D1) |
| Status table in CHANGES-P1.4-RC2.md | **Confirmed** with these changes: "Share again" → fixed; add A2, A3, B2-2, Q1 above; "Rollback" re-run on five older builds |

## Garmin (design review only; no code, no live connection)
**Verdict: the design is acceptable as a basis, with conditions. NO-GO for any live connection or key handling now.**
Confirmed today from Garmin's own FAQ: personal use only; key shown once; expiry 30/90/180 days or one year; e-mail about a
week before expiry; deleting the key ends its tokens; token by POST with `Authorization: ApiKey …`; tokens last 24 hours;
no refresh tokens. The FAQ says nothing about rate limits, CORS, webhooks or read-only. Grok's Swagger-derived claims
(field names, endpoints, 28 paths) were **not** independently verified by Claude.
Conditions before any implementation is approved:
1. The proxy must share the photo function's wrong-code lockout; otherwise it is a second place to guess the owner code.
2. Count token requests in the server store and stop early (attempts, not only successes); Garmin's limits are unpublished.
3. Accept a token only with a valid expiry in the next 24 hours; otherwise do not cache and do not loop.
4. Fixed Garmin host and paths only; no redirects followed; dates strictly validated; no pass-through endpoint.
5. Return only mapped fields (date, steps, moderate, vigorous, source, timezone); never raw Garmin JSON, key, token or error bodies.
6. Key only in the Netlify Functions environment, production context, entered by the owner; never in chat, source, storage, ZIPs, backups or logs.
7. Status details only after the owner code is accepted.
8. Today's partial day must be marked as in progress and not written as final by default.
9. Reader, coach and export must accept the new source in the same release (an unextended reader shows INVALID, never 0).
10. Owner checks on one known day that moderate + 2 × vigorous equals the number Garmin Connect shows, before trusting imports.

## QA results (P1.4-RC3, clean `git archive`)
| Suite | Result |
|---|---|
| Unit (`node --test tests/*.test.js`) | **1644 tests: 1635 pass, 0 fail, 9 skipped** (the 9 need USDA zips or Phase 7/8 trees that are not on Claude's machine; same 9 as on RC2) |
| Python photo adapter (fake model, no network) | **8 / 8**; live test NOT run |
| Chrome full, 2 workers, retries 0 | **691 passed, 1 skipped (pre-existing zoom proxy test), 0 failed** |
| Sprint + QA specs stress, `--repeat-each 5`, 4 workers | **385 / 385** |
| F-1 stress, `--repeat-each 15` | **240 / 240** |
| Rollback, roll-forward, old-backup round trip on P1.3-RC3, P1.1-RC2, P0-RC3, RC2, Claude P11.2 | **49 / 51.** The 2 others are `p1-1-older-build` on P1.3-RC3 and P1.1-RC2: the test expects kg from a build that does not know the lb preference, and those two builds do know it ("215 lb" = 97.5 kg). Not applicable, not a defect |
| Fail-first on unmodified RC2 | unit 3 fail / 2 guards pass; browser 10 fail / 8 guards pass |
| Baseline of RC2 as delivered (Claude's machine) | unit 1630 pass / 9 skipped / 0 fail; Python 8/8; Chrome 673 pass / 1 skipped; sprint stress 295/295 |
| Re-pointed tests | 1 photo-note assertion, 4 label tests, 1 byte pin — all marked `RE-POINTED by P1.4-RC3`; none deleted |

## Not verifiable here (needs the owner's iPhone)
Safari/WebKit layout and 16 px inputs; Larger Text; VoiceOver; the share sheet with a JSON file and "Save to Files";
the download fallback inside the Home Screen app; auto-save when the app is swiped away (`pagehide`); storage-full
behaviour; real photo + note analysis. The device checklist is DEPLOY-P1.4-RC3.md section D.

## Hard limits kept
No deploy, no push, no credential rotation, no live photo or Garmin call, no spend. Block 2 lock, content and dates
unchanged. localStorage data version 2. Clinical numeric guardrails stay provisional. Photos, owner code and credentials
are never stored in a draft, a snapshot or a backup.
