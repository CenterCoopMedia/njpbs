import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  PublicDeploymentStateError,
} = require("../../functions/lib/public-deployment.js");
const {
  assertPublicWorkerCandidateMatchesBatch,
  projectCloudflareWorkerVersion,
  projectPublicWorkerCandidate,
  projectPublicWorkerCandidateInput,
  publicWorkerCandidateMessage,
  publicWorkerCandidateTag,
  workerVersionIdFromWranglerOutput,
} = require("../../functions/lib/public-worker-candidate.js");
const compatibility = require("../../functions/lib/data-figure-compatibility.js");
const postState = require("../../functions/lib/no-build-post-state.js");
const postPublication = require("../../functions/lib/no-build-post-publication.js");
const postRecovery = require("../../functions/lib/no-build-post-recovery.js");
const pageCandidate = require("../../functions/lib/no-build-page-candidate.js");
const pageOwnership = require("../../functions/lib/no-build-page-ownership.js");

const timestamp = { toMillis: () => Date.parse("2026-08-27T20:01:00.000Z") };

function candidate(overrides = {}) {
  const value = {
    schemaVersion: 1,
    buildBatchId: "build-one",
    generation: 1,
    commitSha: "a".repeat(40),
    workerName: "njpbs-production",
    workerVersionId: "11111111-1111-4111-8111-111111111111",
    workerVersionTag: `cms-g1-${"d".repeat(16)}`,
    versionCreatedOn: "2026-08-27T20:00:00.000Z",
    artifactDigest: "d".repeat(64),
    artifactReceiptDigest: "e".repeat(64),
    publicationReceiptDigest: "f".repeat(64),
    mediaManifestDigest: "c".repeat(64),
    artifactFileCount: 100,
    artifactBytes: 1_000_000,
    wranglerVersion: "4.123.0",
    ...overrides,
  };
  if (
    !Object.prototype.hasOwnProperty.call(overrides, "workerVersionTag") &&
    (Object.prototype.hasOwnProperty.call(overrides, "generation") ||
      Object.prototype.hasOwnProperty.call(overrides, "artifactDigest"))
  ) {
    value.workerVersionTag = publicWorkerCandidateTag(value);
  }
  return value;
}

function batch(overrides = {}) {
  return {
    schemaVersion: 1,
    buildBatchId: "build-one",
    generation: 1,
    commitSha: "a".repeat(40),
    ...overrides,
  };
}

function familyVersion(input, extraBindings = []) {
  const message = publicWorkerCandidateMessage(input);
  return { value: {
    id: input.workerVersionId, metadata: { source: "wrangler", created_on: input.versionCreatedOn },
    annotations: { "workers/tag": input.workerVersionTag, "workers/message": message, "workers/triggered_by": "version_upload" },
    resources: { script: { etag: "script-etag" },
      script_runtime: { assets: JSON.parse(readFileSync(new URL("../fixtures/cloudflare/dev-worker-version-assets.json", import.meta.url), "utf8")) },
      bindings: [{ name: "ASSETS", type: "assets" },
        { name: "CMS_API", type: "service", service: "njpbs-cms-api", entrypoint: "PublicContentEntrypoint" },
        { name: "NO_BUILD_POST_FAMILIES", type: "plain_text", text: "posts" },
        { name: "NO_BUILD_POST_RENDERER_SHA", type: "plain_text", text: input.commitSha }, ...extraBindings] },
  }, expected: { tag: input.workerVersionTag, message } };
}

function ownedCandidateBoundary(family, { visible = true, figures = true, liveBlog = false } = {}) {
  const currentSha = "a".repeat(40);
  const candidateSha = "b".repeat(40);
  const page = family === "Page";
  const recordId = page ? "about" : "figure-post";
  const path = page ? "/about/" : "/posts/figure-post/";
  const blocks = figures ? [{ id: "figure-block", type: "data_figure", visible: true,
    data: { datasetId: "dataset", version: { mode: "latestApproved" }, display: "compact" } }] : [];
  const datasetFigures = figures ? { figures: [{ blockId: "figure-block", datasetId: "dataset",
    releaseId: "release", revision: 1, digest: "d".repeat(64) }], releases: [] } : undefined;
  const published = { sourceVersion: 1,
    metadata: page ? { slug: "about" } : { type: "post", slug: "figure-post", credits: [] },
    blocks, ...(datasetFigures ? { datasetFigures } : {}) };
  if (liveBlog) published.metadata.liveBlog = { schemaVersion: 1, coverageState: "ongoing", updatedAt: "2026-10-25T15:00:00.000Z", updates: [] };
  const state = page ? { schemaVersion: 1, pageId: recordId, rendererSha: currentSha,
    servingEnabled: true, generation: 1, operationId: "A".repeat(20), sourceVersion: 1, visible,
    path, ownedPaths: [path], snapshotDigest: pageOwnership.digest(published),
    ...(datasetFigures ? { datasetFiguresDigest: pageOwnership.digest(datasetFigures) } : {}),
    runtime: { owner: "cloudflare", release: currentSha } } :
    { schemaVersion: 1, postId: recordId, rendererSha: currentSha, servingEnabled: true, generation: 1,
      operationId: "A".repeat(20), sourceVersion: 1, slug: "figure-post", visible,
      ownedSlugs: ["figure-post"], snapshotDigest: pageOwnership.digest(published),
      ...(datasetFigures ? { datasetFiguresDigest: pageOwnership.digest(datasetFigures) } : {}) };
  const document = { publiclyVisible: visible, published };
  const ownerCollection = page ? pageOwnership.PAGE_OWNER_COLLECTION : "system/publicDeployment/noBuildPostOwners";
  const firestore = {
    doc: path => ({ path }),
    collection: path => ({ path, where() { return this; }, limit() { return this; } }),
  };
  const transaction = {
    async get(ref) {
      if (ref.path === "cmsPages") {
        const docs = page && visible ? [{ id: recordId, data: () => document }] : [];
        return { size: docs.length, docs };
      }
      if (ref.path === "system/publicDeployment/noBuildRecordFamilies/current") return { exists: false, data: () => undefined };
      if (ref.path === "system/publicDeployment/noBuildRecordOwners") return { size: 0, docs: [] };
      if (ref.path === ownerCollection) return { docs: [{ id: recordId,
        ref: firestore.doc(`${ownerCollection}/${recordId}`), data: () => state }] };
      if (ref.path === "system/publicDeployment/noBuildPosts/current") return { data: () => undefined };
      if (ref.path.startsWith(`${pageOwnership.PAGE_ROUTE_COLLECTION}/`)) {
        return { data: () => ({ schemaVersion: 1, pageId: recordId, path }) };
      }
      if (ref.path === `${page ? "cmsPages" : "cmsPosts"}/${recordId}`) return { data: () => document };
      if (ref.path === "cmsPages/home") return { data: () => undefined };
      throw new Error(`Unexpected candidate boundary read: ${ref.path}`);
    },
    async getAll() { return []; },
  };
  const contract = page ? { schemaVersion: 1, rendererSha: candidateSha, enabled: true, authoritative: true } :
    { schemaVersion: 2, families: ["posts"], rendererSha: candidateSha, enabled: true, authoritative: true };
  const value = { commitSha: candidateSha, generation: 2, [page ? "noBuildPage" : "noBuildPost"]: contract };
  const qualify = candidate => page ?
    pageCandidate.assertNoBuildPageCandidateInTransaction({ firestore, transaction, candidate }) :
    postPublication.assertNoBuildCandidateInTransaction({ firestore, transaction, candidate });
  return { contract, qualify, value };
}

