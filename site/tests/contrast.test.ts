import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { relativeLuminance, contrastRatio, meetsAA, compositeOver } from "../src/lib/contrast";

describe("relativeLuminance", () => {
  it("is 0 for black and 1 for white", () => {
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
  });
});

describe("contrastRatio", () => {
  it("is 21:1 for black on white", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
  });

  it("is 1:1 for identical colors", () => {
    expect(contrastRatio("#3b6fb0", "#3b6fb0")).toBeCloseTo(1, 5);
  });

  it("is symmetric — order of fg/bg does not change the ratio", () => {
    const a = contrastRatio("#1746c4", "#ffffff");
    const b = contrastRatio("#ffffff", "#1746c4");
    expect(a).toBeCloseTo(b, 6);
  });

  it("matches the synthesis-computed heritage-blue-on-white value (~7.75)", () => {
    expect(contrastRatio("#1746c4", "#ffffff")).toBeCloseTo(7.75, 1);
  });
});

describe("meetsAA", () => {
  it("requires 4.5:1 for normal text", () => {
    expect(meetsAA(4.5)).toBe(true);
    expect(meetsAA(4.49)).toBe(false);
  });

  it("requires only 3:1 for large text / UI", () => {
    expect(meetsAA(3, { large: true })).toBe(true);
    expect(meetsAA(2.99, { large: true })).toBe(false);
  });
});

// Lock the shared semantic tokens to WCAG AA. The archived theme chooser keeps
// its own kit test, but the live site reads this one source. Pairings name token
// roles rather than component selectors so a component cannot quietly redefine
// what “muted text” or “focus ring” means.
const readSource = (rel: string): string =>
  existsSync(fileURLToPath(new URL(rel, import.meta.url)))
    ? readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
    : "";

const tokenSource = readSource("../src/styles/design-tokens.css");
const notFoundSource = readSource("../src/pages/404.astro");
const notFoundStyleSource = readSource("../src/styles/not-found.css");
const publicSiteLayoutSource = readSource("../src/layouts/PublicSiteLayout.astro");
const servicePageStyleSource = readSource("../src/styles/service-page.css");
const resultsStyleSource = readSource("../../packages/content-core/src/election-results.css");

it("election filter control edges meet the 3:1 non-text contrast requirement", () => {
  const rule = resultsStyleSource.match(/\.election-results__filters :is\(input, select\)\s*\{([^}]+)\}/)?.[1] ?? "";
  const borderToken = rule.match(/border:\s*1px solid var\((--[\w-]+)\)/)?.[1];
  expect(borderToken).toBeTruthy();
  const border = resultsStyleSource.match(new RegExp(`${borderToken}:\\s*(#[0-9a-fA-F]+);`))?.[1] ?? "";
  expect(border).toMatch(/^#/);
  for (const surface of ["#ffffff", token("color-nj-decides-paper")]) {
    expect(contrastRatio(border, surface)).toBeGreaterThanOrEqual(3);
  }
});

function token(name: string, seen = new Set<string>()): string {
  if (seen.has(name)) throw new Error(`CSS token cycle at --${name}`);
  seen.add(name);

  const match = tokenSource.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!match) return "";
  const value = match[1].trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(value)) return value;

  const alias = value.match(/^var\(--([a-zA-Z0-9-]+)\)$/);
  return alias ? token(alias[1], seen) : "";
}

interface TokenPairing {
  name: string;
  fg: string;
  bg: string;
}

interface MeasuredTokenPairing extends TokenPairing {
  ratio: number;
}

