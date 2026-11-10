import { expect, test } from "./fixtures";
import { join } from "node:path";

for (const entry of ["editor", "readonly", "details"] as const)
for (const width of entry === "editor" ? [390, 1280, 1920] : [390, 1280])
for (const height of entry === "editor" && width === 1920 ? [700] : [1000]) {
  test(`editor rights review from ${entry} retains the draft at ${width}px${height === 1000 ? "" : ` with ${height}px height`}`, async ({ page }) => {
    const readonly = entry === "readonly";
    await page.setViewportSize({ width, height });
    await page.route("**/*", route => new URL(route.request().url()).origin === new URL(test.info().project.use.baseURL!).origin
      ? route.continue() : route.abort());
    let checking = false;
    let writes = 0;
    let asset = { id: "rights-video", sourceId: "video-library", name: "A walk along the New Jersey boardwalk",
      description: null, originalName: "boardwalk.mp4", mimeType: "video/mp4", kind: "video", sizeBytes: 1000,
      preview: "browser", viewingCopy: { state: "ready" }, credit: "NJ PBS", license: null as string | null,
      rightsStatus: "pending", tags: [], version: 1, createdAt: null, updatedAt: null };
    await page.route("**/cmsListSourceMedia", route => checking
      ? route.fulfill({ json: { success: true, records: [asset], hasMore: false, nextCursor: null, total: 1 } })
      : route.fulfill({ status: 503, json: { error: "Local rights read unavailable" } }));
    await page.route("**/cmsListMediaSources", route => route.fulfill({ json: { success: true, sources: [{
      id: "video-library", label: "Videos", description: "Local fixture", mediaKind: "video", canBrowse: true,
      canUpload: false, canEditMetadata: !readonly, canRequestProduction: false,
    }] } }));
    await page.route("**/cmsUpdateSourceMediaMetadata", route => {
      const request = route.request().postDataJSON();
      expect(readonly).toBe(false);
      expect(request).toMatchObject({ sourceId: "video-library", assetId: asset.id, expectedVersion: 1,
        changes: { rightsStatus: "complete", credit: "NJ PBS News", license: "Station owned" } });
      expect(Object.keys(request.changes).sort()).toEqual(["credit", "license", "rightsStatus"]);
      writes++;
      asset = { ...asset, ...request.changes, version: 2 };
      return route.fulfill({ json: { success: true, asset } });
    });
    await page.goto("/media-rights.html");
    await page.evaluate(() => document.fonts.ready);
    const title = page.getByRole("textbox", { name: "Headline", exact: true });
    await title.fill("My unsaved boardwalk headline");
    const video = page.locator(".block-card-video");
    const warning = video.locator(".editor-resource-warning");
    await expect(warning).toContainText("could not be checked");
    let review = warning.getByRole("button", { name: "Review", exact: true });
    let returnTarget = video;
    if (entry === "details") {
      await video.getByRole("button", { name: /^Edit uploaded video/ }).click();
      returnTarget = page.locator(".video-block-editor:visible");
      review = returnTarget.getByRole("button", { name: "Review rights", exact: true });
      await expect(review).toBeVisible();
      if (process.env.EDITOR_RIGHTS_EVIDENCE) await page.screenshot({
        path: join(process.env.EDITOR_RIGHTS_EVIDENCE, `details-${width}.png`), fullPage: true, animations: "disabled", caret: "hide", scale: "css",
      });
    }
    await review.scrollIntoViewIfNeeded();
    const scroll = await page.locator(".content-area").evaluate(element => element.scrollTop);
    checking = true;
    await review.click();
    const dialog = page.getByRole("dialog", { name: "Video rights", exact: true });
    if (process.env.EDITOR_RIGHTS_EVIDENCE && process.env.EDITOR_RIGHTS_BEFORE) {
      await expect(page.locator(".video-block-editor:visible").getByRole("textbox", { name: "Video title", exact: true })).toBeVisible();
      await page.screenshot({ path: join(process.env.EDITOR_RIGHTS_EVIDENCE, `${readonly ? "readonly" : "editor"}-${width}.png`),
        fullPage: true, animations: "disabled", caret: "hide", scale: "css" });
    }
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(asset.name);
    expect(await dialog.evaluate(element => element.matches(":modal"))).toBe(true);
    await expect(page.locator(".content-area")).toHaveJSProperty("scrollTop", scroll);
    if (readonly) {
      await expect(dialog).toContainText("permission to edit media");
      await expect(dialog.getByRole("button", { name: "Save rights", exact: true })).toHaveCount(0);
      await expect(dialog.locator("footer").getByRole("button", { name: "Close", exact: true })).toBeVisible();
      await expect(dialog).toContainText("NJ PBS");
    } else {
      await expect(dialog.getByLabel("Credit", { exact: true })).toHaveValue("NJ PBS");
      await dialog.getByRole("combobox", { name: "Rights review", exact: true }).selectOption("complete");
      await dialog.getByLabel("Credit", { exact: true }).fill("NJ PBS News");
      await dialog.getByLabel("License", { exact: true }).fill("Station owned");
    }
    if (process.env.EDITOR_RIGHTS_EVIDENCE && !process.env.EDITOR_RIGHTS_BEFORE && entry !== "details") await page.screenshot({
      path: join(process.env.EDITOR_RIGHTS_EVIDENCE, `${readonly ? "readonly" : "editor"}-${width}.png`), fullPage: true,
      animations: "disabled", caret: "hide", scale: "css",
    });
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    for (let step = 0; step < 8; step++) await page.keyboard.press("Tab");
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
    if (!readonly) {
      await dialog.getByRole("button", { name: "Save rights", exact: true }).click();
      await expect(dialog.getByRole("status")).toContainText("Video rights saved.");
      await expect(warning).toHaveCount(0);
      await expect(page.getByText("Rights need review", { exact: true })).toHaveCount(0);
    }
    if (readonly) await dialog.locator("footer").getByRole("button", { name: "Close", exact: true }).click();
    else {
      await dialog.getByRole("heading", { name: "Video rights", exact: true }).focus();
      await page.keyboard.press("Escape");
    }
    await expect(dialog).toHaveCount(0);
    await expect(readonly || entry === "details" ? review : returnTarget).toBeFocused();
    await expect(title).toHaveValue("My unsaved boardwalk headline");
    const maxScroll = await page.locator(".content-area").evaluate(element => element.scrollHeight - element.clientHeight);
    // Removing the saved warning can shorten the document below the old position.
    // The shorter viewport separately proves exact retention without this browser clamp.
    if (height === 700) expect(maxScroll).toBeGreaterThanOrEqual(scroll);
    await expect(page.locator(".content-area")).toHaveJSProperty("scrollTop", Math.min(scroll, maxScroll));
    expect(await page.evaluate(() => window.__RIGHTS_EDITOR_FIXTURE__?.postSaves)).toBe(0);
    expect(writes).toBe(readonly ? 0 : 1);
  });
}

