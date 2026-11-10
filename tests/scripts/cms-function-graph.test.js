import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fingerprintFunctionGraph, fingerprintInputs, fingerprintPaths, functionGraphSource, readCommittedBlobs, startReceipt, completeReceipt } from "../../scripts/lib/cms-component-receipt.mjs";
import { INDEPENDENT_INPUTS } from "../../scripts/lib/deployment-components.mjs";
import { functionDeploymentPhase, selectedFunctionBatches } from "../../scripts/deploy-cms-function-batches.mjs";

const directories = [];
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function repository() {
  const cwd = mkdtempSync(join(tmpdir(), "cms-graph-"));
  directories.push(cwd);
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (path, source) => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), source); };
  git("init", "-q");
  write("functions/package.json", '{"dependencies":{}}');
  write("functions/index.js", 'lazyExport("health", "./health");\nlazyExport("cmsPreview", "./preview");\nlazyExport("cmsPreviewStatus", "./preview");\n');
  write("functions/health.js", 'exports.health = require("./lib/shared");');
  write("functions/preview.js", 'exports.cmsPreview = require("./lib/shared"); exports.cmsPreviewStatus = "CMS_PREVIEW_RENDERER_SHA";');
  write("functions/lib/shared.js", 'module.exports = 1;');
  const commit = () => { git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"); return git("rev-parse", "HEAD"); };
  return { cwd, write, commit, graph: sha => fingerprintFunctionGraph(sha, { cwd }) };
}

