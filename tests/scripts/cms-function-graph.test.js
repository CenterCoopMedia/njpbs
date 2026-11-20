import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configurationFingerprint, fingerprintFunctionGraph, fingerprintInputs, fingerprintPaths, functionGraphSource, readCommittedBlobs, startReceipt, completeReceipt } from "../../scripts/lib/cms-component-receipt.mjs";
import { INDEPENDENT_INPUTS } from "../../scripts/lib/deployment-components.mjs";
import { functionDeploymentPhase, selectedFunctionBatches } from "../../scripts/deploy-cms-function-batches.mjs";
import { contractRecipe } from "../../scripts/lib/functions-contracts.mjs";
import { cloudWakeConfigurationFingerprint, decideRelease, deploymentVariablesFingerprint, functionSourceProof,
  runtimeParameterChanges } from "../../scripts/lib/cms-release-plan.mjs";

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
  write("config/functions-configuration.json", '{"inputs":{},"parameters":{},"secrets":{},"provider":{}}');
  const commit = () => { git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"); return git("rev-parse", "HEAD"); };
  return { cwd, write, commit, graph: sha => fingerprintFunctionGraph(sha, { cwd }) };
}

async function releaseInputs(before, after, cwd) {
  const deps = { cwd, includeRuntimeInputs: true };
  const [prior, target, oldFingerprint, functionsFingerprint] = await Promise.all([
    fingerprintFunctionGraph(before, deps), fingerprintFunctionGraph(after, deps),
    fingerprintInputs(before, "functions", deps), fingerprintInputs(after, "functions", deps),
  ]);
  const configurationFingerprint = "b".repeat(64);
  const rendererFingerprint = "c".repeat(64);
  const funcs = { inventoryFingerprint: "d".repeat(64) };
  const renderer = { rendererSha: before };
  const receipt = mutation => ({ schemaVersion: 1, state: "complete", mutation });
  return {
    prior, target,
    plan: {
      deploySha: after, functionGraph: target.graph, sourceProof: functionSourceProof(prior, target, prior.graph),
      functionsFingerprint, configurationFingerprint, rendererFingerprint, rendererGraphAvailable: true,
      renderFingerprint: configurationFingerprint, receiptRenderFingerprint: configurationFingerprint,
      liveFunctionsIdentities: funcs, liveRendererIdentities: renderer,
      targetHasAdminRevisionIntake: true, liveHasAdminRevisionIntake: true,
      functionsReceipt: receipt({ sourceSha: before, inputFingerprint: oldFingerprint, configurationFingerprint,
        functionGraph: prior.graph, providerIdentities: funcs }),
      rendererReceipt: receipt({ sourceSha: before, inputFingerprint: rendererFingerprint, providerIdentities: renderer }),
    },
  };
}

