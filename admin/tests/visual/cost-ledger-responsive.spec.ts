import { installProofFonts, expect, test } from "./fixtures";
import { openSpecimen, waitForFonts } from "./capture";

for (const [id, width] of [
  ["cost-ledger-wide", 1280],
  ["cost-ledger-narrow", 390],
] as const) {
  test(`Costs gallery preserves values and shared Details at ${width}px`, async ({
    page,
  }) => {
    await openSpecimen(page, {
      id,
      title: `Costs at ${width} px`,
      width,
      presentation: "text",
    });
    await expect(
      page.getByRole("heading", { name: "Monthly ledger", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("tab", { name: "Price references", exact: true })
      .click();
    await expect(
      page.getByText("Quote required", { exact: true }),
    ).toBeVisible();
    await page.getByRole("tab", { name: "Ledger", exact: true }).click();
    await expect(
      page.locator('td[data-label="Amount"] .cost-ledger-blank'),
    ).toHaveText("Blank");
    await page.getByRole("button", { name: "Edit Claude line" }).click();
    const editor = page.getByRole("form", { name: "Claude standing line" });
    await expect(
      editor.getByRole("checkbox", { name: "Claude active" }),
    ).toBeChecked();
    await expect(
      editor.getByRole("button", { name: "Save", exact: true }),
    ).toBeVisible();
    await expect(editor.getByRole("button", { name: "Cancel" })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    const ledger = page.locator("#cost-panel-ledger .cost-ledger-lines-table");
    expect(
      await ledger.evaluate(
        (table) => table.scrollWidth <= table.clientWidth + 1,
      ),
    ).toBe(true);
  });
}

test("Costs loading keeps its responsive skeleton inside the phone page", async ({
  page,
}) => {
  await openSpecimen(page, {
    id: "cost-ledger-loading-narrow",
    title: "Costs loading at 390 px",
    width: 390,
    presentation: "text",
  });
  await expect(
    page.getByRole("status", { name: "Loading cost ledger" }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
});

// Keep the phone drawer and desktop side pane.
for (const width of [320, 1280]) {
  test(`real Costs surface keeps the ledger readable at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/costs-fixture.html");
    const table = page.locator("#cost-panel-ledger .cost-ledger-lines-table");
    await expect(table.locator("tbody tr")).toHaveCount(22);
    await waitForFonts(page);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    expect(
      await table.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);
    const zero = page.getByRole("button", {
      name: /^Airtable amount for September 2026:/,
    });
    await zero.click();
    const amount = page.getByRole("textbox", {
      name: "Airtable amount for September 2026",
      exact: true,
    });
    await expect(amount).toBeFocused();
    await amount.fill("-12.34");
    await page.keyboard.press("Escape");
    await expect(zero).toBeFocused();
    await expect(page.getByRole("status")).toContainText("1 pending change");
    await zero.click();
    await expect(amount).toHaveValue("-12.34");
    if (width < 1180) {
      const drawer = page.getByRole("dialog", {
        name: "Line details",
        exact: true,
      });
      await expect(drawer).toHaveAttribute("aria-modal", "true");
      expect(
        await zero.evaluate((element) => Boolean(element.closest("[inert]"))),
      ).toBe(true);
      await page.keyboard.press("Shift+Tab");
      expect(
        await drawer.evaluate((element) =>
          element.contains(document.activeElement),
        ),
      ).toBe(true);
    }
  });
}

test("Costs retains drafts across filtering and sorting and returns to a stable result when its opener is filtered away", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/costs-fixture.html");
  const opener = page.getByRole("button", { name: "Airtable", exact: true });
  await opener.click();
  await page
    .getByRole("textbox", { name: "Airtable notes", exact: true })
    .fill("Retained local notes");
  await page
    .getByRole("combobox", { name: "Sort cost lines" })
    .selectOption("amount");
  await page
    .getByRole("textbox", { name: "Search cost lines" })
    .fill("Google Cloud");
  await page
    .getByRole("button", { name: "Close details", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Cost lines", exact: true }),
  ).toBeFocused();
  await page.getByRole("textbox", { name: "Search cost lines" }).fill("");
  await opener.click();
  await expect(
    page.getByRole("textbox", { name: "Airtable notes", exact: true }),
  ).toHaveValue("Retained local notes");
});

test("phone touch targets fit their ledger cells without internal horizontal scrolling", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 320, height: 820 },
    hasTouch: true,
    isMobile: true,
  });
  await installProofFonts(context);
  try {
    const page = await context.newPage();
    await page.goto("/costs-fixture.html");
    const table = page.locator("#cost-panel-ledger .cost-ledger-lines-table");
    await expect(table.locator("tbody tr")).toHaveCount(22);
    const pencil = page.getByRole("button", {
      name: "Edit Airtable line",
      exact: true,
    });
    const dimensions = await pencil.evaluate((button) => {
      const target = button.getBoundingClientRect();
      const cell = button.closest("td")!.getBoundingClientRect();
      return {
        width: target.width,
        height: target.height,
        right: target.right,
        cellRight: cell.right,
      };
    });
    expect(dimensions.width).toBeGreaterThanOrEqual(44);
    expect(dimensions.height).toBeGreaterThanOrEqual(44);
    expect(dimensions.right).toBeLessThanOrEqual(dimensions.cellRight);
    expect(
      await table.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);
  } finally {
    await context.close();
  }
});

test("short 1024px drawer stays fixed and scrolls its lower controls into reach", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 500 });
  await page.goto("/costs-fixture.html");
  await page
    .getByRole("button", { name: "Edit Airtable line", exact: true })
    .click();
  const drawer = page.getByRole("dialog", {
    name: "Line details",
    exact: true,
  });
  expect(
    await drawer.evaluate((element) => getComputedStyle(element).position),
  ).toBe("fixed");
  const save = drawer.getByRole("button", { name: "Save", exact: true });
  await save.scrollIntoViewIfNeeded();
  const bounds = await save.boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(500);
  expect(
    await drawer
      .locator(".ui-inspector-body")
      .evaluate((element) => element.scrollTop),
  ).toBeGreaterThan(0);
});

test("default desktop month pane preserves primary focus through its outside toggle and responsive reflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/costs-fixture.html");
  await expect(page.locator(".ui-inspector-heading")).toBeVisible();
  await expect(page.locator(".ui-inspector-heading")).not.toBeFocused();
  const toggle = page.getByRole("button", {
    name: "Month details",
    exact: true,
  });
  await toggle.click();
  await expect(toggle).toBeFocused();
  await toggle.click();
  const search = page.getByRole("textbox", {
    name: "Search cost lines",
    exact: true,
  });
  await search.fill("Airtable");
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("Airtable");
});

test("phone Month details opens explicitly as a focused modal and returns to its toggle", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/costs-fixture.html");
  const toggle = page.getByRole("button", {
    name: "Month details",
    exact: true,
  });
  await toggle.click();
  const drawer = page.getByRole("dialog", {
    name: "Month details",
    exact: true,
  });
  await expect(drawer).toBeVisible();
  await expect(
    drawer.getByRole("heading", { name: "September 2026", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(toggle).toBeFocused();
});

// Keep phone More and the normal desktop header.
for (const width of [320, 1440]) {
  test(`Costs CSV stays aligned inline or is available in phone More at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/costs-fixture.html");
    const month = page.getByRole("combobox", { name: "Ledger month" }),
      csv = page.getByRole("button", { name: "Download CSV", exact: true });
    await expect(month).toBeVisible();
    if (width < 620) {
      await page
        .getByRole("button", { name: "More cost actions", exact: true })
        .click();
      await expect(
        page
          .locator("#workspace-more-panel")
          .getByRole("button", { name: "Download CSV", exact: true }),
      ).toBeVisible();
      return;
    }
    await expect(csv).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expect
      .poll(async () => {
        const a = await month.boundingBox(),
          b = await csv.boundingBox();
        return Math.abs(a!.y + a!.height - b!.y - b!.height);
      })
      .toBeLessThan(0.5);
    const field = await month.boundingBox(),
      action = await csv.boundingBox();
    expect(action!.height).toBeCloseTo(field!.height, 0);
    expect(action!.y + action!.height).toBeCloseTo(field!.y + field!.height, 0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
  });
}

test("phone month state fits in its complete select with coarse text sizing", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 320, height: 844 },
    hasTouch: true,
  });
  await installProofFonts(context);
  try {
    const page = await context.newPage();
    await page.goto("/costs-fixture.html?state=closed");
    const month = page.getByRole("combobox", { name: "Ledger month" });
    await expect(month).toBeVisible();
    await expect(month.locator("option:checked")).toHaveText(
      "September 2026 · closed",
    );
    const dimensions = await month.evaluate((element) => {
      const select = element as HTMLSelectElement,
        style = getComputedStyle(select),
        canvas = document.createElement("canvas"),
        context = canvas.getContext("2d")!;
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      return {
        width: select.clientWidth,
        required:
          context.measureText(select.selectedOptions[0].label).width +
          parseFloat(style.paddingLeft) +
          parseFloat(style.paddingRight) +
          16,
      };
    });
    expect(dimensions.width).toBeGreaterThanOrEqual(dimensions.required);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(320);
  } finally {
    await context.close();
  }
});

for (const width of [390, 1024]) {
  test(`Costs CSV stays reachable at 200 percent text at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/costs-fixture.html");
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    await page.evaluate(() => document.fonts.ready);
    const month = page.getByRole("combobox", { name: "Ledger month" });
    const csv = page.getByRole("button", { name: "Download CSV", exact: true });
    await expect(month).toBeVisible();
    if (width < 620) {
      await page
        .getByRole("button", { name: "More cost actions", exact: true })
        .click();
      await expect(
        page
          .locator("#workspace-more-panel")
          .getByRole("button", { name: "Download CSV", exact: true }),
      ).toBeVisible();
      return;
    }
    await expect(csv).toBeVisible();
    await page.waitForTimeout(300);
    const a = (await month.boundingBox())!,
      b = (await csv.boundingBox())!;
    expect(b.height).toBeCloseTo(a.height, 0);
    if (width === 1024) {
      expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(a.y + a.height - b.y - b.height)).toBeLessThanOrEqual(1);
    }
  });
}

test("200 percent root text enlarges Costs copy and table rows without clipping", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 1000 });
  await page.goto("/costs-fixture.html");
  await page.locator(".cost-ledger-lines-table tbody tr").first().waitFor();
  await waitForFonts(page);
  const read = () =>
    page.evaluate(() => ({
      root: parseFloat(getComputedStyle(document.documentElement).fontSize),
      heading: parseFloat(
        getComputedStyle(document.querySelector(".cost-ledger h2")!).fontSize,
      ),
      body: parseFloat(
        getComputedStyle(document.querySelector(".cost-ledger p")!).fontSize,
      ),
      table: parseFloat(
        getComputedStyle(document.querySelector(".cost-ledger-lines-table")!)
          .fontSize,
      ),
    }));
  const before = await read();
  await page.evaluate(() => (document.documentElement.style.fontSize = "200%"));
  await waitForFonts(page);
  // Descendant rem styles can update on a later render than the root size.
  for (const key of ["root", "heading", "body", "table"] as const)
    await expect.poll(async () => (await read())[key]).toBeCloseTo(before[key] * 2, 0);
  const rows = await page
    .locator(".cost-ledger-lines-table tbody tr")
    .evaluateAll((rows) =>
      rows.slice(0, 4).map((row) => ({
        height: row.getBoundingClientRect().height,
        clipped: [...row.querySelectorAll("td")].some(
          (cell) =>
            cell.scrollHeight > cell.clientHeight + 1 ||
            cell.scrollWidth > cell.clientWidth + 1,
        ),
      })),
    );
  expect(rows.every((row) => row.height > 44 && !row.clipped)).toBe(true);
  const fields = await Promise.all(
    ["Search cost lines", "Category filter", "Project filter"].map((name) =>
      page
        .getByRole(name === "Search cost lines" ? "textbox" : "combobox", {
          name,
          exact: true,
        })
        .boundingBox(),
    ),
  );
  for (const field of fields.slice(1)) {
    expect(Math.abs(field!.height - fields[0]!.height)).toBeLessThanOrEqual(1);
    if (field!.y < fields[0]!.y + fields[0]!.height)
      expect(Math.abs(field!.y - fields[0]!.y)).toBeLessThanOrEqual(1);
  }
});

for (const width of [390, 1440]) {
  test(`Month details expanded state follows its visible pane at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/costs-fixture.html");
    const toggle = page.getByRole("button", {
      name: "Month details",
      exact: true,
    });
    await expect(toggle).toHaveAttribute(
      "aria-expanded",
      width < 1180 ? "false" : "true",
    );
    await page
      .getByRole("button", { name: "Google Cloud Platform", exact: true })
      .click();
    if (width < 1180) await page.keyboard.press("Escape");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    if (width < 1180) await page.keyboard.press("Escape");
    else await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
}

// Keep pending-draft protection in both inspector modes.
for (const width of [320, 1280]) {
  test(`pending hidden drafts prevent a month change at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/costs-fixture.html");
    const month = page.getByRole("combobox", { name: "Ledger month" });
    await expect(month).toBeEnabled();
    const opener = page.getByRole("button", {
      name: "Google Cloud Platform",
      exact: true,
    });
    await opener.click();
    const field = page.getByRole("textbox", {
      name: "Google Cloud Platform amount for September 2026",
      exact: true,
    });
    await field.fill("-12.34");
    await expect(
      page.getByRole("button", { name: "Save changes", exact: true }),
    ).toBeEnabled();
    if (width < 1180) await page.keyboard.press("Escape");
    else
      await page
        .getByRole("button", { name: "Close details", exact: true })
        .click();
    await expect(
      page.getByRole("button", { name: "Save changes", exact: true }),
    ).toBeEnabled();
    await expect(month).toBeDisabled();
    await month.focus();
    await expect(month).toBeFocused();
    if (width > 619) {
      await expect(
        page.locator(".cost-ledger-phone-actions"),
      ).not.toBeVisible();
      const fieldBox = (await month.boundingBox())!;
      const csvBox = (await page
        .getByRole("button", { name: "Download CSV", exact: true })
        .boundingBox())!;
      expect(csvBox.height).toBeCloseTo(fieldBox.height, 0);
      expect(csvBox.y).toBeCloseTo(fieldBox.y, 0);
      const saveBox = (await page
        .getByRole("button", { name: "Save changes", exact: true })
        .boundingBox())!;
      const monthGap = saveBox.x - fieldBox.x - fieldBox.width;
      const csvGap = csvBox.x - saveBox.x - saveBox.width;
      expect(monthGap).toBeGreaterThanOrEqual(8);
      expect(monthGap).toBeCloseTo(csvGap, 0);
    }
    const reasonId = await month.getAttribute("aria-describedby");
    await expect(
      page.locator(`[id=${JSON.stringify(reasonId)}]`),
    ).toBeInViewport({ ratio: 1 });
    await expect(
      page
        .locator(".workspace-chrome")
        .getByRole("heading", { name: "Costs", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    expect(
      (await page
        .locator(".workspace-chrome")
        .getByRole("heading", { name: "Costs", exact: true })
        .boundingBox())!.width,
    ).toBeGreaterThan(30);
    await expect(month).toHaveAccessibleDescription(
      width <= 1023
        ? "Save or discard 1 change to switch months."
        : "Open · 1 pending change · save or discard first",
    );
    await expect(month).toHaveCSS("cursor", "not-allowed");
    await page.keyboard.press("ArrowUp");
    await expect(month).toHaveValue("2026-09");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await opener.click();
    await expect(field).toHaveValue("-12.34");
    await field.fill("894.23");
    if (width < 1180) await page.keyboard.press("Escape");
    else
      await page
        .getByRole("button", { name: "Close details", exact: true })
        .click();
    await expect(month).toBeEnabled();
  });
}

// Draft isolation and focus return are independent of the inspector placement.
const draftWidth = 390;
test(`retained amount can be discarded without losing another draft at ${draftWidth}`, async ({
  page,
}) => {
  await page.setViewportSize({ width: draftWidth, height: 1000 });
  await page.goto("/costs-fixture.html?state=retained-amount");
  const close = async () => {
    await page
      .getByRole("button", { name: "Close details", exact: true })
      .click();
  };
  await page
    .getByRole("button", { name: "Google Cloud Platform", exact: true })
    .click();
  await page
    .getByRole("textbox", {
      name: "Google Cloud Platform amount for September 2026",
      exact: true,
    })
    .fill("-12.34");
  await close();
  await page
    .getByRole("button", { name: "Edit Airtable line", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Airtable notes", exact: true })
    .fill("Keep unrelated draft");
  await close();
  await page
    .getByRole("button", {
      name: "Edit Google Cloud Platform line",
      exact: true,
    })
    .click();
  await page
    .getByRole("checkbox", {
      name: "Google Cloud Platform active",
      exact: true,
    })
    .uncheck();
  await page
    .getByRole("form", {
      name: "Google Cloud Platform standing line",
      exact: true,
    })
    .getByRole("button", { name: "Save", exact: true })
    .click();
  const retained = page.getByRole("region", {
    name: "Retained amount change",
    exact: true,
  });
  await expect(retained).toContainText("Draft amount-12.34 USD");
  await expect(retained).toContainText("Saved amountBlank");
  await retained
    .getByRole("button", { name: "Discard amount change", exact: true })
    .click();
  await expect(retained).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Close details", exact: true }),
  ).toBeFocused();
  await close();
  await page
    .getByRole("button", { name: "Edit Airtable line", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Airtable notes", exact: true }),
  ).toHaveValue("Keep unrelated draft");
});

for (const mode of ["manual-override", "manual-override-history"]) {
  for (const width of [390, 1440]) {
    test(`freshness stays period-neutral for ${mode} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`/costs-fixture.html?state=${mode}`);
      await expect(
        page.getByRole("combobox", { name: "Ledger month" }),
      ).toHaveValue(mode === "manual-override-history" ? "2026-08" : "2026-09");
      const opener = page.getByRole("button", {
        name: "Google Cloud Platform",
        exact: true,
      });
      const row = page.getByRole("row").filter({ has: opener });
      await expect(row).toContainText("Freshness recorded");
      await expect(row).not.toContainText("manual amount kept");
      if (width === 1440)
        await expect(
          row.getByText("Freshness recorded", { exact: true }),
        ).toBeVisible();
      await opener.click();
      const details = page.getByRole(
        width === 390 ? "dialog" : "complementary",
        { name: "Line details" },
      );
      await expect(details).toContainText(
        mode === "manual-override-history" ? "Automatic" : "Manual",
      );
      await expect(details.getByText("Known", { exact: true })).toBeVisible();
      const fact = details.getByText("Freshness recorded · Sep 22, 2026", {
        exact: true,
      });
      await fact.scrollIntoViewIfNeeded();
      await expect(fact).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
    });
  }
}
