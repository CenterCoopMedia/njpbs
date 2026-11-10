import { expect, test, type Page } from "./fixtures";
import { openMediaRefinement } from "./media-refinement.fixture";
import { FROZEN_NOW } from "./capture";

async function watch(page: Page) {
  const tab = page.getByRole("tab", { name: "Watch & details", exact: true });
  if (await tab.isVisible()) await tab.click();
}
async function read(page: Page) {
  const tab = page.getByRole("tab", { name: "Transcript", exact: true });
  if (await tab.isVisible()) await tab.click();
}
async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

for (const [width, height] of [[390, 844], [1280, 800], [1920, 1080]]) {
  test(`${width}px gives the mounted workspace a bounded reader and reachable paging`, async ({ page }) => {
    const requests = await openMediaRefinement(page, width);
    await page.setViewportSize({ width, height });
    await settle(page);
    const list = page.locator(".transcript-passages");
    const geometry = await list.evaluate(element => {
      const box = element.getBoundingClientRect();
      const editor = element.closest<HTMLElement>(".transcript-workspace")!;
      const workspace = document.querySelector<HTMLElement>(".video-viewer-workspace")!;
      const context = workspace.querySelector<HTMLElement>(".video-viewer-context")!;
      const reading = workspace.querySelector<HTMLElement>(".video-viewer-reading")!;
      const visibleRows = [...element.children].filter(row => {
        const r = row.getBoundingClientRect();
        return r.top >= box.top && r.bottom <= box.bottom;
      }).length;
      return { height: box.height, visibleRows, font: getComputedStyle(element.querySelector(".transcript-passage")!).fontSize,
        overflow: element.scrollWidth > element.clientWidth + 1,
        parentOverflow: editor.scrollHeight > editor.clientHeight + 1,
        siblings: context.parentElement === reading.parentElement,
        leftFraction: context.getBoundingClientRect().width / workspace.getBoundingClientRect().width,
        commandsOutsideList: !element.contains(editor.querySelector(".transcript-command-bar")),
        pagerBelowList: editor.querySelector(".transcript-results-bar")!.getBoundingClientRect().top >= box.bottom - 1 };
    });
    expect(geometry.siblings).toBe(true);
    expect(geometry.overflow).toBe(false);
    expect(geometry.parentOverflow).toBe(false);
    expect(geometry.commandsOutsideList && geometry.pagerBelowList).toBe(true);
    expect(geometry.font).toBe("15px");
    expect(geometry.height).toBeGreaterThan(width >= 1280 ? 500 : 260);
    if (width >= 1280) {
      expect(geometry.leftFraction).toBeCloseTo(width >= 1800 ? 0.32 : 0.35, 2);
      await expect(page.locator("video")).toBeInViewport();
      expect(geometry.visibleRows).toBeGreaterThanOrEqual(width === 1280 ? 8 : 10);
    } else {
      await expect(page.getByRole("tab", { name: "Transcript", exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(page.locator("video")).toBeHidden();
    }
    await expect(page.getByRole("button", { name: "Load more transcript", exact: true })).toBeInViewport();
    const oldPlayerBox = await page.locator("video").boundingBox();
    await list.evaluate(element => { element.scrollTop = 700; });
    if (width >= 1280) expect(await page.locator("video").boundingBox()).toEqual(oldPlayerBox);
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(page.getByRole("searchbox", { name: "Search loaded transcript" })).toBeFocused();
    await expect(page.getByRole("listitem", { name: /^Passage 51:/ })).toBeVisible();
    expect(requests.some(endpoint => endpoint.startsWith("cmsRequest"))).toBe(false);
  });
}

test("desktop comments replace the transcript beside the player and the divider resizes both panes", async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem("cms.video-viewer.context-width"));
  await openMediaRefinement(page, 1280);
  const workspace = page.locator(".video-viewer-workspace");
  const context = workspace.locator(".video-viewer-context");
  const divider = page.getByRole("separator", { name: "Resize Watch & details", exact: true });
  await expect(divider).toHaveAttribute("aria-orientation", "vertical");
  await expect(divider).toHaveAttribute("aria-controls", await context.getAttribute("id") ?? "");
  const initialWidth = (await context.boundingBox())!.width;
  const initialPercent = Number(await divider.getAttribute("aria-valuenow"));

  await divider.press("ArrowRight");
  await expect.poll(async () => Number(await divider.getAttribute("aria-valuenow"))).toBeGreaterThan(initialPercent);
  await expect.poll(async () => (await context.boundingBox())!.width).toBeGreaterThan(initialWidth);
  await divider.press("ArrowLeft");
  await expect.poll(async () => Number(await divider.getAttribute("aria-valuenow"))).toBeCloseTo(initialPercent, 0);
  await divider.press("Home");
  await expect(divider).toHaveAttribute("aria-valuenow", await divider.getAttribute("aria-valuemin") ?? "");
  await divider.press("End");
  await expect(divider).toHaveAttribute("aria-valuenow", await divider.getAttribute("aria-valuemax") ?? "");

  // End must reach its layout width before hover scrolls the divider into view.
  await expect.poll(async () => {
    const pane = (await context.boundingBox())!.width;
    const total = (await workspace.boundingBox())!.width;
    return Math.abs(pane / total * 100 - Number(await divider.getAttribute("aria-valuemax")));
  }).toBeLessThan(0.25);
  await divider.hover();
  const beforeDrag = (await context.boundingBox())!.width;
  const dividerBox = (await divider.boundingBox())!;
  await page.mouse.down();
  try {
    await expect.poll(() => divider.evaluate(element => element.hasPointerCapture(1))).toBe(true);
    await page.mouse.move(dividerBox.x + dividerBox.width / 2 - 80, dividerBox.y + dividerBox.height / 2, { steps: 5 });
    await expect.poll(async () => (await context.boundingBox())!.width).toBeLessThan(beforeDrag - 60);
  } finally {
    await page.mouse.up();
  }
  await expect.poll(async () => (await context.boundingBox())!.width).toBeLessThan(beforeDrag - 60);
  await expect.poll(() => divider.evaluate(element => element.hasPointerCapture(1))).toBe(false);
  await divider.press("Home");
  for (let step = 0; step < 15; step++) await divider.press("ArrowRight");
  const savedWidth = await page.evaluate(() => localStorage.getItem("cms.video-viewer.context-width"));
  expect(savedWidth).toBe("60");

  await page.getByRole("tab", { name: "Comments", exact: true }).click();
  const comments = page.getByRole("tabpanel", { name: "Comments", exact: true });
  await expect(comments).toBeVisible();
  expect(await comments.evaluate(element => Boolean(element.closest(".video-viewer-reading")))).toBe(true);
  await expect(page.locator("video")).toBeInViewport();
  await expect(page.getByRole("tabpanel", { name: "Transcript", exact: true })).toBeHidden();

  const commentsTab = page.getByRole("tab", { name: "Comments", exact: true });
  await commentsTab.focus();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest(".video-viewer-comments-host")))).toBe(true);
  await page.keyboard.press("Shift+Tab");
  await expect(commentsTab).toBeFocused();

  const draft = page.getByRole("textbox", { name: "New comment", exact: true });
  await draft.fill("Unsent responsive draft");
  await draft.evaluate(input => {
    (window as unknown as { retainedComment: Element }).retainedComment = input;
    (input as HTMLTextAreaElement).setSelectionRange(6, 16);
  });
  await page.setViewportSize({ width: 780, height: 900 });
  await expect(draft).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("cms.video-viewer.context-width"))).toBe(savedWidth);
  expect(await draft.evaluate(input => input === (window as unknown as { retainedComment: Element }).retainedComment)).toBe(true);
  await expect(draft).toBeFocused();
  expect(await draft.evaluate(input => [(input as HTMLTextAreaElement).selectionStart, (input as HTMLTextAreaElement).selectionEnd])).toEqual([6, 16]);
  expect(await comments.evaluate(element => Boolean(element.closest(".video-viewer-context")))).toBe(true);

  await page.setViewportSize({ width: 390, height: 900 });
  expect(await page.evaluate(() => localStorage.getItem("cms.video-viewer.context-width"))).toBe(savedWidth);
  await page.setViewportSize({ width: 850, height: 900 });
  await expect(divider).toBeVisible();
  await expect(draft).toBeFocused();
  expect(await page.evaluate(() => localStorage.getItem("cms.video-viewer.context-width"))).toBe(savedWidth);
  expect(await comments.evaluate(element => Boolean(element.closest(".video-viewer-reading")))).toBe(true);

  await page.addStyleTag({ content: "html { font-size: 200%; }" });
  await expect(workspace).toHaveAttribute("data-stacked", "true");
  await expect(divider).toBeHidden();
  await expect(page.getByRole("tab", { name: "Watch & details", exact: true })).toBeVisible();
  await expect(draft).toBeVisible();
  expect(await comments.evaluate(element => Boolean(element.closest(".video-viewer-context")))).toBe(true);
  expect(await workspace.evaluate(element => element.scrollWidth > element.clientWidth + 1)).toBe(false);

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(divider).toBeVisible();
  await expect.poll(async () => Number(await divider.getAttribute("aria-valuemin"))).toBeGreaterThan(40);
  expect(await page.evaluate(() => localStorage.getItem("cms.video-viewer.context-width"))).toBe(savedWidth);
  await divider.press("End");
  const enlarged = await workspace.evaluate(element => {
    const minimum = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) * 18;
    const left = element.querySelector<HTMLElement>(".video-viewer-context")!.getBoundingClientRect().width;
    const right = element.querySelector<HTMLElement>(".video-viewer-reading")!.getBoundingClientRect().width;
    return { minimum, left, right, overflow: element.scrollWidth > element.clientWidth + 1 };
  });
  expect(enlarged.left).toBeGreaterThanOrEqual(enlarged.minimum - 1);
  expect(enlarged.right).toBeGreaterThanOrEqual(enlarged.minimum - 1);
  expect(enlarged.overflow).toBe(false);
});

