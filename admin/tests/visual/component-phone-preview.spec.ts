import { readFileSync } from "node:fs";
import { expect, test } from "./fixtures";

for (const width of [1121, 1120]) {
  test(`row phone preview keeps its scale and panel stable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 912 });
    await page.goto("/gallery.html?embed=data-table-files&tableRow=true");
    await page.getByRole("button", { name: "Edit row 1", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Row 1", exact: true });
    const panel = dialog.getByRole("complementary", { name: "Component phone preview" });
    if (width <= 1120) await panel.getByRole("button", { name: "Expand component preview" }).click();
    const iframe = panel.locator("iframe");
    await expect(iframe.contentFrame().getByRole("table", { name: "New Jersey audience by county", exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    // Moving the floating panel also activates its resize-to-fit observer.
    if (width > 1120) await panel.getByRole("button", { name: "Move component preview" }).press("ArrowDown");
    for (const phoneWidth of [390, 320, 430]) {
      await panel.getByRole("combobox", { name: "Screen size" }).selectOption(String(phoneWidth));
      await expect.poll(() => iframe.evaluate((element: HTMLIFrameElement) => element.contentWindow!.innerWidth)).toBe(phoneWidth);
      const samples = await panel.evaluate(async element => {
        // Allow the selected phone size and panel position to settle first.
        for (let frame = 0; frame < 4; frame++) await new Promise(requestAnimationFrame);
        const frames = [];
        for (let frame = 0; frame < 60; frame++) {
          await new Promise(requestAnimationFrame);
          const { x, y, width, height } = element.getBoundingClientRect();
          frames.push({ scale: element.querySelector(".component-phone-scale")!.textContent, x, y, width, height });
        }
        return frames;
      });
      expect(samples[0].scale).toMatch(/^\d+% size/);
      for (const sample of samples) expect(sample).toEqual(samples[0]);
    }
  });
}

test("the full editing canvas keeps player scripts inactive", async ({ page }) => {
  await page.route("https://www.youtube-nocookie.com/embed/preview-test", route => route.fulfill({
    contentType: "text/html", body: "<p>Player loading</p><script>document.querySelector('p').textContent='Player ready'</script>",
  }));
  await page.goto("/gallery.html?embed=page-preview-frame");
  const canvas = page.locator('iframe[title="Page canvas preview"]');
  await expect(canvas.contentFrame().getByRole("heading", { name: "Page preview" })).toBeVisible();
  await canvas.evaluate((element: HTMLIFrameElement) => {
    const player = element.contentDocument!.createElement("iframe");
    player.src = "https://www.youtube-nocookie.com/embed/preview-test";
    element.contentDocument!.getElementById("home-preview-root")!.append(player);
  });
  const player = canvas.contentFrame().locator("iframe").contentFrame();
  await expect(player.getByText("Player loading")).toBeVisible();
  await expect(player.getByText("Player ready")).toHaveCount(0);
});

// IDs are URL-format fixtures; third-party responses are deterministic network fakes.
for (const [provider, url, src, ratio] of [
  ["YouTube", "https://www.youtube.com/watch?v=od8NMua_mEw&t=268", "https://www.youtube-nocookie.com/embed/od8NMua_mEw?start=268", 16 / 9],
  ["Vimeo", "https://vimeo.com/76979871", "https://player.vimeo.com/video/76979871?dnt=1", 16 / 9],
  ["TikTok", "https://www.tiktok.com/@scout2015/video/6718335390845095173", "https://www.tiktok.com/embed/v2/6718335390845095173", 9 / 16],
  ["Instagram post", "https://www.instagram.com/p/CxYz_123Ab-/", "https://www.instagram.com/p/CxYz_123Ab-/embed", 16 / 9],
  ["Instagram Reel", "https://www.instagram.com/reel/CxYz_123Ab-/", "https://www.instagram.com/reel/CxYz_123Ab-/embed", 9 / 16],
  ["Facebook", "https://www.facebook.com/watch/?v=10153231379946729", "https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Fwatch%2F%3Fv%3D10153231379946729", 16 / 9],
  ["PBS", "https://player.pbs.org/partnerplayer/ix6DN99Ppzn3ntnxghoZbw==/", "https://player.pbs.org/partnerplayer/ix6DN99Ppzn3ntnxghoZbw==/", 16 / 9],
] as const) {
  test(`${provider} phone preview loads the public player at every phone size`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.route(src, route => route.fulfill({
      contentType: "text/html", body: "<p>Player loading</p><script>document.querySelector('p').textContent='Player ready'</script>",
    }));
    await page.goto("/gallery.html?embed=component-video-preview");
    await page.getByRole("button", { name: "Edit video or embed 1", exact: true }).click();
    await page.getByRole("dialog").getByRole("textbox", { name: "Video or embed link", exact: true }).fill(url);
    const panel = page.getByRole("complementary", { name: "Component phone preview" });
    const phone = panel.locator("iframe");
    const player = phone.contentFrame().locator("iframe");
    for (const width of [390, 320, 430]) {
      await panel.getByRole("combobox", { name: "Screen size" }).selectOption(String(width));
      // An already-loaded player stays visible while the phone viewport resizes.
      await expect.poll(() => phone.evaluate((element: HTMLIFrameElement) => element.contentWindow!.innerWidth)).toBe(width);
      await expect(player).toHaveAttribute("src", src);
      await expect(player).toHaveAttribute("loading", "lazy");
      await expect(player.contentFrame().getByText("Player ready")).toBeVisible();
      await expect(phone.contentFrame().getByRole("heading", { name: "Latest newscast" })).toBeVisible();
      const size = await player.evaluate(element => ({ width: element.clientWidth, height: element.clientHeight }));
      // Landscape players fill the phone; portrait players stay centered at a
      // readable width on larger screens. Both must fit the selected viewport.
      expect(size.width).toBeGreaterThan(0);
      expect(size.width).toBeLessThanOrEqual(width);
      if (ratio > 1) expect(size.width).toBeGreaterThan(width - 40);
      expect(Math.abs(size.width / size.height - ratio)).toBeLessThan(0.02);
    }
  });
}

test("X video phone preview shows the supported link card", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/gallery.html?embed=component-video-preview");
  await page.getByRole("button", { name: "Edit video or embed 1", exact: true }).click();
  await page.getByRole("dialog").getByRole("textbox", { name: "Video or embed link", exact: true }).fill("https://twitter.com/NJPBS/status/1234567890123456789");
  const phone = page.getByRole("complementary", { name: "Component phone preview" }).locator("iframe");
  await expect(phone.contentFrame().getByRole("link", { name: "X / Twitter Latest newscast" })).toHaveAttribute("href", "https://x.com/NJPBS/status/1234567890123456789");
  await expect(phone.contentFrame().locator("iframe")).toHaveCount(0);
});

test("phone sizes use real viewports and keep the draft and table controls usable", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/gallery.html?embed=data-table-files");
  const opener = page.getByRole("button", { name: "Edit data table 1", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog");
  const panel = dialog.getByRole("complementary", { name: "Component phone preview" });
  const iframe = panel.locator("iframe");
  await dialog.getByRole("textbox", { name: "Table title", exact: true }).fill("Current draft table");
  for (const [width, height] of [[390, 844], [320, 568], [430, 932]]) {
    await panel.getByRole("combobox", { name: "Screen size" }).selectOption(String(width));
    await expect.poll(() => iframe.evaluate((element: HTMLIFrameElement) => ({
      width: element.contentWindow!.innerWidth, height: element.contentWindow!.innerHeight,
    }))).toEqual({ width, height });
    await expect(iframe.contentFrame().getByRole("table", { name: "Current draft table", exact: true })).toBeVisible();
  }
  const frame = iframe.contentFrame();
  await frame.getByRole("searchbox", { name: "Search table" }).fill("Essex");
  await expect(frame.getByRole("status")).toHaveText("1 of 3 rows");
  await frame.getByRole("searchbox", { name: "Search table" }).fill("");
  await frame.getByRole("button", { name: "Sort by County", exact: true }).click();
  await expect(frame.locator("tbody tr").first()).toContainText("Bergen");

  await panel.getByRole("combobox", { name: "Screen size" }).selectOption("320");
  await expect.poll(() => iframe.evaluate((element: HTMLIFrameElement) => element.contentWindow!.innerHeight)).toBe(568);
  for (let step = 0; step < 20; step++) {
    const before = (await panel.boundingBox())!;
    if (before.y + before.height >= 991) break;
    await panel.getByRole("button", { name: "Move component preview" }).press("Shift+ArrowDown");
    await expect.poll(() => panel.evaluate(element => element.getBoundingClientRect().top)).toBeGreaterThan(before.y);
  }
  await expect.poll(() => panel.evaluate(element => element.getBoundingClientRect().bottom)).toBeGreaterThanOrEqual(991);
  expect((await panel.boundingBox())!.y).toBeGreaterThan(100);
  await panel.getByRole("combobox", { name: "Screen size" }).selectOption("430");
  await expect.poll(() => iframe.evaluate((element: HTMLIFrameElement) => element.contentWindow!.innerHeight)).toBe(932);
  await expect.poll(() => panel.evaluate(element => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(992);

  await page.setViewportSize({ width: 1440, height: 600 });
  await expect.poll(() => panel.evaluate(element => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(584);
  await panel.getByRole("button", { name: "Collapse component preview" }).click();
  await panel.getByRole("button", { name: "Expand component preview" }).click();
  await panel.getByRole("button", { name: "Close component preview" }).click();
  await expect(dialog.getByRole("button", { name: "Phone preview", exact: true })).toBeFocused();
  await dialog.getByRole("button", { name: "Phone preview", exact: true }).click();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(opener).toBeFocused();
  await opener.click();
  await expect(dialog.getByRole("textbox", { name: "Table title", exact: true })).toHaveValue("Current draft table");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel.getByRole("button", { name: "Expand component preview" })).toBeVisible();
  await panel.getByRole("button", { name: "Expand component preview" }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await expect.poll(() => iframe.evaluate((element: HTMLIFrameElement) => element.contentWindow!.innerWidth)).toBe(390);
  expect(pageErrors).toEqual([]);
});

test("trusted video scripts run while draft scripts and unapproved frames remain blocked", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const blockedRequests: string[] = [];
  await page.route("**/preview-untrusted*", route => {
    blockedRequests.push(route.request().url());
    return route.fulfill({ contentType: "text/html", body: "<script>parent.postMessage('draft-script-ran', '*')</script>" });
  });
  await page.route("https://www.youtube-nocookie.com/embed/preview-test", route => route.fulfill({
    contentType: "text/html", body: "<p>Player loading</p><script>document.querySelector('p').textContent='Player script ran'</script>",
  }));
  await page.route("https://example.org/preview-style.css", route => route.fulfill({
    contentType: "text/css", body: '@font-face { font-family: "Preview fixture"; src: url("https://example.org/preview-font.ttf"); } #styled { color: rgb(0, 128, 0); font-family: "Preview fixture"; }',
  }));
  await page.route("https://example.org/preview-font.ttf", route => route.fulfill({
    contentType: "font/ttf", headers: { "access-control-allow-origin": "*" },
    body: readFileSync(new URL("../../../site/src/assets/pdf-fonts/PublicSans-Regular.ttf", import.meta.url)),
  }));
  await page.goto("/gallery.html?embed=data-table-files");
  await page.getByRole("button", { name: "Edit data table 1", exact: true }).click();
  const iframe = page.getByRole("complementary", { name: "Component phone preview" }).locator("iframe");
  await expect(iframe.contentFrame().getByRole("table")).toBeVisible();
  await iframe.evaluate((element: HTMLIFrameElement) => {
    const document = element.contentDocument!;
    const target = document.getElementById("home-preview-root")!;
    window.addEventListener("message", event => {
      if (event.data === "draft-script-ran") document.body.dataset.draftScriptRan = "true";
    });
    document.addEventListener("securitypolicyviolation", () => {
      document.body.dataset.blocked = String(Number(document.body.dataset.blocked ?? 0) + 1);
    });
    const script = document.createElement("script");
    script.textContent = "top.postMessage('draft-script-ran', '*')";
    target.append(script);
    const external = document.createElement("script");
    external.src = `${window.location.origin}/preview-untrusted-script.js`;
    target.append(external);
    const image = document.createElement("img");
    image.setAttribute("onerror", "top.postMessage('draft-script-ran', '*')");
    image.src = "data:image/png,invalid";
    target.append(image);
    const local = document.createElement("iframe");
    local.title = "Draft HTML";
    local.sandbox.value = "allow-scripts";
    local.srcdoc = '<meta http-equiv="Content-Security-Policy" content="script-src * \'unsafe-inline\'"><link rel="stylesheet" href="https://example.org/preview-style.css"><p id="styled">Draft HTML loaded</p><script>top.postMessage("draft-script-ran", "*")</script>';
    target.append(local);
    for (const src of [`${window.location.origin}/preview-untrusted-frame`, "https://example.org/preview-untrusted-frame"]) {
      const denied = document.createElement("iframe");
      denied.src = src;
      target.append(denied);
    }
    const player = document.createElement("iframe");
    player.title = "Allowed player";
    player.src = "https://www.youtube-nocookie.com/embed/preview-test";
    target.append(player);
  });
  const frame = iframe.contentFrame();
  await expect(frame.frameLocator('iframe[title="Allowed player"]').getByText("Player script ran")).toBeVisible();
  await expect(frame.frameLocator('iframe[title="Draft HTML"]').getByText("Draft HTML loaded")).toBeVisible();
  await expect(frame.frameLocator('iframe[title="Draft HTML"]').getByText("Draft HTML loaded")).toHaveCSS("color", "rgb(0, 128, 0)");
  await expect.poll(() => frame.frameLocator('iframe[title="Draft HTML"]').getByText("Draft HTML loaded")
    .evaluate(element => Array.from(element.ownerDocument.fonts).some(font => font.status === "loaded"))).toBe(true);
  await expect.poll(() => iframe.evaluate((element: HTMLIFrameElement) => Number(element.contentDocument!.body.dataset.blocked))).toBeGreaterThanOrEqual(5);
  expect(await iframe.evaluate((element: HTMLIFrameElement) => element.contentDocument!.body.dataset.draftScriptRan)).toBeUndefined();
  expect(blockedRequests).toEqual([]);
  await frame.getByRole("searchbox", { name: "Search table" }).fill("Essex");
  await expect(frame.getByRole("status")).toHaveText("1 of 3 rows");
});
