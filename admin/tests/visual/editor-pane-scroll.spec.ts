import { expect, test } from "./fixtures";
import { openSpecimen } from "./capture";

for (const kind of ["page", "post"] as const) {
  test(`${kind} canvas scrolls independently at 1280x900`, async ({ page }) => {
    await openSpecimen(page, { id: `study-reference-${kind}`, title: kind, width: 1280, presentation: "icons" }, { normalizeGeneratedIds: false });
    const canvas = page.locator(".content-area");
    const bars = page.locator(".workspace-editor-document-bar, .workspace-editing-bar");
    const chrome = page.locator(".workspace-chrome");
    const chromeBefore = await chrome.evaluate(element => element.getBoundingClientRect().toJSON());
    const before = await bars.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, Math.min(box.y + 240, 650));
    await page.mouse.wheel(0, 650);
    await expect.poll(() => page.evaluate(() => scrollY + document.querySelector(".content-area")!.scrollTop)).toBeGreaterThan(0);
    const geometry = await page.evaluate(() => {
      const canvas = document.querySelector(".content-area")!;
      return { windowY: scrollY, documentHeight: document.documentElement.scrollHeight,
        viewportHeight: innerHeight, canvasTop: canvas.getBoundingClientRect().top, canvasBottom: canvas.getBoundingClientRect().bottom,
        canvasScrollTop: canvas.scrollTop, canvasHeight: canvas.clientHeight, canvasScrollHeight: canvas.scrollHeight,
        rail: document.querySelector(".sidebar")!.getBoundingClientRect().toJSON(),
        details: document.querySelector(".editor-workspace-pane-details")!.getBoundingClientRect().toJSON() };
    });
    const evidence = process.env.EDITOR_SCROLL_EVIDENCE;
    if (evidence) {
      await page.screenshot({ path: `${evidence}/${kind}-1280.png`, fullPage: false });
      await test.info().attach(`${kind}-scroll.json`, { body: JSON.stringify(geometry, null, 2), contentType: "application/json" });
    }
    expect(geometry.windowY).toBe(0);
    expect(geometry.documentHeight).toBeLessThanOrEqual(901);
    expect(geometry.canvasScrollTop).toBeGreaterThan(0);
    expect(geometry.canvasScrollHeight).toBeGreaterThan(geometry.canvasHeight);
    expect(geometry.canvasTop).toBeCloseTo(chromeBefore.bottom, 0);
    expect(await chrome.evaluate(element => element.getBoundingClientRect().toJSON())).toEqual(chromeBefore);
    expect(geometry.canvasBottom).toBeCloseTo(900, 0);
    expect(geometry.rail.top).toBe(0);
    expect(geometry.rail.bottom).toBe(900);
    expect(geometry.details.bottom).toBeCloseTo(900, 0);
    expect(await bars.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()))).toEqual(before);
  });
}

for (const id of ["shell-editor", "shell-restore-confirmation"] as const) {
  for (const presentation of ["icons", "text"] as const) {
    test(`${id} ${presentation} keeps the 320px phone document within its viewport`, async ({ page }) => {
      await openSpecimen(page, { id, title: id, width: 320, presentation }, { normalizeGeneratedIds: false });
      expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(800);
      const canvas = page.locator(".content-area");
      await canvas.evaluate(element => { element.scrollTop = element.scrollHeight; });
      expect(await page.evaluate(() => scrollY)).toBe(0);
      // An empty archived Post can already fit; populated Home still needs internal scrolling.
      const end = await canvas.evaluate(element => ({
        offset: element.scrollTop, visible: element.clientHeight, extent: element.scrollHeight,
      }));
      expect(end.offset + end.visible).toBeGreaterThanOrEqual(end.extent - 1);
      // Composition moves insertion commands into the editing bar. The
      // document still reaches its end without scrolling the browser shell.
      const bars = page.locator(".workspace-editor-document-bar, .workspace-editing-bar");
      expect((await bars.first().boundingBox())!.y).toBe(0);
    });
  }
}
