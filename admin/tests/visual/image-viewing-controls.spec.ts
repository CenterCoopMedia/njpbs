import { expect, test } from "./fixtures";
import { openSpecimen } from "./capture";

for (const id of ["image-viewer", "media-favorites-viewer-image", "media-collections-viewer-image"]) {
  for (const width of [1280, 390]) {
    test(`${id} retains image, zoom, pan and metadata while Details switches at ${width}px`, async ({ page }) => {
      await openSpecimen(page, { id, title: "Image view controls", width, presentation: "text" }, { normalizeGeneratedIds: false });
      const viewer = page.getByRole("dialog");
      const toolbar = viewer.getByRole("group", { name: "Image view controls", exact: true });
      const stage = viewer.getByRole("region", { name: "Image viewing surface", exact: true });
      const image = stage.getByRole("img");
      const imageNode = await image.elementHandle();
      await expect(toolbar.getByRole("button", { name: "Fit", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(toolbar.getByRole("status", { name: "Image zoom" })).toHaveText(/^\d+%$/);
      if (width === 1280) await viewer.getByRole("button", { name: "Close image details", exact: true }).click();
      await toolbar.getByRole("button", { name: "View at 100%", exact: true }).click();
      await expect(toolbar.getByRole("status", { name: "Image zoom" })).toHaveText("100%");
      await expect.poll(() => image.evaluate(element => Math.abs(element.getBoundingClientRect().width - (element as HTMLImageElement).naturalWidth))).toBeLessThan(1);
      await toolbar.getByRole("button", { name: "Zoom in", exact: true }).click();
      await expect(toolbar.getByRole("status", { name: "Image zoom" })).toHaveText("125%");
      for (let step = 0; step < 4; step++) await toolbar.getByRole("button", { name: "Zoom in", exact: true }).click();
      await expect(toolbar.getByRole("status", { name: "Image zoom" })).toHaveText("225%");
      // The readout can update before the grid lays out the enlarged image.
      await expect.poll(() => stage.evaluate(element => element.scrollWidth > element.clientWidth && element.scrollHeight > element.clientHeight)).toBe(true);
      await stage.evaluate(element => { element.scrollLeft = 60; element.scrollTop = 40; });
      const before = await stage.evaluate(element => ({ left: element.scrollLeft, top: element.scrollTop }));
      expect(before.left).toBeGreaterThan(0);
      await viewer.getByRole("button", { name: "Details", exact: true }).click();
      const close = viewer.getByRole("button", { name: "Close image details", exact: true });
      const name = viewer.getByRole("textbox", { name: "Name", exact: true });
      await expect(name).toBeVisible();
      if (width === 390) {
        await expect(close).toBeFocused();
        await expect(stage).toBeHidden();
        await expect(toolbar).toBeHidden();
      }
      await name.fill("A retained image draft");
      await close.click();
      await expect(viewer.getByRole("button", { name: "Details", exact: true })).toBeFocused();
      await expect(image).toBeVisible();
      expect(await image.evaluate((element, old) => element === old, imageNode)).toBe(true);
      await expect(toolbar.getByRole("status", { name: "Image zoom" })).toHaveText("225%");
      await expect.poll(() => stage.evaluate(element => ({ left: element.scrollLeft, top: element.scrollTop }))).toEqual(before);
      await stage.focus();
      await stage.press("ArrowRight");
      await expect(viewer).toBeVisible();
      expect(await image.evaluate((element, old) => element === old, imageNode)).toBe(true);
      await viewer.getByRole("button", { name: "Details", exact: true }).click();
      await expect(name).toHaveValue("A retained image draft");
      await close.click();
      await toolbar.getByRole("button", { name: "Fit", exact: true }).click();
      await expect(toolbar.getByRole("button", { name: "Fit", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(toolbar.getByRole("status", { name: "Image zoom" })).toHaveText(/^\d+%$/);
      await expect.poll(() => stage.evaluate(element => ({ left: element.scrollLeft, top: element.scrollTop }))).toEqual({ left: 0, top: 0 });
      await stage.focus();
      await stage.press("Escape");
      await expect(viewer.getByRole("button", { name: "Keep editing", exact: true })).toBeFocused();
      await expect(viewer.getByRole("button", { name: "Discard changes", exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    });
  }
}

for (const naturalWidth of [1200, 4000]) {
  test(`Fit zoom keeps direction and the 25% floor for a ${naturalWidth}px original`, async ({ page }) => {
    await page.route("**/under-the-dome.jpg", route => route.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="${naturalWidth}" height="${naturalWidth * 2 / 3}"><rect width="100%" height="100%" fill="gray"/></svg>` }));
    await openSpecimen(page, { id: "image-viewer", title: "Image zoom direction", width: 390, presentation: "text" }, { normalizeGeneratedIds: false });
    const controls = page.getByRole("group", { name: "Image view controls" });
    const image = page.getByRole("region", { name: "Image viewing surface" }).getByRole("img");
    const before = (await image.boundingBox())!.width;
    const out = controls.getByRole("button", { name: "Zoom out", exact: true });
    if (naturalWidth === 4000) await expect(out).toBeDisabled();
    else {
      await expect(out).toBeEnabled();
      await out.click();
      await expect(controls.getByRole("status", { name: "Image zoom" })).toHaveText("25%");
      await expect.poll(async () => (await image.boundingBox())!.width).toBeLessThan(before);
      await expect(out).toBeDisabled();
    }
    await controls.getByRole("button", { name: "Fit", exact: true }).click();
    await controls.getByRole("button", { name: "Zoom in", exact: true }).click();
    await expect.poll(async () => (await image.boundingBox())!.width).toBeGreaterThan(before);
  });
}

for (const value of ["", "   "]) {
  test(`header Save reveals closed Details for ${value ? "metadata validation" : "native required-field validation"}`, async ({ page }) => {
    await openSpecimen(page, { id: "image-viewer", title: "Image details save", width: 1280, presentation: "text" }, { normalizeGeneratedIds: false });
    const viewer = page.getByRole("dialog");
    const name = viewer.getByRole("textbox", { name: "Name", exact: true });
    await name.fill(value);
    await viewer.getByRole("button", { name: "Close image details", exact: true }).click();
    await expect(name).toBeHidden();
    await viewer.locator(".component-editor-dialog-header").getByRole("button", { name: "Save details", exact: true }).click();
    await expect(name).toBeVisible();
    if (value) await expect(viewer.getByText("Enter a media name.", { exact: true })).toBeVisible();
    else await expect(name).toBeFocused();
  });
}


test("phone resize keeps focus in visible Details when image controls disappear", async ({ page }) => {
  await openSpecimen(page, { id: "image-viewer", title: "Image responsive focus", width: 1280, presentation: "text" }, { normalizeGeneratedIds: false });
  const viewer = page.getByRole("dialog");
  const fit = viewer.getByRole("group", { name: "Image view controls" }).getByRole("button", { name: "Fit", exact: true });
  const stage = viewer.getByRole("region", { name: "Image viewing surface" });
  for (const control of [fit, stage]) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await control.focus();
    await expect(control).toBeFocused();
    await page.setViewportSize({ width: 390, height: 900 });
    await expect(viewer.getByRole("button", { name: "Close image details", exact: true })).toBeFocused();
    await expect(control).toBeHidden();
  }
});


test("Fit keeps its mode control and reports the displayed percentage", async ({ page }) => {
  await openSpecimen(page, { id: "image-viewer", title: "Image fitted scale", width: 390, presentation: "text" }, { normalizeGeneratedIds: false });
  const controls = page.getByRole("group", { name: "Image view controls" });
  const image = page.getByRole("region", { name: "Image viewing surface" }).getByRole("img");
  // Physical displayed width / original pixel width is the viewing-scale invariant.
  const displayedPercent = await image.evaluate(element => Math.round(100 * element.getBoundingClientRect().width / (element as HTMLImageElement).naturalWidth));
  expect(displayedPercent).toBeGreaterThan(0);
  expect(displayedPercent).toBeLessThan(100);
  await expect(controls.getByRole("status", { name: "Image zoom" })).toHaveText(`${displayedPercent}%`);
  await expect(controls.getByRole("status", { name: "Image zoom" })).toHaveAttribute("aria-live", "off");
  await expect(controls.getByRole("button", { name: "Fit", exact: true })).toHaveAttribute("aria-pressed", "true");
  await controls.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(controls.getByRole("button", { name: "Fit", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(controls.getByRole("status", { name: "Image zoom" })).toHaveAttribute("aria-live", "polite");
  await controls.getByRole("button", { name: "Fit", exact: true }).click();
  await expect(controls.getByRole("status", { name: "Image zoom" })).toHaveText(`${displayedPercent}%`);
  await expect(controls.getByRole("status", { name: "Image zoom" })).toHaveAttribute("aria-live", "off");
});

test("zoom reports no scale while the original is loading or unavailable", async ({ page }) => {
  let stopImage: (() => Promise<void>) | undefined;
  await page.route("**/under-the-dome.jpg", route => { stopImage = () => route.abort(); });
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/gallery.html?embed=image-viewer&presentation=text", { waitUntil: "domcontentloaded" });
  const controls = page.getByRole("group", { name: "Image view controls" });
  await expect(page.getByText("Loading original image", { exact: true })).toBeVisible();
  await expect(controls.getByRole("status", { name: "Image zoom" })).toHaveText("--");
  await expect(controls.getByRole("button", { name: "Zoom in", exact: true })).toBeDisabled();
  await expect.poll(() => Boolean(stopImage)).toBe(true);
  await stopImage!();
  await expect(page.getByText("Original image could not be loaded", { exact: true })).toBeVisible();
  await expect(controls.getByRole("status", { name: "Image zoom" })).toHaveText("--");
});
