#!/usr/bin/env node
// Deploys the CMS of the checked-out commit: node scripts/deploy-cms.mjs <development|production> [step ...]
// Every step runs, also after a failed one. The run ends with the list of failed steps.
import { spawn } from "node:child_process";
import { chownSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
process.chdir(root);
const require = createRequire(import.meta.url);
const [environment, ...only] = process.argv.slice(2);
if (!["development", "production"].includes(environment)) throw new Error("Usage: deploy-cms.mjs <development|production> [step ...]");
const dev = environment === "development";

// Variables arrive as one JSON object (toJSON(vars)); a name set in the environment wins.
for (const [name, value] of Object.entries(JSON.parse(process.env.CMS_DEPLOYMENT_VARIABLES_JSON || "{}"))) process.env[name] ??= value;
const env = process.env;
env.CMS_TARGET = environment;
if (dev) { env.CMS_DEPLOYMENT_ENVIRONMENT = "development"; env.CMS_PUBLISH_TRANSPORT = "github"; }
else env.CMS_PUBLISH_TRANSPORT = "serializer";
env.GITHUB_REPOSITORY ||= env.CANONICAL_GITHUB_REPOSITORY;
env.VITE_CANONICAL_GITHUB_REPOSITORY ||= env.CANONICAL_GITHUB_REPOSITORY;
env.WRANGLER_SEND_METRICS = "false";

const { assertDevelopmentWorkerConfig, cmsTarget } = await import("./lib/cms-target.mjs");
const target = cmsTarget();
const project = target.projectId;
env.GCLOUD_PROJECT = project; env.GOOGLE_CLOUD_PROJECT = project;

// Credential files live only while this process runs.
const temp = mkdtempSync(join(tmpdir(), "deploy-cms-"));
process.on("exit", () => rmSync(temp, { recursive: true, force: true }));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(1));
const privateFile = (name, text) => { const path = join(temp, name); writeFileSync(path, text, { mode: 0o600 }); return path; };
const account = env.FIREBASE_SERVICE_ACCOUNT ?? "";
// One guard: development credentials must be development's (repository secrets hold production values).
if (account && JSON.parse(account).project_id !== project) throw new Error(`FIREBASE_SERVICE_ACCOUNT is not a ${project} account`);
if (account) env.GOOGLE_APPLICATION_CREDENTIALS = privateFile("google.json", account);

// Provider output streams through; its tail becomes the failure text.
let tail = "", log = "";
function run(command, args, { env: extra = {}, input, capture = false, cwd = root, uid } = {}) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { cwd, ...(uid ? { uid, gid: uid } : {}), env: { ...env, ...extra }, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", chunk => { if (capture) out += chunk; else { process.stdout.write(chunk); tail = (tail + chunk).slice(-6000); log += chunk; } });
    child.stderr.on("data", chunk => { process.stderr.write(chunk); tail = (tail + chunk).slice(-6000); log += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? done(out.trim()) : reject(new Error(`${command} ${args.slice(0, 3).join(" ")} exited ${code}`)));
    if (input !== undefined) { child.stdin.on("error", () => {}); child.stdin.end(input); }
  });
}
const node = (args, options) => run(process.execPath, args, options);
const npx = (args, options) => run("npx", ["--no-install", ...args], options);
const sha = await run("git", ["rev-parse", "HEAD"], { capture: true });
// Functions and the renderer carry the commit that last changed them, so an unchanged one is not deployed again.
const lastChange = paths => run("git", ["log", "-1", "--format=%H", "--", ...paths], { capture: true });
const contract = ["scripts/lib/functions-contracts.mjs", "packages", "package.json", "package-lock.json"];
const functionsSha = await lastChange(["functions", "config", ...contract]);
const rendererSha = await lastChange(["preview-renderer", "site", "functions", "config/development-inputs.json", "scripts/prepare-preview-renderer.mjs", ...contract]);
const secret = async name => {
  const value = await npx(["firebase", "--non-interactive", "functions:secrets:access", name, "--project", project], { capture: true });
  if (!value) throw new Error(`Secret ${name} is empty`);
  return value;
};

async function functionSource() {
  const { loadFunctionSource } = await import("./lib/functions-deploy-inventory.mjs");
  return loadFunctionSource(project);
}

