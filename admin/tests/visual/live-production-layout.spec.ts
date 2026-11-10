import { expect, test } from "./fixtures";

test.beforeEach(async ({ page }) => {
  // Admit this local fixture to the enabled production layout, independent of
  // the gallery server's default feature flag. Keep the real shell and styles.
  await page.route("**/src/lib/live-production-access.ts", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace(
      'import.meta.env.VITE_LIVE_PRODUCTION_ENABLED === "true"', "true",
    ) });
  });
});

for (const host of ["boardwalk", "studio"]) {
  for (const width of [390, 1024, 1280, 1920]) {
    test(`${host} Prepare stacks banner rows at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/live-production.html?host=${host}`);
      await page.getByLabel("Production session").selectOption("rehearsal");
      await page.getByRole("button", { name: "Prepare", exact: true }).click();
      await expect(page.getByRole("button", { name: "Prepare", exact: true })).toHaveAttribute("aria-pressed", "true");
      const banners = page.getByRole("list", { name: "Ordered banners" }).getByRole("button");
      await expect(banners).toHaveCount(2);
      await expect(banners.locator(".live-banner-number")).toHaveText(["1", "2"]);
      await expect(page.getByRole("list", { name: "Ordered banners" })).toHaveCSS("row-gap", "8px");
      const gap = await banners.evaluateAll(elements => elements[1].getBoundingClientRect().top - elements[0].getBoundingClientRect().bottom);
      expect(gap).toBeGreaterThanOrEqual(7);
      expect(gap).toBeLessThanOrEqual(9);
      await page.getByRole("searchbox", { name: "Search" }).fill("POLL");
      await expect(banners).toHaveCount(1);
      await expect(banners.locator(".live-banner-number")).toHaveText(["1"]);
      await page.getByRole("searchbox", { name: "Search" }).fill("missing banner");
      await expect(banners).toHaveCount(0);
      await expect(page.getByText("No banners match these filters.")).toBeVisible();
    });
  }
}

for (const host of ["boardwalk", "studio"]) {
  for (const height of [500, 900]) {
    test(`${host} phone setup uses page flow at 390x${height}`, async ({ page, context }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.setViewportSize({ width: 390, height });
      await page.goto(`/live-production.html?host=${host}`);
      await page.getByLabel("Production session").selectOption("rehearsal");
      await page.getByRole("button", { name: "Prepare", exact: true }).click();
      await page.getByRole("button", { name: /Headline · v1/ }).click();
      const editor = page.getByRole("heading", { name: "Prepare banner", exact: true });
      await expect(editor).toBeFocused();
      await expect(editor).toBeInViewport();
      const clear = page.getByRole("button", { name: "Clear Overlay 1", exact: true });
      const take = page.getByRole("button", { name: "Take saved banner", exact: true });
      await expect(clear).toBeInViewport();
      await expect(take).toBeInViewport();
      const setup = page.locator(".live-studio-setup");
      const summary = setup.locator("summary");
      await summary.focus();
      await page.keyboard.press("Enter");
      const copy = setup.getByRole("button", { name: "Copy session ID", exact: true });
      await expect(copy).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(setup.getByRole("button", { name: "Create studio session", exact: true })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(copy).toBeFocused();
      await copy.click();
      await expect(setup.getByText("Session ID copied.", { exact: true })).toBeVisible();
      const pane = page.locator(".live-side-scroll");
      expect(await pane.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
      for (const control of await setup.locator("button:enabled, input:not(:disabled), select:not(:disabled)").all()) {
        await control.focus();
        await expect(control).toBeFocused();
        const box = (await control.boundingBox())!;
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual((await page.locator(".live-bar").boundingBox())!.y + 0.5);
      }
      await expect(clear).toBeInViewport();
      await expect(take).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      await page.getByRole("button", { name: "Show", exact: true }).click();
      await expect(page.locator(".live-workspace--show")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(height);
    });
  }
  test(`${host} phone setup without a session uses page flow`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 500 });
    await page.goto(`/live-production.html?host=${host}`);
    await page.getByRole("button", { name: "Prepare", exact: true }).click();
    await page.locator(".live-studio-setup > summary").click();
    await page.getByRole("button", { name: "Create studio session", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Create a studio session", exact: true })).toBeFocused();
    await page.getByRole("combobox", { name: "Program", exact: true }).selectOption("spotlight");
    const sessionName = page.getByRole("textbox", { name: "Session name", exact: true });
    await expect(sessionName).toHaveValue(/^NJ Spotlight News - /);
    await sessionName.fill("Phone rehearsal");
    await expect(sessionName).toBeFocused();
    await expect(sessionName).toHaveValue("Phone rehearsal");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await expect(page.getByRole("button", { name: "Cancel session creation", exact: true })).toBeVisible();
  });
  test(`${host} phone session typing before the opening frame keeps focus`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 500 });
    await page.goto(`/live-production.html?host=${host}`);
    await page.getByRole("button", { name: "Prepare", exact: true }).click();
    await page.locator(".live-studio-setup > summary").click();
    // Hold the app's frame callbacks so typing can precede the deferred entry focus.
    const releaseFrames = await page.evaluateHandle(() => {
      const requestFrame = window.requestAnimationFrame.bind(window);
      const callbacks: FrameRequestCallback[] = [];
      window.requestAnimationFrame = callback => { callbacks.push(callback); return callbacks.length; };
      return () => {
        window.requestAnimationFrame = requestFrame;
        return new Promise<void>(resolve => requestFrame(time => {
          for (const callback of callbacks) callback(time);
          resolve();
        }));
      };
    });
    await page.getByRole("button", { name: "Create studio session", exact: true }).click();
    await page.getByRole("combobox", { name: "Program", exact: true }).selectOption("spotlight");
    const sessionName = page.getByRole("textbox", { name: "Session name", exact: true });
    await sessionName.fill("Phone rehearsal");
    await releaseFrames.evaluate(release => release());
    await releaseFrames.dispose();
    await expect(sessionName).toBeFocused();
    await sessionName.pressSequentially(" continued");
    await expect(sessionName).toHaveValue("Phone rehearsal continued");
  });
  test(`${host} phone preparation heading receives focus after discard confirmation`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 500 });
    await page.goto(`/live-production.html?host=${host}`);
    await page.getByLabel("Production session").selectOption("rehearsal");
    await page.getByRole("button", { name: "Prepare", exact: true }).click();
    const addBanner = page.locator(".live-rundown-tools").getByRole("button", { name: "Add banner", exact: true });
    await addBanner.click();
    await expect(page.getByRole("heading", { name: "New banner", exact: true })).toBeFocused();
    await page.getByRole("textbox", { name: "Headline", exact: true }).fill("Unsaved banner");
    await addBanner.click();
    await page.getByRole("button", { name: "Discard and leave", exact: true }).click();
    await expect(page.getByRole("heading", { name: "New banner", exact: true })).toBeFocused();
    await page.getByRole("textbox", { name: "Headline", exact: true }).fill("Another unsaved banner");
    await page.getByRole("button", { name: "Import CSV", exact: true }).click();
    await page.getByRole("button", { name: "Discard and leave", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Import banner CSV", exact: true })).toBeFocused();
  });
}
