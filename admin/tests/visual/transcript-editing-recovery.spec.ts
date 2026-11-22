import { test, expect } from "./fixtures";
import { openMediaRefinement } from "./media-refinement.fixture";
import { mediaTranscriptFixture } from "../../src/dev/fixtures/media-transcript";

for (const width of [1280, 390]) test(`late correction and save recovery at ${width}px`, async ({ page }) => {
  await openMediaRefinement(page, width);
  let releaseFailure!: () => void;
  const failure = new Promise<void>(resolve => { releaseFailure = resolve; });
  let saves = 0;
  const draft = "Verified correction for the waterfront archive.";
  await page.route("**/cmsSaveVideoTranscript", async route => {
    expect(route.request().postDataJSON()?.segments).toEqual([{ index: 104, speaker: "unknown", text: draft }]);
    if (++saves === 1) {
      await failure;
      return route.fulfill({ status: 503, json: { error: "Fixture save unavailable" } });
    }
    const fixture = mediaTranscriptFixture();
    return route.fulfill({ json: { success: true, cached: true, transcript: { ...fixture.transcript, editRevision: 8,
      nextCursor: fixture.nextCursor, segments: fixture.segments?.map(segment => segment.index === 104 ? { ...segment, text: draft } : segment) } } });
  });
  const transcript = page.getByRole("region", { name: "Saved video transcript", exact: true });
  const next = transcript.getByRole("button", { name: "Next page", exact: true });
  await next.press("Enter");
  await next.press("Enter");
  await transcript.getByRole("button", { name: "Passage 105 actions", exact: true }).press("Enter");
  await page.getByRole("menuitem", { name: "Edit passage 105", exact: true }).press("Enter");
  const correction = transcript.getByRole("textbox", { name: "Passage 105", exact: true });
  await expect(correction).toBeFocused();
  await correction.fill(draft);
  await transcript.getByRole("searchbox", { name: "Search loaded transcript" }).fill("ferry terminal");
  await expect(correction).toHaveCount(0);
  await transcript.getByRole("button", { name: "Return to correction", exact: true }).press("Enter");
  await expect(correction).toHaveValue(draft);
  await expect(correction).toBeFocused();
  await expect(correction).toBeInViewport();
  await page.locator("video").evaluate((video: HTMLVideoElement) => { video.currentTime = 1; });
  const passages = transcript.getByRole("list", { name: "Transcript passages" });
  const save = transcript.getByRole("button", { name: /^(Save|Saving) transcript$/ });
  await save.focus();
  const readingPosition = await passages.evaluate(list => list.scrollTop);
  try {
    await save.press("Enter");
    await expect(save).toBeFocused();
    await expect(save).toHaveAttribute("aria-disabled", "true");
    await save.press("Enter");
    expect(saves).toBe(1);
  } finally {
    releaseFailure();
  }
  await expect(transcript.getByText("Transcript corrections could not be saved. Your edits are still here.")).toBeVisible();
  await expect(save).toBeFocused();
  await expect(correction).toHaveValue(draft);
  expect(await passages.evaluate(list => list.scrollTop)).toBe(readingPosition);
  await save.press("Enter");
  await expect(transcript.getByText("Transcript corrections saved.")).toBeVisible();
  await expect(transcript.getByText(draft)).toBeVisible();
  await expect(transcript.getByRole("button", { name: "Follow playback", exact: true })).toHaveAttribute("aria-pressed", "false");
  await transcript.getByRole("button", { name: "Follow playback", exact: true }).press("Enter");
  await expect(transcript.getByRole("listitem", { name: /^Passage 1:/ })).toHaveAttribute("aria-current", "true");
});
