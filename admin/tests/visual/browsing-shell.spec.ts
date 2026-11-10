import { expect, test, type Request } from "./fixtures";
import { freezeClock, openSpecimen, waitForFonts } from "./capture";

test.beforeEach(async ({ page }) => {
  await freezeClock(page);
  await page.addInitScript(() => localStorage.setItem("njpbs-admin:navigation-collapsed", "false"));
});

for (const family of ["library"]) {
  test(`${family} shares the measured identity and command bars and preserves rail disclosure`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/gallery.html?embed=browsing-family-shell&family=${family}&presentation=icons&guide=1`);
    const shell = page.locator(".app-shell");
    await expect(shell).toHaveAttribute("data-shared-chrome", "true");
    await expect(page.locator(".workspace-browse-toolbar")).not.toBeEmpty();
    await waitForFonts(page);
    const identity = page.locator(".workspace-document-bar");
    expect((await identity.boundingBox())!.height).toBe(58);
    await expect(page.locator(".sidebar")).toHaveCSS("width", "208px");
    const current = page.locator(".nav-item.active").first();
    const marker = current.locator("xpath=ancestor::div[contains(@class,'nav-destination-main')][1]");
    const active = await marker.count() ? marker : current;
    await expect(active).toHaveCSS("background-color", "rgb(32, 54, 84)");
    await expect(active).toHaveCSS("box-shadow", "rgb(120, 140, 255) 2px 0px 0px 0px inset");
    const chrome = page.locator(".workspace-chrome");
    await expect.poll(() => page.locator(".workspace-shell").evaluate(node => Number.parseFloat(getComputedStyle(node).getPropertyValue("--workspace-header-height"))))
      .toBeCloseTo((await chrome.boundingBox())!.height, 1);
    await page.getByRole("button", { name: "Collapse primary navigation", exact: true }).click();
    await expect(shell).toHaveAttribute("data-sidebar-collapsed", "true");
    await expect(page.locator(".sidebar")).toHaveCSS("width", "60px");
    expect(await page.evaluate(() => localStorage.getItem("njpbs-admin:navigation-collapsed"))).toBe("true");
    await page.getByRole("button", { name: "Expand primary navigation", exact: true }).click();
    await expect(page.locator(".sidebar")).toHaveCSS("width", "208px");
    expect(await page.evaluate(() => localStorage.getItem("njpbs-admin:navigation-collapsed"))).toBe("false");
    if (family === "record-list") {
      await page.evaluate(() => window.scrollTo(0, 640));
      expect(await page.evaluate(() => scrollY)).toBeGreaterThan(100);
      expect((await identity.boundingBox())!.y).toBe(0);
      expect((await page.locator(".workspace-browse-toolbar").boundingBox())!.y).toBe(58);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1280);
  });
}

test("phone Finder and Help retain keyboard dismissal while the command bar wraps", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/gallery.html?embed=browsing-family-shell&family=library&presentation=text&guide=1");
  const finder = page.locator(".browse-workspace-find").getByRole("button", { name: "Find a workspace", exact: true });
  await expect(finder).toBeVisible();
  await finder.click();
  await expect(page.getByRole("dialog", { name: "Find a workspace", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(finder).toBeFocused();
  const help = page.getByRole("button", { name: "Help and reporting", exact: true });
  await help.click();
  await expect(page.getByRole("link", { name: "Open Boardwalk guide in a new tab" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(help).toBeFocused();
  const commandBar = page.locator(".workspace-browse-toolbar");
  expect((await commandBar.boundingBox())!.height).toBeLessThan(200);
  await expect(page.getByRole("searchbox", { name: "Search content", exact: true })).toHaveCSS("height", "40px");
  await expect(page.getByRole("combobox", { name: "Sort by", exact: true })).toHaveCSS("height", "40px");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

for (const width of [768, 1024]) {
  test(`Review queue headers and long facts fit their own columns at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/gallery.html?embed=browsing-family-shell&family=queue&presentation=text&guide=1');
    const table = page.locator('.review-queue-table');
    await expect(table).toBeVisible();
    await waitForFonts(page);
    const headerFactsFit = () => table.locator('th:not(.content-index-actions-cell)').evaluateAll(cells => cells.every(cell => {
      const box = cell.getBoundingClientRect(), style = getComputedStyle(cell);
      const range = document.createRange(); range.selectNodeContents(cell);
      return [...range.getClientRects()].every(text => text.left >= box.left + parseFloat(style.paddingLeft) - 1
        && text.right <= box.right - parseFloat(style.paddingRight) + 1);
    }));
    await expect.poll(headerFactsFit).toBe(true);
    await page.getByRole('button', { name: 'Collapse primary navigation', exact: true }).click();
    await expect.poll(headerFactsFit).toBe(true);
    // Plausible unbroken values exercise wrapping in the original fact cells.
    await table.locator('tbody tr').first().evaluate(row => {
      row.querySelector('td[data-label="Version"]')!.textContent = '12345';
      row.querySelector('td[data-label="Assigned to"]')!.textContent = 'AlexandriaMontgomeryPatterson';
    });
    const facts = table.locator('tbody tr').first().locator('td[data-label="Version"], td[data-label="Assigned to"]');
    await expect.poll(() => facts.evaluateAll(cells => cells.every(cell => {
      const box = cell.getBoundingClientRect(), style = getComputedStyle(cell);
      const range = document.createRange(); range.selectNodeContents(cell);
      return [...range.getClientRects()].every(text => text.left >= box.left + parseFloat(style.paddingLeft) - 1
        && text.right <= box.right - parseFloat(style.paddingRight) + 1);
    }))).toBe(true);
  });
}

