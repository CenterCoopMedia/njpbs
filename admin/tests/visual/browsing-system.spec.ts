import { expect, test, type Locator } from "./fixtures";
import { freezeClock, openSpecimen, waitForFonts } from "./capture";

async function settledRowBackground(row: Locator) {
  return row.evaluate(async element => {
    await Promise.all(element.getAnimations().map(animation => animation.finished));
    return getComputedStyle(element).backgroundColor;
  });
}

for (const pointer of ["fine", "coarse"] as const) {
  test.describe(`${pointer} audio state geometry`, () => {
    test.use({ hasTouch: pointer === "coarse" });
    for (const presentation of ["icons", "text"] as const) {
      test(`Favorite stays clear of audio actions with ${presentation} controls`, async ({ page }) => {
        await openSpecimen(page, { id: "audio-library", title: "Audio", width: 320, presentation }, { normalizeGeneratedIds: false });
        expect(await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches)).toBe(pointer === "coarse");
        const tile = page.locator('.media-tile[data-kind="audio"]').filter({ has: page.getByRole("button", { name: /^Station identification, audio/ }) });
        const badge = tile.locator(".media-tile-badge-favorite");
        const more = tile.getByRole("button", { name: /^More actions:/ });
        for (const narrow of [false, true]) {
          if (narrow) await tile.evaluate(element => { element.style.maxWidth = "160px"; });
          await expect(badge).toBeVisible();
          await expect(badge).toHaveText("Favorite");
          const state = (await badge.boundingBox())!;
          const header = (await tile.locator(".media-tile-thumb").boundingBox())!;
          for (const control of [tile.locator(".media-tile-mark"), tile.locator(".media-tile-actions"), tile.locator(".media-tile-document > .icon")]) {
            const box = (await control.boundingBox())!;
            expect(state.y).toBeGreaterThanOrEqual(box.y + box.height + 3);
          }
          expect(state.x).toBeGreaterThanOrEqual(header.x);
          expect(state.x + state.width).toBeLessThanOrEqual(header.x + header.width);
          expect((await more.boundingBox())!.height).toBe(pointer === "coarse" ? 44 : 32);
        }
        await more.click();
        await expect(page.getByRole("menuitem", { name: "Remove from favorites", exact: true })).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(more).toBeFocused();
        await expect(tile.getByRole("button", { name: "Listen to Station identification", exact: true })).toBeVisible();
        await expect(tile).toContainText("soft-spoken");
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
      });
    }
  });
}