// Nine retained Posts cross the eight-owner read batch. One owner can carry a
// live blog (refused after its Post read) and one a data figure digest
// (refused before any read) so the refusal order is observable.
function ownerSetBoundary({ liveBlogAt = -1, figuresAt = -1 } = {}) {
  const currentSha = "a".repeat(40);
  const candidateSha = "b".repeat(40);
  const ownerCollection = "system/publicDeployment/noBuildPostOwners";
  const firestore = {
    doc: path => ({ path }),
    collection: path => ({ path, limit() { return this; } }),
  };
  const owners = Array.from({ length: 9 }, (_, index) => {
    const postId = `post-${index}`;
    const published = { sourceVersion: 1, blocks: [], metadata: { type: "post", slug: postId, credits: [],
      ...(index === liveBlogAt ? { liveBlog: { schemaVersion: 1, coverageState: "ongoing", updatedAt: "2026-10-25T15:00:00.000Z", updates: [] } } : {}) } };
    const state = { schemaVersion: 1, postId, rendererSha: currentSha, servingEnabled: true, generation: 1,
      operationId: "A".repeat(20), sourceVersion: 1, slug: postId, visible: true, ownedSlugs: [postId],
      snapshotDigest: pageOwnership.digest(published),
      ...(index === figuresAt ? { datasetFiguresDigest: "d".repeat(64) } : {}) };
    return { postId, state, document: { publiclyVisible: true, published } };
  });
  const transaction = {
    async get(ref) {
      if (ref.path === "system/publicDeployment/noBuildRecordFamilies/current") return { exists: false, data: () => undefined };
      if (ref.path === "system/publicDeployment/noBuildRecordOwners") return { size: 0, docs: [] };
      if (ref.path === ownerCollection) return { docs: owners.map(owner => ({ id: owner.postId,
        ref: firestore.doc(`${ownerCollection}/${owner.postId}`), data: () => owner.state })) };
      if (ref.path === "system/publicDeployment/noBuildPosts/current") return { data: () => undefined };
      const owner = owners.find(entry => ref.path === `cmsPosts/${entry.postId}`);
      if (owner) return { data: () => owner.document };
      if (ref.path === "cmsPages/home") return { data: () => undefined };
      throw new Error(`Unexpected candidate boundary read: ${ref.path}`);
    },
    async getAll() { return []; },
  };
  const contract = { schemaVersion: 2, families: ["posts"], rendererSha: candidateSha, enabled: true, authoritative: true };
  const qualify = () => postPublication.assertNoBuildCandidateInTransaction({ firestore, transaction,
    candidate: { commitSha: candidateSha, generation: 2, noBuildPost: contract } });
  return { owners, qualify };
}

