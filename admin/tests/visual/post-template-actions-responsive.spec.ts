import { expect, test, type Locator } from "./fixtures";
import { openSpecimen } from "./capture";

type MenuGeometry = {
  bottom: number;
  clientHeight: number;
  clientWidth: number;
  left: number;
  right: number;
  scrollHeight: number;
  scrollWidth: number;
  top: number;
  viewportHeight: number;
  viewportWidth: number;
};

async function readGeometry(menu: Locator): Promise<MenuGeometry> {
  return menu.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      bottom: rect.bottom,
      clientHeight: element.clientHeight,
      clientWidth: element.clientWidth,
      left: rect.left,
      right: rect.right,
      scrollHeight: element.scrollHeight,
      scrollWidth: element.scrollWidth,
      top: rect.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };
  });
}

async function expectMenuInsideViewport(menu: Locator): Promise<void> {
  await expect.poll(async () => (await readGeometry(menu)).left).toBeGreaterThanOrEqual(0);
  await expect.poll(async () => (await readGeometry(menu)).top).toBeGreaterThanOrEqual(0);
  await expect.poll(async () => {
    const geometry = await readGeometry(menu);
    return geometry.viewportWidth - geometry.right;
  }).toBeGreaterThanOrEqual(0);
  await expect.poll(async () => {
    const geometry = await readGeometry(menu);
    return geometry.viewportHeight - geometry.bottom;
  }).toBeGreaterThanOrEqual(0);

  const geometry = await readGeometry(menu);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  expect(geometry.scrollHeight).toBeGreaterThanOrEqual(geometry.clientHeight);
}

for (const viewport of [
  { label: "desktop", width: 1280, height: 900 },
  { label: "phone", width: 390, height: 640 },
  { label: "short desktop", width: 1280, height: 180 },
  { label: "short phone", width: 390, height: 180 },
]) {
  test(`Document overflow stays in the ${viewport.label} viewport`, async ({ page }) => {
    await openSpecimen(page, {
      id: "shell-post-actions",
      title: "Post editor — template actions",
      width: viewport.width,
      presentation: "text",
    });
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    const trigger = page.getByRole("button", { name: "More document actions", exact: true });
    await expect(trigger).toBeVisible();
    await trigger.click();

    const duplicatePost = page.getByRole("button", { name: "Duplicate post" });
    await expect(duplicatePost).toBeVisible();
    await expectMenuInsideViewport(page.locator("#workspace-more-panel"));
    await duplicatePost.click({ trial: true });
  });
}

test("document overflow supports keyboard use and dismissal", async ({ page }) => {
  await openSpecimen(page, {
    id: "shell-post-actions",
    title: "Post editor — template actions",
    width: 1280,
    presentation: "text",
  });

  const trigger = page.getByRole("button", { name: "More document actions", exact: true });
  const disclosure = page.locator("#workspace-more-panel");
  await trigger.focus();
  await trigger.press("Enter");

  const duplicatePost = page.getByRole("button", { name: "Duplicate post" });
  const saveAsTemplate = page.getByRole("button", { name: "Save as template" });
  await expect(disclosure).toBeVisible();
  await expect(duplicatePost).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(disclosure).toBeHidden();
  await expect(duplicatePost).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.press("Enter");
  await expect(duplicatePost).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(duplicatePost).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.press("Enter");
  await page.keyboard.press("Tab");
  await expect(saveAsTemplate).toBeFocused();
  await expect(disclosure).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Delete", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Workspace preferences", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Open Boardwalk guide in a new tab" })).toBeFocused();
  await page.keyboard.press("Escape"); await expect(disclosure).toBeHidden();

  await trigger.click();
  await saveAsTemplate.click();
  const dialog = page.getByRole("dialog", { name: "Save as template" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole("heading", { name: "Edit post", level: 1 }).click();
  await expect(disclosure).toBeHidden();
  await expect(saveAsTemplate).toBeHidden();
});

for (const [id, names] of [
  ["shell-editor", ["Save draft", "Preview"]],
  ["shell-post-actions", ["Save draft"]],
] as const) {
  for (const width of [320, 390]) {
    test(`${id} keeps editing actions clear of More at ${width}px`, async ({ page }) => {
      await openSpecimen(page, { id, title: id, width, presentation: "text" });
      const editing = page.getByRole("group", { name: "Editing", exact: true });
      const more = await page.getByRole("button", { name: "More document actions", exact: true }).boundingBox();
      if (!more) throw new Error("More must remain visible on phone");
      for (const name of names) {
        const button = editing.getByRole("button", { name, exact: true });
        const box = await button.boundingBox();
        if (!box) throw new Error(`${name} must remain visible`);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        const overlaps = box.x < more.x + more.width && box.x + box.width > more.x &&
          box.y < more.y + more.height && box.y + box.height > more.y;
        expect(overlaps).toBe(false);
        await expect(button).toBeVisible();
      }
    });
  }
}
