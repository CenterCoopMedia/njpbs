import { expect, test, type Locator } from "./fixtures";
import { openMediaRefinement } from "./media-refinement.fixture";
import { openSpecimen } from "./capture";

for (const coarse of [false, true]) {
  test.describe(`${coarse ? "coarse" : "fine"} shared media frame`, () => {
    test.use({ hasTouch: coarse });
    for (const width of [1280, 320]) {
      test(`${width}px keeps one Close, native Save and the actual navigation owner`, async ({ page }) => {
        const requests = await openMediaRefinement(page, width);
        const header = page.locator(".component-editor-dialog-header");
        const save = header.getByRole("button", { name: "Save details", exact: true });
        const close = page.getByRole("button", { name: "Close", exact: true });
        await expect(close).toHaveCount(1);
        await expect(save).toBeVisible();
        await expect(save).toBeDisabled();
        const target = (await save.boundingBox())!;
        expect(target.height).toBe(coarse ? 44 : 36);
        expect(target.width).toBe(coarse ? 44 : 36);
        expect((await header.boundingBox())!.height).toBeLessThanOrEqual(80);
        const footer = page.locator(".component-editor-dialog-footer");
        expect((await footer.boundingBox())!.height).toBe(28);
        await expect(footer.getByRole("button")).toHaveCount(0);
        const identity = await page.locator("video").evaluate(async (video: HTMLVideoElement) => {
          (window as unknown as { frameVideo: HTMLVideoElement }).frameVideo = video;
          video.muted = true;
          await video.play();
          video.pause();
          video.playbackRate = 1.25;
          await new Promise<void>(resolve => {
            video.addEventListener("seeked", () => resolve(), { once: true });
            video.currentTime = 12;
          });
          return video.currentTime;
        });
        expect(identity).toBe(12);
        const download = header.getByRole("button", { name: "Download", exact: true });
        if (width < 781) {
          const more = header.getByRole("button", { name: "More preview actions", exact: true });
          const controls = await Promise.all([save, download, more, close].map(control => control.boundingBox()));
          for (let index = 1; index < controls.length; index++) {
            expect(controls[index]!.x).toBeGreaterThanOrEqual(controls[index - 1]!.x + controls[index - 1]!.width);
            expect(Math.abs(controls[index]!.y - controls[0]!.y)).toBeLessThan(1);
          }
          expect(controls.at(-1)!.x + controls.at(-1)!.width).toBeLessThanOrEqual(width);
          await expect(header.getByRole("button", { name: "Previous file", exact: true })).toBeHidden();
          await more.click();
          await expect(page.getByRole("menu")).toContainText("Current results · 2 of 3");
          await expect(page.getByRole("menuitem", { name: "Previous file", exact: true })).toBeVisible();
          await expect(page.getByRole("menuitem", { name: "Next file", exact: true })).toBeVisible();
          await expect(page.getByRole("menuitemcheckbox", { name: "Favorite", exact: true })).toBeVisible();
          await expect(page.getByRole("menuitem", { name: "Copy link", exact: true })).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(more).toBeFocused();
        } else {
          await expect(header.getByRole("group", { name: "Step through this page" })).toContainText("2 of 3");
          await expect(header.getByRole("button", { name: "Previous file", exact: true })).toBeVisible();
        }
        await download.click();
        const menu = page.getByRole("menu", { name: "Download", exact: true });
        for (const format of ["Plain text", "Web captions (VTT)", "SRT captions", "Soundbite log (TSV)", "Avid markers", "Premiere transcript"]) {
          await expect(menu.getByRole("menuitem", { name: new RegExp(`^${format.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) })).toBeVisible();
        }
        const avid = menu.getByRole("menuitem", { name: /^Avid markers/ });
        await expect(avid).toHaveAttribute("aria-disabled", "true");
        await expect(avid).toContainText("Choose a frame rate");
        await avid.focus();
        await avid.press("Enter");
        await expect(menu).toBeVisible();
        expect(requests.some(endpoint => /Request|ReadVideoTranscript/.test(endpoint))).toBe(false);
        await page.keyboard.press("Escape");
        await expect(download).toBeFocused();
        expect(await page.locator("video").evaluate((video: HTMLVideoElement) => video === (window as unknown as { frameVideo: HTMLVideoElement }).frameVideo && video.currentTime === 12 && video.playbackRate === 1.25)).toBe(true);
      });
    }
  });
}

test("dirty close stays visible outside a deeply scrolled body and retains the native form", async ({ page }) => {
  await openMediaRefinement(page, 390);
  const watch = page.getByRole("tab", { name: "Watch & details", exact: true });
  if (await watch.isVisible()) await watch.click();
  const title = page.getByRole("textbox", { name: "Title", exact: true });
  await title.fill("Unsaved local title");
  const save = page.getByRole("button", { name: "Save details", exact: true });
  await expect(save).toBeEnabled();
  const formId = await save.getAttribute("form");
  expect(formId).toBeTruthy();
  expect(await title.evaluate((input, id) => input.closest("form")?.id === id, formId)).toBe(true);
  await page.locator(".component-editor-dialog-body").evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const keep = page.getByRole("button", { name: "Keep editing", exact: true });
  await expect(keep).toBeFocused();
  await expect.poll(async () => {
    const notice = (await page.locator(".media-dialog-notices").boundingBox())!;
    const control = (await keep.boundingBox())!;
    return control.y >= notice.y && control.y + control.height <= notice.y + notice.height;
  }).toBe(true);
  await keep.click();
  await expect(page.getByRole("dialog", { name: "Waterfront oral history — interview master", exact: true })).toBeVisible();
  await expect(title).toHaveValue("Unsaved local title");
  await expect(save).toHaveAttribute("form", formId!);
});

for (const presentation of ["icons", "text"] as const) {
  test(`desktop ${presentation} context toolbar keys retain the asset and dirty form`, async ({ page }) => {
    await openMediaRefinement(page, 1280, presentation);
    const header = page.locator(".component-editor-dialog-header");
    const watch = page.getByRole("tab", { name: "Watch & details", exact: true });
  if (await watch.isVisible()) await watch.click();
  const title = page.getByRole("textbox", { name: "Title", exact: true });
    await title.fill("Unchanged asset with a local draft");
    const favorite = header.getByRole("button", { name: /^Favorite:/ });
    const copy = header.getByRole("button", { name: "Copy link", exact: true });
    await favorite.focus();
    await favorite.press("ArrowRight");
    await expect(copy).toBeFocused();
    await copy.press("ArrowLeft");
    await expect(favorite).toBeFocused();
    await favorite.press("End");
    await expect(copy).toBeFocused();
    await copy.press("Home");
    await expect(favorite).toBeFocused();
    await expect(page.getByRole("dialog")).toHaveAccessibleName("Waterfront oral history — interview master");
    await expect(title).toHaveValue("Unchanged asset with a local draft");
    await expect(page.getByRole("button", { name: "Keep editing", exact: true })).toHaveCount(0);
    const download = header.getByRole("button", { name: "Download", exact: true });
    await download.focus();
    await download.press("ArrowLeft");
    await expect(download).toBeFocused();
    await expect(title).toHaveValue("Unchanged asset with a local draft");
  });
}

// Header geometry remains covered above at every width and pointer mode.
// Roving keys and result stepping use the same phone command owner.
test("phone toolbar keys and actual result stepping retain the visible focus owner", async ({ page }) => {
  await openMediaRefinement(page, 320);
  const header = page.locator(".component-editor-dialog-header");
  const download = header.getByRole("button", { name: "Download", exact: true });
  const more = header.getByRole("button", { name: "More preview actions", exact: true });
  const positionStatus = header.getByRole("status").filter({ hasText: /^\d+ of \d+$/ });
  await expect(positionStatus).toHaveCount(1);
  await expect(positionStatus).toHaveText("2 of 3");
  await download.focus();
  await download.press("ArrowRight");
  await expect(more).toBeFocused();
  await more.press("Home");
  await expect(download).toBeFocused();
  await download.press("End");
  await expect(more).toBeFocused();
  await expect(page.getByRole("dialog")).toHaveAccessibleName("Waterfront oral history — interview master");
  await more.click();
  await page.getByRole("menuitem", { name: "Next file", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Waterfront archive · closing interview", exact: true })).toBeVisible();
  await expect(positionStatus).toHaveText("3 of 3");
  await expect(more).toBeFocused();
  await more.click();
  const last = page.getByRole("menuitem", { name: /^Next file/ });
  await expect(page.getByRole("menu")).toContainText("Current results · 3 of 3");
  await expect(last).toHaveAttribute("aria-disabled", "true");
  await expect(last).toContainText("Last file in these results.");
  await last.focus();
  await last.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.getByRole("menuitem", { name: "Previous file", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Waterfront oral history — interview master", exact: true })).toBeVisible();
  await expect(more).toBeFocused();
  await more.click();
  await expect(page.getByRole("menu")).toContainText("Current results · 2 of 3");
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();
  await more.click();
  await page.getByRole("menuitem", { name: "Copy link", exact: true }).click();
  const copy = page.getByRole("dialog", { name: "Internal media link", exact: true });
  await expect(copy).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(copy).toBeHidden();
  await expect(more).toBeFocused();
});

test.describe('coarse enlarged Text frame', () => {
  test.use({ hasTouch: true });
  test('320px retains labeled Save and every command as targets grow', async ({ page }) => {
    await openMediaRefinement(page, 390, 'text');
    await page.setViewportSize({ width: 320, height: 740 });
    await page.addStyleTag({ content: 'html { font-size:200%; }' });
    await expect(page.locator('html')).toHaveCSS('font-size', '32px');
    await page.evaluate(async () => { await document.fonts.ready; });
    const header = page.locator('.component-editor-dialog-header');
    await expect.poll(async () => header.locator('button').evaluateAll(elements => elements
      .filter(element => element.getClientRects().length)
      .every(element => { const box = element.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.width >= 44 && box.height >= 44; }))).toBe(true);
    expect(await header.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(header.getByRole('button', { name: 'Save details', exact: true })).toContainText('Save');
    const more = header.getByRole('button', { name: 'More preview actions', exact: true });
    await more.click();
    await expect(page.getByRole('menu')).toContainText('Current results · 2 of 3');
    await page.keyboard.press('Escape');
    await expect(more).toBeFocused();
    await expect(page.getByRole('button', { name: 'Close', exact: true })).toHaveCount(1);
  });
});

test("declining a phone step keeps the draft and restores the mounted More trigger", async ({ page }) => {
  await openMediaRefinement(page, 390);
  const watch = page.getByRole("tab", { name: "Watch & details", exact: true });
  if (await watch.isVisible()) await watch.click();
  const title = page.getByRole("textbox", { name: "Title", exact: true });
  await title.fill("Keep this local draft");
  const more = page.getByRole("button", { name: "More preview actions", exact: true });
  await more.click();
  await page.getByRole("menuitem", { name: "Next file", exact: true }).click();
  const keep = page.getByRole("button", { name: "Keep editing", exact: true });
  await expect(keep).toBeFocused();
  await keep.click();
  await expect(more).toBeFocused();
  await expect(title).toHaveValue("Keep this local draft");
  await expect(page.getByRole("dialog", { name: "Waterfront oral history — interview master", exact: true })).toBeVisible();
});

for (const width of [390, 1280]) {
  test(`${width}px open command menus own horizontal arrows without stepping the asset`, async ({ page }) => {
    await openMediaRefinement(page, width);
    const dialog = page.getByRole('dialog', { name: 'Waterfront oral history — interview master', exact: true });
    const download = dialog.getByRole('button', { name: 'Download', exact: true });
    const triggers = width < 781 ? [download, dialog.getByRole('button', { name: 'More preview actions', exact: true })] : [download];
    for (const trigger of triggers) {
      await trigger.click();
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      for (const key of ['ArrowLeft', 'ArrowRight']) {
        await page.keyboard.press(key);
        await expect(dialog).toBeVisible();
        await expect(menu).toBeVisible();
      }
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
      await expect(dialog).toBeVisible();
    }
  });
}

for (const width of [320, 390]) {
  for (const enlarged of [false, true]) {
    test(`Text controls at ${width}px${enlarged ? ' and 200% root text' : ''} retain every header command`, async ({ page }) => {
      await openMediaRefinement(page, width, 'text');
      if (enlarged) {
        await page.addStyleTag({ content: 'html { font-size:200%; }' });
        await expect(page.locator('html')).toHaveCSS('font-size', '32px');
        await page.evaluate(async () => { await document.fonts.ready; });
      }
      const header = page.locator('.component-editor-dialog-header');
      const save = header.getByRole('button', { name: 'Save details', exact: true });
      await expect(save.locator('.async-action-label')).toContainText('Save');
      await expect.poll(async () => header.locator('button').evaluateAll(elements => elements
        .filter(element => element.getClientRects().length)
        .every(element => { const box = element.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; }))).toBe(true);
      expect(await header.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      const more = header.getByRole('button', { name: 'More preview actions', exact: true });
      await more.click();
      await expect(page.getByRole('menu')).toContainText('Current results · 2 of 3');
      await page.keyboard.press('Escape');
      await expect(more).toBeFocused();
    });
  }
}


test("resizing the shared frame preserves the mounted player, draft, caret and native Save form", async ({ page }) => {
  await openMediaRefinement(page, 1280);
  const watch = page.getByRole("tab", { name: "Watch & details", exact: true });
  if (await watch.isVisible()) await watch.click();
  const title = page.getByRole("textbox", { name: "Title", exact: true });
  await title.fill("Draft retained across the media frame breakpoint");
  await title.evaluate((input: HTMLInputElement) => { input.setSelectionRange(6, 14); });
  const save = page.getByRole("button", { name: "Save details", exact: true });
  const formId = await save.getAttribute("form");
  await save.evaluate(button => { (window as unknown as { retainedSave: Element }).retainedSave = button; });
  await page.locator("video").evaluate(async (video: HTMLVideoElement) => {
    (window as unknown as { retainedVideo: HTMLVideoElement }).retainedVideo = video;
    video.playbackRate = 1.25;
    await new Promise<void>(resolve => {
      video.addEventListener("seeked", () => resolve(), { once: true });
      video.currentTime = 12;
    });
  });
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await expect.poll(() => page.locator(".component-editor-dialog-header").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(title).toHaveValue("Draft retained across the media frame breakpoint");
    await expect(title).toBeFocused();
    expect(await title.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([6, 14]);
    await expect(save).toHaveAttribute("form", formId!);
    await expect(save).toBeEnabled();
    expect(await save.evaluate(button => button === (window as unknown as { retainedSave: Element }).retainedSave)).toBe(true);
    expect(await title.evaluate((input, id) => input.closest("form")?.id === id, formId)).toBe(true);
    expect(await page.locator("video").evaluate((video: HTMLVideoElement) => video === (window as unknown as { retainedVideo: HTMLVideoElement }).retainedVideo && video.currentTime === 12 && video.playbackRate === 1.25)).toBe(true);
  }
});


test("Transcript export settings retains focus after the outer disclosure frame", async ({ page }) => {
  await openMediaRefinement(page, 390);
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await page.getByRole("menuitem", { name: "Transcript export settings…", exact: true }).click();
  const summary = page.locator(".video-transcript-export-options > summary");
  await expect(summary).toBeVisible();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(summary).toBeFocused();
  await expect(page.getByRole("combobox", { name: "Editing clip or sequence frame rate", exact: true })).toBeVisible();
});


test("a pending transcript download holds the viewer until its request settles", async ({ page }) => {
  await openMediaRefinement(page, 390);
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let reads = 0;
  await page.route("**/cmsCreateVideoTranscriptRead", async route => {
    reads++;
    await pending;
    await route.fulfill({ status: 500, json: { error: "Temporary fixture failure" } });
  });
  const close = page.getByRole("button", { name: "Close", exact: true });
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Plain text/ }).click();
  try {
    await expect.poll(() => reads).toBe(1);
    await expect(close).toBeDisabled();
    const more = page.getByRole("button", { name: "More preview actions", exact: true });
    await more.click();
    const next = page.getByRole("menuitem", { name: /^Next file/ });
    await expect(next).toHaveAttribute("aria-disabled", "true");
    await next.focus();
    await next.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Waterfront oral history — interview master", exact: true })).toBeVisible();
  } finally {
    finish();
  }
  await expect(page.getByText(/The saved transcript could not be downloaded\./)).toBeVisible();
  await expect(close).toBeEnabled();
});

test("a failed header transcript download stays visible and recoverable outside the work panes", async ({ page }) => {
  const requests = await openMediaRefinement(page, 390);
  const transcript = page.locator(".video-transcript-settings");
  await expect(transcript).not.toHaveAttribute("open", "");
  await page.locator(".component-editor-dialog-body").evaluate(element => { element.scrollTop = element.scrollHeight; });
  let downloads = 0;
  await page.route("**/cmsCreateVideoTranscriptRead", route => {
    downloads++;
    return route.fulfill({ status: 500, json: { error: "Temporary fixture failure" } });
  });
  const download = page.getByRole("button", { name: "Download", exact: true });
  await download.click();
  await page.getByRole("menuitem", { name: /^Plain text/ }).click();
  const feedback = page.getByText(/The saved transcript could not be downloaded\./);
  await expect.poll(() => downloads).toBe(1);
  await expect(feedback).toBeVisible();
  await expect(transcript).not.toHaveAttribute("open", "");
  const notices = page.locator(".media-dialog-notices");
  await expect(notices).toContainText("Transcript needs attention");
  const noticeBox = (await notices.boundingBox())!;
  const errorBox = (await feedback.boundingBox())!;
  expect(errorBox.y).toBeGreaterThanOrEqual(noticeBox.y);
  expect(errorBox.y + errorBox.height).toBeLessThanOrEqual(noticeBox.y + noticeBox.height);
  const retry = notices.getByRole("button", { name: "Check saved status", exact: true });
  await expect(page.getByRole("button", { name: "Close", exact: true })).toBeEnabled();
  await retry.focus();
  await retry.press("ArrowRight");
  await expect(page.getByRole("dialog", { name: "Waterfront oral history — interview master", exact: true })).toBeVisible();
  await expect(feedback).toBeVisible();
  await expect(retry).toBeFocused();
  const checks = requests.filter(endpoint => endpoint === "cmsGetVideoTranscript").length;
  await retry.click();
  await expect(transcript).not.toHaveAttribute("open", "");
  await expect(feedback).toBeHidden();
  await expect(page.getByRole("tab", { name: "Transcript", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("searchbox", { name: "Search loaded transcript" })).toBeFocused();
  expect(requests.filter(endpoint => endpoint === "cmsGetVideoTranscript").length).toBe(checks + 1);
  expect(requests.some(endpoint => endpoint.startsWith("cmsRequest"))).toBe(false);
});


for (const kind of ["image", "document", "video"] as const) {
  for (const presentation of ["icons", "text"] as const) {
    test(`gallery ${kind} ${presentation} 320px uses one shared phone header row and real navigation in More`, async ({ page }) => {
      await openSpecimen(page, { id: `media-full-viewer-${kind}`, title: "Shared media viewer", width: 320, presentation }, { normalizeGeneratedIds: false });
      const header = page.locator(".component-editor-dialog-header");
      const download = header.getByRole("button", { name: "Download", exact: true });
      const more = header.getByRole("button", { name: "More preview actions", exact: true });
      const close = header.getByRole("button", { name: "Close", exact: true });
      await expect(more).toBeVisible();
      await expect(header.getByRole("button", { name: "Previous file", exact: true })).toBeHidden();
      await expect(header.getByRole("button", { name: "Next file", exact: true })).toBeHidden();
      const boxes = await Promise.all([download, more, close].map(control => control.boundingBox()));
      for (const box of boxes) {
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(320);
        expect(Math.abs(box!.y - boxes[0]!.y)).toBeLessThan(1);
      }
      expect((await header.boundingBox())!.height).toBeLessThanOrEqual(80);
      if (presentation === "icons") {
        await expect(download.locator(".icon")).toBeVisible();
        // The shared mobile label uses the AT-visible 1px clip pattern.
        await expect(download.locator(".button-compact-label")).toHaveCSS("clip-path", "inset(50%)");
        await expect(download).toHaveAccessibleName("Download");
      }
      await more.click();
      await expect(page.getByRole("menu")).toContainText(`Current results · ${kind === "image" ? 1 : kind === "document" ? 2 : 3} of 3`);
      await page.keyboard.press("Escape");
      await expect(more).toBeFocused();
      await download.click();
      await expect(page.getByRole("menuitem", { name: kind === "video" ? "Download video" : "Download original", exact: true })).toBeVisible();
    });
  }
}

async function expectRevealed(control: Locator) {
  const box = (await control.boundingBox())!;
  // Chromium can round the final scroll offset by a fraction of a CSS pixel.
  // Bound the intersection loss to less than half a pixel along either edge.
  await expect(control).toBeInViewport({ ratio: 1 - 0.5 / Math.max(box.width, box.height) });
}

for (const coarse of [false, true]) {
  test.describe(`${coarse ? "coarse" : "fine"} image form reflow`, () => {
    test.use({ hasTouch: coarse });
    for (const presentation of ["icons", "text"] as const) {
      test(`image phone ${presentation} keeps Save with its form and a readable title through resize`, async ({ page }) => {
        await openSpecimen(page, { id: "image-viewer", title: "Image details", width: 320, presentation }, { normalizeGeneratedIds: false });
        await page.getByRole("group", { name: "Image view controls" }).getByRole("button", { name: "Details", exact: true }).click();
        const header = page.locator(".component-editor-dialog-header");
        await expect(header.getByRole("button", { name: "Save details", exact: true })).toHaveCount(0);
        const save = page.locator(".media-image-inspector-footer").getByRole("button", { name: "Save details", exact: true });
        await expect(save).toBeVisible();
        await expect(save).toBeDisabled();
        expect((await save.boundingBox())!.height).toBe(coarse ? 44 : 36);
        await expect(header.locator(".media-preview-header-facts")).toContainText("JPEG · 2400 × 1600 · 2.1 MB");
        const title = (await header.getByRole("heading").boundingBox())!;
        const firstWord = await header.getByRole("heading").evaluate(element => {
          const range = document.createRange();
          range.setStart(element.firstChild!, 0); range.setEnd(element.firstChild!, "Statehouse".length + 2);
          return range.getBoundingClientRect().width;
        });
        expect(title.width).toBeGreaterThanOrEqual(firstWord);
        const name = page.getByRole("textbox", { name: "Name", exact: true });
        await expect(save).toHaveAttribute("form", (await name.evaluate(element => (element as HTMLInputElement).form!.id)));
        await name.fill("Image draft held through resize");
        await expectRevealed(save);
        await expectRevealed(page.getByRole("button", { name: "Cancel changes", exact: true }));
        await expect(page.getByRole("button", { name: "Cancel changes", exact: true }).locator("span")).toHaveCSS("clip-path", "none");
        await expect(name).toBeFocused();
        await expectRevealed(name);
        await save.focus();
        await expect(save).toBeFocused();
        await save.press("ArrowRight");
        await page.evaluate(() => new Promise(requestAnimationFrame));
        await expect(page.getByRole("button", { name: "Keep editing", exact: true })).toHaveCount(0);
        await expect(save).toBeFocused();
        await save.press("Escape");
        const keep = page.getByRole("button", { name: "Keep editing", exact: true });
        await expect(keep).toBeFocused();
        await keep.click();
        await expect(name).toHaveValue("Image draft held through resize");
        await save.focus();
        await page.setViewportSize({ width: 1280, height: 800 });
        const desktopSave = header.getByRole("button", { name: "Save details", exact: true });
        await expect(desktopSave).toBeFocused();
        await expectRevealed(desktopSave);
        await expect(name).toHaveValue("Image draft held through resize");
        await page.setViewportSize({ width: 320, height: 800 });
        await expect(save).toBeFocused();
        await expectRevealed(save);
        await name.press("Enter");
        await expect(page.getByRole("dialog", { name: "Image draft held through resize", exact: true })).toBeVisible();
        await expect(save).toBeDisabled();
        await name.fill("A second local draft");
        const cancel = page.getByRole("button", { name: "Cancel changes", exact: true });
        await cancel.focus();
        await cancel.press("ArrowRight");
        await page.evaluate(() => new Promise(requestAnimationFrame));
        await expect(page.getByRole("button", { name: "Keep editing", exact: true })).toHaveCount(0);
        await expect(cancel).toBeFocused();
        await page.setViewportSize({ width: 1280, height: 800 });
        await expect(desktopSave).toBeVisible();
        await expect(cancel).toBeFocused();
        await page.setViewportSize({ width: 320, height: 800 });
        await expect(desktopSave).toHaveCount(0);
        await expect(cancel).toBeFocused();
        await expectRevealed(cancel);
        await page.setViewportSize({ width: 320, height: 500 });
        await expect(cancel).toBeFocused();
        await expectRevealed(cancel);
        await page.setViewportSize({ width: 320, height: 800 });
        await cancel.click();
        await expect(name).toHaveValue("Image draft held through resize");
      });
    }
  });
}

for (const presentation of ["icons", "text"] as const) {
  test(`phone document ${presentation} keeps dirty Save, discard and the edited field visible`, async ({ page }) => {
    await openSpecimen(page, { id: "media-collections-viewer-document", title: "Document details", width: 320, presentation }, { normalizeGeneratedIds: false });
    const viewer = page.getByRole("dialog", { name: "Field production guide" });
    const name = viewer.getByRole("textbox", { name: "Name", exact: true });
    await name.fill("Document with a local draft");
    const save = viewer.locator(".media-image-inspector-footer").getByRole("button", { name: "Save details", exact: true });
    const cancel = viewer.getByRole("button", { name: "Cancel changes", exact: true });
    await expect(save).toBeEnabled();
    await expectRevealed(save);
    await expectRevealed(cancel);
    await expect(cancel.locator("span")).toHaveCSS("clip-path", "none");
    await expect(name).toBeFocused();
    const footer = viewer.locator(".ui-inspector-footer");
    expect((await name.boundingBox())!.y + (await name.boundingBox())!.height).toBeLessThanOrEqual((await footer.boundingBox())!.y);
    const description = viewer.getByRole("textbox", { name: "Description", exact: true });
    await description.focus();
    await expect(description).toBeFocused();
    expect((await description.boundingBox())!.y + (await description.boundingBox())!.height).toBeLessThanOrEqual((await footer.boundingBox())!.y);
    await page.addStyleTag({ content: "html { font-size:200%; }" });
    await expectRevealed(save);
    await expectRevealed(cancel);
    const label = (await cancel.locator("span").boundingBox())!;
    const button = (await cancel.boundingBox())!;
    expect(label.x).toBeGreaterThanOrEqual(button.x);
    expect(label.x + label.width).toBeLessThanOrEqual(button.x + button.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(await page.evaluate(() => document.documentElement.clientWidth));
    await cancel.click();
    await expect(name).toHaveValue("Field production guide");
    await expect(save).toBeDisabled();
    await expect(cancel).toHaveCount(0);
  });
}
