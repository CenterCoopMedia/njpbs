import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, writeFile, lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fingerprintInputs, fingerprintFunctionGraph, fingerprintPaths } from "./cms-component-receipt.mjs";

const require = createRequire(import.meta.url);
const targets = require("../../functions/lib/publication-target.js");
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const CONTRACT_BUDGET_MS = 240_000;
export const CONTRACT_ATTEMPTS = 2;
export const CONTRACT_SETTINGS = Object.freeze(["site-navigation", "public-site-chrome", "nj-decides-brand", "public-homepage-banner", "coverage-labels"]);
export const CONTRACT_FEATURES = Object.freeze(["settings", "postChrome", "capabilities", "previewRequest", "adminSession"]);
const PROOF_PATHS = ["scripts/lib/cms-public-contract.mjs", "scripts/check-cms-public-contract.mjs", "scripts/cms-public-contract-runtime.Dockerfile", "tests/functions/cms-public-contract.test.ts",
  ".github/workflows/cms-staging-deploy.yml", ".github/workflows/cms-dev-deploy.yml", "firebase.dev.json", "cms-api/wrangler.dev.jsonc", "preview-renderer/wrangler.dev.jsonc"];
const PRIVATE_LIMIT = 16 * 1024 * 1024;
const CREDENTIAL_KEYS = new Set(["authorization", "cookie", "password", "private_key", "secretAccessKey", "accessKeyId", "refreshToken", "idToken", "accessToken", "client_secret"]);
const DIRECT_WRITE_OWNERS = new Set(["lib/editor-lock-store.ts", "lib/control-presentation-store.ts", "lib/home-shortcuts-store.ts",
  "lib/media-collection-pins-store.ts", "lib/saved-content-view-store.ts", "lib/saved-media-view-store.ts"]);
const FIRESTORE_READ_IMPORTS = new Set(["collection", "doc", "documentId", "getDoc", "getDocFromServer", "getDocs", "limit", "onSnapshot", "query", "where",
  "getFirestore", "connectFirestoreEmulator", "deleteField", "serverTimestamp", "Timestamp", "orderBy"]);

// Existing preference and editor-lock owners keep their rules boundary. A new
// SDK writer cannot hide among read imports or become a public-content writer.
export async function discoverAdminWrites({ candidateRoot, baselineRoot }) {
  const ts = createRequire(join(candidateRoot, "package.json"))("typescript");
  const owners = [];
  async function visit(relative = "") {
    for (const entry of await readdir(join(candidateRoot, "admin/src", relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isSymbolicLink()) refuse("admin-write-unclassified");
      if (entry.isDirectory()) { await visit(path); continue; }
      if (!/\.tsx?$/.test(path)) continue;
      const text = await readFile(join(candidateRoot, "admin/src", path), "utf8");
      const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
      let writes = false;
      function walk(node) {
        if ((ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isExportDeclaration(node)) &&
            node.getText(ast).includes("firebase/firestore")) refuse("admin-write-unclassified");
        if (ts.isImportDeclaration(node) && node.moduleSpecifier.text?.startsWith("firebase/firestore")) {
          const clause = node.importClause;
          if (!clause?.isTypeOnly) {
            if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) refuse("admin-write-unclassified");
            for (const item of clause.namedBindings.elements) {
              if (item.isTypeOnly) continue;
              const name = (item.propertyName ?? item.name).text;
              if (["setDoc", "updateDoc", "addDoc", "deleteDoc", "writeBatch", "runTransaction"].includes(name)) writes = true;
              else if (!FIRESTORE_READ_IMPORTS.has(name)) refuse("admin-write-unclassified");
            }
          }
        }
        ts.forEachChild(node, walk);
      }
      walk(ast);
      if (writes) {
        if (!DIRECT_WRITE_OWNERS.has(path) || await readFile(join(baselineRoot, "admin/src", path), "utf8").catch(() => null) !== text) refuse("admin-write-unclassified");
        owners.push(path);
      }
    }
  }
  await visit();
  if (owners.length !== DIRECT_WRITE_OWNERS.size) refuse("admin-write-unclassified");
  return owners.sort();
}

export class CmsPublicContractError extends Error {
  constructor(code) { super("CMS public contract refused"); this.code = code; }
}
export function refuse(code) { throw new CmsPublicContractError(code); }