for (const presentation of ["icons", "text"] as const) {
  test(`320px library keeps native row overflow reachable with ${presentation} controls`, async ({ page }) => {
    await openSpecimen(page, { id: "content-library", title: "All content", width: 320, presentation }, { normalizeGeneratedIds: false });
    const frame = page.locator(".content-browse-frame");
    const title = page.getByRole("link", { name: "Transit funding explained", exact: true });
    const row = title.locator("xpath=ancestor::tr");
    const more = row.getByRole("button", { name: "Transit funding explained actions", exact: true });
    // Keep each complete row inside the phone frame.
    expect(await frame.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false);
    await title.focus();
    const initialScroll = await frame.evaluate(element => element.scrollLeft);
    // Both actions are already visible; the added Edit link precedes More in native order.
    const edit = row.locator(".browse-row-primary .browse-row-edit");
    const initialEdit = (await edit.boundingBox())!;
    const initialFrame = (await frame.boundingBox())!;
    expect(initialEdit.x).toBeGreaterThanOrEqual(initialFrame.x);
    expect(initialEdit.x + initialEdit.width).toBeLessThanOrEqual(initialFrame.x + initialFrame.width);
    await title.press("Tab");
    await expect(edit).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(more).toBeFocused();
    expect(await frame.evaluate(element => element.scrollLeft)).toBe(initialScroll);
    const outer = (await frame.boundingBox())!;
    const target = (await more.boundingBox())!;
    expect(target.x).toBeGreaterThanOrEqual(outer.x);
    expect(target.x + target.width).toBeLessThanOrEqual(outer.x + outer.width);
    await more.press("Enter");
    const actions = page.getByRole("dialog", { name: "Transit funding explained actions", exact: true });
    await expect(actions.getByRole("link", { name: "Edit Transit funding explained", exact: true }))
      .toHaveAttribute("href", (await title.getAttribute("href"))!);
    await expect(actions.getByRole("button", { name: "Show details for Transit funding explained", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(more).toBeFocused();
    await more.press("Shift+Tab");
    await expect(edit).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(title).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  });
}

for (const width of [390, 1280]) {
  test(`Pages search keeps a same-frame type-then-clear edit at ${width}px`, async ({ page }) => {
    await openSpecimen(page, { id: "page-directory", title: "Directory", width, presentation: "text" }, { normalizeGeneratedIds: false });
    await page.getByRole("button", { name: "Home actions", exact: true }).click();
    await page.getByRole("dialog", { name: "Home actions", exact: true }).getByRole("button", { name: "Show details for Home", exact: true }).click();
    const search = page.getByRole("searchbox", { name: "Search pages" });
    await search.focus();
    const edits = await search.evaluate((element: HTMLInputElement) => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(element, "donate");
      element.dispatchEvent(new Event("input", { bubbles: true }));
      const typed = element.value;
      setValue.call(element, "");
      element.dispatchEvent(new Event("input", { bubbles: true }));
      return { typed, cleared: element.value };
    });
    expect(edits).toEqual({ typed: "donate", cleared: "" });
    await expect(search).toHaveValue("");
    await expect(page.getByRole("region", { name: "Home details" })).toBeVisible();
  });
}

test("directory adopts fine-pointer controls without turning expanded details into selection", async ({ page }) => {
  await openSpecimen(page, { id: "page-directory", title: "Directory", width: 1280, presentation: "icons" }, { normalizeGeneratedIds: false });
  const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: "Edit page draft: Home", exact: true }) });
  const edit = row.getByRole("link", { name: "Edit draft", exact: true });
  expect((await edit.boundingBox())!.height).toBe(32);
  const details = row.getByRole("button", { name: /^(Show|Hide) details for Home$/ });
  expect((await details.boundingBox())!.height).toBe(32);
  await expect(details).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await details.focus();
  await expect(row.locator(".browse-row-inline")).toHaveCSS("opacity", "1");
  await details.press("Enter");
  await expect(details).toHaveAttribute("aria-expanded", "true");
  await expect(row).not.toHaveAttribute("data-selected");
  await expect(page.getByRole("region", { name: "Home details" })).toBeVisible();
  await row.hover();
  expect(await settledRowBackground(row)).toBe("rgb(237, 241, 246)");
  await page.getByRole("searchbox", { name: "Search pages" }).fill("donate");
  await page.getByRole("searchbox", { name: "Search pages" }).fill("");
  await expect(details).toHaveAttribute("aria-expanded", "true");
});

test("table selection survives hover and keeps its own edge independently of keyboard focus", async ({ page }) => {
  await openSpecimen(page, { id: "content-library", title: "All content", width: 1280, presentation: "text" }, { normalizeGeneratedIds: false });
  const mark = page.getByRole("checkbox", { name: "Select Transit funding explained", exact: true });
  const row = page.getByRole("row").filter({ has: mark });
  await mark.check();
  await row.hover();
  expect(await settledRowBackground(row)).toBe("rgb(233, 237, 255)");
  // #2638c4 is the approved study's brand edge, independent of the selected wash.
  await expect(row.locator("td").first()).toHaveCSS("box-shadow", "rgb(38, 56, 196) 2px 0px 0px 0px inset");
  await mark.focus();
  await expect(mark).toBeFocused();
  await expect(mark).toBeChecked();
  await row.getByRole("button", { name: "Transit funding explained actions", exact: true }).click();
  await page.getByRole("dialog", { name: "Transit funding explained actions", exact: true })
    .getByRole("button", { name: "Show details for Transit funding explained", exact: true }).click();
  await expect(mark).toBeChecked();
  await expect(row).toHaveAttribute("data-expanded", "true");
  await row.hover();
  expect(await settledRowBackground(row)).toBe("rgb(233, 237, 255)");
});

