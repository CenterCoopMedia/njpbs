import { expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import type { VisualSpecimenPair } from "../../src/lib/visual-specimens";
import { visualSpecimenUrl } from "../../src/lib/visual-specimens";

export const GALLERY_PATH = "/gallery.html";

/**
 * The instant every captured specimen believes it is. Fixed, and in the pinned time zone
 * (America/New_York, set in playwright.config.ts), so a fixture that formats a date, or
 * says an editor lock was taken "a minute ago", renders the same string on every run and
 * on every machine. A midday weekday avoids a date that flips across the local midnight.
 */
export const FROZEN_NOW = Date.parse("2026-08-20T15:00:00-04:00");

/**
 * Freeze the page clock before any application script runs.
 *
 * Only `Date` is replaced. Timers stay real, because React's scheduler drives rendering
 * through them and a faked timer queue would stall the very paint we are capturing.
 */
export async function freezeClock(page: Page | BrowserContext, nowMs = FROZEN_NOW): Promise<void> {
  await page.addInitScript((fixed: number) => {
    const RealDate = Date;
    class FrozenDate extends RealDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) super(fixed);
        else super(...(args as [number]));
      }
      static now(): number {
        return fixed;
      }
    }
    // eslint-disable-next-line no-global-assign
    globalThis.Date = FrozenDate as unknown as DateConstructor;
  }, nowMs);
}