test("narrow library titles retain readable space and metadata clears the thumbnail", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/gallery.html?embed=browsing-family-shell&family=library&presentation=icons&guide=1");
  const title = page.getByRole("link", { name: "Transit funding explained", exact: true });
  await expect(title).toBeVisible();
  await waitForFonts(page);
  const row = title.locator("xpath=ancestor::tr");
  const text = await title.locator("span").last().boundingBox();
  const thumbnail = await title.locator(".content-row-thumbnail").boundingBox();
  const updated = await row.locator(".content-index-date-inline").boundingBox();
  expect(text!.width).toBeGreaterThan(120);
  expect(text!.height).toBeLessThan(40);
  expect(updated!.x).toBeGreaterThanOrEqual(thumbnail!.x + thumbnail!.width + 9);
  await expect(row.locator(".browse-row-inline")).toBeHidden();
  await row.getByRole("button", { name: "Transit funding explained actions", exact: true }).click();
  const actions = page.getByRole("dialog", { name: "Transit funding explained actions", exact: true });
  await expect(actions.getByRole("link", { name: "Edit Transit funding explained", exact: true }))
    .toHaveAttribute("href", (await title.getAttribute("href"))!);
  await expect(actions.getByRole("button", { name: "Show details for Transit funding explained", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

for (const kind of ["sponsor", "event"]) {
  test(`${kind} keeps its primary name readable beside real metadata columns`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/gallery.html?embed=browsing-family-shell&family=record-list&recordKind=${kind}&presentation=icons&guide=1`);
    const name = kind === "event" ? "New Jersey community screening and conversation" : "New Jersey Community Foundation 1";
    const title = page.getByRole("link", { name, exact: true });
    await expect(title).toBeVisible();
    await waitForFonts(page);
    const row = title.locator("xpath=ancestor::tr");
    const table = page.locator(".record-list .browse-table");
    // The desktop table has the same column rules at 1280 and 1440px.
    for (const width of [1280]) {
      await page.setViewportSize({ width, height: 900 });
      expect((await table.getByRole("columnheader", { name: "Name", exact: true }).boundingBox())!.width)
        .toBeGreaterThan((await table.boundingBox())!.width * 0.45);
      expect((await title.boundingBox())!.height).toBeLessThan(25);
      expect((await row.getByRole("button", { name: `${name} actions`, exact: true }).boundingBox())!.x)
        .toBeGreaterThan((await title.boundingBox())!.x + (await title.boundingBox())!.width);
      if (kind === "event") {
        await expect(row.locator('td[data-label="Starts"]')).toContainText("Aug 22, 2026");
        expect(await row.locator('td[data-label="Starts"]').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      }
    }
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(page.locator(".browse-workspace-find").getByRole("button", { name: "Find a workspace", exact: true })).toBeVisible();
    expect((await title.boundingBox())!.width).toBeGreaterThan(150);
    await expect(row.getByRole("button", { name: `${name} actions`, exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  });
}

test("row overflow preserves native open destinations and returns focus after real details", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/gallery.html?embed=browsing-family-shell&family=directory&presentation=icons&guide=1");
  const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: "Edit page draft: Home", exact: true }) });
  const nativeHref = await row.getByRole("link", { name: "Edit page draft: Home", exact: true }).getAttribute("href");
  const more = row.getByRole("button", { name: "Home actions", exact: true });
  const before = (await row.boundingBox())!.height;
  await more.click();
  const actions = page.getByRole("dialog", { name: "Home actions", exact: true });
  await expect(actions.getByRole("link", { name: "Edit draft", exact: true })).toHaveAttribute("href", nativeHref!);
  await actions.getByRole("button", { name: "Show details for Home", exact: true }).click();
  await expect(actions).toBeHidden();
  await expect(more).toBeFocused();
  await expect(page.getByRole("region", { name: "Home details", exact: true })).toBeVisible();
  expect((await row.boundingBox())!.height).toBe(before);
  await more.click();
  await expect(actions.getByRole("button", { name: "Hide details for Home", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();
  await expect(row).not.toHaveAttribute("data-selected");
});


for (const width of [390, 1280]) {
  test(`quick-view focus rings remain complete inside their scroller at ${width}px`, async ({ page }) => {
    const goto = page.goto.bind(page);
    page.goto = (url, options) => goto(`${url}&family=library&guide=1`, options);
    try {
      await openSpecimen(page, { id: "browsing-family-shell", title: "Library", width, presentation: "icons" }, { normalizeGeneratedIds: false });
    } finally { page.goto = goto; }
    const strip = page.locator(".content-library .content-library-views");
    const buttons = await strip.getByRole("button").all();
    await buttons[0].focus();
    for (const button of buttons) {
      await expect(button).toBeFocused();
      await expect(button).toHaveCSS("outline-style", "solid");
      // Keep exact full-target bounds after native Tab reveals each control.
      await expect.poll(() => button.evaluate(element => {
        const box = element.getBoundingClientRect();
        const clip = element.closest(".content-library-views")!.getBoundingClientRect();
        return box.left >= clip.left - 0.5 && box.right <= clip.right + 0.5;
      })).toBe(true);
      const bounds = await button.evaluate(element => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        const clip = element.closest(".content-library-views")!.getBoundingClientRect();
        return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, clip: { x: clip.x, y: clip.y, right: clip.right, bottom: clip.bottom },
          outset: Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset)) };
      });
      expect(bounds.x - bounds.outset).toBeGreaterThanOrEqual(bounds.clip.x - 0.5);
      expect(bounds.y - bounds.outset).toBeGreaterThanOrEqual(bounds.clip.y - 0.5);
      expect(bounds.right + bounds.outset, await button.getAttribute("aria-label") ?? await button.innerText()).toBeLessThanOrEqual(bounds.clip.right + 0.5);
      expect(bounds.bottom + bounds.outset).toBeLessThanOrEqual(bounds.clip.bottom + 0.5);
      await page.keyboard.press("Tab");
    }
  });
}

test("row links preserve native activation and return keyboard focus to More", async ({ page }) => {
  const mockedPublicRequests = new Set<Request>();
  await page.context().route("https://njpbs.org/**", route => {
    mockedPublicRequests.add(route.request());
    return route.fulfill({ contentType: "text/html", body: "<title>Local public-page fixture</title>" });
  });
  let editorNavigationRequests = 0;
  await page.context().route("**/content/pages/home/edit", route => {
    editorNavigationRequests++;
    return route.abort();
  });
  const goto = page.goto.bind(page);
  page.goto = (url, options) => goto(`${url}&family=directory&guide=1`, options);
  try {
    await openSpecimen(page, { id: "browsing-family-shell", title: "Directory", width: 390, presentation: "icons" }, { normalizeGeneratedIds: false });
  } finally { page.goto = goto; }
  const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: "Edit page draft: Home", exact: true }) });
  const more = row.getByRole("button", { name: "Home actions", exact: true });
  const actions = page.getByRole("dialog", { name: "Home actions", exact: true });
  const edit = actions.getByRole("link", { name: "Edit draft", exact: true });
  const popupRequests: Request[] = [];
  page.context().on("request", request => {
    try { if (request.frame().page() === page) return; }
    catch { /* A new popup's first request can precede its frame. */ }
    popupRequests.push(request);
  });
  const newTabTimeoutMs = 5_000;
  for (const mode of ["live", "modified-edit"]) {
    await more.focus();
    await more.press("Enter");
    await expect(actions).toBeVisible();
    // Popover moves focus after showing the panel; wait before native activation.
    await expect(edit).toBeFocused();
    if (mode === "live") {
      const [popup] = await Promise.all([
        page.context().waitForEvent("page", { timeout: newTabTimeoutMs }).catch(cause => {
          throw new Error(`No new tab opened for ${mode} within ${newTabTimeoutMs} ms`, { cause });
        }),
        actions.getByRole("link", { name: "View live: Home (opens in a new tab)", exact: true }).press("Enter"),
      ]);
      await expect(popup).toHaveURL("https://njpbs.org/");
      await popup.close();
    } else {
      // Observe after React's handlers, then stop browser navigation. Chromium can load
      // a background target without reporting its first commit to Playwright (#3639).
      const activation = await page.evaluateHandle(() => {
        const result: { defaultPrevented?: boolean; ctrlKey?: boolean; href?: string | null } = {};
        document.addEventListener("click", event => {
          result.defaultPrevented = event.defaultPrevented;
          result.ctrlKey = event.ctrlKey;
          result.href = (event.target as Element).closest<HTMLAnchorElement>("a[href]")?.href ?? null;
          event.preventDefault();
        }, { once: true });
        return result;
      });
      await edit.click({ modifiers: ["Control"] });
      expect(await activation.jsonValue()).toEqual({
        defaultPrevented: false, ctrlKey: true, href: new URL("/content/pages/home/edit", page.url()).href,
      });
      await activation.dispose();
    }
    await expect(actions).toBeHidden();
    await expect(more).toBeFocused();
    await expect(row.getByRole("link", { name: "Edit page draft: Home", exact: true })).toBeVisible();
  }
  expect(editorNavigationRequests).toBe(0);
  expect(popupRequests.length).toBeGreaterThanOrEqual(1);
  const unexpectedOrigins = popupRequests.filter(request => !mockedPublicRequests.has(request))
    .map(request => new URL(request.url()).hostname)
    .filter(hostname => hostname !== "127.0.0.1" && hostname !== "localhost");
  expect(unexpectedOrigins).toEqual([]);
});

// One rail case on each side of the 720px browse reflow; both return to phone.
for (const width of [620, 800]) {
  test(`shared rail remains reachable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/gallery.html?embed=browsing-family-shell&family=directory&presentation=icons&guide=1");
    const collapse = page.getByRole("button", { name: "Collapse primary navigation", exact: true });
    await expect(collapse).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary", exact: true })).toBeVisible();
    await collapse.click();
    await expect(page.getByRole("button", { name: "Expand primary navigation", exact: true })).toBeVisible();
    const finder = page.locator(".sidebar").getByRole("button", { name: "Find a workspace", exact: true });
    await finder.click();
    await expect(page.getByRole("dialog", { name: "Find a workspace", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(finder).toBeFocused();
    await page.setViewportSize({ width: 390, height: 800 });
    const phoneFinder = page.locator(".browse-workspace-find").getByRole("button", { name: "Find a workspace", exact: true });
    await expect(phoneFinder).toBeVisible();
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Find a workspace", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(phoneFinder).toBeFocused();
  });
}

for (const tab of ["images", "voiceovers"]) {
  test(`${tab} keeps flat inset chrome and responds after direct-load portal placement`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    let documentNavigations = 0;
    page.on("framenavigated", frame => {
      if (frame === page.mainFrame()) documentNavigations++;
    });
    await page.goto(`/gallery.html?embed=browsing-family-shell&family=media&tab=${tab}&presentation=icons&guide=1`);
    const chrome = page.locator(".workspace-browse-toolbar .media-chrome");
    const toolbar = page.getByRole("toolbar", { name: "Library controls", exact: true });
    await expect(toolbar).toBeVisible();
    const search = toolbar.getByRole("searchbox");
    if (await search.count()) await search.fill("fixture draft");
    for (const width of [1440, 390, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(chrome).toHaveCSS("padding-left", width === 390 ? "12px" : "20px");
      await expect(chrome).toHaveCSS("box-shadow", "none");
      await expect(chrome).toHaveCSS("backdrop-filter", "none");
      expect((await toolbar.boundingBox())!.x - (await chrome.boundingBox())!.x).toBe(width === 390 ? 12 : 20);
      if (width === 390) await expect(chrome).toHaveClass(/media-chrome-compact/);
      else await expect(chrome).not.toHaveClass(/media-chrome-compact/);
      if (await search.count()) await expect(search).toHaveValue("fixture draft");
      const host = page.locator(".media-workspace > section").first();
      await expect.poll(() => host.evaluate(node => node.style.getPropertyValue("--media-chrome-height"))).toBe("0px");
      const shellChrome = page.locator(".workspace-chrome");
      await expect.poll(() => page.locator(".workspace-shell").evaluate(node => Number.parseFloat(getComputedStyle(node).getPropertyValue("--workspace-header-height"))))
        .toBeCloseTo((await shellChrome.boundingBox())!.height, 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await page.setViewportSize({ width, height: 390 });
      await expect(chrome).toHaveCSS("display", "grid");
      await expect(toolbar).toHaveCSS("padding-left", "0px");
      await expect(toolbar).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(chrome.locator(".media-toolbar-filter .button-compact-label")).toBeVisible();
      if (tab !== "favorites" && tab !== "collections") {
        await expect(chrome.locator(".media-toolbar-upload .button-compact-label")).toBeVisible();
      }
      for (const label of await chrome.locator(":is(.media-toolbar-filter, .media-toolbar-upload) .button-compact-label").all()) {
        await expect(label).toHaveCSS("clip-path", "none");
        await expect(label).toHaveCSS("position", "static");
        expect((await label.boundingBox())!.width).toBeGreaterThan(20);
      }
      if (tab === "favorites" || tab === "collections") {
        const upload = page.locator(".workspace-browse-toolbar").getByRole("button", { name: "Upload media", exact: true });
        await expect(upload.locator(".button-compact-label")).toBeVisible();
        await expect(upload.locator(".button-compact-label")).toHaveCSS("clip-path", "none");
        await expect(upload.locator(".button-compact-label")).toHaveCSS("position", "static");
        expect((await upload.boundingBox())!.height).toBe(36);
        const bar = (await page.locator(".workspace-browse-toolbar").boundingBox())!;
        const action = (await upload.boundingBox())!;
        expect(action.x + action.width).toBeLessThanOrEqual(bar.x + bar.width - (width === 390 ? 12 : 20));
      }
    }
    // Images search starts the meaning worker. Its dependencies must not reload
    // either document while the next direct-load tab's toolbar is being exercised.
    expect(documentNavigations).toBe(1);
    if (tab === "favorites" || tab === "collections") {
      const chooserPromise = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "Upload media", exact: true }).click();
      const chooser = await chooserPromise;
      expect(chooser.isMultiple()).toBe(true);
      await chooser.setFiles([]);
    }
  });
}

for (const tab of ["favorites", "collections"]) {
  test(`${tab} native command order stays main then Upload when its panel mounts later`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/gallery.html?embed=browsing-family-shell&family=media&tab=${tab}&deferPanel=1&presentation=icons&guide=1`);
    const upload = page.locator(".workspace-browse-trailing").getByRole("button", { name: "Upload media", exact: true });
    await expect(upload).toBeVisible();
    await expect(page.getByRole("toolbar", { name: "Library controls", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Load media fixture", exact: true }).click();
    await expect(page.getByRole("toolbar", { name: "Library controls", exact: true })).toBeVisible();
    for (const width of [1280, 390, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      const chrome = page.locator(".workspace-browse-main .media-chrome");
      if (width === 390) await expect(chrome).toHaveClass(/media-chrome-compact/);
      else await expect(chrome).not.toHaveClass(/media-chrome-compact/);
      const lastMain = page.locator(".workspace-browse-main").locator("button:visible:not(:disabled), input:visible:not(:disabled), select:visible:not(:disabled), a[href]:visible").last();
      await lastMain.focus();
      await expect(lastMain).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(upload).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(lastMain).toBeFocused();
    }
  });
}

test("sticky Library commands focus their body forms below wrapped chrome", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/gallery.html?embed=browsing-family-shell&family=library&presentation=text&guide=1");
  await page.evaluate(() => window.scrollTo(0, 600));
  await page.getByRole("button", { name: "Save current view", exact: true }).click();
  const name = page.getByRole("textbox", { name: "View name", exact: true });
  await expect(name).toBeFocused();
  await expect.poll(async () => (await name.boundingBox())!.y).toBeGreaterThanOrEqual((await page.locator(".workspace-chrome").boundingBox())!.height);
  await page.locator(".content-library-save-view").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save current view", exact: true })).toBeFocused();
  await page.evaluate(() => window.scrollTo(0, 600));
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  const first = page.getByRole("group", { name: "Content type", exact: true }).getByRole("checkbox").first();
  await expect(first).toBeFocused();
  await expect.poll(async () => (await first.boundingBox())!.y).toBeGreaterThanOrEqual((await page.locator(".workspace-chrome").boundingBox())!.height);
});

test("successful local saved view returns to the enabled sticky trigger", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/gallery.html?embed=browsing-family-shell&family=library&presentation=text&guide=1");
  const trigger = page.getByRole("button", { name: "Save current view", exact: true });
  await trigger.click();
  const name = page.getByRole("textbox", { name: "View name", exact: true });
  await name.fill("Local browsing focus fixture");
  await name.press("Enter");
  await expect(name).toBeHidden();
  await expect(trigger).toBeEnabled();
  await expect(trigger).toBeFocused();
});

test("local upload receipt focus clears the measured shared media bars", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 500 });
  await page.goto("/gallery.html?embed=browsing-family-shell&family=media&presentation=text&guide=1");
  await expect(page.getByRole("grid", { name: "Images", exact: true })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 500));
  await page.getByRole("button", { name: "Upload media", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Upload media", exact: true });
  await sheet.getByLabel(/^Files \(25 MB maximum each\)/).setInputFiles({
    name: "local-receipt.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6S2kAAAAASUVORK5CYII=", "base64"),
  });
  await sheet.getByRole("textbox", { name: "License", exact: true }).fill("NJ PBS owned");
  await sheet.getByRole("button", { name: "Upload", exact: true }).click();
  const receipt = page.getByText("Media uploaded", { exact: true }).locator("xpath=ancestor::div[@tabindex='-1'][1]");
  await expect(receipt).toBeFocused();
  await expect.poll(async () => (await receipt.boundingBox())!.y)
    .toBeGreaterThanOrEqual((await page.locator(".workspace-chrome").boundingBox())!.height);
});

test("Finder keeps the same open query across phone and rail placement changes", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/gallery.html?embed=browsing-family-shell&family=directory&presentation=icons&guide=1");
  const phone = page.locator(".browse-workspace-find").getByRole("button", { name: "Find a workspace", exact: true });
  await phone.click();
  const input = page.getByRole("dialog", { name: "Find a workspace", exact: true }).getByRole("searchbox");
  await input.fill("Pages");
  const node = await input.elementHandle();
  await page.setViewportSize({ width: 800, height: 900 });
  await expect(input).toHaveValue("Pages");
  expect(await node!.evaluate(element => element.isConnected)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Help and reporting", exact: true })).toBeFocused();
  const rail = page.locator(".sidebar").getByRole("button", { name: "Find a workspace", exact: true });
  await rail.click();
  await page.setViewportSize({ width: 390, height: 800 });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Help and reporting", exact: true })).toBeFocused();
});

for (const touch of [false, true]) {
  test.describe(touch ? "coarse media options" : "fine media options", () => {
    test.use({ hasTouch: touch });
    test("each segmented radio owns its full target and keeps native arrow selection", async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 800 });
      await page.goto("/gallery.html?embed=media-display-popover&presentation=text&guide=1");
      const options = page.locator('.ui-segmented[data-control-size="standard"] .ui-segmented-option');
      await expect(options.first()).toBeVisible();
      const target = touch ? 44 : 36;
      for (const option of await options.all()) {
        expect((await option.boundingBox())!.height).toBeGreaterThanOrEqual(target);
        expect((await option.locator("input").boundingBox())!.height).toBeGreaterThanOrEqual(target);
      }
      const group = page.getByRole("radiogroup").first();
      const radios = group.getByRole("radio");
      await radios.first().focus();
      await page.keyboard.press("ArrowRight");
      await expect(radios.nth(1)).toBeChecked();
    });
  });
}

for (const coarse of [false, true]) {
  test.describe(coarse ? "coarse browse row actions" : "fine browse row actions", () => {
    test.use({ hasTouch: coarse });
    test("queue keeps a compact native Open draft action and leaves immutable jobs alone", async ({ page }) => {
      // Desktop table and the minimum-width phone card; keep both pointer modes.
      for (const width of [1440, 320]) {
        const goto = page.goto.bind(page);
        page.goto = (url, options) => goto(`${url}&family=queue&guide=1`, options);
        try {
          await openSpecimen(page, { id: "browsing-family-shell", title: "Queue", width, presentation: "icons" }, { normalizeGeneratedIds: false });
        } finally { page.goto = goto; }
        const table = page.getByRole("table", { name: "Review requests", exact: true });
        const title = table.locator("td.content-title a").first();
        const row = title.locator("xpath=ancestor::tr");
        const draft = row.locator(".browse-row-edit");
        await expect(draft).toHaveText("Open draft");
        await expect(draft).toHaveAttribute("href", (await title.getAttribute("href"))!);
        const box = (await draft.boundingBox())!;
        const frame = (await table.locator('xpath=ancestor::div[contains(@class,"table-frame")][1]').boundingBox())!;
        expect(box.height).toBe(coarse ? 44 : 32);
        expect(box.x).toBeGreaterThanOrEqual(frame.x);
        expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width);
        await expect(page.getByRole("table", { name: "Publish activity", exact: true }).locator(".browse-row-edit")).toHaveCount(0);
      }
    });
    test("saved-view delete stays attached with its own named target", async ({ page }) => {
      const goto = page.goto.bind(page);
      page.goto = (url, options) => goto(`${url}&family=library&guide=1`, options);
      try {
        await openSpecimen(page, { id: "browsing-family-shell", title: "Library", width: 1440, presentation: "icons" }, { normalizeGeneratedIds: false });
      } finally { page.goto = goto; }
      const remove = page.getByRole("button", { name: "Delete saved view Review queue", exact: true });
      await remove.scrollIntoViewIfNeeded();
      const view = remove.locator("xpath=parent::*").getByRole("button", { name: "Review queue", exact: true });
      const target = (await remove.boundingBox())!;
      const tab = (await view.boundingBox())!;
      expect(target.height).toBe(coarse ? 44 : 32);
      expect(target.width).toBe(coarse ? 44 : 32);
      expect(Math.abs(target.x - (tab.x + tab.width))).toBeLessThan(1);
    });
  });
}
