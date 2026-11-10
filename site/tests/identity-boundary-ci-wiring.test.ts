// @vitest-environment node
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const readRepo = (relativePath: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
    "utf8",
  );

const repoPath = (relativePath: string): string =>
  fileURLToPath(new URL(`../../${relativePath}`, import.meta.url));

const GUARD_PATH = ".github/scripts/identity-boundary-guard.mjs";
const DECLARATION_PATH = ".github/scripts/identity-boundary-guard.d.mts";
const TEST_PATH = "site/tests/identity-boundary.test.ts";
const GUARD_COMMAND = `node ${GUARD_PATH}`;

function expectOrdered(source: string, first: string, second: string): void {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);
  expect(firstIndex, `${first} missing`).toBeGreaterThanOrEqual(0);
  expect(secondIndex, `${second} missing`).toBeGreaterThan(firstIndex);
}

describe("identity-boundary required CI binding (#459, #1101)", () => {
  it("runs the one dependency-free guard before Admin or Functions code", () => {
    const ci = readRepo(".github/workflows/ci.yml");
    expect(ci).toContain("name: Identity boundary guard");
    expect(ci).toContain(`run: ${GUARD_COMMAND}`);
    expectOrdered(
      ci,
      "name: Metered-API source scan (before any scanned code runs)",
      "name: Identity boundary guard",
    );
    expectOrdered(ci, "name: Identity boundary guard", "uses: actions/setup-node@v7");
    for (const workflowPath of [".github/workflows/admin-ci.yml", ".github/workflows/firebase-ci.yml"]) {
      const source = readRepo(workflowPath);
      expect(source).toContain("workflow_call:");
      expect(source).not.toContain("pull_request:");
      expect(source).not.toContain("name: Identity boundary guard");
    }
    for (const path of [GUARD_PATH, DECLARATION_PATH, TEST_PATH]) expect(readRepo(".github/scripts/ci-classifier.mjs")).toContain(`"${path}"`);
    expect(ci).not.toContain("vitest.identity-boundary.config.ts");
  });

  it("keeps the canonical CI guard dependency-free and singular", () => {
    const guard = readRepo(GUARD_PATH);
    expect(guard).toContain('from "node:fs"');
    expect(guard).toContain('from "node:path"');
    expect(guard).toContain('from "node:url"');
    expect(guard).not.toMatch(/\bfrom\s+["'](?!node:)/);
    expect(guard).toContain("export const MEMBER_GATE");
    expect(guard).toContain("export const STAFF_IDENTITY");
    expect(readRepo(TEST_PATH)).toContain(`from "../../${GUARD_PATH}"`);
    expect(existsSync(repoPath("vitest.identity-boundary.config.ts"))).toBe(
      false,
    );
  });
});
