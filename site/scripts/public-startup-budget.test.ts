// Post-build asset budgets. Reuses the existing guardrail job; no browser or network.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicStartupAudit, publicStartupFailures } from "./public-startup-budget.mjs";
import { isGuardrailExemptPath } from "../src/lib/guardrails";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
function pages(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? pages(file) : entry.name.endsWith(".html") ? [file] : [];
  });
}

describe("emitted public startup budgets", () => {
  it("keeps public startup and deferred graphs within their byte limits", async () => {
    const audit = createPublicStartupAudit((asset: string) => readFileSync(join(dist, asset), "utf8"));
    const failures: string[] = [];
    const internalPreviewRoots = ["design-system/", "atlas/", "resources/nj-politics/"];
    const publicPages = pages(dist).filter(file => {
      const route = relative(dist, file).replaceAll("\\", "/");
      return !isGuardrailExemptPath(route) && !internalPreviewRoots.some(root => route.startsWith(root));
    });
    expect(publicPages.length).toBeGreaterThan(0);
    for (const file of publicPages) {
      const pagePath = `/${relative(dist, file).replaceAll("\\", "/")}`;
      try {
        const report = await audit(readFileSync(file, "utf8"), pagePath);
        if (report.unresolvedDynamicImports) console.info(`${pagePath}: ${report.unresolvedDynamicImports} non-literal dynamic imports need separate runtime evidence`);
        failures.push(...publicStartupFailures(report).map(reason => `${pagePath}: ${reason}`));
      } catch (error) {
        failures.push(`${pagePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
});
