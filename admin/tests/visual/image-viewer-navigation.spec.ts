import { expect, test } from "./fixtures";
import { waitForFonts } from "./capture";

for (const width of [320, 390]) {
  test(`image viewer navigation prompt stacks above details at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/gallery.html?embed=image-viewer&presentation=text&navigation-prompt");
    const viewer = page.getByRole("dialog", { name: "Statehouse dome at dusk" });
    await viewer.getByRole("group", { name: "Image workspace controls" }).getByRole("button", { name: "Details", exact: true }).click();
    const prompt = viewer.getByRole("status").filter({ hasText: "Unsaved media changes" });
    const details = viewer.getByRole("complementary", { name: "Asset details" });
    await expect(prompt).toBeVisible();
    await waitForFonts(page);
    const [promptElement, detailsElement] = await Promise.all([prompt.elementHandle(), details.elementHandle()]);
    expect(promptElement).not.toBeNull();
    expect(detailsElement).not.toBeNull();
    const { promptBox, detailsBox } = await page.evaluate(
      ([promptNode, detailsNode]) => {
        const promptRect = promptNode.getBoundingClientRect();
        const detailsRect = detailsNode.getBoundingClientRect();
        return {
          promptBox: { height: promptRect.height, width: promptRect.width, y: promptRect.y },
          detailsBox: { y: detailsRect.y },
        };
      },
      [promptElement!, detailsElement!],
    );
    expect(promptBox.width).toBeGreaterThan(220);
    expect(detailsBox.y).toBeGreaterThanOrEqual(promptBox.y + promptBox.height - 1);
    await prompt.getByRole("button", { name: "Keep editing" }).focus();
    await expect(prompt.getByRole("button", { name: "Keep editing" })).toBeFocused();
    await viewer.press("Escape");
    await viewer.press("Escape");
    await expect(viewer).toBeVisible();
  });
}