test("enlarging text in an open viewer re-fits a saved wide divider", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("cms.video-viewer.context-width", "60"));
  await openMediaRefinement(page, 1280);
  const workspace = page.locator(".video-viewer-workspace");
  await expect(page.getByRole("separator", { name: "Resize Watch & details", exact: true })).toBeVisible();
  await page.addStyleTag({ content: "html { font-size: 200%; }" });
  await expect.poll(() => workspace.evaluate(element => {
    if (element.hasAttribute("data-stacked")) return true;
    const minimum = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) * 18;
    const left = element.querySelector<HTMLElement>(".video-viewer-context")!.getBoundingClientRect().width;
    const right = element.querySelector<HTMLElement>(".video-viewer-reading")!.getBoundingClientRect().width;
    return left >= minimum - 1 && right >= minimum - 1 && element.scrollWidth <= element.clientWidth + 1;
  })).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem("cms.video-viewer.context-width"))).toBe("60");
});

test("phone views, contexts, corrections and breakpoints retain playback and drafts", async ({ page }) => {
  const requests = await openMediaRefinement(page, 390);
  await watch(page);
  await page.locator("video").evaluate(async (video: HTMLVideoElement) => {
    (window as unknown as { retainedPlayer: HTMLVideoElement }).retainedPlayer = video;
    video.muted = true;
    video.playbackRate = 1.5;
    await video.play();
    video.currentTime = 12;
  });
  const title = page.getByRole("textbox", { name: "Title", exact: true });
  await title.fill("Unsaved details retained across panes");
  await page.getByRole("tab", { name: "Comments", exact: true }).click();
  await page.getByRole("textbox", { name: "New comment", exact: true }).fill("Unsaved comment");
  await page.getByRole("tab", { name: "Your review", exact: true }).click();
  await page.getByRole("textbox", { name: "Notes", exact: true }).fill("Private unsaved review");
  await read(page);
  await page.getByRole("button", { name: "Edit transcript", exact: true }).click();
  const passage = page.getByRole("textbox", { name: "Passage 1", exact: true });
  await passage.fill("A correction retained across panes");
  await passage.evaluate(input => { (window as unknown as { retainedEditor: Element }).retainedEditor = input; });
  await watch(page);
  await read(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(passage).toHaveValue("A correction retained across panes");
  expect(await passage.evaluate(input => input === (window as unknown as { retainedEditor: Element }).retainedEditor)).toBe(true);
  expect(await page.locator("video").evaluate((video: HTMLVideoElement) => video === (window as unknown as { retainedPlayer: HTMLVideoElement }).retainedPlayer && !video.paused && video.currentTime >= 12 && video.playbackRate === 1.5)).toBe(true);
  const detailsTab = page.getByRole("tab", { name: "Details", exact: true });
  await detailsTab.click();
  await expect(title).toHaveValue("Unsaved details retained across panes");
  await expect(detailsTab).toBeFocused();
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(page.getByRole("tab", { name: "Watch & details", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(detailsTab).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("tab", { name: "Comments", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "New comment", exact: true })).toHaveValue("Unsaved comment");
  await page.getByRole("tab", { name: "Your review", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Notes", exact: true })).toHaveValue("Private unsaved review");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("button", { name: "Keep editing", exact: true })).toBeFocused();
  expect(requests.some(endpoint => /cmsRequest|cmsSave|cmsUpdate|cmsCreateMediaComment/.test(endpoint))).toBe(false);
});

test("phone seek and continuous clip selection reveal the existing player and clip controls", async ({ page }) => {
  const requests = await openMediaRefinement(page, 390);
  await watch(page);
  await page.getByRole("tab", { name: "Comments", exact: true }).click();
  const commentDraft = page.getByRole("textbox", { name: "New comment", exact: true });
  await commentDraft.fill("Keep this comment context");
  await read(page);
  await page.getByRole("button", { name: "Seek to 00:00:08.300", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Watch & details", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "Comments", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(commentDraft).toHaveValue("Keep this comment context");
  await expect(page.locator("video")).toBeFocused();
  await read(page);
  await page.getByRole("button", { name: "Select passages", exact: true }).click();
  await page.getByRole("checkbox", { name: "Select passage 1", exact: true }).check();
  await page.getByRole("checkbox", { name: "Select passage 3", exact: true }).check();
  await expect(page.getByRole("region", { name: "Clip selection", exact: true })).toContainText("includes gaps and unselected passages");
  await page.getByRole("button", { name: "Use selected range as clip", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "In time", exact: true })).toBeFocused();
  await expect(page.getByRole("textbox", { name: "In time", exact: true })).toHaveValue("00:00:00.000");
  await expect(page.getByRole("textbox", { name: "Out time", exact: true })).toHaveValue("00:00:11.940");
  expect(requests.some(endpoint => endpoint.startsWith("cmsRequest"))).toBe(false);
});

test("native header validation reveals the mounted title from the phone transcript", async ({ page }) => {
  const requests = await openMediaRefinement(page, 390);
  await watch(page);
  const title = page.getByRole("textbox", { name: "Title", exact: true });
  await title.fill("");
  await read(page);
  await page.getByRole("button", { name: "Save details", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Watch & details", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(title).toBeFocused();
  expect(requests.some(endpoint => /cmsUpdateSourceMedia/.test(endpoint))).toBe(false);
});

for (const width of [390, 1280]) {
  test(`${width}px renewing preview access shows progress and retains the latest native playback choices`, async ({ page }) => {
    await openMediaRefinement(page, width);
    await page.locator("video").evaluate(async (video: HTMLVideoElement) => {
      (window as unknown as { retainedPlayer: HTMLVideoElement }).retainedPlayer = video;
      video.muted = true;
      await video.play();
      video.currentTime = 12;
      video.playbackRate = 1.25;
      video.dispatchEvent(new Event("error"));
    });
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    let pending = false;
    await page.route("**/cmsCreateSourceMediaRead", async route => {
      pending = true;
      await gate;
      await route.fulfill({ json: { success: true, access: {
        url: `${new URL(route.request().url()).origin}/local-media-frame-preview.mp4?renewed=1`, expiresAt: "2026-08-20T20:00:00Z",
      } } });
    });
    await page.getByRole("button", { name: "Refresh preview", exact: true }).click();
    await expect.poll(() => pending).toBe(true);
    const progress = page.locator(".media-dialog-notices").getByRole("status", { name: "Renewing private preview", exact: true });
    try {
      await expect(progress).toBeInViewport();
      await expect(page.getByRole("status", { name: "Renewing private preview", exact: true })).toHaveCount(1);
      if (width === 390) await expect(page.getByRole("tab", { name: "Transcript", exact: true })).toHaveAttribute("aria-selected", "true");
      await page.locator("video").evaluate((video: HTMLVideoElement) => { video.pause(); video.playbackRate = 2; video.currentTime = 20; });
    } finally { finish(); }
    await expect(progress).toHaveCount(0);
    await expect.poll(() => page.locator("video").evaluate((video: HTMLVideoElement) => video.readyState >= 1 && video.currentTime === 20 && video.playbackRate === 2 && video.paused)).toBe(true);
    expect(await page.locator("video").evaluate(video => video === (window as unknown as { retainedPlayer: HTMLVideoElement }).retainedPlayer)).toBe(true);
  });
}

for (const width of [390, 1280]) {
  test(`${width}px automatic preview renewal stays silent without shifting the workspace`, async ({ page }) => {
    await page.clock.install({ time: new Date(FROZEN_NOW) });
    await openMediaRefinement(page, width);
    const workspace = page.locator(".video-viewer-workspace");
    const passages = page.locator(".transcript-passages");
    const before = { workspace: await workspace.boundingBox(), passages: await passages.boundingBox() };
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    let pending = false;
    await page.route("**/cmsCreateSourceMediaRead", async route => {
      pending = true;
      await gate;
      await route.fulfill({ json: { success: true, access: {
        url: `${new URL(route.request().url()).origin}/local-media-frame-preview.mp4?renewed=1`, expiresAt: "2026-08-20T20:00:00Z",
      } } });
    });
    await page.clock.fastForward(60 * 60 * 1000);
    await expect.poll(() => pending).toBe(true);
    try {
      await settle(page);
      await expect(page.getByRole("status", { name: "Renewing private preview", exact: true })).toHaveCount(0);
      expect({ workspace: await workspace.boundingBox(), passages: await passages.boundingBox() }).toEqual(before);
    } finally { finish(); }
  });
}

for (const height of [350, 800]) {
  test(`short/enlarged ${height}px workspace keeps task controls reachable`, async ({ page }) => {
    await openMediaRefinement(page, 390);
    await page.setViewportSize({ width: 390, height });
    if (height === 800) await page.addStyleTag({ content: "html { font-size: 200%; } .transcript-passage { font-size: 30px !important; }" });
    await page.getByRole("button", { name: "Select passages", exact: true }).click();
    await page.getByRole("checkbox", { name: "Select passage 1", exact: true }).check();
    const selection = page.getByRole("region", { name: "Clip selection", exact: true });
    await selection.getByRole("button", { name: "Clear selection", exact: true }).click();
    await expect(selection).toContainText("0 passages selected");
    const next = page.getByRole("button", { name: "Next page", exact: true });
    await next.click();
    await expect(page.getByRole("listitem", { name: /^Passage 51:/ })).toBeVisible();
    expect(await page.locator(".video-viewer-workspace").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await watch(page);
    if (height <= 520) {
      await expect.poll(async () => (await page.locator(".source-video-player").boundingBox())!.height)
        .toBeLessThanOrEqual(height * 0.32 + 1);
    }
    await page.getByRole("tab", { name: "Your review", exact: true }).click();
    await page.getByRole("textbox", { name: "Notes", exact: true }).fill("Reachable at enlarged text");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("button", { name: "Keep editing", exact: true })).toBeFocused();
  });
}

test("short desktop workspace keeps the player below its task controls", async ({ page }) => {
  await openMediaRefinement(page, 1280);
  await page.setViewportSize({ width: 1280, height: 520 });
  await expect.poll(async () => (await page.locator(".source-video-player").boundingBox())!.height)
    .toBeLessThanOrEqual(520 * 0.32 + 1);
});

for (const width of [390, 1280]) {
  test(`text controls at ${width}px fit both panes and keep actions reachable`, async ({ page }) => {
    await openMediaRefinement(page, width, "text");
    const actions = page.getByRole("group", { name: "Transcript actions", exact: true });
    for (const name of ["Rename speakers", "Edit transcript", "Select passages"]) {
      const control = actions.getByRole("button", { name, exact: true });
      await expect(control).toBeInViewport();
      await expect(control).toHaveText(name);
    }
    expect(await page.locator(".transcript-command-bar").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await actions.getByRole("button", { name: "Select passages", exact: true }).click();
    await expect(actions.getByRole("button", { name: "Cancel selection", exact: true })).toBeInViewport();
    await expect(actions.getByRole("button", { name: "Cancel selection", exact: true })).toHaveText("Cancel selection");
    await watch(page);
    await page.getByRole("tab", { name: "Your review", exact: true }).click();
    await page.getByRole("textbox", { name: "Notes", exact: true }).fill("Text controls retain the current private draft");
    await page.getByRole("tab", { name: "Details", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Title", exact: true })).toBeVisible();
  });
}

test("phone Transcript selection stays visible while its tab is hovered and pressed", async ({ page }) => {
  await openMediaRefinement(page, 390);
  await watch(page);
  const transcript = page.getByRole("tab", { name: "Transcript", exact: true });
  await transcript.click();
  await expect(transcript).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "Watch & details", exact: true })).toHaveAttribute("aria-selected", "false");
  await expect(page.getByRole("tabpanel", { name: "Transcript", exact: true })).toBeVisible();
  await expect(page.getByRole("tabpanel", { name: "Watch & details", exact: true })).toBeHidden();
  const { brand, surface } = await transcript.evaluate(element => {
    const probe = document.createElement("span");
    probe.style.color = "var(--cms-brand)";
    probe.style.backgroundColor = "var(--cms-surface)";
    element.append(probe);
    const style = getComputedStyle(probe);
    const colors = { brand: style.color, surface: style.backgroundColor };
    probe.remove();
    return colors;
  });
  for (const pressed of [false, true]) {
    await transcript.hover();
    if (pressed) await page.mouse.down();
    try {
      await expect(transcript).toHaveCSS("color", brand);
      await expect(transcript).toHaveCSS("border-bottom-color", brand);
      await expect(transcript).toHaveCSS("border-bottom-width", "2px");
      await expect(transcript).toHaveCSS("background-color", surface);
    } finally {
      if (pressed) await page.mouse.up();
    }
  }
});

test("phone workspace and context tabs own arrows and preserve the asset", async ({ page }) => {
  const requests = await openMediaRefinement(page, 390);
  const transcript = page.getByRole("tab", { name: "Transcript", exact: true });
  await transcript.focus();
  await transcript.press("Home");
  const watchTab = page.getByRole("tab", { name: "Watch & details", exact: true });
  await expect(watchTab).toBeFocused();
  await expect(watchTab).toHaveAttribute("aria-selected", "true");
  const details = page.getByRole("tab", { name: "Details", exact: true });
  await details.focus();
  await details.press("End");
  await expect(page.getByRole("tab", { name: "Your review", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(details).toBeFocused();
  await expect(details).toHaveAttribute("aria-selected", "true");
  await watchTab.focus();
  await watchTab.press("ArrowRight");
  await expect(transcript).toBeFocused();
  await expect(transcript).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("dialog")).toHaveAccessibleName("Waterfront oral history — interview master");
  expect(requests.some(endpoint => endpoint.startsWith("cmsRequest"))).toBe(false);
});


test("a dirty-close notice retains the phone transcript view and correction after Keep editing", async ({ page }) => {
  await openMediaRefinement(page, 390);
  await page.getByRole("button", { name: "Edit transcript", exact: true }).click();
  const correction = page.getByRole("textbox", { name: "Passage 1", exact: true });
  await correction.fill("A correction kept in the Transcript view");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const keep = page.getByRole("button", { name: "Keep editing", exact: true });
  await expect(keep).toBeFocused();
  await expect(page.getByRole("tab", { name: "Transcript", exact: true })).toHaveAttribute("aria-selected", "true");
  await keep.click();
  await expect(correction).toBeVisible();
  await expect(correction).toHaveValue("A correction kept in the Transcript view");
  await expect(page.getByRole("tab", { name: "Transcript", exact: true })).toHaveAttribute("aria-selected", "true");
});

for (const width of [1280, 390]) {
  test(`header metadata conflicts stay visible outside both panes at ${width}px`, async ({ page }) => {
    await openMediaRefinement(page, width);
    await watch(page);
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("A local draft that conflicts");
    const current = { id: "media-frame-interview", sourceId: "video-library", kind: "video", version: 2,
      name: "Newer server title", originalName: "interview-master.mp4", mimeType: "video/mp4", sizeBytes: 1024,
      preview: "browser", tags: ["interview"], rightsStatus: "complete", description: null, license: null, credit: null,
      createdAt: null, updatedAt: null, viewingCopy: { state: "ready", width: 640, height: 360, durationSeconds: 5400, sizeBytes: 1024 } };
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    let requested = false;
    await page.route("**/cmsUpdateSourceMediaMetadata", async route => {
      requested = true;
      await pending;
      await route.fulfill({ status: 409, json: { error: "The saved video changed", current } });
    });
    await page.getByRole("button", { name: "Save details", exact: true }).click();
    await expect.poll(() => requested).toBe(true);
    await read(page);
    finish();
    const notices = page.locator(".media-dialog-notices");
    await expect(notices.getByText("This video changed. Reload its current details before saving.", { exact: true })).toBeInViewport();
    const reload = notices.getByRole("button", { name: "Reload details", exact: true });
    await expect(reload).toBeInViewport();
    if (width === 390) await expect(page.getByRole("tab", { name: "Transcript", exact: true })).toHaveAttribute("aria-selected", "true");
    await reload.click();
    await watch(page);
    await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Newer server title");
    await expect(notices.getByRole("button", { name: "Reload details", exact: true })).toHaveCount(0);
  });
}

for (const [item, message] of [["Original video", "The original file could not be downloaded. Try again."],
  ["Web copy", "The web copy could not be downloaded. Try again."]]) {
  test(`phone transcript keeps the ${item} download failure visible`, async ({ page }) => {
    await openMediaRefinement(page, 390);
    await page.route("**/cmsCreateSourceMediaRead", route => route.fulfill({ status: 503, json: { error: "Unavailable" } }));
    await page.getByRole("button", { name: "Download", exact: true }).click();
    await page.getByRole("menuitem", { name: new RegExp(`^${item}`) }).click();
    await expect(page.locator(".media-dialog-notices").getByText(message, { exact: true })).toBeInViewport();
    await expect(page.getByRole("tab", { name: "Transcript", exact: true })).toHaveAttribute("aria-selected", "true");
  });
}

for (const width of [390, 1280]) {
  test(`${width}px keeps preview failure, renewal progress and recovery visible`, async ({ page }) => {
    await openMediaRefinement(page, width);
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    let pending = false;
    await page.route("**/cmsCreateSourceMediaRead", async route => {
      pending = true;
      await gate;
      await route.fulfill({ status: 503, json: { error: "Unavailable" } });
    });
    await page.locator("video").evaluate(video => {
      (window as unknown as { retainedPlayer: HTMLVideoElement }).retainedPlayer = video as HTMLVideoElement;
      video.dispatchEvent(new Event("error"));
    });
    const notices = page.locator(".media-dialog-notices");
    await expect(notices.getByText(/Playback stopped/)).toBeInViewport();
    const refresh = notices.getByRole("button", { name: "Refresh preview", exact: true });
    await refresh.click();
    await expect.poll(() => pending).toBe(true);
    const progress = notices.getByRole("status", { name: "Renewing private preview", exact: true });
    try {
      await expect(progress).toBeInViewport();
      if (width === 390) await expect(page.getByRole("tab", { name: "Transcript", exact: true })).toHaveAttribute("aria-selected", "true");
    } finally { finish(); }
    await expect(notices.getByRole("alert").filter({ hasText: "The preview could not be opened. Try again or download the original file." })).toBeInViewport();
    await expect(progress).toHaveCount(0);
    expect(await page.locator("video").evaluate(video => video === (window as unknown as { retainedPlayer: HTMLVideoElement }).retainedPlayer)).toBe(true);
    await expect(refresh).toBeInViewport();
    await page.unroute("**/cmsCreateSourceMediaRead");
    const recovered = page.waitForResponse("**/cmsCreateSourceMediaRead");
    await refresh.click();
    expect((await recovered).status()).toBe(200);
    await expect(progress).toHaveCount(0);
    await expect(notices.getByText("Video access needs attention", { exact: true })).toHaveCount(0);
    if (width === 390) await expect(page.getByRole("tab", { name: "Transcript", exact: true })).toHaveAttribute("aria-selected", "true");
  });
}

test("valid header metadata save preserves the active phone pane and context", async ({ page }) => {
  await openMediaRefinement(page, 390);
  await watch(page);
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Saved from the transcript view");
  await page.getByRole("tab", { name: "Comments", exact: true }).click();
  await read(page);
  await page.route("**/cmsUpdateSourceMediaMetadata", route => route.fulfill({ json: { success: true, asset: {
    id: "media-frame-interview", sourceId: "video-library", kind: "video", version: 2,
    name: "Saved from the transcript view", originalName: "interview-master.mp4", mimeType: "video/mp4", sizeBytes: 1024,
    preview: "browser", tags: ["interview"], rightsStatus: "complete", description: null, license: null, credit: null,
    createdAt: null, updatedAt: null, viewingCopy: { state: "ready", width: 640, height: 360, durationSeconds: 5400, sizeBytes: 1024 },
  } } }));
  await page.getByRole("button", { name: "Save details", exact: true }).click();
  await expect(page.locator(".media-dialog-notices").getByText("Video details saved.", { exact: true })).toBeInViewport();
  await expect(page.getByRole("tab", { name: "Transcript", exact: true })).toHaveAttribute("aria-selected", "true");
  await watch(page);
  await expect(page.getByRole("tab", { name: "Comments", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("a phone link to a video time opens the visible player at that moment", async ({ page }) => {
  const requests = await openMediaRefinement(page, 390);
  await page.goto("/gallery.html?embed=media-refinement-frame&presentation=icons&asset=media-frame-interview&t=12");
  await expect(page.getByRole("tab", { name: "Watch & details", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("video")).toBeInViewport();
  await expect.poll(() => page.locator("video").evaluate((video: HTMLVideoElement) => video.currentTime)).toBe(12);
  expect(requests.some(endpoint => endpoint.startsWith("cmsRequest"))).toBe(false);
});
