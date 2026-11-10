import { expect, test, type Locator } from "./fixtures";
import { openSpecimen } from "./capture";

async function box(locator: Locator) {
  const value = await locator.boundingBox();
  expect(value).not.toBeNull();
  return value!;
}

function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  return a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y;
}

async function locatorsOverlap(a: Locator, b: Locator) {
  return overlaps(await box(a), await box(b));
}

async function expectClear(a: Locator, b: Locator) {
  try {
    await expect.poll(() => locatorsOverlap(a, b)).toBe(false);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${JSON.stringify({ a: await box(a), b: await box(b) })}`);
  }
}

for (const width of [1280, 390]) {
  test(`upload tray clears selection and focused results at ${width}px`, async ({ page }) => {
    await openSpecimen(page, {
      id: "media-upload-progress",
      presentation: "text",
      title: "Media library upload tray",
      width,
    });

    const tray = page.locator(".media-upload-tray");
    const selection = page.getByRole("group", { name: "Collection selection" });
    await expectClear(tray, selection);
    if (width === 1280) {
      await expect(tray.getByRole("button", { name: "Resume studio-interview.mp4" })).toBeVisible();
      await expect(tray.getByRole("button", { name: "Cancel studio-interview.mp4" })).toBeVisible();
    }

    await page.locator(".media-upload-gallery-results").evaluate((element) => {
      element.style.minHeight = "75rem";
      element.style.alignContent = "end";
    });
    const resultControl = page.getByRole("button", { name: "Focus result control" });
    await resultControl.focus();
    await expect(resultControl).toBeFocused();
    await expectClear(tray, resultControl);

    if (width === 1280) {
      await page.getByRole("button", { name: "Open upload", exact: true }).click();
      const sheet = page.getByRole("complementary", { name: "Upload media" });
      await expect(sheet).toBeVisible();
      expect(Math.round((await box(sheet)).width)).toBe(448);
      await expectClear(tray, selection);
    } else {
      const pill = page.getByRole("button", { name: /^Open upload details,/ });
      await expect(pill).toBeVisible();
      await pill.click();
      const sheet = page.getByRole("dialog", { name: "Upload media" });
      await expect(sheet).toBeVisible();
      expect((await box(sheet)).width).toBeLessThanOrEqual(width);
      await expect(sheet.getByRole("heading", { name: "Upload images and documents" })).toBeFocused();
      await expect(sheet.getByRole("button", { name: "Stop news-desk.png" })).toBeVisible();
      await expect(sheet.getByRole("button", { name: "View asset station-id.png" })).toBeVisible();
      await expect(sheet.getByRole("button", { name: "Resume studio-interview.mp4" })).toBeVisible();
      await expect(sheet.getByRole("button", { name: "Cancel studio-interview.mp4" })).toBeVisible();
    }

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  });

  test(`video upload sheet fits at ${width}px`, async ({ page }) => {
    await openSpecimen(page, {
      id: "media-upload-sheet",
      presentation: "text",
      title: "Video library upload sheet",
      width,
    });

    const sheet = page.getByRole(width === 1280 ? "complementary" : "dialog", { name: "Upload media" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("heading", { name: "Upload to Video library" })).toBeFocused();
    await expect(sheet.getByRole("button", { name: "Resume studio-interview.mp4" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Cancel studio-interview.mp4" })).toBeVisible();
    expect(Math.round((await box(sheet)).width)).toBe(width === 1280 ? 448 : width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  });

  test(`image route upload sheet fits at ${width}px`, async ({ page }) => {
    await openSpecimen(page, {
      id: "media-browsing",
      presentation: "text",
      title: "Media library upload sheet",
      width,
    });

    const upload = page.getByRole("button", { name: "Upload media" });
    // Some browsers leave focus on the preceding control when a button is clicked.
    await page.locator(".media-tile-open").first().focus();
    await upload.evaluate(element => element.addEventListener("mousedown", event => event.preventDefault(), { once: true }));
    await upload.click();
    const sheet = page.getByRole(width === 1280 ? "complementary" : "dialog", { name: "Upload media" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("heading", { name: "Upload images and documents" })).toBeFocused();
    await expect(sheet.getByRole("button", { name: "Close upload" })).toBeVisible();
    expect(Math.round((await box(sheet)).width)).toBe(width === 1280 ? 448 : width);

    await sheet.getByLabel(/^Files \(25 MB maximum each\)/).setInputFiles([
      { name: "breaking-news-a.png", mimeType: "image/png", buffer: Buffer.from("first image") },
      { name: "breaking-news-b.png", mimeType: "image/png", buffer: Buffer.from("second image") },
    ]);
    await expect(sheet.getByRole("button", { name: "Upload all files" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Upload file" })).toBeVisible();
    const actions = sheet.locator(".media-form-actions");
    expect(await actions.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);

    if (width === 1280) {
      await expectClear(sheet, page.locator(".media-drop-target"));
      expect(Math.abs((await box(sheet)).y - (await box(page.locator(".media-grid"))).y)).toBeLessThanOrEqual(1);
      const card = page.locator(".media-tile-open").nth(1);
      const name = await card.innerText();
      await card.click();
      const details = page.getByRole("complementary", { name: "Asset details" });
      await expect(details.getByRole("heading", { name, exact: true })).toBeVisible();
      await expect(sheet).toBeHidden();
      const resume = page.getByRole("button", { name: "Continue upload (2)", exact: true });
      await expect(resume).toBeVisible();
      await expect(resume).toHaveText("Continue upload (2)");
      await resume.click();
      await expect(sheet.getByRole("button", { name: "Upload all files" })).toBeVisible();
      await page.getByText("3 results", { exact: true }).click();
      await expect(sheet).toBeHidden();
    } else {
      await expect(page.locator(".media-drop-target")).toHaveAttribute("inert", "");
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  });
}

for (const width of [1280, 390]) {
  test(`queued upload aligns with the grid and keeps running when hidden at ${width}px`, async ({ page }) => {
    await openSpecimen(page, { id: "media-upload-running", presentation: "text", title: "Queued media upload", width });
    const sheet = page.getByRole(width === 1280 ? "complementary" : "dialog", { name: "Upload media" });
    await expect(sheet.getByRole("button", { name: /.+: Uploading…$/ })).toHaveAttribute("aria-busy", "true");
    if (width === 1280) {
      await expect.poll(async () => Math.abs((await box(sheet)).y - (await box(page.locator(".media-grid"))).y)).toBeLessThanOrEqual(1);
      expect((await box(sheet)).y + (await box(sheet)).height).toBeLessThanOrEqual(900);
      const card = page.locator(".media-tile-open").nth(1);
      const name = await card.innerText();
      await card.click();
      await expect(page.getByRole("complementary", { name: "Asset details" }).getByRole("heading", { name, exact: true })).toBeVisible();
    } else {
      expect((await box(sheet)).y).toBe(0);
      await sheet.getByRole("button", { name: "Close upload" }).click();
    }
    await expect(sheet).toBeHidden();
    await page.getByRole("button", { name: "Upload media", exact: true }).click();
    await expect(sheet.getByRole("button", { name: /.+: Uploading…$/ })).toHaveAttribute("aria-busy", "true");
  });
}
