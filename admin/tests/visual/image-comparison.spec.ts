import { expect, test } from "@playwright/test";
import { freezeClock, waitForFonts } from "./capture";

for (const width of [390, 1280]) {
  test(`compares only chosen originals with independent controls and retained drafts at ${width}px`, async ({ page }) => {
    const originals: string[] = [];
    const api: string[] = [];
    page.on("request", request => {
      if (request.resourceType() === "image") originals.push(request.url());
      if (/\/cms[A-Z]/.test(request.url())) api.push(request.url());
    });
    await page.route("**/comparison-portrait.svg", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1600"><circle cx="400" cy="800" r="300" fill="teal"/></svg>' }));
    await page.route("**/comparison-missing.svg", route => route.fulfill({ status: 404, body: "Unavailable" }));
    await freezeClock(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/gallery.html?embed=image-viewer&presentation=text&comparison", { waitUntil: "networkidle" });
    await waitForFonts(page);
    const viewer = page.getByRole("dialog");
    const primary = viewer.getByRole("region", { name: "Image viewing surface", exact: true });
    if (width === 390) await viewer.getByRole("button", { name: "Details", exact: true }).click();
    await viewer.getByRole("textbox", { name: "Name", exact: true }).fill("Unsaved comparison draft");
    await viewer.getByRole("button", { name: "Close image details", exact: true }).click();
    await expect(primary.locator("img")).toBeVisible();
    const primaryNode = await primary.locator("img").elementHandle();
    expect(originals.filter(url => /energy-environment|comparison-/.test(url))).toEqual([]);
    const selector = viewer.getByRole("combobox", { name: "Compare with" });
    const shared = viewer.getByRole("group", { name: "Image workspace controls" });
    await expect(shared.getByRole("combobox", { name: "Compare with" })).toBeVisible();
    await expect(shared.getByRole("button", { name: "Details", exact: true })).toBeVisible();
    await selector.focus();
    await selector.press("ArrowDown");
    await selector.press("Enter");
    const secondary = viewer.getByRole("region", { name: "Comparison image viewing surface", exact: true });
    await expect(secondary).toHaveAttribute("data-status", "ready");
    await expect(viewer.getByText("Viewing controls keep the file unchanged. 100% shows the preview at its pixel size.", { exact: true })).toHaveCount(1);
    if (width === 1280) {
      const headers = await viewer.locator(".image-viewer-toolbar").evaluateAll(elements => elements.map(element => ({ top: element.getBoundingClientRect().top, height: element.getBoundingClientRect().height })));
      expect(headers[0]).toEqual(headers[1]);
    }
    await expect(viewer.getByText("Statehouse dome at dusk · gallery-statehouse · v4", { exact: true })).toBeVisible();
    await expect(viewer.getByRole("region", { name: "Comparison image", exact: true }).getByText("Offshore wind turbines, Barnegat Bay · gallery-energy · v4", { exact: true })).toBeVisible();
    expect(originals.filter(url => url.includes("energy-environment"))).toHaveLength(1);
    const secondaryControls = viewer.getByRole("group", { name: "Comparison image view controls", exact: true });
    await secondaryControls.getByRole("button", { name: "View at 100%", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(secondaryControls.getByRole("status", { name: "Image zoom" })).toHaveText("100%");
    await expect(viewer.getByRole("group", { name: "Image view controls", exact: true }).getByRole("button", { name: "Fit", exact: true })).toHaveAttribute("aria-pressed", "true");
    await secondary.focus();
    await secondary.press("ArrowRight");
    expect(await primary.locator("img").evaluate((node, old) => node === old, primaryNode)).toBe(true);
    await selector.selectOption("gallery-portrait");
    await expect(secondary).toHaveAttribute("data-status", "ready");
    await expect(secondaryControls.getByRole("button", { name: "Fit", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => secondary.locator("img").evaluate(image => image.getBoundingClientRect().height / image.getBoundingClientRect().width)).toBeCloseTo(2, 2);
    await expect(secondary).toBeInViewport();
    expect(originals.filter(url => url.includes("comparison-portrait"))).toHaveLength(1);
    const portrait = await secondary.locator("img").elementHandle();
    await selector.selectOption("gallery-missing");
    await expect(secondary.getByRole("link", { name: "Open original" })).toHaveAttribute("href", "/comparison-missing.svg");
    expect(await portrait!.evaluate(node => node.isConnected)).toBe(false);
    await expect(primary).toHaveAttribute("data-status", "ready");
    await selector.selectOption("");
    await expect(secondary).toHaveCount(0);
    await viewer.getByRole("button", { name: "Details", exact: true }).click();
    await expect(viewer.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Unsaved comparison draft");
    expect(api).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}
