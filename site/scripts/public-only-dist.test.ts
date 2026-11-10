import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const distDir = fileURLToPath(new URL("../dist/", import.meta.url));
const indexPath = join(distDir, "index.html");

function isPublicOnlyDist(): boolean {
  if (!existsSync(indexPath)) return false;
  const html = readFileSync(indexPath, "utf8");
  return (
    html.includes("New NJ PBS") &&
    html.includes("Something new is taking shape.") &&
    /<meta name="robots" content="[^"]*noindex[^"]*"/.test(html)
  );
}

describe("PUBLIC_ONLY dist shape", () => {
  it("excludes the native schedule route from the coming-soon rollback", () => {
    if (!isPublicOnlyDist()) {
      expect(isPublicOnlyDist()).toBe(false);
      return;
    }

    expect(existsSync(join(distDir, "schedule", "index.html"))).toBe(false);
  });

  it("excludes the public Admin guide from the coming-soon rollback", () => {
    if (!isPublicOnlyDist()) {
      expect(isPublicOnlyDist()).toBe(false);
      return;
    }

    expect(existsSync(join(distDir, "admin", "docs", "index.html"))).toBe(
      false,
    );
  });
});