export function contractDigest(value) {
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function contractTarget(environment, env = {}, target = targets.publicationTarget(environment)) {
  if (env.FIREBASE_PROJECT_ID !== undefined && env.FIREBASE_PROJECT_ID !== target.projectId ||
      env.CMS_DEPLOYMENT_ENVIRONMENT !== undefined && env.CMS_DEPLOYMENT_ENVIRONMENT !== environment ||
      Object.entries(env).some(([key, value]) => /EMULATOR/.test(key) && value !== undefined)) refuse("capture-target");
  return { ...target, databaseId: "(default)", apiWorker: environment === "production" ? "njpbs-cms-api" : env.CMS_DEV_API_WORKER ?? "template-dev-cms-api",
    previewWorker: environment === "production" ? "njpbs-cms-preview-renderer" : env.CMS_DEV_PREVIEW_RENDERER ?? "template-dev-cms-preview-renderer",
    adminOrigin: environment === "production" ? "https://admin.njpbs.org" : env.CMS_DEV_ADMIN_ORIGIN ?? "https://dev-admin.example.org" };
}

export function assertUnchangedPlan(plan) {
  if (!plan || plan.abort !== false || plan.releaseReason !== "unchanged" || plan.functionsMutated !== false ||
      plan.previewPaused !== false || plan.configurationRequiresRelease !== false || plan.apiMutated !== false ||
      plan.rulesMutated !== false || plan.indexesMutated !== false || plan.rendererMutated !== false ||
      plan.functionDeployTargets !== "") refuse("plan-not-unchanged");
  return plan;
}

export function devMutationSelection({ plan, proved, publishingEnabled, rendererOnly, rendererRelease, readerInstall }) {
  const independent = proved === true && plan?.releaseReason === "unchanged";
  if (independent) {
    assertUnchangedPlan(plan);
    if (publishingEnabled !== "true" || rendererOnly || rendererRelease || readerInstall) refuse("dev-independent-mode");
    return { independent: true, admin: true, backend: false, requireHold: false };
  }
  if (plan?.abort === true || publishingEnabled !== "false") refuse("dev-full-hold");
  return { independent: false, admin: true, backend: true, requireHold: true };
}

// These tagged values retain Firestore types without serializing SDK internals.
export function encodeContractValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return ["array", value.map(encodeContractValue)];
  if (!value || typeof value !== "object") refuse("capture-value");
  if (typeof value.toMillis === "function" && Number.isInteger(value.seconds) && Number.isInteger(value.nanoseconds)) return ["timestamp", value.seconds, value.nanoseconds];
  if (value instanceof Date) return ["date", value.toISOString()];
  if (Buffer.isBuffer(value)) return ["bytes", value.toString("base64")];
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) refuse("capture-value");
  return ["map", Object.keys(value).sort().map(key => {
    if (CREDENTIAL_KEYS.has(key)) refuse("capture-credential");
    return [key, encodeContractValue(value[key])];
  })];
}

export function decodeContractValue(value, { Timestamp }) {
  if (!Array.isArray(value)) return value;
  const [kind, data, nanos] = value;
  if (kind === "array") return data.map(item => decodeContractValue(item, { Timestamp }));
  if (kind === "map") return Object.fromEntries(data.map(([key, item]) => [key, decodeContractValue(item, { Timestamp })]));
  if (kind === "timestamp") return new Timestamp(data, nanos);
  if (kind === "date") return new Date(data);
  if (kind === "bytes") return Buffer.from(data, "base64");
  refuse("capture-value");
}

export async function writePrivateCapsule(file, value) {
  const bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes) > PRIVATE_LIMIT) refuse("capture-size");
  await writeFile(file, bytes, { mode: 0o600, flag: "wx" });
}
export async function readPrivateCapsule(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > PRIVATE_LIMIT) refuse("capture-private-file");
  return JSON.parse(await readFile(file, "utf8"));
}

export async function compareContractInputs({ candidateSha, baselineSha, cwd }) {
  if (![candidateSha, baselineSha].every(sha => SHA.test(sha))) refuse("source-unavailable");
  const source = async sha => {
    const [functions, cmsApi, graph, proof] = await Promise.all([
      fingerprintInputs(sha, "functions", { cwd }), fingerprintInputs(sha, "cmsApi", { cwd }),
      fingerprintFunctionGraph(sha, { cwd }), fingerprintPaths(sha, PROOF_PATHS, { cwd }),
    ]);
    return { functions, cmsApi, graph, proof };
  };
  const [candidate, baseline] = await Promise.all([source(candidateSha), source(baselineSha)]);
  if (!isDeepStrictEqual(candidate, baseline)) refuse("backend-inputs-changed");
  return candidate;
}

