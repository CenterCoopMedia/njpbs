import { expect, test, type Page } from "./fixtures";
import { fileURLToPath } from "node:url";
import { openSpecimen } from "./capture";
const widths = [1280, 320] as const;
async function showDetails(page: Page) {
  const trigger = page.getByRole("button", { name: "Details", exact: true });
  if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
  await page.getByRole("tab", { name: "Post", exact: true }).click();
  return page.locator("#editor-details-document-panel");
}
async function hidePhoneDetails(page: Page, width: number) {
  if (width < 780) await page.getByRole("button", { name: "Close details", exact: true }).click();
}
// #3695: both phone widths share the <=619px chrome and headline rules; keep 320.
for (const width of [320]) {
  test(`unavailable public status keeps the complete canonical headline at ${width}px`, async ({ page }) => {
    await openSpecimen(page, { id: "shell-post-mobile-published", title: "Published Post", width, presentation: "icons" }, { normalizeGeneratedIds: false });
    await page.route("https://njpbs.org/_publication.json?*", route => route.fulfill({ status: 503, json: {} }));
    await page.reload();
    const headline = page.getByRole("textbox", { name: "Headline", exact: true });
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Edit post");
    await expect(headline).toHaveValue("Station update");
    expect(await headline.evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    await expect(page.locator(".editor-document-state")).toContainText("Public status unavailable");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  });
}
// Keep a phone modal, a narrow rail modal, and a desktop pane.
for (const [width, presentation] of [[320, "text"], [720, "text"], [1280, "icons"]] as const) {
  test(`populated Post image fits at ${width}px with ${presentation} controls`, async ({ page }) => {
    await page.route("https://image.pbs.org/**", route => route.fulfill({ path: fileURLToPath(new URL("../../public/brand/njpbs-horizontal-white.svg", import.meta.url)), contentType: "image/svg+xml" }));
    await openSpecimen(page, { id: "shell-post-mobile-draft", title: "Draft Post", width, presentation }, { normalizeGeneratedIds: false });
    await page.getByRole("button", { name: /^Edit image / }).click();
    const pane = page.locator("#editor-details-selection-panel");
    const frame = pane.locator(".inline-image-frame"); const image = frame.locator("img");
    await expect.poll(() => image.evaluate(node => node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0)).toBe(true);
    for (const fallback of [false, true]) {
      if (fallback) { await image.evaluate(node => node.dispatchEvent(new Event("error"))); await expect(frame.getByText("Saved image could not be shown")).toBeVisible(); }
      const geometry = await frame.evaluate(node => { const parent = node.closest('.editor-workspace-pane')!.getBoundingClientRect(); const rect = node.getBoundingClientRect(); return { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, left: rect.left, right: rect.right, parentLeft: parent.left, parentRight: parent.right }; });
      expect(geometry.scroll).toBe(geometry.width); expect(geometry.left).toBeGreaterThanOrEqual(geometry.parentLeft); expect(geometry.right).toBeLessThanOrEqual(geometry.parentRight);
    }
    for (const name of ["Change image", "Remove image"]) { const box = await pane.getByRole("button", { name, exact: true }).boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches ? 44 : 36)); expect(box!.x + box!.width).toBeLessThanOrEqual(width); }
    await page.getByRole("button", { name: "Close details", exact: true }).click();
    await expect(page.locator(".post-inline-writing").filter({ hasText: "A newsroom article follows the image." })).toBeVisible();
  });
}
for (const [width, presentation, labelVisible] of [[390, "icons", false], [390, "text", true], [1280, "icons", true]] as const) {
  test(`live Post action opens the receipt route from the document header at ${width}px with ${presentation} controls`, async ({ page }) => {
    await page.context().route("https://njpbs.org/posts/station-update/", route => route.fulfill({ body: "Live Post" }));
    await openSpecimen(page, { id: "shell-post-saved", title: "Saved Post", width, presentation }, { normalizeGeneratedIds: false });
    const live = page.getByRole("link", { name: "View live post (opens in a new tab)", exact: true });
    await expect(live).toHaveAttribute("href", "https://njpbs.org/posts/station-update/");
    await expect(live).toHaveAttribute("target", "_blank");
    await expect(live).toHaveAttribute("rel", "noopener noreferrer");
    const label = live.getByText("View live post", { exact: true });
    if (presentation === "icons") await expect(label).toHaveClass("button-compact-label");
    else await expect(label).not.toHaveClass("button-compact-label");
    if (labelVisible) await expect(label).toBeVisible();
    else expect(await label.evaluate(element => getComputedStyle(element).clipPath)).toBe("inset(50%)");
    const header = await page.locator(".workspace-header").boundingBox();
    const action = await live.boundingBox();
    expect(action!.x).toBeGreaterThanOrEqual(header!.x);
    expect(action!.x + action!.width).toBeLessThanOrEqual(header!.x + header!.width);
    expect(action!.y).toBeGreaterThanOrEqual(header!.y);
    expect(action!.y + action!.height).toBeLessThanOrEqual(header!.y + header!.height);
    await live.focus();
    await expect(live).toBeFocused();
    const popupPromise = page.waitForEvent("popup");
    await live.press("Enter");
    const popup = await popupPromise;
    await expect(popup).toHaveURL("https://njpbs.org/posts/station-update/");
    await popup.close();
  });
}
for (const width of [390, 1280]) {
  test(`publication error stays visible when Lifecycle starts collapsed at ${width}px`, async ({ page }) => {
    await openSpecimen(page, { id: "shell-post-publish-failure", title: "Refused publication", width, presentation: "icons" }, { normalizeGeneratedIds: false });
    const side = await showDetails(page); const toggle = side.getByRole("button", { name: "Lifecycle", exact: true, includeHidden: true });
    await toggle.click(); await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await hidePhoneDetails(page, width);
    await page.locator(".editor-writing-canvas").evaluate(element => element.scrollIntoView({ block: "start" }));
    await page.getByRole("button", { name: "Review & publish", exact: true }).click();
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    const feedback = page.locator(".workspace-feedback");
    await expect(feedback.getByText("Publication did not start", { exact: true })).toBeVisible();
    await expect(feedback.getByText("Image publication is paused. The current public version is unchanged.", { exact: true })).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const error = await feedback.getByRole("alert").boundingBox(); const header = await page.locator(".workspace-header").boundingBox();
    expect(error!.y).toBeGreaterThanOrEqual(header!.y + header!.height); expect(error!.y + error!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  });
  test(`destructive confirmation stays below the toolbar after scrolling at ${width}px`, async ({ page }) => {
    await openSpecimen(page, { id: "shell-post-saved", title: "Saved Post", width, presentation: "icons" }, { normalizeGeneratedIds: false });
    await page.setViewportSize({ width, height: 600 }); await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.getByRole("button", { name: "More document actions", exact: true }).click(); await page.getByRole("button", { name: "Delete", exact: true }).click();
    const confirmation = page.locator(".lifecycle-actions-confirmation");
    await expect(confirmation.getByRole("button", { name: "Move to recycle bin", exact: true })).toBeFocused();
    const box = await confirmation.boundingBox(); const header = await page.locator(".workspace-header").boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(header!.y + header!.height); expect(box!.y + box!.height).toBeLessThanOrEqual(600);
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("button", { name: "More document actions", exact: true })).toBeFocused();
  });
}
for (const width of widths) {
  test(`post inspector expanded at ${width}px`, async ({ page }) => {
    await openSpecimen(page, { id: "shell-post-saved", title: "Saved Post", width, presentation: "icons" }, { normalizeGeneratedIds: false });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    const side = await showDetails(page);
    for (const title of ["Post identity", "Images", "Organization"]) await expect(side.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(side.getByRole("button", { name: "Lifecycle", exact: true })).toHaveAttribute("aria-expanded", "true");
    await side.locator('.editor-organization-details summary').click();
    for (const title of ["Dates", "Search & sharing", "Advanced"]) { const toggle = side.getByRole("button", { name: title, exact: true }); await expect(toggle).toHaveAttribute("aria-expanded", "false"); await toggle.click(); }
    await expect(page.getByRole("navigation", { name: "Document sections" })).toHaveCount(0);
    const paneBox = await page.locator(".editor-workspace-pane-details").boundingBox();
    if (width >= 800) { expect(paneBox!.width).toBe(304); expect(paneBox!.x + paneBox!.width).toBeLessThanOrEqual(width); }
    else expect(await page.locator(".editor-workspace-pane-details").evaluate(element => element.matches(":modal"))).toBe(true);
    const summary = page.getByRole("textbox", { name: "Summary", exact: true }); const excerpt = side.getByRole("textbox", { name: "Excerpt", exact: true });
    await expect(summary).toHaveAccessibleDescription(/Optional text below the title. Also used in listings, search, and social sharing./);
    await expect(excerpt).toHaveAccessibleDescription(/Optional fallback for listing cards and default Search and Social descriptions when summary is empty./);
    await expect(side.getByRole("textbox", { name: "Search title", exact: true })).toHaveValue("Station update");
    await expect(side.getByRole("textbox", { name: "Social title", exact: true })).toHaveValue("Station update"); await expect(side.getByText("Using post title")).toHaveCount(2);
    const hero = side.getByRole("article", { name: "Images" });
    await expect(hero.getByRole("textbox", { name: "Hero background image", exact: true, includeHidden: true })).toHaveCount(1);
    const backgroundSummary = hero.locator('[data-image-role="heroBackgroundImage"] summary');
    await expect(backgroundSummary).not.toHaveAttribute("aria-disabled", "true");
    await expect(hero.getByRole("group", { name: "Background crop position", exact: true })).toBeHidden();
    await backgroundSummary.focus(); await backgroundSummary.press("Enter");
    const crop = hero.getByRole("group", { name: "Background crop position", exact: true });
    await expect(crop).toBeVisible();
    for (const control of await crop.getByRole("button").all()) await expect(control).toBeDisabled();
    await backgroundSummary.press("Enter");
    await expect(crop).toBeHidden();
    const publication = side.getByRole("article", { name: "Lifecycle", includeHidden: true }); await expect(publication.getByText("Version 12", { exact: true })).toBeVisible(); await expect(publication.getByText("Published copy live", { exact: true })).toBeVisible();
    await expect(publication.getByText("Approved", { exact: true })).toHaveCount(0); await expect(publication.getByRole("button", { name: /^Draft status for/ })).toHaveCount(0); await expect(side.getByText("Approval does not publish", { exact: true })).toBeVisible();
    await hidePhoneDetails(page, width); await page.getByRole("button", { name: "Review & publish", exact: true }).click();
    await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeEnabled(); await expect(page.getByRole("button", { name: "Schedule publish", exact: true })).toBeEnabled(); await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeEnabled(); await showDetails(page);
    const lead = side.locator('[data-image-role="leadMedia"]');
    await expect(lead.getByRole("combobox", { name: "Lead media type", exact: true })).toBeHidden();
    await lead.locator("summary").focus(); await page.keyboard.press("Enter");
    await expect(lead.getByRole("combobox", { name: "Lead media type", exact: true })).toBeVisible();
    await lead.locator("summary").press("Enter");
    await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); }); await page.locator(".editor-workspace-pane-details .editor-workspace-pane-content").evaluate(element => element.scrollTo(0, 0));
    await expect(page).toHaveScreenshot(`post-inspector--expanded--${width}w.png`, { fullPage: true });
  });
  test(`post inspector collapsed at ${width}px`, async ({ page }) => {
    await openSpecimen(page, { id: "shell-post-saved", title: "Saved Post", width, presentation: "icons" }, { normalizeGeneratedIds: false });
    const side = await showDetails(page); const publication = side.getByRole("article", { name: "Lifecycle", includeHidden: true }); const toggle = publication.getByRole("button", { name: "Lifecycle", exact: true, includeHidden: true });
    await toggle.click(); await expect(toggle).toHaveAttribute("aria-expanded", "false");
    for (const title of ["Post identity", "Images", "Organization"]) await expect(side.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(side.locator('[data-image-role="heroBackgroundImage"]')).not.toHaveAttribute("open");
    await expect(side.locator('[data-image-role="leadMedia"]')).not.toHaveAttribute("open");
    await expect(side.getByRole("combobox", { name: "Lead media type", exact: true })).toBeHidden();
    await expect(toggle).toBeFocused(); await hidePhoneDetails(page, width);
    await page.getByRole("button", { name: "Review & publish", exact: true }).click(); await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeEnabled(); await expect(page.getByRole("button", { name: "Schedule publish", exact: true })).toBeEnabled(); await page.keyboard.press("Escape");
    await showDetails(page); await toggle.click(); await expect(toggle).toHaveAttribute("aria-expanded", "true"); await toggle.click(); await expect(toggle).toHaveAttribute("aria-expanded", "false"); await expect(toggle).toBeFocused();
    await page.evaluate(() => window.scrollTo(0, 0)); await page.locator(".editor-workspace-pane-details .editor-workspace-pane-content").evaluate(element => element.scrollTo(0, 0));
    await expect(page).toHaveScreenshot(`post-inspector--collapsed--${width}w.png`, { fullPage: true });
    await hidePhoneDetails(page, width); await page.getByRole("button", { name: "Review & publish", exact: true }).click(); await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false"); await expect(publication.getByRole("button", { name: "Confirm publication" })).toHaveCount(0);
    await expect(page.locator(".success-notice").getByText("Publication requested. The saved version is queued for a public build.", { exact: true })).toBeVisible();
  });
}

