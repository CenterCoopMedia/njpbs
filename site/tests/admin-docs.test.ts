// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from "node:fs";

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("admin documentation manifest", () => {
  it("keeps the staff guide outside the public index contract", () => {
    const qaAudit = readFileSync(
      fileURLToPath(new URL("../../qa/audit_dist.py", import.meta.url)),
      "utf8",
    );
    expect(qaAudit).toContain("INDEXABLE_FULL_BUILD_PREFIXES = ()");
    expect(qaAudit).not.toContain('INDEXABLE_FULL_BUILD_PREFIXES = ("/admin/docs/",)');
  });

  it("keeps the protected screenshot source outside the public static tree", () => {
    const publicAssets = fileURLToPath(
      new URL("../public/images/admin-guide", import.meta.url),
    );
    const internalAssets = fileURLToPath(
      new URL("../src/internal/admin-guide", import.meta.url),
    );
    const manifest = JSON.parse(readFileSync(
      fileURLToPath(
        new URL("./fixtures/public-contracts/guide-images.json", import.meta.url),
      ),
      "utf8",
    )) as { screenshots: Array<{ file: string }> };

    expect(existsSync(publicAssets)).toBe(false);
    expect(readdirSync(internalAssets).filter(file => file.endsWith(".webp")).sort()).toEqual(
      manifest.screenshots.map(({ file }) => file).sort(),
    );
  });
});
