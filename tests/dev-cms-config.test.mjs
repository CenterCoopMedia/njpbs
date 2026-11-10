import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { repositoryFixture } from "./helpers/repository-identity.mjs";
import { devDeploymentEnvironment, devFunctionsEnvironment } from "./helpers/dev-deployment-config.mjs";
Object.assign(process.env, devDeploymentEnvironment);
const { assertDevConfigs: assertSourceDevConfigs, assertDevTargets, DEV_TARGETS } = await import("../scripts/assert-dev-cms-targets.mjs");
const configDirectory = mkdtempSync(join(tmpdir(), "dev-config-source-"));
const configRoot = pathToFileURL(`${configDirectory}/`);
const readConfigSource = path => path === "functions/.env.njpbs-site-dev"
  ? Buffer.from(devFunctionsEnvironment(DEV_TARGETS))
  : readFileSync(new URL(`../${path}`, import.meta.url));
for (const path of ["cms-api/wrangler.dev.jsonc", "preview-renderer/wrangler.dev.jsonc", "workers/wrangler.preview.dev.jsonc",
  "workers/wrangler.staff-preview.dev.jsonc", "firebase.dev.json", "functions/.env.njpbs-site-dev"]) {
  mkdirSync(dirname(join(configDirectory, path)), { recursive: true });
  writeFileSync(join(configDirectory, path), readConfigSource(path));
}
for (const path of ["scripts/assert-dev-cms-targets.mjs", "scripts/lib/repository-identity.mjs", "functions/lib/dev-reader-deployment.js"]) {
  mkdirSync(dirname(join(configDirectory, path)), { recursive: true });
  writeFileSync(join(configDirectory, path), readFileSync(new URL(`../${path}`, import.meta.url)));
}
writeFileSync(join(configDirectory, "wrangler.jsonc"), '{"name":"fixture-production"}');
after(() => rmSync(configDirectory, { recursive: true, force: true }));
const assertDevConfigs = (root = configRoot, env = process.env) => assertSourceDevConfigs(root, env);
import { previewOutputTarget } from "../site/scripts/preview-output-target.mjs";

const require = createRequire(import.meta.url);

test("the existing dev index deployment enables the report evidence TTL policy", async () => {
  const { FirestoreApi } = require("firebase-tools/lib/firestore/api");
  const { parse } = require("yaml");
  const config = JSON.parse(readFileSync(new URL("../firebase.dev.json", import.meta.url), "utf8"));
  const indexes = JSON.parse(readFileSync(new URL(`../${config.firestore.indexes}`, import.meta.url), "utf8"));
  const evidence = indexes.fieldOverrides.find(field => field.collectionGroup === "bugReportEvidence" && field.fieldPath === "expireAt");
  const api = new FirestoreApi();
  const calls = [];
  // Exercise the installed deployment serializer; fake only its HTTP transport.
  api.apiClient = { patch: async (...args) => { calls.push(args); return {}; } };
  api.validateField(evidence);
  await api.patchField("njpbs-site-dev", evidence);
  assert.deepEqual(calls, [[
    "/projects/njpbs-site-dev/databases/(default)/collectionGroups/bugReportEvidence/fields/expireAt",
    { indexConfig: { indexes: [] }, ttlConfig: {} },
  ]]);
  const workflow = parse(readFileSync(new URL("../.github/workflows/cms-dev-deploy.yml", import.meta.url), "utf8"));
  const steps = workflow.jobs.deploy.steps;
  const deployIndexes = steps.findIndex(step => step.name === "Deploy dev Firestore rules and indexes");
  assert.ok(deployIndexes >= 0 && deployIndexes < steps.findIndex(step => step.name === "Deploy and attest dev reader mounts"));
  assert.match(steps[deployIndexes].run, /--project njpbs-site-dev --config firebase\.dev\.json --only firestore:rules,firestore:indexes/);
});

