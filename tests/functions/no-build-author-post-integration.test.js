import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import "../../functions/lib/firebase.js";
import save from "../../functions/save.js";
import authorApi from "../../functions/author-profiles.js";
import authorStore from "../../functions/lib/author-profile-store.js";
import deployment from "../../functions/lib/public-deployment.js";
import registry from "../../functions/lib/no-build-post-ownership.js";
import publicContent from "../../functions/public-content.js";
import { createNoBuildPostWorker } from "../../workers/src/no-build-post-worker";
import { resolvePublicCreditLinks } from "../../site/src/lib/public-author-links";
import { postPublicPath } from "../../site/src/lib/public-content-routes";
const db = isolatedFirestore("no-build-author-post-integration.test.js");

// Ada's identity and story come from posts-authors.e2e.test.ts. Jules's Q2
// requires current public names, with the frozen name when no public row exists.
const authorId = `au_${"1".repeat(32)}`;
const sha = "a".repeat(40);
const publishedAt = "2026-08-20T14:00:00.000Z";
const quiet = { info() {}, warn() {}, error() {} };
const editor = {
  uid: "ada-editor",
  email: "ada@example.test",
  principal: { id: "ada-editor", grants: [{ role: "editor", sections: ["news"] }] },
};
const admin = {
  uid: "profile-admin",
  email: "admin@example.test",
  role: "super_admin",
  principal: { id: "profile-admin", grants: [{ role: "super_admin" }] },
};
const frozenCredits = [
  { kind: "registered", authorId, displayName: "Ada Reporter", slug: "ada-reporter" },
  { kind: "custom", name: "NJ PBS staff" },
];

async function invoke(handler, body) {
  const response = {
    code: 200,
    headersSent: false,
    status(code) { this.code = code; return this; },
    set() { return this; },
    json(value) { this.body = value; this.headersSent = true; return this; },
  };
  await handler({ method: "POST", body, headers: {}, ip: "127.0.0.1" }, response);
  expect({ status: response.code, error: response.body?.error ?? null }).toEqual({ status: 200, error: null });
  return response.body;
}

function authorDependencies(actor = editor) {
  return { firestore: db, requirePrincipalFn: async () => actor, log: quiet };
}

async function changeAuthor(handler, changes) {
  const profile = (await db.doc(`cmsAuthorProfiles/${authorId}`).get()).data();
  return invoke(handler, { expectedVersion: profile.version, ...changes });
}

const editAuthor = changes => changeAuthor(authorApi.createUpdateAuthorProfileHandler(authorDependencies()), changes);
const setVisibility = visibility => changeAuthor(
  authorApi.createSetAuthorProfileVisibilityHandler(authorDependencies()), { visibility },
);
const renameAuthor = slug => changeAuthor(
  authorApi.createAdminUpdateAuthorProfileHandler(authorDependencies(admin)), { action: "rename", authorId, slug },
);

async function publishPost() {
  const handler = save.createCmsSaveHandler({
    firestore: db,
    requirePrincipalFn: async () => editor,
    now: () => publishedAt,
    enablePublishSnapshot: true,
    log: quiet,
    assertPublishReadyFn: async () => { throw new Error("Full-build readiness cannot admit this Post"); },
  });
  const saved = await invoke(handler, {
    collection: "cmsPosts",
    section: "news",
    document: {
      type: "post",
      title: "Trenton budget hearing draws a crowd",
      summary: "Residents filled the room.",
      tags: ["budget"],
      categories: [],
      credits: [{ kind: "registered", authorId }, { kind: "custom", name: "NJ PBS staff" }],
      blocks: [{ id: "body", type: "prose", order: 0, visible: true, data: {
        content: { type: "doc", content: [{ type: "paragraph", content: [
          { type: "text", text: "The hearing ran two hours." },
        ] }] },
      } }],
    },
  });
  const result = await invoke(handler, {
    collection: "cmsPosts", id: saved.document.id, baseVersion: saved.document.version, publish: true, document: {},
  });
  // Address the server-owned published route. The response supplies the request
  // identity; byline and rendering expectations remain independent fixture values.
  return { ...result, path: postPublicPath(result.document.published.metadata.slug) };
}

async function decision(requestPath, method = "GET") {
  const result = await invoke(publicContent.createCmsGetPublicPageHandler({ firestore: db, log: quiet }),
    { mode: "no-build-post-v1", path: requestPath, rendererSha: sha, method });
  // Model the JSON boundary used by the private reader service.
  return JSON.parse(JSON.stringify(result));
}

function renderByline(content) {
  const credits = resolvePublicCreditLinks(content.posts[0].credits, content.authors);
  const byline = credits.map(credit => credit.slug
    ? `<a href="/authors/${credit.slug}/">${credit.name}</a>` : credit.name).join(" and ");
  return `<!doctype html><html><body><h1>${content.posts[0].title}</h1><p>By ${byline}</p></body></html>`;
}

