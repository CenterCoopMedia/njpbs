import { expect, test } from "./fixtures";
import { openSpecimen } from "./capture";
import { assertControlDesign } from "./control-contract";

for (const width of [320, 1280]) {
  test(`page identity and actions stay together at ${width}px`, async ({ page }) => {
    await openSpecimen(page, { id: "page-directory", title: "Site pages", width, presentation: "text" });
    const table = page.getByRole("table", { name: "Live site pages" });
    const home = page.getByRole("row").filter({ has: page.getByRole("link", { name: "Edit page draft: Home", exact: true }) });
    const tableBox = (await table.boundingBox())!;
    const rowBox = (await home.boundingBox())!;
    expect(rowBox.width).toBeGreaterThanOrEqual(tableBox.width - 2);
    // The shared study row keeps one primary link and always-rendered overflow;
    // quiet inline commands need not be visible at narrow widths or at rest.
    const more = home.getByRole("button", { name: "Home actions", exact: true });
    const box = (await more.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await more.click();
    await page.getByRole("dialog", { name: "Home actions", exact: true })
      .getByRole("button", { name: "Show details for Home", exact: true }).click();
    const details = page.getByRole("region", { name: "Home details" });
    await expect(details).toBeVisible();
    await page.getByRole("searchbox", { name: "Search pages" }).fill("donate");
    await expect(details).toBeHidden();
    await page.getByRole("searchbox", { name: "Search pages" }).fill("");
    await expect(details).toBeVisible();
    await assertControlDesign(page);
  });
}