test.describe("coarse browse states", () => {
  test.use({ hasTouch: true });
  test("coarse browse selection retains its fill and keyboard focus reaches striped rows", async ({ page }) => {
    await openSpecimen(page, { id: "content-library", title: "All content", width: 390, presentation: "text" }, { normalizeGeneratedIds: false });
    const mark = page.getByRole("checkbox", { name: "Select Transit funding explained", exact: true });
    const row = page.getByRole("row").filter({ has: mark });
    await mark.check(); await row.hover();
    expect(await page.evaluate(() => matchMedia("(hover: hover)").matches)).toBe(false);
    expect(await settledRowBackground(row)).toBe("rgb(233, 237, 255)");
    const bounds = (await mark.boundingBox())!;
    expect(bounds.width).toBeGreaterThanOrEqual(44);
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    const even = page.locator(".content-library .browse-table > tbody > .content-index-row").nth(1);
    await page.keyboard.press("Tab");
    await even.getByRole("checkbox").focus();
    expect(await settledRowBackground(even)).toBe("rgb(248, 249, 251)");
  });
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`forced-color browse selection retains its outline and native focus in ${colorScheme}`, async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active", colorScheme });
    await openSpecimen(page, { id: "content-library", title: "All content", width: 1280, presentation: "text" }, { normalizeGeneratedIds: false });
    const mark = page.getByRole("checkbox", { name: "Select Transit funding explained", exact: true });
    const row = page.getByRole("row").filter({ has: mark });
    await mark.focus(); await mark.press("Space");
    await row.hover(); await settledRowBackground(row);
    await expect(mark).toBeChecked();
    await expect(mark).toBeFocused();
    await expect(row).toHaveCSS("outline-style", "solid");
    await expect(row).toHaveCSS("outline-width", "2px");
    await mark.press("Space");
    await expect(mark).not.toBeChecked();
    await expect(row).not.toHaveAttribute("data-selected");
  });
}

