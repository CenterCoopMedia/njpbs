import { expect, test } from "./fixtures";
import { fileURLToPath } from "node:url";
import { freezeClock, waitForFonts } from "./capture";

for (const width of [1280, 1920, 390]) {
  for (const surface of ["light", "dark"]) {
    test(`coverage eyebrows on ${surface} at ${width}px`, async ({ page }) => {
      await freezeClock(page);
      // The preview uses the public origin, but its exact bundled assets are local.
      await page.route(/^https:\/\/(?:dev\.)?njpbs\.org\/brand\//, route => route.fulfill({
        path: fileURLToPath(new URL(`../../../site/public${new URL(route.request().url()).pathname}`, import.meta.url)),
        headers: { "access-control-allow-origin": "*" },
      }));
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`/coverage-labels.html?view=home-${surface}`);
      const frame = page.frameLocator('iframe[title="Home coverage labels"]');
      await expect(frame.locator(".post-coverage")).toHaveCount(2);
      await waitForFonts(page);
      await frame.locator("body").evaluate(async body => {
        await body.ownerDocument.fonts.ready;
        await Promise.all([...body.querySelectorAll("img")].map(image => image.decode()));
      });
      const result = await frame.locator("body").evaluate(body => {
        const coverage = body.querySelector<HTMLElement>('[data-coverage-label="nj-decides-2026"]')!;
        const publication = body.querySelector<HTMLElement>('[data-publication="nj-spotlight-news"]')!;
        const custom = body.querySelector<HTMLElement>('[data-coverage-label="statehouse-watch"]')!;
        const customReference = custom.closest(".post-branding-group")!.querySelector<HTMLElement>('[data-publication="nj-spotlight-news"]')!;
        const typography = (element: HTMLElement) => {
          const style = getComputedStyle(element);
          return [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight,
            style.letterSpacing, style.textTransform, style.color];
        };
        const bar = getComputedStyle(coverage, "::before");
        const customBar = getComputedStyle(custom, "::before");
        return {
          typography: typography(coverage), reference: typography(publication), customTypography: typography(custom), customReference: typography(customReference),
          top: coverage.getBoundingClientRect().top, referenceTop: publication.getBoundingClientRect().top,
          barWidth: parseFloat(bar.width), referenceWidth: parseFloat(getComputedStyle(publication).borderInlineStartWidth),
          barHeight: parseFloat(bar.height), referenceHeight: publication.getBoundingClientRect().height,
          gradient: bar.backgroundImage, frame: bar.boxShadow, customFrame: customBar.boxShadow,
          radius: getComputedStyle(coverage).borderRadius, background: getComputedStyle(coverage).backgroundColor,
          overflow: body.ownerDocument.documentElement.scrollWidth > body.ownerDocument.defaultView!.innerWidth,
        };
      });
      expect(result.typography).toEqual(result.reference);
      expect(result.customTypography).toEqual(result.customReference);
      expect(Math.abs(result.top - result.referenceTop)).toBeLessThan(0.5);
      expect(Math.abs(result.barWidth - result.referenceWidth)).toBeLessThan(0.25);
      expect(Math.abs(result.barHeight - result.referenceHeight)).toBeLessThan(0.25);
      expect(result.gradient).toContain("linear-gradient");
      expect(result.gradient).toContain("rgb(255, 255, 255)");
      expect(result.frame).not.toBe("none");
      expect(result.customFrame).not.toBe("none");
      expect(result.radius).toBe("0px");
      expect(result.background).toBe("rgba(0, 0, 0, 0)");
      expect(result.overflow).toBe(false);
      await expect(page).toHaveScreenshot(`coverage-eyebrows-${surface}-${width}w.png`, { fullPage: true });
    });
  }
}
