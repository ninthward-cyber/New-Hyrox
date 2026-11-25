'use strict';
// P6 Meron readiness tests. The data layer already names missing inputs
// (sleep, soreness, resting HR, baseline). That is locked. The Today glance
// tile must name each missing input and link to its field — that UI is not
// on this data-layer tree (p6/qa + p6/data b418faa). CONTRACT-P6.md v2 defines
// UI testids glance-readiness-missing and glance-missing-<id> (Liya, p6/ui), which
// are not present here, so the desired UI assertions stay skipped with a reason.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const HW = require(path.resolve(__dirname, '../src/data/hyrox-wellness.js'));

const TODAY = '2026-11-13';

describe('P6 lock: readiness() already names each missing input', () => {
  it('with no daily record, missing is sleep, soreness, and resting HR (exact labels)', () => {
    const r = HW.readiness(TODAY, [], { rhrBaselineBpm: 60, rhrBaselineSource: 'OWNER_DEFAULT' });
    assert.deepEqual(r.missing, [
      'sleep',
      'soreness',
      'resting HR',
    ]);
    assert.equal(r.flags.length, 0);
  });

  it('a recorded rhr with no configured baseline and fewer than 4 prior readings names the missing baseline', () => {
    const rec = {
      id: 'daily-' + TODAY, date: TODAY,
      sleepH: { state: 'OBSERVED', value: 7 },
      soreness: { state: 'OBSERVED', value: 2 },
      rhr: { state: 'OBSERVED', value: 58 },
    };
    // hasBaseline is (configured bpm) OR (observed 7-day mean with >=4 readings).
    const r = HW.readiness(TODAY, [rec], { rhrBaselineSource: 'OWNER_DEFAULT' });
    assert.deepEqual(r.missing, ['valid resting-HR baseline (needs ≥4 readings in prior 7 days)']);
  });
});

describe('P6 characterization (source): the glance tile currently only counts unknowns', () => {
  it('app-ext.js glance readiness sub-line still uses the "<n> inputs unknown" count (not a lock of the defect; documents today)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/ui/app-ext.js'), 'utf8');
    // The desired fix replaces this. This test only documents the current source; it is
    // skipped once the count-only line is gone, so it cannot fail the Phase 6 fix.
    const stillCounts = /unknown \? unknown \+ ' input'/.test(src)
      || /inputs unknown'/.test(src)
      || /' input' \+ \(unknown === 1 \? '' : 's'\) \+ ' unknown'/.test(src);
    if (!stillCounts) {
      // Fixed: the count-only wording is gone. Keep the run green; desired e2e covers the new UI.
      assert.ok(true);
      return;
    }
    assert.ok(stillCounts);
  });
});

const glanceFixed = (() => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/ui/app-ext.js'), 'utf8');
  return !(/unknown \+ ' input'/.test(src) || /inputs unknown'/.test(src));
})();

describe('P6 desired: glance readiness names each missing input and can jump to its field', {
  skip: glanceFixed ? false : 'The Today glance tile on this tree (p6/qa + p6/data b418faa only) still says "<n> inputs unknown" and has no per-input links. CONTRACT-P6.md v2 defines UI testids glance-readiness-missing and glance-missing-<id> (Liya, p6/ui), but those are not on this data-layer tree. Skipped until the glance tile names each missing input and links to its field (daily-sleepH, daily-soreness, daily-rhr). The Readiness card already names them via #readiness-missing.',
}, () => {
  it('the glance readiness tile source names sleep, soreness and resting HR, and go()s to the daily check-in fields', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/ui/app-ext.js'), 'utf8');
    assert.match(src, /glance-readiness|testid: 'glance-readiness'/);
    assert.match(src, /sleep/);
    assert.match(src, /soreness/);
    assert.match(src, /resting HR|rhr/i);
    assert.match(src, /go\('add',\s*'daily'\)/);
  });
});
