import { expect, test, type Page } from "./fixtures";

async function openCollectionList(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/gallery.html?embed=media-collections-detail&presentation=text");
  const grid = page.getByRole("grid", { name: "Collection media" });
  await expect(grid.getByRole("button", { name: "Unavailable item", exact: true })).toBeVisible();
  await page.getByRole("toolbar", { name: "Library controls" })
    .getByRole("button", { name: "Display", exact: true }).click();
  await page.getByRole("dialog", { name: "Display" }).getByRole("radio", { name: "List" }).click();
  await page.keyboard.press("Escape");
  await expect(grid).toHaveAttribute("data-layout", "list");
  await page.evaluate(() => document.fonts.ready);
  return grid;
}

// Refs #3591: unavailable references share the available rows' compact selection
// geometry, with the existing 44px coarse-pointer target and native selection.
for (const touch of [false, true]) {
  test.describe(touch ? "Coarse pointer" : "Fine pointer", () => {
    test.use({ hasTouch: touch });

    for (const width of [320, 1280]) {
      test(`Unavailable Collection selection aligns at ${width}px`, async ({ page }, testInfo) => {
        const grid = await openCollectionList(page, width);

        const row = grid.getByRole("row", { name: /Unavailable item/ });
        const mark = row.getByRole("checkbox", { name: "Select unavailable collection item" });
        await expect(row).toContainText("This collection reference is no longer available to your account.");
        await expect(mark).toBeEnabled();
        await expect(mark).not.toBeChecked();
        const geometry = await row.evaluate(element => {
          const label = element.querySelector(".ui-checkbox")!;
          const target = label.getBoundingClientRect();
          const box = label.querySelector(".ui-checkbox-box")!.getBoundingClientRect();
          const cell = element.querySelector(".media-row-mark-cell")!.getBoundingClientRect();
          const peer = document.querySelector('.media-row:not([data-unavailable], .media-row-header) .ui-checkbox')!
            .getBoundingClientRect();
          const more = element.querySelector(".ui-menu-trigger")!.getBoundingClientRect();
          return {
            target: { x: target.x, width: target.width, height: target.height },
            box: { width: box.width, height: box.height },
            cell: { x: cell.x, width: cell.width },
            peer: { x: peer.x, width: peer.width, height: peer.height },
            more: { x: more.x, width: more.width, height: more.height },
            peerMore: [...document.querySelectorAll('.media-row:not([data-unavailable], .media-row-header) .media-row-more')]
              .map(button => { const rect = button.getBoundingClientRect();
                return { x: rect.x, width: rect.width, height: rect.height }; }),
            offset: box.x + box.width / 2 - (target.x + target.width / 2),
            coarse: matchMedia("(pointer: coarse)").matches,
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            actionGap: more.left - element.querySelector(".media-row-main")!.getBoundingClientRect().right,
          };
        });
        await testInfo.attach("Selection geometry", {
          body: JSON.stringify(geometry, null, 2), contentType: "application/json",
        });
        // Full-page metrics overrides reset Chromium's emulated coarse pointer.
        // Keep touch captures inside the viewport and verify the native mode.
        if (touch) {
          await row.screenshot({ path: testInfo.outputPath("collection-row.png") });
          await page.screenshot({ path: testInfo.outputPath("collection-selection.png") });
        } else {
          // A neutral hover and the same scroll order keep before/after evidence
          // free of unrelated field hover and sticky-toolbar differences.
          await page.getByRole("heading", { name: "Statehouse reporting package", exact: true }).hover();
          await page.screenshot({ path: testInfo.outputPath("collection-selection.png"), fullPage: true });
          await row.screenshot({ path: testInfo.outputPath("collection-row.png") });
        }
        expect(await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches)).toBe(touch);
        expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(touch);
        expect(await mark.evaluate(element => element.getBoundingClientRect().width)).toBe(touch ? 44 : 32);
        expect(await mark.evaluate(element => element.getBoundingClientRect().height)).toBe(touch ? 44 : 32);

        await expect(row.getByRole("button", { name: "Remove unavailable item from collection" })).toHaveCount(0);
        await expect(row.locator(".media-row-actions").getByRole("button")).toHaveCount(1);
        expect(geometry.coarse).toBe(touch);
        const targetSize = touch ? 44 : 32;
        expect.soft(geometry.target.width).toBe(targetSize);
        expect.soft(geometry.target.height).toBe(targetSize);
        expect.soft(geometry.box.width).toBe(16);
        expect.soft(geometry.box.height).toBe(16);
        expect.soft(Math.abs(geometry.offset)).toBeLessThanOrEqual(1);
        expect.soft(geometry.target).toEqual(geometry.peer);
        expect(geometry.peerMore).toHaveLength(3);
        for (const peer of geometry.peerMore) expect(geometry.more).toEqual(peer);
        expect.soft(geometry.target.x).toBeGreaterThanOrEqual(geometry.cell.x);
        expect.soft(geometry.target.x + geometry.target.width)
          .toBeLessThanOrEqual(geometry.cell.x + geometry.cell.width + 1);
        expect(geometry.overflow).toBeLessThanOrEqual(1);
        expect(geometry.actionGap).toBeGreaterThanOrEqual(0);

        await mark.click();
        await expect(mark).toBeChecked();
        await expect(row).toHaveAttribute("aria-selected", "true");
        const selection = page.getByRole("group", { name: "Collection selection" });
        await expect(selection).toContainText("1 of 30 selected");
        await mark.focus();
        await expect(mark).toBeFocused();
        await mark.press("Space");
        await expect(mark).not.toBeChecked();
        await expect(row).toHaveAttribute("aria-selected", "false");
        await expect(selection).toHaveCount(0);
      });
    }
  });
}