describe("committed Functions module graph", () => {
  it.each([
    ["firestoreRules", "firestore.rules"], ["firestoreIndexes", "firestore.indexes.json"], ["storageRules", "storage.rules"],
    ["migrations", "scripts/backfill-page-seed-media.mjs"], ["migrations", "scripts/backfill-media-thumbnails.mjs"],
    ["migrations", "scripts/seed-media-categories.mjs"], ["migrations", "scripts/backfill-media-category-assignments.mjs"],
    ["migrations", "scripts/backfill-author-profiles.mjs"], ["migrations", "scripts/seed-content-sections.mjs"],
    ["migrations", "scripts/backfill-byline-projections.mjs"], ["migrations", "scripts/backfill-media-discovery.mjs"],
  ])("fingerprints %s independently when only %s changes", async (component, file) => {
    const repo = repository();
    repo.write(file, "before");
    repo.write("cms-api/src/index.ts", "export default {};");
    // The CMS API fingerprint discovers bundle inputs from committed Worker sources.
    for (const name of ["wrangler.jsonc", "wrangler.dev.jsonc"]) repo.write(`cms-api/${name}`, '{ "main": "src/index.ts" }\n');
    repo.write("cms-api/tsconfig.json", "{}\n");
    repo.write("package-lock.json", '{ "packages": {} }\n');
    const before = repo.commit(), graph = await repo.graph(before);
    const original = await Promise.all(["functions", "renderer", "cmsApi"].map(name => fingerprintInputs(before, name, { cwd: repo.cwd })));
    const identity = await fingerprintPaths(before, INDEPENDENT_INPUTS[component], { cwd: repo.cwd });
    repo.write(file, "after");
    const after = repo.commit();
    expect(await repo.graph(after)).toEqual(graph);
    expect(await Promise.all(["functions", "renderer", "cmsApi"].map(name => fingerprintInputs(after, name, { cwd: repo.cwd })))).toEqual(original);
    expect(await fingerprintPaths(after, INDEPENDENT_INPUTS[component], { cwd: repo.cwd })).not.toBe(identity);
  });
  it("reads immutable blobs in one byte-framed batch, including embedded headers and Unicode", async () => {
    const repo = repository();
    const source = 'π café\n' + 'a'.repeat(40) + ' blob 3\nabc\n\0';
    repo.write("payload.txt", source);
    const sha = repo.commit();
    const git = (...args) => execFileSync("git", args, { cwd: repo.cwd, encoding: "utf8" }).trim();
    const id = git("rev-parse", `${sha}:payload.txt`);
    expect(await readCommittedBlobs([id, id], { cwd: repo.cwd })).toEqual(new Map([[id, source]]));
    await expect(readCommittedBlobs(["invalid"], { cwd: repo.cwd })).rejects.toThrow();
    await expect(readCommittedBlobs([git("rev-parse", `${sha}^{tree}`)], { cwd: repo.cwd })).rejects.toThrow();
  });
  it("fingerprints shared closures, preview readers, and committed source only", async () => {
    const repo = repository(), a = repo.commit(), first = await repo.graph(a);
    expect(Object.keys(first.exports).sort()).toEqual(["cmsPreview", "cmsPreviewStatus", "health"]);
    expect(first.exports.health.preview).toBe(false);
    expect(first.exports.cmsPreview.preview).toBe(true);
    repo.write("functions/health.js", 'exports.health = 42;');
    expect(await repo.graph(a)).toEqual(first);
    const second = await repo.graph(repo.commit());
    expect(second.exports.health.fingerprint).not.toBe(first.exports.health.fingerprint);
    expect(second.exports.cmsPreview).toEqual(first.exports.cmsPreview);
    repo.write("functions/lib/shared.js", 'module.exports = 2;');
    const third = await repo.graph(repo.commit());
    expect(third.exports.cmsPreview.fingerprint).not.toBe(second.exports.cmsPreview.fingerprint);
    expect(third.exports.cmsPreviewStatus.fingerprint).toBe(third.exports.cmsPreview.fingerprint);
    expect(third.exports.health).toEqual(second.exports.health);
  });

  it("keeps independent receipt graphs isolated from caller mutation", async () => {
    const repo = repository(), sha = repo.commit(), first = await repo.graph(sha);
    const original = structuredClone(first);
    first.globalFingerprint = "0".repeat(64);
    first.exports.health.fingerprint = "0".repeat(64);
    delete first.exports.cmsPreview;
    expect(await repo.graph(sha)).toEqual(original);
  });

  it("requires the source object in the requested repository even after another repository proved it", async () => {
    const first = repository(), sha = first.commit();
    expect(await first.graph(sha)).not.toBeNull();
    const other = repository(); other.write("functions/health.js", "exports.health = 99;"); other.commit();
    expect(await other.graph(sha)).toBeNull();
  });

  it("does not parse or execute an unreferenced source blob included in the batch", async () => {
    const repo = repository(), first = await repo.graph(repo.commit());
    repo.write("functions/unreachable.js", "invalid JavaScript that must never execute (");
    const second = await repo.graph(repo.commit());
    expect(second.exports).toEqual(first.exports);
  });

  it("still fingerprints dependencies outside the prefetched Functions and package paths", async () => {
    const repo = repository();
    repo.write("functions/health.js", 'exports.health = require("../outside.js");');
    repo.write("outside.js", "module.exports = 1;");
    const first = await repo.graph(repo.commit());
    repo.write("outside.js", "module.exports = 2;");
    const second = await repo.graph(repo.commit());
    expect(second.exports.health.fingerprint).not.toBe(first.exports.health.fingerprint);
    expect(second.exports.cmsPreview).toEqual(first.exports.cmsPreview);
  });

  it("tracks static lazy imports, cycles and preview runtime readers", async () => {
    const repo = repository();
    repo.write("functions/health.js", 'exports.health = () => import("./other.mjs");');
    repo.write("functions/other.mjs", 'import "./health.js"; export const control = "cmsPreviewRuntime";');
    const first = await repo.graph(repo.commit());
    expect(first.exports.health.preview).toBe(true);
    repo.write("functions/other.mjs", 'import "./health.js"; export const control = "changed";');
    expect((await repo.graph(repo.commit())).exports.health.fingerprint).not.toBe(first.exports.health.fingerprint);
  });

  it("attributes index-level startup closures to every export and the full-release fingerprint", async () => {
    const repo = repository();
    repo.write("functions/index.js", 'const startup = require("./startup");\nlazyExport("health", "./health");\nlazyExport("cmsPreview", "./preview");\nlazyExport("cmsPreviewStatus", "./preview");\n');
    repo.write("functions/startup.js", 'module.exports = require("./target");');
    repo.write("functions/target.js", 'module.exports = 1;');
    const first = await repo.graph(repo.commit());
    repo.write("functions/target.js", 'module.exports = 2;');
    const second = await repo.graph(repo.commit());
    expect(second.globalFingerprint).not.toBe(first.globalFingerprint);
    for (const name of Object.keys(first.exports)) {
      expect(second.exports[name].fingerprint).not.toBe(first.exports[name].fingerprint);
    }
  });
  it("fails closed on a new index-level module loader too", async () => {
    const repo = repository();
    repo.write("functions/index.js", 'const { createRequire } = require("node:module");\n' +
      'lazyExport("health", "./health");\nlazyExport("cmsPreview", "./preview");\n');
    expect(await repo.graph(repo.commit())).toBeNull();
  });
  it("treats loader words in comments and strings as data", async () => {
    const repo = repository();
    repo.write("functions/health.js", '// A Cloud Function (#1261) does not eval or createRequire.\nexports.health = "getBuiltinModule mainModule eval Function (";');
    expect(await repo.graph(repo.commit())).not.toBeNull();
  });

  it.each([
    'module.exports = require(process.env.MODULE);',
    'const load = require; module.exports = load("./lib/shared");',
    'module.exports = import(process.env.MODULE);',
    'module.exports = require("./missing");',
    'module.exports = require("undeclared-package");',
    'eval(process.env.CODE);',
    'const loader = require("node:" + "module"); module.exports = loader["create" + "Require"](__filename)("./lib/shared");',
    'const execute = eval; execute(process.env.MODULE_CODE);',
    'const execute = Function; execute(process.env.MODULE_CODE)();',
    'const load = process.getBuiltinModule("node:module")["createRequire"](__filename); module.exports = load("./lib/shared");',
    'const load = process.mainModule.require; module.exports = load("./lib/shared");',
  ])("fails closed for an unresolvable graph: %s", async source => {
    const repo = repository();
    repo.write("functions/health.js", source);
    expect(await repo.graph(repo.commit())).toBeNull();
  });

  it("invalidates the full-release configuration for assets, manifests and index changes", async () => {
    const repo = repository(), first = await repo.graph(repo.commit());
    repo.write("functions/assets/logo.png", "fixture");
    const second = await repo.graph(repo.commit());
    expect(second.globalFingerprint).not.toBe(first.globalFingerprint);
    expect(second.exports).toEqual(first.exports);
    repo.write("site/view.js", "site only");
    expect(await repo.graph(repo.commit())).toEqual(second);
  });
  it("keeps shared runtime JSON in the global Functions configuration guard", async () => {
    const repo = repository();
    repo.write("functions/lib/public-asset-hosts.json", '["before.example.org"]');
    repo.write("functions/health.js", 'exports.health = require("./lib/public-asset-hosts.json");');
    const before = await repo.graph(repo.commit());
    repo.write("functions/lib/public-asset-hosts.json", '["after.example.org"]');
    const after = await repo.graph(repo.commit());
    expect(after.globalFingerprint).not.toBe(before.globalFingerprint);
    expect(after.exports.health.fingerprint).not.toBe(before.exports.health.fingerprint);
  });

  it("records module fingerprints and the actual preserved preview pin across mutation completion", async () => {
    const repo = repository(), sha = repo.commit(), pin = "b".repeat(40);
    let receipt;
    const firestore = {
      doc: () => ({ protocol: true }),
      collection: () => ({ doc: () => ({}) }),
      runTransaction: work => work({ get: async ref => ref.protocol ? { exists: false } : ({ exists: !!receipt, data: () => receipt }), set: (_ref, value) => { receipt = value; } }),
    };
    await startReceipt(firestore, { component: "functions", sourceSha: sha, previewRendererSha: pin, trustedWorkflowSha: sha, runId: "1", runAttempt: 1 }, { cwd: repo.cwd });
    const expected = await repo.graph(sha);
    expect(receipt.mutation.functionGraph).toEqual(expected);
    await completeReceipt(firestore, { component: "functions", sourceSha: sha, runId: "1", runAttempt: 1, providerIdentities: { inventoryFingerprint: "f".repeat(64) } });
    expect(receipt.mutation.functionGraph).toEqual(expected);
    expect(receipt.mutation.previewRendererSha).toBe(pin);
  });

  it("deploys only validated selections while retaining the complete inventory manifest", () => {
    const names = ["health", "cmsPreview", "cmsPreviewStatus"];
    expect(selectedFunctionBatches(names, "functions:cmsPreview,functions:cmsPreviewStatus")).toEqual([["cmsPreview", "cmsPreviewStatus"]]);
    expect(selectedFunctionBatches(names, "all")).toEqual([names]);
    for (const selection of ["", "functions:unknown", "functions:health,functions:health", "all;exit"]) {
      expect(() => selectedFunctionBatches(names, selection)).toThrow();
    }
  });
  it("discovers all five retained-reader edges hidden behind generated createRequire aliases", async () => {
    const source = execFileSync("git", ["show", "HEAD:functions/lib/home-retained-sources.js"], { encoding: "utf8" });
    const blob = execFileSync("git", ["rev-parse", "HEAD:functions/lib/home-retained-sources.js"], { encoding: "utf8" }).trim();
    const { build } = await import("esbuild");
    const edges = [];
    await build({ stdin: { contents: functionGraphSource(source, "functions/lib/home-retained-sources.js",
      `100644 blob ${blob}`), resolveDir: "/" }, bundle: true, write: false,
      platform: "node", logLevel: "silent", plugins: [{ name: "collect-only", setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => { edges.push(args.path); return { path: args.path, external: true }; });
      } }] });
    for (const path of ["./public-media-manifest.js", "./media-usage.js", "./public-deployment.js", "./publication-target.js", "./current-public-code-source.js"]) {
      expect(edges).toContain(path);
    }
    expect(() => functionGraphSource(source, "functions/lib/home-retained-sources.js", "100644 blob " + "a".repeat(40))).toThrow();
    expect(() => functionGraphSource('const load = require("node:module").createRequire(__filename); load("./hidden");', "functions/new-loader.js", "100644 blob " + "a".repeat(40))).toThrow();
  });

  it("keeps preview readers out of the pre-pause phase and verifies the full inventory after it", () => {
    const names = ["health", "cmsPreview", "cmsPreviewStatus"];
    expect(functionDeploymentPhase(names, "functions:health", "before-preview", "functions:cmsPreview,functions:cmsPreviewStatus"))
      .toEqual({ batches: [["health"]], readyNames: ["health"] });
    expect(functionDeploymentPhase(names, "functions:cmsPreview,functions:cmsPreviewStatus"))
      .toEqual({ batches: [["cmsPreview", "cmsPreviewStatus"]], readyNames: names });
    for (const [selection, phase, preview] of [["all", "before-preview", "functions:cmsPreview"],
      ["functions:cmsPreview", "before-preview", "functions:cmsPreview"],
      ["functions:health", "unknown", "functions:cmsPreview"], ["functions:health", "before-preview", ""]]) {
      expect(() => functionDeploymentPhase(names, selection, phase, preview)).toThrow();
    }
  });
});
