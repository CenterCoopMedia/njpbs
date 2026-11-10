// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, copyFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { sealCompiledRenderer } from "../scripts/compiled-renderer-release.mjs";

const directories: string[] = [];
const sha = "a".repeat(40);
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "preview-bootstrap-"));
  directories.push(root);
  const scripts = path.join(root, "site/scripts");
  const release = path.join(root, "site/.compiled-renderer");
  for (const directory of [scripts, ...["server", "client", "runtime"].map(child => path.join(release, child))]) {
    await mkdir(directory, { recursive: true });
  }
  for (const file of ["run-cms-preview-cloud.ts", "compiled-renderer-release.mjs", "cms-publication-credentials.ts",
    "cms-preview-pair-code-transport.ts"]) {
    await copyFile(fileURLToPath(new URL(`../scripts/${file}`, import.meta.url)), path.join(scripts, file));
  }
  await writeFile(path.join(scripts, "preview-diagnostics.ts"), `export function previewDiagnostics() {
    return Object.assign(async (stage, fn) => { globalThis.events.push(stage); return fn(); }, {timings:()=>({})});
  }`);
  await writeFile(path.join(scripts, "cms-publication-runtime-guard.ts"), `export async function assertCmsPreviewSourceCheckout(sha) {
    if (process.env.CMS_PREVIEW_FIREBASE_ACCOUNT || process.env.CMS_PREVIEW_R2_CREDENTIAL || process.env.CMS_DEV_ACCESS_CLIENT_ID || process.env.CMS_DEV_ACCESS_CLIENT_SECRET) throw Error("credentials leaked");
    if (sha !== "${sha}" || process.env.FIXTURE_DIRTY) throw Error("source rejected");
  }`);
  await writeFile(path.join(scripts, "cms-preview-operator-checks.ts"), `export function parsePreviewOperatorArguments([mode, rendererSha, serializerId]) {
    if (!["--serve","--preflight"].includes(mode)) throw Error("arguments rejected");
    return {rendererSha,serializerId,preflight:mode==="--preflight"};
  }
  export async function assertPreviewSandboxAvailable() { if(process.env.FIXTURE_SANDBOX) throw Error("sandbox rejected"); }`);
  await writeFile(path.join(release, "server/entry.mjs"), "export const render = () => {};");
  await writeFile(path.join(release, "client/_preview-assets.json"), "{}");
  await writeFile(path.join(release, "runtime/cloud.mjs"), `
    globalThis.events.push("imported");
    if (process.env.CMS_PREVIEW_FIREBASE_ACCOUNT || process.env.CMS_PREVIEW_R2_CREDENTIAL || process.env.CMS_DEV_ACCESS_CLIENT_ID || process.env.CMS_DEV_ACCESS_CLIENT_SECRET) throw Error("import credentials leaked");
    export async function serveCmsPreviewCloud(options) {
      const startup = options.startup();
      if(!/^[a-f0-9-]{36}$/.test(startup.startupId) || !Number.isSafeInteger(startup.processStartedAtMs) ||
        !Number.isSafeInteger(startup.timingsMs["node-startup"])) throw Error("startup attribution missing");
      if(options.rawAccount !== "fixture-account" || options.rawStorage !== "fixture-storage") throw Error("credentials missing");
      if(process.env.CMS_DEPLOYMENT_ENVIRONMENT === "development" &&
        (options.deploymentEnvironment !== "development" || options.publicationAccess.clientId !== "fixture-id" ||
         options.publicationAccess.clientSecret !== "fixture-secret")) throw Error("dev context missing");
      globalThis.events.push("served");
      if(process.env.FIXTURE_RUNTIME) throw Error("runtime stopped");
    }
  `);
  await sealCompiledRenderer(release, sha, {});
  return { root, release };
}
async function run(root: string, environment: Record<string, string> = {}, mode = "--serve") {
  const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", `
    globalThis.events = [];
    const {runCmsPreviewCloud} = await import("./site/scripts/run-cms-preview-cloud.ts");
    try { await runCmsPreviewCloud(${JSON.stringify(mode)}); console.log(JSON.stringify({events:globalThis.events})); }
    catch(error) { console.log(JSON.stringify({events:globalThis.events,error:error.message})); }
  `], { cwd: root, env: { PATH: "/usr/bin:/bin", CMS_PREVIEW_RENDERER_SHA: sha,
    CMS_PREVIEW_SERIALIZER_ID: "cloudflare-preview", CMS_PREVIEW_FIREBASE_ACCOUNT: "fixture-account",
    CMS_PREVIEW_R2_CREDENTIAL: "fixture-storage", ...environment }, timeout: 10_000 });
  return JSON.parse(stdout);
}
it.each([
  [{ CMS_PREVIEW_RENDERER_SHA: "b".repeat(40) }, ["source-check"], "source rejected"],
  [{ FIXTURE_DIRTY: "1" }, ["source-check"], "source rejected"],
  [{ FIXTURE_SANDBOX: "1" }, ["source-check", "package-check", "sandbox-check"], "sandbox rejected"],
  [{ FIRESTORE_EMULATOR_HOST: "127.0.0.1:18081" }, [], "emulator route"],
] as const)("rejects failed admission before importing runtime: %j", async (environment, events, message) => {
  const { root } = await fixture();
  const result = await run(root, environment);
  expect(result.events).toEqual(events);
  expect(result.error).toContain(message);
});
it.each(["missing", "tampered"])("rejects a %s runtime before import or clients", async condition => {
  const { root, release } = await fixture();
  const file = path.join(release, "runtime/cloud.mjs");
  if (condition === "missing") await rm(file);
  else await writeFile(file, 'globalThis.events.push("unsafe import");');
  const result = await run(root);
  expect(result.events).toEqual(["source-check", "package-check"]);
  expect(result.error).toContain("manifest");
});
it("keeps preflight local and imports only after serial admission with scrubbed credentials", async () => {
  const { root } = await fixture();
  expect(await run(root, {}, "--preflight")).toEqual({ events: ["source-check", "package-check", "sandbox-check"] });
  const events = ["source-check", "package-check", "sandbox-check", "runtime-import", "imported", "served"];
  expect(await run(root)).toEqual({ events });
  expect(await run(root, { CMS_DEPLOYMENT_ENVIRONMENT: "development", CMS_DEV_ACCESS_CLIENT_ID: "fixture-id", CMS_DEV_ACCESS_CLIENT_SECRET: "fixture-secret" })).toEqual({ events });
  expect(await run(root, { FIXTURE_RUNTIME: "1" })).toEqual({ events, error: "runtime stopped" });
});
