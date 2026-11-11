import { expect, test, type Locator } from "@playwright/test";
import { waitForFonts } from "./capture";

async function geometry(controls: Locator[]) {
  return Promise.all(controls.map(async control => {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    return box!;
  }));
}

for (const viewport of [
  { width: 1165, height: 757, coarse: false },
  { width: 768, height: 900, coarse: false },
  { width: 390, height: 844, coarse: false },
  { width: 390, height: 844, coarse: true },
  // The CSS viewport at 200% browser zoom on a 640px-wide window.
  { width: 320, height: 420, coarse: false },
]) for (const outcome of ["ready", "failed"] as const) {
  test(`Post Preview keeps its controls stable through ${outcome} at ${viewport.width}px ${viewport.coarse ? "coarse" : "fine"}`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, viewport, hasTouch: viewport.coarse, reducedMotion: "reduce" });
    try {
      await context.route("https://preview.njpbs.org/p/**", route => route.fulfill({ contentType: "text/html", body: "<h1>Exact private preview</h1>" }));
      const page = await context.newPage();
      await page.goto("/gallery.html?embed=single-preview-workspace&presentation=text&previewKind=post&waitStatus=1");
      const preview = page.locator(".workspace-actions").getByRole("button", { name: "Preview", exact: true });
      const save = page.getByRole("button", { name: "Save draft", exact: true });
      const publishing = page.getByRole("button", { name: "Review & publish", exact: true });
      const more = page.getByRole("button", { name: "More document actions", exact: true });
      const controls = [preview, save, publishing, more];
      await expect(preview).toBeEnabled();
      await waitForFonts(page);
      expect(await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches)).toBe(viewport.coarse);
      const idle = await geometry(controls);
      expect(idle[0].width).toBeLessThanOrEqual(idle[1].width * 1.4);
      for (const box of idle) {
        expect(box.width).toBeGreaterThanOrEqual(viewport.coarse ? 44 : 32);
        expect(box.height).toBeGreaterThanOrEqual(viewport.coarse ? 44 : 32);
      }
      const noOverflow = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
      await noOverflow();
      await page.screenshot({ path: test.info().outputPath("idle.png") });

      await preview.focus();
      const popupPromise = context.waitForEvent("page");
      await preview.press("Enter");
      const popup = await popupPromise;
      // Keep the same DOM button while its accessible name changes.
      const pending = page.locator(".workspace-actions button[aria-busy=true]");
      await expect(pending).toHaveAccessibleName("Preview: Preparing preview…");
      await expect(pending).toHaveAttribute("aria-disabled", "true");
      await expect(pending.locator(".activity-indicator")).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: "Preparing your preview in a new tab." })).toHaveText("Preparing your preview in a new tab.");
      await expect.poll(() => page.evaluate(() => window.__CMS_PREVIEW_FIXTURE__?.reads.length)).toBe(1);
      const pendingControls = [pending, save, publishing, more];
      const busy = await geometry(pendingControls);
      expect(busy).toEqual(idle);
      await pending.press("Enter");
      expect(context.pages()).toHaveLength(2);
      expect(await page.evaluate(() => window.__CMS_PREVIEW_FIXTURE__?.requests.length)).toBe(1);
      await noOverflow();
      await page.screenshot({ path: test.info().outputPath("pending.png") });

      await page.evaluate(status => window.__CMS_PREVIEW_FIXTURE__?.releaseStatus(status), outcome);
      if (outcome === "ready") {
        await expect(popup.getByRole("heading", { name: "Exact private preview", exact: true })).toBeVisible();
      } else {
        await expect(page.getByRole("alert")).toHaveText("Preview is temporarily unavailable. Your edits remain in the editor.");
        await expect(popup.getByRole("heading", { name: "Preview unavailable", exact: true })).toBeVisible();
      }
      await expect(preview).toBeEnabled();
      await expect(preview).not.toHaveAttribute("aria-busy");
      await expect(preview).not.toHaveAttribute("aria-disabled");
      await expect(preview.locator(".activity-indicator")).toHaveCount(0);
      const terminal = await geometry(controls);
      expect(terminal).toEqual(idle);
      await test.info().attach("preview-action-geometry", { body: JSON.stringify({ viewport, outcome, controls: ["Preview", "Save draft", "Review & publish", "More"], idle, busy, terminal }), contentType: "application/json" });
      await noOverflow();
      await page.screenshot({ path: test.info().outputPath(`${outcome}.png`) });
      expect(await page.evaluate(() => window.__CMS_PREVIEW_FIXTURE__?.saves)).toBe(0);
    } finally {
      await context.close();
    }
  });
}