const LIGHT_SURFACE_TEXT_PAIRINGS: TokenPairing[] = [
  { name: "wiki text on paper", fg: "color-light-text", bg: "color-paper" },
  { name: "wiki muted text on paper", fg: "color-light-text-muted", bg: "color-paper" },
  { name: "wiki link on paper", fg: "color-light-link", bg: "color-paper" },
  { name: "wiki body copy on paper", fg: "color-light-body", bg: "color-paper" },
  { name: "wiki link on soft surface", fg: "color-light-link", bg: "color-light-surface-soft" },
  { name: "wiki link on current blue surface", fg: "color-light-link", bg: "color-light-surface-blue-strong" },
  { name: "wiki badge link on muted surface", fg: "color-light-link", bg: "color-light-surface-muted" },
  { name: "wiki blue notice copy", fg: "color-light-blue-copy", bg: "color-light-surface-blue" },
  { name: "wiki note text", fg: "color-light-note-text", bg: "color-light-note" },
  { name: "schedule fallback copy on paper", fg: "color-light-copy", bg: "color-paper" },
  { name: "schedule fallback link on paper", fg: "color-light-link-strong", bg: "color-paper" },
  { name: "schedule fallback hover link on paper", fg: "color-light-heading", bg: "color-paper" },
];

const TEXT_PAIRINGS: TokenPairing[] = [
  ...["page", "panel", "elevated", "current"].flatMap((surface) => [
    {
      name: `primary text on ${surface}`,
      fg: "color-text-on-surface",
      bg: `color-surface-${surface}`,
    },
    {
      name: `muted text on ${surface}`,
      fg: "color-text-muted",
      bg: `color-surface-${surface}`,
    },
    {
      name: `quiet metadata on ${surface}`,
      fg: "color-text-quiet",
      bg: `color-surface-${surface}`,
    },
  ]),
  { name: "link on page", fg: "color-link", bg: "color-surface-page" },
  { name: "link on elevated surface", fg: "color-link", bg: "color-surface-elevated" },
  { name: "text on brand", fg: "color-text-on-brand", bg: "color-brand" },
  { name: "text on bright brand", fg: "color-text-on-brand", bg: "color-brand-bright" },
  { name: "text on red action", fg: "color-text-on-action", bg: "color-action" },
  { name: "green status on panel", fg: "color-status", bg: "color-surface-panel" },
  { name: "green status on elevated surface", fg: "color-status", bg: "color-surface-elevated" },
  { name: "green progress on track", fg: "color-status", bg: "color-progress-track" },
  { name: "dark label on focus", fg: "color-ink", bg: "color-focus-ring" },
  { name: "primary schedule text on brand", fg: "color-text-on-surface", bg: "color-brand" },
  { name: "schedule current date on brand", fg: "color-schedule-current-date-text", bg: "color-brand" },
  { name: "schedule hour on rail", fg: "color-schedule-hour-text", bg: "color-schedule-rail-surface" },
  { name: "schedule primetime text on panel", fg: "color-schedule-primetime-text", bg: "color-surface-panel" },
  { name: "schedule time on panel", fg: "color-schedule-time-text", bg: "color-surface-panel" },
  { name: "schedule time on elevated surface", fg: "color-schedule-time-text", bg: "color-surface-elevated" },
  { name: "schedule time on program hover", fg: "color-schedule-time-text", bg: "color-schedule-program-hover-surface" },
  { name: "primary text on program hover", fg: "color-text-on-surface", bg: "color-schedule-program-hover-surface" },
  { name: "muted text on program hover", fg: "color-text-muted", bg: "color-schedule-program-hover-surface" },
  { name: "quiet text on program hover", fg: "color-text-quiet", bg: "color-schedule-program-hover-surface" },
  { name: "schedule link on elevated surface", fg: "color-schedule-link", bg: "color-surface-elevated" },
  { name: "schedule print ink on paper", fg: "color-print-ink", bg: "color-paper" },
  ...LIGHT_SURFACE_TEXT_PAIRINGS,
];

