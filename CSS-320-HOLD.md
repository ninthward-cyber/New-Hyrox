# 320 CSS rule — HOLD for owner iPhone test

Claude's one-line overflow fix stays in `src/ui/style.css` at the end of the file:

```css
.block .entry-title select { min-width: 0; }
```

**Status:** HOLD for the owner's iPhone test. Conditions 1–2 PASS in Chrome emulation (not Safari, not a physical iPhone). Conditions 3–5 (physical iPhone, device backup/rollback, publication approval) remain OPEN / owner-gated.

**One-line revert:** delete `.block .entry-title select { min-width: 0; }` and the HOLD / Claude QA comments immediately above it at the end of `src/ui/style.css`. No other rule depends on it.
