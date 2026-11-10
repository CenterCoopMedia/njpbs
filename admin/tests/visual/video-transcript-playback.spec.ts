import { test, expect } from "./fixtures";
import { openMediaRefinement } from "./media-refinement.fixture";

const point = { id: "transcript-point", authorUid: "synthetic-editor", authorName: "Editor Alex", text: "Check the opening cut.",
  version: 1, createdAt: "2026-08-20T12:00:00Z", updatedAt: "2026-08-20T12:00:00Z", canEdit: false, hasReplies: true,
  time: { startMs: 3000, endMs: null, startFrame: null, endFrame: null, rateNum: null, rateDen: null, currentVersion: true } };
const range = { ...point, id: "transcript-range", authorName: "Producer Jordan", text: "Keep the full answer here.", hasReplies: false,
  time: { ...point.time, startMs: 40000, endMs: 60000 } };
const reply = { ...point, id: "transcript-reply", parentId: point.id, time: undefined, text: "The opening pause is intentional.", authorName: "Producer Jordan" };

for (const width of [1280, 390]) test(`transcript playback and timed comments at ${width}px`, async ({ page }) => {
  await openMediaRefinement(page, width);
  await page.route("**/cmsListMediaComments", route => route.fulfill({ json: { success: true, comments: [point, range, reply], nextCursor: null } }));
  await page.reload();
  const transcript = page.getByRole("region", { name: "Saved video transcript", exact: true });
  await expect(transcript).toBeVisible();
  const search = transcript.getByRole("searchbox", { name: "Search loaded transcript" });
  await search.focus();
  await page.locator("video").evaluate((video: HTMLVideoElement) => { video.currentTime = 120; });
  const current = transcript.locator('[aria-current="true"]');
  await expect(current).toHaveAccessibleName(/^Passage 11:/);
  await expect(search).toBeFocused();
  await expect(current).toBeInViewport();
  await transcript.locator(".transcript-passages").dispatchEvent("wheel", { deltaY: -200 });
  await expect(transcript.getByRole("button", { name: "Follow playback", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.locator("video").evaluate((video: HTMLVideoElement) => { video.currentTime = 1; });
  await transcript.getByRole("button", { name: "Follow playback", exact: true }).click();
  await expect(current).toHaveAccessibleName(/^Passage 1:/);
  await expect(current).toBeInViewport();
  await search.fill("winter");
  const speakers = transcript.getByRole("combobox", { name: "Filter by speaker", exact: true });
  await speakers.selectOption("spk_2");
  await transcript.locator(".transcript-timestamp").first().press("Enter");
  await expect.poll(() => page.locator("video").evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(60, 1);
  if (width === 390) await page.getByRole("tab", { name: "Transcript", exact: true }).click();
  await expect(search).toHaveValue("winter");
  await expect(speakers).toHaveValue("spk_2");
  await expect(transcript.getByRole("button", { name: "Follow playback", exact: true })).toHaveAttribute("aria-pressed", "false");
  await transcript.getByRole("button", { name: "Follow playback", exact: true }).click();
  await expect(search).toHaveValue("");
  await expect(speakers).toHaveValue("");
  const summary = transcript.locator("summary").filter({ hasText: "Check the opening cut." });
  await summary.focus();
  await summary.press("Enter");
  await expect(transcript.getByRole("list", { name: "Replies to Editor Alex" })).toContainText("The opening pause is intentional.");
  await expect(summary).toBeFocused();
  const timestamp = transcript.locator(".transcript-timestamp").nth(1);
  await timestamp.focus(); await timestamp.press("Enter");
  await expect(page.locator("video")).toBeInViewport();
  await expect.poll(() => page.locator("video").evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(8.12, 1);
  if (width === 390) await page.getByRole("tab", { name: "Transcript", exact: true }).click();
  await expect(transcript.getByRole("button", { name: "Following playback", exact: true })).toHaveAttribute("aria-pressed", "true");
  if (width === 390) await page.getByRole("tab", { name: "Watch & details", exact: true }).click();
  const seek = page.getByRole("slider", { name: "Review video position", exact: true });
  await seek.focus(); await expect(seek).toHaveValue("8.12"); await seek.press("ArrowRight");
  await expect.poll(() => page.locator("video").evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(8.12);
  const markers = page.getByRole("toolbar", { name: "Comment markers" });
  const first = markers.getByRole("button").first();
  await first.focus();
  await expect(page.locator(".media-comment-card")).toContainText("Editor Alex");
  await first.press("ArrowRight");
  await expect(markers.getByRole("button").nth(1)).toBeFocused();
  await expect(page.locator(".media-comment-card")).toContainText("Producer Jordan");
  await page.keyboard.press("Escape");
  await expect(page.locator(".media-comment-card")).toHaveCount(0);
  const laneBox = (await markers.boundingBox())!;
  const seekBox = (await seek.boundingBox())!;
  const videoBox = (await page.locator("video").boundingBox())!;
  expect(laneBox.y + laneBox.height).toBeLessThanOrEqual(seekBox.y + 1);
  // Keep the resting picture clear by placing the strip below it.
  expect(laneBox.y).toBeGreaterThanOrEqual(videoBox.y + videoBox.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const read = page.getByRole("tab", { name: "Transcript", exact: true });
  if (await read.isVisible()) await read.click();
  await transcript.getByRole("button", { name: "Open in Comments", exact: true }).click();
  await expect(page.locator(`#media-comment-${point.id}`)).toBeFocused();
  await expect(page.getByRole("tabpanel", { name: "Comments", exact: true })).toBeVisible();
});

test("playback loads later saved passages once and preserves explicit retry after failure", async ({ page }) => {
  await openMediaRefinement(page, 1280);
  let cursorReads = 0;
  const first = { index: 0, startSeconds: 0, endSeconds: 5, speaker: "spk_0", text: "Opening passage" };
  const second = { index: 1, startSeconds: 6, endSeconds: 15, speaker: "spk_0", text: "Later saved passage" };
  await page.route("**/cmsGetVideoTranscript", route => {
    const cursor = route.request().postDataJSON()?.cursor;
    if (cursor && ++cursorReads === 1) return route.fulfill({ status: 503, json: { error: "Fixture page unavailable" } });
    return route.fulfill({ json: { success: true, cached: true, transcript: { id: "playback-pages", state: "ready", totalSegments: 2,
      segments: cursor ? [second] : [first], nextCursor: cursor ? null : "saved-page-two" } } });
  });
  await page.reload();
  const transcript = page.getByRole("region", { name: "Saved video transcript", exact: true });
  await expect(transcript).toContainText("Opening passage");
  const edit = transcript.getByRole("button", { name: "Edit transcript", exact: true });
  await edit.focus();
  await page.locator("video").evaluate((video: HTMLVideoElement) => { video.currentTime = 8; });
  await expect(page.getByRole("slider", { name: "Review video position", exact: true })).toHaveValue("8");
  await expect(edit).toBeFocused();
  expect(cursorReads).toBe(0);
  await page.locator("video").focus();
  await page.locator("video").evaluate((video: HTMLVideoElement) => { video.currentTime = 9; });
  await expect(page.getByText(/Processing is currently unavailable/)).toBeVisible();
  await page.locator("video").evaluate((video: HTMLVideoElement) => { video.currentTime = 10; });
  await expect.poll(() => page.locator("video").evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(10, 1);
  expect(cursorReads).toBe(1);
  await page.getByRole("button", { name: "Load more transcript", exact: true }).click();
  await expect(transcript.locator('[aria-current="true"]')).toContainText("Later saved passage");
  expect(cursorReads).toBe(2);
  await expect(page.getByText(/Processing is currently unavailable/)).toHaveCount(0);
});

test("background passage reads retain download errors and leave Close usable", async ({ page }) => {
  await openMediaRefinement(page, 1280);
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let cursorReads = 0;
  await page.route("**/cmsGetVideoTranscript", async route => {
    const cursor = route.request().postDataJSON()?.cursor;
    if (cursor) { cursorReads++; await gate; }
    return route.fulfill({ json: { success: true, cached: true, transcript: { id: "background-pages", state: "ready", totalSegments: 2,
      segments: [{ index: cursor ? 1 : 0, startSeconds: cursor ? 6 : 0, endSeconds: cursor ? 15 : 5, speaker: "spk_0", text: cursor ? "Later passage" : "Opening passage" }],
      nextCursor: cursor ? null : "page-two" } } });
  });
  await page.route("**/cmsCreateVideoTranscriptRead", route => route.fulfill({ status: 503, json: { error: "Fixture download unavailable" } }));
  await page.reload();
  await expect(page.getByRole("region", { name: "Saved video transcript", exact: true })).toContainText("Opening passage");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Plain text/ }).click();
  const error = page.getByText(/Processing is currently unavailable/);
  await expect(error).toBeVisible();
  await page.locator("video").focus();
  await page.locator("video").evaluate((video: HTMLVideoElement) => { video.currentTime = 8; });
  await expect.poll(() => cursorReads).toBe(1);
  try {
    const close = page.getByRole("button", { name: "Close", exact: true });
    await expect(close).toBeEnabled();
    await close.focus();
    await expect(close).toBeFocused();
    await expect(error).toBeVisible();
    await close.click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally { finish(); }
});
