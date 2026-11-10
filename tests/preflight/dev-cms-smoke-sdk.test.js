import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
const smoke = new URL("../../scripts/smoke-cms-functions.mjs", import.meta.url).href;

async function fixture(change = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "dev-smoke-sdk-"));
  try {
    cpSync(new URL("../../functions", import.meta.url), join(root, "functions"), {
      recursive: true, filter: path => !path.includes("node_modules"),
    });
    cpSync(new URL("../../firebase.dev.json", import.meta.url), join(root, "firebase.dev.json"));
    writeFileSync(join(root, "package.json"), "{}");
    symlinkSync(new URL("../../node_modules", import.meta.url), join(root, "node_modules"), "dir");
    symlinkSync(new URL("../../packages", import.meta.url), join(root, "packages"), "dir");
    const pkg = JSON.parse(readFileSync(join(root, "functions/package.json"), "utf8"));
    writeFileSync(join(root, "functions/package.json"), JSON.stringify({ ...pkg, main: "dev-index.js" }));
    writeFileSync(join(root, "functions/cloud-publication-wake.generated.json"), JSON.stringify({ schemaVersion: 1, environment: "development", enabled: false }));
    change(root);
    const source = pathToFileURL(`${root}/`).href;
    return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e",
      `import { readVerifiedDevManifest } from ${JSON.stringify(smoke)};
       console.log(JSON.stringify(await readVerifiedDevManifest(new URL(${JSON.stringify(source)}))));`,
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CMS_DEPLOYMENT_ENVIRONMENT: "development" } }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it("verifies actual Firebase SDK discovery against the separate reviewed dev manifest", async () => {
  const names = await fixture();
  expect(names).toHaveLength(45);
  expect(names).toContain("cmsCollectBoardwalkUsage");
  expect(names).toContain("cmsGetBoardwalkUsage");
  expect(names).toContain("cmsReaderV2");
  expect(names).not.toContain("cmsCuezStatus");
});
it.each(["missing export", "missing reader family", "extra export", "missing declaration", "production entry", "enabled wake", "production wake"])(
  "refuses %s before live smoke", async kind => {
    await expect(fixture(root => {
      const entry = join(root, "functions/dev-index.js");
      if (kind === "missing export") writeFileSync(entry, readFileSync(entry, "utf8") + "\ndelete exports.cmsReaderV2;\n");
      if (kind === "missing reader family") writeFileSync(entry, readFileSync(entry, "utf8") +
        "\ndelete exports.cmsReaderV1; delete exports.cmsReaderV2; delete exports.cmsReadPairCurrentCodeV2;\n");
      if (kind === "extra export") writeFileSync(entry, readFileSync(entry, "utf8") + "\nexports.cmsUnexpected = exports.health;\n");
      if (kind === "missing declaration") {
        const path = join(root, "functions/dev-manifest.js");
        writeFileSync(path, readFileSync(path, "utf8").replace('  cmsReaderV2: "./cms-reader-endpoints",', ""));
      }
      if (kind === "production entry") {
        const path = join(root, "functions/package.json");
        writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), main: "index.js" }));
      }
      if (kind.endsWith("wake")) writeFileSync(join(root, "functions/cloud-publication-wake.generated.json"), JSON.stringify({
        schemaVersion: 1, environment: kind === "production wake" ? "production" : "development", enabled: kind === "enabled wake",
      }));
    })).rejects.toThrow();
  },
);