describe("committed Functions module graph", () => {
  it("replays the November 19 rollout from both committed sources", async () => {
    const { before, after, removedVariable, count, batches } =
      JSON.parse(readFileSync(new URL("../fixtures/cms-functions-nov-19.json", import.meta.url), "utf8"));
    const { plan, target } = await releaseInputs(before, after);
    const table = JSON.parse(execFileSync("git", ["show", `${before}:config/functions-configuration.json`], { encoding: "utf8" }));
    const nextTable = JSON.parse(execFileSync("git", ["show", `${after}:config/functions-configuration.json`], { encoding: "utf8" }));
    expect(table.inputs[removedVariable].variable).toBe(removedVariable);
    expect(nextTable.inputs[removedVariable].variable).toBeUndefined();
    const manifest = Object.keys(target.graph.exports).sort();
    expect(manifest).toHaveLength(count);
    // The run log records equality outcomes. The GitHub Variables values and
    // provider payloads are not part of the replay data.
    const edge = "e".repeat(64);
    const wake = { environment: "production", enabled: true };
    const variables = { [removedVariable]: nextTable.inputs[removedVariable].default };
    const oldVariableNames = [...new Set(Object.values(table.inputs).map(row => row.variable).filter(Boolean))].sort();
    const oldVariablesFingerprint = configurationFingerprint({ variables: JSON.stringify(Object.fromEntries(
      oldVariableNames.map(key => [key, variables[key] ?? ""]))) });
    plan.functionsReceipt.mutation.variablesFingerprint = oldVariablesFingerprint;
    plan.functionsReceipt.mutation.configurationFingerprint = cloudWakeConfigurationFingerprint(edge, wake, oldVariablesFingerprint);
    const variablesFingerprint = deploymentVariablesFingerprint(JSON.stringify(variables));
    expect(variablesFingerprint).not.toBe(oldVariablesFingerprint);
    const result = decideRelease({ ...plan, variablesFingerprint, manifestNames: manifest, runtimeChanges: {},
      configurationFingerprint: cloudWakeConfigurationFingerprint(edge, wake, variablesFingerprint),
      baselineConfigurationFingerprint: plan.functionsReceipt.mutation.configurationFingerprint });
    expect(result).toMatchObject({ functionDeployTargets: "all", releaseReason: "functions_configuration_changed" });
    expect(result.functionReasons).toEqual(Object.fromEntries(manifest.map(name => [name, ["functions_configuration_changed"]])));
    const selectedBatches = selectedFunctionBatches(manifest, result.functionDeployTargets);
    expect(selectedBatches).toHaveLength(batches);
  });

  it("skips a variable-list edit when the committed closures and deployed values agree", async () => {
    const repo = repository();
    repo.write("config/functions-configuration.json", '{"inputs":{"TVSS_CALLSIGN":{"variable":"TVSS_CALLSIGN"}},"parameters":{},"secrets":{},"provider":{}}');
    const before = repo.commit();
    repo.write("config/functions-configuration.json", '{"inputs":{"TVSS_CALLSIGN":{"default":"new"}},"parameters":{},"secrets":{},"provider":{}}');
    const { plan, target } = await releaseInputs(before, repo.commit(), repo.cwd);
    const environmentVariables = { TVSS_CALLSIGN: "new" };
    const live = Object.keys(target.graph.exports).map(name => ({ name, serviceConfig: { environmentVariables } }));
    const runtimeChanges = runtimeParameterChanges(live, environmentVariables, target.reads, ["TVSS_CALLSIGN"]);
    expect(plan.functionsFingerprint).not.toBe(plan.functionsReceipt.mutation.inputFingerprint);
    const inputs = { ...plan, variablesFingerprint: "e".repeat(64), runtimeChanges };
    expect(decideRelease({ ...inputs, manifestNames: null }))
      .toMatchObject({ functionDeployTargets: "", releaseReason: "unchanged",
        functionsMutated: false, configurationRequiresRelease: false, previewPaused: false });
    expect(decideRelease({ ...inputs, manifestNames: ["health"] }))
      .toMatchObject({ functionDeployTargets: "all", releaseReason: "function_manifest_mismatch" });
  });

  it("deploys every transitive reader of a changed module and proves literal parameter reads", async () => {
    const repo = repository();
    repo.write("functions/health.js", "exports.health = 42;");
    repo.write("functions/lib/shared.js", "module.exports = () => process.env.TVSS_CALLSIGN;");
    const before = repo.commit();
    repo.write("functions/lib/shared.js", "module.exports = () => process.env.TVSS_CALLSIGN.trim();");
    const { plan, target } = await releaseInputs(before, repo.commit(), repo.cwd);
    expect(target.reads.cmsPreview).toEqual({ keys: ["CMS_PREVIEW_RENDERER_SHA", "TVSS_CALLSIGN"], unknown: false });
    expect(target.reads.health).toEqual({ keys: [], unknown: false });
    expect(decideRelease(plan)).toMatchObject({ functionDeployTargets: "functions:cmsPreview,functions:cmsPreviewStatus",
      functionReasons: { cmsPreview: ["source_closure_changed"], cmsPreviewStatus: ["source_closure_changed"], health: ["unchanged"] } });
    repo.write("functions/health.js", "exports.health = key => process.env[key];");
    const opaque = await fingerprintFunctionGraph(repo.commit(), { cwd: repo.cwd, includeRuntimeInputs: true });
    expect(opaque.reads.health).toEqual({ keys: [], unknown: true });
  });
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

  it("keeps the pre-recipe build wrapper outside retained release fingerprints", async () => {
    const repo = repository();
    const fingerprints = async sha => Promise.all([
      fingerprintInputs(sha, "functions", { cwd: repo.cwd }),
      fingerprintInputs(sha, "renderer", { cwd: repo.cwd }),
    ]);
    const before = await fingerprints(repo.commit());
    // PR #201 shipped this wrapper before receipts included any contract build inputs.
    repo.write("scripts/build-functions-contracts.mjs", 'throw new Error("Retained local build wrapper");');
    expect(await fingerprints(repo.commit())).toEqual(before);
  });

  it("fingerprints a committed contract change only for the functions that use it", async () => {
    const repo = repository();
    const file = "packages/content-core/src/example.ts";
    repo.write(contractRecipe, JSON.stringify({ entries: { example: file } }));
    repo.write("package-lock.json", readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"));
    repo.write("functions/health.js", 'exports.health = require("./lib/example");');
    repo.write("config/development-inputs.json", JSON.stringify({ schemaVersion: 1, inputs: {
      CMS_DEV_MEDIA_ORIGIN: { kind: "origin", placeholder: "https://dev-media.example.org", files: [file] },
    } }));
    repo.write(file, 'export const value = "https://dev-media.example.org";');
    const before = repo.commit(), first = await repo.graph(before);
    expect(first).not.toBeNull();
    repo.write(file, 'export const value = "https://committed.fixture.test";');
    expect(await repo.graph(before)).toEqual(first);
    const second = await repo.graph(repo.commit());
    expect(second.exports.health.fingerprint).not.toBe(first.exports.health.fingerprint);
    expect(second.exports.cmsPreview).toEqual(first.exports.cmsPreview);
    const configured = await fingerprintFunctionGraph(before, {
      cwd: repo.cwd, env: { CMS_DEV_MEDIA_ORIGIN: "https://configured.fixture.test" },
    });
    expect(configured.exports.health.fingerprint).not.toBe(first.exports.health.fingerprint);
    expect(configured.exports.cmsPreview).toEqual(first.exports.cmsPreview);
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
  it("discovers all five retained-reader edges in the generated modules", async () => {
    const source = readFileSync(new URL("../../functions/lib/home-retained-sources.js", import.meta.url), "utf8");
    const { build } = await import("esbuild");
    const edges = [];
    await build({ stdin: { contents: functionGraphSource(source, "functions/lib/home-retained-sources.js",
      "100644 generated fixture"), resolveDir: "/" }, bundle: true, write: false,
      platform: "node", logLevel: "silent", plugins: [{ name: "collect-only", setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => { edges.push(args.path); return { path: args.path, external: true }; });
      } }] });
    for (const path of ["./public-media-manifest.js", "./media-usage.js", "./public-deployment.js", "./publication-target.js", "./current-public-code-source.js"]) {
      expect(edges).toContain(path);
    }
    expect(() => functionGraphSource(source, "functions/lib/home-retained-sources.js", "100644 blob " + "a".repeat(40))).toThrow();
    expect(() => functionGraphSource('const load = require("node:module").createRequire(__filename); load("./hidden");', "functions/new-loader.js", "100644 blob " + "a".repeat(40))).toThrow();
  });

  it("discovers static aliases only in a recognized retained reader blob", () => {
    const file = "functions/lib/home-retained-sources.js";
    const source = 'requireModule("./public-media-manifest.js");\nrequire2("./publication-target.js");';
    // The Functions reader retained by the release before generated outputs left Git.
    const retainedBlob = "100644 blob 64d39a0ef7658e8ecd5ba64f9be9e9bc578147d8";
    expect(functionGraphSource(source, file, retainedBlob))
      .toBe('require("./public-media-manifest.js");\nrequire("./publication-target.js");');
    expect(() => functionGraphSource(source, file, "100644 blob " + "a".repeat(40)))
      .toThrow("Unknown retained-reader module loader");
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