describe("semantic text colors meet WCAG AA", () => {
  it.each(TEXT_PAIRINGS)(
    "$name clears the AA threshold",
    ({ fg: fgName, bg: bgName }) => {
      const fg = token(fgName);
      const bg = token(bgName);
      expect(fg, `--${fgName} must resolve to a hex color`).toMatch(/^#/);
      expect(bg, `--${bgName} must resolve to a hex color`).toMatch(/^#/);
      expect(meetsAA(contrastRatio(fg, bg))).toBe(true);
    },
  );
});

// WCAG 1.4.11 (non-text contrast) needs 3:1 for the visual information that
// identifies a UI component or its state, separate from the 1.4.3 text gate.
// The 3px focus ring sits outside each component, so its adjacent color is the
// surface. The approved concept-4 dark ring (#aeb7ff) stays on dark surfaces
// where its lowest live ratio is 7.82:1; white/light surfaces use the PBS blue
// ring at 8.59:1 because #aeb7ff on white is only 1.91:1.
const NON_TEXT_PAIRINGS: TokenPairing[] = [
  { name: "Data Hub gridlines on page", fg: "color-data-hub-comparison-edge", bg: "bg-0" },
  ...["page", "panel", "elevated", "current"].map((surface) => ({
    name: `focus ring on ${surface}`,
    fg: "color-focus-ring",
    bg: `color-surface-${surface}`,
  })),
  { name: "focus ring on light surface", fg: "color-focus-ring-on-light", bg: "color-paper" },
  { name: "green progress on track", fg: "color-status", bg: "color-progress-track" },
  { name: "schedule print border on paper", fg: "color-schedule-print-border", bg: "color-paper" },
];

const FOCUS_RING_PAIRINGS: MeasuredTokenPairing[] = [
  { name: "dark focus ring on page", fg: "color-focus-ring", bg: "color-surface-page", ratio: 10.54 },
  { name: "dark focus ring on panel", fg: "color-focus-ring", bg: "color-surface-panel", ratio: 10.06 },
  { name: "dark focus ring on elevated surface", fg: "color-focus-ring", bg: "color-surface-elevated", ratio: 9.15 },
  { name: "dark focus ring on current surface", fg: "color-focus-ring", bg: "color-surface-current", ratio: 7.82 },
  { name: "light focus ring on paper", fg: "color-focus-ring-on-light", bg: "color-paper", ratio: 8.59 },
];

interface SourceFocusRoot {
  name: string;
  selector: string;
  source: string;
}

const LIGHT_SURFACE_FOCUS_ROOTS: SourceFocusRoot[] = [
  { name: "public shell skip link", selector: ".skip:focus", source: publicSiteLayoutSource },
  {
    name: "schedule white widget frame",
    selector: ".public-page__schedule-frame",
    source: servicePageStyleSource,
  },
  {
    name: "schedule unavailable status card",
    selector: ".public-page__schedule-status",
    source: servicePageStyleSource,
  },
];

function cssRule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  return match?.[1] ?? "";
}

describe("non-text UI colors meet WCAG 1.4.11 (3:1)", () => {
  it.each(NON_TEXT_PAIRINGS)(
    "$name clears the 3:1 non-text threshold",
    ({ fg: fgName, bg: bgName }) => {
      const fg = token(fgName);
      const bg = token(bgName);
      expect(fg, `--${fgName} must resolve to a hex color`).toMatch(/^#/);
      expect(bg, `--${bgName} must resolve to a hex color`).toMatch(/^#/);
      expect(meetsAA(contrastRatio(fg, bg), { large: true })).toBe(true);
    },
  );
});

describe("the footer motion toggle keeps a 3:1 visible boundary", () => {
  it("uses current text color for the switch edge in both states", () => {
    expect(cssRule(publicSiteLayoutSource, ".motion-toggle__switch")).toContain(
      "border: 1px solid currentColor;",
    );

    const background = token("color-surface-page");
    for (const foreground of ["color-text-muted", "color-text-on-surface"]) {
      const ratio = contrastRatio(token(foreground), background);
      expect(
        meetsAA(ratio, { large: true }),
        `--${foreground} is ${ratio.toFixed(2)}:1 on the footer`,
      ).toBe(true);
    }
  });
});

describe("focus ring tokens meet WCAG 1.4.11 on live dark and light surfaces", () => {
  it("keeps the redesigned 404 and its skip link on the tested dark focus surface", () => {
    expect(notFoundSource).toContain('import "../styles/not-found.css"');
    expect(notFoundSource).toContain('class="nf-page"');
    for (const selector of [".nf-page", ".nf-skip:focus"]) {
      expect(cssRule(notFoundStyleSource, selector)).toContain("background: var(--color-surface-page);");
    }
    expect(notFoundStyleSource).not.toMatch(/--color-focus-ring\s*:/);
    expect(meetsAA(contrastRatio(token("color-focus-ring"), token("color-surface-page")), { large: true })).toBe(true);
  });

  it.each(FOCUS_RING_PAIRINGS)(
    "$name has the documented $ratio:1 contrast ratio",
    ({ fg: fgName, bg: bgName, ratio: expectedRatio }) => {
      const fg = token(fgName);
      const bg = token(bgName);
      expect(fg, `--${fgName} must resolve to a hex color`).toMatch(/^#/);
      expect(bg, `--${bgName} must resolve to a hex color`).toMatch(/^#/);

      const measuredRatio = contrastRatio(fg, bg);
      expect(measuredRatio).toBeCloseTo(expectedRatio, 2);
      expect(meetsAA(measuredRatio, { large: true })).toBe(true);
    },
  );

  it.each(LIGHT_SURFACE_FOCUS_ROOTS)(
    "$name inherits the light-surface focus ring",
    ({ selector, source }) => {
      expect(cssRule(source, selector), selector).toContain(
        "--color-focus-ring: var(--color-focus-ring-on-light);",
      );
    },
  );
});

describe("compositeOver flattens a translucent layer the way a browser paints it", () => {
  it("returns the overlay at alpha 1 and the backdrop at alpha 0", () => {
    expect(compositeOver("#2638c4", 1, "#ffffff")).toBe("#2638c4");
    expect(compositeOver("#2638c4", 0, "#ffffff")).toBe("#ffffff");
  });

  it("blends channel-wise in gamma-encoded sRGB, not linear light", () => {
    // Half black over white is #808080 in sRGB. Compositing in linearized space
    // would land near #bcbcbc, so this pins the color space as well as the math.
    expect(compositeOver("#000000", 0.5, "#ffffff")).toBe("#808080");
  });

  it("rejects an alpha passed as a percentage", () => {
    expect(() => compositeOver("#000000", 72, "#ffffff")).toThrow(RangeError);
  });
});

// WCAG 1.4.11 for a control on .site-head cannot be measured token-against-token,
// because that header is translucent: the color actually painted behind the donate
// button is the header's rgba flattened onto whatever is scrolling beneath it, and a
// white content card (.public-page__schedule-frame) already passes under it on
// subpages. The brand fill cannot hold the boundary there, measuring 2.34:1 over
// the page and 1.01:1 under that white card, so --color-control-edge-on-glass
// carries it instead. #336
interface HeaderLayer {
  label: string;
  hex: string;
  alpha: number;
}

function headerGlassLayers(source: string): HeaderLayer[] {
  const toHex = (n: number) => n.toString(16).padStart(2, "0");
  const layers: HeaderLayer[] = [];
  for (const [, selector, body] of source.matchAll(
    /([^{}]*\.site-head[^{}]*)\{([^{}]*)\}/g,
  )) {
    const rgba = body.match(
      /background:\s*rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/,
    );
    if (!rgba) continue;
    layers.push({
      // Drop any comment sitting above the rule, which the selector capture
      // otherwise sweeps in and turns into an unreadable test name.
      label: selector.replace(/\/\*[\s\S]*?\*\//g, "").trim().replace(/\s+/g, " "),
      hex: `#${toHex(Number(rgba[1]))}${toHex(Number(rgba[2]))}${toHex(Number(rgba[3]))}`,
      alpha: Number(rgba[4]),
    });
  }
  return layers;
}

const GLASS_LAYERS = headerGlassLayers(publicSiteLayoutSource);

describe("the static Home lead remains readable over source photography", () => {
  it("keeps all copy roles above 4.5:1 at the weakest scrim stop, even over white", () => {
    const rgba = tokenSource.match(/--color-home-lead-scrim:\s*rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/);
    expect(rgba).not.toBeNull();
    const hex = `#${rgba!.slice(1, 4).map(value => Number(value).toString(16).padStart(2, "0")).join("")}`;
    for (const background of ["#000000", "#ffffff"]) {
      const painted = compositeOver(hex, Number(rgba![4]), background);
      for (const foreground of ["color-text-on-surface", "color-text-muted", "color-link"]) {
        expect(contrastRatio(token(foreground), painted), `${foreground} over ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(readSource("../src/styles/home-editorial.css")).toContain(
      "background: linear-gradient(180deg, var(--color-home-lead-scrim), var(--color-surface-page));",
    );
  });
});

describe("Latest stories remain readable over source photography", () => {
  it("keeps every copy role above 4.5:1 over black and white source pixels", () => {
    const rgba = tokenSource.match(/--color-home-story-scrim:\s*rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/);
    expect(rgba).not.toBeNull();
    const hex = `#${rgba!.slice(1, 4).map(value => Number(value).toString(16).padStart(2, "0")).join("")}`;
    for (const background of ["#000000", "#ffffff"]) {
      const painted = compositeOver(hex, Number(rgba![4]), background);
      for (const foreground of ["color-text-on-surface", "color-text-muted", "color-link"]) {
        expect(contrastRatio(token(foreground), painted), `${foreground} over ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(cssRule(readSource("../src/styles/home-editorial.css"), ".home-editorial__headline-media::after")).toContain(
      "background: var(--color-home-story-scrim);",
    );
  });
});

describe("the donate button keeps a 3:1 boundary on the translucent header", () => {
  it("finds every translucent .site-head variant in the layout", () => {
    // Both the frosted default and the opaque-leaning data-saver override, so a
    // change to either opacity is measured rather than assumed.
    expect(GLASS_LAYERS.length).toBeGreaterThanOrEqual(2);
  });

  it("declares the edge on .donate rather than relying on the fill", () => {
    expect(cssRule(publicSiteLayoutSource, ".donate")).toContain(
      "border: 1px solid var(--color-control-edge-on-glass);",
    );
  });

  it.each(GLASS_LAYERS)(
    "$label keeps the edge above 3:1 against any possible backdrop",
    ({ hex, alpha }) => {
      const edge = token("color-control-edge-on-glass");
      expect(edge, "--color-control-edge-on-glass must resolve to a hex color").toMatch(/^#/);

      // Compositing is linear per channel in the backdrop and relative luminance
      // rises monotonically with every channel, so black and white bound each
      // color that could ever scroll under the header. Sampling the live surface
      // tokens instead would only prove the edge holds for today's content.
      for (const under of ["#000000", "#ffffff"]) {
        const painted = compositeOver(hex, alpha, under);
        const ratio = contrastRatio(edge, painted);
        expect(
          meetsAA(ratio, { large: true }),
          `edge ${edge} on header painted ${painted} (over ${under}) is ${ratio.toFixed(2)}:1`,
        ).toBe(true);
      }
    },
  );
});

// Boardwalk's role colors remain independent of the public-site theme.
const cmsTokens: Record<string, string> = JSON.parse(
  readSource("../../admin/src/design-system/tokens.json"),
).tokens;
function cmsToken(name: string): string {
  const value = cmsTokens[name];
  const alias = value?.match(/^var\(--cms-([a-z0-9-]+)\)$/);
  return alias ? cmsToken(alias[1]) : value;
}
const cmsSurfaces = ["surface-workspace", "surface-context", "surface-chrome", "surface-header", "surface-content", "surface-field", "surface-selected"];
describe("Boardwalk editorial surface and control contrast", () => {
  it.each(cmsSurfaces)("keeps text, icons, focus and field edges legible on %s", surface => {
    const background = cmsToken(surface);
    for (const foreground of ["ink", "ink-secondary", "ink-muted", "brand-ink", "action-quiet-text", "danger"]) {
      expect(contrastRatio(cmsToken(foreground), background), `${foreground} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const foreground of ["focus"]) {
      expect(contrastRatio(cmsToken(foreground), background), `${foreground} on ${surface}`).toBeGreaterThanOrEqual(3);
    }
  });
  it.each(["sidebar", "sidebar-raised", "sidebar-hover", "nav-current"])("keeps inverse quiet icons and focus legible on %s", background => {
    expect(contrastRatio(cmsToken("sidebar-text"), cmsToken(background))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(cmsToken("focus-inverse"), cmsToken(background))).toBeGreaterThanOrEqual(3);
  });
  it.each([...cmsSurfaces, "surface-muted", "brand-soft"])("keeps field boundaries at 3:1 on %s", surface => {
    expect(contrastRatio(cmsToken("boundary-field"), cmsToken(surface)), `field edge on ${surface}`).toBeGreaterThanOrEqual(3);
  });
  it("keeps neutral control hover and pressed text above AA", () => {
    for (const state of ["action-quiet-hover", "action-quiet-pressed", "action-secondary", "action-secondary-hover", "action-secondary-pressed"]) {
      expect(contrastRatio(cmsToken("action-quiet-text"), cmsToken(state)), state).toBeGreaterThanOrEqual(4.5);
      if (state.startsWith("action-quiet")) {
        expect(contrastRatio(cmsToken("focus"), cmsToken(state)), `focus on ${state}`).toBeGreaterThanOrEqual(3);
      }
    }
    expect(contrastRatio(cmsToken("danger"), cmsToken("danger-soft"))).toBeGreaterThanOrEqual(4.5);
  });
});

it("keeps the study attention tag readable", () => {
  expect(contrastRatio(cmsToken("tag-warning-ink"), cmsToken("tag-warning-background"))).toBeGreaterThanOrEqual(4.5);
});

it("keeps editor navigation and document type labels legible", () => {
  expect(contrastRatio(cmsToken("sidebar-text"), cmsToken("nav-current"))).toBeGreaterThanOrEqual(4.5);
  for (const background of ["sidebar", "nav-current"]) {
    expect(contrastRatio(cmsToken("nav-current-marker"), cmsToken(background))).toBeGreaterThanOrEqual(3);
  }
  expect(contrastRatio(cmsToken("ink-muted"), cmsToken("surface-type-tag"))).toBeGreaterThanOrEqual(4.5);
});

it("keeps composition headers, resource advisories and crop choices legible", () => {
  for (const surface of ["surface-header", "surface-context", "surface-muted", "section-selected-header", "post-selected-header", "row-header", "tag-background"]) {
    for (const ink of ["ink", "ink-secondary", "ink-muted"]) expect(contrastRatio(cmsToken(ink), cmsToken(surface)), `${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5);
  }
  expect(contrastRatio(cmsToken("warning"), cmsToken("warning-soft"))).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(cmsToken("brand-ink"), cmsToken("brand-soft"))).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(cmsToken("ink-muted"), cmsToken("surface-muted"))).toBeGreaterThanOrEqual(3);
});

it("keeps the video symbol and summary placeholder legible", () => {
  expect(contrastRatio(cmsToken("video-symbol-ink"), cmsToken("video-symbol"))).toBeGreaterThanOrEqual(3);
  expect(contrastRatio(cmsToken("ink-placeholder"), cmsToken("surface-content"))).toBeGreaterThanOrEqual(4.5);
});

it("keeps browsing row selection and contextual inspectors above AA", () => {
  expect(contrastRatio(cmsToken("brand"), cmsToken("surface-muted")), "type glyph on its thumbnail").toBeGreaterThanOrEqual(3);
  for (const background of ["surface-header", "surface-context", "surface-chrome", "surface-selected", "browse-table-header", "browse-table-stripe", "browse-choice-surface", "browse-choice-hover"]) {
    for (const foreground of ["ink", "ink-secondary", "ink-muted", "brand-ink"]) {
      expect(contrastRatio(cmsToken(foreground), cmsToken(background)), `${foreground} on browsing ${background}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio(cmsToken("brand"), cmsToken(background)), `selection edge on ${background}`).toBeGreaterThanOrEqual(3);
  }
});

it("keeps image-role symbols and taxonomy projections legible", () => {
  expect(contrastRatio(cmsToken("asset-summary-ink"), cmsToken("asset-summary-bg"))).toBeGreaterThanOrEqual(3);
  expect(contrastRatio(cmsToken("ink-secondary"), cmsToken("taxonomy-tag-bg"))).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(cmsToken("taxonomy-primary-border"), cmsToken("taxonomy-tag-bg"))).toBeGreaterThanOrEqual(3);
});
