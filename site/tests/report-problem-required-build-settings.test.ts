// @vitest-environment node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dialog = readFileSync(
  fileURLToPath(
    new URL("../src/islands/ReportProblemDialog.astro", import.meta.url),
  ),
  "utf8",
);

describe("report problem required build settings", () => {
  it("fails a required public build when either report setting is missing", () => {
    expect(dialog).toContain(
      'const reportRequired = import.meta.env.PUBLIC_REPORT_REQUIRED === "1"',
    );
    expect(dialog).toMatch(
      /if \(reportRequired && \(!endpoint \|\| !turnstileSitekey\)\) \{\s*throw new Error/,
    );
    expect(dialog).toContain(
      "PUBLIC_REPORT_ENDPOINT and PUBLIC_TURNSTILE_SITEKEY are required",
    );
  });
});
