#!/usr/bin/env node
// Install the development cloud publisher at an exact main commit outside a release run.
// Usage, from a clean checkout of main that contains the commit, with CANONICAL_GITHUB_REPOSITORY and
// CANONICAL_GITHUB_REPOSITORY_ID naming the repository:
//   node scripts/install-dev-publisher.mjs --sha <X> --image-run <publisher-image development run id> [--check] \
//     3< <(<print the dev Firestore operator credential JSON>) \
//     4< <(<print the dev publisher deploy token>) \
//     5< <(<print the dev Cloudflare read token>)
// Each descriptor is read only when its credential is used, kept in memory and never written.
// --check performs every read and stops before the deploy; it never opens descriptor 4.
// Development only: every name is fixed below and there is no target argument; the container
// application is the single one named for the development Worker. The deploy
// token can also write production Workers, so no call falls back to a default name.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareTarget, productionConfig, publisherTarget, targetSource } from "../.github/scripts/publisher-image.mjs";
import { developmentInputs } from "./render-development-config.mjs";
import { repositoryIdentity } from "./lib/repository-identity.mjs";
import { rolloutApplied } from "./lib/cms-component-receipt.mjs";

const require = createRequire(import.meta.url);
const repository = fileURLToPath(new URL("..", import.meta.url));
export const target = publisherTarget("development");
const WORKER = "njpbs-dev-cms-publisher";
const SHA = /^[a-f0-9]{40}$/;
const TOKEN = /^[A-Za-z0-9_-]{20,4096}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
// Container secrets the Worker keeps across the reinstall; their values are never handled.
export const SECRETS = ["ACTIVATION_TOKEN", "CMS_DEV_ACCESS_CLIENT_ID", "CMS_DEV_ACCESS_CLIENT_SECRET", "FIREBASE_SERVICE_ACCOUNT",
  "MEDIA_MANAGER_CREDENTIAL", "PUBLICATION_WAKE_TOKEN", "R2_PREVIEW_CREDENTIAL", "R2_PUBLICATION_CREDENTIAL"];
export const WAIT = { attempts: 60, intervalMs: 15_000 };
// Emulator settings take precedence over the credential in the Firebase SDK.
const AMBIENT = ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_CONFIG"];

export class InstallRefusal extends Error {}
const refuse = message => { throw new InstallRefusal(message); };
if (target.publisherWorker !== WORKER || target.projectId !== "njpbs-site-dev") refuse("Development target names differ");

export function parseArguments(args, env = process.env) {
  const check = args.at(-1) === "--check";
  const [flag0, sha, flag1, run, ...rest] = check ? args.slice(0, -1) : args;
  if (flag0 !== "--sha" || !SHA.test(sha ?? "") || flag1 !== "--image-run" || !/^[1-9][0-9]{0,19}$/.test(run ?? "") || rest.length) {
    refuse("Usage: install-dev-publisher --sha <40-hex main commit> --image-run <run id> [--check]");
  }
  // config-input: FIREBASE_AUTH_EMULATOR_HOST, FIREBASE_CONFIG, FIRESTORE_EMULATOR_HOST, GOOGLE_APPLICATION_CREDENTIALS
  if (AMBIENT.some(key => env[key] !== undefined)) refuse("Unset Firebase emulator and ambient credential settings");
  return { sha, run, check };
}

// The run must be the main publisher-image workflow that built this exact development source.
export function assertImageRun(run, sha, identity) {
  if (run?.repository?.full_name?.toLowerCase() !== identity.repository.toLowerCase() || String(run.repository.id) !== identity.id || run.path !== ".github/workflows/publisher-image.yml" ||
      run.head_branch !== "main" || run.event !== "workflow_dispatch" || run.status !== "completed" ||
      run.conclusion !== "success" || run.display_title !== `Publisher image development ${sha}` ||
      !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) refuse("Image run is not a successful development publisher-image run for this commit");
  return `publisher-image-development-${sha}-${run.run_attempt}`;
}

