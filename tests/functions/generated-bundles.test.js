import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Functions load CommonJS bundles built from packages/content-core by the
// scripts/generate-*.mjs scripts. A source change without a rebuild ships a stale
// server contract (#2751: the validator had no `video` entry, so every video save
// failed). Each check rebuilds in memory and compares with the committed file.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const generators = readdirSync(resolve(repoRoot, "scripts"))
  .filter((name) => /^generate-.+\.mjs$/.test(name))
  .map((name) => {
    const script = readFileSync(resolve(repoRoot, "scripts", name), "utf8");
    const entry = script.match(/entryPoints:\s*\["([^"]+)"\]/)?.[1];
    const outfile = script.match(/outfile:\s*"([^"]+)"/)?.[1];
    return { name, script, entry, outfile };
  })
  .filter((generator) => generator.outfile?.startsWith("functions/lib/"));

function lf(text) {
  return text.replace(/\r\n/g, "\n");
}

describe("generated functions bundles", () => {
  it("finds the bundle generators", () => {
    expect(generators.map((generator) => generator.outfile)).toEqual(expect.arrayContaining([
      "functions/lib/block-content-validation.js",
      "functions/lib/post-formats.js",
      "functions/lib/posts-browse-contract.js",
      "functions/lib/video-block.js",
    ]));
  });

  it.each(generators.map((generator) => [generator.outfile, generator]))("%s matches its source", async (_outfile, generator) => {
    // The comparison is only fair while every generator uses these options.
    for (const option of ['bundle: true', 'platform: "node"', 'format: "cjs"', 'target: "node22"', 'legalComments: "none"']) {
      expect(generator.script, `${generator.name} ${option}`).toContain(option);
    }
    const committed = lf(readFileSync(resolve(repoRoot, generator.outfile), "utf8"));
    expect(committed.split("\n").slice(0, 2).join("\n")).toContain(`node scripts/${generator.name}`);
    const directory = mkdtempSync(join(tmpdir(), "njpbs-generated-bundle-"));
    const outfile = join(directory, "bundle.js");
    const scriptPath = join(repoRoot, "scripts", `.bundle-check-${randomUUID()}.mjs`);
    try {
      // Run the canonical generator, including its require-path plugin and
      // import.meta definition. Redirect only its output to private scratch.
      writeFileSync(scriptPath, generator.script.replace(/outfile:\s*"[^"]+"/,
        () => `outfile: ${JSON.stringify(outfile)}`));
      const result = spawnSync(process.execPath, [scriptPath], { cwd: repoRoot, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(lf(readFileSync(outfile, "utf8")) === committed,
        `${generator.outfile} is stale. Run: node scripts/${generator.name}`).toBe(true);
    } finally {
      rmSync(scriptPath, { force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
