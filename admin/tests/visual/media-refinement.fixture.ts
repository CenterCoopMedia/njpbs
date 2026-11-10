import { expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { mediaTranscriptFixture } from "../../src/dev/fixtures/media-transcript";
import { openSpecimen } from "./capture";

export async function openMediaRefinement(page: Page, width: number, presentation: "icons" | "text" = "icons",
  options: { originalState?: "available" | "archived" | "restoring" | "restored" } = {}) {
  const requests: string[] = [];
  let originalState = options.originalState ?? "available";
  const preview = await readFile(fileURLToPath(new URL("./fixtures/media-frame-preview.mp4", import.meta.url)));
  await page.route("**/local-media-frame-preview.mp4*", route => {
    // A native video needs byte-range support to expose its real seekable range.
    // A200-only intercepted file reports [0,0] even after all bytes are buffered.
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), preview.length - 1) : preview.length - 1;
    if (start >= preview.length || start > end) return route.fulfill({ status: 416,
      headers: { "content-range": `bytes */${preview.length}` } });
    return route.fulfill({ status: range ? 206 : 200, contentType: "video/mp4",
      headers: { "accept-ranges": "bytes", "content-length": String(end - start + 1),
        ...(range ? { "content-range": `bytes ${start}-${end}/${preview.length}` } : {}) },
      body: preview.subarray(start, end + 1) });
  });
  await page.route(/\/cms[A-Z][A-Za-z]+(?:\?.*)?$/, route => {
    const endpoint = new URL(route.request().url()).pathname.split("/").at(-1)!;
    requests.push(endpoint);
    if (endpoint === "cmsSourceMediaOriginal") {
      if (route.request().postDataJSON()?.action === "restore") originalState = "restoring";
      return route.fulfill({ json: { success: true, original: { state: originalState,
        archiveTier: ["archived", "restoring"].includes(originalState) ? "DEEP_ARCHIVE_ACCESS" : null,
        checkedAt: "2026-08-20T19:00:00.000Z" } } });
    }
    const fixture = mediaTranscriptFixture();
    const transcript = { ...fixture.transcript, languageCode: "en-US", maxSpeakers: 10,
      segments: fixture.segments, nextCursor: fixture.nextCursor };
    if (endpoint === "cmsCreateSourceMediaRead") return route.fulfill({ json: { success: true,
      access: { url: `${new URL(route.request().url()).origin}/local-media-frame-preview.mp4`, expiresAt: "2026-08-20T20:00:00.000Z" } } });
    if (endpoint === "cmsGetMediaReview") return route.fulfill({ json: { success: true, review: null } });
    if (endpoint === "cmsListMediaComments") return route.fulfill({ json: { success: true, comments: [], nextCursor: null } });
    if (endpoint === "cmsListVideoClips") return route.fulfill({ json: { success: true, clips: [], nextCursor: null } });
    if (endpoint === "cmsGetVideoTranscript") return route.fulfill({ json: { success: true, cached: true, transcript } });
    if (endpoint === "cmsListVideoTranscripts") return route.fulfill({ json: { success: true, transcripts: [transcript], nextCursor: null } });
    if (endpoint === "cmsGetTranscriptionOptions") {
      const budget = { reservedSubmissions: 0, reservedAudioSeconds: 0, consumedSubmissions: 0, consumedAudioSeconds: 0,
        remainingSubmissions: 0, remainingAudioSeconds: 0 };
      return route.fulfill({ json: { success: true, enabled: false, credentials: [],
        provider: { id: "elevenlabs", model: "scribe_v2", wordTimings: true, languageCodes: ["en-US"], maxSpeakers: { min: 1, max: 10 } },
        limits: { requester: { submissions: 0, audioSeconds: 0, outstanding: 0 }, global: { submissions: 0, audioSeconds: 0 } },
        budget: { day: "2026-08-20", requester: budget, global: budget } } });
    }
    return route.fulfill({ status: 501, json: { error: "This local media-frame fixture has no response for that request." } });
  });
  await openSpecimen(page, { id: "media-refinement-frame", title: "Media frame", width, presentation }, { normalizeGeneratedIds: false });
  const pane = page.getByRole("tab", { name: "Transcript", exact: true });
  if (await pane.isVisible()) {
    await pane.click();
    await expect(page.getByRole("region", { name: "Saved video transcript", exact: true })).toBeVisible();
    await expect.poll(() => page.locator("video").evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(1);
    return requests;
  }
  // Desktop panes open the saved transcript as part of the workspace.
  if (await page.getByRole("region", { name: "Saved video transcript", exact: true }).isVisible()) {
    await expect.poll(() => page.locator("video").evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(1);
    return requests;
  }
  const action = page.getByRole("button", { name: "Open transcript", exact: true });
  if (await action.isVisible()) await action.click();
  else if (await page.getByRole("button", { name: "Transcript", exact: true }).isVisible()) {
    await page.getByRole("button", { name: "Transcript", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "More preview actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Transcript", exact: true }).click();
  }
  await expect(page.getByRole("region", { name: "Saved video transcript", exact: true })).toBeVisible();
  await expect.poll(() => page.locator("video").evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(1);
  return requests;
}
