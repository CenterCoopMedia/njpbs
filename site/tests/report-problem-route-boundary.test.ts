import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";

const root = process.cwd();
const wrapper = readFileSync(
  join(root, "src", "islands", "ReportProblem.astro"),
  "utf8",
);
const dialog = readFileSync(
  join(root, "src", "islands", "ReportProblemDialog.astro"),
  "utf8",
);
const layout = readFileSync(
  join(root, "src", "layouts", "PublicSiteLayout.astro"),
  "utf8",
);
const sharePage = readFileSync(join(root, "src", "pages", "share", "[...share].astro"), "utf8");
const shareIsland = readFileSync(join(root, "src", "islands", "ShareSubmission.astro"), "utf8");

describe("report-a-problem route boundary", () => {
  it("keeps the layout API stable while isolating the full dialog", () => {
    expect(layout).toContain(
      'import ReportProblem from "../islands/ReportProblem.astro"',
    );
    expect(layout).toMatch(/<ReportProblem\s*\/>/);
    expect(wrapper).toContain(
      'import ReportProblemDialog from "./ReportProblemDialog.astro"',
    );
    expect(dialog).toContain("PUBLIC_REPORT_ENDPOINT");
    expect(dialog).toContain("PUBLIC_TURNSTILE_SITEKEY");
  });

  it("omits the collecting dialog from every path whose final segment is kids", () => {
    expect(wrapper).toContain(
      'const isKidsRoute = pathSegments.at(-1) === "kids"',
    );
    expect(wrapper).toMatch(/!isKidsRoute\s*&&\s*<ReportProblemDialog\s*\/>/);
    expect(wrapper).not.toContain("PUBLIC_REPORT_ENDPOINT");
    expect(wrapper).not.toContain("PUBLIC_TURNSTILE_SITEKEY");
  });

  it("renders kids and dev fallbacks as ordinary mailto links without JavaScript", () => {
    expect(wrapper).not.toContain("querySelectorAll");
    expect(layout).toContain(
      'href="mailto:njpbs@montclair.edu?subject=Website%20problem%20report"',
    );
    for (const [isKidsRoute, isDevelopment, expectedTrigger, expectedPopup] of [
      [true, false, undefined, undefined],
      [false, true, undefined, undefined],
      [true, true, undefined, undefined],
      [false, false, "", "dialog"],
    ]) {
      const context = { isKidsRoute, isDevelopment };
      const reportOpen = layout.match(/data-report-open=\{([^}]+)\}/)?.[1];
      const popup = layout.match(/aria-haspopup=\{([^}]+)\}/)?.[1];
      expect(reportOpen).toBeDefined();
      expect(popup).toBeDefined();
      expect(runInNewContext(reportOpen!, context)).toBe(expectedTrigger);
      expect(runInNewContext(popup!, context)).toBe(expectedPopup);
    }
  });

  it("keeps the share island on the standalone route and off the kids layout", () => {
    expect(sharePage).toContain('import ShareSubmission from "../../islands/ShareSubmission.astro"');
    expect(sharePage).toContain("<ShareSubmission />");
    expect(shareIsland).toContain("PUBLIC_SHARE_INTAKE_ENDPOINT");
    expect(layout).not.toContain("ShareSubmission");
    expect(wrapper).not.toContain("ShareSubmission");
  });
});