for (const width of [390, 1280]) {
  test(`empty lead opens the picker in one action and preserves the background at ${width}px`, async ({ page }) => {
    await openSpecimen(page, { id: "study-reference-post", title: "Post", width, presentation: "icons" }, { normalizeGeneratedIds: false });
    const side = await showDetails(page);
    const lead = side.locator('[data-image-role="leadMedia"]');
    const background = side.locator('#record-post-heroBackgroundImage');
    const storedBackground = await background.inputValue();
    await lead.locator("summary").click();
    const picker = page.getByRole("dialog", { name: "Choose an image", exact: true });
    await expect(picker).toBeVisible();
    await picker.locator(".media-picker-card").filter({ hasText: "Story image" }).click();
    await expect(picker).toHaveCount(0);
    await expect(lead.locator("summary")).toContainText("Library image · Story image");
    await expect(background).toHaveValue(storedBackground);
    await lead.getByRole("button", { name: "Remove lead media", exact: true }).click();
    await expect(lead.locator("summary")).toBeFocused();
    await expect(lead).not.toHaveAttribute("open");
    await expect(lead.locator("summary")).toContainText("No lead media");
    await expect(background).toHaveValue(storedBackground);
    // An explicit No lead media choice still reopens the common image path directly.
    await lead.locator("summary").click();
    await expect(picker).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(lead.locator("summary")).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  });
}
