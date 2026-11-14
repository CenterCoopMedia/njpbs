import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkRegistry, entryExports, sourceInventory } from "../../scripts/check-release-surfaces.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fixture(t) {
  const directory = mkdtempSync(resolve(tmpdir(), "release-surfaces-"));
  t.after(() => rmSync(directory, { recursive: true }));
  const write = (path, text) => {
    mkdirSync(dirname(resolve(directory, path)), { recursive: true });
    writeFileSync(resolve(directory, path), text);
  };
  const track = () => execFileSync("git", ["add", "."], { cwd: directory });
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
  write(".github/workflows/ci.yml", "name: Fixture\non: push\n");
  write("workers/wrangler.preview.dev.jsonc", "{}\n");
  write("functions/package.json", JSON.stringify({ dependencies: { "firebase-functions": "1.0.0" } }));
  write("functions/health.js", "exports.health = () => {};\n");
  write("functions/index.js", 'lazyExport("health", "./health");\n');
  write("functions/dev-index.js", "for (const [name, modulePath] of Object.entries(devFunctionManifest())) { const handler = require(modulePath)[name]; exports[name] = handler; }\n");
  const devSource = body => `"use strict";
const { CLOUD_WAKE_FUNCTIONS } = require("./lib/cloud-publication-wake-deployment");
const DEV_FUNCTIONS = Object.freeze({ health: "./health" });
function devFunctionManifest(deployment) { ${body ?? 'if (deployment?.enabled !== true || deployment.environment !== "development") return DEV_FUNCTIONS; const selected = { ...DEV_FUNCTIONS }; for (const name of CLOUD_WAKE_FUNCTIONS) selected[name] = "./no-build-cloud-wake"; return Object.freeze(selected);'} }
module.exports = { DEV_FUNCTIONS, devFunctionManifest };\n`;
  write("functions/dev-manifest.js", devSource());
  write("functions/lib/cloud-publication-wake-deployment.js", "const CLOUD_WAKE_FUNCTIONS = Object.freeze([]);\n");
  track();
  const registry = {
    schemaVersion: 1,
    workflows: [".github/workflows/ci.yml"],
    wrangler: ["workers/wrangler.preview.dev.jsonc"],
    functions: ["functions/dev-index.js", "functions/index.js"].map(entrypoint => ({ entrypoint, exports: [{ name: "health", module: "functions/health.js" }] })),
    machines: [{ id: "fixture-request", kind: "app", sources: ["functions/health.js"], states: ["pending", "complete"] }],
  };
  return { directory, write, track, registry, devSource };
}

test("current tracked deployment surfaces match the reviewed registry", () => {
  const registry = JSON.parse(readFileSync(resolve(root, "config/release-surfaces.json"), "utf8"));
  assert.match(checkRegistry(registry, sourceInventory(root)), /Release surface registry:/);
  for (const id of ["pub-legacy-queue", "ema-worker-slot", "workflow-production-promotion"]) assert.ok(registry.machines.some(row => row.id === id));
});

for (const [name, path, source, diagnostic] of [
  ["workflow", ".github/workflows/new.yaml", "name: New\non: push\n", /missing=.*new.yaml/],
  ["disabled workflow", ".github/workflows/new.yml.disabled", "name: New\non: push\n", /missing=.*new.yml.disabled/],
  ["Wrangler variant", "nested/wrangler.public.dev.toml", 'name = "example"\n', /missing=.*wrangler.public.dev.toml/],
  ["repeated-hyphen Wrangler variant", "nested/wrangler---preview.dev.jsonc", "{}\n", /missing=.*wrangler---preview.dev.jsonc/],
  ["Functions export", "functions/index.js", 'lazyExport("health", "./health"); lazyExport("newHandler", "./health");\n', /missing=.*newHandler/],
  ["direct Functions export", "functions/index.js", 'lazyExport("health", "./health"); exports.newHandler = handler;\n', /missing=.*newHandler/],
  ["dev direct export", "functions/dev-index.js", 'for (const [name, modulePath] of Object.entries(devFunctionManifest())) { exports[name] = handler; } exports.newHandler = handler;\n', /missing=.*newHandler/],
]) {
  test(`an unregistered ${name} fails the source contract`, t => {
    const f = fixture(t);
    f.write(path, source);
    f.track();
    assert.throws(() => checkRegistry(f.registry, sourceInventory(f.directory)), diagnostic);
  });
}

test("a new literal dev manifest export needs a registry row", t => {
  const f = fixture(t);
  f.write("functions/dev-manifest.js", f.devSource().replace('health: "./health"', 'health: "./health", newHandler: "./health"'));
  assert.throws(() => checkRegistry(f.registry, sourceInventory(f.directory)), /missing=.*newHandler/);
});

test("comments and strings do not create Functions exports", t => {
  const f = fixture(t);
  f.write("functions/index.js", 'lazyExport("health", "./health");\n// lazyExport("comment", "./health");\nconst text = "exports.fake = handler";\n');
  assert.doesNotThrow(() => checkRegistry(f.registry, sourceInventory(f.directory)));
});

