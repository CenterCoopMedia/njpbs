import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from "vitest";
import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { retainedSourceFixture } from "../helpers/cms-reader-retained-sources";
import { nativeReaderHttp } from "../helpers/cms-reader-native-http";
import { DEV_TARGETS } from "../../scripts/assert-dev-cms-targets.mjs";
import { createReaderInstallAdapter } from "../../scripts/lib/cms-reader-first-install-adapter.mjs";
import { readCmsReaderProviderIdentities } from "../../scripts/lib/cms-reader-provider-readback.mjs";
import { proveCmsReaderBridge, installCmsReaderBridge, FIRST_INSTALL_STAGE, prepareInstalledCmsReaderConsumers } from "../../scripts/lib/cms-reader-bridge-install.mjs";
import { commitLiveReaderReceipt } from "../../scripts/lib/cms-component-receipt.mjs";
import { buildReaderInstallAdapter } from "../../scripts/build-cms-reader-install-adapter.mjs";
const require = createRequire(import.meta.url);
const cms = require("../../functions/lib/cms-preview-pair.js");
const source = require("../../functions/lib/cms-reader-retained-replies.js");
let app: any, db: any, fixture: any, config: any, http: any;
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) throw new Error("Local emulator only");
  app = initializeApp({ projectId: "njpbs-site-dev" }, "reader-first-install-adapter-emulator"); db = getFirestore(app);
});
afterAll(async () => { await db?.terminate(); if (app) await deleteApp(app); });
afterEach(async () => { await http?.close(); http = undefined; });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/njpbs-site-dev/databases/(default)/documents`, { method: "DELETE" });
  fixture = await retainedSourceFixture(db);
  const { sourceBodyDigest } = await source.captureRetainedReaderReplySources({ firestore: db, ...fixture, now: () => fixture.now });
  config = { schemaVersion: 1, projectId: db.projectId, sourceBodyDigest, readerOperationId: "reader-first-a", bridgeOperationId: "reader-first-a",
    accountId: DEV_TARGETS.CLOUDFLARE_ACCOUNT_ID, candidates: fixture.candidates, consumerStage: FIRST_INSTALL_STAGE };
});
function providerFetch(url: string | URL | Request) {
  const target = String(url);
  if (target === "https://cloudfunctions.googleapis.com/v2/projects/njpbs-site-dev/locations/us-central1/functions?pageSize=100") return Promise.resolve(Response.json({ functions: fixture.functionsInventory }));
  if (target === `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/workers/scripts/template-dev-cms-api/deployments`) return Promise.resolve(Response.json({ success: true, result: { deployments: [fixture.apiDeployment] } }));
  throw new Error("Unknown provider fixture URL");
}
const providers = () => readCmsReaderProviderIdentities({ ...config, readCloudflareToken: async () => "fixture-cloudflare", readGoogleToken: async () => "fixture-google", fetchImpl: providerFetch });
const open = (settings = config) => createReaderInstallAdapter({ firestore: db, config: settings, readProviders: providers,
  readStaffToken: async () => "fixture-staff", readEdgeSecret: async () => "fixture-edge" });
async function proveAndInstall(adapter: any, request: any) {
  http ??= await nativeReaderHttp(db, fixture, config);
  const common = { ...adapter, firestore: db, request };
  const proof = await proveCmsReaderBridge({ ...common, transport: http.transport(adapter.targets) });
  const installed = await installCmsReaderBridge({ ...common, commitReader: commitLiveReaderReceipt });
  return { proof, installed };
}
it("starts with no proof, installs Stage A's 56 responses/four refusals and derives Stage B only after OLD-preserving conversion", async () => {
  expect((await db.collection("cmsReaderBridgeInstalledProofs").get()).empty).toBe(true);
  const adapter = await open();
  const a = await adapter.prepareRequest({ operationId: "reader-first-a", stage: FIRST_INSTALL_STAGE });
  expect(a.cases).toHaveLength(28); expect(a.refusals).toHaveLength(2);
  const resultA = await proveAndInstall(adapter, a);
  expect(resultA.proof.results).toHaveLength(56); expect(resultA.proof.refusals).toHaveLength(4);
  await expect(prepareInstalledCmsReaderConsumers({ firestore: db, operationId: a.operationId, readProviders: providers,
    assertStateInTransaction: adapter.assertStateInTransaction })).rejects.toThrow();
  await db.doc(cms.SELECTOR_PATH).update({ phase: "paused" });
  const bootstrapRequest = { oldPairId: fixture.previewPairs[0].pairId, newPairId: fixture.previewPairs[1].pairId,
    expectedRuntimeDigest: cms.digest((await db.doc(cms.SELECTOR_PATH).get()).data()) };
  const guard = await adapter.prepareInstalledConsumers({ request: bootstrapRequest });
  expect(await db.runTransaction((transaction: any) => guard.assertCurrentInTransaction({ transaction }), { readOnly: true })).toBe(guard.digest);
  await db.doc("system/publicDeployment").set(fixture.convertedRoot);
  await db.doc(cms.SELECTOR_PATH).set(fixture.convertedPreview);
  await expect(db.runTransaction((transaction: any) => guard.assertCurrentInTransaction({ transaction }), { readOnly: true })).rejects.toThrow();
  const bAdapter = await open({ ...config, bridgeOperationId: "reader-first-b", consumerStage: "public-converted" });
  const b = await bAdapter.prepareRequest({ operationId: "reader-first-b" });
  expect(b.cases).toHaveLength(36); expect(b.stage).toBeUndefined();
  expect((await db.doc("cmsReaderBridgeInstalledProofs/reader-first-b").get()).exists).toBe(false);
  expect((await db.doc(`cmsReaderBridgeInstalledProofs/${a.operationId}`).get()).data()).toEqual(resultA.installed);
});
it("proves all 72 Stage B responses and installs with the native writer without assuming an existing installed reader proof", async () => {
  await db.doc("system/publicDeployment").set(fixture.convertedRoot);
  await db.doc(cms.SELECTOR_PATH).set(fixture.convertedPreview);
  await db.doc("system/noBuildPostAdmission").update({ revision: 2 });
  const fresh = await source.captureRetainedReaderReplySources({ firestore: db, ...fixture, now: () => fixture.now });
  expect((await db.collection("cmsReaderBridgeInstalledProofs").get()).empty).toBe(true);
  const adapter = await open({ ...config, ...fresh, bridgeOperationId: "reader-first-b", consumerStage: "public-converted" });
  const request = await adapter.prepareRequest({ operationId: "reader-first-b" });
  for (const row of request.cases) {
    if (row.feature === "publicCode" && row.scope.endsWith("New")) expect(row.body.selection.pair.commitSha).toBe(fixture.newPair.commitSha);
    if (row.feature !== "publicCode") expect(row.body.retained.sourcePair.commitSha).toBe(fixture.oldPair.commitSha);
  }
  const result = await proveAndInstall(adapter, request);
  expect(result.proof.results).toHaveLength(72);
  expect(result.installed.proof.operationId).toBe("reader-first-b");
});
it("ignores caller expectations and repeats native source/candidate authority in the original late SDK transaction", async () => {
  const adapter = await open();
  const request = await adapter.prepareRequest({ operationId: "reader-first-a", stage: FIRST_INSTALL_STAGE });
  const forged = structuredClone(request);
  forged.cases.forEach((row: any) => { row.expected.bodyDigest = "0".repeat(64); });
  const original = await adapter.readRetainedCases(forged);
  expect(original.cases.every((row: any) => row.expected.bodyDigest !== "0".repeat(64))).toBe(true);
  expect(await db.runTransaction((transaction: any) => adapter.assertStateInTransaction({ transaction, request }), { readOnly: true })).toBe(request.expectedStateDigest);
  await db.doc("cmsSettings/public-site-chrome").update({ "published.values.newsletterLabel": "Changed after preparation" });
  await expect(db.runTransaction((transaction: any) => adapter.assertStateInTransaction({ transaction, request }), { readOnly: true })).rejects.toThrow();
  expect((await db.collection("cmsReaderBridgeInstalledProofs").get()).empty).toBe(true);
});
it("builds and imports the verified single-file production entry without fetching any credential or requiring an installed proof", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reader-adapter-bundle-"));
  try {
    const built = await buildReaderInstallAdapter(config, join(directory, "adapter.mjs"));
    const bytes = readFileSync(built.adapterPath);
    const module = await import(`data:text/javascript;base64,${bytes.toString("base64")}`);
    expect(typeof module.prepareInstalledConsumers).toBe("function");
    const adapter = await module.openBridgeInstallAdapter({ firestore: db });
    try {
      const request = await adapter.prepareRequest({ operationId: "reader-first-a", stage: FIRST_INSTALL_STAGE });
      expect(request.cases).toHaveLength(28); expect(request.refusals).toHaveLength(2);
    } finally { adapter.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
it("binds the parent provider pipes before SDK initialization and refuses an undeclared bootstrap CLI descriptor", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reader-bundle-credential-boundary-"));
  try {
    const built = await buildReaderInstallAdapter(config, join(directory, "adapter.mjs"));
    const fixturePath = join(directory, "provider.json"), childPath = join(directory, "child.mjs"), inputPath = join(directory, "identity.json");
    writeFileSync(fixturePath, JSON.stringify({ functions: fixture.functionsInventory, deployment: fixture.apiDeployment,
      expected: Object.fromEntries(Object.entries(fixture.readers).map(([component, value]: any) => [component, value.providerIdentities])) }));
    writeFileSync(inputPath, "{}");
    writeFileSync(childPath, `
