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
