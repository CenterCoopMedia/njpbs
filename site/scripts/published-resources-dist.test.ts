import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { publishedResourceIssues } from "../src/lib/published-resource-check";
import { isGuardrailExemptPath } from "../src/lib/guardrails";

const origin = process.env.CMS_DEPLOYMENT_ENVIRONMENT === "development" ? "https://dev-public.example.org" : "https://njpbs.org";
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
function htmlFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? htmlFiles(path) : entry.name.endsWith(".html") ? [path] : [];
  });
}

it("reviews third-party resources in built public pages", () => {
  // Missing or empty dist must fail; no skipped build can report a clean scan.
  const files = htmlFiles(dist).filter(path => !isGuardrailExemptPath(relative(dist, path)));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const path = `/${relative(dist, file).replace(/index\.html$/, "")}`;
    expect(publishedResourceIssues(readFileSync(file, "utf8"), path, origin), path).toEqual([]);
  }
});
