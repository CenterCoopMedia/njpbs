import { expect, type Page } from "@playwright/test";

/** These checks cannot be waived by accepting a new screenshot baseline. */
export async function assertControlDesign(page: Page): Promise<void> {
  const failures = await page.evaluate(() => {
    const problems: string[] = [];
    const root = getComputedStyle(document.documentElement);
    const radius = root.getPropertyValue("--cms-radius-button").trim();
    const resolveColor = (property: "background-color" | "border-color" | "color", value: string) => {
      const probe = document.createElement("span");
      probe.style.setProperty(property, value);
      probe.style.position = "fixed";
      probe.style.visibility = "hidden";
      document.body.append(probe);
      const resolved = getComputedStyle(probe).getPropertyValue(property);
      probe.remove();
      return resolved;
    };
    const roleColors = {
      primary: [
        resolveColor("background-color", "var(--color-action-primary)"),
        resolveColor("background-color", "var(--color-action-primary-hover)"),
        resolveColor("background-color", "var(--color-action-primary-pressed)"),
      ],
      danger: [
        resolveColor("background-color", "var(--color-action-danger)"),
        resolveColor("background-color", "var(--color-action-danger-hover)"),
        resolveColor("background-color", "var(--color-action-danger-pressed)"),
      ],
      secondary: [
        resolveColor("background-color", "var(--cms-action-secondary)"),
        resolveColor("background-color", "var(--cms-action-secondary-hover)"),
        resolveColor("background-color", "var(--cms-action-secondary-pressed)"),
      ],
      secondaryText: resolveColor("color", "var(--cms-action-secondary-text)"),
      secondaryBorder: resolveColor("border-color", "var(--cms-action-secondary-border)"),
      secondaryHoverBorder: resolveColor("border-color", "var(--cms-action-secondary-border-hover)"),
      quiet: [
        resolveColor("background-color", "var(--cms-action-quiet)"),
        resolveColor("background-color", "var(--cms-action-quiet-hover)"),
        resolveColor("background-color", "var(--cms-action-quiet-pressed)"),
      ],
      quietText: resolveColor("color", "var(--cms-action-quiet-text)"),
      quietBorder: resolveColor("border-color", "var(--cms-action-quiet-border)"),
      inverse: resolveColor("background-color", "var(--cms-sidebar-raised)"),
      inverseText: resolveColor("color", "var(--cms-sidebar-text)"),
      inverseBorder: resolveColor("border-color", "var(--cms-control-border)"),
      inverseHeader: [
        resolveColor("background-color", "var(--cms-sidebar-raised)"),
        resolveColor("background-color", "var(--cms-sidebar-hover)"),
      ],
      inverseHeaderText: resolveColor("color", "var(--cms-sidebar-text)"),
      inverseHeaderBorder: resolveColor("border-color", "var(--cms-sidebar-line)"),
    };
    const requiredRoleTokens = [
      "--color-action-primary",
      "--color-action-primary-hover",
      "--color-action-primary-pressed",
      "--color-action-danger",
      "--color-action-danger-hover",
      "--color-action-danger-pressed",
      "--cms-action-secondary",
      "--cms-action-secondary-hover",
      "--cms-action-secondary-pressed",
      "--cms-action-secondary-text",
      "--cms-action-secondary-border",
      "--cms-action-secondary-border-hover",
      "--cms-action-quiet",
      "--cms-action-quiet-hover",
      "--cms-action-quiet-pressed",
      "--cms-action-quiet-text",
      "--cms-action-quiet-border",
    ];
    const missingRoleTokens = requiredRoleTokens.filter(
      (token) => root.getPropertyValue(token).trim() === "",
    );
    if (missingRoleTokens.length > 0) {
      problems.push(`CMS theme is missing semantic action tokens: ${missingRoleTokens.join(", ")}`);
    }
    const prohibitedSupportingFills = new Set([
      ...roleColors.primary,
      ...roleColors.danger,
      resolveColor("background-color", "var(--cms-positive)"),
      resolveColor("background-color", "var(--cms-brand-green)"),
      resolveColor("background-color", "var(--cms-brand-green-strong)"),
      resolveColor("background-color", "var(--cms-brand-green-hover)"),
      resolveColor("background-color", "var(--cms-brand-green-pressed)"),
    ]);
    const controls = document.querySelectorAll<HTMLElement>(
      ".button, .editor-bento-collapse, .editor-bento-grip, .editor-tag-remove, " +
      ".content-index-row-actions > a, .content-index-row-actions > button",
    );
    const surface = (element: Element): string => {
      let current: Element | null = element;
      while (current) {
        const color = getComputedStyle(current).backgroundColor;
        if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent") return color;
        current = current.parentElement;
      }
      return "rgb(255, 255, 255)";
    };
    const luminance = (color: string): number => {
      const channels = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const [r, g, b] = channels.map(value => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const groups = new Map<Element, { name: string; box: DOMRect }[]>();
    for (const control of controls) {
      if (!control.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      const style = getComputedStyle(control);
      const box = control.getBoundingClientRect();
      const name = control.getAttribute("aria-label") || control.innerText.trim() || control.className;
      const fail = (detail: string) => problems.push(`${name}: ${detail}`);
      const compact = control.matches(".button-size-compact, .info-tooltip-trigger");
      const standard = control.matches(".button-size-standard");
      const coarse = matchMedia("(any-pointer: coarse)").matches;
      const navigation = control.matches(".app-shell .nav-item.button");
      const studyFilter = control.matches('.content-library-views > .button[aria-pressed], .content-library-saved-view > .button[aria-pressed]');
      const navigationTarget = Number.parseFloat(style.getPropertyValue("--cms-nav-row-height"));
      const minimumTarget = coarse ? 44 : navigation ? navigationTarget : !compact && !standard ? 44 : compact ? 32 : 36;
      if (box.height < minimumTarget - 0.5) fail(`target height is ${box.height}px; minimum ${minimumTarget}px`);
      if (control.matches('.action-control-icon[data-action="add-item"], .action-control-icon[data-action="remove-item"]')) {
        if (box.width < minimumTarget - 0.5) fail(`contextual target width is ${box.width}px`);
        if (box.width > box.height + 1) fail("contextual icon has expanded into a descriptive-button footprint");
        if (!control.getAttribute("aria-label")?.trim()) fail("contextual icon lacks its action-and-target name");
        if (control.matches('.button-danger, .button-primary')) fail("local list action uses excessive visual emphasis");
      }
      if (control.scrollWidth > control.clientWidth + 1) fail("content exceeds button width");
      for (const corner of [style.borderTopLeftRadius, style.borderTopRightRadius,
        style.borderBottomLeftRadius, style.borderBottomRightRadius]) {
        const expectedRadius = studyFilter ? "0px" : radius;
        if (corner !== expectedRadius) fail(`corner ${corner} differs from ${expectedRadius}`);
      }
      if (studyFilter) {
        if (style.backgroundColor !== "rgba(0, 0, 0, 0)" || style.paddingLeft !== "0px" || style.paddingRight !== "0px" ||
          style.paddingBottom !== "9px" || style.borderBottomWidth !== "2px") fail("filter does not use the measured study tab anatomy");
        const selectedEdge = resolveColor("border-color", "var(--cms-brand)");
        if (style.borderBottomColor !== (control.getAttribute("aria-pressed") === "true" ? selectedEdge : "rgba(0, 0, 0, 0)")) {
          fail("filter underline does not match its pressed state");
        }
      }
      if (!control.matches(':disabled, [aria-disabled="true"]')) {
        const fill = style.backgroundColor;
        if (control.matches(".button-primary") && !roleColors.primary.includes(fill)) {
          fail("primary action does not use the canonical primary background");
        }
        if (control.matches(".button-danger") && !roleColors.danger.includes(fill)) {
          fail("danger action does not use the canonical danger background");
        }

        if (control.matches(".button-danger-quiet")) {
          const states = ["", "-hover", "-pressed"];
          const fills = ["rgba(0, 0, 0, 0)", ...roleColors.quiet];
          const inks = states.map(state => resolveColor("color", `var(--cms-danger${state})`));
          if (!fills.includes(fill) || !inks.includes(style.color) || style.borderTopColor !== "rgba(0, 0, 0, 0)") {
            fail("quiet danger action does not use its canonical red role");
          }
        }

        const supportingRole = control.matches(".button-secondary, .button-ghost");
        const inverseRowControl = Boolean(control.closest(".content-row-toolbar"));
        const quietRailToggle = control.matches(".app-shell .sidebar-collapse-toggle");
        const inverseSidebarControl = !quietRailToggle && control.matches(".sidebar-collapse-toggle, .view-options-toggle, .menu-toggle") &&
          Boolean(control.closest(".sidebar"));
        const inverseHeaderControl = Boolean(control.closest(".component-editor-dialog-header:not([data-media-preview])"));
        // #3552 / media refinement "The reference workspace": the media frame
        // now has pale chrome and uses the ordinary neutral quiet role.
        const paleMediaHeader = Boolean(control.closest('.component-editor-dialog[data-framing="media"] > .component-editor-dialog-header[data-media-preview]'));
        const inverseQuietControl = !paleMediaHeader && control.matches(".button-ghost") && Boolean(control.closest(".component-editor-dialog-header[data-media-preview]"));
        const contextualControl = quietRailToggle || inverseRowControl || inverseSidebarControl || inverseHeaderControl || inverseQuietControl ||
          control.matches('[aria-pressed], [aria-expanded="true"], [role="tab"]') ||
          control.closest('nav, [role="navigation"]');
        if (!contextualControl && control.matches(".button-secondary, .button-ghost") &&
          prohibitedSupportingFills.has(fill)) {
          fail("supporting action uses a primary, danger, or green background");
        }
        if (inverseRowControl || inverseSidebarControl) {
          if (fill !== roleColors.inverse) fail("inverse action does not use its inverse background");
          if (style.color !== roleColors.inverseText) fail("inverse action does not use its inverse text color");
          if (style.borderTopColor !== roleColors.inverseBorder) fail("inverse action does not use its inverse border");
        }
        if (quietRailToggle && (fill !== "rgba(0, 0, 0, 0)" || style.borderTopColor !== "rgba(0, 0, 0, 0)" || style.color !== roleColors.inverseText)) {
          fail("shared rail toggle does not use its quiet inverse role");
        }
        if (inverseHeaderControl) {
          if (!roleColors.inverseHeader.includes(fill)) fail("inverse header action does not use its inverse background");
          if (style.color !== roleColors.inverseHeaderText) fail("inverse header action does not use its inverse text color");
          if (style.borderTopColor !== roleColors.inverseHeaderBorder) fail("inverse header action does not use its inverse border");
        }
        if (inverseQuietControl && !control.matches('[aria-pressed="true"], [aria-expanded="true"]')) {
          if (!["rgba(0, 0, 0, 0)", ...roleColors.inverseHeader].includes(fill)) fail("inverse quiet action has an unexpected fill");
          if (style.color !== roleColors.inverseText) fail("inverse quiet action lacks inverse text");
          if (style.borderTopColor !== "rgba(0, 0, 0, 0)") fail("inverse quiet action has an unexpected border");
        }
        const canonicalNeutral = !contextualControl;
        if (canonicalNeutral && control.matches(".button-secondary")) {
          if (!roleColors.secondary.includes(fill)) fail("secondary action does not use its neutral background");
          if (style.color !== roleColors.secondaryText) fail("secondary action does not use its neutral text color");
          if (style.borderTopColor !== (control.matches(":hover") ? roleColors.secondaryHoverBorder : roleColors.secondaryBorder)) fail("secondary action does not use its state border");
        }
        if (canonicalNeutral && control.matches(".button-ghost")) {
          if (!roleColors.quiet.includes(fill)) fail("quiet action does not use its neutral background");
          if (style.color !== roleColors.quietText) fail("quiet action does not use its neutral text color");
          const activeQuiet = control.matches(':hover, :focus-visible, :active');
          const expectedBorder = activeQuiet ? roleColors.quietBorder : "rgba(0, 0, 0, 0)";
          if (style.borderTopColor !== expectedBorder) fail("quiet action does not use its state border");
        }
        if (canonicalNeutral && control.matches(".button-secondary")) {
          const borderWidth = Number.parseFloat(style.borderTopWidth);
          if (style.borderTopStyle === "none" || borderWidth < 1 || style.borderTopColor === fill) {
            fail("supporting action does not have a distinct visible border");
          }
        }

        const normalizedName = name.replace(/\s+/g, " ").trim();
        if (/^(?:cancel(?: changes| this choice)?$|close\b|dismiss\b|back\b|keep editing$|keep row$)/i.test(normalizedName)) {
          if (control.matches(".button-primary, .button-danger, .button-danger-quiet")) {
            fail("cancel, close, back, and dismiss actions must use a supporting role");
          }
          if (prohibitedSupportingFills.has(fill)) {
            fail("cancel, close, back, or dismiss action uses a primary, danger, or green background");
          }
        }
        const foreground = luminance(style.color);
        const background = luminance(surface(control));
        const contrast = (Math.max(foreground, background) + 0.05) /
          (Math.min(foreground, background) + 0.05);
        if (!Number.isFinite(contrast) || contrast < 4.5) fail(`text contrast is ${contrast.toFixed(2)}:1`);
      }
      const group = control.closest(
        ".content-index-row-actions, .button-row, .toolbar, .editor-bento-card-header, .editor-tag-controls, .editor-list-item-controls, .story-credit-controls",
      );
      if (group) {
        const siblings = groups.get(group) ?? [];
        for (const sibling of siblings) {
          const overlapX = Math.min(box.right, sibling.box.right) - Math.max(box.left, sibling.box.left);
          const overlapY = Math.min(box.bottom, sibling.box.bottom) - Math.max(box.top, sibling.box.top);
          if (overlapX > 1 && overlapY > 1) fail(`overlaps ${sibling.name}`);
        }
        siblings.push({ name, box });
        groups.set(group, siblings);
      }
      // Visible label text must have room inside its own control. Hidden accessible
      // names and reserve labels are excluded; SVG-only actions have no text node.
      const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.textContent?.trim() || !(node.parentElement instanceof HTMLElement)) continue;
        const parent = node.parentElement;
        if (parent.closest('[aria-hidden="true"], .sr-only, .visually-hidden')) continue;
        if (!parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
        if (getComputedStyle(parent).clipPath === "inset(50%)") continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const text = range.getBoundingClientRect();
        if (text.width < 1 || text.height < 1) continue;
        const labelInset = studyFilter ? 0 : 6;
        if (text.left < box.left + labelInset || text.right > box.right - labelInset) fail("label lacks horizontal padding");
        if (text.top < box.top || text.bottom > box.bottom + 1) fail("label extends outside button");
      }
    }
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) {
      problems.push("page content exceeds viewport width");
    }
    return [...new Set(problems)];
  });
  expect(failures, "Rendered controls must satisfy the shared design contract").toEqual([]);
}
