import { expect, test, type Locator, type Page } from "./fixtures";
import { openSpecimen } from "./capture";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("njpbs-admin:navigation-collapsed", "false"));
});

const WIDTHS = [320, 390] as const;
const MODULE_ORDER = [
  "heading",
  "buildStatus",
  "milestone",
] as const;
const LONG_HEADING =
  "Newsroom coverage planning for central New Jersey communities and public media partners across the region";

interface BannerGeometry {
  afterBannerGap: number;
  bannerHeight: number;
  headingHeight: number;
  headingScrollWidth: number;
  headingClientWidth: number;
  headingStyles: {
    lineClamp: string;
    overflowY: string;
    overflowWrap: string;
    textOverflow: string;
    whiteSpace: string;
  };
  moduleContentSlack: number[];
  moduleGaps: number[];
  moduleOrder: string[];
  moduleOverflow: Array<{ horizontal: number; vertical: number }>;
  quickActionSizes: Array<{ height: number; width: number }>;
  rootClientWidth: number;
  rootScrollWidth: number;
  rowGap: number;
}

async function newsroomGeometry(page: Page): Promise<BannerGeometry> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const banner = document.querySelector<HTMLElement>(".newsroom-home-intro");
    const statusGrid = document.querySelector<HTMLElement>(".newsroom-status-grid");
    if (!banner || !statusGrid) throw new Error("The Newsroom home did not finish rendering");

    const modules = Array.from(
      banner.querySelectorAll<HTMLElement>(":scope > [data-banner-module]"),
    ).filter((module) => module.getClientRects().length > 0);
    const moduleRects = modules.map((module) => module.getBoundingClientRect());
    const bannerRect = banner.getBoundingClientRect();
    const heading = banner.querySelector<HTMLElement>(
      '[data-banner-module="heading"] h2',
    );
    if (!heading) throw new Error("The Newsroom banner heading is missing");
    const headingStyles = getComputedStyle(heading);

    const moduleContentSlack = modules.map((module) => {
      const moduleRect = module.getBoundingClientRect();
      const leafRects = Array.from(module.querySelectorAll<HTMLElement>("*"))
        .filter((element) => element.childElementCount === 0)
        .map((element) => element.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height > 0);
      if (leafRects.length === 0) throw new Error("A visible banner module has no content");
      const contentTop = Math.min(...leafRects.map((rect) => rect.top));
      const contentBottom = Math.max(...leafRects.map((rect) => rect.bottom));
      return moduleRect.height - (contentBottom - contentTop);
    });

    return {
      afterBannerGap: statusGrid.getBoundingClientRect().top - bannerRect.bottom,
      bannerHeight: bannerRect.height,
      headingHeight: heading.getBoundingClientRect().height,
      headingScrollWidth: heading.scrollWidth,
      headingClientWidth: heading.clientWidth,
      headingStyles: {
        lineClamp: headingStyles.webkitLineClamp,
        overflowY: headingStyles.overflowY,
        overflowWrap: headingStyles.overflowWrap,
        textOverflow: headingStyles.textOverflow,
        whiteSpace: headingStyles.whiteSpace,
      },
      moduleContentSlack,
      moduleGaps: moduleRects.slice(1).map((rect, index) => rect.top - moduleRects[index].bottom),
      moduleOrder: modules.map((module) => module.dataset.bannerModule ?? ""),
      moduleOverflow: modules.map((module) => ({
        horizontal: module.scrollWidth - module.clientWidth,
        vertical: module.scrollHeight - module.clientHeight,
      })),
      quickActionSizes: Array.from(
        document.querySelectorAll<HTMLElement>(
          '.newsroom-work-heading .home-shortcuts a, .newsroom-work-heading .home-shortcuts > button',
        ),
      ).map((control) => {
        const rect = control.getBoundingClientRect();
        return { height: rect.height, width: rect.width };
      }),
      rootClientWidth: root.clientWidth,
      rootScrollWidth: root.scrollWidth,
      rowGap: Number.parseFloat(getComputedStyle(banner).rowGap),
    };
  });
}

