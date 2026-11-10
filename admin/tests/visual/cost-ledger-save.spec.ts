import { expect, test } from "./fixtures";
// Keep the phone and docked-details rule bands.
for (const width of [320, 1280]) {
  test(`Save changes and deliberate month review at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/costs-fixture.html");
    const save = page.getByRole("button", {
      name: "Save changes",
      exact: true,
    });
    await expect(save).toBeDisabled();
    await page
      .getByRole("button", { name: "More cost actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Close month", exact: true })
      .or(
        page
          .locator("#workspace-more-panel")
          .getByRole("button", { name: "Close month", exact: true }),
      )
      .click();
    const review = page.getByRole("dialog", { name: "Close September 2026?" });
    await expect(review).toBeVisible();
    await expect(
      review.getByRole("button", { name: "Keep reviewing", exact: true }),
    ).toBeFocused();
    await expect(review).toContainText("Blank lines included");
    await expect(
      review.getByRole("button", { name: "Close month", exact: true }),
    ).toBeEnabled();
    await page.keyboard.press("Shift+Tab");
    await expect(
      review.getByRole("button", { name: "Close month", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(review).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "More cost actions", exact: true }),
    ).toBeFocused();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
  });
}
test("global save reports fixture failure and retains drafts from multiple tasks", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/costs-fixture.html");
  await page
    .getByRole("button", { name: "Edit Claude line", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Claude notes", exact: true })
    .fill("Unsent local note");
  await page
    .getByRole("tab", { name: "Price references", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Edit Ghost(Pro) Business reference",
      exact: true,
    })
    .click();
  await page
    .getByRole("textbox", {
      name: "Ghost(Pro) Business comparison notes",
      exact: true,
    })
    .fill("Unsent research note");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("No changes were saved");
  await expect(page.getByRole("alert")).toContainText(
    "Not sent: Ghost(Pro) Business",
  );
  await expect(
    page.getByRole("textbox", {
      name: "Ghost(Pro) Business comparison notes",
      exact: true,
    }),
  ).toHaveValue("Unsent research note");
  await page.getByRole("tab", { name: "Ledger", exact: true }).click();
  await page
    .getByRole("button", { name: "Edit Claude line", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Claude notes", exact: true }),
  ).toHaveValue("Unsent local note");
});
test("pending save keeps its footprint and blocks conflicting fields", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/costs-fixture.html?state=pending");
  await page
    .getByRole("button", { name: /^Airtable amount for September 2026:/ })
    .click();
  await page
    .getByRole("textbox", {
      name: "Airtable amount for September 2026",
      exact: true,
    })
    .fill("-12.34");
  await page.keyboard.press("Escape");
  const save = page.locator(".cost-ledger-header-actions .async-action-button");
  await expect(save.locator(".activity-indicator")).toHaveCount(0);
  const before = await save.boundingBox();
  await save.click();
  await expect(save).toHaveAttribute("aria-busy", "true");
  await expect(save.locator(".activity-indicator")).toHaveCount(1);
  const after = await save.boundingBox();
  expect(after!.width).toBeCloseTo(before!.width, 0);
  expect(after!.height).toBeCloseTo(before!.height, 0);
  await expect(
    page.getByRole("combobox", { name: "Ledger month" }),
  ).toBeDisabled();
  await expect(save).toHaveAttribute("aria-disabled", "true");
});
test("confirmed write with unavailable reload disables retry and keeps recovery available", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/costs-fixture.html?state=reload-failure");
  await page
    .getByRole("button", { name: /^Airtable amount for September 2026:/ })
    .click();
  await page
    .getByRole("textbox", {
      name: "Airtable amount for September 2026",
      exact: true,
    })
    .fill("0");
  await page.getByRole("button", { name: "Save amount", exact: true }).click();
  await expect(
    page
      .getByRole("alert")
      .getByText("Saved view needs a reload", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("write succeeded");
  await expect(
    page.getByRole("button", { name: "Save amount", exact: true }),
  ).toBeDisabled();
  await expect(
    page
      .getByRole("dialog", { name: "Line details" })
      .getByRole("heading", { name: "Airtable", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Reload saved costs", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "More cost actions", exact: true })
    .click();
  await expect(
    page
      .locator("#workspace-more-panel")
      .getByRole("button", { name: "Download CSV", exact: true }),
  ).toBeDisabled();
});
test("short enlarged month review keeps lower actions reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 500 });
  await page.goto("/costs-fixture.html");
  await page.addStyleTag({ content: "html { font-size: 200%; }" });
  await page
    .getByRole("button", { name: "More cost actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Close month", exact: true })
    .or(
      page
        .locator("#workspace-more-panel")
        .getByRole("button", { name: "Close month", exact: true }),
    )
    .click();
  const action = page
    .getByRole("dialog")
    .getByRole("button", { name: "Close month", exact: true });
  await action.scrollIntoViewIfNeeded();
  const box = await action.boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(500);
  await action.focus();
  await page.keyboard.press("Tab");
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: "Keep reviewing", exact: true }),
  ).toBeFocused();
});

test("month review retains focus after discard and distinguishes pending draft saves", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/costs-fixture.html?state=pending");
  await page
    .getByRole("button", { name: /^Airtable amount for September 2026:/ })
    .click();
  await page
    .getByRole("textbox", {
      name: "Airtable amount for September 2026",
      exact: true,
    })
    .fill("12.34");
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "More cost actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Close month", exact: true })
    .or(
      page
        .locator("#workspace-more-panel")
        .getByRole("button", { name: "Close month", exact: true }),
    )
    .click();
  const review = page.getByRole("dialog");
  await expect(
    review.getByRole("button", { name: "Close month", exact: true }),
  ).toBeDisabled();
  await review
    .getByRole("button", { name: "Discard pending changes", exact: true })
    .click();
  const discardGuard = page.getByRole("dialog", {
    name: "Discard 1 pending change?",
  });
  await expect(
    discardGuard.getByRole("button", { name: "Keep editing", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    discardGuard.getByRole("button", {
      name: "Discard changes",
      exact: true,
    }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    discardGuard.getByRole("button", { name: "Keep editing", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(discardGuard).toHaveCount(0);
  await expect(
    review.getByRole("button", { name: "Close month", exact: true }),
  ).toBeDisabled();
  await expect(
    review.getByRole("button", {
      name: "Discard pending changes",
      exact: true,
    }),
  ).toBeFocused();
  await review
    .getByRole("button", { name: "Discard pending changes", exact: true })
    .click();
  await discardGuard
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(
    review.getByRole("button", { name: "Keep reviewing", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: /^Airtable amount for September 2026:/ })
    .click();
  await page
    .getByRole("textbox", {
      name: "Airtable amount for September 2026",
      exact: true,
    })
    .fill("12.34");
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "More cost actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Close month", exact: true })
    .or(
      page
        .locator("#workspace-more-panel")
        .getByRole("button", { name: "Close month", exact: true }),
    )
    .click();
  await review
    .getByRole("button", { name: "Save changes first", exact: true })
    .click();
  const draftSave = review.locator('button[aria-busy="true"]');
  await expect(draftSave).toHaveAccessibleName(/Save changes first/);
  await expect(draftSave).toBeFocused();
  await expect(
    review.getByRole("button", { name: "Close month", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(review).toBeVisible();
});

for (const width of [390, 1440]) {
  test(`month confirm keeps safe order and centers its idle label at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/costs-fixture.html");
    await page
      .getByRole("button", { name: "More cost actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Close month", exact: true })
      .or(
        page
          .locator("#workspace-more-panel")
          .getByRole("button", { name: "Close month", exact: true }),
      )
      .click();
    const dialog = page.getByRole("dialog"),
      keep = dialog.getByRole("button", {
        name: "Keep reviewing",
        exact: true,
      }),
      confirm = dialog.getByRole("button", {
        name: "Close month",
        exact: true,
      });
    const a = (await keep.boundingBox())!,
      b = (await confirm.boundingBox())!;
    expect(width < 513 ? a.y : a.x).toBeLessThan(width < 513 ? b.y : b.x);
    const alignment = await confirm.evaluate((button) => {
      const b = button.getBoundingClientRect(),
        copy = button
          .querySelector(".async-action-copy")!
          .getBoundingClientRect();
      return Math.abs(b.x + b.width / 2 - copy.x - copy.width / 2);
    });
    expect(alignment).toBeLessThanOrEqual(2);
  });
}
for (const task of ["Price references", "Hardware"]) {
  test(`confirmed reload failure stays in one reachable notice in ${task}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/costs-fixture.html?state=reload-failure");
    await page.getByRole("tab", { name: task, exact: true }).click();
    await page
      .getByRole("button", {
        name:
          task === "Hardware"
            ? "Edit node-services assumptions"
            : "Edit Ghost(Pro) Business reference",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", {
        name:
          task === "Hardware" ? "Save hardware assumptions" : "Save comparison",
        exact: true,
      })
      .click();
    const notice = page.getByRole("alert");
    await expect(notice).toHaveCount(1);
    await expect(notice).toContainText("write succeeded");
    await expect(
      notice.getByRole("button", { name: "Reload saved costs", exact: true }),
    ).toBeEnabled();
    await expect(notice).not.toContainText("..");
    await expect(
      page.getByRole("dialog").locator(".ui-inspector-heading"),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(1);
  });
}

for (const width of [390, 1440]) {
  test(`amount controls keep a distinct keyboard focus ring at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/costs-fixture.html");
    const name = page.getByRole("button", { name: "Airtable", exact: true });
    await name.focus();
    await page.keyboard.press("Tab");
    const amount = page.getByRole("button", {
      name: /^Airtable amount for September 2026:/,
    });
    await expect(amount).toBeFocused();
    const focus = await amount.evaluate((element) => ({
      style: getComputedStyle(element).outlineStyle,
      width: parseFloat(getComputedStyle(element).outlineWidth),
      rowStyle: getComputedStyle(element.closest("tr")!).outlineStyle,
    }));
    expect(focus.style).toBe("solid");
    expect(focus.width).toBeGreaterThanOrEqual(2);
    expect(focus.rowStyle).toBe("none");
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("button", { name: "Edit Airtable line", exact: true }),
    ).toBeFocused();
  });
}

for (const width of [390, 1440]) {
  test(`month review preserves separate read recovery at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/costs-fixture.html?state=reload-error");
    await page
      .getByRole("combobox", { name: "Ledger month" })
      .selectOption("2026-08");
    await expect(page.getByRole("alert")).toContainText(
      "Costs could not be loaded",
    );
    await page
      .getByRole("button", { name: "More cost actions", exact: true })
      .click();
    await page
      .getByRole(width === 390 ? "button" : "menuitem", {
        name: "Close month",
        exact: true,
      })
      .click();
    const review = page.getByRole("dialog", { name: "Close September 2026?" });
    await expect(review).toBeVisible();
    await expect(review).not.toContainText(
      "The requested cost view could not be loaded",
    );
    await expect(review.getByRole("alert")).toHaveCount(0);
    await review.getByRole("button", { name: "Keep reviewing" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "Costs could not be loaded",
    );
    await expect(
      page.getByRole("button", { name: "Try again", exact: true }),
    ).toBeEnabled();
  });
}
