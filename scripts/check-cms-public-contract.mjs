#!/usr/bin/env node
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, readdir, lstat, symlink, cp } from "node:fs/promises";
import { tmpdir, networkInterfaces } from "node:os";
import { openSync, closeSync, readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { CONTRACT_SETTINGS, contractDigest, contractTarget, contractIdentity,
  compareContractInputs, captureNativeContract, boundedContractProof, writePrivateCapsule, readPrivateCapsule,
  assertUnchangedPlan, contractSummary, recheckContractSummary, refuse, CmsPublicContractError } from "./lib/cms-public-contract.mjs";
import { readReceipt, collectLiveIdentities, functionsInventoryIdentity, fingerprintInputs, fingerprintFunctionGraph } from "./lib/cms-component-receipt.mjs";
import { FUNCTION_RUNTIME_VARIABLES } from "./lib/cms-release-plan.mjs";
import { repositoryMatches } from "./lib/repository-identity.mjs";
import { readDeploymentManifest, renderCommittedDeploymentSource } from "./render-development-config.mjs";

const execute = promisify(execFile);
const trustedRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const SHA = /^[a-f0-9]{40}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const IMAGE_FILE = "cms-public-contract-image.txt";
const MAX_WIRE = 8 * 1024 * 1024;
const SOURCE_PATHS = ["admin", "functions", "packages", "config", "agents/vmix/configuration.mjs", "cms-api", "preview-renderer", "site/src", "site/scripts", "site/tests/fixtures", "site/package.json", "site/tsconfig.json",
  "scripts", "tests/helpers", "tests/setup", "tests/functions/cms-public-contract.test.ts", "package.json", "package-lock.json", "site/package-lock.json", ".npmrc", "firestore.rules", "firestore.indexes.json",
  "firebase.json", "firebase.dev.json", ".firebaserc", "vitest.config.mjs"];

function argumentsFor(argv) {
  const [command, ...rest] = argv;
  if (!["prepare", "prove", "inside"].includes(command)) refuse("command");
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!["--environment", "--boundary", "--source-root", "--candidate", "--summary", "--previous-summary", "--state-directory"].includes(rest[i]) ||
        options[rest[i]] !== undefined || !rest[i + 1]) refuse("arguments");
    options[rest[i]] = rest[i + 1];
  }
  return { command, options };
}

async function privateDirectory(parent, prefix) {
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(parent, prefix));
  await chmod(directory, 0o700);
  return directory;
}

async function privateCommand(file, args, { cwd, directory, signal, env = process.env }) {
  const stdout = openSync(join(directory, `${randomUUID()}.stdout`), "wx", 0o600);
  const stderr = openSync(join(directory, `${randomUUID()}.stderr`), "wx", 0o600);
  try {
    await new Promise((accept, reject) => {
      const child = spawn(file, args, { cwd, env, signal, stdio: ["ignore", stdout, stderr] });
      child.once("error", reject);
      child.once("exit", code => code === 0 ? accept() : reject(new Error("Private command refused")));
    });
  } finally { closeSync(stdout); closeSync(stderr); }
}

