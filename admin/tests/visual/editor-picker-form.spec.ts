import { expect, test } from "./fixtures";
import { openSpecimen } from "./capture";

test("Enter in picker upload metadata cannot submit the surrounding record form", async ({ page }) => {
  await openSpecimen(page, { id: "media-picker-upload", title: "Picker", width: 1280, presentation: "icons" }, { normalizeGeneratedIds: false });
  // Model the legacy record form around the picker's React origin. Native form
  // ownership, rather than the overlay's DOM ancestry, controls implicit submit.
  await page.getByRole("button", { name: "Choose image", exact: true }).evaluate(button => {
    const origin = button.parentElement!;
    const form = document.createElement("form");
    form.id = "native-record-form";
    origin.replaceWith(form); form.append(origin);
    const submit = document.createElement("button");
    submit.type = "submit"; submit.textContent = "Save record"; form.append(submit);
    form.dataset.submissions = "0";
    form.addEventListener("submit", event => {
      event.preventDefault();
      form.dataset.submissions = String(Number(form.dataset.submissions) + 1);
    });
  });
  await page.getByRole("button", { name: "Choose image", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Choose an image", exact: true });
  await picker.getByRole("button", { name: "Upload image", exact: true }).click();
  const license = picker.getByRole("textbox", { name: "Batch license default", exact: true });
  expect(await license.evaluate(element => (element as HTMLInputElement).form === null)).toBe(true);
  await license.fill("NJ PBS owned");
  await license.press("Enter");
  await expect(page.locator("#native-record-form")).toHaveAttribute("data-submissions", "0");
  // Prove this fixture's native submit observer is active.
  await page.getByRole("button", { name: "Save record", exact: true }).evaluate(button => (button as HTMLButtonElement).click());
  await expect(page.locator("#native-record-form")).toHaveAttribute("data-submissions", "1");
});
