import { expect, test } from "./fixtures";
import { openSpecimen } from "./capture";

test("the actual Italic command visibly changes glyphs", async ({ page }) => {
  await openSpecimen(page, { id: "rich-text-context-menu", title: "Rich text", width: 1280, presentation: "text" });
  const editor = page.getByRole("textbox", { name: "Long body", exact: true });
  const paragraph = editor.locator("p").first();
  const text = await paragraph.textContent();
  const plain = await paragraph.screenshot({ caret: "hide", animations: "disabled" });
  await paragraph.evaluate(element => {
    (element.parentElement as HTMLElement).focus();
    const range = document.createRange(); range.selectNodeContents(element);
    window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await editor.press("Control+i");
  await expect(paragraph.locator("em")).toHaveText(text!);
  await editor.evaluate(element => {
    window.getSelection()?.removeAllRanges(); (element as HTMLElement).blur();
  });
  await expect(page.getByRole("toolbar", { name: "Formatting for Long body" })).toBeHidden();
  const italic = await paragraph.screenshot({ caret: "hide", animations: "disabled" });
  expect(italic.equals(plain), "Italic formatting must visibly change the same text's glyphs").toBe(false);
});
