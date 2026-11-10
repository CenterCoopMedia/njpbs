// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createPublicStartupAudit, publicStartupFailures } from "../scripts/public-startup-budget.mjs";

const files: Record<string, string> = {
  "/_astro/main.js": 'import "./shared.js"; export const load = () => import("./nj-hero.heavy.js");',
  "/_astro/shared.js": 'export const shared = true;',
  "/_astro/nj-hero.heavy.js": 'import "./engine.js"; export const hero = true;',
  "/_astro/engine.js": 'import "./shared.js"; export const engine = true;',
};
const read = (path: string) => {
  if (!(path in files)) throw new Error(`Missing emitted asset: ${path}`);
  return files[path];
};

describe("public startup asset graph", () => {
  it("deduplicates static imports and keeps the literal dynamic hero graph deferred", async () => {
    const report = await createPublicStartupAudit(read)('<script type="module" src="/_astro/main.js"></script>', '/index.html');
    expect(report.initialAssets.sort()).toEqual(['/_astro/main.js', '/_astro/shared.js']);
    expect(report.reachableAssets.sort()).toEqual(Object.keys(files).sort());
    expect(report.initialHeavyHeroAssets).toEqual([]);
    expect(report.reachableGzipBytes).toBeGreaterThan(report.initialGzipBytes);
    expect(publicStartupFailures(report)).toEqual([]);
  });

  it("rejects a modulepreloaded heavy hero and its initial dependencies", async () => {
    const report = await createPublicStartupAudit(read)('<link rel="modulepreload" href="/_astro/nj-hero.heavy.js"><script type="module" src="/_astro/main.js"></script>', '/index.html');
    expect(report.initialHeavyHeroAssets).toEqual(['/_astro/nj-hero.heavy.js']);
    expect(publicStartupFailures(report).some((reason: string) => reason.includes('Heavy hero entered'))).toBe(true);
  });

  it("counts inline JavaScript and resolves its static imports relative to the route", async () => {
    const report = await createPublicStartupAudit(read)('<script type="module">import "../../_astro/shared.js";</script><script type="application/ld+json">{}</script><template><script src="/missing.js"></script></template>', '/posts/story/index.html');
    expect(report.initialAssets.sort()).toEqual(['/_astro/shared.js', '/posts/story/index.html#inline-0']);
    expect(report.initialGzipBytes).toBeGreaterThan(0);
  });

  it("handles cycles, ignores import.meta and records unresolved dynamic imports", async () => {
    const audit = createPublicStartupAudit(() => 'import "./cycle.js"; const base = import.meta.url; export const load = path => import(path);');
    const report = await audit('<script type="module" src="/_astro/cycle.js"></script>', '/index.html');
    expect(report.initialAssets).toEqual(['/_astro/cycle.js']);
    expect(report.unresolvedDynamicImports).toBe(1);
  });

  it("fails on missing assets and external scripts without byte receipts", async () => {
    await expect(createPublicStartupAudit(read)('<script src="/missing.js"></script>', '/index.html')).rejects.toThrow('Missing emitted asset');
    await expect(createPublicStartupAudit(read)('<script src="https://example.test/external.js"></script>', '/index.html')).rejects.toThrow('no local byte receipt');
    await expect(createPublicStartupAudit(read)('<script src="/..%2Foutside.js"></script>', '/index.html')).rejects.toThrow('escapes its artifact');
  });

  it.each(["text/ecmascript", "application/ecmascript", "text/jscript", "text/livescript", "application/x-javascript", "text/javascript; charset=utf-8"])("counts browser-executable scripts with MIME type %s", async type => {
    const audit = createPublicStartupAudit(read);
    const report = await audit(`<script type="${type}" src="/_astro/shared.js"></script><script type="${type}">const ready = true;</script>`, '/index.html');
    expect(report.initialAssets.sort()).toEqual(['/_astro/shared.js', '/index.html#inline-0']);
    await expect(audit(`<script type="${type}" src="https://example.test/external.js"></script>`, '/index.html')).rejects.toThrow('no local byte receipt');
  });

  it("enforces the documented per-page gzip limits", () => {
    const report = { initialGzipBytes: 100 * 1024 + 1, heroGzipBytes: 300 * 1024 + 1, initialHeavyHeroAssets: [] };
    expect(publicStartupFailures(report)).toHaveLength(2);
  });
});