export function assertReceipt(receipt, { sha, run, account }) {
  const prefix = `registry.cloudflare.com/${account}/${WORKER}@`;
  if (JSON.stringify(Object.keys(receipt ?? {}).sort()) !== JSON.stringify(["deployment_input_sha256", "image", "schema", "source_sha", "target", "workflow_run_id"]) ||
      receipt.schema !== 1 || receipt.target !== "development" || receipt.source_sha !== sha || receipt.workflow_run_id !== run ||
      typeof receipt.image !== "string" || !receipt.image.startsWith(prefix) || !DIGEST.test(receipt.image.slice(prefix.length)) ||
      !/^[a-f0-9]{64}$/.test(receipt.deployment_input_sha256 ?? "")) refuse("Development image receipt refused");
  return receipt;
}

// Public variables and template inputs come from the same GitHub settings the image run used:
// the publisher-image environment first, then the repository.
export function deploymentVariables(repositoryVariables, environmentVariables) {
  const value = name => environmentVariables[name] ?? repositoryVariables[name];
  let variables;
  try { variables = JSON.parse(value("PUBLISHER_DEVELOPMENT_PUBLIC_VARS_JSON")); } catch { refuse("Development publisher variables are missing"); }
  if (!variables || typeof variables !== "object" || Array.isArray(variables) || "CMS_DEV_CLOUDFLARE_ACCOUNT_ID" in variables) {
    refuse("Development publisher variables are invalid");
  }
  variables = { ...variables, CMS_DEV_CLOUDFLARE_ACCOUNT_ID: value("CMS_DEV_CLOUDFLARE_ACCOUNT_ID") ?? "" };
  if (variables.CMS_DEPLOYMENT_ENVIRONMENT !== "development" || variables.PUBLICATION_SERIALIZER_ID !== target.serializerId ||
      !/^[a-f0-9]{32}$/.test(variables.CLOUDFLARE_ACCOUNT_ID ?? "") || variables.CMS_DEV_CLOUDFLARE_ACCOUNT_ID !== variables.CLOUDFLARE_ACCOUNT_ID) {
    refuse("Development publisher variables do not name the development target");
  }
  const inputs = {};
  for (const name of Object.keys(developmentInputs)) {
    if (typeof value(name) !== "string" || !value(name)) refuse("A development template input is missing");
    inputs[name] = value(name);
  }
  return { variables, inputs };
}

// The installed publisher, its runtime control and the live pointer must name one commit.
export function assertAligned({ runtime, pointer }, sha) {
  if (runtime?.phase !== "ready" || runtime.commitSha !== sha || runtime.cloud?.phase !== "ready" ||
      runtime.cloud.commitSha !== sha || runtime.cloud.serializerId !== target.serializerId ||
      pointer?.state !== "idle" || pointer.activeCommitSha !== sha) {
    refuse("Development runtime, cloud runtime and pointer do not all name this commit");
  }
}

export function assertDeployConfig(config, { sha, image }) {
  if (config.name !== WORKER || config.containers?.length !== 1 || config.containers[0].name !== WORKER ||
      config.containers[0].image !== image || "image_build_context" in config.containers[0] ||
      JSON.stringify(config.routes) !== JSON.stringify([{ pattern: new URL(target.publisherOrigin).host, custom_domain: true }]) ||
      config.r2_buckets?.length !== 1 || config.r2_buckets[0].bucket_name !== target.publicationBucket ||
      config.vars?.CMS_DEPLOYMENT_ENVIRONMENT !== "development" || config.vars.PUBLICATION_SERIALIZER_ID !== target.serializerId ||
      config.vars.PUBLICATION_COMMIT_SHA !== sha) refuse("Rendered configuration does not name the development publisher");
  return config;
}

// An existing app with a changed image takes one rollout; --containers-rollout immediate makes it one 100% step.
// A JSON {} secrets file sets keep_secrets, so every existing secret, set or placeholder, is kept unchanged.
export function deployCommand({ wrangler, config, secretsFile, sha, token, account }) {
  return {
    args: ["--no-warnings", wrangler, "deploy", "--name", WORKER, "--config", config, "--containers-rollout", "immediate",
      "--secrets-file", secretsFile, "--message", `install-dev-publisher ${sha}`],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: "true", CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account,
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false", CLOUDFLARE_INCLUDE_PROCESS_ENV: "false", WRANGLER_SEND_METRICS: "false" },
  };
}

