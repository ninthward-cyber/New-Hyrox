'use strict';
// Chrome mobile emulation, not Safari/WebKit, and not a physical iPhone.
// S5 preview renderer: textContent only, no pre-ticks, no Tick-all, no "connected".
const { test, expect } = require('@playwright/test');

async function mount(page, width) {
  await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
  await page.goto('./');
  await page.addScriptTag({ path: require('path').resolve(__dirname, '../../src/integrations/garmin-import.js') });
  const report = await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'garmin-preview-host';
    document.body.appendChild(host);
    const G = window.HyroxGarminImport;
    const model = {
      forceRender: true,
      items: [
        { status: 'New', date: '2026-11-16', collection: 'workouts', activity: { activityName: '</script>Easy run' } },
        { status: 'IN_PROGRESS', date: '2026-11-23', collection: 'steps', writable: false }
      ]
    };
    const r = G.renderPreview(host, model);
    const boxes = [...host.querySelectorAll('input[type="checkbox"]')];
    return {
      ok: r.ok, preTicked: r.preTicked, tickAll: r.tickAll,
      usedTextContent: r.usedTextContent,
      html: host.innerHTML,
      text: host.textContent,
      connected: /connected/i.test(host.textContent),
      checked: boxes.filter((b) => b.checked).length,
      disabledInProgress: boxes.some((b) => b.disabled),
      injectedScript: host.innerHTML.includes('<script>')
    };
  });
  return report;
}

for (const width of [320, 390]) {
  test(`Chrome emulation, not Safari — Garmin preview at ${width}px: textContent, no pre-tick, no connected`, async ({ page }) => {
    const r = await mount(page, width);
    expect(r.ok, 'renderer ok').toBeTruthy();
    expect(r.preTicked).toBeFalsy();
    expect(r.tickAll).toBeFalsy();
    expect(r.checked).toBe(0);
    expect(r.connected).toBeFalsy();
    expect(r.injectedScript).toBeFalsy();
    expect(r.text).toContain('Easy run');
    expect(r.disabledInProgress).toBeTruthy();
  });
}
