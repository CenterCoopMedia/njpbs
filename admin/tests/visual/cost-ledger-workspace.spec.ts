import { expect, test } from "./fixtures";
// Keep the phone and docked-details rule bands.
for (const width of [320, 1280]) {
  test(`Costs measured shared workspace at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/costs-fixture.html");
    await expect(
      page.getByText("Known monthly total", { exact: true }).first(),
    ).toBeInViewport();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await expect(
      page.getByRole("tab", { name: "Ledger", exact: true }),
    ).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const readSizes = () => page
      .locator(".workspace-shell")
      .evaluate((element) => ({
        actual: element
          .querySelector(".workspace-chrome")!
          .getBoundingClientRect().height,
        measured: parseFloat(
          getComputedStyle(element).getPropertyValue("--costs-chrome-height"),
        ),
        scroll: document.documentElement.scrollWidth,
      }));
    // ResizeObserver publishes the CSS measurement after layout; wait for that contract.
    await expect.poll(async () => {
      const { measured, actual } = await readSizes();
      return measured - actual;
    }).toBeCloseTo(0, 0);
    const sizes = await readSizes();
    expect(sizes.measured).toBeCloseTo(sizes.actual, 0);
    expect(sizes.scroll).toBe(width);
    const identity = page
      .locator(".workspace-chrome")
      .getByRole("heading", { name: "Costs", exact: true });
    await expect(identity).toBeVisible();
    expect((await identity.boundingBox())!.width).toBeGreaterThan(30);
    if (width > 760)
      await expect(
        page
          .locator(".workspace-chrome")
          .getByRole("link", { name: "Settings", exact: true }),
      ).toHaveAttribute("href", "/admin/settings");
    await expect(
      page
        .getByRole("combobox", { name: "Ledger month" })
        .locator("option:checked"),
    ).toHaveText("September 2026 · open");
    const tabs = page.getByRole("tablist", { name: "Cost tasks" });
    await page.getByRole("tab", { name: "Ledger", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(
      page.getByRole("tab", { name: "History", exact: true }),
    ).toBeFocused();
    await expect(
      page.getByRole("heading", { name: "History", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("End");
    await expect(
      page.getByRole("tab", { name: "Hardware", exact: true }),
    ).toBeFocused();
    await expect(tabs).toBeVisible();
  });
}
test("reference and hardware inspectors retain drafts and saved totals through task switches", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/costs-fixture.html");
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
    .fill("Local research note");
  await page.getByRole("tab", { name: "Hardware", exact: true }).click();
  await page
    .getByRole("button", { name: "Edit node-services assumptions", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "node-services internet share", exact: true })
    .fill("0");
  await page
    .getByRole("tab", { name: "Price references", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Edit Ghost(Pro) Business reference",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("textbox", {
      name: "Ghost(Pro) Business comparison notes",
      exact: true,
    }),
  ).toHaveValue("Local research note");
  await page.getByRole("tab", { name: "Hardware", exact: true }).click();
  await page
    .getByRole("button", { name: "Edit node-services assumptions", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", {
      name: "node-services internet share",
      exact: true,
    }),
  ).toHaveValue("0");
});
test("short workspace keeps month controls and lower machine fields reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 500 });
  await page.goto("/costs-fixture.html");
  await expect(
    page.getByRole("combobox", { name: "Ledger month" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Hardware", exact: true }).click();
  await page
    .getByRole("button", { name: "Edit node-services assumptions", exact: true })
    .click();
  const save = page.getByRole("button", {
    name: "Save hardware assumptions",
    exact: true,
  });
  await save.scrollIntoViewIfNeeded();
  const box = await save.boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(500);
});

for (const width of [320]) {
  test(`History and read-only facts remain readable at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/costs-fixture.html?state=readonly");
    await page.getByRole("tab", { name: "History", exact: true }).click();
    const cells = await page
      .locator(".cost-ledger-history-table td")
      .evaluateAll((elements) =>
        elements.map((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return {
            cell: element.getBoundingClientRect().toJSON(),
            text: range.getBoundingClientRect().toJSON(),
          };
        }),
      );
    expect(cells.length).toBeGreaterThan(0);
    for (const { cell, text } of cells) {
      expect(text.right).toBeLessThanOrEqual(cell.right + 1);
      expect(text.left).toBeGreaterThanOrEqual(cell.left - 1);
    }
    await page
      .getByRole("tab", { name: "Price references", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "View Ghost(Pro) Business reference",
        exact: true,
      })
      .click();
    const reference = page.getByRole("dialog", {
      name: "Price reference details",
    });
    await expect(
      reference.getByRole("link", { name: "Source", exact: true }),
    ).toBeVisible();
    await expect(
      reference.getByText("Source / read date", { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: "Hardware", exact: true }).click();
    await page
      .getByRole("button", {
        name: "View node-services assumptions",
        exact: true,
      })
      .click();
    const hardware = page.getByRole("dialog", { name: "Hardware details" });
    for (const name of [
      "Purchase cost",
      "Life (months)",
      "Watts",
      "Hours per month",
      "Cents per kWh",
      "Internet share",
    ])
      await expect(hardware.getByText(name, { exact: true })).toBeVisible();
  });
}