function expectCompactIntrinsicBanner(geometry: BannerGeometry): void {
  expect(geometry.moduleOrder).toEqual(MODULE_ORDER);
  expect(geometry.rowGap).toBe(24);
  expect(geometry.moduleGaps).toEqual([24, 24]);
  expect(geometry.afterBannerGap).toBeLessThan(0);
  expect(geometry.rootScrollWidth).toBe(geometry.rootClientWidth);
  expect(geometry.moduleOverflow).toHaveLength(MODULE_ORDER.length);
  for (const overflow of geometry.moduleOverflow) {
    expect(overflow.horizontal).toBeLessThanOrEqual(1);
    expect(overflow.vertical).toBeLessThanOrEqual(1);
  }
  expect(geometry.moduleContentSlack).toHaveLength(MODULE_ORDER.length);
  for (const slack of geometry.moduleContentSlack) expect(Math.abs(slack)).toBeLessThanOrEqual(1);
  expect(geometry.quickActionSizes).toHaveLength(3);
  for (const { height, width } of geometry.quickActionSizes) {
    expect(height).toBeGreaterThanOrEqual(44);
    expect(width).toBeGreaterThanOrEqual(44);
  }
}

async function expectUtilityPanelReachable(
  page: Page,
  panel: Locator,
  trigger: Locator,
  direction: "down" | "up",
  opensIntoWorkspace: boolean,
): Promise<void> {
  const geometry = await panel.evaluate((element, expectedDirection) => {
    const rect = element.getBoundingClientRect();
    const trigger = document.querySelector<HTMLElement>(
      element.classList.contains("view-options-panel")
        ? ".view-options-toggle"
        : ".account-menu-toggle",
    );
    const sidebar = document.querySelector<HTMLElement>(".sidebar");
    if (!trigger || !sidebar) throw new Error("Missing utility geometry target");
    const triggerRect = trigger.getBoundingClientRect();
    const sidebarRect = sidebar.getBoundingClientRect();
    // Sample the painted panel inside its rounded corner.
    const inset = Math.max(2, Number.parseFloat(getComputedStyle(element).borderTopRightRadius));
    const hit = document.elementFromPoint(rect.right - inset, rect.top + inset);
    return {
      bottom: rect.bottom,
      clientWidth: document.documentElement.clientWidth,
      left: rect.left,
      right: rect.right,
      clientHeight: element.clientHeight,
      overflowY: getComputedStyle(element).overflowY,
      scrollHeight: element.scrollHeight,
      sidebarRight: sidebarRect.right,
      top: rect.top,
      topRightReachable: hit instanceof Node && element.contains(hit),
      triggerBottom: triggerRect.bottom,
      triggerTop: triggerRect.top,
      viewportHeight: window.innerHeight,
      direction: expectedDirection,
    };
  }, direction);

  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.clientWidth);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.topRightReachable).toBe(true);
  expect(geometry.overflowY).toBe("auto");
  expect(geometry.scrollHeight).toBeGreaterThanOrEqual(geometry.clientHeight);
  if (opensIntoWorkspace) {
    expect(geometry.left).toBeGreaterThanOrEqual(geometry.sidebarRight - 1);
  }
  if (geometry.direction === "up") {
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.triggerTop - 4);
  } else {
    expect(geometry.top).toBeGreaterThanOrEqual(geometry.triggerBottom + 4);
  }
  const target = await trigger.boundingBox();
  if (!target) throw new Error("Missing utility trigger box");
  expect(target.width).toBeGreaterThanOrEqual(44);
  expect(target.height).toBeGreaterThanOrEqual(44);
  await expect(page.locator(".sidebar")).toHaveCSS("overflow-x", opensIntoWorkspace ? "visible" : "auto");
  await expect(page.locator(".sidebar")).toHaveCSS("overflow-y", opensIntoWorkspace ? "visible" : "auto");
}

