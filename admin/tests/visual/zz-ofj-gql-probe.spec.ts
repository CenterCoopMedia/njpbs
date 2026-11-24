import { expect, test } from "./fixtures";

// Temporary CI probe for #606: samples layout each frame around the scroll.
for (let run = 0; run < 20; run++) {
  test(`probe collections scroll geometry ${run}`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 501 });
    await page.goto("/gallery.html?embed=media-collections-list&presentation=text");
    const filter = page.getByRole("button", { name: "Filter, 2 applied" });
    await expect(filter).toBeVisible();
    await expect(page.getByRole("button", { name: /^Retired station IDs/ })).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; });
    const sample = () => page.evaluate(() => new Promise<string[]>(resolve => {
      const seen: string[] = []; let last = ""; let frames = 0; const start = performance.now();
      const read = () => {
        const q = (s: string) => { const e = document.querySelector(s); if (!e) return "-"; const b = e.getBoundingClientRect(); return `${(b.top + scrollY).toFixed(2)}+${b.height.toFixed(2)}`; };
        const chrome = document.querySelector(".media-chrome");
        const value = [`cw=${document.documentElement.clientWidth}`, `sh=${document.documentElement.scrollHeight}`, `y=${scrollY}`,
          `intro=${q(".surface-intro")}`, `chrome=${q(".media-chrome")}`, `pos=${chrome ? getComputedStyle(chrome).position : "-"}`,
          `cls=${chrome?.className}`, `parent=${chrome?.parentElement?.className}`, `sec=${q(".media-toolbar-secondary")}`,
          `filter=${q(".media-toolbar-filter")}`, `row=${q(".media-library-toolbar")}`].join(" ");
        if (value !== last) { seen.push(`${(performance.now() - start).toFixed(0)}ms ${value}`); last = value; }
        if (++frames < 60) requestAnimationFrame(read); else resolve(seen);
      };
      read();
    }));
    const before = await sample();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const after = await sample();
    console.log(`PROBE606 ${run} before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
  });
}
