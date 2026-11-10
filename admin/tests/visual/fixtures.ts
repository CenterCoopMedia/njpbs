import { readFileSync } from "node:fs";
import { test as base, type BrowserContext, type Page } from "@playwright/test";
export * from "@playwright/test";

/** Serve proof fonts on a context or a page with its own request guard. */
export async function installProofFonts(context: BrowserContext | Page): Promise<void> {
  await context.route(/^https:\/\/media\.njpbs\.org\/cms-media\/fonts\//, route => {
    const face = route.request().url().endsWith("PBSSans-Black.woff2") ? "Black"
      : route.request().url().endsWith("PBSSans-Bold.woff2") ? "Bold" : "Regular";
    return route.fulfill({ contentType: "font/ttf", headers: { "access-control-allow-origin": "*" },
      body: readFileSync(new URL(`../../../site/src/assets/pdf-fonts/PublicSans-${face}.ttf`, import.meta.url)) });
  });
}

/** Visual proof uses the repository's open fonts instead of a live media server. */
export const test = base.extend<{ proofFonts: void }>({
  proofFonts: [async ({ context }, use) => {
    await installProofFonts(context);
    await use();
  }, { auto: true }],
});