export function contractIdentity(state, target) {
  const { publicReader: reader, backend, priorAdminSha } = state ?? {};
  if (!SHA.test(priorAdminSha ?? "") || !reader || !SHA.test(reader.rendererSha ?? "") ||
      !UUID.test(reader.versionId ?? "") || reader.percentage !== 100 || reader.worker !== target.workerName ||
      !DIGEST.test(reader.artifactDigest ?? "") || !DIGEST.test(reader.checkpointDigest ?? "") ||
      !Number.isSafeInteger(reader.codeGeneration) || reader.codeGeneration < 1 ||
      !backend || !Array.isArray(backend.functions) || !backend.functions.length ||
      !DIGEST.test(backend.configurationFingerprint ?? "") || !UUID.test(backend.apiVersionId ?? "") ||
      !SHA.test(backend.previewRendererSha ?? "") || !DIGEST.test(backend.previewIdentityDigest ?? "")) refuse("identity-unavailable");
  const names = new Set();
  for (const fn of backend.functions) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(fn.name ?? "") || names.has(fn.name) || fn.state !== "ACTIVE" ||
        typeof fn.revision !== "string" || !fn.revision || !DIGEST.test(fn.inputFingerprint ?? "") ||
        !SHA.test(fn.sourceSha ?? "")) refuse("functions-inventory");
    names.add(fn.name);
  }
  if (!Array.isArray(backend.expectedExports) || !isDeepStrictEqual([...names].sort(), [...backend.expectedExports].sort())) refuse("functions-inventory");
  return { environment: target.environment, projectId: target.projectId, databaseId: target.databaseId,
    priorAdminSha, publicReader: reader, backend };
}

const allowedPath = path => /^(?:cmsSettings|cmsPages|cmsPosts|cmsPreviewHeads|cmsPreviewQueue|cmsPublishQueue|cmsAuthorProfilesPublic|cmsContentSections|media_assets|media_assets_public|cmsPublicPageRoutes|cmsPublicPostRoutes|cmsPublicRecordRoutes|cmsPublicContext|cmsPublicContextReceipts|cmsPublications|cmsPublicationSerializerJournals|cmsPublicationPins|system)\//.test(path);

