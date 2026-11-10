#!/usr/bin/env node
import { assertDevelopmentSource } from "./render-development-config.mjs";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cert, initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import mount from "../functions/lib/cms-reader-mount-descriptor.js";
import cms from "../functions/lib/cms-preview-pair.js";
import { fingerprintInputs, fingerprintPaths, RECEIPT_INPUT_PATHS, configurationFingerprint, startReceipt, startCandidateReceipt,
  candidateReceiptRef, verifyCandidateReceipt, completeReceipt, commitLiveReaderReceipt } from "./lib/cms-component-receipt.mjs";
import { readEnabledCmsReaderProviders } from "./lib/cms-enabled-reader-provider.mjs";

import { productionReaderBinding } from "./lib/production-reader-authorization.mjs";
export { productionReaderBinding } from "./lib/production-reader-authorization.mjs";
const refuse = () => { throw new Error("Production reader deployment refused; preserve the original run for reconciliation"); };
const supported = { previewRequest: [1], postChrome: [1], settings: [1], capabilities: [1], adminSession: [1, 2] };

const dotenv = bytes => Object.fromEntries(bytes.split(/\r?\n/).filter(line => line && !line.startsWith("#"))
  .map(line => { const index = line.indexOf("="); if (index < 1) refuse(); return [line.slice(0, index), line.slice(index + 1)]; }));

