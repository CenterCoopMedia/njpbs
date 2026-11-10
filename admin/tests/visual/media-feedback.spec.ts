import { expect, test, type Page } from "./fixtures";
import { openSpecimen } from "./capture";

async function blockNonLocalRequests(page: Page) {
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      ? route.continue()
      : route.abort("blockedbyclient");
  });
}

async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <=
    document.documentElement.clientWidth + 1)).toBe(true);
}

for (const width of [390, 1280]) {
  test(`keeps private reviews and staff comments usable at ${width}px`, async ({ page }) => {
    await blockNonLocalRequests(page);
    await openSpecimen(page, {
      id: "audio-library", title: "Audio library", presentation: "text", width,
    }, { normalizeGeneratedIds: false, readyRegion: "Audio" });
    const grid = page.getByRole("grid", { name: "Audio" });
    await grid.getByRole("button", { name: /^Station interview, audio/ }).click();
    const details = page.getByRole(width < 992 ? "dialog" : "complementary", { name: "Asset details" });
    await expect(details.getByText("Only you can see this.")).toBeVisible();
    await expect(details.getByText("Visible to staff with access.")).toBeVisible();
    const notes = details.getByRole("textbox", { name: "Notes", exact: true });
    await expect(notes).toBeEnabled();
    await notes.fill("Private production note.");
    await details.getByLabel("More like this", { exact: true }).check();
    await details.getByRole("button", { name: "Save details", exact: true }).click();
    await expect(notes).toHaveValue("Private production note.");
    await expect(details.getByRole("button", { name: "Save details", exact: true })).toBeDisabled();

    const url = `https://example.test/${"long-address-segment-".repeat(10)}review`;
    const text = `Staff feedback <script>plain text</script> ${url} ` + "longword".repeat(16);
    await details.getByRole("textbox", { name: "New comment", exact: true }).fill(text);
    await details.getByRole("button", { name: "Close details", exact: true }).click();
    const leave = page.getByRole("dialog", { name: "Leave with unsaved changes?" });
    await expect(leave).toBeVisible();
    await leave.getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect(details.getByRole("textbox", { name: "New comment", exact: true })).toHaveValue(text);
    await details.getByRole("button", { name: "Add comment", exact: true }).click();
    const comment = details.getByRole("listitem").filter({ hasText: text });
    await expect(comment).toBeVisible();
    await expect(comment.locator("script")).toHaveCount(0);
    await expect(comment.locator("time")).toHaveAttribute("datetime", /2026-/);
    const link = comment.getByRole("link", { name: `${url} (opens in a new tab)` });
    await expect(link).toHaveAttribute("href", url);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await link.focus();
    await expect(link).toBeFocused();
    await expectNoOverflow(page);
    await comment.getByRole("button", { name: "Edit comment", exact: true }).click();
    await comment.getByRole("textbox", { name: /^Edit comment by/ }).fill("Discarded edit draft.");
    await details.getByRole("button", { name: "Cancel edit", exact: true }).click();
    await expect(comment.getByRole("button", { name: "Edit comment", exact: true })).toBeFocused();
    await comment.getByRole("button", { name: "Edit comment", exact: true }).click();
    await comment.getByRole("textbox", { name: /^Edit comment by/ }).fill("Edited staff feedback.");
    await details.getByRole("button", { name: "Save comment", exact: true }).click();
    const edited = details.getByRole("listitem").filter({ hasText: "Edited staff feedback." });
    await expect(edited).toBeVisible();
    await expectNoOverflow(page);
    await edited.getByRole("button", { name: "Delete comment", exact: true }).click();
    await edited.getByRole("group", { name: /^Confirm deletion of comment by/ })
      .getByRole("button", { name: "Keep comment", exact: true }).click();
    await expect(edited.getByRole("button", { name: "Delete comment", exact: true })).toBeFocused();
    await edited.getByRole("button", { name: "Delete comment", exact: true }).click();
    await edited.getByRole("group", { name: /^Confirm deletion of comment by/ })
      .getByRole("button", { name: "Delete comment", exact: true }).click();
    await expect(edited).toHaveCount(0);
    await expect(notes).toHaveValue("Private production note.");
    await expectNoOverflow(page);
    await test.info().attach(`audio-feedback-${width}.png`, {
      body: await page.screenshot({ path: test.info().outputPath(`audio-feedback-${width}.png`), fullPage: true }),
      contentType: "image/png",
    });
  });

  test(`reviews source video and keeps other staff comments read-only at ${width}px`, async ({ page }) => {
    await blockNonLocalRequests(page);
    await openSpecimen(page, {
      id: "video-viewer-inspector", title: "Source video feedback", presentation: "text", width,
    }, { normalizeGeneratedIds: false });
    const details = page.getByRole("complementary", { name: "Video details" });
    const notes = details.getByRole("textbox", { name: "Notes", exact: true });
    await expect(notes).toBeEnabled();
    await notes.fill("Private video note.");
    await details.getByRole("button", { name: "Save review", exact: true }).click();
    await expect(details.getByText("Your review saved", { exact: true })).toBeVisible();
    const otherComment = details.getByRole("listitem").filter({ hasText: "Riley Chen" });
    await expect(otherComment).toBeVisible();
    await expect(otherComment.getByRole("button", { name: "Edit comment" })).toHaveCount(0);
    await expect(otherComment.getByRole("button", { name: "Delete comment" })).toHaveCount(0);
    await details.getByRole("textbox", { name: "New comment", exact: true }).fill("Shared video feedback.");
    await details.getByRole("button", { name: "Add comment", exact: true }).click();
    await expect(details.getByText("Shared video feedback.", { exact: true })).toBeVisible();
    await expect(notes).toHaveValue("Private video note.");
    await expectNoOverflow(page);
    // Guide captures need enough room to show a whole section above the viewer footer.
    if (width === 1280) await page.setViewportSize({ width, height: 2000 });
    for (const title of ["Your review", "Staff comments"]) {
      const section = details.getByRole("heading", { name: title, exact: true }).locator("../..");
      await section.screenshot({ path: test.info().outputPath(`${title === "Your review" ? "private-review" : "staff-comments"}-${width}.png`) });
    }
    await test.info().attach(`video-feedback-${width}.png`, {
      body: await page.screenshot({ path: test.info().outputPath(`video-feedback-${width}.png`), fullPage: true }),
      contentType: "image/png",
    });
  });
}