export async function captureNativeContract({ firestore, baselineRoot, target, requests, identity, now = Date.now, signal }) {
  if (firestore.projectId !== target.projectId || firestore.databaseId !== target.databaseId) refuse("capture-database");
  const load = createRequire(join(resolve(baselineRoot), "package.json"));
  const settings = load("./functions/settings.js");
  const schemas = load("./functions/lib/cms-settings-contract.js");
  const preview = load("./functions/preview.js");
  const serializer = load("./functions/lib/cms-published-settings-reply.js");
  const { recordReaderSourceReads } = load("./functions/lib/cms-reader-source-readset.js");
  const { publicReleaseDigest } = load("./functions/lib/public-release-pair.js");
  return firestore.runTransaction(async tx => {
    signal?.throwIfAborted();
    const capturedAt = now();
    if (!Number.isSafeInteger(capturedAt) || capturedAt < 1) refuse("capture-clock");
    const documents = new Map();
    const completeReads = new Map();
    const captureTx = { get: async ref => {
      const row = await tx.get(ref);
      let rows = row.docs ?? [row];
      if (rows.length > 5000) refuse("capture-size");
      if (row.docs) {
        // A native query may project fields. Keep its exact query readset and
        // also retain the complete source documents needed by the real writers.
        const complete = [];
        for (let offset = 0; offset < rows.length; offset += 100) complete.push(...await tx.getAll(...rows.slice(offset, offset + 100).map(item => item.ref)));
        rows = complete;
      }
      for (const item of rows) {
        if (!allowedPath(item.ref.path)) refuse("capture-record");
        if (documents.size >= 5000) refuse("capture-size");
        documents.set(item.ref.path, item.exists ? encodeContractValue(item.data()) : null);
        if (item.ref.path !== "system/publicDeployment") completeReads.set(item.ref.path, { target: { kind: "document", path: item.ref.path, steps: [] },
          digest: publicReleaseDigest(item.exists ? item.data() : null) });
      }
      return row;
    } };
    const recorded = recordReaderSourceReads({ firestore, transaction: captureTx });
    const root = (await recorded.transaction.get(recorded.firestore.doc("system/publicDeployment"))).data();
    if (!root || root.state !== "idle" || root.schemaVersion !== 1 || root.activeCommitSha !== identity.publicReader.rendererSha ||
        root.activeGeneration !== identity.publicReader.codeGeneration) refuse("public-transition");
    for (const [family, schema] of [["Posts", 2], ["Pages", 1]]) {
      const marker = (await recorded.transaction.get(recorded.firestore.doc(`system/publicDeployment/noBuild${family}/capability`))).data();
      if (!marker || marker.schemaVersion !== schema || marker.rendererSha !== identity.publicReader.rendererSha || marker.servingEnabled !== true) refuse("capability-unavailable");
    }
    await load("./functions/lib/settings-publication.js").readPublicationPrerequisites(recorded.firestore, recorded.transaction);
    await load("./functions/lib/no-build-post-ownership.js").listNoBuildPostOwners(recorded);
    const replies = { settings: [] };
    if (!isDeepStrictEqual([...requests.settings].sort(), [...CONTRACT_SETTINGS].sort())) refuse("settings-corpus");
    for (const id of requests.settings) {
      if (settings.validateGetPublishedSettingsRequest({ id }) || !schemas.currentCmsSettingsSchemaFor(id)) refuse("settings-request");
      const document = (await recorded.transaction.get(recorded.firestore.doc(`cmsSettings/${id}`))).data();
      const reply = serializer.publishedSettingsReply({ id, document });
      if (document?.published !== undefined && reply.found !== true) refuse("settings-native-omission");
      replies.settings.push({ id, mode: id === "coverage-labels" ? "native-source-bound" : "public-projection",
        json: JSON.stringify(reply) });
    }
    const runtime = (await recorded.transaction.get(recorded.firestore.doc("system/cmsPreviewRuntime"))).data();
    if (!runtime || runtime.schemaVersion !== 1 || runtime.phase !== "ready" || runtime.rendererSha !== identity.backend.previewRendererSha) refuse("preview-runtime");
    const request = requests.previewRequest;
    if (!preview.validQueueId(request.pageId) || !["cmsPages", "cmsPosts"].includes(request.collection)) refuse("preview-request");
    const document = (await recorded.transaction.get(recorded.firestore.doc(`${request.collection}/${request.pageId}`))).data();
    if (!document || document.deleted || document.status === "archived") refuse("preview-request");
    const head = await preview.readPreviewHead(recorded.firestore, request.collection, request.pageId, recorded.transaction);
    const ready = head.ready?.data;
    const response = preview.previewHeadResponse(head, capturedAt);
    if (!ready || ready.previewPairId !== undefined || ready.transport !== preview.SERIALIZER_TRANSPORT ||
        ready.rendererSha !== runtime.rendererSha || !Number.isSafeInteger(ready.sourceVersion) || ready.sourceVersion < 1 ||
        ready.snapshot?.version !== ready.sourceVersion || response.ready?.status !== "ready" || !response.ready.previewUrl) refuse("preview-unavailable");
    replies.previewRequest = JSON.stringify(response);
    for (const [feature, module, owner] of [
      ["postChrome", "no-build-post-publication", "readNoBuildPostDecisionInTransaction"],
      ["capabilities", "no-build-page-serving", "readNoBuildPageDecisionInTransaction"],
    ]) {
      const value = await load(`./functions/lib/${module}.js`)[owner]({ ...recorded, ...requests[feature],
        target: targets.publicationTarget(target.environment), now: () => capturedAt });
      if (!(feature === "postChrome" ? ["post", "alias", "gone", "receipts"] : ["page", "context-page"]).includes(value?.kind)) refuse("native-reply-unavailable");
      if (feature === "postChrome") {
        const operationId = value.receipt?.operationId;
        if (!/^[A-Za-z0-9]{20}$/.test(operationId ?? "")) refuse("publication-source-unavailable");
        const previous = (await recorded.transaction.get(recorded.firestore.doc(`cmsPublishQueue/${operationId}`))).data();
        if (!previous) refuse("publication-source-unavailable");
        if (previous.homeFullBuild?.status === "reserved") {
          const queueId = previous.homeFullBuild.queueId;
          if (!/^[A-Za-z0-9]{20}$/.test(queueId ?? "")) refuse("publication-source-unavailable");
          await recorded.transaction.get(recorded.firestore.doc(`cmsPublishQueue/${queueId}`));
        }
      }
      replies[feature] = JSON.stringify(value);
    }
    signal?.throwIfAborted();
    return { schemaVersion: 1, identity, capturedAt, requests, replies, root: encodeContractValue(root),
      readset: [...recorded.readset(), ...completeReads.values()].sort((left, right) => contractDigest(left.target).localeCompare(contractDigest(right.target))),
      documents: [...documents].map(([path, data]) => ({ path, data })) };
  }, { readOnly: true });
}

