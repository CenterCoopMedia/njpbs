#!/usr/bin/env node
import { assertDevelopmentSource, readDeploymentManifest, renderCommittedDeploymentSource } from "./render-development-config.mjs";
import { workflowMatches } from "./lib/repository-identity.mjs";
import { deploymentOwner } from "./lib/deployment-settings.mjs";
import { execFileSync } from "node:child_process";
import { devDeploySourceSha } from "./lib/dev-deploy-source.mjs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applicationDefault, initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { assertDevTargets, assertDevConfigs, devPublicationIdentity } from "./assert-dev-cms-targets.mjs";
import { deployDevFunctions } from "./deploy-dev-functions.mjs";
import deployment from "../functions/lib/dev-reader-deployment.js";
import mount from "../functions/lib/cms-reader-mount-descriptor.js";
import cms from "../functions/lib/cms-preview-pair.js";
import { RECEIPT_INPUT_PATHS, fingerprintPaths, fingerprintInputs, configurationFingerprint, startReceipt, startCandidateReceipt,
  verifyCandidateReceipt, completeReceipt, commitLiveReaderReceipt, candidateReceiptRef } from "./lib/cms-component-receipt.mjs";
import { readEnabledCmsReaderProviders } from "./lib/cms-enabled-reader-provider.mjs";

const refuse = () => { throw new Error("Dev reader deployment refused; retain the original attempt for reconciliation"); };
const supported = { previewRequest: [1], postChrome: [1], settings: [1], capabilities: [1], adminSession: [1, 2] };

export function assertDevReaderContext(env) {
  const sourceSha = devDeploySourceSha(env);
  const installing = env.CMS_DEV_INSTALL_READER_BRIDGE === "true";
  if (installing && sourceSha !== env.GITHUB_SHA) refuse();
  const owner = deploymentOwner(env);
  assertDevTargets(env);
  const binding = installing ? deployment.devReaderDeployment(env) : deployment.devReaderUpdateDeployment(env);
  if (binding.CMS_READER_BRIDGE_ENABLED !== "true" || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") ||
      env.GITHUB_WORKFLOW_SHA !== env.GITHUB_SHA || env.GITHUB_REF !== "refs/heads/main" ||
      env.GITHUB_ACTOR !== owner || env.GITHUB_TRIGGERING_ACTOR !== owner ||
      !workflowMatches(env.GITHUB_WORKFLOW_REF, "cms-dev-deploy.yml", env)) refuse();
  return binding;
}

export function readDevReaderDeploymentProviders({ env, ...options }) {
  return readEnabledCmsReaderProviders({ ...options, projectId: "njpbs-site-dev",
    accountId: env.CLOUDFLARE_ACCOUNT_ID, sourceSha: devDeploySourceSha(env) });
}

/** Update the dev readers through their native deployment owners. The separate
 * first installation remains explicit. Neither mode writes a selector or proof. */