for (const width of [390, 1280]) test(`missing-video Review keeps replacement Details at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.route("**/*", route => new URL(route.request().url()).origin === new URL(test.info().project.use.baseURL!).origin
    ? route.continue() : route.abort());
  await page.route("**/cmsListSourceMedia", route => route.fulfill({ json: { success: true, records: [], hasMore: false, nextCursor: null } }));
  await page.route("**/cmsUpdateSourceMediaMetadata", () => { throw new Error("Missing-video review must not write rights"); });
  await page.goto("/media-rights.html");
  const title = page.getByRole("textbox", { name: "Headline", exact: true });
  await title.fill("Keep this unsaved headline");
  const warning = page.locator(".block-card-video .editor-resource-warning");
  await expect(warning).toContainText("This video is no longer in the media library. Choose another video.");
  await warning.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Video rights", exact: true })).toHaveCount(0);
  const details = page.locator(".video-block-editor:visible");
  await expect(details.getByRole("button", { name: "Choose a different video", exact: true })).toBeEnabled();
  await expect(details.getByRole("textbox", { name: "Video title", exact: true })).toBeVisible();
  await expect(details.getByRole("button", { name: "Review rights", exact: true })).toHaveCount(0);
  await expect(title).toHaveValue("Keep this unsaved headline");
  expect(await page.evaluate(() => window.__RIGHTS_EDITOR_FIXTURE__?.postSaves)).toBe(0);
});

for (const width of [1280]) test(`complete-video rights remain reachable from Details at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.route("**/*", route => new URL(route.request().url()).origin === new URL(test.info().project.use.baseURL!).origin
    ? route.continue() : route.abort());
  let writes = 0;
  let asset = { id: "rights-video", sourceId: "video-library", name: "A walk along the New Jersey boardwalk",
    description: null, originalName: "boardwalk.mp4", mimeType: "video/mp4", kind: "video", sizeBytes: 1000,
    preview: "browser", viewingCopy: { state: "ready" }, credit: "NJ PBS", license: "Station owned",
    rightsStatus: "complete", tags: [], version: 1, createdAt: null, updatedAt: null };
  await page.route("**/cmsListSourceMedia", route => route.fulfill({ json: { success: true, records: [asset], hasMore: false, nextCursor: null } }));
  await page.route("**/cmsListMediaSources", route => route.fulfill({ json: { success: true, sources: [{ id: "video-library",
    label: "Videos", mediaKind: "video", canBrowse: true, canUpload: false, canEditMetadata: true, canRequestProduction: false }] } }));
  await page.route("**/cmsUpdateSourceMediaMetadata", route => {
    const request = route.request().postDataJSON();
    expect(request).toMatchObject({ sourceId: "video-library", assetId: asset.id, expectedVersion: 1,
      changes: { rightsStatus: "complete", credit: "NJ PBS News", license: "Station owned" } });
    writes++; asset = { ...asset, ...request.changes, version: 2 };
    return route.fulfill({ json: { success: true, asset } });
  });
  await page.goto("/media-rights.html");
  await page.evaluate(() => document.fonts.ready);
  const title = page.getByRole("textbox", { name: "Headline", exact: true });
  await title.fill("Keep this unsaved headline");
  await page.locator(".block-card-video").getByRole("button", { name: /^Edit uploaded video/ }).click();
  const details = page.locator(".video-block-editor:visible");
  await expect(details.getByRole("textbox", { name: "Video title", exact: true })).toBeVisible();
  await expect(details.locator(".video-editor-warning")).toHaveCount(0);
  const review = details.getByRole("button", { name: "Review rights", exact: true });
  const capture = async () => page.screenshot({ path: join(process.env.EDITOR_RIGHTS_EVIDENCE!, `complete-${width}.png`),
    fullPage: true, animations: "disabled", caret: "hide", scale: "css" });
  if (process.env.EDITOR_RIGHTS_EVIDENCE && process.env.EDITOR_RIGHTS_BEFORE) await capture();
  await expect(review).toBeVisible();
  if (process.env.EDITOR_RIGHTS_EVIDENCE && !process.env.EDITOR_RIGHTS_BEFORE) await capture();
  await review.click();
  const dialog = page.getByRole("dialog", { name: "Video rights", exact: true });
  await expect(dialog.getByLabel("License", { exact: true })).toHaveValue("Station owned");
  const save = dialog.getByRole("button", { name: "Save rights", exact: true });
  await expect(save).toBeDisabled();
  await dialog.getByLabel("License", { exact: true }).press("Enter");
  expect(writes).toBe(0);
  await dialog.getByLabel("Credit", { exact: true }).fill("NJ PBS News");
  await expect(save).toBeEnabled(); await save.click();
  await expect(dialog.getByRole("status")).toContainText("Video rights saved.");
  await expect(save).toBeDisabled();
  await dialog.getByRole("button", { name: "Close video rights", exact: true }).click();
  await expect(review).toBeFocused();
  await expect(title).toHaveValue("Keep this unsaved headline");
  expect(writes).toBe(1);
  expect(await page.evaluate(() => window.__RIGHTS_EDITOR_FIXTURE__?.postSaves)).toBe(0);
});