test("the complete dev target tuple rejects each replaced or production value", () => {
  assert.equal(assertDevTargets(DEV_TARGETS), true);
  const productionValues = {
    FIREBASE_PROJECT_ID: "njpbs-site",
    FIREBASE_WEB_APP_ID: "production-web-app",
    CMS_API_WORKER: "njpbs-cms-api",
    CMS_PREVIEW_WORKER: "njpbs-cms-preview",
    CMS_PREVIEW_RENDERER: "njpbs-cms-preview-renderer",
    CMS_PREVIEW_STAFF_WORKER: "njpbs-staff-sites",
    CMS_SITE_PAGES: "njpbs-production",
    CMS_ADMIN_PAGES: "njpbs-admin",
    CMS_MEDIA_BUCKET: "njpbs-media",
    CMS_PREVIEW_BUCKET: "njpbs-cms-previews",
    CMS_ADMIN_ORIGIN: "https://admin.njpbs.org",
    CMS_API_ORIGIN: "https://api.example.org",
    CMS_PREVIEW_ORIGIN: "https://preview.njpbs.org",
    CMS_SITE_ORIGIN: "https://njpbs.org",
    CMS_MEDIA_ORIGIN: "https://media.njpbs.org",
    FUNCTIONS_ORIGIN: "https://us-central1-njpbs-site.cloudfunctions.net",
    CMS_DEPLOYMENT_ENVIRONMENT: "production",
    CLOUDFLARE_ACCOUNT_ID: "another-account",
    CMS_ADMIN_PAGES_BRANCH: "production",
  };
  for (const [key, value] of Object.entries(DEV_TARGETS)) {
    assert.throws(() => assertDevTargets({ ...DEV_TARGETS, [key]: undefined }), new RegExp(key));
    assert.notEqual(productionValues[key], value);
    assert.throws(() => assertDevTargets({ ...DEV_TARGETS, [key]: productionValues[key] }), new RegExp(key));
  }
  assert.equal(assertDevConfigs(), true);
});

