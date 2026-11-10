import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import serving from "../../functions/lib/staff-author-serving.js";
import background from "../../functions/lib/post-background-outputs.js";
import deployment from "../../functions/lib/public-deployment.js";
import postReader from "../../functions/lib/no-build-post-publication.js";
import revision from "../../functions/lib/public-context-revision.js";
const now = 1_790_000_000_000, rendererSha = "a".repeat(40), path = "/authors/new-profile/";
const bytes = Buffer.from("<!doctype html><html><body>New profile</body></html>");
const hash = value => createHash("sha256").update(value).digest("hex");

it.each(["missing", "pending", "old manifest", "promoted", "failed replacement", "expired", "withdrawal expired", "wrong owner", "invalid context", "Assets pass", "unestablished pass", "Post read failure", "static owner", "static missing path", "Post refusal"])(
  "links only to the same eligible author page as the real reader: %s", async mode => {
    const context = { schemaVersion: 1, revision: 1, withdrawalRevision: 0 };
    const file = { path, key: "immutable-author-body", digest: hash(bytes), size: bytes.length, contentType: "text/html; charset=utf-8" };
    const receipt = { revision: 1, rendererSha, contextDigest: revision.publicContextDigest(1), verifiedAt: now,
      withdrawalRevision: 0, assets: [], manifest: [file], digest: hash("manifest") };
    const state = { owner: "post-background-v1", schemaVersion: 1, output: "authors", status: "verified", contextOnly: true,
      revision: 1, contextDigest: receipt.contextDigest, after: background.dependency(null), receipt };
    if (["pending", "old manifest", "failed replacement"].includes(mode)) {
      Object.assign(state, { status: mode === "failed replacement" ? "failed" : "pending", receipt: null,
        lastGood: mode === "pending" ? null : { receipt: structuredClone(receipt), after: state.after } });
      if (mode === "old manifest") state.lastGood.receipt.manifest = [{ ...file, path: "/authors/old-profile/" }];
    }
    if (["expired", "withdrawal expired"].includes(mode)) {
      context.revision++;
      receipt.verifiedAt -= mode === "expired" ? background.MAX_STALE_MS : background.WITHDRAWAL_STALE_MS;
      if (mode === "withdrawal expired") context.withdrawalRevision++;
    }
    if (mode === "wrong owner") state.owner = "unknown";
    if (mode === "Post read failure") { state.contextOnly = false; state.postId = "source"; }
    if (mode === "invalid context") context.withdrawalRevision = -1;
    const pointer = { ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
      activeDeploymentId: "static-build", activeCommitSha: rendererSha, lastReservedGeneration: 1,
      newestEligibleGeneration: 1, newestEligibleBuildBatchId: "static-build" };
    const aggregate = { schemaVersion: 1, runtime: { owner: "cloudflare", release: rendererSha },
      operationId: "A".repeat(20), contextDigest: receipt.contextDigest, servingEstablished: true,
      baselineWithdrawalRevision: 0 };
    if (mode === "unestablished pass") { aggregate.servingEstablished = false; state.status = "pending"; state.receipt = null; }
    const staticMode = ["static owner", "static missing path"].includes(mode);
    const legacyOwner = staticMode || mode === "Post refusal";
    const document = { version: 1, status: "published", publiclyVisible: true,
      published: { sourceVersion: 1, publishedAt: "2026-01-01T00:00:00.000Z", metadata: { type: "post", slug: "source" }, blocks: [], authorIds: [] } };
    const dependency = background.dependency(document);
    const proof = { schemaVersion: 1, postId: "source", operationId: "B".repeat(20), sourceVersion: 1,
      visible: true, slug: "source", ownedSlugs: ["source"], snapshotDigest: dependency.digest,
      contextDigest: revision.publicContextDigest(context.revision), files: ["/posts/", "/feeds/news.xml", "/api/v1/content.json",
        "/pagefind/pagefind.js", "/search/meaning-index.json", "/_publication.json", "/_content-status.json", "/sitemap.xml", "/posts/source/",
        ...(mode === "static owner" ? [path] : [])].map(path => ({ path, bytes: bytes.length, digest: hash(bytes) })) };
    const owner = { schemaVersion: 1, mode: staticMode ? "static" : "dynamic", postId: "source",
      operationId: "B".repeat(20), sourceVersion: 1, visible: true, slug: "source", ownedSlugs: ["source"],
      rendererSha, servingEnabled: false, generation: 1, ...(staticMode ? { staticProof: proof } : {}) };
    const values = new Map([["cmsBackgroundOutputs/authors", mode === "missing" ? undefined : state],
      [revision.PUBLIC_CONTEXT_PATH, context], ["system/publicDeployment", pointer],
      ["system/publicDeployment/aggregateContexts/current", mode === "Assets pass" || legacyOwner ? undefined : aggregate]]);
    if (legacyOwner) {
      values.set("system/publicDeployment/noBuildPostOwners/source", owner);
      values.set("cmsPosts/source", document);
    }
    const row = path => ({ exists: values.has(path), data: () => values.get(path) });
    const failure = new Error("Firestore unavailable");
    const transaction = { get: async path => {
      if (path === "cmsPosts/source" && mode === "Post read failure") throw failure;
      return path === "system/publicDeployment/noBuildPostOwners" ? { docs: legacyOwner ? [{ id: "source", ref: "system/publicDeployment/noBuildPostOwners/source", data: () => owner }] : [] } : row(path);
    }, getAll: async (...paths) => paths.map(row) };
    const firestore = { doc: path => path, collection: path => path, runTransaction: async run => run(transaction) };
    const read = () => serving.readServingStaffAuthorPaths({ firestore, transaction, rendererSha, now: new Date(now), path });
    if (mode === "Post read failure") { await expect(read()).rejects.toBe(failure); return; }
    const paths = await read();
    const reader = background.createPostBackgroundOutputs({ firestore, now: () => now,
      readContextInTransaction: async () => ({ rendererSha, digest: revision.publicContextDigest(context.revision),
        withdrawalRevision: context.withdrawalRevision }), artifacts: { get: async key => key === file.key ? bytes : null } });
    if (mode === "Post refusal") { expect(paths.size).toBe(0); await expect(postReader.readNoBuildPostDecisionInTransaction({ firestore, transaction, rendererSha, path })).rejects.toMatchObject({ status: 409 }); return; }
    const namespace = await postReader.readNoBuildPostDecisionInTransaction({ firestore, transaction, rendererSha, path });
    const staticPass = ["Assets pass", "unestablished pass"].includes(mode);
    expect(namespace.kind === "pass").toBe(staticPass);
    const response = namespace.kind === "pass" ? new Response("Static author page", { status: 200 })
      : namespace.kind === "static" ? new Response(namespace.staticFile ? bytes : null, { status: namespace.staticFile ? 200 : 404 })
      : await reader.serve(new Request(`https://njpbs.org${path}`));
    const ready = ["promoted", "failed replacement", "static owner"].includes(mode);
    expect(paths === null).toBe(staticPass);
    expect(paths?.has(path) ?? staticPass).toBe(ready || staticPass);
    expect(response?.status === 200).toBe(ready || staticPass);
    if (ready) expect(await response.text()).toContain("New profile");
  },
);
