import { expect, test, type Page } from "./fixtures";
import { openMediaRefinement } from "./media-refinement.fixture";

function controls(page: Page) {
  const video = page.locator("video");
  const open = page.getByRole("button", { name: "Bookmarks", exact: true });
  const panel = page.getByRole("dialog", { name: "Video bookmarks", exact: true });
  const name = panel.getByRole("textbox", { name: "Bookmark name", exact: true });
  const jump = panel.getByRole("button", { name: "Opening remark · 0:12", exact: true });
  const resume = panel.getByRole("button", { name: "Resume at 0:48", exact: true });
  return {
    video, open, panel, name, jump, resume,
    time: () => video.evaluate((element: HTMLVideoElement) => element.currentTime),
    seek: (seconds: number) => video.evaluate((element: HTMLVideoElement, seconds) => { element.currentTime = seconds; }, seconds),
    ready: () => expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(1),
  };
}

for (const width of [390, 1280]) test(`save and navigate personal video moments by keyboard at ${width}px`, async ({ page }) => {
  await openMediaRefinement(page, width);
  const { video, open, panel, name, jump, resume, time, seek, ready } = controls(page);
  expect(await time()).toBe(0);
  await seek(12);
  const download = page.getByRole("button", { name: "Download", exact: true });
  await download.focus();
  await page.keyboard.press("ArrowRight");
  await expect(open).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(name).toBeFocused();
  await page.keyboard.type("Opening remark");
  await page.keyboard.press("Enter");
  await expect(jump).toBeVisible();
  await expect(name).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(open).toBeFocused();
  await expect(panel).toBeHidden();

  if (width === 390) await page.getByRole("tab", { name: "Watch & details", exact: true }).press("Enter");
  await seek(48);
  await open.press("Enter");
  await panel.getByRole("button", { name: "Save resume position", exact: true }).press("Enter");
  await expect(resume).toBeVisible();
  await page.reload();
  await ready();

  await open.press("Enter");
  await jump.press("Enter");
  await expect.poll(time).toBeCloseTo(12, 1);
  await expect(video).toBeFocused();
  await open.press("Enter");
  await resume.press("Enter");
  await expect.poll(time).toBeCloseTo(48, 1);
  await expect(video).toBeFocused();

  await open.press("Enter");
  await panel.getByRole("button", { name: "Delete bookmark Opening remark at 0:12", exact: true }).press("Enter");
  await expect(name).toBeFocused();
  await panel.getByRole("button", { name: "Clear resume position", exact: true }).press("Enter");
  await page.reload();
  await ready();
  expect(await time()).toBe(0);
  await open.press("Enter");
  await expect(jump).toBeHidden();
  await expect(resume).toBeHidden();
});

for (const width of [390, 1280]) test(`return to a transcript draft after visiting saved moments at ${width}px`, async ({ page }) => {
  await openMediaRefinement(page, width);
  const { video, open, panel, name, jump, resume, time, seek } = controls(page);
  await seek(12);
  await open.press("Enter");
  await name.fill("Opening remark");
  await name.press("Enter");
  await expect(jump).toBeVisible();
  await page.keyboard.press("Escape");
  await seek(48);
  await open.press("Enter");
  await panel.getByRole("button", { name: "Save resume position", exact: true }).press("Enter");
  await expect(resume).toBeVisible();
  await page.keyboard.press("Escape");

  const transcript = page.getByRole("region", { name: "Saved video transcript", exact: true });
  const search = transcript.getByRole("searchbox", { name: "Search loaded transcript" });
  await search.fill("Archive");
  const next = transcript.getByRole("button", { name: "Next page", exact: true });
  await next.press("Enter");
  await next.press("Enter");
  await transcript.getByRole("button", { name: "Passage 114 actions", exact: true }).press("Enter");
  await page.getByRole("menuitem", { name: "Edit passage 114", exact: true }).press("Enter");
  const correction = transcript.getByRole("textbox", { name: "Passage 114", exact: true });
  const draft = "Verified firsthand account of the waterfront archive.";
  await expect(correction).toBeFocused();
  await correction.fill(draft);
  const passages = transcript.getByRole("list", { name: "Transcript passages" });
  const readingPosition = await passages.evaluate(list => list.scrollTop);
  const returnToCorrection = page.getByRole("button", { name: "Return to transcript correction", exact: true });
  await expect(returnToCorrection).toBeHidden();

  for (const [moment, seconds] of [[jump, 12], [resume, 48]] as const) {
    await open.press("Enter");
    await moment.press("Enter");
    await expect.poll(time).toBeCloseTo(seconds, 1);
    await expect(video).toBeFocused();
    await expect(panel).toBeHidden();
    await returnToCorrection.press("Enter");
    await expect(correction).toBeFocused();
    await expect(correction).toBeInViewport();
    await expect(correction).toHaveValue(draft);
    await expect(search).toHaveValue("Archive");
    await expect(transcript.getByText("Page 3 of 3", { exact: true })).toBeVisible();
    expect(await passages.evaluate(list => list.scrollTop)).toBe(readingPosition);
    await expect(transcript.getByRole("button", { name: "Follow playback", exact: true })).toHaveAttribute("aria-pressed", "false");
    await expect.poll(time).toBeCloseTo(seconds, 1);
  }

  await transcript.getByRole("button", { name: "Cancel edits", exact: true }).press("Enter");
  const follow = transcript.getByRole("button", { name: "Follow playback", exact: true });
  await expect(follow).toHaveAttribute("aria-pressed", "false");
  await follow.press("Enter");
  await expect(transcript.getByRole("button", { name: "Following playback", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(transcript.getByRole("listitem", { name: /^Passage 5:/ })).toHaveAttribute("aria-current", "true");
});

test("saved moments require the same editor and an available, matching file version", async ({ page }) => {
  await openMediaRefinement(page, 1280);
  const { video, open, panel, name, jump, resume, time, seek, ready } = controls(page);
  const original = page.url();
  await seek(12);
  await open.press("Enter");
  await name.fill("Opening remark");
  await name.press("Enter");
  await page.keyboard.press("Escape");
  await seek(48);
  await open.press("Enter");
  await panel.getByRole("button", { name: "Save resume position", exact: true }).press("Enter");
  await expect(resume).toBeVisible();

  for (const change of ["other-editor", "replacement"]) {
    const url = new URL(original);
    url.searchParams.set(change, "1");
    await page.goto(url.href);
    await ready();
    expect(await time()).toBe(0);
    await open.press("Enter");
    await expect(panel).toBeVisible();
    await expect(jump).toBeHidden();
    await expect(resume).toBeHidden();
  }

  const unavailable = "**/cmsCreateSourceMediaRead";
  await page.route(unavailable, route => route.fulfill({ status: 404, json: { error: "Fixture is unavailable" } }));
  await page.goto(original);
  await expect(page.getByRole("button", { name: "Refresh preview", exact: true })).toBeVisible();
  await expect(open).toBeHidden();
  await expect(video).toHaveCount(0);

  await page.unroute(unavailable);
  await page.reload();
  await ready();
  await open.press("Enter");
  await expect(jump).toBeVisible();
  await expect(resume).toBeVisible();
});