export async function boundedContractProof(run, { now = Date.now, boundary, signal } = {}) {
  const startedAt = now();
  for (let attempt = 1; attempt <= CONTRACT_ATTEMPTS; attempt += 1) {
    const remaining = CONTRACT_BUDGET_MS - (now() - startedAt);
    if (remaining <= 0) break;
    const deadline = AbortSignal.any([AbortSignal.timeout(remaining), ...(signal ? [signal] : [])]);
    try {
      const result = await run({ attempt, signal: deadline });
      deadline.throwIfAborted();
      if (now() - startedAt >= CONTRACT_BUDGET_MS) break;
      return result;
    } catch (error) {
      if (deadline.aborted || now() - startedAt >= CONTRACT_BUDGET_MS) break;
      if (error?.code !== "capture-moved") throw error;
    }
  }
  refuse(boundary === "settlement" ? "settlement-unconfirmed" : "capture-budget");
}

export function validateReplayResult(result, { capsuleDigest, candidateSha, identityDigest }) {
  if (!result || result.schemaVersion !== 1 || result.capsuleDigest !== capsuleDigest || result.candidateSha !== candidateSha ||
      result.identityDigest !== identityDigest || !DIGEST.test(result.apiPassThroughDigest ?? "") || !Array.isArray(result.cases) || !result.cases.length ||
      result.cases.some(row => !row || row.passed !== true || !DIGEST.test(row.nativeDigest ?? "") || !DIGEST.test(row.renderedDigest ?? "")) ||
      !CONTRACT_FEATURES.every(feature => result.cases.some(row => row.feature === feature)) ||
      !["C0", "C1", "C0-after-C1"].every(writer => result.cases.some(row => row.writer === writer)) ||
      CONTRACT_SETTINGS.some(id => !result.cases.some(row => row.settingId === id))) refuse("replay-incomplete");
  const required = [["postChrome", "C1"], ["postChrome", "C0-after-C1"], ["capabilities", "C1"],
    ["previewRequest", "C1"], ["previewRequest", "C0-after-C1"], ["adminSession", "C0"], ["adminSession", "C1"],
    ...CONTRACT_SETTINGS.flatMap(id => [["settings", "C1", id], ["settings", "C0-after-C1", id]])];
  if (required.some(([feature, writer, settingId]) => !result.cases.some(row => row.feature === feature && row.writer === writer &&
      (settingId === undefined || row.settingId === settingId)))) refuse("replay-incomplete");
  return result;
}

export function contractSummary({ candidateSha, identity, capsuleDigest, replay, capturedAt, now = Date.now() }) {
  if (!SHA.test(candidateSha) || !DIGEST.test(capsuleDigest) || !Number.isSafeInteger(capturedAt) || capturedAt > now || now - capturedAt >= CONTRACT_BUDGET_MS) refuse("proof-stale");
  validateReplayResult(replay, { capsuleDigest, candidateSha, identityDigest: contractDigest(identity) });
  return { schemaVersion: 1, candidateSha, priorAdminSha: identity.priorAdminSha, environment: identity.environment,
    projectId: identity.projectId, databaseId: identity.databaseId, identityDigest: contractDigest(identity),
    publicReaderDigest: contractDigest(identity.publicReader), backendDigest: contractDigest(identity.backend), capsuleDigest,
    proofDigest: contractDigest(replay), capturedAt, verifiedAt: now, mode: "native-source-bound",
    settingsMode: "public-projection", result: "proved" };
}

export function recheckContractSummary(previous, current, { candidateSha, settlement = false, now = Date.now() }) {
  if (!previous || !current || current.result !== "proved" || previous.result !== "proved" ||
      previous.candidateSha !== candidateSha || current.candidateSha !== candidateSha ||
      ["priorAdminSha", "environment", "projectId", "databaseId", "identityDigest", "publicReaderDigest", "backendDigest"].some(key => previous[key] !== current[key]) ||
      !Number.isSafeInteger(current.verifiedAt) || current.verifiedAt > now || now - current.verifiedAt >= CONTRACT_BUDGET_MS) {
    refuse(settlement ? "settlement-unconfirmed" : "proof-contract-changed");
  }
  return current;
}