test("dev dispatch repository admits only the approved repository without admitting production targets", () => {
  const workspace = mkdtempSync(join(tmpdir(), "dev-repository-test-"));
  const root = pathToFileURL(`${workspace}/`);
  try {
    for (const path of ["cms-api/wrangler.dev.jsonc", "preview-renderer/wrangler.dev.jsonc",
      "workers/wrangler.preview.dev.jsonc", "workers/wrangler.staff-preview.dev.jsonc", "firebase.dev.json", "functions/.env.njpbs-site-dev"]) {
      mkdirSync(dirname(join(workspace, path)), { recursive: true });
      writeFileSync(join(workspace, path), readConfigSource(path));
    }
    const envPath = join(workspace, "functions/.env.njpbs-site-dev");
    const original = readFileSync(envPath, "utf8");
    for (const repository of ["CenterCoopMedia/njpbs"]) {
      const updated = original.replace("CMS_PUBLISH_GITHUB_REPOSITORY=CenterCoopMedia/njpbs", `CMS_PUBLISH_GITHUB_REPOSITORY=${repository}`);
      writeFileSync(envPath, updated);
      assert.equal(assertDevConfigs(root), true);
      writeFileSync(envPath, updated + "UNEXPECTED_TARGET=njpbs-site\n");
      assert.throws(() => assertDevConfigs(root), /Dev deployment config refused/);
    }
    for (const repository of ["fork/njpbs-site", "CenterCoopMedia/other", "", "https://github.com/CenterCoopMedia/njpbs"]) {
      writeFileSync(envPath, original.replace("CMS_PUBLISH_GITHUB_REPOSITORY=CenterCoopMedia/njpbs", `CMS_PUBLISH_GITHUB_REPOSITORY=${repository}`));
      assert.throws(() => assertDevConfigs(root), /Dev deployment config refused/);
    }
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("dev writeback readiness requires the proved enabled value", () => {
  const workspace = mkdtempSync(join(tmpdir(), "dev-writeback-test-"));
  const root = pathToFileURL(`${workspace}/`);
  try {
    for (const path of ["cms-api/wrangler.dev.jsonc", "preview-renderer/wrangler.dev.jsonc",
      "workers/wrangler.preview.dev.jsonc", "workers/wrangler.staff-preview.dev.jsonc", "firebase.dev.json", "functions/.env.njpbs-site-dev"]) {
      mkdirSync(dirname(join(workspace, path)), { recursive: true });
      writeFileSync(join(workspace, path), readConfigSource(path));
    }
    const envPath = join(workspace, "functions/.env.njpbs-site-dev");
    const env = readFileSync(envPath, "utf8");
    assert.match(env, /^CMS_WRITEBACK_CONFIGURED=true$/m);
    assert.equal(assertDevConfigs(root), true);
    for (const replacement of ["CMS_WRITEBACK_CONFIGURED=false", "CMS_WRITEBACK_CONFIGURED=", ""]) {
      writeFileSync(envPath, env.replace("CMS_WRITEBACK_CONFIGURED=true", replacement));
      assert.throws(() => assertDevConfigs(root), /Dev deployment config refused/);
    }
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("saved preview output agrees with the dev publication target tuple", () => {
  const selected = previewOutputTarget(DEV_TARGETS.CMS_DEPLOYMENT_ENVIRONMENT, DEV_TARGETS.FIREBASE_PROJECT_ID);
  assert.equal(selected.bucket, DEV_TARGETS.CMS_PREVIEW_BUCKET);
  assert.equal(selected.origin, DEV_TARGETS.CMS_PREVIEW_ORIGIN);
  assert.throws(() => previewOutputTarget("development", "njpbs-site"), /target differs/);
  assert.throws(() => previewOutputTarget("production", "njpbs-site-dev"), /target differs/);
});

test("dev preview readiness requires the verified renderer SHA and dev-only service binding", () => {
  const workspace = mkdtempSync(join(tmpdir(), "dev-preview-readiness-"));
  const root = pathToFileURL(`${workspace}/`);
  const previousSha = process.env.CMS_DEV_RENDERER_SOURCE_SHA;
  const sha = "a".repeat(40);
  try {
    for (const path of ["cms-api/wrangler.dev.jsonc", "preview-renderer/wrangler.dev.jsonc",
      "workers/wrangler.preview.dev.jsonc", "workers/wrangler.staff-preview.dev.jsonc", "firebase.dev.json", "functions/.env.njpbs-site-dev"]) {
      mkdirSync(dirname(join(workspace, path)), { recursive: true });
      writeFileSync(join(workspace, path), readConfigSource(path));
    }
    const envPath = join(workspace, "functions/.env.njpbs-site-dev");
    const original = readFileSync(envPath, "utf8");
    writeFileSync(envPath, original.replace("CMS_PREVIEW_SERIALIZER_READY=false", "CMS_PREVIEW_SERIALIZER_READY=true")
      .replace("CMS_PREVIEW_RENDERER_SHA=", `CMS_PREVIEW_RENDERER_SHA=${sha}`));
    delete process.env.CMS_DEV_RENDERER_SOURCE_SHA;
    assert.throws(() => assertDevConfigs(root), /Dev deployment config refused/);
    process.env.CMS_DEV_RENDERER_SOURCE_SHA = "b".repeat(40);
    assert.throws(() => assertDevConfigs(root), /Dev deployment config refused/);
    process.env.CMS_DEV_RENDERER_SOURCE_SHA = sha;
    assert.equal(assertDevConfigs(root), true);
    const apiPath = join(workspace, "cms-api/wrangler.dev.jsonc");
    const api = readFileSync(apiPath, "utf8");
    writeFileSync(apiPath, api.replace('"service": "template-dev-cms-preview-renderer"', '"service": "njpbs-cms-preview-renderer"'));
    assert.throws(() => assertDevConfigs(root), /Dev deployment config refused/);
  } finally {
    if (previousSha === undefined) delete process.env.CMS_DEV_RENDERER_SOURCE_SHA;
    else process.env.CMS_DEV_RENDERER_SOURCE_SHA = previousSha;
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("dev manifest has exactly the reviewed endpoints and only admitted secrets", () => {
  const expected = [
    "health", "cmsCollectBoardwalkUsage", "cmsGetBoardwalkUsage",
    "registerStaffProfile", "getStaffAccessStatus", "grantRole",
    "revokeRole", "deactivateStaff", "cmsValidateSiteAccess", "cmsGetContent",
    "cmsListContent", "cmsSaveContent", "cmsTransitionContent", "cmsGetRevision",
    "cmsListRevisions", "cmsRestoreRevision", "cmsAssignContent", "cmsListAudit",
    "cmsPostTemplates", "cmsDatasets", "cmsElectionResultsSources", "onElectionResultsSourcePoll", "onDatasetRefresh", "cmsGetNewsroomBanner", "cmsGetSettings", "cmsGetCoverageLabels", "cmsSaveSettings",
    "cmsPublishSettings", "cmsGetPublicPage", "cmsListMedia", "cmsListMediaCategories",
    "cmsListMediaUsage", "cmsListBylineAuthors", "cmsGetAuthorProfile",
    "cmsPreview", "cmsPreviewStatus", "cmsReaderV1", "cmsReaderV2", "cmsReadPairCurrentCodeV2", "cmsPublish", "cmsRecheckPublication", "cmsSubmitBugReport", "onNoBuildPostConfirmation",
    "onNoBuildPostConfirmationRecovery", "onScheduledPublish",
  ];
  const { DEV_FUNCTIONS } = require("../functions/dev-manifest.js");
  assert.deepEqual(Object.keys(DEV_FUNCTIONS), expected);
  const apiList = readFileSync(new URL("../cms-api/src/dev-endpoints.ts", import.meta.url), "utf8");
  const apiNames = [...apiList.matchAll(/"([A-Za-z][A-Za-z0-9]+)"/g)].map(match => match[1]);
  assert.deepEqual(apiNames.sort(), expected.filter(name =>
    !["cmsReaderV1", "cmsReaderV2", "cmsReadPairCurrentCodeV2", "health", "cmsValidateSiteAccess", "cmsGetPublicPage", "onDatasetRefresh", "onElectionResultsSourcePoll", "onNoBuildPostConfirmation",
      "onNoBuildPostConfirmationRecovery", "onScheduledPublish"].includes(name),
  ).sort());
  const script = `
    const params = require("firebase-functions/params");
    const original = params.defineSecret;
    const seen = new Set();
    params.defineSecret = name => { seen.add(name); return original(name); };
    const functions = require("./functions/dev-index");
    process.stdout.write(JSON.stringify({
      names: Object.keys(functions),
      declaredSecrets: [...seen].sort(),
      endpoints: Object.fromEntries(Object.entries(functions).map(([name, fn]) => [name, fn.__endpoint])),
    }));
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: new URL("../", import.meta.url),
    env: { ...process.env, GCLOUD_PROJECT: "njpbs-site-dev", CMS_DEPLOYMENT_ENVIRONMENT: "development", CMS_PUBLISH_TRANSPORT: "github" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const loaded = JSON.parse(result.stdout);
  assert.deepEqual(loaded.names, expected);
  for (const name of ["cmsCollectBoardwalkUsage", "cmsGetBoardwalkUsage"]) {
    assert.deepEqual(loaded.endpoints[name].secretEnvironmentVariables.map(secret => secret.key), ["CMS_EDGE_ORIGIN_SECRET"], name);
  }
  assert.deepEqual(loaded.endpoints.cmsSubmitBugReport.secretEnvironmentVariables.map(secret => secret.key), ["CMS_EDGE_ORIGIN_SECRET"]);
  assert.deepEqual(loaded.endpoints.cmsRecheckPublication.secretEnvironmentVariables.map(secret => secret.key).sort(),
    ["CMS_DEV_ACCESS_CLIENT_ID", "CMS_DEV_ACCESS_CLIENT_SECRET", "CMS_EDGE_ORIGIN_SECRET"]);
  assert.deepEqual(loaded.declaredSecrets, ["CMS_DEV_ACCESS_CLIENT_ID", "CMS_DEV_ACCESS_CLIENT_SECRET",
    "CMS_DEV_PUBLISH_APP_ID", "CMS_DEV_PUBLISH_APP_PRIVATE_KEY", "CMS_EDGE_ORIGIN_SECRET", "CMS_MEDIA_CACHE_PURGE_TOKEN"]);
  for (const name of ["onNoBuildPostConfirmation", "onNoBuildPostConfirmationRecovery"]) {
    assert.deepEqual(loaded.endpoints[name].secretEnvironmentVariables.map(secret => secret.key).sort(),
      ["CMS_DEV_ACCESS_CLIENT_ID", "CMS_DEV_ACCESS_CLIENT_SECRET", "CMS_EDGE_ORIGIN_SECRET", "CMS_MEDIA_CACHE_PURGE_TOKEN"], name);
  }
  for (const name of ["cmsSaveContent", "cmsTransitionContent", "cmsPublish", "onScheduledPublish"]) {
    const names = loaded.endpoints[name].secretEnvironmentVariables.map(secret => secret.key);
    assert.ok(names.includes("CMS_DEV_PUBLISH_APP_ID"), name);
    assert.ok(names.includes("CMS_DEV_PUBLISH_APP_PRIVATE_KEY"), name);
    assert.ok(!names.includes("CMS_PUBLISH_GITHUB_TOKEN"), name);
  }
  for (const [name, endpoint] of Object.entries(loaded.endpoints)) {
    assert.ok(!endpoint.secretEnvironmentVariables?.some(secret => secret.key === "CMS_PUBLISH_GITHUB_TOKEN"), name);
  }
  for (const [name, endpoint] of Object.entries(loaded.endpoints)) {
    assert.equal(endpoint.minInstances, 0, name);
    // The new dataset worker keeps a single-instance budget, like recovery.
    assert.equal(endpoint.maxInstances, ["onScheduledPublish", "onNoBuildPostConfirmationRecovery", "onDatasetRefresh", "onElectionResultsSourcePoll"].includes(name) ? 1 : 2, name);
    assert.deepEqual(endpoint.region, ["us-central1"], name);
  }
});

test("both dev intake bindings refuse missing, blank, and sending modes", () => {
  const workspace = mkdtempSync(join(tmpdir(), "dev-report-intake-"));
  const root = pathToFileURL(`${workspace}/`);
  try {
    for (const path of ["cms-api/wrangler.dev.jsonc", "preview-renderer/wrangler.dev.jsonc",
      "workers/wrangler.preview.dev.jsonc", "workers/wrangler.staff-preview.dev.jsonc", "firebase.dev.json", "functions/.env.njpbs-site-dev"]) {
      mkdirSync(dirname(join(workspace, path)), { recursive: true });
      writeFileSync(join(workspace, path), readConfigSource(path));
    }
    for (const [path, binding] of [
      ["cms-api/wrangler.dev.jsonc", '"CMS_DEV_REPORT_INTAKE_MODE": "stored-only"'],
      ["functions/.env.njpbs-site-dev", "CMS_DEV_REPORT_INTAKE_MODE=stored-only"],
    ]) {
      const original = readFileSync(join(workspace, path), "utf8");
      assert.ok(original.includes(binding));
      for (const replacement of [binding.replace("stored-only", "send"), binding.replace("stored-only", ""), binding.replace("CMS_DEV_REPORT_INTAKE_MODE", "UNUSED_MODE")]) {
        writeFileSync(join(workspace, path), original.replace(binding, replacement));
        assert.throws(() => assertDevConfigs(root), /Dev deployment config refused/);
      }
      writeFileSync(join(workspace, path), original);
    }
    assert.equal(assertDevConfigs(root), true);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("dev dispatch cannot select the production publish event", () => {
  const script = 'process.stdout.write(JSON.stringify(require("./functions/publish").buildDispatchPayload({queueId:"q1",triggeredBy:"dev"})))';
  const dev = spawnSync(process.execPath, ["-e", script], {
    cwd: new URL("../", import.meta.url),
    env: { ...process.env, GCLOUD_PROJECT: "njpbs-site-dev", CMS_DEPLOYMENT_ENVIRONMENT: "development", CMS_PUBLISH_TRANSPORT: "github" },
    encoding: "utf8",
  });
  assert.equal(dev.status, 0, dev.stderr);
  assert.deepEqual(JSON.parse(dev.stdout), {
    event_type: "cms_dev_publish",
    client_payload: { queueId: "q1", triggeredBy: "dev", environment: "development", projectId: "njpbs-site-dev", transport: "github" },
  });
  const production = spawnSync(process.execPath, ["-e", script], {
    cwd: new URL("../", import.meta.url),
    env: { ...process.env, GCLOUD_PROJECT: "njpbs-site", CMS_DEPLOYMENT_ENVIRONMENT: "production" },
    encoding: "utf8",
  });
  assert.equal(production.status, 0, production.stderr);
  assert.deepEqual(JSON.parse(production.stdout), {
    event_type: "cms_publish",
    client_payload: { queueId: "q1", triggeredBy: "dev" },
  });
  const wrongProject = spawnSync(process.execPath, ["-e", script], {
    cwd: new URL("../", import.meta.url),
    env: { ...process.env, GCLOUD_PROJECT: "njpbs-site", CMS_DEPLOYMENT_ENVIRONMENT: "development", CMS_PUBLISH_TRANSPORT: "github" },
    encoding: "utf8",
  });
  assert.notEqual(wrongProject.status, 0);
  assert.match(wrongProject.stderr, /Development publication requires/);
});

test("dev source discovery without .env values declares only dev secrets", () => {
  // Firebase CLI discovery env: firebase-tools prepare.js passes FIREBASE_CONFIG,
  // GCLOUD_PROJECT and GOOGLE_CLOUD_QUOTA_PROJECT only.
  const script = `
    const params = require("firebase-functions/params");
    const original = params.defineSecret;
    const seen = new Set();
    params.defineSecret = name => { seen.add(name); return original(name); };
    require("./functions/dev-index");
    process.stdout.write(JSON.stringify([...seen].sort()));
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: new URL("../", import.meta.url),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, FUNCTIONS_CONTROL_API: "true", GCLOUD_PROJECT: "njpbs-site-dev", GOOGLE_CLOUD_QUOTA_PROJECT: "njpbs-site-dev" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["CMS_DEV_ACCESS_CLIENT_ID", "CMS_DEV_ACCESS_CLIENT_SECRET",
    "CMS_DEV_PUBLISH_APP_ID", "CMS_DEV_PUBLISH_APP_PRIVATE_KEY", "CMS_EDGE_ORIGIN_SECRET", "CMS_MEDIA_CACHE_PURGE_TOKEN"]);
});

test("dev dotenv sets every declared non-secret param for non-interactive deploys", () => {
  // firebase-tools resolveParams ignores param defaults in non-interactive mode.
  const script = `
    require("./functions/dev-index");
    const { declaredParams } = require("firebase-functions/params");
    process.stdout.write(JSON.stringify(declaredParams
      .filter(param => !param.constructor.name.includes("Secret"))
      .map(param => param.name)));
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: new URL("../", import.meta.url),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, FUNCTIONS_CONTROL_API: "true", GCLOUD_PROJECT: "njpbs-site-dev" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const dotenv = new Set(readFileSync(new URL("functions/.env.njpbs-site-dev", configRoot), "utf8")
    .split(/\r?\n/).filter(line => line && !line.startsWith("#")).map(line => line.slice(0, line.indexOf("="))));
  assert.deepEqual(JSON.parse(result.stdout).filter(name => !dotenv.has(name)), []);
});

test("dev source discovery refuses an explicit production environment", () => {
  const result = spawnSync(process.execPath, ["-e", 'require("./functions/dev-index")'], {
    cwd: new URL("../", import.meta.url),
    env: { ...process.env, GCLOUD_PROJECT: "njpbs-site-dev", CMS_DEPLOYMENT_ENVIRONMENT: "production" },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Dev Functions require/);
});

test("dev source discovery refuses a production Firebase project", () => {
  const result = spawnSync(process.execPath, ["-e", 'require("./functions/dev-index")'], {
    cwd: new URL("../", import.meta.url),
    env: { ...process.env, GCLOUD_PROJECT: "njpbs-site", CMS_DEPLOYMENT_ENVIRONMENT: "development", CMS_PUBLISH_TRANSPORT: "github" },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Dev Functions require/);
});


test("Admin upload executes only the checked dev Pages target outside repository config", () => {
  const { parse } = require("yaml");
  const workflow = parse(readFileSync(new URL("../.github/workflows/cms-dev-deploy.yml", import.meta.url), "utf8"));
  const job = workflow.jobs.deploy;
  const upload = job.steps.find(step => step.name === "Upload dev Admin to Pages");
  assert.equal(job.environment, "development");
  assert.equal(job.env.CLOUDFLARE_ACCOUNT_ID, "${{ vars.CLOUDFLARE_ACCOUNT_ID }}");
  assert.equal(upload.env.CLOUDFLARE_API_TOKEN, "${{ secrets.CLOUDFLARE_DEV_PAGES_TOKEN }}");
  assert.equal(job.steps.find(step => step.name === "Build dev Admin").env.VITE_PUBLIC_SITE_ORIGIN, "${{ vars.CMS_DEV_PUBLIC_ORIGIN }}");
  const workspace = mkdtempSync(join(tmpdir(), "dev-admin-upload-test-"));
  try {
    mkdirSync(join(workspace, "node_modules/.bin"), { recursive: true });
    writeFileSync(join(workspace, "wrangler.jsonc"), '{"name":"production"}');
    writeFileSync(join(workspace, "node_modules/.bin/wrangler"), `#!/usr/bin/env node
      const fs = require("node:fs");
      if(process.cwd() === process.env.HOME || fs.existsSync("wrangler.jsonc") || process.env.CMS_PAGES_BROKER_URL) process.exit(9);
      process.stdout.write(JSON.stringify({cwd:process.cwd(), args:process.argv.slice(2), account:process.env.CLOUDFLARE_ACCOUNT_ID}));
    `, { mode: 0o755 });
    const run = extra => spawnSync("bash", ["-e", "-c", upload.run], { cwd: configRoot, encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: workspace, ...job.env, ...DEV_TARGETS, ...repositoryFixture, GITHUB_WORKSPACE: workspace,
        GITHUB_SHA: "b".repeat(40), DEPLOY_SHA: "a".repeat(40), CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CLOUDFLARE_API_TOKEN: "fixture-token",
        CMS_DEV_CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), FIREBASE_WEB_APP_ID: process.env.FIREBASE_WEB_APP_ID,
        CMS_DEV_FIREBASE_WEB_APP_ID: process.env.CMS_DEV_FIREBASE_WEB_APP_ID, ...extra } });
    const result = run({});
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout.split("\n").at(-1));
    assert.deepEqual(output.args, ["pages", "deploy", join(workspace, "admin/dist"), "--project-name=template-dev-admin",
      "--branch=main", `--commit-hash=${"a".repeat(40)}`, "--commit-dirty=true"]);
    assert.equal(output.account, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.notEqual(output.cwd, workspace);
    for (const extra of [{ CMS_ADMIN_PAGES: "njpbs-admin" }, { CMS_ADMIN_PAGES_BRANCH: "production" }, { CLOUDFLARE_ACCOUNT_ID: "other" }]) {
      const refused = run(extra);
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /Dev target tuple refused/);
    }
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

// #2957 requires the verified renderer output to identify Functions and Admin
// enablement. Exercise the shell/Git/env-file boundary on a temporary checkout.
test("dev deployment writes the exact Admin source revision before Functions deploy", () => {
  const { parse } = require("yaml");
  const workflow = parse(readFileSync(new URL("../.github/workflows/cms-dev-deploy.yml", import.meta.url), "utf8"));
  const steps = workflow.jobs.deploy.steps;
  const writer = steps.find(step => step.name === "Set the matched dev Admin revision");
  assert.ok(steps.indexOf(writer) < steps.findIndex(step => step.name === "Deploy and attest dev reader mounts"));
  const workspace = mkdtempSync(join(tmpdir(), "dev-revision-test-"));
  try {
    mkdirSync(join(workspace, "scripts"));
    mkdirSync(join(workspace, "functions/lib"), { recursive: true });
    writeFileSync(join(workspace, "functions/lib/cms-publish-dispatch.js"), readFileSync(new URL("../functions/lib/cms-publish-dispatch.js", import.meta.url)));
    // The tuple guard has separate contract coverage; this fixture exercises the
    // shell/Git/env-file boundary without performing any remote deployment.
    writeFileSync(join(workspace, "scripts/assert-dev-cms-targets.mjs"), "");
    writeFileSync(join(workspace, "functions/.env.njpbs-site-dev"), "CMS_WRITEBACK_CONFIGURED=true\n");
    const git = args => {
      const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git(["init", "-q"]);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-qm", "Fixture"]);
    const sha = git(["rev-parse", "HEAD"]);
    const run = (revision, pin = sha, releasing = true) => spawnSync("bash", ["-e", "-c", writer.run], {
      cwd: workspace, encoding: "utf8", env: { PATH: process.env.PATH, GITHUB_SHA: "f".repeat(40), DEPLOY_SHA: revision,
        CMS_DEV_RENDERER_SOURCE_SHA: pin, CMS_DEV_RELEASE_PREVIEW_RENDERER: String(releasing),
        CMS_PUBLISH_GITHUB_TRUSTED_ACTORS: JSON.stringify(["fixture-owner"]) },
    });
    const result = run(sha);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(workspace, "functions/.env.njpbs-site-dev"), "utf8"),
      `CMS_WRITEBACK_CONFIGURED=true\nCMS_ADMIN_BUILD_REVISION=${sha}\nCMS_PUBLISH_GITHUB_TRUSTED_ACTORS=["fixture-owner"]\nCMS_PREVIEW_SERIALIZER_READY=true\nCMS_PREVIEW_RENDERER_SHA=${sha}\n`);
    assert.notEqual(run("0".repeat(40)).status, 0);
    assert.notEqual(run(sha, "b".repeat(40), true).status, 0);
    assert.notEqual(run(sha, "", false).status, 0);
    writeFileSync(join(workspace, "functions/.env.njpbs-site-dev"), "CMS_WRITEBACK_CONFIGURED=true\n");
    const pinned = "b".repeat(40);
    assert.equal(run(sha, pinned, false).status, 0);
    assert.equal(readFileSync(join(workspace, "functions/.env.njpbs-site-dev"), "utf8"),
      `CMS_WRITEBACK_CONFIGURED=true\nCMS_ADMIN_BUILD_REVISION=${sha}\nCMS_PUBLISH_GITHUB_TRUSTED_ACTORS=["fixture-owner"]\nCMS_PREVIEW_SERIALIZER_READY=true\nCMS_PREVIEW_RENDERER_SHA=${pinned}\n`);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("dev dispatch defaults to pinned renderer verification and opts into image release explicitly", () => {
  const { parse } = require("yaml");
  const workflow = parse(readFileSync(new URL("../.github/workflows/cms-dev-deploy.yml", import.meta.url), "utf8"));
  assert.equal(workflow.on.workflow_dispatch.inputs.release_preview_renderer.type, "boolean");
  assert.equal(workflow.on.workflow_dispatch.inputs.release_preview_renderer.default, false);
  const pinned = "b".repeat(40), released = "a".repeat(40);
  const context = (releasing, result, cancelled = false) => ({ format: (pattern, value) => pattern.replace("{0}", value), inputs: { release_preview_renderer: releasing },
    needs: { renderer: { result, outputs: { renderer_sha: released } } }, vars: { CANONICAL_GITHUB_REPOSITORY: "CenterCoopMedia/njpbs", CANONICAL_GITHUB_REPOSITORY_ID: "1442374012", CMS_DEV_RENDERER_SOURCE_SHA: pinned, CMS_DEPLOY_OWNER: "fixture-owner" },
    github: { repository_id: "1442374012", ref: "refs/heads/main", actor: "fixture-owner", triggering_actor: "fixture-owner",
      workflow_ref: "CenterCoopMedia/njpbs/.github/workflows/cms-dev-deploy.yml@refs/heads/main" },
    always: () => true, cancelled: () => cancelled });
  // Evaluate the workflow's documented boolean-expression subset, including
  // GitHub's skipped-needs behavior and jobs.needs/always semantics.
  const evaluate = (expression, ctx) => runInNewContext(expression.replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replaceAll("needs.preview-renderer", "needs.renderer"), ctx);
  const renderer = workflow.jobs["preview-renderer"];
  const deploy = workflow.jobs.deploy;
  assert.equal(evaluate(renderer.if, context(false, "skipped")), false);
  assert.equal(evaluate(deploy.if, context(false, "skipped")), true);
  assert.equal(evaluate(deploy.env.CMS_DEV_RENDERER_SOURCE_SHA, context(false, "skipped")), pinned);
  assert.equal(evaluate(renderer.if, context(true, "success")), true);
  assert.equal(evaluate(deploy.if, context(true, "success")), true);
  assert.equal(evaluate(deploy.env.CMS_DEV_RENDERER_SOURCE_SHA, context(true, "success")), released);
  for (const [releasing, result, cancelled] of [[true, "skipped", false], [true, "failure", false], [false, "failure", false], [false, "skipped", true]]) {
    assert.equal(evaluate(deploy.if, context(releasing, result, cancelled)), false);
  }
  const verification = deploy.steps.find(step => step.name === "Verify the pinned dev renderer for a routine deploy");
  assert.equal(evaluate(verification.if, context(false, "skipped")), true);
  assert.equal(evaluate(verification.if, context(true, "success")), false);
  assert.deepEqual(Object.keys(verification.env).sort(), ["CLOUDFLARE_API_TOKEN", "CMS_DEV_PREVIEW_FIREBASE_ACCOUNT"]);
});
