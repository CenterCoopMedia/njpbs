import { expect, test, type Locator, type Page } from "./fixtures";
import { openSpecimen } from "./capture";

function wav(channels = 1, sampleRate = 48_000, bits = 16) {
  const align = channels * bits / 8;
  const bytes = Buffer.alloc(44 + sampleRate * align);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * align, 28);
  bytes.writeUInt16LE(align, 32);
  bytes.writeUInt16LE(bits, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}

function assetDetails(page: Page, width: number): Locator {
  return page.getByRole(width < 992 ? "dialog" : "complementary", {
    name: "Asset details",
  });
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() =>
    document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
  )).toBe(true);
}

for (const width of [390, 1280]) {
  test(`uploads WAV audio and keeps shared inspector controls usable at ${width}px`, async ({ page }) => {
    await page.route("https://media.example.test/**", route => route.fulfill({
      contentType: "audio/wav",
      body: wav(),
    }));
    await openSpecimen(page, {
      id: "audio-library",
      title: "Audio library",
      presentation: "text",
      width,
    }, { normalizeGeneratedIds: false, readyRegion: "Audio" });

    const grid = page.getByRole("grid", { name: "Audio" });
    await expect(grid.getByRole("button", { name: /^Station interview, audio/ })).toBeVisible();
    await grid.getByRole("button", { name: /^Station interview, audio/ }).click();
    let details = assetDetails(page, width);
    await expect(details).toBeVisible();
    await expect(details.getByLabel("Play Station interview")).toHaveAttribute("preload", "none");
    await expect(details.getByText("No license entered", { exact: true })).toBeVisible();
    const favorite = details.getByRole("button", { name: "Add to favorites: Station interview" });
    await favorite.click();
    await expect(details.getByRole("button", { name: "Remove from favorites: Station interview" }))
      .toHaveAttribute("aria-pressed", "true");
    await details.getByRole("button", { name: "Close details" }).click();
    await expect(grid.getByRole("button", { name: /^Station interview, audio.*favorite$/ })).toBeVisible();

    await page.getByRole("button", { name: "Upload media", exact: true }).click();
    await page.getByLabel(/Files \(25 MB/).setInputFiles({
      name: "desk-interview.wav",
      mimeType: "audio/wav",
      buffer: wav(2, 44_100, 24),
    });
    await expect(page.getByLabel("Alt-text suggestion")).toHaveCount(0);
    await expect(page.getByText("You can upload without a license.", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Upload", exact: true }).click();
    details = assetDetails(page, width);
    await expect(details.getByRole("heading", { name: "desk-interview.wav" })).toBeVisible();
    await expect(grid.getByRole("button", { name: /^desk-interview\.wav, audio/ })).toBeVisible();
    await expect(details.getByLabel("Play desk-interview.wav")).toHaveAttribute("preload", "none");
    await expect(details.getByText("No license entered", { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    const decoded = await page.evaluate(async bytes => {
      const context = new AudioContext({ sampleRate: 44_100 });
      try {
        const audio = await context.decodeAudioData(new Uint8Array(bytes).buffer);
        return {
          channels: audio.numberOfChannels,
          duration: audio.duration,
          sampleRate: audio.sampleRate,
        };
      } finally {
        await context.close();
      }
    }, [...wav(2, 44_100, 24)]);
    expect(decoded).toEqual({ channels: 2, duration: 1, sampleRate: 44_100 });
  });
}

test("loads private voiceover audio and review details only after selection", async ({ page }) => {
  await openSpecimen(page, {
    id: "audio-library",
    title: "Audio library",
    presentation: "icons",
    width: 1280,
  }, { normalizeGeneratedIds: false, readyRegion: "Audio" });

  const grid = page.getByRole("grid", { name: "Audio" });
  await grid.getByRole("button", { name: /^Station identification, audio.*favorite$/ }).click();
  const details = assetDetails(page, 1280);
  await expect(details.getByText("Jordan Avery", { exact: true })).toBeVisible();
  await expect(details.getByRole("textbox", { name: "Notes" }))
    .toHaveValue("Use this warm station identification.");
  await expect(details.getByLabel("Play Station identification")).toHaveCount(0);
  await details.getByRole("button", { name: "Listen to Station identification" }).click();
  await expect(details.getByLabel("Play Station identification")).toHaveAttribute("preload", "none");

  const favorite = details.getByRole("button", {
    name: "Remove from favorites: Station identification",
  });
  await favorite.click();
  await expect(details.getByRole("button", { name: "Add to favorites: Station identification" }))
    .toHaveAttribute("aria-pressed", "false");
  await expectNoHorizontalOverflow(page);
});
