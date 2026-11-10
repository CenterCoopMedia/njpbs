import { expect, test } from "./fixtures";
import { openSpecimen } from "./capture";

for (const destination of ["same column", "another column"] as const) {
  test(`reorder payload cannot enter live rich text when dropped in ${destination}`, async ({ page }) => {
    await openSpecimen(page, {
      id: "outline-workspace", title: "Page outline hierarchy", width: 1280, presentation: "text",
    }, { normalizeGeneratedIds: false });
    const sourceColumn = page.getByRole("group", { name: "Row 2, column 1", exact: true });
    const targetColumn = destination === "same column" ? sourceColumn
      : page.getByRole("group", { name: "Row 2, column 2", exact: true });
    const grip = await sourceColumn.getByRole("button", { name: /^Move: text plank/ }).elementHandle();
    if (!grip) throw new Error("Missing source plank grip");
    const sourceId = await sourceColumn.locator(".block-card").getAttribute("id");
    if (destination === "same column") {
      await sourceColumn.getByRole("button", { name: "Add plank to column 1", exact: true }).click();
      const picker = page.getByRole("dialog", { name: "Add content", exact: true });
      await picker.getByRole("radio", { name: "text", exact: true }).check();
      await picker.getByRole("button", { name: "Insert block", exact: true }).click();
      const editor = page.getByRole("dialog", { name: /^text \d+$/ });
      await editor.getByRole("textbox", { name: "Body", exact: true }).fill("Middle plank stays with its column.");
      await editor.getByRole("button", { name: "Done", exact: true }).click();
    }
    await targetColumn.getByRole("button", { name: `Add plank to column ${destination === "same column" ? 1 : 2}`, exact: true }).click();
    const picker = page.getByRole("dialog", { name: "Add content", exact: true });
    await picker.getByRole("radio", { name: "text", exact: true }).check();
    await picker.getByRole("button", { name: "Insert block", exact: true }).click();
    const editor = page.getByRole("dialog", { name: /^text \d+$/ });
    const body = editor.getByRole("textbox", { name: "Body", exact: true });
    const text = "Keep this draft text unchanged after a reorder drop.";
    await body.fill(text);
    const orderBefore = await sourceColumn.locator(".block-card").evaluateAll(cards => cards.map(card => card.id));
    const targetOrderBefore = await targetColumn.locator(".block-card").evaluateAll(cards => cards.map(card => card.id));

    // This exercises the real browser DataTransfer and ProseMirror drop listener.
    // The open modal makes the source grip inert, so dispatched events test the
    // drop boundary; they are not evidence of a physical grip-to-modal gesture.
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await grip.dispatchEvent("dragstart", { dataTransfer });
    expect(await dataTransfer.evaluate(data => data.getData("text/plain"))).toBe("");
    const point = await body.evaluate(element => {
      const plank = element.closest(".content-plank-placement");
      if (!plank) throw new Error("The live editor has no containing plank");
      const bounds = element.getBoundingClientRect();
      return { clientX: bounds.left + bounds.width / 2, clientY: bounds.top + bounds.height / 2 };
    });
    await body.dispatchEvent("dragover", { dataTransfer, ...point });
    const dropPosition = await body.evaluate(element => element.closest(".content-plank-placement")?.getAttribute("data-reorder-drop"));
    if (destination === "same column") expect(["before", "after"]).toContain(dropPosition);
    await body.dispatchEvent("drop", { dataTransfer, ...point });
    await grip.dispatchEvent("dragend", { dataTransfer });
    await expect(body).toHaveText(text);
    await editor.getByRole("button", { name: "Done", exact: true }).click();

    if (destination === "same column") {
      const expected = orderBefore.filter(id => id !== sourceId);
      expected.splice(dropPosition === "after" ? expected.length : expected.length - 1, 0, sourceId!);
      await expect.poll(() => sourceColumn.locator(".block-card").evaluateAll(cards => cards.map(card => card.id))).toEqual(expected);
      await expect(page.locator(".content-row-canvas").getByRole("status")).toContainText(`moved to position ${expected.indexOf(sourceId!) + 1} of 3`);
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await expect.poll(() => sourceColumn.locator(".block-card").evaluateAll(cards => cards.map(card => card.id))).toEqual(orderBefore);
    } else {
      await expect(page.locator(".content-row-canvas").getByRole("status")).toContainText("No valid drop position. Order unchanged.");
      expect(await sourceColumn.locator(".block-card").evaluateAll(cards => cards.map(card => card.id))).toEqual(orderBefore);
      expect(await targetColumn.locator(".block-card").evaluateAll(cards => cards.map(card => card.id))).toEqual(targetOrderBefore);
    }
    await expect(targetColumn.locator(".block-preview-content").filter({ hasText: text })).toHaveText(text);
    await expect(sourceColumn.locator(".block-preview-content").filter({ hasText: "Sample story text" }).first()).toHaveText("Sample story text");
    await dataTransfer.dispose();
  });
}

test("touch moves an outline plank within its column and keeps focus and undo", async ({ page }) => {
  await openSpecimen(page, {
    id: "editor-structure-post", title: "Post editor structure", width: 390, presentation: "text",
  }, { normalizeGeneratedIds: false });
  await page.getByRole("button", { name: "Outline", exact: true }).click();
  const outline = page.getByRole("navigation", { name: "Content outline", exact: true });
  const grip = outline.getByRole("button", { name: "Move: text 3 in content outline", exact: true });
  const target = outline.getByRole("button", { name: /^Go to link card 4:/ });
  await target.scrollIntoViewIfNeeded();
  await expect(grip).toBeInViewport();
  const sourceBox = await grip.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error("Missing visible touch targets");
  const targetRow = target.locator("..");
  const siblings = outline.getByRole("button", { name: "Go to Row 1, column 2: 2 blocks", exact: true })
    .locator("../..").locator(":scope > ol");
  const labels = siblings.locator(":scope > li .block-outline-copy > strong");
  // Staff titles are the primary line; these are the specimen's prose and link titles.
  const copyTitle = "New Jersey stories begin with the people who live them. Follow the conversations, places and everyday decisions that shape our communities.";
  const linkTitle = "More reporting from New Jersey";
  await expect(labels).toHaveText([copyTitle, linkTitle]);
  const touch = await page.context().newCDPSession(page);
  try {
    // Points come from named controls, never screenshot positions.
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{
      x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2,
    }] });
    await expect(grip).toHaveAttribute("aria-pressed", "true");
    await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{
      x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height - 4,
    }] });
    await expect(targetRow).toHaveAttribute("data-reorder-drop", "after");
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(labels).toHaveText([linkTitle, copyTitle]);
    await expect(outline.getByRole("button", { name: "Move: text 4 in content outline", exact: true })).toBeFocused();
    await expect(page.getByRole("dialog", { name: "Content outline", exact: true }).getByRole("status"))
      .toContainText("moved to position 2 of 2");
    await page.getByRole("button", { name: "Close content outline", exact: true }).click();
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.getByRole("button", { name: "Outline", exact: true }).click();
    const column = outline.getByRole("button", { name: "Go to Row 1, column 2: 2 blocks", exact: true }).locator("../..");
    await expect(column.locator(".block-outline-item .block-outline-copy > strong")).toHaveText([copyTitle, linkTitle]);
  } finally {
    await touch.detach();
  }
});