function worker(requestPath, render = renderByline) {
  const entries = new Map();
  const inputs = [];
  const serving = createNoBuildPostWorker({
    rendererSha: sha,
    getDecision: decision,
    cache: {
      async match(request) { return entries.get(request.url)?.clone(); },
      async put(request, response) { entries.set(request.url, response.clone()); },
    },
    async render(content) { inputs.push(content); return render(content); },
    async fetchAsset() { throw new Error("Post detail cannot fall back to static Assets"); },
  });
  return { inputs, request: () => serving.fetch(new Request(`https://njpbs.org${requestPath}`)) };
}

async function expectByline(serving, byline, cache) {
  const response = await serving.request();
  expect(response.status).toBe(200);
  expect(response.headers.get("x-njpbs-render-cache")).toBe(cache);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toContain(`<p>By ${byline}</p>`);
  return response;
}

async function retainedPublication(postId) {
  return {
    post: (await db.doc(`cmsPosts/${postId}`).get()).data(),
    owner: (await registry.readNoBuildPostOwner({ firestore: db, postId })).state,
    queues: (await db.collection("cmsPublishQueue").get()).docs.map(row => ({ id: row.id, ...row.data() })),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") ||
      !/^demo-njpbs(?:-[a-z0-9-]+)?$/.test(db.projectId)) {
    throw new Error("Use a local demo Firestore emulator");
  }
});

beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${db.projectId}/databases/(default)/documents`,
    { method: "DELETE" }, db);
  await db.doc("system/noBuildPostAdmission").set({ schemaVersion: 2, revision: 1, enabled: true,
    families: { posts: { mode: "all" } }, backgroundBucket: "fixture-bucket" });
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(),
    activeGeneration: 1, activeDeploymentId: "11111111-1111-4111-8111-111111111111", activeCommitSha: sha,
    lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "baseline", mediaLifecycleReady: true });
  await db.doc(registry.CAPABILITY_PATH).set({ schemaVersion: 2, rendererSha: sha, servingEnabled: true, generation: 1 });
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 1 });
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: sha,
    serializerId: "node-compute-publisher", cloud: { phase: "ready", commitSha: sha, serializerId: "cloudflare-publisher" } });
  await db.doc("sections/news").set({ label: "News" });
  for (const actor of [editor, admin]) {
    await db.doc(`users/${actor.uid}`).set({ email: actor.email, displayName: "Ada Reporter", active: true,
      role: actor.role ?? null, grants: actor.role ? [] : actor.principal.grants });
  }
  await authorStore.ensureAuthorIdentity({ firestore: db, uid: editor.uid, nowIso: publishedAt,
    actorUid: editor.uid, actorEmail: editor.email, randomHex: "1".repeat(32), requireAuthoringAccess: true });
});

describe("registered authors through the real build-free Post boundary", () => {
  it("admits an ordinary Editor's registered and custom byline in the existing cloud queue and owner", async () => {
    await setVisibility("published");
    const result = await publishPost();
    expect(result.publication.transport).toBe("post-no-build-v1");
    const retained = await retainedPublication(result.document.id);
    expect(retained.post.published.sourceVersion).toBe(2);
    expect(retained.post.credits).toEqual([{ kind: "registered", authorId }, { kind: "custom", name: "NJ PBS staff" }]);
    expect(retained.post.published.metadata.credits).toEqual(frozenCredits);
    expect(retained.owner).toMatchObject({ postId: result.document.id, operationId: result.publication.queueId,
      sourceVersion: 2, runtime: { owner: "cloudflare", release: sha } });
    expect(retained.queues).toHaveLength(1);
    expect(retained.queues[0]).toMatchObject({ id: result.publication.queueId, transport: "post-no-build-v1",
      backgroundRuntime: { owner: "cloudflare", release: sha } });
    const reply = await decision(result.path);
    expect(reply.kind).toBe("post");
    expect(reply.receipt).toMatchObject({ postId: result.document.id,
      operationId: result.publication.queueId, sourceVersion: 2 });
    expect(reply.receipt.ownedSlugs).toContain(result.document.published.metadata.slug);
    expect(reply.published.document.published.metadata.credits).toEqual(frozenCredits);
    expect(reply.published.authors).toEqual([expect.objectContaining({ id: authorId, authorId,
      displayName: "Ada Reporter", slug: "ada-reporter" })]);
    const serving = worker(result.path);
    await expectByline(serving, '<a href="/authors/ada-reporter/">Ada Reporter</a> and NJ PBS staff', "MISS");
    expect(serving.inputs[0].posts[0].credits).toEqual([
      { authorId, name: "Ada Reporter", slug: "ada-reporter" }, { name: "NJ PBS staff" },
    ]);
  });

  it("changes public names and links without republishing the Post, with frozen fallback for withdrawal and private edits", async () => {
    await setVisibility("published");
    const result = await publishPost();
    const retained = await retainedPublication(result.document.id);
    const serving = worker(result.path);
    const first = await expectByline(serving, '<a href="/authors/ada-reporter/">Ada Reporter</a> and NJ PBS staff', "MISS");
    await expectByline(serving, '<a href="/authors/ada-reporter/">Ada Reporter</a> and NJ PBS staff', "HIT");

    await editAuthor({ displayName: "Ada Current" });
    await renameAuthor("ada-current");
    const current = await expectByline(serving, '<a href="/authors/ada-current/">Ada Current</a> and NJ PBS staff', "MISS");
    expect(current.headers.get("x-njpbs-context-sha256")).not.toBe(first.headers.get("x-njpbs-context-sha256"));
    expect(current.headers.get("x-njpbs-input-sha256")).not.toBe(first.headers.get("x-njpbs-input-sha256"));
    expect(current.headers.get("x-njpbs-source-version")).toBe("2");
    expect(serving.inputs.at(-1).authors[0]).toMatchObject({ authorId, displayName: "Ada Current", slug: "ada-current" });
    expect(serving.inputs.at(-1).posts[0].credits[0]).toEqual({ authorId, name: "Ada Reporter", slug: "ada-reporter" });
    await expectByline(serving, '<a href="/authors/ada-current/">Ada Current</a> and NJ PBS staff', "HIT");

    await setVisibility("private");
    expect((await db.doc(`cmsAuthorProfilesPublic/${authorId}`).get()).exists).toBe(false);
    const withdrawn = await expectByline(serving, "Ada Reporter and NJ PBS staff", "MISS");
    expect(withdrawn.headers.get("x-njpbs-context-sha256")).not.toBe(current.headers.get("x-njpbs-context-sha256"));
    expect(serving.inputs.at(-1).authors).toEqual([]);
    await expectByline(serving, "Ada Reporter and NJ PBS staff", "HIT");

    await editAuthor({ displayName: "Private Ada draft" });
    const privateDraft = await expectByline(serving, "Ada Reporter and NJ PBS staff", "HIT");
    expect(privateDraft.headers.get("x-njpbs-context-sha256")).toBe(withdrawn.headers.get("x-njpbs-context-sha256"));
    const privateReply = await decision(result.path);
    expect(privateReply.published.authors).toEqual([]);
    expect(privateReply.published.document.published.metadata.credits).toEqual(frozenCredits);
    expect(JSON.stringify(privateReply)).not.toContain("Private Ada draft");

    await editAuthor({ displayName: "Ada Republished" });
    await setVisibility("published");
    await expectByline(serving, '<a href="/authors/ada-current/">Ada Republished</a> and NJ PBS staff', "MISS");
    await expectByline(serving, '<a href="/authors/ada-current/">Ada Republished</a> and NJ PBS staff', "HIT");
    expect(await retainedPublication(result.document.id)).toEqual(retained);
  });

  it("admits a registered author with no public profile and keeps private name changes out of a populated cache", async () => {
    const result = await publishPost();
    const retained = await retainedPublication(result.document.id);
    expect(retained.post.published.metadata.credits).toEqual([
      { kind: "registered", authorId, displayName: "Ada Reporter" }, { kind: "custom", name: "NJ PBS staff" },
    ]);
    const serving = worker(result.path);
    await expectByline(serving, "Ada Reporter and NJ PBS staff", "MISS");
    await expectByline(serving, "Ada Reporter and NJ PBS staff", "HIT");
    await editAuthor({ displayName: "Private Ada draft" });
    await expectByline(serving, "Ada Reporter and NJ PBS staff", "HIT");
    expect((await decision(result.path)).published.authors).toEqual([]);
    expect(await retainedPublication(result.document.id)).toEqual(retained);
  });

  it.each(["edit", "withdrawal"])("refuses a late cache fill when a real author %s commits during rendering", async mutation => {
    await setVisibility("published");
    const result = await publishPost();
    const retained = await retainedPublication(result.document.id);
    const started = deferred();
    const release = deferred();
    const serving = worker(result.path, async content => {
      if (content.authors[0]?.displayName === "Ada Current") {
        started.resolve(content);
        await release.promise;
      }
      return renderByline(content);
    });
    await expectByline(serving, '<a href="/authors/ada-reporter/">Ada Reporter</a> and NJ PBS staff', "MISS");
    await expectByline(serving, '<a href="/authors/ada-reporter/">Ada Reporter</a> and NJ PBS staff', "HIT");
    await editAuthor({ displayName: "Ada Current" });
    const pending = serving.request();
    try {
      const oldInput = await started.promise;
      expect(oldInput.target.sourceVersion).toBe(2);
      expect(oldInput.authors[0]).toMatchObject({ authorId, displayName: "Ada Current" });
      if (mutation === "edit") await editAuthor({ displayName: "Ada Latest" });
      else await setVisibility("private");
    } finally {
      release.resolve();
    }
    const stale = await pending;
    expect(stale.status).toBe(503);
    expect(stale.headers.get("cache-control")).toBe("no-store");
    expect(await stale.text()).not.toMatch(/Ada Current|Ada Reporter/);
    const byline = mutation === "edit"
      ? '<a href="/authors/ada-reporter/">Ada Latest</a> and NJ PBS staff' : "Ada Reporter and NJ PBS staff";
    await expectByline(serving, byline, "MISS");
    await expectByline(serving, byline, "HIT");
    expect(await retainedPublication(result.document.id)).toEqual(retained);
  });
});