for (const width of [320, 1440]) {
  test(`Costs table bands and control geometry stay aligned at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/costs-fixture.html");
    await page.locator(".cost-ledger-lines-table tbody tr").first().waitFor();
    if (width < 761)
      await page.getByRole("button", { name: "Filters", exact: true }).click();
    await page.evaluate(() => document.fonts.ready);
    const fields = await Promise.all(
      [
        "Search cost lines",
        "Category filter",
        "Project filter",
        "Line state",
        "Sort cost lines",
      ].map((name) =>
        page
          .getByRole(name === "Search cost lines" ? "textbox" : "combobox", {
            name,
            exact: true,
          })
          .boundingBox(),
      ),
    );
    expect(fields.every(Boolean)).toBe(true);
    for (const field of fields)
      expect(Math.abs(field!.height - fields[0]!.height)).toBeLessThanOrEqual(
        1,
      );
    if (width > 760)
      for (const field of fields.slice(1, 3))
        expect(Math.abs(field!.y - fields[0]!.y)).toBeLessThanOrEqual(1);
    for (const table of [page.locator(".cost-ledger-lines-table").first()]) {
      const band = await table.locator("th").evaluateAll((cells) =>
        cells
          .filter((e) => e.getBoundingClientRect().width > 0)
          .map((e) => ({
            right: e.getBoundingClientRect().right,
            bg: getComputedStyle(e).backgroundColor,
          })),
      );
      const bounds = (await table.boundingBox())!;
      expect(
        Math.abs(band.at(-1)!.right - bounds.x - bounds.width),
      ).toBeLessThanOrEqual(1);
      expect(band.every((cell) => cell.bg === band[0].bg)).toBe(true);
      expect(band[0].bg).not.toBe("rgba(0, 0, 0, 0)");
    }
    await page.getByRole("tab", { name: "Hardware", exact: true }).click();
    const numeric = await page
      .locator(".cost-ledger-fleet-table")
      .evaluate((table) =>
        [
          table.querySelector("th:nth-child(2)"),
          table.querySelector("td:nth-child(2)"),
        ].map((e) => {
          const range = document.createRange();
          range.selectNodeContents(e!);
          return range.getBoundingClientRect().right;
        }),
      );
    expect(Math.abs(numeric[0] - numeric[1])).toBeLessThanOrEqual(2);
  });
}

for (const state of ["", "closed"]) {
  test(`Costs phone adopts the shared More panel with safe finder return (${state || "open"})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto("/costs-fixture.html" + (state ? "?state=" + state : ""));
    const more = page.getByRole("button", {
      name: "More cost actions",
      exact: true,
    });
    const month = page.getByRole("combobox", { name: "Ledger month" });
    await expect(month).toBeVisible();
    await expect(more).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expect
      .poll(async () => {
        const a = (await month.boundingBox())!,
          b = (await more.boundingBox())!;
        return Math.abs(a.y - b.y);
      })
      .toBeLessThanOrEqual(1);
    const a = (await month.boundingBox())!,
      b = (await more.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(a.x + a.width);
    await more.click();
    const panel = page.locator("#workspace-more-panel");
    await expect(
      panel.getByRole("button", { name: "Download CSV", exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Reload saved costs", exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", {
        name: state ? "Reopen month" : "Close month",
        exact: true,
      }),
    ).toBeVisible();
    await panel
      .getByRole("button", { name: "Find a workspace", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Find a workspace", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(more).toBeFocused();
    await expect(panel).toBeHidden();
  });
}

for (const width of [320, 390]) {
  test(`Costs phone More uses consistent labeled icon rows at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/costs-fixture.html");
    await page
      .getByRole("button", { name: "More cost actions", exact: true })
      .click();
    const panel = page.locator("#workspace-more-panel");
    for (const name of [
      "Download CSV",
      "Reload saved costs",
      "Close month",
      "Find a workspace",
      "Report a problem",
    ])
      await expect(
        panel.getByRole("button", { name, exact: true }),
      ).toBeVisible();
    await expect(
      panel.getByRole("link", { name: "Open Boardwalk guide in a new tab" }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: /^What's new(?:, unread updates)?$/ })
        .getByText("What's new", { exact: true }),
    ).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const rows = await panel
      .getByRole("button")
      .or(panel.getByRole("link"))
      .evaluateAll((es) =>
        es.map((e) => ({
          x: e.getBoundingClientRect().x,
          height: e.getBoundingClientRect().height,
          icons: e.querySelectorAll(".icon").length,
          clipped:
            e.scrollWidth > e.clientWidth || e.scrollHeight > e.clientHeight,
        })),
      );
    expect(rows).toHaveLength(7);
    for (const row of rows) {
      expect(Math.abs(row.x - rows[0].x)).toBeLessThanOrEqual(1);
      expect(Math.abs(row.height - rows[0].height)).toBeLessThanOrEqual(1);
      expect(row.icons).toBe(1);
      expect(row.height).toBeGreaterThanOrEqual(44);
      expect(row.clipped).toBe(false);
    }
  });
}
test("reference inspector inputs and status use one field height", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/costs-fixture.html");
  await page
    .getByRole("tab", { name: "Price references", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Edit Ghost(Pro) Business reference",
      exact: true,
    })
    .click();
  const fields = page
    .getByRole("dialog")
    .locator(".cost-ledger-comparison-edit > label > :is(input,select)");
  await expect
    .poll(async () => {
      const heights = await fields.evaluateAll((es) =>
        es.map((e) => e.getBoundingClientRect().height),
      );
      return Math.max(...heights) - Math.min(...heights);
    })
    .toBeLessThanOrEqual(1);
});

test("read-only Costs phone More hides both month mutation actions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/costs-fixture.html?state=readonly");
  await page
    .getByRole("button", { name: "More cost actions", exact: true })
    .click();
  const panel = page.locator("#workspace-more-panel");
  await expect(
    panel.getByRole("button", { name: "Download CSV", exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: /^What's new(?:, unread updates)?$/ })
      .getByText("What's new", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Close month", exact: true }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "Reopen month", exact: true }),
  ).toHaveCount(0);
});

for (const width of [390, 1440]) {
  test(`hardware conflict recovery replaces only hardware drafts at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/costs-fixture.html?state=hardware-conflict");
    await page.getByRole("tab", { name: "Hardware", exact: true }).click();
    await page
      .getByRole("button", {
        name: "Edit node-services assumptions",
        exact: true,
      })
      .click();
    const field = page.getByRole("textbox", {
      name: "node-services internet share",
      exact: true,
    });
    await field.fill("13.00");
    await page
      .getByRole("button", { name: "Save hardware assumptions", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText(
      "changed in the saved ledger",
    );
    await expect(page.getByRole("alert")).toContainText("other drafts stay");
    await page
      .getByRole("button", { name: "Reload hardware assumptions", exact: true })
      .click();
    await expect(field).toHaveValue("25.00");
    await expect(page.getByRole("alert")).toHaveCount(0);
    const session = await page.context().newCDPSession(page);
    try {
      await session.send("Accessibility.enable");
      const { nodes } = await session.send("Accessibility.getFullAXTree");
      const announcements = nodes.filter(
        (node) =>
          !node.ignored &&
          node.role?.value === "status" &&
          node.name?.value === "Hardware recovery",
      );
      expect(announcements).toHaveLength(1);
      expect(
        nodes.some(
          (node) =>
            !node.ignored &&
            node.name?.value ===
              "Hardware assumptions reloaded. Other drafts were kept.",
        ),
      ).toBe(true);
    } finally {
      await session.detach();
    }
    if (width < 1180) {
      await expect
        .poll(() =>
          page
            .getByRole("dialog")
            .evaluate((element) => element.contains(document.activeElement)),
        )
        .toBe(true);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
  });
}

for (const width of [390, 1440]) {
  test(`native month review keeps pending drafts and sends no write at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/costs-fixture.html");
    await page
      .getByRole("button", { name: "Google Cloud Platform", exact: true })
      .click();
    const field = page.getByRole("textbox", {
      name: "Google Cloud Platform amount for September 2026",
      exact: true,
    });
    await field.fill("-12.34");
    if (width < 1180) await page.keyboard.press("Escape");
    else
      await page
        .getByRole("button", { name: "Close details", exact: true })
        .click();
    await page
      .getByRole("button", { name: "More cost actions", exact: true })
      .click();
    await page
      .getByRole(width < 620 ? "button" : "menuitem", {
        name: "Close month",
        exact: true,
      })
      .click();
    const review = page.getByRole("dialog", {
      name: "Close September 2026?",
      exact: true,
    });
    await expect(review).toContainText("Resolve pending drafts first");
    await expect(
      review.getByRole("button", { name: "Close month", exact: true }),
    ).toBeDisabled();
    await review
      .getByRole("button", { name: "Keep reviewing", exact: true })
      .click();
    await expect(review).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Google Cloud Platform", exact: true })
      .click();
    await expect(field).toHaveValue("-12.34");
  });
}

for (const width of [390, 1440]) {
  test(`Costs trailing slash keeps the same shared chrome at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    for (const suffix of ["", "?trailing-slash=1"]) {
      await page.goto(`/costs-fixture.html${suffix}`);
      const chrome = page.locator(".workspace-chrome");
      await expect(
        chrome.getByRole("combobox", { name: "Ledger month" }),
      ).toBeVisible();
      await expect(
        chrome.getByRole("tablist", { name: "Cost tasks" }),
      ).toBeVisible();
      await expect(
        page.getByText("Known monthly total", { exact: true }).first(),
      ).toBeInViewport();
      if (width === 390) {
        await page
          .getByRole("button", { name: "More cost actions", exact: true })
          .click();
        const panel = page.locator("#workspace-more-panel");
        await expect(
          panel.getByRole("button", { name: "Download CSV", exact: true }),
        ).toBeVisible();
        await expect(
          panel.getByRole("button", {
            name: "Reload saved costs",
            exact: true,
          }),
        ).toBeVisible();
      } else {
        await expect(
          chrome.getByRole("link", { name: "Settings", exact: true }),
        ).toHaveAttribute("href", "/admin/settings");
      }
    }
  });
}