test("computed registrations are refused rather than omitted", () => {
  for (const source of ['lazyExport(name, "./health");', "exports[name] = handler;", "module.exports = handlers;", "Object.assign(exports, handlers);", "register(exports);", "const target = exports; target.newHandler = handler;", "exports.newHandler ??= handler;", "exports.newHandler ||= handler;", "exports.newHandler &&= handler;", "module.exports ||= {};", "[exports.newHandler] = [handler];", "({ newHandler: exports.newHandler } = handlers);", "for (exports.newHandler of handlers) {}", "exports.newHandler++;"]) {
    assert.throws(() => entryExports(source, "functions/index.js", new Set(["functions/health.js"])), /Computed|Unsupported/);
  }
});

test("a new Firebase Functions package needs an entrypoint registry row", t => {
  const f = fixture(t);
  f.write("backend/package.json", JSON.stringify({ dependencies: { "firebase-functions": "1.0.0" } }));
  f.write("backend/index.js", "exports.health = handler;\n");
  f.track();
  assert.throws(() => checkRegistry(f.registry, sourceInventory(f.directory)), /Functions entrypoints.*missing=.*backend\/index.js/);
});

test("standalone billing Function exports are inventoried without loading the module", t => {
  const f = fixture(t);
  const path = "infrastructure/billing-kill-switch/index.js";
  f.write(path, "export async function stopBillingOnBudgetAlert(event) {}\n");
  f.track();
  f.registry.functions.push({ entrypoint: path, exports: [{ name: "stopBillingOnBudgetAlert", module: path }] });
  assert.doesNotThrow(() => checkRegistry(f.registry, sourceInventory(f.directory)));
  f.write(path, "export async function stopBillingOnBudgetAlert(event) {}\nexport function newHandler() {}\n");
  assert.throws(() => checkRegistry(f.registry, sourceInventory(f.directory)), /missing=.*newHandler/);
});

test("static ESM exports keep their exported names and wildcard exports are refused", () => {
  const path = "functions/index.js";
  const entries = entryExports("export function handler() {} export const option = 1; export { handler as renamed }; export default handler;", path, new Set());
  assert.deepEqual([...entries.keys()], ["handler", "option", "renamed", "default"]);
  assert.throws(() => entryExports('export * from "./handlers.js";', path, new Set()), /Unsupported Functions re-export/);
});

test("new computed development manifest producers are refused", t => {
  const f = fixture(t);
  for (const body of [
    "return extraHandlers;",
    'const selected = { ...DEV_FUNCTIONS, extra: "./health" }; return Object.freeze(selected);',
    'const selected = { ...DEV_FUNCTIONS }; const target = selected; target.extra = "./health"; return Object.freeze(selected);',
    'let selected = { ...DEV_FUNCTIONS }; selected = extraHandlers; return Object.freeze(selected);',
    'const selected = { ...DEV_FUNCTIONS }; Reflect.set(selected, "extra", "./health"); return Object.freeze(selected);',
    'const selected = { ...DEV_FUNCTIONS }; selected.extra ??= "./health"; return Object.freeze(selected);',
    'const selected = { ...DEV_FUNCTIONS }; function add() { selected.extra = "./health"; } add(); return Object.freeze(selected);',
    'const selected = { ...DEV_FUNCTIONS }; const [target] = [selected]; target.extra = "./health"; return Object.freeze(selected);',
    'const selected = { ...DEV_FUNCTIONS }; const holder = { target: selected }; holder.target.extra = "./health"; return Object.freeze(selected);',
    'const selected = { ...DEV_FUNCTIONS }; const target = (selected); target.extra = "./health"; return Object.freeze(selected);',
    'const selected = { ...DEV_FUNCTIONS }; const name = "extra"; for (const n of CLOUD_WAKE_FUNCTIONS) selected[name] = "./no-build-cloud-wake"; return Object.freeze(selected);',
    'const selected = { ...DEV_FUNCTIONS }; for (let name of CLOUD_WAKE_FUNCTIONS) { name = "extra"; selected[name] = "./no-build-cloud-wake"; } return Object.freeze(selected);',
  ]) {
    f.write("functions/dev-manifest.js", f.devSource(body));
    assert.throws(() => sourceInventory(f.directory), /Changed Functions manifest producer|Computed Functions manifest/);
  }
  f.write("functions/dev-manifest.js", f.devSource().replace(/function devFunctionManifest[\s\S]*?\nmodule.exports/, 'const devFunctionManifest = deployment => Object.freeze({ ...DEV_FUNCTIONS, extra: "./health" });\nmodule.exports'));
  assert.throws(() => sourceInventory(f.directory), /Changed Functions manifest producer/);
});

test("removed surfaces and machine owners cannot remain registered", t => {
  const f = fixture(t);
  rmSync(resolve(f.directory, "workers/wrangler.preview.dev.jsonc"));
  f.track();
  assert.throws(() => checkRegistry(f.registry, sourceInventory(f.directory)), /stale=.*wrangler.preview.dev.jsonc/);
  f.write("workers/wrangler.preview.dev.jsonc", "{}\n");
  f.track();
  f.registry.machines[0].sources = ["functions/missing.js"];
  assert.throws(() => checkRegistry(f.registry, sourceInventory(f.directory)), /Missing machine source/);
});

test("duplicate exports and unknown machine kinds fail closed", t => {
  const f = fixture(t);
  assert.throws(() => entryExports('lazyExport("health", "./health"); lazyExport("health", "./health");', "functions/index.js", new Set(["functions/health.js"])), /Duplicate/);
  f.registry.machines[0].kind = "unknown";
  assert.throws(() => checkRegistry(f.registry, sourceInventory(f.directory)), /Invalid state machine/);
});
