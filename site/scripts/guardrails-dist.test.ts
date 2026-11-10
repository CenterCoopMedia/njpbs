import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findGuardrailViolations,
  isScannableAsset,
  isGuardrailExemptPath,
} from "../src/lib/guardrails";

// Post-build guardrail gate. Runs ONLY via its own config (npm run guardrails),
// after a build has produced dist/. It hard-fails when dist/ is missing or empty
// so it can never pass as a silent no-op — if you see it green, it actually
// scanned real emitted HTML. Kept out of the default `npm test` (which globs
// tests/** and must stay build-free) by living under scripts/.

const distDir = fileURLToPath(new URL("../dist/", import.meta.url));
const normalizeRel = (rel: string): string => rel.replaceAll("\\", "/");

describe("built public HTML obeys the binding guardrails", () => {
  it("dist/ exists — run a build first", () => {
    expect(existsSync(distDir)).toBe(true);
  });

  it("emits at least one HTML page to scan", () => {
    const html = (readdirSync(distDir, { recursive: true }) as string[])
      .map(normalizeRel)
      .filter((f) => f.endsWith(".html"));
    expect(html.length).toBeGreaterThan(0);
  });

  it("has no guardrail violations in any emitted page or stylesheet", () => {
    // Scan HTML and CSS: the logo-image rule's url() branch only catches a
    // forbidden mark in a kit stylesheet if the gate actually feeds it CSS.
    const files = (readdirSync(distDir, { recursive: true }) as string[])
      .map(normalizeRel)
      .filter(
        (f): f is string =>
          isScannableAsset(f) && !isGuardrailExemptPath(f),
      );
    const offenders = files
      .map((rel) => ({
        file: rel,
        violations: findGuardrailViolations(readFileSync(join(distDir, rel), "utf8")),
      }))
      .filter((o) => o.violations.length > 0);
    // Equality against [] surfaces the offending file + matched text on failure.
    expect(offenders).toEqual([]);
  });
});
