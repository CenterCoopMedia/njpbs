import { expect, test } from "./fixtures";

for (const width of [1280, 1920, 390]) {
  test(`Home preview blocks untrusted feed images and omits referrers at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const leaks: string[] = [];
    const referrers: (string | undefined)[] = [];
    const image = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>';
    await page.route("https://feed-image.invalid/**", route => {
      leaks.push(route.request().url());
      return route.fulfill({ contentType: "image/svg+xml", body: image });
    });
    await page.route("https://image.pbs.org/harden-privacy-*", async route => {
      referrers.push((await route.request().allHeaders()).referer);
      return route.request().url().endsWith("redirect")
        ? route.fulfill({ status: 302, headers: { location: "https://feed-image.invalid/redirected.png" } })
        : route.fulfill({ contentType: "image/svg+xml", body: image });
    });
    await page.route("https://njpbs.org/brand/harden-privacy.svg", async route => {
      referrers.push((await route.request().allHeaders()).referer);
      return route.fulfill({ contentType: "image/svg+xml", body: image });
    });
    await page.goto("/gallery.html?embed=page-preview-frame");
    const canvas = page.locator('iframe[title="Page canvas preview"]');
    await expect(canvas.contentFrame().getByRole("heading", { name: "Page preview" })).toBeVisible();
    await expect(canvas).toHaveAttribute("referrerpolicy", "no-referrer");
    await canvas.evaluate((element: HTMLIFrameElement) => {
      const document = element.contentDocument!;
      const root = document.getElementById("home-preview-root")!;
      root.dataset.imageViolations = "0";
      document.addEventListener("securitypolicyviolation", event => {
        // Redirect violations may report the original allowed URL. The route
        // spy below proves that neither untrusted destination is requested.
        if (event.violatedDirective === "img-src") {
          root.dataset.imageViolations = String(Number(root.dataset.imageViolations) + 1);
        }
      });
      for (const [id, src] of [
        ["direct", "https://feed-image.invalid/direct.png"],
        ["trusted", "https://image.pbs.org/harden-privacy-trusted"],
        ["redirect", "https://image.pbs.org/harden-privacy-redirect"],
        ["brand", "https://njpbs.org/brand/harden-privacy.svg"],
      ]) {
        const img = document.createElement("img");
        img.id = id;
        img.src = src;
        root.append(img);
      }
    });
    await expect.poll(() => canvas.evaluate((element: HTMLIFrameElement) => {
      const image = element.contentDocument!.getElementById("trusted") as HTMLImageElement;
      return image.complete && image.naturalWidth;
    })).toBe(2);
    await expect.poll(() => canvas.evaluate((element: HTMLIFrameElement) => {
      const image = element.contentDocument!.getElementById("brand") as HTMLImageElement;
      return image.complete && image.naturalWidth;
    })).toBe(2);
    await expect.poll(() => canvas.evaluate((element: HTMLIFrameElement) =>
      Number(element.contentDocument!.getElementById("home-preview-root")!.dataset.imageViolations),
    )).toBe(2);
    expect(referrers).toEqual([undefined, undefined, undefined]);
    expect(leaks).toEqual([]);
  });
}
