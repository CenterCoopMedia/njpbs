import { expect, test, type Page } from "./fixtures";

async function openComparison(page: Page, kind: string, longValues = false) {
  await page.goto(`/revision-timezone-fixture.html?kind=${kind}&values=${longValues ? "long" : "short"}`);
  await page.locator(".revision-list").waitFor({ state: "attached" });
  const history = page.getByRole("button", { name: "Revision history", exact: true });
  if (!(await history.isVisible())) {
    await page.getByRole("button", { name: "More document actions", exact: true }).click();
  }
  await history.click();
  await page.getByRole("button", { name: "Inspect version 9", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Changes in version 9", exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function valueFragments(page: Page) {
  return page.locator(".revision-field-change dd").evaluateAll(cells => cells.flatMap(cell => {
    const box = cell.getBoundingClientRect();
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    const words: { text: string; lines: number; overflow: number }[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest(".revision-value-label")) continue;
      for (const match of node.textContent!.matchAll(/\S+/g)) {
        const range = document.createRange();
        range.setStart(node, match.index!);
        range.setEnd(node, match.index! + match[0].length);
        const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
        if (rects.length) words.push({
          text: match[0],
          lines: new Set(rects.map(rect => rect.y)).size,
          overflow: Math.max(...rects.map(rect => Math.max(box.left - rect.left, rect.right - box.right))),
        });
      }
    }
    return words;
  }));
}

for (const kind of ["page", "post"]) {
  for (const width of [390, 1280]) {
    test(`${kind} revision values keep whole words at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await openComparison(page, kind);
      const words = await valueFragments(page);
      expect(words.map(word => word.text)).toEqual(expect.arrayContaining(["Earlier", "sample", "headline", "Not", "set"]));
      expect(words.filter(word => word.lines > 1 || word.overflow > 0.5)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);

      await openComparison(page, kind, true);
      const longWords = await valueFragments(page);
      expect(longWords.map(word => word.text)).toEqual(expect.arrayContaining(["complete", "words", "narrow", "panel"]));
      // Ordinary words stay whole. Long unbroken values may wrap inside the cell.
      expect(longWords.filter(word => (word.text.length < 40 && word.lines > 1) || word.overflow > 0.5)).toEqual([]);
      for (const token of ["a".repeat(100), "b".repeat(100)]) {
        expect(longWords.find(word => word.text === token)?.lines).toBeGreaterThan(1);
      }
      await expect(page.getByRole("heading", { name: "Blocks", exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    });
  }
}