const r2 = async () => ({
  CMS_MEDIA_R2_ACCESS_KEY_ID: await secret("CMS_MEDIA_R2_ACCESS_KEY_ID"),
  CMS_MEDIA_R2_SECRET_ACCESS_KEY: await secret("CMS_MEDIA_R2_SECRET_ACCESS_KEY"),
  CMS_MEDIA_R2_ENDPOINT: `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  CMS_MEDIA_R2_BUCKET: dev ? env.CMS_DEV_MEDIA_BUCKET : env.CMS_MEDIA_R2_BUCKET,
  CMS_MEDIA_PUBLIC_ORIGIN: target.mediaOrigin,
});

const steps = {
  async install() {
    await run("npm", ["ci", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"]);
    await run("npm", ["--prefix", "site", "ci", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"]);
  },
  async render() {
    if (dev) await run("git", ["checkout", "--", `functions/.env.${project}`]); // configure writes it again
    await node(["scripts/render-development-config.mjs", dev ? "--development" : "--production", "--root", root]);
  },
  async "functions-build"() {
    await run("npm", ["run", "functions:build"]);
    await node(["scripts/prepare-cloud-publication-wake.mjs", environment, String(!dev)]);
    await node(["scripts/component-runner.mjs", "functions", "configure"], { env: {
      CMS_ADMIN_BUILD_REVISION: functionsSha, CMS_PREVIEW_RENDERER_SHA: functionsSha, VITE_LIVE_PRODUCTION_ENABLED: dev ? "false" : env.LIVE_PRODUCTION_ENABLED || "false" } });
  },
  async seed() {
    await node(["scripts/backfill-page-seed-media.mjs"]);
    await node(["scripts/backfill-media-thumbnails.mjs", "--apply"], { env: await r2(), input: account });
    await node(["scripts/seed-media-categories.mjs", "--if-needed"]);
    await node(["scripts/backfill-media-category-assignments.mjs"]);
    await node(["scripts/backfill-author-profiles.mjs"], { env: dev ? { AUTHOR_PROFILE_MAPPING: "" } : {} });
    await node(["scripts/seed-content-sections.mjs", "--if-needed"]);
  },
  async firebase() {
    await npx(["firebase", "functions:artifacts:setpolicy", "--project", project, "--location", "us-central1", "--days", "7", "--force"]);
    // Firebase skips each Function whose source, parameters and secrets did not change; a repeat deploys only what is left.
    // No --force: it would delete every live index and Function that the source does not name.
    const rules = dev ? "firestore:rules,firestore:indexes" : "firestore:rules,firestore:indexes,storage";
    for (let left = Infinity; ;) {
      log = "";
      try {
        return await npx(["firebase", "deploy", "--project", project, "--config", target.firebaseConfig, "--only", `${rules},functions`, "--non-interactive"]);
      } catch (error) {
        const failed = new Set([...log.matchAll(/Error Failed to .* function (\w+)/g)].map(match => match[1])).size;
        if (!failed || failed >= left || !/Quota exceeded|HTTP Error: (?:429|5\d\d)/i.test(log)) throw error;
        left = failed;
        console.log(`${failed} Functions met the provider's per-minute write limit; its minute ends in 60 s`);
        await new Promise(done => setTimeout(done, 60_000));
      }
    }
  },
  // Firebase does not grant a new event trigger's identity the right to call it; its events would be dropped.
  async "event-grants"() {
    const { GoogleAuth } = require("google-auth-library");
    const client = await new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }).getClient();
    const call = async (url, method = "GET", data) => (await client.request({ url, method, data })).data;
    const projectPolicy = await call(`https://cloudresourcemanager.googleapis.com/v1/projects/${project}:getIamPolicy`, "POST", {});
    const has = (policy, member) => (policy.bindings ?? []).some(b => b.role === "roles/run.invoker" && !b.condition && b.members?.includes(member));
    const source = await functionSource();
    for (let page = ""; page !== undefined;) {
      const list = await call(`https://cloudfunctions.googleapis.com/v2/projects/${project}/locations/us-central1/functions?pageSize=200${page && `&pageToken=${page}`}`);
      for (const fn of list.functions ?? []) {
        const account = fn.eventTrigger?.serviceAccountEmail, service = fn.serviceConfig?.service;
        if (!account || !service || !Object.hasOwn(source, fn.name.split("/").at(-1))) continue;
        const member = `serviceAccount:${account}`, url = `https://run.googleapis.com/v2/${service}`;
        if (has(projectPolicy, member)) continue;
        const policy = await call(`${url}:getIamPolicy`);
        if (has(policy, member)) continue;
        await call(`${url}:setIamPolicy`, "POST", { policy: { ...policy, bindings: [...policy.bindings ?? [], { role: "roles/run.invoker", members: [member] }] } });
        console.log(`Granted run.invoker on ${service.split("/").at(-1)}`);
      }
      page = list.nextPageToken || undefined;
    }
  },
  async backfill() {
    await node(["scripts/backfill-byline-projections.mjs"]);
    await node(["scripts/backfill-media-discovery.mjs", "--apply", "--project", project, "--source-sha", sha], { input: account });
  },
  async "cms-api"() {
    let config = [];
    if (dev) {
      const rendered = JSON.parse(readFileSync("cms-api/wrangler.dev.jsonc", "utf8"));
      // A config whose names were not rendered must not create a stray Worker.
      assertDevelopmentWorkerConfig(rendered, { name: target.cmsApiWorker, hostnames: [new URL(target.apiOrigin).hostname] });
      // The hostname is attached already, and the dev token cannot edit routes.
      config = ["--config", privateFile("cms-api-wrangler.json", JSON.stringify({ ...rendered, $schema: undefined, routes: undefined, main: join(root, "cms-api", rendered.main) }))];
    }
    const secrets = privateFile("cms-api.json", JSON.stringify({ CMS_EDGE_ORIGIN_SECRET: env.CMS_EDGE_ORIGIN_SECRET, FIREBASE_WEB_API_KEY: env.VITE_FIREBASE_API_KEY?.trim() }));
    await npx(["wrangler", "deploy", ...(dev ? config : ["--cwd", "cms-api"]), "--secrets-file", secrets],
      { env: { CLOUDFLARE_API_TOKEN: dev && env.CLOUDFLARE_DEV_WORKER_TOKEN || env.CLOUDFLARE_API_TOKEN } });
  },
  async renderer() {
    await node(["--import", "./site/node_modules/tsx/dist/loader.mjs", "scripts/deploy-cms-renderer.mjs", rendererSha, ...(only.includes("renderer") ? ["--always"] : [])], { env: {
      CLOUDFLARE_API_TOKEN: dev ? env.CLOUDFLARE_DEV_PREVIEW_RENDERER_TOKEN : env.CLOUDFLARE_API_TOKEN,
      CMS_PREVIEW_FIREBASE_ACCOUNT: dev ? env.CMS_DEV_PREVIEW_FIREBASE_ACCOUNT : account,
      CMS_PREVIEW_R2_CREDENTIAL: dev ? env.CMS_DEV_PREVIEW_R2_CREDENTIAL : env.CMS_PREVIEW_R2_CREDENTIAL } });
  },
  async studio() {
    const bucket = dev ? env.CMS_DEV_STUDIO_BUCKET : env.CMS_MEDIA_MASTER_R2_BUCKET;
    if (!bucket) return console.log("No studio bucket for this target");
    const source = join(temp, "studio-source"), output = join(temp, "studio-connector");
    await run("git", ["worktree", "add", "--detach", source, sha]); // packages the committed source, not the rendered one
    try {
      await run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", join(source, "agents/vmix")]);
      await node([join(source, "agents/vmix/build-windows.mjs"), "--source-sha", sha, "--output", output], { env: {
        DEPLOY_SHA: sha, CMS_STUDIO_API_ORIGIN: dev ? target.apiOrigin : env.CMS_STUDIO_API_ORIGIN } });
      await node(["scripts/upload-studio-connector.mjs", join(output, "manifest.json")], { env: { ...await r2(), DEPLOY_SHA: sha, CMS_MEDIA_MASTER_R2_BUCKET: bucket } });
    } finally { await run("git", ["worktree", "remove", "--force", source]); }
  },
  async "admin-build"() {
    const repository = env.CANONICAL_GITHUB_REPOSITORY;
    const token = env.GITHUB_TOKEN;
    const reply = await fetch(`https://api.github.com/repos/${repository}/milestones?state=all&sort=due_on&direction=asc&per_page=100`,
      { headers: { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    if (!reply.ok) throw new Error(`GitHub milestones HTTP ${reply.status}: ${(await reply.text()).slice(0, 300)}`);
    const milestones = privateFile("milestones.json", await reply.text());
    const manifest = await node(["scripts/admin-status-manifest.mjs", "--environment", dev ? "Development" : "Production",
      "--milestones", milestones, "--repository", repository, "--revision", sha], { capture: true });
    await run("npm", ["run", "admin:build"], { env: { ADMIN_STATUS_MANIFEST_BASE64: manifest, CMS_STUDIO_API_ORIGIN: dev ? target.apiOrigin : env.CMS_STUDIO_API_ORIGIN ?? "",
      VITE_USE_EMULATORS: "false", VITE_FUNCTIONS_BASE_URL: target.apiOrigin, VITE_CMS_PREVIEW_ENABLED: "true",
      VITE_CMS_STUDIO_CONFIGURATION: dev ? "" : env.VITE_CMS_STUDIO_CONFIGURATION ?? "", VITE_LIVE_PRODUCTION_ENABLED: dev ? "false" : env.LIVE_PRODUCTION_ENABLED ?? "false",
      VITE_AUTHOR_PAGES_LIVE: env.AUTHOR_PAGES_LIVE ?? "false", VITE_VIDEO_REPLACEMENT_ENABLED: env.VITE_VIDEO_REPLACEMENT_ENABLED ?? "false",
      VITE_CMS_DEPLOYMENT_ENVIRONMENT: dev ? "development" : "", VITE_FIREBASE_EXPECTED_DEV_APP_ID: dev ? env.CMS_DEV_FIREBASE_WEB_APP_ID : "", VITE_PUBLIC_SITE_ORIGIN: dev ? target.publicOrigin : "",
      VITE_FIREBASE_PROJECT_ID: project, VITE_FIREBASE_AUTH_DOMAIN: `${project}.firebaseapp.com` } });
  },
  async "admin-deploy"() {
    await npx(["wrangler", "pages", "deploy", "dist", "--project-name", target.adminPages, "--branch", "main", "--commit-hash", sha, "--commit-dirty=true"], { cwd: join(root, "admin"),
      env: { CLOUDFLARE_API_TOKEN: dev && env.CLOUDFLARE_DEV_PAGES_TOKEN || env.CLOUDFLARE_API_TOKEN } });
  },
  async "admin-shell"() {
    if (dev) return console.log("The dev Admin stays behind Access");
    await node(["scripts/configure-admin-public-shell.mjs"], { env: { CLOUDFLARE_API_TOKEN: env.CMS_ADMIN_ACCESS_API_TOKEN } });
  },
  async smoke() {
    const faults = [];
    for (const args of [["scripts/smoke-cms-functions.mjs", "--live-only", "--index", "functions/index.js"], ["scripts/smoke-signed-in-preview.mjs", environment]]) {
      // Chrome refuses its sandbox as root, so a root shell runs the smoke as nobody.
      const home = mkdtempSync(join(tmpdir(), "smoke-home-")), nobody = process.getuid() === 0 ? 65534 : undefined;
      if (nobody) chownSync(home, nobody, nobody);
      try { await node(args, { uid: nobody, env: { VITE_FUNCTIONS_BASE_URL: target.apiOrigin, ...(nobody ? { HOME: home } : {}) } }); }
      catch (error) { faults.push(error.message); }
    }
    if (faults.length) throw new Error(faults.join("; "));
  },
};

// A step whose failure can follow from an earlier one; it still runs.
const after = { render: ["install"], "functions-build": ["install", "render"], seed: ["install"], firebase: ["install", "functions-build"],
  "event-grants": ["firebase"], backfill: ["firebase"], "cms-api": ["render", "install"], renderer: ["install", "render"],
  studio: ["install"], "admin-build": ["install", "render"], "admin-deploy": ["admin-build"], "admin-shell": ["install", "admin-deploy"],
  smoke: ["firebase", "cms-api", "renderer", "admin-deploy", "seed"] };
const unknown = only.filter(name => !Object.hasOwn(steps, name));
if (unknown.length) throw new Error(`Unknown step ${unknown.join(", ")}; steps: ${Object.keys(steps).join(", ")}`);
console.log(`Deploy the ${environment} CMS at ${sha}`);
const report = [];
for (const name of Object.keys(steps).filter(step => !only.length || only.includes(step))) {
  const started = Date.now();
  tail = log = "";
  console.log(`\n>>> START ${name}`);
  let error;
  try { await steps[name](); } catch (caught) { error = `${caught.message}\n${tail.trim().split("\n").slice(-12).join("\n")}`.trim(); }
  const seconds = Math.round((Date.now() - started) / 1000);
  report.push({ name, seconds, error });
  console.log(`<<< ${error ? "FAILED" : "DONE"} ${name} ${seconds} s${error ? `\n${error}` : ""}`);
}
const failed = report.filter(row => row.error);
console.log(`\n=== ${failed.length} of ${report.length} steps failed, ${report.reduce((sum, row) => sum + row.seconds, 0)} s`);
for (const { name, seconds, error } of report) console.log(`${error ? "FAILED" : "ok    "} ${name} ${seconds} s`);
for (const { name, error } of failed) {
  const causes = (after[name] ?? []).filter(step => failed.some(row => row.name === step));
  console.log(`\n--- ${name}${causes.length ? ` (likely follows from ${causes.join(", ")})` : ""}\n${error}`);
}
process.exit(failed.length ? 1 : 0);
