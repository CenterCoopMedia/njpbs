import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { fingerprintInputs, RECEIPT_INPUT_PATHS } from "../../scripts/lib/cms-component-receipt.mjs";

describe("CMS API compiled input selection", () => {
  it("covers every runtime bundle input, including external and transitive imports", async () => {
    const result = await build({ entryPoints: ["cms-api/src/index.ts"], bundle: true, format: "esm",
      platform: "browser", external: ["cloudflare:*", "node:*"], write: false, metafile: true, logLevel: "silent" });
    expect(result.warnings).toEqual([]);
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs).toContain("functions/lib/public-asset-hosts.json");
    expect(inputs).toContain("admin/src/lib/field-defaults.ts");
    for (const path of inputs.filter(path => !path.startsWith("node_modules/"))) {
      expect(RECEIPT_INPUT_PATHS.cmsApi.some(prefix => path === prefix || path.startsWith(`${prefix}/`)), path).toBe(true);
    }
  });

  it("selects external runtime changes while leaving unrelated Admin/Functions edits independent", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cms-api-inputs-"));
    const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const write = (path, text) => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), text); };
    const commit = () => {
      git("add", ".");
      git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
      return git("rev-parse", "HEAD");
    };
    const shared = RECEIPT_INPUT_PATHS.cmsApi.filter(path => path.startsWith("admin/src/") || path.startsWith("functions/lib/"));
    try {
      git("init", "-q");
      for (const path of shared) write(path, "before");
      // The fingerprint discovers bundle inputs from the committed Worker sources.
      for (const name of ["wrangler.jsonc", "wrangler.dev.jsonc"]) write(`cms-api/${name}`, '{ "main": "src/index.ts" }\n');
      write("cms-api/tsconfig.json", "{}\n");
      write("cms-api/src/index.ts", "export default {};\n");
      write("package-lock.json", '{ "packages": {} }\n');
      const baseline = commit(), original = await fingerprintInputs(baseline, "cmsApi", { cwd });
      let previous;
      for (const path of shared) {
        if (previous) write(previous, "before");
        write(path, "after");
        expect(await fingerprintInputs(commit(), "cmsApi", { cwd }), path).not.toBe(original);
        previous = path;
      }
      write(previous, "before");
      write("functions/health.js", "unrelated Function body");
      write("admin/src/components/Unrelated.tsx", "unrelated Admin screen");
      expect(await fingerprintInputs(commit(), "cmsApi", { cwd })).toBe(original);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
