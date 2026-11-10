import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "src", "layouts", "PublicSiteLayout.astro"),
  "utf8",
);

describe("skip-to-content link", () => {
  it("targets a programmatically focusable main landmark", () => {
    expect(source).toMatch(/<a class="skip" href="#main">Skip to content<\/a>/);
    expect(source).toMatch(/<main id="main" tabindex="-1"[^>]*>/);
  });
});

describe("public footer", () => {
  it("acknowledges Montclair State and the College of Communication and Media", () => {
    expect(source).toContain(
      "NJ PBS is housed at the College of Communication and Media at Montclair State University.",
    );
  });

  it("stacks the brand block on narrow screens so the station text can breathe", () => {
    expect(source).toMatch(
      /@media\s*\(max-width:\s*520px\)\s*\{[\s\S]*?\.foot-brand\s*\{[\s\S]*?align-items:\s*flex-start;[\s\S]*?flex-direction:\s*column;/,
    );
  });

  it("wraps FCC station links on narrow screens", () => {
    expect(source).toMatch(
      /@media\s*\(max-width:\s*520px\)\s*\{[\s\S]*?\.foot-fcc\s*\{[\s\S]*?flex-direction:\s*column;[\s\S]*?\.foot-fcc ul\s*\{[\s\S]*?flex-wrap:\s*wrap;/,
    );
  });
});

describe("report-a-problem trigger", () => {
  it("mounts the report dialog island once in the footer", () => {
    // A refactor that drops the mount would leave a footer button that opens
    // nothing, so pin both the import and the render.
    expect(source).toContain('import ReportProblem from "../islands/ReportProblem.astro"');
    expect(source).toMatch(/<ReportProblem\s*\/>/);
  });

  it("exposes a route-aware dialog trigger with a no-JS mailto fallback", () => {
    // Production non-Kids routes get enhancement hooks for the dialog. Kids
    // routes and development keep the mailto link without popup semantics.
    expect(source).toMatch(
      /<a[^>]*href="mailto:njpbs@montclair\.edu[^>]*class="foot-report"[^>]*data-report-open=\{isKidsRoute \|\| isDevelopment \? undefined : ""\}[^>]*aria-haspopup=\{isKidsRoute \|\| isDevelopment \? undefined : "dialog"\}/,
    );
    expect(source).toContain("Report a problem");
  });
});

describe("newsletter header link", () => {
  it("renders one resolved setting in the desktop and mobile header", () => {
    expect(source).toContain("resolvePublicSiteChromeNewsletter");
    expect(source).toContain("const showNewsletter = !isKidsRoute && newsletter.enabled");
    expect(source.match(/href=\{newsletter\.href\}/g)).toHaveLength(2);
    expect(source.match(/\{newsletter\.label\}/g)).toHaveLength(2);
    expect(source.match(/\{showNewsletter && \(/g)).toHaveLength(2);
    expect(source).not.toContain("Subscribe to the newsletter");
  });
});

describe("reduce-motion footer toggle", () => {
  it("renders one labeled toggle in the footer and none in the header", () => {
    const header = source.slice(source.indexOf("<header"), source.indexOf("</header>"));
    const footer = source.slice(source.indexOf("<footer"), source.indexOf("</footer>"));

    expect(source.match(/data-motion-toggle/g)).toHaveLength(2);
    expect(header).not.toContain("data-motion-toggle");
    expect(footer).toMatch(
      /<button[^>]*class="motion-toggle"[^>]*aria-pressed="false"[^>]*data-motion-toggle/,
    );
    expect(footer).toContain("Reduce motion");
  });

  it("persists the choice and drives the global motion attribute", () => {
    expect(source).toContain('localStorage.setItem(KEY, on ? "off" : "on")');
    expect(source).toMatch(/root\.setAttribute\("data-motion", "off"\)/);
    expect(source).toMatch(/root\.removeAttribute\("data-motion"\)/);
  });
});