test.describe("Keyboard removal", () => {
  test.use({ hasTouch: true });
  for (const width of [390, 1280]) {
    test(`Unavailable reference can be removed and undone at ${width}px`, async ({ page }) => {
      const grid = await openCollectionList(page, width);
      // The gallery owns reads. Fake only its missing membership-write response
      // at the fetch boundary, and retain every write to detect any asset delete.
      await page.evaluate(() => {
        const originalFetch = window.fetch;
        const writes: { endpoint: string; body: Record<string, unknown> }[] = [];
        Object.assign(window, { collectionWrites: writes });
        window.fetch = async (input, init) => {
          const endpoint = new URL(typeof input === "string" ? input
            : input instanceof URL ? input.href : input.url, location.href).pathname.split("/").pop()!;
          if (init?.method === "POST") {
            const body = JSON.parse(String(init.body)) as Record<string, unknown>;
            writes.push({ endpoint, body });
            if (endpoint === "cmsSetMediaCollectionItems") return Response.json({
              success: true, changed: true, replayed: false, collectionId: body.collectionId,
              version: 4, membershipVersion: Number(body.baseMembershipVersion) + 1,
              changedRefs: body.refs, hiddenChangedCount: 0,
            });
          }
          return originalFetch(input, init);
        };
      });

      const row = grid.getByRole("row", { name: /Unavailable item/ });
      const more = row.getByRole("button", { name: "More actions: Unavailable item", exact: true });
      await more.focus();
      await more.press("ArrowDown");
      const menu = page.getByRole("menu", { name: "More actions: Unavailable item", exact: true });
      const remove = menu.getByRole("menuitem", { name: "Remove from collection", exact: true });
      await expect(remove).toBeFocused();
      await remove.press("Enter");
      await expect(row).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Items", exact: true })).toBeFocused();
      await expect(grid.getByRole("button", { name: /^Statehouse newsroom still, image/ })).toBeVisible();
      const notice = page.getByRole("region", { name: "Notifications" });
      await expect(notice).toContainText("1 item removed from Statehouse reporting package.");

      const undo = notice.getByRole("button", { name: "Undo", exact: true });
      await undo.focus();
      await undo.press("Enter");
      await expect(row).toBeVisible();
      await expect(notice).toContainText("1 item restored to Statehouse reporting package.");
      const writes = await page.evaluate(() =>
        (window as unknown as { collectionWrites: { endpoint: string; body: Record<string, unknown> }[] }).collectionWrites);
      expect(writes).toHaveLength(2);
      for (const write of writes) {
        expect(write.endpoint).toBe("cmsSetMediaCollectionItems");
        expect(write.body.collectionId).toBe("c".repeat(64));
        expect(write.body.refs).toEqual([{ backend: "s3", sourceId: "archive", id: "missing-collection-video" }]);
      }
      expect(writes.map(write => write.body.present)).toEqual([false, true]);
      expect(writes.map(write => write.body.baseMembershipVersion)).toEqual([7, 8]);
    });
  }
});
