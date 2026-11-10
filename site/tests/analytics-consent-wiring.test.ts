// @vitest-environment node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

function read(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf8",
  );
}

describe("analytics consent deployment wiring", () => {
  it("disables analytics on the isolated dev surface", () => {
    const source = read("../../.github/workflows/cms-dev-publish.yml");
    expect(source).toContain("CMS_DEPLOYMENT_ENVIRONMENT: development");
    const publisher = read("../scripts/cms-dev-publication.mjs");
    expect(publisher).toContain('PUBLIC_GA4_REQUIRED: "0"');
    expect(publisher).not.toContain("PUBLIC_GA4_MEASUREMENT_ID:");
    expect(read("../src/layouts/PublicSiteLayout.astro")).toContain(
      'const ga4MeasurementId = isDevelopment ? undefined : process.env.PUBLIC_GA4_MEASUREMENT_ID?.trim()',
    );
  });

  it.each([
    ["cms-dev-publish.yml", ["Build from frozen input without network or credentials", "Check built content"]],
  ] as const)("uses development rules for both build and guardrails in %s", (file, steps) => {
    const workflow = parse(read(`../../.github/workflows/${file}`));
    const job = workflow.jobs.build;
    for (const name of steps) {
      const step = job.steps.find((candidate: { name?: string }) => candidate.name === name);
      expect(step, name).toBeDefined();
      const environment = { ...workflow.env, ...job.env, ...step.env };
      expect(environment.CMS_DEPLOYMENT_ENVIRONMENT, name).toBe("development");
    }
  });
});

describe("video pages turn analytics off", () => {
  it("passes noAnalytics from every block-rendering route to the layout", () => {
    expect(read("../src/layouts/PublicSiteLayout.astro")).toContain("!noAnalytics &&");
    for (const route of [
      "../src/pages/posts/[...slug].astro",
      "../src/pages/[...slug].astro",
      "../src/pages/schedule/[...schedule].astro",
      "../src/pages/staff/[...index].astro",
    ]) {
      expect(read(route), route).toMatch(/noAnalytics=\{containsVideo\(/);
    }
  });
});