export async function deployDevReaders({ env = process.env, root = new URL("../", import.meta.url), firestore,
  readProviders, consumerProvider, onPhase = () => {}, deployFunctions = options => deployDevFunctions(options),
  deployApi = () => execFileSync("npx", ["--no-install", "wrangler", "deploy", "--config", "wrangler.dev.jsonc", "--tag", env.DEPLOY_SHA],
    { cwd: new URL("cms-api/", root), stdio: "inherit" }), fingerprint = fingerprintPaths } = {}) {
  onPhase("configuration");
  const binding = assertDevReaderContext(env);
  const sourceSha = devDeploySourceSha(env);
  if (firestore?.projectId !== "njpbs-site-dev" || typeof readProviders !== "function") refuse();
  if ((await firestore.doc(`cmsReaderBridgeInstalledProofs/${binding.CMS_READER_BRIDGE_OPERATION_ID}`).get()).exists) refuse();
  if (env.CMS_DEV_INSTALL_READER_BRIDGE !== "true") {
    for (const component of ["functions", "cmsApi"]) {
      cms.currentReader((await firestore.doc(`${cms.READER_RECEIPTS}/${component}`).get()).data(), component);
    }
  }
  // Every deployment starts from the reviewed inert defaults.
  assertDevConfigs(root, { ...env, CMS_DEV_INSTALL_READER_BRIDGE: "false", CMS_DEV_READER_OPERATION_ID: "", CMS_DEV_READER_INSTALL_AUTHORIZATION: "" });
  const dotenvPath = new URL("functions/.env.njpbs-site-dev", root), apiPath = new URL("cms-api/wrangler.dev.jsonc", root);
  const dotenv = readFileSync(dotenvPath, "utf8"), apiBytes = readFileSync(apiPath, "utf8");
  const api = JSON.parse(apiBytes);
  const functionVars = Object.fromEntries(dotenv.split(/\r?\n/).filter(line => line && !line.startsWith("#"))
    .map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  if (functionVars.CMS_ADMIN_BUILD_REVISION !== sourceSha || functionVars.CMS_PREVIEW_SERIALIZER_READY !== "true" ||
      functionVars.CMS_PREVIEW_RENDERER_SHA !== env.CMS_DEV_RENDERER_SOURCE_SHA) refuse();
  Object.assign(functionVars, binding);
  Object.assign(api.vars, Object.fromEntries(Object.entries(binding).filter(([key]) => key.startsWith("CMS_READER_"))));
  onPhase("candidate-preflight");
  const inputs = {}, deploymentInputs = {};
  for (const component of ["functions", "cmsApi"]) {
    inputs[component] = { component, sourceSha, trustedWorkflowSha: env.GITHUB_WORKFLOW_SHA,
      runId: env.GITHUB_RUN_ID, runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
      previewRendererSha: env.CMS_DEV_RENDERER_SOURCE_SHA,
      inputFingerprint: await fingerprintInputs(sourceSha, component, { cwd: fileURLToPath(root) }),
      configurationFingerprint: configurationFingerprint(Object.fromEntries(Object.entries(component === "functions" ? functionVars : api.vars)
        .map(([key, value]) => [key, JSON.stringify(value)]))) };
    deploymentInputs[component] = await fingerprint(sourceSha, [...RECEIPT_INPUT_PATHS[component], "firebase.dev.json",
      "scripts/lib/repository-identity.mjs",
      "scripts/deploy-dev-reader-mounts.mjs", "scripts/deploy-dev-functions.mjs", "scripts/assert-dev-cms-targets.mjs",
      "scripts/lib/cms-enabled-reader-provider.mjs", "scripts/lib/cms-reader-provider-readback.mjs",
      ".github/workflows/cms-dev-deploy.yml", "site/scripts/public-release-installed-consumer-owner.ts",
      "site/scripts/public-release-installed-consumer-provider.ts", "site/scripts/public-release-installed-consumer-contract.ts"], { cwd: fileURLToPath(root) });
    if ((await candidateReceiptRef(firestore, inputs[component]).get()).exists) refuse();
  }
  try {
    writeFileSync(dotenvPath, `${Object.entries(functionVars).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
    writeFileSync(apiPath, `${JSON.stringify(api, null, 2)}\n`);
    assertDevConfigs(root, { ...env, ...binding });
    for (const input of Object.values(inputs)) {
      onPhase(`receipts-start-${input.component}`);
      await startReceipt(firestore, input);
      await startCandidateReceipt(firestore, input);
    }
    onPhase("functions-deploy");
    await deployFunctions({ env: { ...env, ...binding }, root });
    onPhase("api-deploy");
    await deployApi();
    const collect = async component => (await readProviders({ binding, apiVars: api.vars }))[component];
    for (const input of Object.values(inputs)) {
      onPhase(`verify-complete-${input.component}`);
      const candidate = await verifyCandidateReceipt(firestore, input, { collect });
      await completeReceipt(firestore, { ...input, providerIdentities: candidate.mutation.providerIdentities });
    }
    // Same original owner used by bridge install; no substitute receipt writer.
    for (const input of Object.values(inputs)) {
      onPhase(`reader-receipt-${input.component}`);
      await commitLiveReaderReceipt(firestore, { ...input, supported }, { collect });
    }
    onPhase("descriptor-readback");
    const descriptor = await mount.readCmsReaderMountDescriptor({ firestore, environment: binding });
    onPhase("installed-public-consumer-probe");
    const { require: typedRequire } = createRequire(new URL("../site/package.json", import.meta.url))("tsx/cjs/api");
    const { readInstalledPublicReleaseConsumerDeployment } = typedRequire("../site/scripts/public-release-installed-consumer-owner.ts", import.meta.url);
    const publicConsumers = await readInstalledPublicReleaseConsumerDeployment({ firestore, environment: "development", sourceSha,
      provider: consumerProvider, cwd: fileURLToPath(root) });
    return { schemaVersion: 1, projectId: "njpbs-site-dev", sourceSha, operationId: descriptor.operationId,
      candidates: { functions: binding.CMS_READER_BRIDGE_FUNCTIONS_CANDIDATE, cmsApi: binding.CMS_READER_BRIDGE_CMS_API_CANDIDATE },
      readers: descriptor.readers, identities: descriptor.identities, deploymentInputs, publicConsumers };
  } finally {
    writeFileSync(dotenvPath, dotenv); writeFileSync(apiPath, apiBytes);
  }
}

export function assertDevReaderCheckout(env, root = new URL("../", import.meta.url)) {
  const sourceSha = devDeploySourceSha(env);
  const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  if (git(["rev-parse", "HEAD"]).trim() !== sourceSha ||
       !assertDevelopmentSource(fileURLToPath(root), env, { allowedChanges: ["functions/package.json", "functions/.env.njpbs-site-dev"] })) refuse();
  const expectedPackage = JSON.parse(git(["show", `${sourceSha}:functions/package.json`]));
  expectedPackage.main = "dev-index.js";
  if (JSON.stringify(JSON.parse(readFileSync(new URL("functions/package.json", root), "utf8"))) !== JSON.stringify(expectedPackage)) refuse();
  const expectedEnv = renderCommittedDeploymentSource("functions/.env.njpbs-site-dev",
    git(["show", `${sourceSha}:functions/.env.njpbs-site-dev`]), env, readDeploymentManifest(fileURLToPath(root))) +
    `CMS_ADMIN_BUILD_REVISION=${sourceSha}\nCMS_PUBLISH_GITHUB_TRUSTED_ACTORS=${env.CMS_PUBLISH_GITHUB_TRUSTED_ACTORS}\n` +
    Object.entries(devPublicationIdentity(env)).map(([key, value]) => `${key}=${value}\n`).join("") +
    `CMS_PREVIEW_SERIALIZER_READY=true\nCMS_PREVIEW_RENDERER_SHA=${env.CMS_DEV_RENDERER_SOURCE_SHA}\n`;
  if (readFileSync(new URL("functions/.env.njpbs-site-dev", root), "utf8") !== expectedEnv) refuse();
  // Discovery and runtime must use the same default-off cloud wake artifact.
  const wake = JSON.parse(readFileSync(new URL("functions/cloud-publication-wake.generated.json", root), "utf8"));
  if (JSON.stringify(wake) !== JSON.stringify({ schemaVersion: 1, environment: "development", enabled: false })) refuse();
}

async function main() {
  let app, phase = "authorize";
  try {
    const env = process.env;
    assertDevReaderContext(env);
    if (process.argv.length !== 3 || !process.argv[2].startsWith("/") || process.env.FIRESTORE_EMULATOR_HOST) refuse();
    phase = "checkout";
    assertDevReaderCheckout(env);
    phase = "artifact-preflight";
    if (existsSync(process.argv[2])) refuse();
    phase = "initialize-sdk";
    // OIDC ADC is selected only after exact development/workflow authorization.
    app = initializeApp({ projectId: "njpbs-site-dev", credential: applicationDefault() }, "dev-reader-deployment");
    const firestore = getFirestore(app);
    const require = createRequire(import.meta.url);
    const { GoogleAuth } = require("google-auth-library");
    const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
    const readProviders = options => readDevReaderDeploymentProviders({ ...options, env,
      readGoogleToken: async () => (await auth.getClient()).getAccessToken().then(result => result.token),
      readCloudflareToken: async () => env.CLOUDFLARE_API_TOKEN });
    const result = await deployDevReaders({ env, firestore, readProviders, onPhase: value => { phase = value; } });
    phase = "write-artifact";
    writeFileSync(process.argv[2], `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log("Dev reader deployments verified; original install proofs and selectors unchanged");
  } catch {
    console.error(`Dev reader deployment refused at ${phase}; preserve original run/candidate evidence for reconciliation`); process.exitCode = 1;
  } finally { if (app) await deleteApp(app); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
