import { expect, test } from "@playwright/test";

test("built Admin renders its signed-out shell without page errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  try {
    const response = await page.goto("/", { waitUntil: "load" });
    expect(response?.ok(), "Admin document must load successfully").toBe(true);
    await expect(page.locator("#root")).not.toBeEmpty();
    // A loading indicator or error boundary is not a working signed-out shell.
    await expect(page.getByRole("heading", { name: "Sign in to Boardwalk", exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Email", exact: true })).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  } finally {
    expect(errors, "Admin boot must not raise any pageerror").toEqual([]);
  }
});
