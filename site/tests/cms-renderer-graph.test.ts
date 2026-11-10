// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fingerprintRendererGraph } from "../../scripts/lib/cms-renderer-graph.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const parserRequire = createRequire(new URL("../package.json", import.meta.url));
let cwd: string, baseline: string, original: Awaited<ReturnType<typeof fingerprintRendererGraph>>;
const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const content = (path: string) => git("show", `${baseline}:${path}`);
function commit(path: string, source: string) {
  const env = { ...process.env, GIT_INDEX_FILE: join(cwd, "test-index"), GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
  const command = (args: string[], input?: string) => execFileSync("git", args, { cwd, env, input, encoding: "utf8" }).trim();
  command(["read-tree", baseline]);
  const blob = command(["hash-object", "-w", "--stdin"], source);
  command(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`]);
  const tree = command(["write-tree"]);
  return command(["commit-tree", tree, "-p", baseline], "fixture\n");
}
const graph = (sha: string) => fingerprintRendererGraph(sha, { cwd, parserRequire });
beforeAll(async () => {
  cwd = mkdtempSync(join(tmpdir(), "cms-renderer-graph-"));
  git("init", "--bare", "-q");
  const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim();
  mkdirSync(join(cwd, "objects/info"), { recursive: true });
  writeFileSync(join(cwd, "objects/info/alternates"), resolve(root, common, "objects") + "\n");
  baseline = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  original = await graph(baseline);
}, 20000);
afterAll(() => { if (cwd) rmSync(cwd, { recursive: true, force: true }); });

describe("committed renderer inputs", () => {
  it.each(["firestore.rules", "firestore.indexes.json", "storage.rules", "scripts/backfill-media-discovery.mjs"])("does not replace Preview for an independent policy/repair edit (%s)", async path => {
    expect(original).not.toBeNull();
    expect((await graph(commit(path, content(path) + "\n ")))?.fingerprint).toBe(original!.fingerprint);
  });
  it("resolves actual renderer and retained-reader closures without running them", () => {
    expect(original).not.toBeNull();
    for (const path of ["functions/lib/home-retained-sources.js", "functions/lib/current-public-code-source.js", "functions/lib/media-usage.js"]) {
      expect(original!.dependencyPaths).toContain(path);
    }
  });
  it("ignores an unrelated Functions module but tracks a retained-reader dependency", async () => {
    const unrelated = "functions/lib/video-transcript-elevenlabs.js";
    expect(original!.dependencyPaths).not.toContain(unrelated);
    expect((await graph(commit(unrelated, content(unrelated) + "\n// unrelated edit\n")))?.fingerprint).toBe(original!.fingerprint);
    const retained = "functions/lib/current-public-code-source.js";
    expect((await graph(commit(retained, content(retained) + "\n// retained-reader edit\n")))?.fingerprint).not.toBe(original!.fingerprint);
  });
  it.each([
    ['import(process.env.RENDERER_MODULE);', "site/src/lib/unknown-input.ts"],
    ['import "../../../functions/missing-module.js";', "site/src/lib/unknown-input.ts"],
    ['const inputs = import.meta.glob("../../../functions/**/*.js");', "site/src/lib/unknown-input.ts"],
    ['const inputs = import.meta.glob(process.env.MODULE_GLOB);', "site/src/lib/unknown-input.ts"],
    ['import { createRequire as load } from "module"; const req = load(import.meta.url); req("../../../functions/lib/video-transcript-elevenlabs");', "site/src/lib/unknown-input.ts"],
    ['import * as loader from "module"; const req = loader.createRequire(import.meta.url); req("../../../functions/lib/video-transcript-elevenlabs");', "site/src/lib/unknown-input.ts"],
    ['const loader = require("module"); const req = loader["create" + "Require"](import.meta.url); req("../../../functions/lib/video-transcript-elevenlabs");', "site/src/lib/unknown-input.ts"],
    ['const loader = await import("module"); const req = loader["create" + "Require"](import.meta.url); req("../../../functions/lib/video-transcript-elevenlabs");', "site/src/lib/unknown-input.ts"],
    ["functions/\n", ".dockerignore"],
    ['const load = require; load("../../../functions/lib/video-transcript-elevenlabs");', "site/src/lib/unknown-input.ts"],
    ['require.call(null, "../../../functions/lib/video-transcript-elevenlabs");', "site/src/lib/unknown-input.ts"],
    ['const execute = eval; execute(process.env.MODULE_CODE);', "site/src/lib/unknown-input.ts"],
    ['const execute = Function; execute(process.env.MODULE_CODE)();', "site/src/lib/unknown-input.ts"],
    ['process.getBuiltinModule("node:module")["createRequire"](import.meta.url)("../../../functions/lib/video-transcript-elevenlabs");', "site/src/lib/unknown-input.ts"],
    ['const load = process.mainModule.require; load("../../../functions/lib/video-transcript-elevenlabs");', "site/src/lib/unknown-input.ts"],
    ['import { createRequire } from "node:module"; export const requireLocal = createRequire(import.meta.url);', "site/src/lib/unknown-input.ts"],
    ['import { createRequire } from "node:module"; export default createRequire(import.meta.url);', "site/src/lib/unknown-input.ts"],
    ['import { createRequire } from "node:module"; let r; r = createRequire(import.meta.url); r("../../../functions/lib/video-transcript-elevenlabs");', "site/src/lib/unknown-input.ts"],
    ['import { createRequire } from "node:module"; let r = createRequire(import.meta.url); r("../../../functions/lib/video-transcript-elevenlabs");', "site/src/lib/unknown-input.ts"],
    ['import { createRequire } from "node:module"; const req = createRequire(import.meta.url); const resolver = req.resolve;', "site/src/lib/unknown-input.ts"],
    ['let mod = "./public-content-links.ts"; mod = "../../../functions/lib/video-transcript-elevenlabs"; import(mod);', "site/src/lib/unknown-input.ts"],
    ['const mod = "./public-content-links.ts"; async function load(mod) { return import(mod); }', "site/src/lib/unknown-input.ts"],
    ['const mod = "./public-content-links.ts"; try { throw 1; } catch (mod) { import(mod); }', "site/src/lib/unknown-input.ts"],
    ['const mod = "./public-content-links.ts"; function load({mod}) { return import(mod); }', "site/src/lib/unknown-input.ts"],
    ['const mod = "./public-content-links.ts"; for (const mod of process.argv) { import(mod); }', "site/src/lib/unknown-input.ts"],
    ['var mod = "./public-content-links.ts"; import(mod);', "site/src/lib/unknown-input.ts"],
    ['const mod = "./public-content-links.ts"; const {mod: target} = process.env; import(target);', "site/src/lib/unknown-input.ts"],
    ['const mod = "./public-content-links.ts"; for (const mod in process.env) { import(mod); }', "site/src/lib/unknown-input.ts"],
    ['const modules = import.meta.glob("/../functions/lib/*.js");', "site/src/lib/unknown-input.ts"],
    ['const modules = import.meta.glob("/scripts/*.ts");', "site/src/lib/unknown-input.ts"],
    ['const modules = import.meta.glob("./*.ts", {base: "../../functions"});', "site/src/lib/unknown-input.ts"],
    ['function load(Astro) { return Astro.glob("./*.js"); }', "site/src/lib/unknown-input.ts"],
  ])("fails closed for unsupported source edges (%s)", async (source, path) => {
    expect(await graph(commit(path, source))).toBeNull();
  });
  it.each(["site/scripts/compiled-renderer-adapter.mjs", "preview-renderer/worker.ts",
    "scripts/prepare-preview-renderer.mjs", "site/scripts/deploy-cms-preview-cloud.ts"])("rejects changed launch contracts (%s)", async launcher => {
    const reasons: unknown[] = [];
    expect(await fingerprintRendererGraph(commit(launcher, content(launcher) + "\n// changed launcher\n"),
      { cwd, parserRequire, onUnknown: (code: string, file: string) => reasons.push({ code, file }) })).toBeNull();
    expect(reasons).toEqual([{ code: "build_launch_contract", file: launcher }]);
  });
  it("rejects regenerated opaque require wrappers", async () => {
    const bundle = "functions/lib/home-retained-sources.js";
    const reasons: unknown[] = [];
    expect(await fingerprintRendererGraph(commit(bundle, content(bundle) + "\n// regenerated bundle\n"),
      { cwd, parserRequire, onUnknown: (code: string, file: string) => reasons.push({ code, file }) })).toBeNull();
    expect(reasons).toEqual([{ code: "functions_loader_contract", file: bundle }]);
  });
  it("includes a new static Functions edge discovered from an Astro frontmatter", async () => {
    const sha = commit("site/src/components/GraphProbe.astro", '---\nimport "../../../functions/lib/video-transcript-elevenlabs.js";\n---\n<p>Graph probe</p>');
    const result = await graph(sha);
    expect(result).not.toBeNull();
    expect(result!.dependencyPaths).toContain("functions/lib/video-transcript-elevenlabs.js");
  });
  it("resolves the actual lexical const even when a separate function shadows its name", async () => {
    const sha = commit("site/src/lib/lexical-target.ts", 'const mod = "../../../functions/lib/video-transcript-elevenlabs"; function echo(mod) { return mod; } import(mod);');
    expect((await graph(sha))?.dependencyPaths).toContain("functions/lib/video-transcript-elevenlabs.js");
  });
});


it("binds resolved API inputs and rendering source dependencies into the graph", async () => {
  const configured = await fingerprintRendererGraph(baseline, { cwd, parserRequire,
    env: { CMS_PRODUCTION_API_ORIGIN: "https://api.fixture.test" } });
  const changed = await fingerprintRendererGraph(baseline, { cwd, parserRequire,
    env: { CMS_PRODUCTION_API_ORIGIN: "https://other-api.fixture.test" } });
  expect(configured).not.toBeNull(); expect(changed).not.toBeNull();
  expect(changed!.fingerprint).not.toBe(configured!.fingerprint);
  for (const path of ["scripts/render-development-config.mjs", "config/development-inputs.json"]) {
    const result = await graph(commit(path, content(path) + "\n \n"));
    expect(result).not.toBeNull(); expect(result!.fingerprint).not.toBe(original!.fingerprint);
  }
});
