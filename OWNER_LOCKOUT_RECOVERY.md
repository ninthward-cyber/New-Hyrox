# Owner recovery runbook — shared photo + Garmin auth lockout (S6)

**Status:** documented only. This procedure has not been executed on live Netlify Blobs, and must not be executed as part of this offline work.

**D2 is no longer pending.** The Command Center running decisions document (https://docs.google.com/document/d/1xBtFUixZh_ouXIBFfC0pR89wjPBJpr2wONdTNUPKYZ8) records both owner answers. Quoting that document: "User explicitly answered YES to both in this project, and Command Center readback verified prior entry: accepts risk of third-party induced global photo/Garmin lockout up to 24 h; confirms >=16 randomly generated character code. These are owner attestations, NOT authorization for live photo security changes, Garmin API, Netlify writes, staging/production deploy, key handling, spending, or GitHub publish. Claude MUST NOT re-ask either question. D2 implementation and verified recovery still open."

Consent to a risk is not proof of safety and authorises no deploy, no wiring of this helper into photo-auth, and no live Blobs access.

## What this helper does (when later wired, not now)

- One shared SHA-256 owner-code hash (the existing photo hash). No second scrypt code.
- CAS reservation **before** the hash compare.
- Per-IP: 5 failures in 15 minutes → lock 30 minutes, doubling up to 24 hours.
- Global: 20 failures in 24 hours → lock 1 hour, doubling up to 24 hours.
- After **7 days** with no lock in force (`now` is at least 7 days after `until`), `nextLockMs` decays back to the base length (30 min per-IP, 1 h global).
- Store failures and exhausted stale-etag retries fail closed with the **same** constant 429 body `{"ok":false,"code":"RATE_LIMITED"}`.
- Thresholds and keys live in `netlify/lib/auth-lockout-shared.mjs` (ESM, importable from the deploy package). Keys are `lock/ip/<sha256(ip)…>` and `lock/global`.

## Recovery (do not run on live Blobs in this sprint)

If the owner is locked out after a future approved deploy:

1. Confirm the site and the Blobs store name (`hyrox-photo` today for photo-auth; do not invent a second store).
2. From a trusted machine with the Netlify CLI the owner already has, list lock keys (exact command, not executed here):

   `netlify blobs:list hyrox-photo --prefix lock/`

   Syntax verified against official public Netlify CLI docs only on 24 Nov 2026 (Asia/Qatar), not executed, and with no Netlify access: `netlify blobs:list <store>` accepts `--prefix` and `netlify blobs:delete <store> <key>` is the documented delete form. Both commands are marked Beta in the official docs (https://cli.netlify.com/commands/blobs/ and the v17 snapshot https://v17-17-0--cli.netlify.com/commands/blobs/). Agents must not list, delete, or otherwise access live Blobs.

   Inspect `until` timestamps in Asia/Qatar.
3. To recover: delete the affected `lock/ip/…` key and, if the global tier is locked, `lock/global`:

   `netlify blobs:delete hyrox-photo lock/global`

   (and the matching `lock/ip/…` key). This is a deliberate unlock. Do not download or export other Blobs keys.
4. After unlock, sign in with the existing owner code. If the code may have been exposed, rotate the SHA-256 hash in env (same scheme, not a second KDF) and store the new hash only. **Changing the owner-code hash in env needs a redeploy** for the function to see the new value; editing the env alone is not enough if the running function has already started.
5. Record the time (Asia/Qatar), which key was deleted, and who did it.

This runbook is not a live Blobs access grant. S6 tests use `createFakeStore()` only. A demonstrated Blobs UI/CLI recovery is still required before any release that wires this helper.

## Netlify plan and Garmin key scope at go-live (owner-performed, after approval)

Owner confirmation **t110u** (24 Nov 2026): the Netlify team is on a **Pro** plan. This is recorded here from the owner's confirmation. Agents must not query, change, or inspect the Netlify plan, site, or environment.

At go-live, after explicit owner approval and performed by the owner (not by an agent in this offline pass): the Garmin key environment variable must be **scoped to Functions only** (not to the build environment, not to a public or site-wide client-visible context). That scoping is not done in this candidate and is not authorization to set, read, or deploy any key now. S9 live remains NO-GO.