// Every non-secret binding, as the live Worker reports it and as the rendered config declares it.
const sortedBindings = list => JSON.stringify(list.sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`)));
export function liveBindings(settings) {
  return sortedBindings((settings?.bindings ?? []).filter(b => b.type !== "secret_text").map(b => b.type === "plain_text"
    ? { type: b.type, name: b.name, text: b.text } : b.type === "r2_bucket" ? { type: b.type, name: b.name, bucket_name: b.bucket_name, jurisdiction: b.jurisdiction ?? "" }
      : b.type === "durable_object_namespace" ? { type: b.type, name: b.name, class_name: b.class_name } : { type: b.type, name: b.name }));
}
export function renderedBindings(config) {
  return sortedBindings([...Object.entries(config.vars).map(([name, text]) => ({ type: "plain_text", name, text })),
    ...config.r2_buckets.map(b => ({ type: "r2_bucket", name: b.binding, bucket_name: b.bucket_name, jurisdiction: b.jurisdiction ?? "" })),
    ...config.durable_objects.bindings.map(b => ({ type: "durable_object_namespace", name: b.name, class_name: b.class_name }))]);
}

const secretNames = settings => (settings?.bindings ?? []).filter(b => b.type === "secret_text").map(b => b.name).sort();
const plain = (settings, name) => settings?.bindings?.find(b => b.type === "plain_text" && b.name === name)?.text;

// The container application is found by its fixed development name; exactly one must exist.
export async function readPublisher(cloudflare) {
  const [settings, applications, deployments] = await Promise.all([
    cloudflare(`workers/scripts/${WORKER}/settings`), cloudflare("containers/applications"), cloudflare(`workers/scripts/${WORKER}/deployments`)]);
  const named = Array.isArray(applications) ? applications.filter(app => app?.name === WORKER) : [];
  if (named.length !== 1 || !/^[a-f0-9-]{36}$/.test(named[0].id ?? "")) refuse("The development publisher container application is not unique");
  // The application must serve the Worker's PUBLISHER Durable Object namespace.
  const namespace = settings?.bindings?.filter(b => b.type === "durable_object_namespace" && b.name === "PUBLISHER") ?? [];
  if (namespace.length !== 1 || !namespace[0].namespace_id || named[0].durable_objects?.namespace_id !== namespace[0].namespace_id) {
    refuse("The development publisher container application is not bound to the Worker");
  }
  const versions = deployments?.deployments?.[0]?.versions ?? [];
  return { secrets: secretNames(settings), commit: plain(settings, "PUBLICATION_COMMIT_SHA"), bindings: liveBindings(settings), application: named[0],
    image: named[0].configuration?.image, version: versions.length === 1 && versions[0].percentage === 100 ? versions[0].version_id : undefined };
}

const newestRollout = rollouts => rollouts.reduce((a, b) => (Date.parse(b.created_at) > Date.parse(a.created_at) ? b : a));

// The image running on the application: the newest rollout's target once it is applied, or the
// application record for a first install, which creates the application with no rollout.
// A rollout still in flight, or one bound elsewhere, gives no applied image.
export function appliedImage(application, rollouts) {
  if (!Array.isArray(rollouts)) return undefined;
  if (!rollouts.length) return application.configuration?.image;
  const newest = newestRollout(rollouts);
  if (!["pending", "progressing", "completed"].includes(newest.status)) refuse("Publisher rollout was reverted or replaced");
  return rolloutApplied(application, newest) ? newest.target_configuration.image : undefined;
}

export function assertBefore(before) {
  if (JSON.stringify(before.secrets) !== JSON.stringify(SECRETS)) refuse("Live publisher secret names differ from the development contract");
}

// Waits for the commit on one Worker version, the receipt image applied and /health 200.
// After a deploy the Worker version must also differ from the one read before it.
export async function readBack({ cloudflare, health, sleep, before, sha, image, bindings, deployed }) {
  for (let attempt = 0; attempt < WAIT.attempts; attempt += 1) {
    if (attempt) await sleep(WAIT.intervalMs);
    const after = await readPublisher(cloudflare);
    if (JSON.stringify(after.secrets) !== JSON.stringify(before.secrets)) refuse("Publisher secret names changed");
    if (after.application.id !== before.application.id) refuse("Publisher container application changed");
    if (after.commit !== sha || after.bindings !== bindings || !after.version || (deployed && after.version === before.version)) continue;
    const rollouts = await cloudflare(`containers/applications/${after.application.id}/rollouts`);
    // The application record can keep the previous image after a rollout completes; the applied target is the proof.
    if (appliedImage(after.application, rollouts) !== image) continue;
    if (await health() !== 200) continue;
    return { schema: 1, target: "development", worker: WORKER, source_sha: sha, image, previous_version: before.version ?? null,
      version: after.version, rollout: rollouts.length ? newestRollout(rollouts).id : null, noRollout: !rollouts.length, health: 200, deployed };
  }
  refuse("Publisher readback did not complete; rerun --check to read the live state");
}

export async function install({ sha, run, check }, io) {
  io.assertSource(sha);
  const identity = io.identity();
  const imageRun = await io.github(`repos/${identity.repository}/actions/runs/${run}`);
  const artifact = assertImageRun(imageRun, sha, identity);
  const { variables, inputs } = deploymentVariables(await io.variables(identity.repository), await io.variables(identity.repository, "publisher-image"));
  const account = variables.CLOUDFLARE_ACCOUNT_ID;
  const receipt = assertReceipt(await io.receipt(identity.repository, run, artifact), { sha, run, account });
  const { prepared, inputFingerprint } = io.prepare({ sha, variables, inputs });
  try {
    if (inputFingerprint !== receipt.deployment_input_sha256) refuse("Rendered inputs differ from the image's inputs");
    const config = assertDeployConfig(productionConfig(io.sourceConfig(sha), targetSource(JSON.parse(readFileSync(prepared.configPath, "utf8")), target),
      { checkout: prepared.source, sha, image: receipt.image, variables, target }), { sha, image: receipt.image });
    assertAligned(await io.firestore(io.credential(3)), sha);
    const readToken = io.token(5);
    const cloudflare = route => io.cloudflare(account, route, readToken);
    const before = await readPublisher(cloudflare);
    assertBefore(before);
    // A Worker on one version with exactly the rendered non-secret bindings (so the commit too), whose application already runs the image, is installed,
    // including a first install with no rollout, which the release method accepts; only the readback runs.
    const rollouts = await cloudflare(`containers/applications/${before.application.id}/rollouts`);
    const applied = appliedImage(before.application, rollouts);
    const bindings = renderedBindings(config);
    const installed = before.bindings === bindings && Boolean(before.version) && applied === receipt.image;
    const live = { version: before.version ?? null, commit: before.commit ?? null, application: before.application.id, image: applied ?? null };
    if (check) return { schema: 1, check: true, source_sha: sha, image: receipt.image, live, deploy_needed: !installed };
    if (installed) return await readBack({ cloudflare, health: io.health, sleep: io.sleep, before, sha, image: receipt.image, bindings, deployed: false });
    const configPath = path.join(prepared.directory, "deploy.json"), secretsFile = path.join(prepared.directory, "keep-secrets.json");
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    writeFileSync(secretsFile, "{}\n");
    io.deploy(deployCommand({ wrangler: prepared.wrangler, config: configPath, secretsFile, sha, token: io.token(4), account }), prepared.source);
    return await readBack({ cloudflare, health: io.health, sleep: io.sleep, before, sha, image: receipt.image, bindings, deployed: true });
  } finally {
    rmSync(prepared.directory, { recursive: true, force: true });
  }
}

const quiet = { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 };
const git = args => execFileSync("/usr/bin/git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
  { ...quiet, cwd: repository, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
const gh = args => execFileSync("gh", ["api", "-H", "X-GitHub-Api-Version: 2022-11-28", ...args], quiet);
const onMain = sha => { try { git(["merge-base", "--is-ancestor", sha, "origin/main"]); return true; } catch { return false; } };
const readFd = fd => { try { return readFileSync(fd, "utf8"); } catch { return refuse(`Credential descriptor ${fd} is not readable`); } };

// The variables endpoints return at most 30 per page.
export function collectVariables(page) {
  const variables = [];
  for (let number = 1; number <= 10; number += 1) {
    const listed = page(number);
    if (!Array.isArray(listed?.variables) || !Number.isSafeInteger(listed.total_count)) break;
    variables.push(...listed.variables);
    if (variables.length >= listed.total_count || !listed.variables.length) {
      if (variables.length !== listed.total_count || new Set(variables.map(v => v.name)).size !== variables.length) break;
      return Object.fromEntries(variables.map(v => [v.name, v.value]));
    }
  }
  return refuse("GitHub variable listing is incomplete");
}

const variablesOf = route => collectVariables(number => JSON.parse(gh([`${route}?per_page=30&page=${number}`])));

export const liveIo = {
  identity: () => { try { return repositoryIdentity(process.env); } catch { return refuse("Configure CANONICAL_GITHUB_REPOSITORY and CANONICAL_GITHUB_REPOSITORY_ID"); } },
  assertSource(sha) {
    let clean = false;
    try { clean = git(["status", "--porcelain"]) === "" && onMain(git(["rev-parse", "HEAD"])) && onMain(sha); } catch { /* Refuse below. */ }
    if (!clean) refuse("Run from a clean checkout of main that contains the commit");
  },
  github: async route => JSON.parse(gh([route])),
  variables: async (repository, environment) => variablesOf(environment ? `repos/${repository}/environments/${environment}/variables` : `repos/${repository}/actions/variables`),
  async receipt(repository, run, artifact) {
    const directory = mkdtempSync(path.join(tmpdir(), "njpbs-dev-publisher-receipt-"));
    try {
      execFileSync("gh", ["run", "download", run, "--repo", repository, "--name", artifact, "--dir", directory], { stdio: "ignore" });
      if (JSON.stringify(readdirSync(directory)) !== JSON.stringify(["receipt.json"])) refuse("Development image artifact contents differ");
      return JSON.parse(readFileSync(path.join(directory, "receipt.json"), "utf8"));
    } catch (error) {
      if (error instanceof InstallRefusal) throw error;
      return refuse("Development image artifact could not be read");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  },
  prepare: ({ sha, variables, inputs }) => prepareTarget({ sha, target, variables, checkout: repository, source: liveIo.sourceConfig(sha),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...inputs, CMS_DEV_CLOUDFLARE_ACCOUNT_ID: variables.CMS_DEV_CLOUDFLARE_ACCOUNT_ID } }),
  sourceConfig: sha => targetSource(JSON.parse(git(["show", `${sha}:publisher/wrangler.json`])), target),
  credential: fd => readFd(fd),
  token(fd) {
    const token = readFd(fd).trim();
    if (!TOKEN.test(token)) refuse(`Credential descriptor ${fd} does not hold a token`);
    return token;
  },
  async firestore(input) {
    const { parseDevOperatorCredential } = await import("./lib/dev-proof-admission.mjs");
    const account = parseDevOperatorCredential(input);
    const runtime = require("../functions/lib/cms-publication-runtime-control");
    const { assertPublicDeploymentPointer } = require("../functions/lib/public-deployment-pointer");
    const { cert, initializeApp, deleteApp } = require("firebase-admin/app");
    const { getFirestore } = require("firebase-admin/firestore");
    const app = initializeApp({ projectId: target.projectId, credential: cert(account) }, `install-dev-publisher-${process.pid}`);
    try {
      const firestore = getFirestore(app);
      const [pins, pointer] = await firestore.getAll(firestore.doc(runtime.RUNTIME_DOCUMENT_PATH), firestore.doc("system/publicDeployment"));
      if (!pins.exists || !pointer.exists) refuse("Development runtime or pointer is absent");
      return { runtime: runtime.parseCmsPublicationRuntimeControl(pins.data()), pointer: assertPublicDeploymentPointer(pointer.data()) };
    } finally { await deleteApp(app); }
  },
  async cloudflare(account, route, token) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/${route}`, {
      headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(30_000) });
    const envelope = response.ok ? await response.json() : undefined;
    if (envelope?.success !== true) refuse(`Cloudflare read refused (HTTP ${response.status})`);
    return envelope.result;
  },
  async health() {
    try {
      const response = await fetch(`${target.publisherOrigin}/health`, { redirect: "error", signal: AbortSignal.timeout(30_000) });
      return response.status;
    } catch { return 0; }
  },
  deploy({ args, env }, cwd) {
    try { execFileSync(process.execPath, args, { cwd, env, stdio: "ignore" }); }
    // Wrangler output is withheld; the readback reports what changed.
    catch (error) { refuse(`Publisher deploy failed (exit ${Number.isInteger(error.status) ? error.status : "unknown"}); run --check to read the live state`); }
  },
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  install(parseArguments(process.argv.slice(2)), liveIo)
    .then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(error => {
      console.error(error instanceof InstallRefusal ? error.message : "Development publisher install failed; details withheld.");
      process.exitCode = 1;
    });
}
