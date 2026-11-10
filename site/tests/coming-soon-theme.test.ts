// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { contrastRatio, meetsAA } from "../src/lib/contrast";

import { SIGNAL, COMING_SOON_TEXT, COMING_SOON_LINKS } from "../src/lib/coming-soon-theme";

const readSource = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const INDEX = readSource("../src/pages/index.astro");
const TOKENS = readSource("../src/styles/design-tokens.css");

const COMING_SOON_TEXT_SELECTORS: Record<string, string> = {
  mark: ".soon__mark",
  tagline: ".soon__tagline",
  status: ".soon__status",
  link: ".soon__link",
  "link-pending": ".soon__link--pending",
};

const COMING_SOON_CSS_VARS: Record<string, string> = {
  surface: SIGNAL.surface,
  nearWhite: SIGNAL.nearWhite,
};

function cssRule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  return match?.[1] ?? "";
}

function declaration(rule: string, property: string): string {
  return (
    rule.match(new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`))?.[1].trim() ?? ""
  );
}

function token(name: string, seen = new Set<string>()): string {
  if (seen.has(name)) throw new Error(`CSS token cycle at --${name}`);
  seen.add(name);

  const match = TOKENS.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!match) return "";
  return resolveColor(match[1].trim(), seen);
}

function resolveColor(value: string, seen = new Set<string>()): string {
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(trimmed)) return trimmed;

  const variable = trimmed.match(/^var\(--([a-zA-Z0-9-]+)\)$/)?.[1];
  if (!variable) return "";
  return variable in COMING_SOON_CSS_VARS
    ? resolveColor(COMING_SOON_CSS_VARS[variable], seen)
    : token(variable, seen);
}

// "Computed, not eyeballed": every text/surface pairing on the public coming-soon
// page is asserted against its WCAG AA floor here, so a sub-AA color choice fails
// the build instead of shipping.
describe("coming-soon Signal text contrast", () => {
  for (const pair of COMING_SOON_TEXT) {
    it(`${pair.name}: ${pair.fg} on ${pair.bg} clears its AA minimum`, () => {
      const ratio = contrastRatio(resolveColor(pair.fg), resolveColor(pair.bg));
      expect(ratio).toBeGreaterThanOrEqual(pair.minRatio);
      expect(meetsAA(ratio, { large: pair.minRatio < 4.5 })).toBe(true);
    });
  }

  it("checks the colors the PUBLIC_ONLY page actually renders", () => {
    const soonRule = cssRule(INDEX, ".soon");
    const renderedBackground = declaration(soonRule, "background");

    for (const pair of COMING_SOON_TEXT) {
      const selector = COMING_SOON_TEXT_SELECTORS[pair.name];
      expect(selector, pair.name).toBeTruthy();

      const renderedColor = declaration(cssRule(INDEX, selector), "color");
      expect(renderedColor, selector).toBeTruthy();
      expect(resolveColor(pair.fg), `${pair.name} foreground`).toBe(
        resolveColor(renderedColor),
      );
      expect(resolveColor(pair.bg), `${pair.name} background`).toBe(
        resolveColor(renderedBackground),
      );
    }
  });
});

// The coming-soon page carries two forward-looking slots (#25): the announcement
// and the job postings. Each is a real link once a URL exists and a non-link
// "coming soon" affordance until then — never a dead "#" link.
describe("coming-soon forward links", () => {
  it("has an announcement slot and a jobs slot", () => {
    const names = COMING_SOON_LINKS.map((l) => l.name);
    expect(names).toContain("announcement");
    expect(names).toContain("jobs");
  });

  it("each slot is either pending (null href) or an absolute http(s) URL — no dead links", () => {
    for (const link of COMING_SOON_LINKS) {
      if (link.href === null) {
        expect(link.pending.length).toBeGreaterThan(0); // a visible affordance, not nothing
      } else {
        expect(link.href).toMatch(/^https?:\/\//); // a real destination, not "#"
      }
    }
  });

  it("labels carry no launch date and no operator claim", () => {
    // Preview link labels stay neutral: no launch year or operator claim.
    for (const link of COMING_SOON_LINKS) {
      const text = `${link.label} ${link.pending}`;
      expect(text).not.toMatch(/\b20\d{2}\b/); // no year/date
      expect(text).not.toMatch(/Montclair|MSU|CCM|takes? over|operator/i);
    }
  });
});
