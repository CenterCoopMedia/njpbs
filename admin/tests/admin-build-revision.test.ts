import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { resolveAdminBuildRevision } from "../../scripts/lib/admin-build-revision.mjs";
import { createPerfRecorder, type TimingSink } from "../src/lib/perf-receipts";

const sink: TimingSink = {
  now: () => 0,
  mark: () => undefined,
  measure: () => undefined,
};

describe("admin build revision", () => {
  it("injects the full checked-out source revision for dev problem reports", async () => {
    const { resolveConfig } = await import("vite");
    const config = await resolveConfig({ configFile: resolve(process.cwd(), "vite.config.ts") }, "build");
    const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(sourceRevision).toMatch(/^[0-9a-f]{40}$/);
    expect(config.define?.__ADMIN_SOURCE_REVISION__).toBe(JSON.stringify(sourceRevision));
  });

  it("prefers the reviewed build manifest the deployed build already publishes", () => {
    expect(
      resolveAdminBuildRevision({
        manifest: {
          build: { revision: "d805028221a24448055bf0adcce344d1921547b7" },
        },
        gitRevision: "0000000000000000000000000000000000000000",
      }),
    ).toBe("d805028");
  });

  it("falls back to the checked-out commit when no manifest is supplied", () => {
    expect(
      resolveAdminBuildRevision({
        gitRevision: "d805028221a24448055bf0adcce344d1921547b7\n",
      }),
    ).toBe("d805028");
  });

  it("reports no revision rather than inventing one", () => {
    expect(resolveAdminBuildRevision({})).toBeNull();
    expect(resolveAdminBuildRevision({ gitRevision: "not-a-revision" })).toBeNull();
    expect(
      resolveAdminBuildRevision({ manifest: { build: null } }),
    ).toBeNull();
  });

  // The env-var boundary forbids a whole-object import.meta.env read, which is what an
  // optional env lookup compiles to. A defined constant is replaced per key instead.
  it("reaches the client as a defined constant, not an environment object", () => {
    const config = readFileSync(
      resolve(process.cwd(), "vite.config.ts"),
      "utf8",
    );

    expect(config).toContain("__ADMIN_BUILD_REVISION__");
    expect(config).toContain("resolveAdminBuildRevision");

    // Code lines only, the way the preflight boundary reads them: the module explains in a
    // comment why it does not read the environment, and that explanation is not a read.
    const receiptCode = readFileSync(
      resolve(process.cwd(), "src/lib/perf-receipts.ts"),
      "utf8",
    )
      .split("\n")
      .filter((line) => {
        const trimmed = line.trimStart();
        return !trimmed.startsWith("//") && !trimmed.startsWith("*");
      });

    expect(receiptCode.filter((line) => line.includes("import.meta.env"))).toEqual(
      [],
    );
    expect(receiptCode.some((line) => line.includes("__ADMIN_BUILD_REVISION__"))).toBe(
      true,
    );
  });

  it("attributes a receipt to the revision it was captured on", () => {
    expect(createPerfRecorder(sink, { build: "d805028" }).receipt().build).toBe(
      "d805028",
    );
    expect(createPerfRecorder(sink).receipt().build).toBeNull();
  });
});