export async function prepareContractRuntime(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const scratch = await privateDirectory(directory, "runtime-");
  try {
    const imageFile = join(directory, IMAGE_FILE);
    await privateCommand("docker", ["build", "--file", join(trustedRoot, "scripts/cms-public-contract-runtime.Dockerfile"), "--iidfile", imageFile, scratch],
      { directory: scratch });
    const image = (await readFile(imageFile, "utf8")).trim();
    if (!IMAGE_ID.test(image)) refuse("runtime-image");
    await chmod(imageFile, 0o600);
    return image;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

async function prepareDependencies({ directory, cwd, environment, candidateSha, previous }) {
  const target = contractTarget(environment, process.env);
  const logs = await privateDirectory(directory, "prepare-");
  const install = async root => {
    const home = join(logs, "home"); await mkdir(home, { recursive: true, mode: 0o700 });
    const env = { PATH: process.env.PATH, HOME: home, CI: "true", npm_config_cache: join(home, ".npm") };
    await privateCommand("npm", ["ci", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"], { cwd: root, directory: logs, env });
    await privateCommand("npm", ["--prefix", "site", "ci", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"], { cwd: root, directory: logs, env });
  };
  try {
    if (trustedRoot !== cwd) await install(trustedRoot);
    const signal = AbortSignal.timeout(30_000);
    let rendererSha, priorAdminSha;
    try {
      const [publication, admin] = await Promise.all([publicJson(`${target.origin}/_publication.json`, target, signal),
        publicJson(`${target.adminOrigin}/admin-status.json`, target, signal)]);
      rendererSha = publication.body?.commitSha;
      priorAdminSha = previous?.priorAdminSha ?? admin.body?.build?.revision;
      if (!SHA.test(rendererSha ?? "") || !SHA.test(priorAdminSha ?? "")) refuse("prepare-source");
    } catch {
      // No dev baseline is a full/unknown plan, not permission to publish.
      // The held full method must still be able to establish the first baseline.
      if (environment !== "development" || process.env.CMS_DEV_PUBLISH_ENABLED !== "false") refuse("prepare-source");
      await writeFile(join(directory, "dependencies.json"), JSON.stringify({ candidateSha, roots: { trusted: trustedRoot, C1: cwd } }), { mode: 0o600 });
      return;
    }
    const roots = { trusted: trustedRoot, C1: cwd };
    for (const [name, sha] of [["R-source", rendererSha], ["C0", priorAdminSha]]) {
      if (sha === candidateSha) roots[name] = cwd;
      else if (name === "C0" && sha === rendererSha) roots[name] = roots["R-source"];
      else {
        const source = join(directory, `dependencies-${sha}`);
        await snapshotSource(sha, source, cwd);
        await install(source);
        roots[name] = source;
      }
    }
    await writeFile(join(directory, "dependencies.json"), JSON.stringify({ candidateSha, rendererSha, priorAdminSha, roots }), { mode: 0o600 });
  } finally { await rm(logs, { recursive: true, force: true }); }
}

async function boundedJson(response, limit = MAX_WIRE) {
  if (!response.ok || !response.body) { await response.body?.cancel(); refuse("provider-unavailable"); }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) refuse("provider-size");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { refuse("provider-response"); }
}

async function cloudflare(script, suffix, target, signal) {
  const token = target.environment === "production" ? process.env.CLOUDFLARE_API_TOKEN :
    script === target.workerName ? process.env.CMS_CONTRACT_PUBLIC_TOKEN :
      script === target.previewWorker ? process.env.CMS_CONTRACT_PREVIEW_TOKEN : process.env.CLOUDFLARE_API_TOKEN;
  if (!token || !/^[a-f0-9]{32}$/i.test(ACCOUNT) || process.env.CLOUDFLARE_ACCOUNT_ID !== ACCOUNT) refuse("provider-credential");
  const body = await boundedJson(await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${script}/${suffix}`, {
    headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  }));
  if (body.success !== true || !body.result) refuse("provider-response");
  return body.result;
}

async function selectedVersion(script, target, signal) {
  const body = await cloudflare(script, "deployments", target, signal);
  const selected = (body.deployments ?? body)?.[0];
  if (!selected || !Array.isArray(selected.versions) || selected.versions.length !== 1 ||
      selected.versions[0].percentage !== 100 || !UUID.test(selected.versions[0].version_id ?? "")) refuse("mixed-worker-traffic");
  const version = await cloudflare(script, `versions/${selected.versions[0].version_id}`, target, signal);
  if (version.id !== selected.versions[0].version_id) refuse("worker-version");
  return { versionId: version.id, deploymentId: selected.id, tag: version.annotations?.["workers/tag"], bindings: version.resources?.bindings };
}

function bindingIdentity(bindings) {
  if (!Array.isArray(bindings)) refuse("worker-bindings");
  const fields = ["name", "type", "id", "namespace_id", "service", "environment", "bucket_name", "queue_name", "class_name", "script_name"];
  // The exact Worker UUID binds values too. Only safe binding names/resource
  // identities enter this tuple; secret text is neither copied nor hashed.
  return bindings.map(binding => Object.fromEntries(fields.filter(key => binding[key] !== undefined).map(key => [key, binding[key]])))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function publicJson(url, target, signal) {
  const headers = { "cache-control": "no-cache" };
  if (target.environment === "development") {
    if (!process.env.CMS_DEV_ACCESS_CLIENT_ID || !process.env.CMS_DEV_ACCESS_CLIENT_SECRET) refuse("dev-read-credential");
    headers["cf-access-client-id"] = process.env.CMS_DEV_ACCESS_CLIENT_ID;
    headers["cf-access-client-secret"] = process.env.CMS_DEV_ACCESS_CLIENT_SECRET;
  }
  const response = await fetch(url, { headers, cache: "no-store", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
  const rendererSha = response.headers.get("x-njpbs-renderer-sha");
  return { body: await boundedJson(response, 512 * 1024), rendererSha };
}

async function listFunctions(target, signal) {
  const require = createRequire(join(trustedRoot, "package.json"));
  const { GoogleAuth } = require("google-auth-library");
  const client = await new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }).getClient();
  const functions = [], tokens = new Set(); let pageToken;
  do {
    const { data } = await client.request({ url: `https://cloudfunctions.googleapis.com/v2/projects/${target.projectId}/locations/-/functions`,
      params: { pageSize: 100, ...(pageToken ? { pageToken } : {}) }, timeout: 15_000, signal });
    if (!Array.isArray(data.functions) || (data.unreachable ?? []).length) refuse("functions-inventory");
    functions.push(...data.functions);
    pageToken = data.nextPageToken;
    if (pageToken && (typeof pageToken !== "string" || tokens.has(pageToken))) refuse("functions-inventory");
    tokens.add(pageToken);
  } while (pageToken);
  return functions;
}

async function compareFunctionsReplies({ capsule, state, target, signal }) {
  const fn = state.providerFunctions.filter(row => row.name === `projects/${target.projectId}/locations/us-central1/functions/cmsGetPublicPage`);
  const bindings = fn[0]?.serviceConfig?.secretEnvironmentVariables?.filter(row => row.key === "CMS_EDGE_ORIGIN_SECRET");
  if (fn.length !== 1 || bindings?.length !== 1 || bindings[0].secret !== "CMS_EDGE_ORIGIN_SECRET" || !/^[1-9][0-9]*$/.test(bindings[0].version ?? "")) refuse("reader-secret-binding");
  const require = createRequire(join(trustedRoot, "package.json"));
  const { GoogleAuth } = require("google-auth-library");
  const client = await new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }).getClient();
  let bytes, credential;
  try {
    const { data } = await client.request({ url: `https://secretmanager.googleapis.com/v1/projects/${target.projectId}/secrets/CMS_EDGE_ORIGIN_SECRET/versions/${bindings[0].version}:access`, timeout: 10_000, signal });
    if (typeof data.payload?.data !== "string" || data.payload.data.length > 64 * 1024) refuse("reader-secret-binding");
    bytes = Buffer.from(data.payload.data, "base64"); data.payload.data = "";
    credential = bytes.toString("utf8");
    if (!/^[\x21-\x7e]{32,32768}$/.test(credential)) refuse("reader-secret-binding");
    for (const [feature, mode] of [["postChrome", "no-build-post-v1"], ["capabilities", "no-build-page-v1"]]) {
      const response = await fetch(`https://us-central1-${target.projectId}.cloudfunctions.net/cmsGetPublicPage`, {
        method: "POST", headers: { "content-type": "application/json", "cache-control": "no-cache", "x-njpbs-cms-edge": credential },
        body: JSON.stringify({ ...capsule.requests[feature], mode, method: "GET" }), redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
      const reply = await boundedJson(response);
      if (contractDigest(reply) !== contractDigest(JSON.parse(capsule.replies[feature]))) refuse("capture-moved");
    }
  } finally { bytes?.fill(0); credential = null; }
}

export async function restoreRendererArchive({ restoreArtifact, reference, archive, checkpointDigest, signal }) {
  // The storage owner restores only into an existing private directory.
  await mkdir(archive, { recursive: true, mode: 0o700 });
  if (!await restoreArtifact(reference, archive, checkpointDigest, signal)) refuse("checkpoint-unavailable");
}

export function retainRendererArchive(restore, compare = compareFunctionsReplies) {
  let restored = false;
  return async comparison => {
    await compare(comparison);
    if (!restored) {
      await restore(comparison.state, comparison.signal);
      restored = true;
    }
  };
}

function outputValues(source) {
  const values = Object.fromEntries(source.trim().split("\n").map(line => {
    const at = line.indexOf("=");
    if (at < 1 || !/^[a-z_]+$/.test(line.slice(0, at))) refuse("planner-output");
    return [line.slice(0, at), line.slice(at + 1)];
  }));
  return values;
}

async function nativeProductionPlan({ candidateSha, cwd, directory, signal }) {
  const functionsOutput = join(directory, "functions-plan.txt"), apiOutput = join(directory, "api-plan.txt");
  const baseEnv = { ...process.env, GITHUB_WORKSPACE: cwd, DEPLOY_SHA: candidateSha };
  await privateCommand(process.execPath, [join(trustedRoot, "scripts/cms-release-plan.mjs")], {
    cwd, directory, signal, env: { ...baseEnv, GITHUB_OUTPUT: functionsOutput },
  });
  const functions = outputValues(await readFile(functionsOutput, "utf8"));
  const secretsFile = join(directory, "api-secrets.json");
  // This is the existing API plan's configuration owner and digest, not a new secret digest.
  if (!process.env.CMS_EDGE_ORIGIN_SECRET || !process.env.FIREBASE_WEB_API_KEY) refuse("planner-credential");
  await writeFile(secretsFile, JSON.stringify({ CMS_EDGE_ORIGIN_SECRET: process.env.CMS_EDGE_ORIGIN_SECRET,
    FIREBASE_WEB_API_KEY: process.env.FIREBASE_WEB_API_KEY }), { mode: 0o600 });
  try {
    await privateCommand(process.execPath, [join(trustedRoot, "scripts/cms-component-receipt.mjs"), "plan", "--component", "cmsApi",
      "--source-sha", candidateSha, "--trusted-workflow-sha", process.env.CMS_TRUSTED_WORKFLOW_SHA ?? process.env.GITHUB_SHA,
      "--secrets-file", secretsFile, "--configuration-fingerprint-file", join(directory, "api-configuration.sha256")], {
      cwd, directory, signal, env: { ...baseEnv, GITHUB_OUTPUT: apiOutput, FUNCTIONS_MUTATED: functions.functions_mutated,
        CONFIGURATION_REQUIRES_RELEASE: functions.configuration_requires_release, CMS_EDGE_ORIGIN_SECRET_FINGERPRINT: functions.edge_origin_secret_fingerprint },
    });
  } finally { await rm(secretsFile, { force: true }); }
  const api = outputValues(await readFile(apiOutput, "utf8"));
  return { abort: false, releaseReason: functions.release_reason, functionsMutated: functions.functions_mutated !== "false",
    previewPaused: functions.preview_paused !== "false", configurationRequiresRelease: functions.configuration_requires_release !== "false",
    apiMutated: api.mutated !== "false", rulesMutated: false, indexesMutated: false, rendererMutated: functions.preview_paused !== "false",
    functionDeployTargets: functions.function_deploy_targets };
}

async function nativeDevelopmentPlan({ state, target, candidateSha, cwd, signal }) {
  await compareContractInputs({ candidateSha, baselineSha: state.identity.backend.baseline.sourceSha, cwd });
  const stdout = await readFile(join(cwd, "functions/.env.njpbs-site-dev"), "utf8");
  const parameters = Object.fromEntries(stdout.split(/\r?\n/).filter(line => line && !line.startsWith("#")).map(line => {
    const at = line.indexOf("="); if (at < 1) refuse("dev-configuration"); return [line.slice(0, at), line.slice(at + 1)];
  }));
  Object.assign(parameters, { CMS_ADMIN_BUILD_REVISION: state.identity.priorAdminSha, CMS_PREVIEW_SERIALIZER_READY: "true",
    CMS_PREVIEW_RENDERER_SHA: state.identity.backend.previewRendererSha });
  for (const fn of state.providerFunctions) {
    if (Object.entries(parameters).some(([key, value]) => fn.serviceConfig?.environmentVariables?.[key] !== value)) refuse("dev-configuration");
  }
  const require = createRequire(join(trustedRoot, "package.json"));
  const { GoogleAuth } = require("google-auth-library");
  const client = await new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }).getClient();
  const project = (await client.request({ url: `https://cloudresourcemanager.googleapis.com/v1/projects/${target.projectId}`, timeout: 15_000, signal })).data;
  const seen = new Map();
  for (const fn of state.providerFunctions) for (const binding of fn.serviceConfig?.secretEnvironmentVariables ?? []) {
    if (![target.projectId, project.projectNumber].includes(binding.projectId) || !/^[A-Za-z0-9_-]+$/.test(binding.secret ?? "") ||
        !/^[1-9][0-9]*$/.test(binding.version ?? "")) refuse("dev-secret-project");
    const key = `${binding.projectId}/${binding.secret}`;
    if (!seen.has(key)) seen.set(key, (await client.request({ url: `https://secretmanager.googleapis.com/v1/projects/${binding.projectId}/secrets/${binding.secret}/versions/latest`, timeout: 15_000, signal })).data);
    const latest = seen.get(key);
    if (latest.state !== "ENABLED" || latest.name?.split("/").at(-1) !== binding.version) refuse("dev-secret-version");
  }
  return { abort: false, releaseReason: "unchanged", functionsMutated: false, previewPaused: false, configurationRequiresRelease: false,
    apiMutated: false, rulesMutated: false, indexesMutated: false, rendererMutated: false, functionDeployTargets: "" };
}

export async function devCompletedBaseline(priorAdminSha, functions, signal) {
  const repository = process.env.GITHUB_REPOSITORY;
  const owner = process.env.CMS_DEPLOY_OWNER;
  if (!repositoryMatches(repository, process.env, process.env.GITHUB_REPOSITORY_ID) ||
      !process.env.GITHUB_REPOSITORY_ID || !owner || !process.env.GITHUB_TOKEN) refuse("dev-baseline");
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/cms-dev-deploy.yml/runs?branch=main&status=success&per_page=20`, {
    headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: "application/vnd.github+json" }, signal,
  });
  const runs = (await boundedJson(response, 1024 * 1024)).workflow_runs;
  // A dispatch may deploy an explicit deploy_ref, so head_sha names only the workflow revision. The
  // deployed revision is the one each Function records; the run is the one whose window contains every update.
  if (!functions.length || functions.some(fn => fn.serviceConfig?.environmentVariables?.CMS_ADMIN_BUILD_REVISION !== priorAdminSha)) refuse("dev-mixed-backend");
  const run = runs?.find(row => row.event === "workflow_dispatch" && row.conclusion === "success" && row.actor?.login === owner &&
    functions.every(fn => Date.parse(fn.updateTime) >= Date.parse(row.run_started_at) && Date.parse(fn.updateTime) <= Date.parse(row.updated_at)));
  if (!run) refuse("dev-baseline");
  return { runId: String(run.id), sourceSha: priorAdminSha, completedAt: run.updated_at };
}

async function readState({ firestore, target, cwd, signal, originalPriorAdminSha }) {
  const [publicMetadata, admin, worker, api, functions, functionsReceipt, apiReceipt, rendererReceipt, rootRow] = await Promise.all([
    publicJson(`${target.origin}/_publication.json`, target, signal), publicJson(`${target.adminOrigin}/admin-status.json`, target, signal),
    selectedVersion(target.workerName, target, signal), selectedVersion(target.apiWorker, target, signal), listFunctions(target, signal),
    readReceipt(firestore, "functions"), readReceipt(firestore, "cmsApi"), readReceipt(firestore, "renderer"), firestore.doc("system/publicDeployment").get(),
  ]);
  const publicRoot = rootRow.data();
  const rendererSha = publicMetadata.body?.commitSha;
  const priorAdminSha = originalPriorAdminSha ?? admin.body?.build?.revision;
  if (!SHA.test(rendererSha ?? "") || publicMetadata.rendererSha !== rendererSha || publicRoot?.state !== "idle" ||
      publicRoot.schemaVersion !== 1 || publicRoot.activeCommitSha !== rendererSha || !SHA.test(priorAdminSha ?? "")) refuse("public-binding");
  const native = createRequire(join(trustedRoot, "package.json"));
  const sourceSha = target.environment === "production" ? functionsReceipt?.state === "complete" && functionsReceipt.mutation?.sourceSha : priorAdminSha;
  if (!SHA.test(sourceSha ?? "")) refuse("baseline-incomplete");
  const graph = await fingerprintFunctionGraph(sourceSha, { cwd });
  let expectedExports = Object.keys(graph.exports);
  if (target.environment === "development") {
    const { stdout } = await execute("git", ["show", `${sourceSha}:functions/dev-manifest.js`], { cwd });
    const parsed = [...stdout.matchAll(/^  ([A-Za-z][A-Za-z0-9]*): "\.\/[A-Za-z0-9-]+",?$/gm)].map(row => row[1]);
    if (!parsed.length) refuse("dev-manifest");
    expectedExports = parsed;
  }
  const selectedFunctions = functions.filter(fn => (fn.labels?.["firebase-functions-codebase"] ?? "default") === (target.environment === "development" ? "dev" : "default"));
  if (selectedFunctions.length !== functions.length || functions.some(fn => fn.state !== "ACTIVE" || fn.serviceConfig?.allTrafficOnLatestRevision !== true ||
      fn.buildConfig?.entryPoint !== fn.name?.split("/").at(-1))) refuse("functions-inventory");
  let baseline;
  let previewIdentity;
  if (target.environment === "production") {
    if (![functionsReceipt, apiReceipt, rendererReceipt].every(row => row?.state === "complete") ||
        contractDigest(functionsReceipt.mutation.providerIdentities) !== contractDigest(functionsInventoryIdentity(functions))) refuse("backend-receipt");
    if (functionsReceipt.mutation.inputFingerprint !== await fingerprintInputs(sourceSha, "functions", { cwd }) ||
        contractDigest(functionsReceipt.mutation.functionGraph) !== contractDigest(graph) ||
        apiReceipt.mutation.inputFingerprint !== await fingerprintInputs(apiReceipt.mutation.sourceSha, "cmsApi", { cwd }) ||
        await fingerprintInputs(apiReceipt.mutation.sourceSha, "cmsApi", { cwd }) !== await fingerprintInputs(sourceSha, "cmsApi", { cwd })) refuse("backend-source");
    if (apiReceipt.mutation.providerIdentities.versionId !== api.versionId || apiReceipt.mutation.providerIdentities.script !== target.apiWorker) refuse("api-receipt");
    previewIdentity = await collectLiveIdentities("renderer", { firestore });
    if (contractDigest(previewIdentity) !== contractDigest(rendererReceipt.mutation.providerIdentities)) refuse("preview-receipt");
    baseline = { sourceSha, receiptDigest: contractDigest([functionsReceipt, apiReceipt, rendererReceipt]) };
  } else {
    baseline = await devCompletedBaseline(priorAdminSha, functions, signal);
    const { collectDevRendererIdentity, assertPinnedDevRendererReceipt } = await import(pathToFileURL(join(trustedRoot, "preview-renderer/deploy-dev.mjs")));
    const control = (await firestore.doc("system/cmsPreviewRuntime").get()).data();
    previewIdentity = await collectDevRendererIdentity(process.env.CMS_CONTRACT_PREVIEW_TOKEN, rendererReceipt?.sourceSha, fetch, { releaseStartedAt: rendererReceipt?.releaseStartedAt });
    assertPinnedDevRendererReceipt(control, rendererReceipt, previewIdentity, rendererReceipt?.sourceSha);
    if (api.tag !== priorAdminSha) refuse("dev-api-source");
  }
  const batches = await firestore.collection("system/publicDeployment/buildBatches").where("generation", "==", publicRoot.activeGeneration)
    .where("commitSha", "==", rendererSha).limit(2).get();
  if (batches.size !== 1 || !/^cms-[A-Za-z0-9]{20}$/.test(batches.docs[0].id)) refuse("checkpoint-unavailable");
  const queueId = batches.docs[0].id.slice(4);
  const candidate = (await batches.docs[0].ref.collection("candidates").doc("worker").get()).data();
  const preparation = native("./functions/lib/public-release-preparation.js");
  const checkpointRow = await firestore.doc(`system/publicReleasePreparations/entries/${queueId}/checkpoints/artifact`).get();
  const checkpoint = checkpointRow.data();
  if (!candidate || candidate.workerVersionId !== worker.versionId || candidate.commitSha !== rendererSha ||
      candidate.artifactDigest !== publicMetadata.body.artifactDigest || !checkpoint?.preparedArtifact) refuse("renderer-artifact-binding");
  await preparation.assertPreparedPublicReleaseCheckpoint({ firestore, preparationId: queueId, preparedArtifact: checkpoint.preparedArtifact,
    target: native("./functions/lib/publication-target.js").publicationTarget(target.environment) });
  if (checkpoint.preparedArtifact.artifactDigest !== candidate.artifactDigest) refuse("renderer-artifact-binding");
  const fingerprints = await Promise.all(selectedFunctions.map(async fn => ({ name: fn.name.split("/").at(-1), state: fn.state,
    revision: fn.serviceConfig?.revision, sourceSha, inputFingerprint: graph.exports[fn.name.split("/").at(-1)]?.fingerprint ?? await fingerprintInputs(sourceSha, "functions", { cwd }) })));
  const configuration = selectedFunctions.map(fn => ({ name: fn.name, service: fn.serviceConfig?.service,
    parameters: Object.fromEntries([...FUNCTION_RUNTIME_VARIABLES, "CMS_ADMIN_BUILD_REVISION", "CMS_PREVIEW_RENDERER_SHA", "CMS_READER_BRIDGE_ENABLED"]
      .filter(key => Object.hasOwn(fn.serviceConfig?.environmentVariables ?? {}, key)).map(key => [key, fn.serviceConfig.environmentVariables[key]])),
    secretVersions: (fn.serviceConfig?.secretEnvironmentVariables ?? []).map(row => ({ key: row.key, secret: row.secret, version: row.version, projectId: row.projectId })) }));
  const identity = contractIdentity({ priorAdminSha, publicReader: { worker: target.workerName, versionId: worker.versionId, percentage: 100,
    rendererSha, codeGeneration: publicRoot.activeGeneration, artifactDigest: candidate.artifactDigest, checkpointDigest: checkpoint.artifactCheckpointDigest,
    apiBindingDigest: contractDigest(bindingIdentity(worker.bindings)), capabilitiesDigest: contractDigest({ pages: candidate.noBuildPage ?? null, posts: candidate.noBuildPost ?? null }) },
    backend: { functions: fingerprints, expectedExports, configurationFingerprint: contractDigest(configuration), apiVersionId: api.versionId,
      apiBindingDigest: contractDigest(bindingIdentity(api.bindings)), previewRendererSha: previewIdentity.rendererSha ?? rendererReceipt.sourceSha,
      previewIdentityDigest: contractDigest(previewIdentity), baseline } }, target);
  return { identity, checkpoint, providerFunctions: functions,
    reference: { queueId, commitSha: rendererSha, buildBatchId: `cms-${queueId}`, inputSha256: checkpoint.inputSha256 }, adminSha: admin.body?.build?.revision };
}

async function snapshotSource(sha, destination, cwd) {
  await mkdir(destination, { mode: 0o700 });
  const archive = join(destination, ".source.tar");
  const { stdout } = await execute("git", ["ls-tree", "-rz", "--name-only", sha, "--", ...SOURCE_PATHS], { cwd, maxBuffer: 8 * 1024 * 1024 });
  const files = stdout.split("\0").filter(Boolean);
  if (!files.length || files.some(file => file.startsWith("/") || /[\\\r\n]/.test(file) ||
      file.split("/").some(segment => segment === "." || segment === ".."))) refuse("source-unavailable");
  const selected = SOURCE_PATHS.filter(prefix => files.some(file => file === prefix || file.startsWith(`${prefix}/`)));
  await execute("git", ["archive", "--format=tar", `--output=${archive}`, sha, ...selected], { cwd });
  await execute("tar", ["-xf", archive, "-C", destination]);
  await rm(archive);
  const manifest = readDeploymentManifest(cwd, sha);
  for (const file of files) {
    if (!Object.values(manifest?.inputs ?? {}).some(input => input.files.includes(file))) continue;
    const path = join(destination, file);
    const source = await readFile(path, "utf8");
    const rendered = renderCommittedDeploymentSource(file, source, process.env, manifest);
    if (source !== rendered) await writeFile(path, rendered);
  }
}

async function sealFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const file = join(directory, entry.name);
    if (entry.isSymbolicLink()) refuse("source-symlink");
    if (entry.isDirectory()) await sealFiles(file);
    else if (!entry.isFile()) refuse("source-file");
    await chmod(file, entry.isDirectory() ? 0o700 : 0o600);
  }
}

async function seal(directory) {
  await sealFiles(directory);
  await chmod(directory, 0o700);
  // Hosted runners supply passwordless sudo. Only this disposable input tree changes owner.
  await execute("sudo", ["chown", "-R", "65534:65534", directory]);
}

export function replayDockerArguments({ image, sealedDirectory, dependencies, siteDependencies, dependencyRoots, name, owner = "local-proof" }) {
  if (!IMAGE_ID.test(image) || !/^cms-contract-[a-f0-9-]+$/.test(name)) refuse("runtime-image");
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(owner)) refuse("replay-owner");
  const args = ["run", "--rm", "--name", name, "--label", `njpbs.cms-contract=${owner}`, "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--user", "65534:65534", "--pids-limit", "256",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=2g,mode=1777", "--mount", `type=bind,source=${sealedDirectory},target=/inputs,readonly`];
  for (const source of ["trusted", "C0", "C1", "R-source"]) {
    const root = dependencyRoots?.[source];
    args.push("--mount", `type=bind,source=${root ? join(root, "node_modules") : dependencies},target=/inputs/${source}/node_modules,readonly`);
    args.push("--mount", `type=bind,source=${root ? join(root, "site/node_modules") : siteDependencies},target=/inputs/${source}/site/node_modules,readonly`);
    for (const workspace of ["functions", "admin", "cms-api"]) {
      const nested = root && join(root, workspace, "node_modules");
      if (nested && existsSync(nested)) args.push("--mount", `type=bind,source=${nested},target=/inputs/${source}/${workspace}/node_modules,readonly`);
    }
  }
  const rendererRoot = dependencyRoots?.["R-source"];
  args.push("--mount", `type=bind,source=${rendererRoot ? join(rendererRoot, "node_modules") : dependencies},target=/inputs/R-artifact/node_modules,readonly`);
  args.push("--mount", `type=bind,source=${rendererRoot ? join(rendererRoot, "site/node_modules") : siteDependencies},target=/inputs/R-artifact/renderer/node_modules,readonly`);
  args.push("--env", "HOME=/tmp/home", "--env", "METADATA_SERVER_DETECTION=none", "--env", "CI=true", "--env", "TZ=America/New_York", image);
  return args;
}

const REPLAY_FAILURE_KINDS = new Set(["startup", "filesystem", "dependency", "timeout", "process", "test", "handler-project-mismatch",
  "handler-auth-refused:auth/argument-error", "handler-auth-refused:auth/invalid-id-token", "handler-auth-refused:auth/id-token-revoked",
  "handler-auth-refused:auth/internal-error", "handler-auth-refused:app/invalid-credential", "handler-auth-refused:unknown"]);

// The isolated corpus writes one sanitized diagnostic line to its private stderr. Keep only that
// line's allowlisted fields; every other stderr byte stays private.
export function replayRefusal(stderr) {
  for (const line of stderr.split("\n").reverse()) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.schemaVersion !== 1 || row.result !== "refused" || !["sdk-replay-refused", "api-replay-refused"].includes(row.code) ||
        !REPLAY_FAILURE_KINDS.has(row.failureKind) || !Array.isArray(row.failedTests) || row.failedTests.length > 30 ||
        row.failedTests.some(value => typeof value !== "string" || !DIGEST.test(value)) ||
        !(row.counts === null || Array.isArray(row.counts) && row.counts.length === 4 &&
          row.counts.every(value => value === null || Number.isSafeInteger(value) && value >= 0 && value <= 100_000))) continue;
    const error = new CmsPublicContractError(row.code);
    error.diagnostic = { failedTests: row.failedTests, counts: row.counts, failureKind: row.failureKind };
    return error;
  }
  return new CmsPublicContractError("replay-refused");
}

export function refusalLine(error) {
  // SDK, candidate and provider exceptions can contain private inputs. Never print them.
  const code = error instanceof CmsPublicContractError && /^[a-z][a-z-]{1,63}$/.test(error.code) ? error.code : "proof-refused";
  return JSON.stringify({ schemaVersion: 1, result: "refused", code, ...(error instanceof CmsPublicContractError && error.diagnostic ? error.diagnostic : {}) });
}

export async function replay({ capsule, candidateSha, baselineSha, rendererSha, cwd, directory, image, signal, archive, dependencyRoots }) {
  const inputs = await privateDirectory(directory, "sealed-");
  const capsuleDigest = contractDigest(capsule);
  try {
    for (const [name, sha] of [["C0", baselineSha], ["C1", candidateSha], ["R-source", rendererSha]]) await snapshotSource(sha, join(inputs, name), cwd);
    await snapshotSource(process.env.CMS_TRUSTED_WORKFLOW_SHA ?? process.env.GITHUB_SHA, join(inputs, "trusted"), cwd);
    for (const source of ["trusted", "C0", "C1", "R-source"]) {
      for (const relative of ["node_modules", "site/node_modules", ...["functions", "admin", "cms-api"].filter(workspace =>
        existsSync(join(dependencyRoots[source], workspace, "node_modules"))).map(workspace => `${workspace}/node_modules`)]) {
        await mkdir(join(inputs, source, relative), { recursive: true, mode: 0o700 });
      }
    }
    const sealFile = JSON.parse(await readFile(join(archive, "renderer/renderer-release.json"), "utf8"));
    if (sealFile.rendererSha !== rendererSha || sealFile.schemaVersion !== 1) refuse("renderer-substitution");
    await cp(archive, join(inputs, "R-artifact"), { recursive: true, dereference: false });
    await mkdir(join(inputs, "R-artifact/node_modules"), { mode: 0o700 });
    await mkdir(join(inputs, "R-artifact/renderer/node_modules"), { mode: 0o700 });
    await writePrivateCapsule(join(inputs, "capsule.json"), capsule);
    await writePrivateCapsule(join(inputs, "invocation.json"), { candidateSha, baselineSha, rendererSha, capsuleDigest, identityDigest: contractDigest(capsule.identity) });
    await seal(inputs);
    const name = `cms-contract-${randomUUID()}`;
    const stdoutPath = join(directory, "replay.stdout"), stderrPath = join(directory, "replay.stderr");
    const stdout = openSync(stdoutPath, "wx", 0o600), stderr = openSync(stderrPath, "wx", 0o600);
    let exitCode;
    try {
      const args = replayDockerArguments({ image, sealedDirectory: inputs, dependencyRoots, name,
        owner: `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-${process.env.GITHUB_JOB}` });
      await new Promise((accept, reject) => {
        const child = spawn("docker", args, { signal, stdio: ["ignore", stdout, stderr] });
        child.once("error", reject); child.once("exit", code => { exitCode = code; accept(); });
      });
    } finally {
      closeSync(stdout); closeSync(stderr);
      await execute("docker", ["rm", "--force", name]).catch(() => {});
    }
    if (exitCode !== 0) throw replayRefusal(await readFile(stderrPath, "utf8"));
    const output = await readFile(stdoutPath, "utf8");
    if (Buffer.byteLength(output) > 64 * 1024) refuse("replay-output");
    try { return JSON.parse(output); } catch { refuse("replay-output"); }
  } finally { await execute("sudo", ["rm", "-rf", "--", inputs]); }
}

export async function assertReplayIsolation() {
  if (process.getuid() !== 65534 || Object.keys(process.env).some(key => /TOKEN|SECRET|CREDENTIAL|GOOGLE_|GITHUB_|AWS_|ACCESS_KEY|DOCKER_HOST/.test(key)) ||
      Object.keys(networkInterfaces()).some(name => name !== "lo")) refuse("replay-isolation");
  const status = await readFile("/proc/self/status", "utf8");
  if (!/^CapEff:\s+0+$/m.test(status) || !/^NoNewPrivs:\s+1$/m.test(status)) refuse("replay-isolation");
  for (const file of ["/var/run/docker.sock", "/root/.aws/credentials", "/root/.config/gcloud/application_default_credentials.json"]) {
    if (await lstat(file).catch(() => null)) refuse("replay-isolation");
  }
  const mounts = await readFile("/proc/self/mountinfo", "utf8");
  if (!mounts.split("\n").some(row => row.split(" ")[4] === "/" && row.split(" ")[5]?.split(",").includes("ro"))) refuse("replay-isolation");
  for (const line of mounts.split("\n").filter(row => row.includes(" /inputs"))) {
    if (!line.split(" ")[5]?.split(",").includes("ro")) refuse("replay-isolation");
  }
}

async function runReplayCorpus(args, { phase, report, directory, env }) {
  try {
    await privateCommand(process.execPath, args, { directory, cwd: directory, env });
  } catch {
    let failedTests = [];
    let counts = null, failureKind = "startup";
    try {
      const result = JSON.parse(await readFile(report, "utf8"));
      failedTests = result.testResults.flatMap(row => row.assertionResults)
        .filter(row => row.status === "failed").slice(0, 30).map(row => contractDigest(row.fullName));
      counts = ["numTotalTests", "numPassedTests", "numFailedTests", "numFailedTestSuites"].map(key =>
        Number.isSafeInteger(result[key]) && result[key] >= 0 && result[key] <= 100_000 ? result[key] : null);
      const messages = result.testResults.flatMap(row => [row.message ?? "", ...row.assertionResults.flatMap(test => test.failureMessages ?? [])]).join("\n");
      failureKind = /EROFS|EACCES/.test(messages) ? "filesystem" : /MODULE_NOT_FOUND|Cannot find (?:module|package)/.test(messages) ? "dependency"
        : /timed out|timeout/i.test(messages) ? "timeout" : /thread|pthread|Resource temporarily unavailable/.test(messages) ? "process" : "test";
      const startup = /handler-project-mismatch|handler-auth-refused:(?:auth\/(?:argument-error|invalid-id-token|id-token-revoked|internal-error)|app\/invalid-credential|unknown)/.exec(messages);
      if (startup) failureKind = startup[0];
    } catch { /* Startup errors have no completed test report. */ }
    // Test identities are hashed; assertion values and candidate logs stay private.
    process.stderr.write(JSON.stringify({ schemaVersion: 1, result: "refused", code: `${phase}-replay-refused`, failedTests, counts, failureKind }) + "\n");
    refuse(`${phase}-replay-refused`);
  }
}

async function inside() {
  await assertReplayIsolation();
  const directory = await privateDirectory("/tmp", "execution-");
  await mkdir("/tmp/home", { mode: 0o700 });
  await symlink("/inputs/trusted/node_modules", join(directory, "node_modules"));
  const config = join(directory, "firebase.json");
  await writeFile(config, JSON.stringify({ firestore: { rules: "/inputs/C0/firestore.rules" }, emulators: {
    auth: { host: "127.0.0.1", port: 19464 }, firestore: { host: "127.0.0.1", port: 18464 }, hub: { host: "127.0.0.1", port: 14464 },
    logging: { host: "127.0.0.1", port: 14564 }, ui: { enabled: false }, singleProjectMode: false } }));
  const vitestConfig = join(directory, "vitest.config.mjs");
  await writeFile(vitestConfig, `export default { cacheDir: ${JSON.stringify(join(directory, "vite-cache"))}, test: { testTimeout: 20000, hookTimeout: 20000, maxWorkers: 1, fileParallelism: false } };`);
  const resultFile = join(directory, "result.json");
  const sdkReport = join(directory, "sdk-tests.json");
  const apiRepliesFile = join(directory, "api-replies.json");
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const command = [process.execPath, "/inputs/trusted/node_modules/vitest/vitest.mjs", "run", "/inputs/trusted/tests/functions/cms-public-contract.test.ts",
    "--config", vitestConfig, "--configLoader", "native", "--root", "/inputs/trusted", "--reporter=json", `--outputFile=${sdkReport}`].map(quote).join(" ");
  await runReplayCorpus(["/inputs/trusted/node_modules/firebase-tools/lib/bin/firebase.js", "emulators:exec", "--project", "demo-njpbs-contract", "--config", config,
    "--only", "auth,firestore", "--non-interactive", command], { phase: "sdk", report: sdkReport, directory, env: { ...process.env,
      CMS_PUBLIC_CONTRACT_INPUTS: "/inputs", CMS_PUBLIC_CONTRACT_RESULT: resultFile, CMS_PUBLIC_CONTRACT_API_REPLIES: apiRepliesFile,
      GCLOUD_PROJECT: "demo-njpbs-contract", FUNCTIONS_EMULATOR: "true" } });
  const result = await readPrivateCapsule(resultFile);
  const nativeReplies = await readPrivateCapsule(apiRepliesFile);
  await rm(join(directory, "node_modules"));
  await symlink("/inputs/C0/node_modules", join(directory, "node_modules"));
  const apiConfig = join(directory, "api.config.mjs"), apiResultFile = join(directory, "api-result.json");
  await writeFile(apiConfig, `import {cloudflareTest} from '@cloudflare/vitest-pool-workers';
    export default {cacheDir:${JSON.stringify(join(directory, "api-cache"))},plugins:[cloudflareTest({
      wrangler:{configPath:'/inputs/C0/cms-api/wrangler.jsonc'},miniflare:{
        bindings:{CMS_EDGE_ORIGIN_SECRET:'synthetic-edge',CMS_ROUTE_D_REPLIES:${JSON.stringify(JSON.stringify(nativeReplies))}},
        workers:[{name:'njpbs-cms-preview-renderer',modules:true,compatibilityDate:'2026-08-13',
          script:'export default {fetch(){return new Response(null,{status:404})}}'}]}})],
      test:{include:['test/public-content-rpc.test.ts'],testTimeout:20000,testNamePattern:'Route D'}};`, { mode: 0o600 });
  await runReplayCorpus(["/inputs/C0/node_modules/vitest/vitest.mjs", "run", "--config", apiConfig,
    "--configLoader", "native", "--root", "/inputs/C0/cms-api", "--reporter=json", `--outputFile=${apiResultFile}`], { phase: "api", report: apiResultFile, directory });
  const apiResult = JSON.parse(await readFile(apiResultFile, "utf8"));
  if (apiResult.numPassedTests !== 2 || apiResult.numFailedTests !== 0) refuse("api-replay-incomplete");
  result.apiPassThroughDigest = contractDigest({ sourceSha: result.baselineSha, replies: nativeReplies,
    cases: apiResult.testResults.flatMap(row => row.assertionResults).filter(row => row.status === "passed").map(row => row.fullName) });
  process.stdout.write(JSON.stringify(result));
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = argumentsFor(argv);
  if (command === "inside") return inside();
  const stateDirectory = resolve(options["--state-directory"] ?? join(process.env.RUNNER_TEMP ?? tmpdir(), "cms-public-contract"));
  if (command === "prepare") {
    const cwd = resolve(options["--source-root"] ?? process.cwd()), candidateSha = options["--candidate"];
    if (!SHA.test(candidateSha ?? "")) refuse("arguments");
    if (options["--environment"] === "development" && process.env.CMS_DEV_PUBLISH_ENABLED === "false") return;
    if (options["--environment"] === "production") {
      const { verifyLivePublisher } = await import(pathToFileURL(join(trustedRoot, ".github/scripts/cms-deploy-compatibility.mjs")));
      try { await verifyLivePublisher(cwd, `${contractTarget("production", process.env).origin}/_publication.json`); return; }
      catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("CMS deploy_ref must be an ancestor of live public renderer ")) refuse("public-first-refused");
      }
    }
    const previous = options["--previous-summary"] ? JSON.parse(await readFile(options["--previous-summary"], "utf8")) : null;
    await prepareDependencies({ directory: stateDirectory, cwd, candidateSha, environment: options["--environment"], previous });
    return prepareContractRuntime(stateDirectory);
  }
  const environment = options["--environment"], boundary = options["--boundary"];
  if (!["production", "development"].includes(environment) || !["preflight", "before-upload", "settlement"].includes(boundary)) refuse("arguments");
  const cwd = resolve(options["--source-root"] ?? process.cwd());
  const source = createRequire(join(environment === "production" ? trustedRoot : cwd, "package.json"));
  const target = contractTarget(environment, process.env, source("./functions/lib/publication-target.js").publicationTarget(environment));
  const candidateSha = options["--candidate"];
  if (!SHA.test(candidateSha ?? "") || !options["--summary"]) refuse("arguments");
  if (environment === "development" && process.env.CMS_DEV_PUBLISH_ENABLED === "false") {
    const previous = options["--previous-summary"] ? JSON.parse(await readFile(options["--previous-summary"], "utf8")) : null;
    if (boundary !== "preflight" && (!previous || previous.result !== "full" || previous.candidateSha !== candidateSha)) refuse("resume-baseline");
    await writeFile(resolve(options["--summary"]), JSON.stringify({ schemaVersion: 1, result: "full", candidateSha, environment, projectId: target.projectId }) + "\n", { mode: 0o600 });
    if (process.env.GITHUB_OUTPUT) {
      const { appendFile } = await import("node:fs/promises"); await appendFile(process.env.GITHUB_OUTPUT, "independent=false\n");
    }
    process.stdout.write(JSON.stringify({ schemaVersion: 1, result: "full", candidateSha }) + "\n");
    return;
  }
  if (environment === "production") {
    const { verifyLivePublisher } = await import(pathToFileURL(join(trustedRoot, ".github/scripts/cms-deploy-compatibility.mjs")));
    let publisherSha;
    try { publisherSha = await verifyLivePublisher(cwd, `${target.origin}/_publication.json`); }
    catch (error) {
      // Only the known non-ancestor refusal can proceed to independent proof.
      if (!(error instanceof Error) || !error.message.startsWith("CMS deploy_ref must be an ancestor of live public renderer ")) refuse("public-first-refused");
    }
    if (publisherSha) {
      await writeFile(resolve(options["--summary"]), `${JSON.stringify({ schemaVersion: 1, result: "public-first", candidateSha, publisherSha, capturedAt: Date.now() })}\n`, { mode: 0o600 });
      process.stdout.write(JSON.stringify({ schemaVersion: 1, result: "public-first", candidateSha }) + "\n");
      if (process.env.GITHUB_OUTPUT) {
        const { appendFile } = await import("node:fs/promises");
        await appendFile(process.env.GITHUB_OUTPUT, "independent=false\n");
      }
      return;
    }
  }
  const image = (await readFile(join(stateDirectory, IMAGE_FILE), "utf8")).trim();
  if (!IMAGE_ID.test(image)) refuse("runtime-image");
  const require = createRequire(join(trustedRoot, "package.json"));
  const { initializeApp, applicationDefault, deleteApp } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");
  const app = initializeApp({ credential: applicationDefault(), projectId: target.projectId }, `cms-contract-${randomUUID()}`);
  const firestore = getFirestore(app, target.databaseId);
  const directory = await privateDirectory(stateDirectory, "boundary-");
  try {
    const dependencies = JSON.parse(await readFile(join(stateDirectory, "dependencies.json"), "utf8"));
    if (dependencies.candidateSha !== candidateSha) refuse("prepare-source");
    const previous = options["--previous-summary"] ? JSON.parse(await readFile(options["--previous-summary"], "utf8")) : null;
    if ((boundary !== "preflight" || Number(process.env.GITHUB_RUN_ATTEMPT ?? 1) > 1) && !previous) refuse("resume-baseline");
    let originalIdentity;
    const archive = join(directory, "verified-renderer");
    const compareAndRestore = retainRendererArchive(async (state, signal) => {
      const { parsePreviewStorageCredential } = await import(pathToFileURL(join(trustedRoot, "site/scripts/cms-preview-storage-credential.ts")));
      const { createCmsPublicationCloudStorage } = await import(pathToFileURL(join(trustedRoot, "site/scripts/cms-publication-cloud-storage.ts")));
      let credential;
      try { credential = parsePreviewStorageCredential(readFileSync(4, "utf8")); }
      finally { try { closeSync(4); } catch {} }
      const { restoreArtifact } = createCmsPublicationCloudStorage({ ...credential, includeRenderer: true,
        target: require("./functions/lib/publication-target.js").publicationTarget(environment) });
      credential = null;
      await restoreRendererArchive({ restoreArtifact, reference: state.reference, archive, checkpointDigest: state.identity.publicReader.checkpointDigest, signal });
    });
    const summary = await boundedContractProof(async ({ signal, attempt }) => {
      const attemptDirectory = await privateDirectory(directory, `attempt-${attempt}-`);
      let state, plan;
      try {
        state = await readState({ firestore, target, cwd, signal, originalPriorAdminSha: previous?.priorAdminSha });
        await compareContractInputs({ candidateSha, baselineSha: state.identity.backend.baseline.sourceSha, cwd });
        if (process.env.FORCE_FIREBASE === "true" || process.env.CMS_DEV_RENDERER_ONLY === "true" || process.env.CMS_DEV_RELEASE_PREVIEW_RENDERER === "true" ||
            process.env.CMS_DEV_INSTALL_READER_BRIDGE === "true" || process.env.CMS_PRODUCTION_INSTALL_READER_BRIDGE === "true") refuse("plan-not-unchanged");
        plan = environment === "production" ? await nativeProductionPlan({ candidateSha, cwd, directory: attemptDirectory, signal }) :
          await nativeDevelopmentPlan({ state, target, candidateSha, cwd, signal });
        assertUnchangedPlan(plan);
      } catch (error) {
        // Only full/unknown planning, before any independent capture, retains the held dev method.
        if (environment === "development" && boundary === "preflight" && !previous && process.env.CMS_DEV_PUBLISH_ENABLED === "false") {
          return { schemaVersion: 1, candidateSha, result: "full", reason: "full-or-unknown-plan" };
        }
        throw error;
      }
      if (environment === "development" && process.env.CMS_DEV_PUBLISH_ENABLED !== "true") refuse("dev-independent-mode");
      if (dependencies.rendererSha !== state.identity.publicReader.rendererSha || dependencies.priorAdminSha !== state.identity.priorAdminSha) refuse("prepare-source-changed");
      await compareContractInputs({ candidateSha: state.identity.priorAdminSha, baselineSha: state.identity.backend.baseline.sourceSha, cwd });
      if (originalIdentity && contractDigest(originalIdentity) !== contractDigest(state.identity)) refuse("proof-contract-changed");
      originalIdentity ??= state.identity;
      const source = join(attemptDirectory, "baseline");
      await snapshotSource(state.identity.backend.baseline.sourceSha, source, cwd);
      await symlink(join(cwd, "node_modules"), join(source, "node_modules"));
      const postOwners = await firestore.collection("system/publicDeployment/noBuildPostOwners").limit(2).get();
      // Exact-only heads have no readyQueueId; filter in the query so they cannot crowd out a retained head.
      const previewHeads = await firestore.collection("cmsPreviewHeads").where("readyQueueId", ">", "").limit(1).get();
      const post = postOwners.docs[0]?.data(), previewHead = previewHeads.docs[0]?.data();
      if (!post?.slug || !previewHead?.pageId || !previewHead?.collection) refuse("capture-corpus-unavailable");
      const requests = { settings: [...CONTRACT_SETTINGS], postChrome: { path: `/posts/${post.slug}/`, rendererSha: state.identity.publicReader.rendererSha },
        capabilities: { path: "/contact/", rendererSha: state.identity.publicReader.rendererSha }, previewRequest: { collection: previewHead.collection, pageId: previewHead.pageId } };
      const capsule = await captureNativeContract({ firestore, baselineRoot: source, target, requests, identity: state.identity, signal });
      await compareAndRestore({ capsule, state, target, signal });
      const result = await replay({ capsule, candidateSha, baselineSha: state.identity.priorAdminSha,
        rendererSha: state.identity.publicReader.rendererSha, cwd, directory: attemptDirectory, image, signal, archive, dependencyRoots: dependencies.roots });
      const fresh = await readState({ firestore, target, cwd, signal, originalPriorAdminSha: state.identity.priorAdminSha });
      if (contractDigest(fresh.identity) !== contractDigest(state.identity)) refuse("proof-contract-changed");
      const recaptured = await captureNativeContract({ firestore, baselineRoot: source, target, requests, identity: fresh.identity, signal });
      if (contractDigest(capsule.readset) !== contractDigest(recaptured.readset) || contractDigest(capsule.root) !== contractDigest(recaptured.root)) refuse("capture-moved");
      if (boundary === "settlement" && fresh.adminSha !== candidateSha) refuse("settlement-unconfirmed");
      return contractSummary({ candidateSha, identity: state.identity, capsuleDigest: contractDigest(capsule), replay: result, capturedAt: capsule.capturedAt });
    }, { boundary });
    if (previous) recheckContractSummary(previous, summary, { candidateSha, settlement: boundary === "settlement" });
    await writeFile(resolve(options["--summary"]), `${JSON.stringify(summary)}\n`, { mode: 0o600 });
    if (process.env.GITHUB_OUTPUT) {
      const { appendFile } = await import("node:fs/promises");
      await appendFile(process.env.GITHUB_OUTPUT, `independent=${summary.result === "proved"}\n`);
    }
    process.stdout.write(JSON.stringify({ schemaVersion: 1, result: summary.result, candidateSha, ...(summary.proofDigest ? { proofDigest: summary.proofDigest } : {}) }) + "\n");
  } finally { await deleteApp(app); await rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${refusalLine(error)}\n`);
    process.exitCode = 1;
  });
}