test("phone text preference keeps selection action words and clears space for the measured dock", async ({ page }) => {
  await openSpecimen(page, { id: "media-grid-keyboard", title: "Media selection", width: 390, presentation: "text" }, { normalizeGeneratedIds: false });
  const grid = page.getByRole("grid", { name: "Images" });
  await grid.getByRole("checkbox").first().check();
  const bar = page.getByRole("group", { name: "Collection selection", exact: true });
  await expect(bar).toHaveAttribute("data-presentation", "text");
  for (const label of ["Add to favorites", "Remove from favorites", "Add to collection", "Clear selection"]) {
    const action = bar.getByRole("button", { name: label, exact: true });
    await expect(action.locator(".media-selection-bar-label")).toBeVisible();
    const box = (await action.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(await action.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await expect.poll(() => grid.locator(".media-grid-cell").first().evaluate(element =>
    Number.parseFloat(getComputedStyle(element).scrollMarginBottom))).toBeGreaterThan((await bar.boundingBox())!.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await bar.getByRole("button", { name: "Clear selection", exact: true }).click();
  await expect(bar).toBeHidden();
  await expect(grid).not.toHaveAttribute("data-selection-mode");
});

test("queue refresh keeps its text footprint and failed reads recover independently", async ({ page }) => {
  await freezeClock(page);
  await page.setViewportSize({ width: 390, height: 800 });
  const url = "/gallery.html?embed=browsing-workflow-states&family=queue&presentation=text&state=";
  await page.goto(`${url}ready`);
  await expect(page.getByRole("heading", { name: "Editorial queue", exact: true })).toBeVisible();
  await waitForFonts(page);
  const idleWidth = (await page.getByRole("button", { name: "Refresh review requests", exact: true }).boundingBox())!.width;
  await page.goto(`${url}loading`);
  const pending = page.getByRole("button", { name: /^Refresh review requests: Refreshing review requests$/ });
  await expect(pending).toHaveAttribute("aria-busy", "true");
  await waitForFonts(page);
  expect((await pending.boundingBox())!.width).toBe(idleWidth);
  await expect(pending).toBeDisabled();
  await page.goto(`${url}error`);
  const reviewFailure = page.getByText("Editorial queue could not be loaded", { exact: true });
  const publishFailure = page.getByText("Publish activity could not be loaded", { exact: true });
  await expect(reviewFailure).toBeVisible();
  await expect(publishFailure).toBeVisible();
  await page.getByRole("button", { name: "Try loading the editorial queue again" }).click();
  await expect(reviewFailure).toBeHidden();
  await expect(publishFailure).toBeVisible();
  await expect(page.getByRole("table", { name: "Review requests" })).toBeVisible();
});

test("real media focus clears a tall text selection dock and releases its measured margin on clear", async ({ page }) => {
  await page.route("**/cmsListMediaFavorites", async route => {
    const query = route.request().postDataJSON();
    await route.fulfill({ json: { success: true, states: (query.refs ?? []).map((ref: unknown) => ({ ref, favorite: false })) } });
  });
  await freezeClock(page);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/gallery.html?embed=media-browsing&presentation=text&guide=1");
  const grid = page.getByRole("grid", { name: "Images" });
  await expect(grid).toBeVisible();
  await waitForFonts(page);
  await grid.getByRole("checkbox").first().check();
  const dock = page.locator(".media-selection-dock");
  const host = page.locator(".media-results");
  await expect(dock).toBeVisible();
  expect((await dock.boundingBox())!.height).toBeGreaterThan(96);
  const last = grid.locator(".media-tile").last();
  const open = last.locator("[data-media-open]");
  await expect.poll(() => open.evaluate(element => Number.parseFloat(getComputedStyle(element).scrollMarginBottom)))
    .toBeGreaterThan((await dock.boundingBox())!.height);
  await open.focus();
  await page.keyboard.press("Tab");
  const mark = last.getByRole("checkbox");
  await expect(mark).toBeFocused();
  await expect.poll(async () => (await mark.boundingBox())!.y + (await mark.boundingBox())!.height)
    .toBeLessThanOrEqual((await dock.boundingBox())!.y);
  await dock.getByRole("button", { name: "Clear selection", exact: true }).click();
  await expect(dock).toBeHidden();
  await expect.poll(() => host.evaluate(element => element.style.getPropertyValue("--media-selection-bar-height"))).toBe("");
});


test("pager focus clears the same measured selection dock as grid controls", async ({ page }) => {
  await page.route("**/cmsListMediaFavorites", async route => {
    const query = route.request().postDataJSON();
    await route.fulfill({ json: { success: true, states: (query.refs ?? []).map((ref: unknown) => ({ ref, favorite: false })) } });
  });
  await openSpecimen(page, { id: "media-indexed-library", title: "Media pages", width: 390, presentation: "text" }, { normalizeGeneratedIds: false });
  await page.setViewportSize({ width: 390, height: 500 });
  await page.getByRole("grid", { name: "Images", exact: true }).getByRole("checkbox").first().check();
  const dock = page.locator(".media-selection-dock");
  const next = page.getByRole("navigation", { name: "Media pages", exact: true }).getByRole("button", { name: "Next page", exact: true });
  await expect(next).toBeEnabled();
  await expect.poll(() => next.evaluate(element => parseFloat(getComputedStyle(element).scrollMarginBottom)))
    .toBeGreaterThan((await dock.boundingBox())!.height);
  await next.focus();
  await expect(next).toBeFocused();
  expect((await next.boundingBox())!.y + (await next.boundingBox())!.height).toBeLessThanOrEqual((await dock.boundingBox())!.y);
  await dock.getByRole("button", { name: "Clear selection", exact: true }).click();
  await expect(dock).toBeHidden();
  await expect.poll(() => next.evaluate(element => parseFloat(getComputedStyle(element).scrollMarginBottom))).toBe(0);
});

test.describe("coarse pointer adoption", () => {
  test.use({ hasTouch: true });
  test("keeps 44px directory and publication targets", async ({ page }) => {
    for (const id of ["page-directory", "queue"]) {
      await openSpecimen(page, { id, title: id, width: 390, presentation: "icons" }, { normalizeGeneratedIds: false });
      expect(await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches)).toBe(true);
      const control = id === "queue" ? page.getByRole("button", { name: /^Details: Publication job / }).first()
        : page.getByRole("button", { name: "Home actions", exact: true });
      const box = (await control.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      const row = control.locator("xpath=ancestor::tr[1]");
      await row.hover();
      await expect(row).toHaveCSS("background-color", "rgb(255, 255, 255)");
    }
  });
});

for (const coarse of [false, true]) {
  test.describe(`${coarse ? 'coarse' : 'fine'} final phone browsing geometry`, () => {
    test.use({ hasTouch: coarse });
    for (const width of [320, 390]) {
      test(`${width}px rows never overflow their own width or the browse frame`, async ({ page }) => {
        for (const id of ['page-directory', 'record-list', 'content-library']) {
          await openSpecimen(page, { id, title: id, width, presentation: 'text' }, { normalizeGeneratedIds: false });
          const rows = await page.locator('.content-index-row:not([hidden])').evaluateAll(elements => elements.map(row => ({
            name: row.textContent, width: row.clientWidth, scroll: row.scrollWidth, box: row.getBoundingClientRect().toJSON(),
          })));
          expect(rows.length, id).toBeGreaterThan(0);
          for (const row of rows) {
            expect(row.scroll, `${id}: ${row.name}`).toBeLessThanOrEqual(row.width);
            expect(row.box.x, id).toBeGreaterThanOrEqual(0);
            expect(row.box.x + row.box.width, id).toBeLessThanOrEqual(width);
          }
          expect(await page.evaluate(() => document.documentElement.scrollWidth), id).toBe(width);
        }
      });

      test(`${width}px text selection actions use the same rows for every count`, async ({ page }) => {
        await openSpecimen(page, { id: 'media-selection-bar', title: 'Selection', width, presentation: 'text' }, { normalizeGeneratedIds: false });
        const bars = page.locator('.media-selection-bar');
        await expect(bars).toHaveCount(4);
        for (const bar of await bars.all()) {
          const summary = (await bar.locator('.media-selection-bar-summary').boundingBox())!;
          const pageMark = (await bar.getByRole('checkbox').locator('xpath=..').boundingBox())!;
          const actions = await bar.locator('.media-selection-bar-action').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
          expect(actions.length).toBeGreaterThan(0);
          expect(actions[0].y).toBeGreaterThanOrEqual(Math.max(summary.y + summary.height, pageMark.y + pageMark.height));
          for (let index = 1; index < actions.length; index++) {
            expect(actions[index].y).toBeGreaterThanOrEqual(actions[index - 1].y + actions[index - 1].height);
            expect(Math.abs(actions[index].x - actions[0].x)).toBeLessThan(0.5);
            expect(Math.abs(actions[index].width - actions[0].width)).toBeLessThan(0.5);
          }
        }
      });

      test(`${width}px enlarged titles remain clear of native row actions`, async ({ page }) => {
        for (const id of ['page-directory', 'record-list', 'content-library']) {
          await openSpecimen(page, { id, title: id, width, presentation: 'text' }, { normalizeGeneratedIds: false });
          await page.addStyleTag({ content: 'html { font-size:200%; }' });
          await expect(page.locator('html')).toHaveCSS('font-size', '32px');
          await page.evaluate(async () => { await document.fonts.ready; });
          await expect.poll(async () => page.locator('.content-index-row:not([hidden])').evaluateAll(rows => rows.every(row => {
            const title = row.querySelector('.content-index-title-link');
            const actions = row.querySelector('.browse-row-actions');
            if (!title || !actions) return true;
            const a = title.getBoundingClientRect(), b = actions.getBoundingClientRect();
            return a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
          })), { message: `${id}: enlarged native title and action pair must not overlap` }).toBe(true);
          const overflows = await page.locator('.content-index-row:not([hidden])').evaluateAll(rows => rows.filter(row => row.scrollWidth > row.clientWidth).length);
          expect(overflows, id).toBe(0);
          expect(await page.evaluate(() => document.documentElement.scrollWidth), id).toBe(width);
        }
      });
    }
    // These Library layouts share one phone mode below 720px.
    // Keep its narrowest viewport; retain both widths above for directory wrapping.
    const width = 320;

    test(`${width}px Library keeps the real select-all target visible and usable`, async ({ page }) => {
      await openSpecimen(page, { id: 'content-library', title: 'Library', width, presentation: 'text' }, { normalizeGeneratedIds: false });
      const all = page.getByRole('checkbox', { name: 'Select all eligible records on this page', exact: true });
      const mark = all.locator('xpath=..').locator('.ui-checkbox-box');
      const bar = (await page.locator('thead').boundingBox())!;
      const card = (await page.locator('tbody .content-index-row').first().boundingBox())!;
      expect(Math.abs(bar.x - card.x)).toBeLessThan(0.5);
      expect(Math.abs(bar.width - card.width)).toBeLessThan(0.5);
      await all.focus();
      await expect(all).toBeFocused();
      await expect(mark).toBeInViewport({ ratio: 1 });
      expect(await mark.evaluate(element => {
        const box = element.getBoundingClientRect();
        return element.closest('label')!.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      })).toBe(true);
      await all.check();
      const states = await page.locator('tbody input[type="checkbox"]:not(:disabled)').evaluateAll(elements => elements.map(element => (element as HTMLInputElement).checked));
      expect(states.length).toBeGreaterThan(0);
      expect(states.every(Boolean)).toBe(true);
      await all.uncheck();
      const cleared = await page.locator('tbody input[type="checkbox"]:not(:disabled)').evaluateAll(elements => elements.every(element => !(element as HTMLInputElement).checked));
      expect(cleared).toBe(true);
    });

    test(`${width}px readonly Library uses its full card width without a phantom selection column`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/gallery.html?embed=browsing-workflow-states&family=library&state=readonly&presentation=text&guide=1');
      const rows = page.locator('.content-library .content-index-row:not([hidden])');
      await expect(rows.first()).toBeVisible();
      await page.evaluate(async () => { await document.fonts.ready; });
      await expect(rows.locator('.content-library-select-cell')).toHaveCount(0);
      const geometry = await rows.evaluateAll(elements => elements.map(row => {
        const box = row.getBoundingClientRect(), title = row.querySelector('.content-title')!.getBoundingClientRect();
        return { titleLeft: title.left, edge: box.left + parseFloat(getComputedStyle(row).paddingLeft), width: row.clientWidth, scroll: row.scrollWidth };
      }));
      for (const row of geometry) {
        expect(Math.abs(row.titleLeft - row.edge)).toBeLessThan(0.5);
        expect(row.scroll).toBeLessThanOrEqual(row.width);
      }
    });

    for (const { width, scale } of [{ width: 430, scale: 150 }, { width: 600, scale: 200 }]) {
      test(`${width}px at ${scale}% text keeps every directory and record action clear of its title`, async ({ page }) => {
        for (const id of ['page-directory', 'record-list']) {
          await openSpecimen(page, { id, title: id, width, presentation: 'text' }, { normalizeGeneratedIds: false });
          await page.addStyleTag({ content: `html { font-size:${scale}%; }` });
          await expect(page.locator('html')).toHaveCSS('font-size', `${16 * scale / 100}px`);
          await page.evaluate(async () => { await document.fonts.ready; });
          await expect.poll(() => page.locator('.content-index-row:not([hidden])').evaluateAll(rows => rows.every(row => {
            const title = row.querySelector('.content-index-title-link'), actions = row.querySelector('.browse-row-actions');
            if (!title || !actions) return true;
            const a = title.getBoundingClientRect(), b = actions.getBoundingClientRect();
            return row.scrollWidth <= row.clientWidth && (a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
          })), { message: id }).toBe(true);
        }
      });
    }

  });
}
