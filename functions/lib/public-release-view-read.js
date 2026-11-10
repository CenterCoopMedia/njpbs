var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var stdin_exports = {};
__export(stdin_exports, {
  isPublicPairRequestPath: () => isPublicPairRequestPath,
  readBoundedPairObject: () => readBoundedPairObject,
  readPublicReleasePairOutput: () => readPublicReleasePairOutput,
  verifyPairRouteTarget: () => verifyPairRouteTarget
});
module.exports = __toCommonJS(stdin_exports);
var import_public_release_pair = __toESM(require("./public-release-pair.js"));
var import_public_release_pair_view = __toESM(require("./public-release-pair-view.js"));
var import_public_release_pair_input = __toESM(require("./public-release-pair-input.js"));
var import_node_crypto = require("node:crypto");
const bytesDigest = async (bytes) => (0, import_node_crypto.createHash)("sha256").update(bytes).digest("hex");
const refuse = () => {
  throw new Error("Public pair bytes are unavailable");
};
async function readBoundedPairObject(store, key, limit, expected, size) {
  const object = await store.get(key);
  if (!object) return refuse();
  const objectSize = object.size;
  if (!Number.isSafeInteger(objectSize) || objectSize < 0 || objectSize > limit || size !== void 0 && objectSize !== size) {
    await object.body.cancel();
    refuse();
  }
  if (expected) {
    const customMetadata = object.customMetadata;
    if (Object.entries(expected).some(([name, value]) => customMetadata?.[name] !== value)) {
      await object.body.cancel();
      refuse();
    }
  }
  const reader = object.body.getReader(), chunks = [];
  let count = 0;
  try {
    for (; ; ) {
      const { value, done } = await reader.read();
      if (done) break;
      count += value.length;
      if (count > objectSize) refuse();
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {
    });
  }
  if (count !== objectSize) refuse();
  const bytes = new Uint8Array(count);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  if (expected && await bytesDigest(bytes) !== expected.bodydigest) refuse();
  return bytes;
}
const isDigest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) refuse();
}
const json = (bytes) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
function isPublicPairRequestPath(path) {
  return !path.startsWith("/_pair-compiled/") && (path.length <= 1024 && /^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*$/.test(path) && path.split("/").every((part) => ![".", ".."].includes(part)) || import_public_release_pair_view.default.isPrivatePairArtifactPath(path));
}
async function readPublicReleasePairOutput({ store, pair, locator, path }) {
  if (locator.pairDigest !== import_public_release_pair.default.publicReleaseDigest(pair)) refuse();
  const identity = import_public_release_pair_view.default.parseViewIdentity(locator.identity, pair);
  const prefix = import_public_release_pair_view.default.publicReleasePairViewPrefix(pair, identity, locator.claimDigest);
  const metadata = (bodydigest) => ({
    schemaversion: "2",
    pairdigest: locator.pairDigest,
    taskid: import_public_release_pair.default.publicReleaseDigest(identity),
    claimdigest: locator.claimDigest,
    bodydigest
  });
  const root = import_public_release_pair_view.default.parsePublicReleasePairViewRoot(json(await readBoundedPairObject(
    store,
    `${prefix}views/${locator.manifestDigest}.json`,
    import_public_release_pair_view.default.VIEW_ROOT_BYTES_LIMIT,
    metadata(locator.manifestDigest),
    locator.manifestBytes
  )), pair);
  if (root.claimDigest !== locator.claimDigest || import_public_release_pair.default.publicReleaseDigest(root.identity) !== import_public_release_pair.default.publicReleaseDigest(identity)) refuse();
  const descriptor = root.pages.find((page2) => import_public_release_pair_view.default.comparePrivatePairArtifactPaths(path, page2.firstPath) >= 0 && import_public_release_pair_view.default.comparePrivatePairArtifactPaths(path, page2.lastPath) <= 0);
  if (!descriptor) return null;
  const page = import_public_release_pair_view.default.parsePublicReleasePairViewPage(json(await readBoundedPairObject(
    store,
    `${prefix}pages/${descriptor.digest}.json`,
    import_public_release_pair_view.default.VIEW_PAGE_BYTES_LIMIT,
    metadata(descriptor.digest)
  )), pair, identity, locator.claimDigest);
  if (page.index !== descriptor.index || page.outputs.length !== descriptor.count || page.outputs[0].path !== descriptor.firstPath || page.outputs.at(-1).path !== descriptor.lastPath || page.outputs.reduce((sum, output2) => sum + output2.bytes, 0) !== descriptor.bytes) refuse();
  const output = page.outputs.find((candidate) => candidate.path === path);
  if (!output) return null;
  const bytes = await readBoundedPairObject(store, output.objectKey, import_public_release_pair_view.default.BODY_BYTES_LIMIT, metadata(output.bodyDigest), output.bytes);
  return { ...output, body: bytes };
}
async function verifyPairRouteTarget({ store, pair, decision, output }) {
  if (decision.route.kind !== "serve") return false;
  const locator = decision.composition?.proofLocator ?? decision.locator, taskId = import_public_release_pair.default.publicReleaseDigest(locator.identity);
  const route = decision.route, owner = route.owner;
  const currentStaticPost = route.family === "post" && owner?.mode === "static";
  if (!owner || owner.operationId !== route.operationId || !currentStaticPost && (owner.sourceVersion !== route.sourceVersion || owner.snapshotDigest !== void 0 && owner.snapshotDigest !== route.snapshotDigest)) return false;
  if (currentStaticPost && (!route.sourcePath || !route.sourceDigest)) return false;
  if (owner.snapshotDigest === void 0 && (route.family !== "post" || !route.sourcePath || !route.sourceDigest)) return false;
  const inputSeal = (bodydigest) => ({ schemaversion: "2", pairdigest: locator.pairDigest, bodydigest });
  const frozenRoot = import_public_release_pair_input.default.parsePublicReleasePairInputRoot(json(await readBoundedPairObject(
    store,
    import_public_release_pair_input.default.publicReleasePairInputRootKey(pair, locator.identity.inputManifestDigest),
    import_public_release_pair_input.default.INPUT_ROOT_BYTES_LIMIT,
    inputSeal(locator.identity.inputManifestDigest)
  )), pair);
  if (frozenRoot.scope.sourceOperationId !== locator.identity.sourceOperationId || frozenRoot.scope.snapshotDigest !== locator.identity.snapshotDigest || frozenRoot.scope.kind !== locator.identity.kind || frozenRoot.scope.sourceVersion !== locator.identity.sourceVersion || frozenRoot.scope.contextSequence !== locator.identity.contextSequence || frozenRoot.cursor.sequence !== locator.identity.contextSequence || frozenRoot.cursor.sequence > decision.contentHead.contextSequence) return false;
  const metadataFile = frozenRoot.files.find((file) => file.name === "source-metadata.json");
  if (!metadataFile) return false;
  const metadata = json(await readBoundedPairObject(
    store,
    metadataFile.objectKey,
    import_public_release_pair_input.default.INPUT_FILE_BYTES_LIMIT,
    inputSeal(metadataFile.digest),
    metadataFile.bytes
  ));
  exact(metadata, ["schemaVersion", "kind", "members", "digest"]);
  if (metadata.schemaVersion !== 1 || metadata.kind !== "pair-public-source-metadata" || !Array.isArray(metadata.members) || metadata.members.length > 1e4 || metadata.digest !== import_public_release_pair.default.publicReleaseDigest({ schemaVersion: 1, kind: metadata.kind, members: metadata.members })) return false;
  const ownerDigest = metadata.members.find((member) => member.path === route.ownerPath)?.digest;
  if (ownerDigest !== import_public_release_pair.default.publicReleaseDigest(owner)) {
    // Exact first. Legacy H may omit ONLY the additive validated staticProof.
    if (!currentStaticPost || owner.staticProof === void 0) return false;
    const legacyOwner = { ...owner }; delete legacyOwner.staticProof;
    if (ownerDigest !== import_public_release_pair.default.publicReleaseDigest(legacyOwner)) return false;
  }
  if (route.family === "post" && metadata.members.find((member) => member.path === route.sourcePath)?.digest !== route.sourceDigest) return false;
  if (decision.path === "/_home-sources.json") {
    const frozenFile = async (name) => {
      const file = frozenRoot.files.find((file2) => file2.name === name);
      if (!file) return refuse();
      return json(await readBoundedPairObject(store, file.objectKey, import_public_release_pair_input.default.INPUT_FILE_BYTES_LIMIT, inputSeal(file.digest), file.bytes));
    };
    const plan = await frozenFile("render-plan.json");
    const planned = plan.routes?.find((value) => value.path === decision.path);
    if (plan.schemaVersion !== 1 || plan.pairDigest !== locator.pairDigest || plan.snapshotDigest !== locator.identity.snapshotDigest || planned?.renderer !== "json" || planned.method !== "GET" || typeof planned.inputFile !== "string") return false;
    const request = await frozenFile(planned.inputFile);
    exact(request, ["schemaVersion", "read", "homeSourcesFile", "resources"]);
    return request.schemaVersion === 1 && request.read !== null && request.read !== void 0 && await bytesDigest(new TextEncoder().encode(JSON.stringify(request.read))) === output.bodyDigest;
  }
  if (!decision.targetProof) return false;
  const readClaim = async (descriptor, limit) => {
    exact(descriptor, ["digest", "key", "bytes"]);
    if (!isDigest(descriptor.digest) || descriptor.key !== import_public_release_pair_view.default.publicReleasePairViewObjectKey(pair, locator.identity, locator.claimDigest, descriptor.digest) || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1 || descriptor.bytes > limit) refuse();
    return json(await readBoundedPairObject(store, descriptor.key, limit, {
      schemaversion: "2",
      pairdigest: locator.pairDigest,
      taskid: taskId,
      claimdigest: locator.claimDigest,
      bodydigest: descriptor.digest
    }, descriptor.bytes));
  };
  const root = await readClaim(decision.targetProof, import_public_release_pair_view.default.VIEW_ROOT_BYTES_LIMIT);
  exact(root, ["schemaVersion", "kind", "pairDigest", "taskId", "claimDigest", "viewManifestDigest", "inputManifestDigest", "pages", "targetCount"]);
  if (root.schemaVersion !== 1 || root.kind !== "pair-render-targets" || root.pairDigest !== locator.pairDigest || root.taskId !== taskId || root.claimDigest !== locator.claimDigest || root.viewManifestDigest !== locator.manifestDigest || root.inputManifestDigest !== locator.identity.inputManifestDigest || !Array.isArray(root.pages) || root.pages.length > 512 || !Number.isSafeInteger(root.targetCount) || root.targetCount < 1 || root.targetCount > import_public_release_pair_view.default.VIEW_OUTPUT_LIMIT) refuse();
  let low = 0, high = root.pages.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2), page = await readClaim(root.pages[middle], import_public_release_pair_view.default.VIEW_PAGE_BYTES_LIMIT);
    exact(page, ["schemaVersion", "index", "targets"]);
    if (page.schemaVersion !== 1 || page.index !== middle || !Array.isArray(page.targets) || !page.targets.length || page.targets.length > 256) refuse();
    let prior = "";
    for (const member2 of page.targets) {
      exact(member2, ["receipt", "bodyDigest", "status"]);
      if (typeof member2.receipt?.path !== "string" || member2.receipt.path <= prior) refuse();
      prior = member2.receipt.path;
    }
    if (output.path < page.targets[0].receipt.path) {
      high = middle - 1;
      continue;
    }
    if (output.path > page.targets.at(-1).receipt.path) {
      low = middle + 1;
      continue;
    }
    const member = page.targets.find((member2) => member2.receipt.path === output.path);
    if (!member) return false;
    const receipt = member.receipt, target = receipt.target, source = receipt.source;
    exact(receipt, ["schemaVersion", "kind", "identityDigest", "inputManifestDigest", "path", "method", "source", "target"]);
    if (receipt.schemaVersion !== 1 || receipt.kind !== "pair-render-target" || receipt.identityDigest !== taskId || receipt.inputManifestDigest !== locator.identity.inputManifestDigest || receipt.method !== "GET" || member.status !== output.status || member.bodyDigest !== output.bodyDigest || target?.pairDigest !== locator.pairDigest || target.rendererSha !== pair.commitSha || target.rendererDigest !== pair.rendererDigest || target.readerContractDigest !== pair.readerContractDigest || target.readerReceiptDigest !== pair.readerReceiptDigest || import_public_release_pair.default.publicReleaseDigest(target.pair) !== import_public_release_pair.default.publicReleaseDigest(import_public_release_pair.default.publicReleasePairReference(pair)) || target.targetDigest !== import_public_release_pair.default.publicReleaseDigest(target.projection) || !isDigest(source?.inputDigest) || !isDigest(source?.provenanceDigest)) return false;
    const projected = target.projection?.target;
    const allowed = decision.route.family === "post" ? ["public-post-shadow"] : decision.route.family === "record" ? ["public-record-family"] : ["public-page", "public-page-context"];
    return allowed.includes(target.projection?.kind) && projected?.documentId === decision.route.id && projected.sourceVersion === decision.route.sourceVersion && projected.pagePath === decision.path && projected.rendererSha === pair.commitSha;
  }
  return false;
}