/** Wait for font resolution; the visual fixture supplies repository-owned Public Sans. */
export async function waitForFonts(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

/**
 * Rewrite React's generated ids to a stable sequence, using the same module the unit suite
 * covers: the gallery publishes it on the window while it evaluates, so the tested code is
 * the code that runs here rather than a copy inlined into the test.
 */
export async function normalizeIds(page: Page): Promise<number> {
  return page.evaluate(() => {
    const normalize = window.__ADMIN_NORMALIZE_GENERATED_IDS__;
    if (!normalize) {
      throw new Error(
        "The gallery did not publish __ADMIN_NORMALIZE_GENERATED_IDS__; the capture seam in src/dev/gallery.tsx has moved.",
      );
    }
    return normalize(document).replaced;
  });
}

/** Open one capture pair and settle the page to the point where a screenshot is meaningful. */
export async function openSpecimen(
  page: Page,
  pair: VisualSpecimenPair,
  { normalizeGeneratedIds = true, readyRegion, readyLocator }: {
    normalizeGeneratedIds?: boolean; readyRegion?: string; readyLocator?: Locator;
  } = {},
): Promise<void> {
  // Gallery records are fixtures, not production records. Keep their public
  // evidence fixed too, so a live deployment cannot change visual assertions.
  const identity = { schemaVersion: 1, buildBatchId: "visual-gallery", generation: 1, commitSha: "a".repeat(40) };
  await page.route("https://njpbs.org/_publication.json?*", route => route.fulfill({ json: identity }));
  await page.route("https://njpbs.org/_content-status.json?*", route => route.fulfill({ json: {
    ...identity, collections: ["cmsPages", "cmsPosts"], routes: [{
      path: "/posts/station-update/", source: "cms", sourceVersion: 8,
      contentKey: createHash("sha256").update("cmsPosts/post-station-update").digest("hex"),
    }, ...(pair.id === "study-reference-page" ? [{ path: "/", source: "cms", sourceVersion: 50,
      contentKey: createHash("sha256").update("cmsPages/home").digest("hex") }] : pair.id === "study-reference-post" ? [{
      path: "/posts/man-who-waged-delaney-hall-hunger-strike-released-from-ice-custody/", source: "cms", sourceVersion: 29,
      contentKey: createHash("sha256").update("cmsPosts/study-post").digest("hex") }] : [])],
  } }));
  await page.route("https://njpbs.org/contact/?*", route => route.fulfill({
    body: "", headers: { "x-njpbs-content-source": "committed-fallback" },
  }));
  if (pair.id !== "media-refinement-frame") {
    await page.route("**/cmsSourceMediaOriginal", route => route.fulfill({ json: {
      success: true, notices: [],
      original: { state: "available", archiveTier: null, checkedAt: "2026-08-20T19:00:00.000Z" },
    } }));
  }
  await freezeClock(page);
  if (pair.id === "auth-loading") {
    // Keep the longest tip stable for responsive visual evidence.
    await page.addInitScript(() => { Math.random = () => 2.5 / 48; });
  }
  await page.setViewportSize({ width: pair.width, height: pair.width >= 1024 ? 900 : 800 });
  if (pair.id === "media-favorites-list") {
    await page.addInitScript(() => localStorage.setItem("njpbs-admin:media-display:favorites", JSON.stringify({ layout: "list" })));
  }
  await page.goto(visualSpecimenUrl(GALLERY_PATH, pair));
  // A specimen's visible control or region proves it has mounted even when
  // background requests remain active. Fonts still settle before capture.
  const ready = readyLocator ?? (readyRegion ? page.getByRole("region", { name: readyRegion, exact: true }) : undefined);
  if (ready) await ready.waitFor({ state: "visible" });
  else await page.waitForLoadState("networkidle");
  await waitForFonts(page);
  if (pair.id === "shell-restore-confirmation") {
    await page.getByRole("button", { name: "Restore to draft" }).click();
    const confirmation = page.getByRole("group", { name: "Confirm restore" });
    await confirmation.waitFor({ state: "visible" });
    const confirm = confirmation.getByRole("button", { name: "Confirm restore" });
    await expect(confirm).toBeFocused();
  }
  // The strip scrolls only as far as it must, so its offset depends on whether the fonts
  // arrived before the first reveal. Reveal again from the start with the settled fonts.
  if (pair.id === "media-tabs") {
    await page.getByRole("navigation", { name: "Media sources" }).evaluate((strip) => {
      strip.scrollLeft = 0;
      window.dispatchEvent(new Event("resize"));
    });
  }
  if (pair.id.startsWith("media-favorites-") && pair.id !== "media-favorites-toolbar") {
    const grid = page.getByRole("grid", { name: "Favorite media" });
    await grid.waitFor({ state: "visible" });
    if (pair.id === "media-favorites-selection") {
      await grid.getByRole("checkbox", { name: "Select Station image" }).click();
      await grid.getByRole("checkbox", { name: "Select unavailable favorite" }).click();
      // This specimen records selection, with the card details at rest. Keep
      // focus on the last chosen item and the pointer away from media names.
      await grid.getByRole("checkbox", { name: "Select unavailable favorite" }).focus();
      await page.getByRole("heading", { name: "Favorites", exact: true }).hover();
      await expect(page.getByRole("group", { name: "Details for Station image", exact: true })).toBeHidden();
    }
    if (pair.id.startsWith("media-favorites-viewer-")) {
      const name = pair.id.endsWith("image") ? /^Station image, image/
        : pair.id.endsWith("document") ? /^Brand guide, PDF/
          : /^Archive interview, video/;
      await grid.getByRole("button", { name }).click();
      await page.getByRole("dialog", { name: pair.id.endsWith("image") ? "Station image"
        : pair.id.endsWith("document") ? "Brand guide" : "Archive interview" }).waitFor({ state: "visible" });
      if (pair.id.endsWith("video")) {
        await page.getByRole("dialog", { name: "Archive interview" })
          .getByRole("toolbar", { name: "Preview actions" }).waitFor({ state: "visible" });
      }
    }
  }
  // Interaction tests retain React-owned IDs so later renders keep ARIA links valid.
  if (normalizeGeneratedIds) await normalizeIds(page);
  // Capture from the top of the specimen. The restore specimen opens its lifecycle action
  // by accessible role above; other specimens keep their mount state unchanged.
  await page.evaluate(() => window.scrollTo(0, 0));
  // A click can move the focused control while the pointer still hovers its old
  // trigger. Commit that style change and the reduced-motion transition before
  // measuring rendered roles; screenshot settling alone happens too late.
  await page.evaluate(() => new Promise<void>(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  ));
}