import {readFileSync} from 'node:fs'; import {createRequire} from 'node:module'; import {isDeepStrictEqual} from 'node:util';
let app, adapter, close, deleteApp;
try {
  const bytes=readFileSync(process.argv[2]); const fixture=JSON.parse(readFileSync(process.argv[3]));
  const module=await import('data:text/javascript;base64,'+bytes.toString('base64'));
  close=module.prepareCredentialPipes({purpose:'preview-bootstrap'});
  const require=createRequire(process.argv[4]);
  const sdk=require('firebase-admin/app'); deleteApp=sdk.deleteApp;
  app=sdk.initializeApp({projectId:'njpbs-site-dev'},'compiled-pipe-boundary');
  globalThis.fetch=async(url,init)=> {
    if(String(url).startsWith('https://cloudfunctions.googleapis.com/v2/projects/njpbs-site-dev/locations/us-central1/functions?') && init.headers.authorization==='Bearer fixture-google') return Response.json({functions:fixture.functions});
    if(String(url).startsWith('https://api.cloudflare.com/client/v4/accounts/') && String(url).endsWith('/workers/scripts/template-dev-cms-api/deployments') && init.headers.authorization==='Bearer fixture-cloudflare') return Response.json({success:true,result:{deployments:[fixture.deployment]}});
    throw new Error('Provider fixture refused');
  };
  adapter=await module.openBridgeInstallAdapter({firestore:require('firebase-admin/firestore').getFirestore(app)});
  if(!isDeepStrictEqual(await adapter.readProviders(),fixture.expected)) throw new Error('Provider identity mismatch');
  process.stdout.write('provider-identity-matched');
} catch {process.stderr.write('Compiled credential boundary refused.');process.exitCode=1;}
finally {adapter?.close();close?.();if(app) await deleteApp(app);}
`);
    const script = `set -euo pipefail
exec 4< <(printf '%s\\n' fixture-cloudflare)
exec 12< <(printf '%s\\n' fixture-google)
CMS_READER_CREDENTIAL_PIPES="$("$1" "$2" 4 12)"
export CMS_READER_CREDENTIAL_PIPES
"$1" "$3" "$4" "$5" "$6"
`;
    const result = spawnSync("bash", ["-c", script, "reader-pipe-boundary", process.execPath,
      join(process.cwd(), "scripts/describe-cms-reader-credential-pipes.mjs"), childPath, built.adapterPath, fixturePath,
      new URL("../../package.json", import.meta.url).href], { env: { ...process.env }, encoding: "utf8", timeout: 5000 });
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toBe("provider-identity-matched");
    const env = { ...process.env }; delete env.CMS_READER_CREDENTIAL_PIPES;
    const refused = spawnSync(process.execPath, ["scripts/bootstrap-cms-preview-pair.cjs", "plan", "demo-reader-fd-boundary", inputPath,
      built.adapterPath, built.sha256], { cwd: process.cwd(), env, encoding: "utf8", timeout: 5000 });
    expect(refused.status).toBe(1); expect(refused.stdout).toBe(""); expect(refused.stderr).toContain("operation-refused");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
