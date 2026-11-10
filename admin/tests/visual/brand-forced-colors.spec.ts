import { expect, test, type Locator } from "./fixtures";
import { openSpecimen, waitForFonts } from "./capture";

function luminance(color: string): number {
  const [red, green, blue] = color.match(/[\d.]+/g)!.slice(0, 3).map(value => {
    const channel = Number(value) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

async function background(locator: Locator): Promise<string> {
  return locator.evaluate(element => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      const color = getComputedStyle(node).backgroundColor;
      if (!color.startsWith("rgba(") || color.endsWith(", 1)")) return color;
    }
    throw new Error("The brand has no opaque backdrop");
  });
}

// Keep forced colors active during Chromium headless-shell full-page capture.
// Remove this launch switch when captureBeyondViewport preserves media overrides.
test.use({ launchOptions: {
  chromiumSandbox: true,
  args: ["--force-high-contrast"],
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {}),
} });

for (const surface of ["shell-home", "sign-in"]) {
  for (const width of surface === "shell-home" ? [1280] : [390]) {
    for (const colorScheme of ["light", "dark"] as const) {
      test(`${surface} retains the official lockup in ${colorScheme} forced colors at ${width}px`, async ({ page }, info) => {
        await page.emulateMedia({ forcedColors: "active", colorScheme });
        if (surface === "sign-in") {
          await page.setViewportSize({ width, height: width === 390 ? 800 : 900 });
          await page.goto("/");
          await expect(page.getByRole("heading", { name: "Sign in to Boardwalk", exact: true })).toBeVisible();
          await expect(page.getByLabel("Password", { exact: true })).toBeEmpty();
          await waitForFonts(page);
        } else {
          await page.addInitScript(() => localStorage.setItem("njpbs-admin:navigation-collapsed", "false"));
          await openSpecimen(page, { id: surface, title: surface, width, presentation: "text" });
        }

        const brand = page.getByRole("group", { name: "Boardwalk", exact: true });
        const image = brand.getByRole("img", { name: "NJ PBS", exact: true });
        await expect(image).toBeVisible();
        expect(await image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
        if (surface !== "shell-home") await expect(brand.getByText("Boardwalk", { exact: true })).toBeVisible();
        // Hosted actuals are evidence, not a locally generated golden.
        const captureName = `brand-${surface}-${colorScheme}-${width}.png`;
        await info.attach(captureName, { body: await page.screenshot({ path: info.outputPath(captureName), fullPage: true }), contentType: "image/png" });
        const backdrop = await background(image);
        // The official SVG has white letters. A light Canvas must not erase them.
        expect((1 + 0.05) / (luminance(backdrop) + 0.05), `White NJ PBS letters against ${backdrop}`).toBeGreaterThanOrEqual(4.5);
        // Only the image needs brand paint; surrounding text follows system colors.
        await expect(brand).toHaveCSS("forced-color-adjust", "auto");
        if (surface === "sign-in") {
          await expect(page.getByRole("textbox", { name: "Email", exact: true })).toHaveCSS("forced-color-adjust", "auto");
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (surface === "shell-home") {
          const customize = page.getByRole("button", { name: "Customize Home shortcuts", exact: true });
          await expect(customize).toBeVisible();
          const bounds = await customize.evaluate(button => {
            const { left, right } = button.getBoundingClientRect();
            return { left, right, viewport: innerWidth };
          });
          const shortcutRight = await page.getByRole("group", { name: "Home shortcuts", exact: true })
            .getByRole("link").evaluateAll(links => Math.max(...links.map(link => link.getBoundingClientRect().right)));
          expect(bounds.right, "The forced-color border stays within the shortcut button edge").toBeLessThanOrEqual(shortcutRight);
          expect(bounds.left).toBeGreaterThanOrEqual(0);
          expect(bounds.right).toBeLessThanOrEqual(bounds.viewport);
        }
        await expect(page).toHaveScreenshot(captureName, { fullPage: true });
        if (surface === "shell-home") {
          const customize = page.getByRole("button", { name: "Customize Home shortcuts", exact: true });
          await customize.focus();
          await customize.press("Enter");
          await expect(page.getByRole("dialog", { name: "Your Home shortcuts", exact: true })).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(customize).toBeFocused();
        }
      });
    }
  }
}