async function expectShellGeometry(
  page: Page,
  mobile: boolean,
  minimumFooterGap = 8,
): Promise<void> {
  const geometry = await page.evaluate(() => {
    const root = document.documentElement;
    const sidebar = document.querySelector<HTMLElement>(".sidebar");
    const header = document.querySelector<HTMLElement>(".sidebar-header");
    const navigation = document.querySelector<HTMLElement>(".primary-nav");
    const footer = document.querySelector<HTMLElement>(".sidebar-footer");
    const workspace = document.querySelector<HTMLElement>(".workspace-shell");
    const view = document.querySelector<HTMLElement>(".view-options-toggle");
    const account = document.querySelector<HTMLElement>(".account-menu-toggle");
    const avatar = document.querySelector<HTMLElement>(".account-avatar");
    const adminSettings = navigation?.querySelector<HTMLElement>(
      'a[href="/admin/settings"]',
    );
    if (
      !sidebar ||
      !header ||
      !navigation ||
      !footer ||
      !workspace ||
      !view ||
      !account ||
      !avatar ||
      !adminSettings
    ) {
      throw new Error("The shell did not finish rendering");
    }
    const sidebarRect = sidebar.getBoundingClientRect();
    const navigationRect = navigation.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    const workspaceRect = workspace.getBoundingClientRect();
    const avatarRect = avatar.getBoundingClientRect();
    const avatarRadius = Number.parseFloat(getComputedStyle(avatar).borderTopLeftRadius);
    return {
      accountSize: account.getBoundingClientRect().toJSON(),
      adminSettingsInFooter: footer.contains(adminSettings),
      avatarCount: document.querySelectorAll(".sidebar .account-avatar").length,
      avatarHeight: avatarRect.height,
      avatarRadius,
      avatarWidth: avatarRect.width,
      footerBottomGap: sidebarRect.bottom - footerRect.bottom,
      footerClientWidth: footer.clientWidth,
      footerFollowsNavigation:
        (navigation.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      footerScrollWidth: footer.scrollWidth,
      footerTop: footerRect.top,
      headerContainsMenu: header.contains(
        document.querySelector<HTMLElement>(".menu-toggle"),
      ),
      navigationBottom: navigationRect.bottom,
      navigationClientHeight: navigation.clientHeight,
      navigationClientWidth: navigation.clientWidth,
      navigationOverflowY: getComputedStyle(navigation).overflowY,
      navigationScrollHeight: navigation.scrollHeight,
      navigationScrollWidth: navigation.scrollWidth,
      rootClientWidth: root.clientWidth,
      rootScrollWidth: root.scrollWidth,
      sidebarRight: sidebarRect.right,
      viewSize: view.getBoundingClientRect().toJSON(),
      workspaceLeft: workspaceRect.left,
      workspaceRight: workspaceRect.right,
    };
  });

  expect(geometry.footerFollowsNavigation).toBe(true);
  expect(geometry.adminSettingsInFooter).toBe(false);
  expect(geometry.avatarCount).toBe(1);
  expect(geometry.avatarWidth).toBeCloseTo(geometry.avatarHeight, 1);
  expect(geometry.avatarRadius).toBeGreaterThanOrEqual(geometry.avatarWidth / 2);
  expect(geometry.footerBottomGap).toBeGreaterThanOrEqual(minimumFooterGap);
  expect(geometry.footerBottomGap).toBeLessThanOrEqual(16);
  expect(geometry.navigationBottom).toBeLessThanOrEqual(geometry.footerTop);
  expect(geometry.navigationScrollHeight).toBeGreaterThanOrEqual(
    geometry.navigationClientHeight,
  );
  expect(geometry.navigationScrollWidth).toBeLessThanOrEqual(
    geometry.navigationClientWidth,
  );
  expect(geometry.footerScrollWidth).toBeLessThanOrEqual(
    geometry.footerClientWidth,
  );
  expect(geometry.rootScrollWidth).toBe(geometry.rootClientWidth);
  expect(geometry.headerContainsMenu).toBe(true);
  for (const target of [geometry.accountSize, geometry.viewSize]) {
    expect(target.width).toBeGreaterThanOrEqual(44);
    expect(target.height).toBeGreaterThanOrEqual(44);
  }
  if (mobile) {
    expect(geometry.workspaceLeft).toBeCloseTo(0, 0);
  } else {
    expect(geometry.navigationClientHeight).toBeGreaterThanOrEqual(44);
    expect(geometry.navigationOverflowY).toBe("auto");
    expect(geometry.workspaceLeft).toBeCloseTo(geometry.sidebarRight, 0);
  }
  expect(geometry.workspaceRight).toBeCloseTo(geometry.rootClientWidth, 0);
}

for (const height of [900, 260] as const) {
  for (const collapsed of [false, true] as const) {
    test(`Navigation footer stays usable in the ${collapsed ? "collapsed" : "expanded"} rail at 1280x${height}`, async ({
      page,
    }) => {
      await openSpecimen(page, {
        id: "shell-home",
        title: "Admin shell — newsroom home",
        width: 1280,
        presentation: "icons",
      });
      await page.setViewportSize({ width: 1280, height });

      const shell = page.locator(".app-shell");
      if (collapsed) {
        await page
          .getByRole("button", { name: "Collapse primary navigation" })
          .click();
      }
      await expect(shell).toHaveAttribute(
        "data-sidebar-collapsed",
        collapsed ? "true" : "false",
      );
      // Let the rail's width change settle before measuring its short-viewport budget.
      // The geometry requirements stay identical throughout this retry.
      await expect(async () => {
        await expectShellGeometry(page, false, height === 260 && collapsed ? 4 : 8);
      }).toPass({ timeout: 2_000 });

      const viewOptions = page.getByRole("button", { name: "View options" });
      await viewOptions.focus();
      await expect(page.locator('[role="tooltip"]')).toHaveText("View options");
      await page.keyboard.press("Escape");
      await viewOptions.click();
      const viewPanel = page.locator("#workspace-view-options");
      await expect(viewPanel).toBeVisible();
      await expectUtilityPanelReachable(page, viewPanel, viewOptions, "up", true);
      await viewOptions.click();
      await expect(viewPanel).toBeHidden();

      const account = page.getByRole("button", { name: /Account menu for/ });
      await account.click();
      const accountPanel = page.getByRole("menu");
      await expect(accountPanel).toBeVisible();
      await expectUtilityPanelReachable(page, accountPanel, account, "up", true);
      await page.keyboard.press("End");
      const lastAccountAction = accountPanel.getByRole("menuitem").last();
      await expect(lastAccountAction).toBeFocused();
      const accountScroll = await accountPanel.evaluate((panel) => {
        const panelRect = panel.getBoundingClientRect();
        const last = panel.querySelector<HTMLElement>('[role="menuitem"]:last-child');
        if (!last) throw new Error("Missing final account action");
        const lastRect = last.getBoundingClientRect();
        return {
          clientHeight: panel.clientHeight,
          lastBottom: lastRect.bottom,
          panelBottom: panelRect.bottom,
          scrollHeight: panel.scrollHeight,
          scrollTop: panel.scrollTop,
        };
      });
      expect(accountScroll.lastBottom).toBeLessThanOrEqual(accountScroll.panelBottom);
      if (accountScroll.scrollHeight > accountScroll.clientHeight) {
        expect(accountScroll.scrollTop).toBeGreaterThan(0);
      }
      const accountLabels = await accountPanel
        .locator(".account-menu-item > span")
        .evaluateAll((labels) =>
          labels.map((label) => {
            const rect = label.getBoundingClientRect();
            return { height: rect.height, width: rect.width };
          }),
        );
      expect(accountLabels).toHaveLength(3);
      for (const label of accountLabels) {
        expect(label.width).toBeGreaterThan(1);
        expect(label.height).toBeGreaterThan(1);
      }
      await page.keyboard.press("Escape");
      await expect(accountPanel).toBeHidden();

      await expect(page.locator(".primary-nav")).toHaveCSS("overflow-y", "auto");
    });
  }
}

test("The 320px navigation footer opens with contained popovers", async ({
  page,
}) => {
  await openSpecimen(page, {
    id: "shell-home",
    title: "Admin shell — newsroom home",
    width: 320,
    presentation: "icons",
  });
  const menu = page.getByRole("button", { name: "Open navigation", exact: true });
  await expect(page.locator("#sidebar-utilities")).toBeHidden();
  await menu.click();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Admin settings" })).toBeVisible();
  await expect(page.locator("#sidebar-utilities")).toBeVisible();
  await expectShellGeometry(page, true);

  const viewOptions = page.getByRole("button", { name: "View options" });
  const viewPanel = page.locator("#workspace-view-options");
  await viewOptions.click();
  await expect(viewPanel).toBeVisible();
  await expectUtilityPanelReachable(page, viewPanel, viewOptions, "up", false);
  await viewOptions.click();

  const account = page.getByRole("button", { name: /Account menu for/ });
  const accountPanel = page.getByRole("menu");
  await account.click();
  await expectUtilityPanelReachable(page, accountPanel, account, "up", false);
  await page.keyboard.press("End");
  await expect(accountPanel.getByRole("menuitem").last()).toBeFocused();
  await page.keyboard.press("Escape");
});

test("The density panel keeps readable control states on its light surface", async ({
  page,
}) => {
  await openSpecimen(page, {
    id: "shell-home",
    title: "Admin shell — newsroom home",
    width: 1280,
    presentation: "icons",
  });

  const viewOptions = page.getByRole("button", { name: "View options" });
  await viewOptions.click();

  const density = page.getByRole("radiogroup", { name: "Density" });
  const compact = density.getByRole("radio", { name: "Compact" });
  const comfortable = density.getByRole("radio", { name: "Comfortable" });

  // Study context surface, ink, quiet hover, disabled opacity and 2px ring.
  await expect(density).toHaveCSS("background-color", "rgb(237, 241, 246)");
  await expect(compact).toHaveCSS("color", "rgb(19, 34, 59)");
  await expect(comfortable).toHaveCSS("background-color", "rgb(226, 235, 255)");
  await expect(comfortable).toHaveCSS("color", "rgb(10, 20, 90)");

  await compact.hover();
  await expect(compact).toHaveCSS("background-color", "rgb(226, 231, 239)");
  await expect(compact).toHaveCSS("color", "rgb(19, 34, 59)");

  await viewOptions.focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "About layout density" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(comfortable).toBeFocused();
  await expect(comfortable).toHaveCSS("outline-color", "rgb(38, 56, 196)");
  await expect(comfortable).toHaveCSS("outline-style", "solid");
  await expect(comfortable).toHaveCSS("outline-width", "2px");

  await compact.evaluate((element) => {
    (element as HTMLButtonElement).disabled = true;
  });
  await expect(compact).toHaveCSS("cursor", "not-allowed");
  await expect(compact).toHaveCSS("opacity", "0.55");
});

for (const density of [
  { label: "Compact", value: "compact", target: 44 },
  { label: "Comfortable", value: "comfortable", target: 44 },
  { label: "Loose", value: "loose", target: 48 },
] as const) {
  test(`${density.label} density keeps the collapsed footer inside a 1280x260 viewport`, async ({
    page,
  }) => {
    await openSpecimen(page, {
      id: "shell-home",
      title: "Admin shell — newsroom home",
      width: 1280,
      presentation: "icons",
    });
    await page.setViewportSize({ width: 1280, height: 260 });

    const shell = page.locator(".app-shell");
    const viewOptions = page.getByRole("button", { name: "View options" });
    await viewOptions.click();
    await page.getByRole("radio", { name: density.label }).click();
    await expect(shell).toHaveAttribute("data-density", density.value);
    await viewOptions.click();
    await page
      .getByRole("button", { name: "Collapse primary navigation" })
      .click();
    await expect(shell).toHaveAttribute("data-sidebar-collapsed", "true");
    const sidebar = page.locator(".sidebar");
    await expect(sidebar).toHaveAttribute("data-collapsed", "true");
    await expect(sidebar).toHaveCSS("gap", "4px");
    await expect(sidebar).toHaveCSS("padding-top", "4px");
    await expect(sidebar).toHaveCSS("padding-bottom", "4px");

    const geometry = await page.evaluate(() => {
      const sidebar = document.querySelector<HTMLElement>(".sidebar");
      const header = document.querySelector<HTMLElement>(".sidebar-header");
      const brand = document.querySelector<HTMLElement>(".sidebar-header .brand-lockup");
      const navigation = document.querySelector<HTMLElement>(".primary-nav");
      const footer = document.querySelector<HTMLElement>(".sidebar-footer");
      const utilities = document.querySelector<HTMLElement>(".sidebar-footer-utilities");
      const collapse = document.querySelector<HTMLElement>(".sidebar-collapse-toggle");
      const view = document.querySelector<HTMLElement>(".view-options-toggle");
      const account = document.querySelector<HTMLElement>(".account-menu-toggle");
      if (
        !sidebar ||
        !header ||
        !brand ||
        !navigation ||
        !footer ||
        !utilities ||
        !collapse ||
        !view ||
        !account
      ) {
        throw new Error("Missing collapsed rail geometry");
      }
      const sidebarRect = sidebar.getBoundingClientRect();
      const footerRect = footer.getBoundingClientRect();
      const sidebarStyles = getComputedStyle(sidebar);
      return {
        accountHeight: account.getBoundingClientRect().height,
        brandHeight: brand.getBoundingClientRect().height,
        collapseHeight: collapse.getBoundingClientRect().height,
        footerBottom: footerRect.bottom,
        footerBottomGap: sidebarRect.bottom - footerRect.bottom,
        footerHeight: footerRect.height,
        headerHeight: header.getBoundingClientRect().height,
        navigationClientHeight: navigation.clientHeight,
        sidebarGap: Number.parseFloat(sidebarStyles.rowGap),
        sidebarPaddingBottom: Number.parseFloat(sidebarStyles.paddingBottom),
        sidebarPaddingTop: Number.parseFloat(sidebarStyles.paddingTop),
        sidebarBottom: sidebarRect.bottom,
        utilitiesHeight: utilities.getBoundingClientRect().height,
        viewHeight: view.getBoundingClientRect().height,
        viewportHeight: window.innerHeight,
      };
    });
    const receipt = `${density.label}: ${JSON.stringify(geometry)}`;
    // The common compact rail uses its 40px fine-pointer collapse target.
    // View options/account retain their separate legacy/density allocation.
    const collapseTarget = 40;
    const utilityTarget = 44;
    const availableNavigationHeight = 236 - collapseTarget - utilityTarget - density.target;
    expect(geometry.sidebarBottom, receipt).toBeLessThanOrEqual(geometry.viewportHeight);
    expect(geometry.footerBottom, receipt).toBeLessThanOrEqual(geometry.viewportHeight);
    expect(geometry.sidebarGap, receipt).toBe(4);
    expect(geometry.sidebarPaddingTop, receipt).toBe(4);
    expect(geometry.sidebarPaddingBottom, receipt).toBe(4);
    expect(geometry.brandHeight, receipt).toBe(0);
    expect(geometry.headerHeight, receipt).toBe(collapseTarget);
    expect(geometry.footerHeight, receipt).toBe(utilityTarget + density.target + 8);
    expect(geometry.utilitiesHeight, receipt).toBe(utilityTarget + density.target + 8);
    expect(geometry.footerBottomGap, receipt).toBe(4);
    // Complete-row fitting can leave spare space below the last visible destination.
    expect(geometry.navigationClientHeight, receipt).toBeGreaterThanOrEqual(40);
    expect(geometry.navigationClientHeight, receipt).toBeLessThanOrEqual(availableNavigationHeight);
    expect(geometry.collapseHeight, receipt).toBe(collapseTarget);
    expect(geometry.viewHeight, receipt).toBe(utilityTarget);
    expect(geometry.accountHeight, receipt).toBe(density.target);
    await expectShellGeometry(page, false, 4);
  });
}

test("The full mobile navigation scrolls above its footer at 320x260", async ({
  page,
}) => {
  await openSpecimen(page, {
    id: "shell-home",
    title: "Admin shell — newsroom home",
    width: 320,
    presentation: "icons",
  });
  await page.setViewportSize({ width: 320, height: 260 });
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();

  const navigation = page.getByRole("navigation", { name: "Primary" });
  const geometry = await navigation.evaluate((element) => {
    const sidebar = document.querySelector<HTMLElement>(".sidebar");
    const footer = document.querySelector<HTMLElement>(".sidebar-footer");
    if (!sidebar || !footer) throw new Error("Missing short mobile geometry");
    return {
      clientHeight: element.clientHeight,
      footerBottom: footer.getBoundingClientRect().bottom,
      overflowY: getComputedStyle(element).overflowY,
      scrollHeight: element.scrollHeight,
      sidebarBottom: sidebar.getBoundingClientRect().bottom,
      viewportHeight: window.innerHeight,
    };
  });
  expect(geometry.overflowY).toBe("auto");
  expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
  expect(geometry.sidebarBottom).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.footerBottom).toBeLessThanOrEqual(geometry.viewportHeight);

  const viewOptions = page.getByRole("button", { name: "View options" });
  const viewPanel = page.locator("#workspace-view-options");
  await viewOptions.click();
  await expectUtilityPanelReachable(page, viewPanel, viewOptions, "up", false);
  await viewOptions.click();

  const account = page.getByRole("button", { name: /Account menu for/ });
  const accountPanel = page.getByRole("menu");
  await account.click();
  await expectUtilityPanelReachable(page, accountPanel, account, "up", false);
  await page.keyboard.press("End");
  await expect(accountPanel.getByRole("menuitem").last()).toBeFocused();
});

