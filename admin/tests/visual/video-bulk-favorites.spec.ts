import { expect, test } from "./fixtures";

// HTTP fixtures exercise the real video route, shared menus and favorite client together.
const records = ["County interview", "Evening report"].map((name, index) => ({
  id: `video-${index + 1}`, sourceId: "video-library", name,
  description: "Synthetic video fixture.", originalName: `video-${index + 1}.mp4`,
  mimeType: "video/mp4", kind: "video", sizeBytes: 10485760, preview: "download_only",
  license: "NJ PBS owned", credit: "Sample newsroom", tags: [], rightsStatus: "pending",
  version: 1, createdAt: null, updatedAt: null,
}));
const refs = records.map(({ id, sourceId }) => ({ backend: "s3", sourceId, id }));

for (const width of [390, 1280]) {
  test(`video bulk favorites agree across bar and menus at ${width}px`, async ({ page }) => {
    const states = new Map<string, boolean>();
    const writes: unknown[] = [];
    let releaseBatch!: () => void;
    const batchGate = new Promise<void>(resolve => { releaseBatch = resolve; });
    let projections = 0;
    await page.route("**/cmsListSourceMedia", route => route.fulfill({ json: {
      success: true, records, nextCursor: null, hasMore: false, total: records.length, posters: [],
    } }));
    await page.route("**/cmsListMediaFavorites", route => {
      projections++;
      const body = route.request().postDataJSON() as { refs: typeof refs };
      return route.fulfill({ json: { success: true, states: body.refs.map(ref => ({ ref, favorite: states.get(ref.id) ?? false })) } });
    });
    await page.route("**/cmsSetMediaFavorites", async route => {
      const body = route.request().postDataJSON() as { refs: typeof refs; favorite: boolean };
      writes.push(body);
      if (writes.length === 1) await batchGate;
      return route.fulfill({ json: { success: true, favorite: body.favorite, results: body.refs.map(ref => {
        const changed = (states.get(ref.id) ?? false) !== body.favorite;
        states.set(ref.id, body.favorite);
        return { ref, favorite: body.favorite, changed };
      }) } });
    });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    await page.goto("/gallery.html?embed=video-library&presentation=text");
    await expect.poll(() => projections).toBe(1);
    await page.getByRole("checkbox", { name: "Select County interview", exact: true }).check();
    await page.getByRole("checkbox", { name: "Select Evening report", exact: true }).check();
    const bar = page.getByRole("group", { name: "Video selection", exact: true });
    await expect(bar.getByRole("button", { name: "Add to favorites", exact: true })).toBeEnabled();
    // Pointer screens use the selection bar or context menu; phones retain More.
    if (width === 390) {
      await page.getByRole("button", { name: "More actions: 2 items", exact: true }).first().click();
      await expect(page.getByRole("menuitem", { name: "Add to favorites", exact: true })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: "Remove from favorites", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
    }
    const card = page.getByRole("button", { name: /^County interview, video/ });
    await card.focus();
    await card.press("Shift+F10");
    await expect(page.getByRole("menuitem", { name: "Add to favorites", exact: true })).toBeVisible();
    await page.getByRole("menuitem", { name: "Add to favorites", exact: true }).click();
    await expect(page.getByText("Saving favorites…", { exact: true })).toBeVisible();
    await expect(bar.getByRole("button", { name: "Remove from favorites", exact: true })).toBeDisabled();
    await card.click();
    await card.press("Enter");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    releaseBatch();
    await expect(page.getByText("Added 2 to favorites.", { exact: true })).toBeVisible();
    await expect(bar).toHaveCount(0);
    await expect.poll(() => projections).toBe(2);
    expect(writes).toEqual([{ refs, favorite: true }]);
    await page.getByRole("checkbox", { name: "Select County interview", exact: true }).check();
    await page.getByRole("checkbox", { name: "Select Evening report", exact: true }).check();
    const remove = bar.getByRole("button", { name: "Remove from favorites", exact: true });
    await remove.focus();
    await remove.press("Enter");
    await expect(page.getByText("Removed 2 from favorites.", { exact: true })).toBeVisible();
    await expect.poll(() => projections).toBe(3);
    expect(writes).toEqual([{ refs, favorite: true }, { refs, favorite: false }]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  });
}
