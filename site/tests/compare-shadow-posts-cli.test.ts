// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("./fixtures/shadow-posts/static.html", import.meta.url), "utf8");

describe("shadow comparison command on fixtures", () => {
  it.each(["same", "different", "fallback"])("reports fixture differences (%s) and keeps the staff cookie on dev", scenario => {
    const directory = mkdtempSync(join(tmpdir(), "njpbs-shadow-compare-"));
    try {
      const cookie = "__Host-njpbs-staff=fixture.session.token";
      const cookieFile = join(directory, "staff-cookie");
      writeFileSync(cookieFile, cookie, { mode: 0o600 });
      // Replace fetch before the CLI loads. This test makes no network request.
      const preload = `globalThis.fetch = async (url, options) => {
        const dev = new URL(url).hostname === "dev-public.example.org";
        if ((options.headers.cookie ?? null) !== (dev ? ${JSON.stringify(cookie)} : null)) {
          throw new Error("Cookie scope mismatch");
        }
        return new Response(dev ? ${JSON.stringify(scenario === "different" ? html.replace("<title>", "<title>Changed ") : html)} : ${JSON.stringify(html)}, {
          headers: { "content-type": "text/html", ...(dev && ${JSON.stringify(scenario !== "fallback")} ? {
            "x-njpbs-renderer-sha": "a".repeat(40), "x-njpbs-source-version": "7", "x-njpbs-input-sha256": "b".repeat(64)
          } : {}) }
        });
      };`;
      const result = spawnSync(process.execPath, [
        "--import", "tsx", "--import", `data:text/javascript,${encodeURIComponent(preload)}`,
        "scripts/compare-shadow-posts.ts", "shadow-fixture",
      ], { cwd: new URL("../", import.meta.url), encoding: "utf8", timeout: 15_000,
        env: { ...process.env, NJPBS_SHADOW_COMPARE_COOKIE_FILE: cookieFile } });
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(scenario === "same" ? 0 : 1);
      const report = JSON.parse(result.stdout.trim());
      expect(report.slug).toBe("shadow-fixture");
      if (scenario === "fallback") {
        expect(report.error).toBe("Dev response lacks shadow renderer evidence");
        expect(report.differences).toBeUndefined();
      } else {
        expect(report.error).toBeUndefined();
        expect(report.differences.length).toBe(scenario === "different" ? 1 : 0);
        expect(report.shadow).toEqual({ rendererSha: "a".repeat(40), sourceVersion: "7", inputSha256: "b".repeat(64) });
      }
      expect(result.stdout).not.toContain(cookie);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
