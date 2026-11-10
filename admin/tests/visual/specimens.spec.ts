import { readFileSync } from "node:fs";
import { expect, test } from "./fixtures";
import { visualSpecimenName } from "../../src/lib/visual-specimens";
import { specimenCapturePairs } from "./specimen-selection";
import { openSpecimen } from "./capture";
import { assertControlDesign } from "./control-contract";

for (const pair of specimenCapturePairs) {
  const name = visualSpecimenName(pair);
  test(`${pair.id} — ${pair.presentation} controls at ${pair.width}px`, async ({
    page,
  }) => {
    await openSpecimen(page, pair);
    await assertControlDesign(page);
    await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true });
  });
}

test("post-metadata waits for a late font before fitting control glyphs", async ({ page }) => {
  let releaseFont!: () => void;
  const fontGate = new Promise<void>(resolve => { releaseFont = resolve; });
  await page.route("https://media.njpbs.org/cms-media/fonts/*/PBSSans.woff2", async route => {
    await fontGate;
    await route.fulfill({ contentType: "font/ttf", headers: { "access-control-allow-origin": "*" },
      body: readFileSync(new URL("../../../site/src/assets/pdf-fonts/PublicSans-Regular.ttf", import.meta.url)) });
  });
  const fontRequested = page.waitForRequest("https://media.njpbs.org/cms-media/fonts/*/PBSSans.woff2");
  const opening = openSpecimen(page, {
    id: "post-metadata", title: "Post metadata", width: 1280, presentation: "text",
  });
  try {
    await fontRequested;
    // The controls must not cache fallback glyphs before their face is ready.
    await expect(page.locator("#gallery-root")).toBeEmpty();
  } finally {
    releaseFont();
  }
  await opening;
  await assertControlDesign(page);
  expect(await page.evaluate(() => [...document.fonts].some(font => font.family === "PBS Sans" && font.weight === "400" && font.status === "loaded"))).toBe(true);
  await expect(page).toHaveScreenshot("post-metadata--text--1280w.png", { fullPage: true });
});

test("post-metadata still mounts when PBS Sans fails", async ({ page }) => {
  await page.route("https://media.njpbs.org/cms-media/fonts/*/PBSSans.woff2", route => route.abort());
  await openSpecimen(page, {
    id: "post-metadata", title: "Post metadata", width: 1280, presentation: "text",
  });
  const assignee = page.getByRole("combobox", { name: "Assigned staff member", exact: true });
  await expect(assignee).toBeVisible();
  await expect(assignee).toHaveValue("ed");
});
