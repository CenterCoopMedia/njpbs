import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const fonts: Record<string, string> = JSON.parse(readFileSync(new URL("../../../site/scripts/public-fonts.json", import.meta.url), "utf8"));

test("built Admin renders its signed-out shell without page errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  try {
    const response = await page.goto("/", { waitUntil: "load" });
    expect(response?.ok(), "Admin document must load successfully").toBe(true);
    await expect(page.locator("#root")).not.toBeEmpty();
    // A loading indicator or error boundary is not a working signed-out shell.
    await expect(page.getByRole("heading", { name: "Sign in to Boardwalk", exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Email", exact: true })).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  } finally {
    expect(errors, "Admin boot must not raise any pageerror").toEqual([]);
  }
});

test("every PBS Sans face in the Admin stylesheets loads as a font", async ({ page }) => {
  await page.goto("/", { waitUntil: "load" });
  const urls = await page.evaluate(() => [...document.styleSheets].flatMap(sheet => [...sheet.cssRules]
    .filter((rule): rule is CSSFontFaceRule => rule instanceof CSSFontFaceRule)
    .flatMap(rule => [...rule.style.getPropertyValue("src").matchAll(/url\("?([^")]+)"?\)/g)]
      .map(match => new URL(match[1], sheet.href ?? document.baseURI).href))));
  expect(urls.map(url => new URL(url).pathname).sort()).toEqual(Object.keys(fonts).map(name => `/brand/fonts/${name}`).sort());
  for (const url of urls) {
    const response = await page.request.get(url);
    expect(response.status(), url).toBe(200);
    expect(response.headers()["content-type"], url).toBe("font/woff2");
  }
});