describe("public Worker candidate receipts", () => {
  it("projects one exact immutable Worker version receipt", () => {
    const result = projectPublicWorkerCandidateInput(candidate({
      workerVersionId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      versionCreatedOn: "2026-08-27T16:00:00-04:00",
    }));

    expect(result).toEqual(candidate({
      workerVersionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }));
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("validates the stored server timestamp and exact build identity", () => {
    const result = assertPublicWorkerCandidateMatchesBatch(
      { ...candidate(), recordedAt: timestamp },
      batch(),
    );

    expect(result.recordedAt).toBe(timestamp);
    expect(projectPublicWorkerCandidate(
      { ...candidate(), recordedAt: timestamp },
      "build-one",
    )).toEqual(result);
  });

  it.each([
    ["unknown field", { futureField: true }],
    ["wrong Worker", { workerName: "another-worker" }],
    ["invalid version id", { workerVersionId: "latest" }],
    ["wrong tag", { workerVersionTag: "cms-g1-wrong" }],
    ["invalid artifact digest", { artifactDigest: "D".repeat(64) }],
    ["invalid manifest digest", { mediaManifestDigest: "C".repeat(64) }],
    ["empty artifact", { artifactFileCount: 0 }],
    ["empty artifact bytes", { artifactBytes: 0 }],
    ["old Wrangler", { wranglerVersion: "3.114.0" }],
    ["invalid timestamp", { versionCreatedOn: "2026-02-30T12:00:00Z" }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => projectPublicWorkerCandidateInput(candidate(overrides)))
      .toThrow(PublicDeploymentStateError);
  });

  it("rejects a candidate from another build", () => {
    expect(() => assertPublicWorkerCandidateMatchesBatch(
      { ...candidate(), recordedAt: timestamp },
      batch({ buildBatchId: "build-two" }),
    )).toThrow("belongs to another build");
  });

  it("binds the full artifact identity into the Cloudflare annotation", () => {
    expect(publicWorkerCandidateMessage(candidate())).toBe(
      `cms-public-candidate-v1 batch=build-one generation=1 commit=${"a".repeat(40)} ` +
      `artifact=${"d".repeat(64)} publication=${"f".repeat(64)} ` +
      `manifest=${"c".repeat(64)}`,
    );
  });

  it("projects the exact uploaded Cloudflare version", () => {
    const input = candidate();
    const message = publicWorkerCandidateMessage(input);
    const result = projectCloudflareWorkerVersion({
      id: input.workerVersionId,
      metadata: {
        source: "wrangler",
        created_on: "2026-08-27T20:00:00.123456Z",
      },
      annotations: {
        "workers/tag": input.workerVersionTag,
        "workers/message": message,
        "workers/triggered_by": "version_upload",
      },
      resources: {
        script: { etag: "script-etag" },
        script_runtime: { assets: { html_handling: "force-trailing-slash" } },
        bindings: [
          { name: "ASSETS", type: "assets" },
          {
            name: "CMS_API",
            type: "service",
            service: "njpbs-cms-api",
            entrypoint: "PublicContentEntrypoint",
          },
        ],
      },
    }, { tag: input.workerVersionTag, message });

    expect(result).toEqual({
      workerVersionId: input.workerVersionId,
      versionCreatedOn: "2026-08-27T20:00:00.123Z",
    });
  });
  it("requires the real version to retain Worker-first paths and its exact Post renderer", () => {
    const input = candidate();
    const message = publicWorkerCandidateMessage(input);
    const version = { id: input.workerVersionId, metadata: { source: "wrangler", created_on: input.versionCreatedOn },
      annotations: { "workers/tag": input.workerVersionTag, "workers/message": message, "workers/triggered_by": "version_upload" },
      resources: { script: { etag: "script-etag" }, script_runtime: { assets: { config: { run_worker_first: true } } },
        bindings: [{ name: "ASSETS", type: "assets" }, { name: "CMS_API", type: "service", service: "njpbs-cms-api", entrypoint: "PublicContentEntrypoint" },
          { name: "NO_BUILD_POST_ID", type: "plain_text", text: "pilot-post" },
          { name: "NO_BUILD_POST_ENABLED", type: "plain_text", text: "true" },
          { name: "NO_BUILD_POST_RENDERER_SHA", type: "plain_text", text: input.commitSha }] } };
    const result = projectCloudflareWorkerVersion(version, { tag: input.workerVersionTag, message });
    expect(result.noBuildPost).toEqual({ schemaVersion: 1, postId: "pilot-post", enabled: true,
      rendererSha: input.commitSha, authoritative: true });
    expect(projectPublicWorkerCandidateInput({ ...input, noBuildPost: result.noBuildPost }).noBuildPost).toEqual(result.noBuildPost);
    expect(() => projectPublicWorkerCandidateInput({ ...input,
      noBuildPost: { ...result.noBuildPost, rendererSha: "b".repeat(40) } })).toThrow();
    version.resources.script_runtime.assets.config.run_worker_first = false;
    expect(() => projectCloudflareWorkerVersion(version, { tag: input.workerVersionTag, message })).toThrow();
  });

  it("seals a family reader from the observed Cloudflare assets receipt without pilot variables", () => {
    const input = candidate();
    const version = familyVersion(input);
    const noBuildPost = { schemaVersion: 2, families: ["posts"], rendererSha: input.commitSha,
      enabled: true, authoritative: true };
    expect(projectCloudflareWorkerVersion(version.value, version.expected).noBuildPost).toEqual(noBuildPost);
    expect(projectPublicWorkerCandidateInput({ ...input, noBuildPost }).noBuildPost).toEqual(noBuildPost);
    expect(() => projectPublicWorkerCandidateInput({ ...input,
      noBuildPost: { ...noBuildPost, rendererSha: "b".repeat(40) } })).toThrow("renderer does not match");
  });

  it("seals live blog support only from the immutable uploaded Post marker", () => {
    const input = candidate();
    const version = familyVersion(input, [{ name: "LIVE_BLOG_VERSION", type: "plain_text", text: "1" }]);
    const projected = projectCloudflareWorkerVersion(version.value, version.expected);
    expect(projected.noBuildPost).toMatchObject({ liveBlogVersion: 1 });
    expect(projected.noBuildPage).toBeUndefined();
    expect(projectPublicWorkerCandidateInput({ ...input, noBuildPost: projected.noBuildPost }).noBuildPost)
      .toMatchObject({ liveBlogVersion: 1 });
    version.value.resources.bindings.find(binding => binding.name === "LIVE_BLOG_VERSION").text = "0";
    expect(projectCloudflareWorkerVersion(version.value, version.expected).noBuildPost).not.toHaveProperty("liveBlogVersion");
    version.value.resources.bindings.find(binding => binding.name === "LIVE_BLOG_VERSION").text = "2";
    expect(() => projectCloudflareWorkerVersion(version.value, version.expected)).toThrow("live blog metadata is invalid");
  });

  it("keeps legacy capabilities valid and activates the optional live blog version", () => {
    const rendererSha = "a".repeat(40);
    const legacy = { schemaVersion: 2, rendererSha, servingEnabled: true, generation: 1 };
    expect(postState.validateCapability(legacy)).not.toHaveProperty("liveBlogVersion");
    expect(postState.validateCapability({ ...legacy, liveBlogVersion: 1 }).liveBlogVersion).toBe(1);
    expect(() => postState.validateCapability({ ...legacy, liveBlogVersion: 2 })).toThrow();
    const writes = new Map();
    postPublication.writeNoBuildCandidateActivation({ set(ref, value) { writes.set(ref.path, value); } },
      { doc: path => ({ path }) }, { owners: [], contract: { schemaVersion: 2, families: ["posts"],
        rendererSha, enabled: true, authoritative: true, liveBlogVersion: 1 } },
      { commitSha: rendererSha, generation: 4 });
    expect(writes.get("system/publicDeployment/noBuildPosts/capability"))
      .toMatchObject({ rendererSha, liveBlogVersion: 1, generation: 4 });
  });

  it("refuses dropping live blog support while an owned visible Post has frozen entries", async () => {
    const boundary = ownedCandidateBoundary("Post", { figures: false, liveBlog: true });
    await expect(boundary.qualify(boundary.value)).rejects.toThrow("does not preserve published live blogs");
    await expect(boundary.qualify({ ...boundary.value, noBuildPost: { ...boundary.contract, liveBlogVersion: 1 } }))
      .resolves.toBeDefined();
  });

  it("does not require live blog support for a withdrawn owner", async () => {
    const boundary = ownedCandidateBoundary("Post", { figures: false, liveBlog: true, visible: false });
    await expect(boundary.qualify(boundary.value)).resolves.toBeDefined();
  });

  it("qualifies every retained Post in owner order through batched reads", async () => {
    const boundary = ownerSetBoundary();
    const result = await boundary.qualify();
    expect(result.owners.map(owner => owner.state.postId)).toEqual(boundary.owners.map(owner => owner.postId));
    expect(result).toMatchObject({ state: result.owners[0].state, staticOwner: null });
    expect(result.staticReturn).toBeUndefined();
    // Owner 2 refuses after its Post read and owner 5 before any read. The
    // first owner in registry order still decides the reason, as a serial pass did.
    await expect(ownerSetBoundary({ liveBlogAt: 2, figuresAt: 5 }).qualify())
      .rejects.toThrow("does not preserve published live blogs");
  });

  it("seals election result support from immutable upload metadata for Pages and Posts", () => {
    const input = candidate();
    const version = familyVersion(input, [
      { name: "NO_BUILD_PAGE_RENDERER_SHA", type: "plain_text", text: input.commitSha },
      { name: "ELECTION_RESULTS_VERSION", type: "plain_text", text: "1" },
    ]);
    const projected = projectCloudflareWorkerVersion(version.value, version.expected);
    expect(projected.noBuildPost).toMatchObject({ electionResultsVersion: 1 });
    expect(projected.noBuildPage).toMatchObject({ electionResultsVersion: 1 });
    const rendererSha = input.commitSha;
    const legacy = { schemaVersion: 2, rendererSha, servingEnabled: true, generation: 1 };
    expect(postState.validateCapability(legacy).electionResultsVersion).toBeUndefined();
    expect(postState.validateCapability({ ...legacy, electionResultsVersion: 1 }).electionResultsVersion).toBe(1);
    expect(postState.validateCapability({ ...legacy, electionResultsVersion: 2 }).electionResultsVersion).toBe(2);
    version.value.resources.bindings.find(binding => binding.name === "ELECTION_RESULTS_VERSION").text = "2";
    expect(projectCloudflareWorkerVersion(version.value, version.expected).noBuildPage.electionResultsVersion).toBe(2);
    expect(projectCloudflareWorkerVersion(version.value, version.expected).noBuildPost.electionResultsVersion).toBe(2);
    version.value.resources.bindings.find(binding => binding.name === "ELECTION_RESULTS_VERSION").text = "3";
    expect(() => projectCloudflareWorkerVersion(version.value, version.expected)).toThrow(/election results metadata is invalid/);
  });

  it("seals data figure support only from the immutable uploaded marker", () => {
    const input = candidate();
    const version = familyVersion(input, [
      { name: "NO_BUILD_PAGE_RENDERER_SHA", type: "plain_text", text: input.commitSha },
      { name: "DATA_FIGURE_VERSION", type: "plain_text", text: "1" },
    ]);
    const projected = projectCloudflareWorkerVersion(version.value, version.expected);
    expect(projected.noBuildPost).toMatchObject({ dataFigureVersion: 1 });
    expect(projected.noBuildPage).toMatchObject({ dataFigureVersion: 1 });
    expect(projectPublicWorkerCandidateInput({ ...input,
      noBuildPost: projected.noBuildPost, noBuildPage: projected.noBuildPage })).toMatchObject({
      noBuildPost: { dataFigureVersion: 1 }, noBuildPage: { dataFigureVersion: 1 },
    });
    version.value.resources.bindings.find(binding => binding.name === "DATA_FIGURE_VERSION").text = "2";
    expect(() => projectCloudflareWorkerVersion(version.value, version.expected))
      .toThrow("data figure metadata is invalid");
  });

  it("keeps old capabilities valid and copies the sealed renderer version into activation", () => {
    const rendererSha = "a".repeat(40);
    const legacy = { schemaVersion: 2, rendererSha, servingEnabled: true, generation: 1 };
    expect(compatibility.supportsDataFigures(postState.validateCapability(legacy))).toBe(false);
    expect(compatibility.supportsDataFigures(postState.validateCapability({ ...legacy, dataFigureVersion: 1 }))).toBe(true);
    expect(() => postState.validateCapability({ ...legacy, dataFigureVersion: 2 })).toThrow();
    const owner = { schemaVersion: 1, postId: "post", rendererSha, servingEnabled: true, generation: 1,
      operationId: "A".repeat(20), sourceVersion: 1, slug: "post", visible: true, ownedSlugs: ["post"],
      snapshotDigest: "b".repeat(64), datasetFiguresDigest: "c".repeat(64) };
    expect(postState.validateState(owner)).toEqual(owner);
    expect(() => postState.validateState({ ...owner, snapshotDigest: undefined })).toThrow();

    const writes = new Map();
    const transaction = { set(ref, value) { writes.set(ref.path, value); } };
    const firestore = { doc(path) { return { path }; } };
    const candidate = { commitSha: rendererSha, generation: 4 };
    const postContract = { schemaVersion: 2, families: ["posts"], rendererSha,
      enabled: true, authoritative: true, dataFigureVersion: 1 };
    postPublication.writeNoBuildCandidateActivation(transaction, firestore,
      { owners: [], state: null, contract: postContract }, candidate);
    const pageContract = { schemaVersion: 1, rendererSha, enabled: true,
      authoritative: true, dataFigureVersion: 1 };
    pageCandidate.writeNoBuildPageCandidateActivation(transaction, firestore, { contract: pageContract }, candidate);
    expect(writes.get("system/publicDeployment/noBuildPosts/capability")).toMatchObject({ dataFigureVersion: 1 });
    expect(writes.get("system/publicDeployment/noBuildPages/capability")).toMatchObject({ dataFigureVersion: 1 });
  });

  it("requires exact optional data figure receipt parity while legacy Post receipts remain valid", async () => {
    const datasetFiguresDigest = "c".repeat(64);
    const state = { operationId: "A".repeat(20), sourceVersion: 1, visible: false, slug: "figure-post",
      rendererSha: "a".repeat(40), snapshotDigest: "b".repeat(64), datasetFiguresDigest };
    const response = ({ snapshot = state.snapshotDigest, figures = datasetFiguresDigest } = {}) =>
      new Response(null, { status: 410, headers: {
        "cache-control": "no-store",
        "x-njpbs-content-source": "cms-no-build",
        "x-njpbs-publication-operation": state.operationId,
        "x-njpbs-source-version": String(state.sourceVersion),
        ...(snapshot ? { "x-njpbs-snapshot-sha256": snapshot } : {}),
        ...(figures ? { "x-njpbs-dataset-figures-sha256": figures } : {}),
        "x-njpbs-admission-revision": "unavailable",
        "x-njpbs-renderer-sha": state.rendererSha,
        "x-njpbs-context-sha256": "d".repeat(64),
      } });
    const input = [async () => response(), new AbortController().signal,
      { origin: "https://example.test" }, new Headers()];
    await expect(postRecovery.readPublicPostReceipt(state, ...input))
      .resolves.toMatchObject({ snapshotDigest: state.snapshotDigest, datasetFiguresDigest });
    await expect(postRecovery.readPublicPostReceipt(state, async () => response({ figures: null }), ...input.slice(1)))
      .rejects.toThrow("Public Post receipt is unavailable");
    const legacy = { ...state };
    delete legacy.snapshotDigest;
    delete legacy.datasetFiguresDigest;
    await expect(postRecovery.readPublicPostReceipt(legacy,
      async () => response({ snapshot: null, figures: null }), ...input.slice(1)))
      .resolves.not.toHaveProperty("datasetFiguresDigest");
  });

  it("accepts an owned visible data figure Page only with the compiled feature marker", async () => {
    const boundary = ownedCandidateBoundary("Page");
    await expect(boundary.qualify(boundary.value)).rejects.toThrow("does not preserve published data figures");
    await expect(boundary.qualify({ ...boundary.value,
      noBuildPage: { ...boundary.contract, dataFigureVersion: 1 } }))
      .resolves.toBeDefined();
  });

  it("accepts an owned visible data figure Post only with the compiled feature marker", async () => {
    const boundary = ownedCandidateBoundary("Post");
    await expect(boundary.qualify(boundary.value)).rejects.toThrow("does not preserve published data figures");
    await expect(boundary.qualify({ ...boundary.value,
      noBuildPost: { ...boundary.contract, dataFigureVersion: 1 } }))
      .resolves.toBeDefined();
  });

  it.each([["Post", true, false], ["Page", true, false], ["Post", false, true], ["Page", false, true]])(
    "keeps an unmarked candidate valid for %s when visible=%s and figures=%s",
    async (family, visible, figures) => {
      const boundary = ownedCandidateBoundary(family, { visible, figures });
      await expect(boundary.qualify(boundary.value)).resolves.toBeDefined();
    },
  );

  it("detects only a visible prospective data figure before the old palette runs", () => {
    const figure = { id: "figure", type: "data_figure", visible: true, data: {} };
    expect(compatibility.containsVisibleDataFigure({ blocks: [figure] })).toBe(true);
    expect(compatibility.containsVisibleDataFigure({ blocks: [{ ...figure, visible: false }] })).toBe(false);
    expect(compatibility.containsVisibleDataFigure({ blocks: null })).toBe(false);
  });
  it("gives fixed family capability metadata precedence over retained pilot variables", () => {
    const input = candidate();
    const version = familyVersion(input, [
      { name: "NO_BUILD_POST_ID", type: "plain_text", text: "another-post" },
      { name: "NO_BUILD_POST_ENABLED", type: "plain_text", text: "false" },
    ]);
    expect(projectCloudflareWorkerVersion(version.value, version.expected).noBuildPost).toEqual({
      schemaVersion: 2, families: ["posts"], rendererSha: input.commitSha, enabled: true, authoritative: true,
    });
  });

  it.each([
    ["empty family", "NO_BUILD_POST_FAMILIES", ""],
    ["another family", "NO_BUILD_POST_FAMILIES", "authors"],
    ["extra family", "NO_BUILD_POST_FAMILIES", "posts,authors"],
    ["invalid renderer", "NO_BUILD_POST_RENDERER_SHA", "A".repeat(40)],
    ["missing renderer", "NO_BUILD_POST_RENDERER_SHA", undefined],
  ])("refuses family receipt metadata with %s", (_label, name, text) => {
    const version = familyVersion(candidate());
    version.value.resources.bindings.find(binding => binding.name === name).text = text;
    expect(() => projectCloudflareWorkerVersion(version.value, version.expected)).toThrow();
  });

  it("refuses ambiguous family metadata and lost Worker-first routing", () => {
    const input = candidate();
    const duplicate = familyVersion(input, [{ name: "NO_BUILD_POST_FAMILIES", type: "plain_text", text: "posts" }]);
    expect(() => projectCloudflareWorkerVersion(duplicate.value, duplicate.expected)).toThrow("reader metadata is invalid");
    const changed = familyVersion(input);
    changed.value.resources.script_runtime.assets.run_worker_first = false;
    expect(() => projectCloudflareWorkerVersion(changed.value, changed.expected)).toThrow("preserve instant Post paths");
  });

  it("requires Home in a family routing list and retains the legacy Post path list", () => {
    const paths = ["/posts", "/posts/*", "/authors", "/authors/*", "/feeds/*", "/api/v1/*",
      "/sitemap*", "/pagefind/*", "/search/*", "/_content-status.json"];
    const version = familyVersion(candidate());
    version.value.resources.script_runtime.assets.raw_run_worker_first = paths;
    expect(() => projectCloudflareWorkerVersion(version.value, version.expected)).toThrow("preserve instant Post paths");
    version.value.resources.script_runtime.assets.raw_run_worker_first = ["/", ...paths];
    expect(projectCloudflareWorkerVersion(version.value, version.expected).noBuildPost.schemaVersion).toBe(2);
    version.value.resources.script_runtime.assets.raw_run_worker_first = paths;
    version.value.resources.bindings = version.value.resources.bindings.filter(binding => binding.name !== "NO_BUILD_POST_FAMILIES");
    version.value.resources.bindings.push(
      { name: "NO_BUILD_POST_ID", type: "plain_text", text: "pilot-post" },
      { name: "NO_BUILD_POST_ENABLED", type: "plain_text", text: "true" },
    );
    expect(projectCloudflareWorkerVersion(version.value, version.expected).noBuildPost).toEqual({
      schemaVersion: 1, postId: "pilot-post", rendererSha: "a".repeat(40), enabled: true, authoritative: true,
    });
  });

  it("keeps the exact retained static proof with a family or matching legacy reader", () => {
    const noBuildStatic = { schemaVersion: 1, postId: "retained-post", operationId: "A".repeat(20),
      sourceVersion: 1, visible: false, slug: "retained-story", ownedSlugs: ["retained-story"],
      snapshotDigest: "b".repeat(64), contextDigest: "c".repeat(64),
      files: ["/posts/", "/feeds/news.xml", "/api/v1/content.json", "/pagefind/pagefind.js",
        "/search/meaning-index.json", "/_publication.json", "/_content-status.json", "/sitemap.xml"]
        .map(path => ({ path, bytes: 1, digest: "d".repeat(64) })) };
    const family = { schemaVersion: 2, rendererSha: "a".repeat(40), families: ["posts"], enabled: true, authoritative: true };
    const legacy = { schemaVersion: 1, rendererSha: "a".repeat(40), postId: "retained-post", enabled: true, authoritative: true };
    for (const noBuildPost of [family, legacy]) {
      const projected = projectPublicWorkerCandidateInput(candidate({ noBuildPost, noBuildStatic }));
      expect(projected.noBuildStatic).toEqual(noBuildStatic);
      expect(projected.noBuildPost).toEqual(noBuildPost);
    }
    expect(() => projectPublicWorkerCandidateInput(candidate({ noBuildStatic,
      noBuildPost: { ...legacy, postId: "another-post" } }))).toThrow("matching authoritative reader");
  });

  it("accepts the raw Worker-first setting from a Cloudflare version receipt", () => {
    const input = candidate();
    const message = publicWorkerCandidateMessage(input);
    // Shape observed on the production version API on October 10, 2026.
    const assets = { html_handling: "force-trailing-slash", not_found_handling: "404-page",
      serve_directly: false, raw_run_worker_first: true, base_path: "/" };
    const version = { id: input.workerVersionId, metadata: { source: "wrangler", created_on: input.versionCreatedOn },
      annotations: { "workers/tag": input.workerVersionTag, "workers/message": message, "workers/triggered_by": "version_upload" },
      resources: { script: { etag: "script-etag" }, script_runtime: { assets },
        bindings: [{ name: "ASSETS", type: "assets" }, { name: "CMS_API", type: "service", service: "njpbs-cms-api", entrypoint: "PublicContentEntrypoint" },
          { name: "NO_BUILD_POST_ID", type: "plain_text", text: "pilot-post" },
          { name: "NO_BUILD_POST_ENABLED", type: "plain_text", text: "true" },
          { name: "NO_BUILD_POST_RENDERER_SHA", type: "plain_text", text: input.commitSha }] } };
    const expected = { tag: input.workerVersionTag, message };
    expect(projectCloudflareWorkerVersion(version, expected).noBuildPost).toEqual({
      schemaVersion: 1, postId: "pilot-post", enabled: true, rendererSha: input.commitSha, authoritative: true,
    });
    for (const value of [false, undefined, "true", ["/posts/*"]]) {
      assets.raw_run_worker_first = value;
      expect(() => projectCloudflareWorkerVersion(version, expected)).toThrow("The candidate does not preserve instant Post paths");
    }
    assets.raw_run_worker_first = true;
    assets.run_worker_first = false;
    expect(() => projectCloudflareWorkerVersion(version, expected)).toThrow("The candidate does not preserve instant Post paths");
  });

  it("rejects a version with the wrong annotation or bindings", () => {
    const input = candidate();
    const message = publicWorkerCandidateMessage(input);
    expect(() => projectCloudflareWorkerVersion({
      id: input.workerVersionId,
      metadata: { source: "wrangler", created_on: input.versionCreatedOn },
      annotations: {
        "workers/tag": input.workerVersionTag,
        "workers/message": `${message} changed`,
        "workers/triggered_by": "version_upload",
      },
      resources: {
        script: {},
        script_runtime: { assets: {} },
        bindings: [{ name: "ASSETS", type: "assets" }],
      },
    }, { tag: input.workerVersionTag, message })).toThrow(
      "uploaded public Worker version receipt is invalid",
    );
  });

  it("extracts one unambiguous Wrangler upload id", () => {
    const versionId = "11111111-1111-4111-8111-111111111111";
    expect(workerVersionIdFromWranglerOutput(
      `Uploaded njpbs-production\nWorker Version ID: ${versionId}\n`,
    )).toBe(versionId);
    expect(() => workerVersionIdFromWranglerOutput(
      `Worker Version ID: ${versionId}\nWorker Version ID: ${versionId}\n`,
    )).toThrow("Wrangler version upload receipt is invalid");
  });
});


describe("explicit dev candidate target", () => {
  const target = require("../../functions/lib/publication-target.js").publicationTarget("development");
  function devVersion() {
    const input = candidate({ workerName: target.workerName, runtime: { owner: "cloudflare", release: "a".repeat(40) } });
    const version = familyVersion(input);
    version.value.resources.bindings = version.value.resources.bindings
      .filter(binding => binding.name !== "NO_BUILD_POST_FAMILIES")
      .map(binding => binding.name === "CMS_API" ? { ...binding, service: "template-dev-cms-api" } : binding);
    return { input, ...version, expected: { ...version.expected, target } };
  }
  it("keeps dev version and candidate evidence outside the production default", () => {
    const { input, value, expected } = devVersion();
    const projected = projectCloudflareWorkerVersion(value, expected);
    expect(projected.noBuildPost).toEqual({ schemaVersion: 2, families: ["posts"],
      rendererSha: input.commitSha, enabled: true, authoritative: true });
    const devCandidate = { ...input, noBuildPost: projected.noBuildPost };
    expect(projectPublicWorkerCandidateInput(devCandidate, { target })).toEqual(devCandidate);
    expect(() => projectPublicWorkerCandidateInput(devCandidate)).toThrow("candidate is invalid");
    expect(() => projectPublicWorkerCandidateInput(candidate(), { target })).toThrow("candidate is invalid");
    expect(() => projectCloudflareWorkerVersion(value, { ...expected, target: undefined })).toThrow();
  });
  it("accepts only the exact optional dev withdrawal bucket with and without Page reader metadata", () => {
    const { value, expected } = devVersion();
    value.resources.bindings.push({ name: "DURABLE_POST_WITHDRAWALS", type: "r2_bucket", bucket_name: "njpbs-dev-cms-publication" });
    expect(projectCloudflareWorkerVersion(value, expected).noBuildPost.schemaVersion).toBe(2);
    value.resources.bindings.push({ name: "NO_BUILD_PAGE_RENDERER_SHA", type: "plain_text", text: "a".repeat(40) });
    value.resources.script_runtime.assets.config = { run_worker_first: true };
    expect(projectCloudflareWorkerVersion(value, expected).noBuildPage).toEqual({ schemaVersion: 1,
      rendererSha: "a".repeat(40), enabled: true, authoritative: true });
    value.resources.bindings.push({ name: "DATA_FIGURE_VERSION", type: "plain_text", text: "1" });
    expect(projectCloudflareWorkerVersion(value, expected)).toMatchObject({
      noBuildPost: { dataFigureVersion: 1 }, noBuildPage: { dataFigureVersion: 1 },
    });
  });
  it.each([
    { name: "OTHER_BUCKET", type: "r2_bucket", bucket_name: "njpbs-dev-cms-publication" },
    { name: "DURABLE_POST_WITHDRAWALS", type: "r2_bucket", bucket_name: "njpbs-cms-publication" },
    { name: "DURABLE_POST_WITHDRAWALS", type: "plain_text", text: "njpbs-dev-cms-publication" },
    { name: "DURABLE_POST_WITHDRAWALS", type: "r2_bucket" },
  ])("rejects an unexpected dev withdrawal binding: %j", binding => {
    const { value, expected } = devVersion();
    value.resources.bindings.push(binding);
    expect(() => projectCloudflareWorkerVersion(value, expected)).toThrow("dev candidate reader bindings are invalid");
  });
  it("rejects duplicate dev withdrawal bindings", () => {
    const { value, expected } = devVersion();
    const binding = { name: "DURABLE_POST_WITHDRAWALS", type: "r2_bucket", bucket_name: "njpbs-dev-cms-publication" };
    value.resources.bindings.push(binding, { ...binding });
    expect(() => projectCloudflareWorkerVersion(value, expected)).toThrow("dev candidate reader bindings are invalid");
  });
  it.each(["production service", "extra family flag", "duplicate CMS binding", "missing renderer seal"])(
    "refuses mixed dev receipt: %s", mode => {
      const { value, expected } = devVersion();
      const bindings = value.resources.bindings;
      if (mode === "production service") bindings.find(binding => binding.name === "CMS_API").service = "njpbs-cms-api";
      if (mode === "extra family flag") bindings.push({ name: "NO_BUILD_POST_FAMILIES", type: "plain_text", text: "posts" });
      if (mode === "duplicate CMS binding") bindings.push({ ...bindings.find(binding => binding.name === "CMS_API") });
      if (mode === "missing renderer seal") value.resources.bindings = bindings.filter(binding => binding.name !== "NO_BUILD_POST_RENDERER_SHA");
      expect(() => projectCloudflareWorkerVersion(value, expected)).toThrow();
    },
  );
});


it("qualifies immutable record routing only from an exact renderer binding", () => {
  const input = candidate(), receipt = familyVersion(input, [{ name: "NO_BUILD_RECORD_RENDERER_SHA", type: "plain_text", text: input.commitSha }]);
  const record = { schemaVersion: 1, rendererSha: input.commitSha, enabled: true, authoritative: true, families: ["programs", "events"] };
  expect(projectCloudflareWorkerVersion(receipt.value, receipt.expected).noBuildRecord).toEqual(record);
  expect(projectPublicWorkerCandidateInput({ ...input, noBuildRecord: record }).noBuildRecord).toEqual(record);
  expect(() => projectPublicWorkerCandidateInput({ ...input, noBuildRecord: { ...record, rendererSha: "b".repeat(40) } })).toThrow();
  receipt.value.resources.script_runtime.assets.raw_run_worker_first = ["/posts/*", "/programs/*"];
  receipt.value.resources.bindings = receipt.value.resources.bindings.filter(binding => binding.name !== "NO_BUILD_POST_FAMILIES");
  expect(() => projectCloudflareWorkerVersion(receipt.value, receipt.expected)).toThrow("every retained record route");
});


it("accepts an explicit empty record renderer marker as disabled", () => {
  const { value, expected } = familyVersion(candidate());
  value.resources.bindings.push({ type: "plain_text", name: "NO_BUILD_RECORD_RENDERER_SHA", text: "" });
  expect(projectCloudflareWorkerVersion(value, expected).noBuildRecord).toBeUndefined();
});

it("qualifies optional dev record and CODE bindings against the sealed public renderer", async () => {
  const { assertDevPublicWorkerBindings } = await import("../../scripts/deploy-dev-staff-gateway.mjs");
  const sha = "a".repeat(40);
  const bindings = [{ name: "ASSETS", type: "assets" }, { name: "CMS_API", type: "service", service: "template-dev-cms-api", entrypoint: "PublicContentEntrypoint" },
    { name: "NO_BUILD_POST_RENDERER_SHA", type: "plain_text", text: sha }];
  for (const text of ["", sha]) expect(() => assertDevPublicWorkerBindings([...bindings,
    { name: "NO_BUILD_RECORD_RENDERER_SHA", type: "plain_text", text }, { name: "NO_BUILD_CODE_POST_RENDERER_SHA", type: "plain_text", text: sha }], sha)).not.toThrow();
  expect(() => assertDevPublicWorkerBindings([...bindings,
    { name: "NO_BUILD_RECORD_RENDERER_SHA", type: "plain_text", text: "b".repeat(40) }], sha)).toThrow();
});

it("keeps dev record readers and Data Hub composition in the same version receipt", () => {
  const input = candidate();
  const { value, expected } = familyVersion(input);
  const target = require("../../functions/lib/publication-target.js").publicationTarget("development");
  value.resources.bindings = value.resources.bindings
    .filter(binding => binding.name !== "NO_BUILD_POST_FAMILIES")
    .map(binding => binding.name === "CMS_API" ? { ...binding, service: "template-dev-cms-api" } : binding);
  value.resources.script_runtime.assets.raw_run_worker_first = true;
  for (const [name, text] of Object.entries({
    NO_BUILD_PAGE_RENDERER_SHA: input.commitSha,
    NO_BUILD_CODE_POST_RENDERER_SHA: input.commitSha,
    NO_BUILD_RECORD_RENDERER_SHA: input.commitSha,
    DATA_FIGURE_VERSION: "1",
    DATA_HUB_PUBLIC: "1",
    DATA_HUB_COMPOSITION_VERSION: "1",
  })) value.resources.bindings.push({ name, type: "plain_text", text });
  value.resources.bindings.push({ name: "DURABLE_POST_WITHDRAWALS", type: "r2_bucket", bucket_name: "njpbs-dev-cms-publication" });
  expect(projectCloudflareWorkerVersion(value, { ...expected, target })).toMatchObject({
    noBuildRecord: { rendererSha: input.commitSha, families: ["programs", "events"] },
    noBuildPage: { rendererSha: input.commitSha, dataFigureVersion: 1, dataHubReportingVersion: 1, dataHubCompositionVersion: 1 },
    noBuildPost: { rendererSha: input.commitSha, dataFigureVersion: 1 },
  });
  value.resources.bindings.find(binding => binding.name === "DATA_HUB_PUBLIC").text = "0";
  expect(() => projectCloudflareWorkerVersion(value, { ...expected, target })).toThrow("Invalid Data Hub composition metadata");
});