test("keeps the draft mounted if the deferred rights dialog cannot open", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.route("**/*", route => new URL(route.request().url()).origin === new URL(test.info().project.use.baseURL!).origin
    ? route.continue() : route.abort());
  await page.route("**/cmsListSourceMedia", route => route.fulfill({ status: 503, json: { error: "Local rights read unavailable" } }));
  await page.route("**/src/components/VideoRightsDialog.tsx*", route => route.abort());
  await page.goto("/media-rights.html");
  const title = page.getByRole("textbox", { name: "Headline", exact: true });
  await title.fill("Keep this draft through a loading failure");
  const original = await title.elementHandle();
  const video = page.locator(".block-card-video");
  await video.getByRole("button", { name: "Review", exact: true }).click();
  const alert = video.getByRole("alert");
  await expect(alert).toContainText("Video rights could not open. Your document is still open.");
  await alert.getByRole("button", { name: "Retry video rights", exact: true }).click();
  await expect(alert).toContainText("Save your changes before reloading to try again.");
  await expect(title).toHaveValue("Keep this draft through a loading failure");
  expect(await original?.evaluate(element => element.isConnected)).toBe(true);
  expect(await page.evaluate(() => window.__RIGHTS_EDITOR_FIXTURE__?.postSaves)).toBe(0);
});
