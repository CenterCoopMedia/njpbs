import { expect, test, type Page } from "./fixtures";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function geometry(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
  for (const control of await page.locator('.cuez-workspace button:visible, .cuez-workspace select:visible, .cuez-workspace input:not([type="radio"]):not([type="checkbox"]):visible').all()) {
    const box = await control.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(43.9);
    expect(box?.width).toBeGreaterThanOrEqual(43.9);
  }
  for (const label of await page.locator(".cuez-item-choice:visible, .cuez-check:visible, .cuez-destination label:visible").all()) {
    expect((await label.boundingBox())?.height).toBeGreaterThanOrEqual(43.9);
  }
}
async function evidence(page: Page, name: string) {
  await geometry(page);
  const directory = process.env.CUEZ_EVIDENCE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move((page.viewportSize()?.width ?? 390) - 2, 2);
  await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true });
  await writeFile(join(directory, `${name}.json`), JSON.stringify({ url: page.url(), viewport: page.viewportSize(),
    capturedAt: new Date().toISOString(), adminTree: process.env.CUEZ_ADMIN_TREE ?? null,
    source: "Local fixture using the real ShellLayout, Cuez workspace, controls, and styles; no live account or provider." }, null, 2));
}
async function previewImport(page: Page) {
  await page.getByRole("tab", { name: "Import", exact: true }).click();
  const panel = page.getByRole("tabpanel", { name: "Import", exact: true });
  await panel.getByRole("button", { name: "Search", exact: true }).click();
  await panel.getByRole("button", { name: /Preview import/ }).click();
  await expect(panel.getByRole("button", { name: "Confirm private draft import" })).toBeDisabled();
  await expect(panel.getByRole("heading", { name: "Review what is omitted" })).toBeVisible();
  return panel;
}

for (const width of [1280, 1920, 390]) {
  test(`selected send, transfer recovery, and private draft import at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/cuez-preview.html");
    await expect(page.getByRole("heading", { name: "StoryDesk", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Review transfer", exact: true })).toBeDisabled();
    await page.getByRole("radio", { name: /Community reporting in New Jersey/ }).check();
    await page.getByRole("button", { name: "Review transfer", exact: true }).click();
    await expect(page.getByRole("button", { name: "Send to StoryDesk", exact: true })).toBeVisible();
    await evidence(page, `send-review-${width}`);
    await page.getByRole("button", { name: "Send to StoryDesk", exact: true }).click();
    await expect(page.getByText("The transfer is done.", { exact: true })).toBeVisible();
    for (const label of ["Queued", "Sending", "Conflict", "Needs review", "Failed"]) await expect(page.getByText(label, { exact: true })).toBeVisible();
    await evidence(page, `transfers-${width}`);
    await page.getByRole("button", { name: "Retry transfer", exact: true }).click();
    await expect(page.getByText("Failed", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Mark as done with what was sent" }).click();
    await expect(page.getByRole("heading", { name: "Review the partial transfer" })).toBeVisible();
    await evidence(page, `partial-review-${width}`);
    await page.getByRole("button", { name: "Keep what was sent" }).click();
    await expect(page.getByText("Marked as done with what was sent. Later revised exports will reuse the confirmed story.", { exact: true })).toBeVisible();
    await expect(page.getByText("Conflict", { exact: true })).toBeVisible();
    await evidence(page, `partial-closed-${width}`);
    const unknown = page.locator(".cuez-operation-list > li").filter({ has: page.getByText("Needs review", { exact: true }) });
    await expect(unknown.getByRole("button", { name: "Retry transfer" })).toHaveCount(0);
    await unknown.getByRole("button", { name: "Review outcome" }).click();
    await page.getByRole("button", { name: "I checked StoryDesk" }).click();
    await expect(page.getByText("Needs review", { exact: true })).toBeVisible();
    const panel = await previewImport(page);
    await expect(panel.getByRole("link", { name: "View the original StoryDesk story" })).toHaveAttribute("href", "https://storydesk.example.test/story");
    await evidence(page, `import-preview-${width}`);
    await panel.getByLabel("I reviewed these omissions.").check();
    await panel.getByRole("button", { name: "Confirm private draft import" }).click();
    await expect(page.getByText("The private draft is ready to review.", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your transfers" })).toBeFocused();
    await expect(page.getByRole("link", { name: "Open private draft" }).first()).toHaveAttribute("href", "/content/post/sample-private-draft/edit");
    const sendTab = page.getByRole("tab", { name: "Send", exact: true });
    await sendTab.focus(); await page.keyboard.press("End");
    await expect(page.getByRole("tab", { name: "Transfers", exact: true })).toBeFocused();
  });

  for (const mode of ["off", "empty", "error", "pending", "reader", "text"]) {
    test(`${mode} state at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`/cuez-preview.html?${mode === "text" ? "presentation=text" : `mode=${mode}`}`);
      if (mode === "off") {
        await expect(page.getByRole("heading", { name: "Transfers are turned off" })).toBeVisible();
        await expect(page.getByRole("tablist", { name: "StoryDesk workflow" })).toHaveCount(0);
      } else if (mode === "error") await expect(page.getByRole("button", { name: "Try status again" })).toBeVisible();
      else if (mode === "pending") await expect(page.getByRole("status", { name: "Checking StoryDesk status" })).toBeVisible();
      else {
        await expect(page.getByRole("tab", { name: "Send", exact: true })).toBeVisible();
        if (mode === "empty") await expect(page.getByText("No accessible items on this page.", { exact: true })).toBeVisible();
        if (mode === "reader") {
          await expect(page.getByRole("tab", { name: "Import", exact: true })).toBeDisabled();
          await expect(page.getByRole("radio", { name: "Existing story" })).toBeDisabled();
        }
        if (mode === "text") {
          await expect(page.getByRole("button", { name: "Refresh StoryDesk availability" })).toHaveText("Refresh");
          await page.getByRole("radio", { name: /Community reporting in New Jersey/ }).check();
          await page.getByRole("button", { name: "Clear the selected Boardwalk item" }).click();
          await expect(page.getByRole("radio", { name: /Community reporting in New Jersey/ })).toBeFocused();
        }
      }
      await evidence(page, `${mode}-${width}`);
    });
  }

  test(`long titles and document preview at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/cuez-preview.html?mode=long");
    await page.getByRole("radio", { name: /A statewide conversation/ }).check();
    await evidence(page, `long-send-${width}`);
    await previewImport(page);
    await evidence(page, `long-import-${width}`);
  });
}