test("A required-only mobile navigation leaves room for the upward account panel", async ({
  page,
}) => {
  await openSpecimen(page, {
    id: "shell-home-required-nav",
    title: "Admin shell — contributor required navigation",
    width: 320,
    presentation: "icons",
  });
  await page.setViewportSize({ width: 320, height: 260 });
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();

  const navigation = page.getByRole("navigation", { name: "Primary" });
  await expect(navigation.getByRole("link")).toHaveCount(2);
  await expect(navigation.getByRole("link", { name: "Home" })).toBeVisible();
  await expect(
    navigation.getByRole("link", { name: "Broadcast schedule" }),
  ).toBeVisible();
  const account = page.getByRole("button", { name: /Account menu for/ });
  const accountPanel = page.getByRole("menu");
  await account.click();
  await expectUtilityPanelReachable(page, accountPanel, account, "up", false);
  await page.keyboard.press("End");
  await expect(accountPanel.getByRole("menuitem").last()).toBeFocused();
});

for (const width of WIDTHS) {
  test(`Newsroom banner stays compact and intrinsic at ${width}px`, async ({ page }) => {
    await openSpecimen(page, {
      id: "shell-home",
      title: "Admin shell — newsroom home",
      width,
      presentation: "text",
    });

    const banner = page.getByRole("region", { name: "Newsroom banner" });
    const menu = page.locator(".workspace-header .editor-menu-trigger");
    const recentEdits = page.getByRole("link", { name: "My recent edits", exact: true });
    const assigned = page.getByRole("link", {
      name: "Assigned to me",
      exact: true,
    });
    const primaryNavigation = page.getByRole("navigation", { name: "Primary" });
    await expect(banner).toBeHidden();
    await expect(recentEdits).toBeVisible();
    await page.locator(".newsroom-system-status > summary").click();
    await expect(banner).toBeVisible();
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await expect(primaryNavigation).toBeHidden();

    const closed = await newsroomGeometry(page);
    expectCompactIntrinsicBanner(closed);

    // The disclosure was opened by pointer. Enter keyboard modality before checking its ring.
    await page.keyboard.press("Tab");
    await recentEdits.focus();
    await expect(recentEdits).toBeFocused();
    await expect(recentEdits).toHaveAttribute("href", "/content/library?owner=me&v=1");
    const focusOutline = await recentEdits.evaluate((control) => {
      const styles = getComputedStyle(control);
      return {
        style: styles.outlineStyle,
        width: Number.parseFloat(styles.outlineWidth),
      };
    });
    expect(focusOutline.style).toBe("solid");
    expect(focusOutline.width).toBe(2);
    await page.keyboard.press("Tab");
    await expect(assigned).toBeFocused();

    const heading = banner.locator('[data-banner-module="heading"] h2');
    await heading.evaluate((element, text) => {
      element.textContent = text;
    }, LONG_HEADING);
    await expect(heading).toHaveText(LONG_HEADING);

    const stressed = await newsroomGeometry(page);
    expectCompactIntrinsicBanner(stressed);
    expect(stressed.headingHeight).toBeGreaterThan(closed.headingHeight);
    expect(stressed.bannerHeight).toBeGreaterThan(closed.bannerHeight);
    expect(stressed.headingScrollWidth - stressed.headingClientWidth).toBeLessThanOrEqual(1);
    expect(stressed.headingStyles).toEqual({
      lineClamp: "none",
      overflowY: "visible",
      overflowWrap: "anywhere",
      textOverflow: "clip",
      whiteSpace: "normal",
    });

    await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await expect(primaryNavigation).toBeVisible();
    expectCompactIntrinsicBanner(await newsroomGeometry(page));
  });
}
