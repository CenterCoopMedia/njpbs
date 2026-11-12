import { repositoryFixture } from "../helpers/repository-identity.mjs";
import { writeDevFunctionsEnvironment } from "../helpers/dev-deployment-config.mjs";
import { DEV_TARGETS } from "../../scripts/assert-dev-cms-targets.mjs";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { deployDevFunctions } from "../../scripts/deploy-dev-functions.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const workflow = parse(readFileSync(join(repo, ".github/workflows/cms-dev-deploy.yml"), "utf8"));

async function fixture(work) {
  const root = mkdtempSync(join(tmpdir(), "dev-functions-deploy-"));
  const prior = { GCLOUD_PROJECT: process.env.GCLOUD_PROJECT, GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT, CMS_DEPLOYMENT_ENVIRONMENT: process.env.CMS_DEPLOYMENT_ENVIRONMENT };
  try {
    for (const path of ["firebase.dev.json", "cms-api/wrangler.dev.jsonc", "preview-renderer/wrangler.dev.jsonc", "workers/wrangler.staff-preview.dev.jsonc", "workers/wrangler.preview.dev.jsonc"]) {
      mkdirSync(join(root, path, ".."), { recursive: true }); cpSync(join(repo, path), join(root, path));
    }
    cpSync(join(repo, "functions"), join(root, "functions"), { recursive: true, filter: path => !path.includes("node_modules") });
    symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
    symlinkSync(join(repo, "packages"), join(root, "packages"), "dir");
    const pkg = JSON.parse(readFileSync(join(root, "functions/package.json"), "utf8"));
    pkg.main = "dev-index.js"; writeFileSync(join(root, "functions/package.json"), JSON.stringify(pkg));
    writeDevFunctionsEnvironment(join(root, "functions/.env.njpbs-site-dev"), DEV_TARGETS);
    const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git(["init", "-q"]); git(["add", "."]);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Reviewed dev source"]);
    const sha = git(["rev-parse", "HEAD"]);
    const dotenv = join(root, "functions/.env.njpbs-site-dev");
    writeFileSync(dotenv, readFileSync(dotenv, "utf8") + `CMS_ADMIN_BUILD_REVISION=${sha}\n`);
    process.env.CMS_DEPLOYMENT_ENVIRONMENT = "development";
    await work({ root: pathToFileURL(`${root}/`), env: { ...workflow.jobs.deploy.env, ...repositoryFixture, ...DEV_TARGETS,
      GITHUB_REPOSITORY: repositoryFixture.CANONICAL_GITHUB_REPOSITORY, GITHUB_REPOSITORY_ID: repositoryFixture.CANONICAL_GITHUB_REPOSITORY_ID,
      CMS_DEPLOY_OWNER: "fixture-user", GITHUB_ACTOR: "fixture-user", GITHUB_TRIGGERING_ACTOR: "fixture-user", GITHUB_REF: "refs/heads/main",
      GITHUB_WORKFLOW_REF: `${repositoryFixture.CANONICAL_GITHUB_REPOSITORY}/.github/workflows/cms-dev-deploy.yml@refs/heads/main`,
      CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID, FIREBASE_WEB_APP_ID: process.env.FIREBASE_WEB_APP_ID,
      CMS_DEV_PUBLISH_ENABLED: "false", DEPLOY_SHA: sha, GITHUB_SHA: "b".repeat(40), GITHUB_WORKFLOW_SHA: "b".repeat(40), RUNNER_ENVIRONMENT: "github-hosted" } });
  } finally {
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

describe("dev Functions deployment boundary", () => {
  it("requires the workflow hold before the first provider mutation", () => {
    const steps = workflow.jobs.deploy.steps;
    const hold = steps.findIndex(step => step.name === "Require the dev publication hold before mutation");
    expect(hold).toBeGreaterThan(steps.findIndex(step => step.name === "Check exact dev targets and configs"));
    expect(hold).toBeLessThan(steps.findIndex(step => step.name === "Deploy dev Firestore rules and indexes"));
    for (const value of ["true", "false"]) {
      if (value === "false") expect(() => execFileSync("bash", ["-e", "-c", steps[hold].run], { env: { ...process.env, CMS_DEV_PUBLISH_ENABLED: value } })).not.toThrow();
      else expect(() => execFileSync("bash", ["-e", "-c", steps[hold].run], { env: { ...process.env, CMS_DEV_PUBLISH_ENABLED: value } })).toThrow();
    }
  });

  it("refuses the unheld wrapper before reading inventory or launching deploy", async () => fixture(async options => {
    let read = false, launched = false;
    await expect(deployDevFunctions({ ...options, env: { ...options.env, CMS_DEV_PUBLISH_ENABLED: "true" },
      request: async () => { read = true; }, runCommand: () => { launched = true; },
    })).rejects.toThrow("Hold dev publishing");
    expect(read).toBe(false); expect(launched).toBe(false);
  }));

  it("refuses a mismatched source revision before inventory or deployment", async () => fixture(async options => {
    let called = false;
    await expect(deployDevFunctions({ ...options, env: { ...options.env, DEPLOY_SHA: "f".repeat(40) },
      request: async () => { called = true; }, runCommand: () => { called = true; },
    })).rejects.toThrow("selected pin");
    const path = new URL("functions/.env.njpbs-site-dev", options.root);
    writeFileSync(path, readFileSync(path, "utf8") + `CMS_ADMIN_BUILD_REVISION=${"f".repeat(40)}\n`);
    await expect(deployDevFunctions({ ...options, request: async () => { called = true; }, runCommand: () => { called = true; },
    })).rejects.toThrow("revision differs");
    expect(called).toBe(false);
  }));

  it("uses correct API field masks and force only after the held full-codebase guard", async () => fixture(async options => {
    const calls = [], deploys = [];
    await deployDevFunctions({ ...options, request: async request => {
      calls.push(request);
      const v2 = request.url.includes("/v2/");
      expect(request.params.fields.includes("environment")).toBe(v2);
      return { data: v2 ? { functions: [{ name: "projects/njpbs-site-dev/locations/us-central1/functions/health", environment: "GEN_2", labels: { "firebase-functions-codebase": "dev" } }] } : {} };
    }, runCommand: (...args) => { expect(calls).toHaveLength(2); deploys.push(args); } });
    expect(deploys[0][0]).toBe("npx");
    expect(deploys[0][1]).toEqual(["--no-install", "firebase", "deploy", "--project", "njpbs-site-dev", "--config", "firebase.dev.json", "--only", "functions:dev", "--force", "--non-interactive"]);
  }));

  it("refuses a missing live Function and hides network/process error contents", async () => fixture(async options => {
    let launched = false;
    await expect(deployDevFunctions({ ...options, request: async request => ({ data: request.url.includes("/v1/") ? {} : {
      functions: [{ name: "projects/njpbs-site-dev/locations/us-central1/functions/retiredHandler", environment: "GEN_2", labels: { "firebase-functions-codebase": "dev" } }],
    } }), runCommand: () => { launched = true; } })).rejects.toThrow("delete or rename");
    expect(launched).toBe(false);
    await expect(deployDevFunctions({ ...options, request: async () => { throw new Error("private-response-content"); } })).rejects.toMatchObject({ message: "Could not read live Functions deployment inventory" });
    await expect(deployDevFunctions({ ...options, request: async () => ({ data: {} }), runCommand: () => { throw new Error("private-process-content"); } })).rejects.toMatchObject({ message: "Dev Functions deployment did not complete" });
  }));
});

// Exact manifest and authorization checks run before any deployment credentials.
describe("default-off development reader installation", () => {
  it("includes the complete reader family in both discovery and deploy", async () => fixture(async options => {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const { DEV_FUNCTIONS } = require("../../functions/dev-manifest.js");
    for (const name of ["cmsReaderV1", "cmsReaderV2", "cmsReadPairCurrentCodeV2"]) expect(DEV_FUNCTIONS[name]).toBe("./cms-reader-endpoints");
    const { loadFunctionSource } = await import("../../scripts/lib/functions-deploy-inventory.mjs");
    expect(Object.keys(loadFunctionSource("njpbs-site-dev", options.root)).sort()).toEqual(Object.keys(DEV_FUNCTIONS).sort());
    const dotenv = readFileSync(new URL("functions/.env.njpbs-site-dev", options.root), "utf8");
    const api = JSON.parse(readFileSync(new URL("cms-api/wrangler.dev.jsonc", options.root), "utf8"));
    expect(dotenv).toContain("CMS_READER_BRIDGE_ENABLED=false");
    for (const flag of ["PUBLIC_RELEASE_READERS_ENABLED", "PUBLIC_RELEASE_COMPOSED_READERS_ENABLED"]) {
      expect(dotenv).toContain(`${flag}=false`);
      const path = new URL("functions/.env.njpbs-site-dev", options.root);
      writeFileSync(path, dotenv.replace(`${flag}=false`, `${flag}=true`));
      const { assertDevConfigs } = await import("../../scripts/assert-dev-cms-targets.mjs");
      expect(() => assertDevConfigs(options.root, options.env)).toThrow("public reader deployment config refused");
      writeFileSync(path, dotenv);
    }
    expect(api.vars.CMS_READER_BRIDGE_ENABLED).toBe("false");
    expect(workflow.on.workflow_dispatch.inputs.install_reader_bridge.default).toBe(false);
    const steps = workflow.jobs.deploy.steps;
    const readers = steps.find(step => step.name === "Deploy and attest dev reader mounts");
    expect(readers.if).toBeUndefined();
    expect(readers.env.CMS_DEV_INSTALL_READER_BRIDGE).toBe("${{ inputs.install_reader_bridge }}");
    expect(readers.run).toBe('node scripts/deploy-dev-reader-mounts.mjs "$RUNNER_TEMP/dev-reader-deployment-receipt.json"');
    expect(steps.find(step => step.name === "Retain original dev reader deployment identities").if).toBeUndefined();
    for (const job of Object.values(workflow.jobs)) {
      expect(job.steps.findIndex(step => step.name === "Validate the separate dev reader installation authorization"))
        .toBeLessThan(job.steps.findIndex(step => step.name?.startsWith("Require the dev publication hold")));
    }
  }));

  it("refuses each missing authorization and every production target before SDK or deploy", async () => {
    const { assertDevReaderContext } = await import("../../scripts/deploy-dev-reader-mounts.mjs");
    const env = { ...workflow.jobs.deploy.env, ...DEV_TARGETS, ...repositoryFixture, CMS_DEPLOY_OWNER: "fixture-owner",
      GITHUB_REPOSITORY: repositoryFixture.CANONICAL_GITHUB_REPOSITORY, GITHUB_REPOSITORY_ID: repositoryFixture.CANONICAL_GITHUB_REPOSITORY_ID,
      CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID, FIREBASE_WEB_APP_ID: process.env.FIREBASE_WEB_APP_ID,
      DEPLOY_SHA: "a".repeat(40), GITHUB_SHA: "a".repeat(40), GITHUB_WORKFLOW_SHA: "a".repeat(40), RUNNER_ENVIRONMENT: "github-hosted",
      CMS_DEV_INSTALL_READER_BRIDGE: "true", CMS_DEV_PUBLISH_ENABLED: "false",
      CMS_DEV_READER_OPERATION_ID: "reader-dev-install", CMS_DEV_READER_INSTALL_AUTHORIZATION: "INSTALL_DEV_READERS",
      GITHUB_SHA: "a".repeat(40), GITHUB_WORKFLOW_SHA: "a".repeat(40), GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1",
      GITHUB_REF: "refs/heads/main", GITHUB_ACTOR: "fixture-owner", GITHUB_TRIGGERING_ACTOR: "fixture-owner",
      GITHUB_WORKFLOW_REF: "CenterCoopMedia/njpbs/.github/workflows/cms-dev-deploy.yml@refs/heads/main" };
    expect(assertDevReaderContext(env)).toMatchObject({ CMS_READER_BRIDGE_ENABLED: "true",
      PUBLIC_RELEASE_READERS_ENABLED: "true", PUBLIC_RELEASE_COMPOSED_READERS_ENABLED: "true",
      CMS_READER_BRIDGE_FUNCTIONS_CANDIDATE: "functions-123-1", CMS_READER_BRIDGE_CMS_API_CANDIDATE: "cmsApi-123-1" });
    // Contract capture tokens do not authorize reader installation.
    const proofTokens = ["CMS_CONTRACT_PUBLIC_TOKEN", "CMS_CONTRACT_PREVIEW_TOKEN"];
    for (const key of proofTokens) {
      expect(assertDevReaderContext({ ...env, [key]: undefined })).toEqual(assertDevReaderContext(env));
    }
    for (const key of Object.keys(env)) {
      if (["CMS_DEV_RELEASE_PREVIEW_RENDERER", "CMS_DEV_RENDERER_SOURCE_SHA", ...proofTokens].includes(key)) continue;
      expect(() => assertDevReaderContext({ ...env, [key]: undefined }), key).toThrow();
    }
    for (const patch of [{ FIREBASE_PROJECT_ID: "njpbs-site" }, { CMS_API_WORKER: "njpbs-cms-api" },
      { CMS_DEV_PUBLISH_ENABLED: "true" }, { CMS_DEV_INSTALL_READER_BRIDGE: "false" },
      { GITHUB_RUN_ATTEMPT: "1001" }, { GITHUB_REF: "refs/heads/feature" }, { GITHUB_WORKFLOW_SHA: "b".repeat(40) }]) {
      expect(() => assertDevReaderContext({ ...env, ...patch })).toThrow();
    }
    const update = { ...env, CMS_DEV_INSTALL_READER_BRIDGE: "false", CMS_DEV_READER_OPERATION_ID: "", CMS_DEV_READER_INSTALL_AUTHORIZATION: "",
      DEPLOY_SHA: "b".repeat(40) };
    expect(assertDevReaderContext(update)).toMatchObject({ CMS_READER_BRIDGE_ENABLED: "true", CMS_READER_BRIDGE_OPERATION_ID: "reader-dev-123-1" });
    for (const patch of [{ CMS_DEV_PUBLISH_ENABLED: "true" }, { FIREBASE_PROJECT_ID: "njpbs-site" },
      { GITHUB_RUN_ID: "" }, { GITHUB_RUN_ATTEMPT: "1001" }, { CMS_DEV_READER_OPERATION_ID: "reader-stray" },
      { CMS_DEV_READER_INSTALL_AUTHORIZATION: env.CMS_DEV_READER_INSTALL_AUTHORIZATION }]) {
      expect(() => assertDevReaderContext({ ...update, ...patch })).toThrow();
    }
  });
});

it("accepts only the reviewed checkout plus the workflow's exact dev preparation", async () => {
  const { assertDevReaderCheckout } = await import("../../scripts/deploy-dev-reader-mounts.mjs");
  const root = mkdtempSync(join(tmpdir(), "dev-reader-checkout-"));
  const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    mkdirSync(join(root, "functions"));
    const pkg = { name: "fixture", main: "index.js" };
    writeFileSync(join(root, "functions/package.json"), JSON.stringify(pkg));
    writeFileSync(join(root, "functions/.env.njpbs-site-dev"), "CMS_READER_BRIDGE_ENABLED=false\n");
    writeFileSync(join(root, ".gitignore"), "functions/cloud-publication-wake.generated.json\n");
    git(["init", "-q"]); git(["add", "."]);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Fixture"]);
    const sha = git(["rev-parse", "HEAD"]), env = { ...workflow.jobs.deploy.env, ...DEV_TARGETS, ...repositoryFixture,
      CMS_DEPLOY_OWNER: "fixture-user", GITHUB_REPOSITORY: repositoryFixture.CANONICAL_GITHUB_REPOSITORY,
      GITHUB_REPOSITORY_ID: repositoryFixture.CANONICAL_GITHUB_REPOSITORY_ID,
      DEPLOY_SHA: sha, GITHUB_SHA: "c".repeat(40), GITHUB_WORKFLOW_SHA: "c".repeat(40),
      GITHUB_REF: "refs/heads/main", GITHUB_ACTOR: "fixture-user", GITHUB_TRIGGERING_ACTOR: "fixture-user",
      RUNNER_ENVIRONMENT: "github-hosted",
      GITHUB_WORKFLOW_REF: `${repositoryFixture.CANONICAL_GITHUB_REPOSITORY}/.github/workflows/cms-dev-deploy.yml@refs/heads/main`,
      CMS_DEV_RENDERER_SOURCE_SHA: "b".repeat(40) };
    writeFileSync(join(root, "functions/package.json"), JSON.stringify({ ...pkg, main: "dev-index.js" }));
    const expected = `CMS_READER_BRIDGE_ENABLED=false\nCMS_ADMIN_BUILD_REVISION=${sha}\nCMS_PREVIEW_SERIALIZER_READY=true\nCMS_PREVIEW_RENDERER_SHA=${env.CMS_DEV_RENDERER_SOURCE_SHA}\n`;
    writeFileSync(join(root, "functions/.env.njpbs-site-dev"), expected);
    writeFileSync(join(root, "functions/cloud-publication-wake.generated.json"), JSON.stringify({ schemaVersion: 1, environment: "development", enabled: false }));
    const url = pathToFileURL(`${root}/`);
    expect(() => assertDevReaderCheckout(env, url)).not.toThrow();
    writeFileSync(join(root, "unreviewed.js"), "throw new Error('unreviewed');");
    expect(() => assertDevReaderCheckout(env, url)).toThrow();
    rmSync(join(root, "unreviewed.js"));
    writeFileSync(join(root, "functions/.env.njpbs-site-dev"), expected + "EXTRA_CONFIG=true\n");
    expect(() => assertDevReaderCheckout(env, url)).toThrow();
    writeFileSync(join(root, "functions/.env.njpbs-site-dev"), expected);
    writeFileSync(join(root, "functions/package.json"), JSON.stringify({ ...pkg, main: "dev-index.js", extra: true }));
    expect(() => assertDevReaderCheckout(env, url)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