export function configureProductionReaders({ component, env, root = new URL("../", import.meta.url) }) {
  const binding = productionReaderBinding(env);
  if (!binding || !["functions", "cmsApi"].includes(component)) refuse();
  const path = new URL(component === "functions" ? "functions/.env.njpbs-site" : "cms-api/wrangler.jsonc", root);
  const original = readFileSync(path, "utf8");
  if (component === "functions") {
    const vars = dotenv(original);
    if (vars.CMS_DEPLOYMENT_ENVIRONMENT !== "production" || vars.CMS_ADMIN_BUILD_REVISION !== env.DEPLOY_SHA ||
        vars.CMS_PREVIEW_SERIALIZER_READY !== "true" || !/^[a-f0-9]{40}$/.test(vars.CMS_PREVIEW_RENDERER_SHA ?? "")) refuse();
    Object.assign(vars, binding);
    writeFileSync(path, `${Object.entries(vars).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
  } else {
    const api = JSON.parse(original);
    if (api.name !== "njpbs-cms-api" || api.vars?.FIREBASE_PROJECT_ID !== "njpbs-site" ||
        api.vars?.FUNCTIONS_ORIGIN !== "https://us-central1-njpbs-site.cloudfunctions.net" ||
        api.routes?.length !== 1 || api.routes[0].pattern !== "api.example.org" || api.routes[0].custom_domain !== true) refuse();
    Object.assign(api.vars, Object.fromEntries(Object.entries(binding).filter(([key]) => key.startsWith("CMS_READER_"))));
    writeFileSync(path, `${JSON.stringify(api, null, 2)}\n`);
  }
  return binding;
}

export async function productionReaderInput({ component, env, root = new URL("../", import.meta.url) }) {
  if (!productionReaderBinding(env) || !["functions", "cmsApi"].includes(component)) refuse();
  const vars = component === "functions" ? dotenv(readFileSync(new URL("functions/.env.njpbs-site", root), "utf8")) :
    JSON.parse(readFileSync(new URL("cms-api/wrangler.jsonc", root), "utf8")).vars;
  return { component, sourceSha: env.DEPLOY_SHA, trustedWorkflowSha: env.GITHUB_WORKFLOW_SHA,
    runId: env.GITHUB_RUN_ID, runAttempt: 1, previewRendererSha: vars.CMS_PREVIEW_RENDERER_SHA,
    inputFingerprint: await fingerprintInputs(env.DEPLOY_SHA, component, { cwd: fileURLToPath(root) }),
    configurationFingerprint: configurationFingerprint(Object.fromEntries(Object.entries(vars).map(([key, value]) => [key, JSON.stringify(value)]))) };
}

const attemptRef = (db, binding) => db.doc(`cmsReaderDeploymentAttempts/${binding.CMS_READER_BRIDGE_OPERATION_ID}`);
const attemptIdentity = (env, binding) => ({ schemaVersion: 1, projectId: "njpbs-site", sourceSha: env.DEPLOY_SHA,
  runId: env.GITHUB_RUN_ID, runAttempt: 1, binding });
const assertAttempt = (stored, env, binding) => {
  if (cms.digest(stored ?? null) !== cms.digest(attemptIdentity(env, binding))) refuse();
};

async function assertProductionReaderStart({ firestore, component, env, binding, tx }) {
  const input = { component, runId: env.GITHUB_RUN_ID, runAttempt: 1 };
  const ref = attemptRef(firestore, binding);
  const [attempt, proof, candidate, legacy, functionsCandidate, functionsLegacy] = await tx.getAll(ref,
    firestore.doc(`cmsReaderBridgeInstalledProofs/${binding.CMS_READER_BRIDGE_OPERATION_ID}`), candidateReceiptRef(firestore, input),
    firestore.doc(`cmsDeploymentReceipts/${component}`), firestore.doc(`cmsDeploymentCandidates/${binding.CMS_READER_BRIDGE_FUNCTIONS_CANDIDATE}`),
    firestore.doc("cmsDeploymentReceipts/functions"));
  if (proof.exists || candidate.exists || legacy.data()?.state === "in_progress") refuse();
  if (component === "functions") {
    if (attempt.exists) refuse();
  } else {
    assertAttempt(attempt.data(), env, binding);
    const candidate = functionsCandidate.data(), complete = functionsLegacy.data();
    if (candidate?.state !== "verified" || complete?.state !== "complete" ||
        [candidate, complete].some(row => row.mutation?.sourceSha !== env.DEPLOY_SHA ||
          row.mutation?.runId !== env.GITHUB_RUN_ID || row.mutation?.runAttempt !== 1) ||
        ["inputFingerprint", "configurationFingerprint", "providerIdentities"].some(key =>
          cms.digest(candidate.mutation[key]) !== cms.digest(complete.mutation[key]))) refuse();
  }
}

// The same SDK refusals run before the native renderer receipt and admission
// pause. Refusing a reused operation must not first take previews offline.
export async function preflightProductionReader({ firestore, component, env }) {
  const binding = productionReaderBinding(env);
  if (!binding || firestore?.projectId !== "njpbs-site" || !["functions", "cmsApi"].includes(component)) refuse();
  await firestore.runTransaction(tx => assertProductionReaderStart({ firestore, component, env, binding, tx }), { readOnly: true });
}

export async function startProductionReader({ firestore, component, env, root }) {
  const binding = configureProductionReaders({ component, env, root });
  if (firestore?.projectId !== "njpbs-site") refuse();
  const input = await productionReaderInput({ component, env, root });
  await firestore.runTransaction(async tx => {
    await assertProductionReaderStart({ firestore, component, env, binding, tx });
    if (component === "functions") tx.create(attemptRef(firestore, binding), attemptIdentity(env, binding));
  });
  await startReceipt(firestore, input);
  await startCandidateReceipt(firestore, input);
  return input;
}

export async function completeProductionReader({ firestore, component, env, root, readProviders }) {
  const binding = productionReaderBinding(env);
  if (!binding || firestore?.projectId !== "njpbs-site") refuse();
  assertAttempt((await attemptRef(firestore, binding).get()).data(), env, binding);
  const input = await productionReaderInput({ component, env, root });
  const collect = async name => (await readProviders({ binding, apiVars: component === "cmsApi" ?
    JSON.parse(readFileSync(new URL("cms-api/wrangler.jsonc", root), "utf8")).vars : undefined }))[name];
  const candidate = await verifyCandidateReceipt(firestore, input, { collect });
  await completeReceipt(firestore, { ...input, providerIdentities: candidate.mutation.providerIdentities });
  await commitLiveReaderReceipt(firestore, { ...input, supported }, { collect });
}

export async function readProductionReaderResult({ firestore, env, root = new URL("../", import.meta.url), consumerProvider }) {
  const binding = productionReaderBinding(env);
  if (!binding || firestore?.projectId !== "njpbs-site") refuse();
  assertAttempt((await attemptRef(firestore, binding).get()).data(), env, binding);
  const descriptor = await mount.readCmsReaderMountDescriptor({ firestore, environment: binding });
  const { require: typedRequire } = createRequire(new URL("../site/package.json", import.meta.url))("tsx/cjs/api");
  const { readInstalledPublicReleaseConsumerDeployment } = typedRequire("../site/scripts/public-release-installed-consumer-owner.ts", import.meta.url);
  const publicConsumers = await readInstalledPublicReleaseConsumerDeployment({ firestore, environment: "production",
    sourceSha: env.DEPLOY_SHA, provider: consumerProvider, cwd: fileURLToPath(root) });
  const deploymentInputs = {};
  for (const component of ["functions", "cmsApi"]) deploymentInputs[component] = await fingerprintPaths(env.DEPLOY_SHA,
    [...RECEIPT_INPUT_PATHS[component], ".github/workflows/cms-staging-deploy.yml", "scripts/production-reader-deployment.mjs",
      "scripts/lib/repository-identity.mjs",
      "scripts/lib/production-reader-authorization.mjs", "scripts/lib/cms-enabled-reader-provider.mjs",
      "scripts/lib/cms-reader-provider-readback.mjs", "scripts/lib/cms-component-receipt.mjs",
      "site/scripts/public-release-installed-consumer-owner.ts", "site/scripts/public-release-installed-consumer-provider.ts"], { cwd: fileURLToPath(root) });
  return { schemaVersion: 1, projectId: "njpbs-site", sourceSha: env.DEPLOY_SHA, ...descriptor, deploymentInputs, publicConsumers };
}

async function main() {
  let app;
  try {
    const env = process.env, [command, component, artifact] = process.argv.slice(2);
    const binding = productionReaderBinding(env);
    if (command === "authorize") return;
    if (!binding || !["preflight", "start", "complete"].includes(command) || !["functions", "cmsApi"].includes(component) ||
        env.FIRESTORE_EMULATOR_HOST || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== env.DEPLOY_SHA ||
        !assertDevelopmentSource(fileURLToPath(new URL("../", import.meta.url)), env, { allowedChanges: ["cms-api/wrangler.jsonc"],
          trustedCopies: { "scripts/cms-function-deploy-runner.mjs": "scripts/deploy-cms-function-batches.mjs" } })) refuse();
    const credential = JSON.parse(env.GOOGLE_APPLICATION_CREDENTIALS ? readFileSync(env.GOOGLE_APPLICATION_CREDENTIALS, "utf8") : env.CMS_PREVIEW_FIREBASE_ACCOUNT);
    if (credential.project_id !== "njpbs-site") refuse();
    app = initializeApp({ projectId: "njpbs-site", credential: cert(credential) }, "production-reader-deployment");
    const firestore = getFirestore(app), root = new URL("../", import.meta.url);
    if (command === "preflight") await preflightProductionReader({ firestore, component, env });
    else if (command === "start") await startProductionReader({ firestore, component, env, root });
    else {
      const { GoogleAuth } = createRequire(import.meta.url)("google-auth-library");
      const auth = new GoogleAuth({ credentials: credential, scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
      const readGoogleToken = async () => (await auth.getClient()).getAccessToken().then(result => result.token);
      const readProviders = options => readEnabledCmsReaderProviders({ ...options, projectId: "njpbs-site", accountId: env.CLOUDFLARE_ACCOUNT_ID,
        sourceSha: env.DEPLOY_SHA, readGoogleToken,
        readCloudflareToken: async () => env.CLOUDFLARE_API_TOKEN });
      await completeProductionReader({ firestore, component, env, root, readProviders });
      if (component === "cmsApi") {
        if (!artifact?.startsWith("/")) refuse();
        const { require: typedRequire } = createRequire(new URL("../site/package.json", import.meta.url))("tsx/cjs/api");
        const { createInstalledConsumerProvider } = typedRequire("../site/scripts/public-release-installed-consumer-provider.ts", import.meta.url);
        const result = await readProductionReaderResult({ firestore, env, root,
          consumerProvider: createInstalledConsumerProvider({ environment: "production", readGoogleToken }) });
        writeFileSync(artifact, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      }
    }
  } catch {
    console.error("Production reader deployment refused; preserve original run/candidate evidence for reconciliation");
    process.exitCode = 1;
  } finally { if (app) await deleteApp(app); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
