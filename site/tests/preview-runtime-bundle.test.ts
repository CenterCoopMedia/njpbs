// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildPreviewRuntime } from "../scripts/build-preview-runtime.mjs";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "preview-runtime-bundle-"));
  directories.push(directory);
  const root = path.join(directory, "original source");
  for (const child of ["site/scripts", "site/src/lib", "functions", "site/node_modules/external-sdk"]) {
    await mkdir(path.join(root, child), { recursive: true });
  }
  await writeFile(path.join(root, "functions/package.json"), '{"name":"fixture-functions"}');
  await writeFile(path.join(root, "functions/value.cjs"), 'module.exports = "functions-boundary";');
  await writeFile(path.join(root, "site/node_modules/external-sdk/package.json"), '{"name":"external-sdk","main":"index.cjs"}');
  await writeFile(path.join(root, "site/node_modules/external-sdk/index.cjs"), 'module.exports = "external-sdk";');
  await writeFile(path.join(root, "site/src/lib/nested.ts"), '#!/usr/bin/env node\nexport const original = import.meta.url;');
  await writeFile(path.join(root, "site/scripts/cms-preview-cloud-runtime.ts"), `
    import { createRequire } from "node:module";
    import sdk from "external-sdk";
    import { original } from "../src/lib/nested.ts";
    const require = createRequire(new URL("../../functions/package.json", import.meta.url));
    export const facts = { original, current: import.meta.url, literal: "import.meta.url", value: require("./value.cjs"), sdk };
    export function serveCmsPreviewCloud() { throw new Error("must not run during import"); }
  `);
  return { root, directory };
}
it("preserves relocated original paths and external SDK boundaries without starting clients", async () => {
  const { root, directory } = await fixture();
  const result = await buildPreviewRuntime(root);
  expect(Object.keys(result.metafile.inputs).some(file => file.includes("node_modules"))).toBe(false);
  expect(Object.values(result.metafile.outputs).flatMap(output => output.imports))
    .toContainEqual(expect.objectContaining({ path: "external-sdk", external: true }));
  const relocated = path.join(directory, "relocated source");
  await rename(root, relocated);
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval",
    'const {facts} = await import("./site/.compiled-renderer/runtime/cloud.mjs"); console.log(JSON.stringify(facts));'],
  { cwd: relocated, env: { PATH: "/usr/bin:/bin" }, timeout: 10_000 });
  const facts = JSON.parse(stdout);
  expect(facts.current).toBe(new URL(`file://${relocated}/site/scripts/cms-preview-cloud-runtime.ts`).href);
  expect(facts.original).toBe(new URL(`file://${relocated}/site/src/lib/nested.ts`).href);
  expect(facts).toMatchObject({ literal: "import.meta.url", value: "functions-boundary", sdk: "external-sdk" });
});
it("refuses a dependency bundled from outside owned source", async () => {
  const { root, directory } = await fixture();
  await writeFile(path.join(directory, "outside.mjs"), "export const outside = true;");
  await writeFile(path.join(root, "site/scripts/cms-preview-cloud-runtime.ts"), 'export { outside } from "../../../outside.mjs";');
  await expect(buildPreviewRuntime(root)).rejects.toThrow("only owned source");
});
