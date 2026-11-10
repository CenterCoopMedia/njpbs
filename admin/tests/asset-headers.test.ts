import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { adminAssetHeadersPlugin } from "../build/asset-headers";

const baseHeaders = readFileSync("public/_headers", "utf8");
const assets = (count: number) => Array.from({ length: count }, (_, index) =>
  `assets/chunk-${index}-Abcd1234.js`);
const ruleCount = (source: string) => source.split(/\r?\n/)
  .filter(line => line.startsWith("/")).length;

// Exercise the Vite plugin's file input and emitted artifact without building the app.
async function headersFor(files: string[], source = baseHeaders): Promise<string> {
  const publicDir = mkdtempSync(path.join(tmpdir(), "admin-headers-"));
  try {
    writeFileSync(path.join(publicDir, "_headers"), source);
    const plugin = adminAssetHeadersPlugin();
    const configure = typeof plugin.configResolved === "function"
      ? plugin.configResolved : plugin.configResolved?.handler;
    const generate = typeof plugin.generateBundle === "function"
      ? plugin.generateBundle : plugin.generateBundle?.handler;
    if (!configure || !generate) throw new Error("Missing asset headers hook");
    await configure.call({} as never, { publicDir } as never);
    const emitFile = vi.fn();
    const bundle = Object.fromEntries(files.map(fileName => [fileName, {
      type: "asset", fileName, names: [], originalFileNames: [], source: "asset",
    }]));
    await generate.call({ emitFile } as never, {} as never, bundle as never, false);
    const output = emitFile.mock.calls.find(([file]) => file.fileName === "_headers")?.[0];
    if (!output) throw new Error("Missing emitted _headers");
    return output.source;
  } finally {
    rmSync(publicDir, { recursive: true, force: true });
  }
}

describe("Admin asset headers", () => {
  it("emits enforcing frame protection in the global static rule", async () => {
    const headers = await headersFor(assets(1));
    const globalRule = headers.split(/\r?\n\r?\n/).find(block => block.includes("\n/*\n"));
    expect(globalRule).toContain("  Content-Security-Policy: frame-ancestors 'none'");
    expect(globalRule).toContain("  X-Frame-Options: DENY");
  });

  it.each([1, 61, 125, 1000])("keeps rule count constant with %i emitted assets", async count => {
    const headers = await headersFor([...assets(count), "guide-content/manifest.json"]);
    expect(headers.startsWith(baseHeaders.trimEnd())).toBe(true);
    expect(ruleCount(headers)).toBe(ruleCount(baseHeaders) + 1);
    expect(ruleCount(headers)).toBeLessThanOrEqual(80);
    expect(headers).toContain("/assets/*\n  Cache-Control: public, max-age=31536000, immutable");
    expect(headers.split("\n").every(line => line.length <= 2000)).toBe(true);
  });

  it("refuses a build without fingerprinted assets", async () => {
    await expect(headersFor(["admin-status.json"])).rejects.toThrow("no fingerprinted assets");
  });

  it.each(["assets/main.js", "assets/worker-abc.js", "assets/index.html"])(
    "refuses a non-fingerprinted asset: %s", async file => {
      await expect(headersFor([...assets(1), file])).rejects.toThrow("non-fingerprinted asset path");
    },
  );

  it("enforces the Pages 100-rule limit including the asset rule", async () => {
    const rules = Array.from({ length: 99 }, (_, index) => `/route-${index}\n  Cache-Control: no-store`).join("\n\n");
    expect(ruleCount(await headersFor(assets(1), rules))).toBe(100);
    await expect(headersFor(assets(1), `${rules}\n/one-more\n  Cache-Control: no-store`))
      .rejects.toThrow("Cloudflare Pages permits at most 100");
  });
});

