import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// Check routing before loading any database SDK or application module.
const project = process.env.NJPBS_RESTORE_DRILL_PROJECT;
const directory = process.env.NJPBS_RESTORE_DRILL_ROOT;
const phase = process.argv[2];
assert.match(project ?? "", /^demo-njpbs-restore-[a-f0-9]{8}$/);
assert.equal(process.env.GCLOUD_PROJECT, project);
assert.equal(process.env.GOOGLE_CLOUD_PROJECT, project);
assert.match(process.env.FIRESTORE_EMULATOR_HOST ?? "", /^127\.0\.0\.1:\d+$/);
assert(directory && ["seed", "verify"].includes(phase) && process.argv.length === 3);
const config = JSON.parse(await readFile(join(directory, "firebase.json"), "utf8"));
assert.equal(process.env.FIRESTORE_EMULATOR_HOST, `127.0.0.1:${config.emulators.firestore.port}`);

const { initializeApp, deleteApp } = await import("firebase-admin/app");
const { getFirestore, Timestamp } = await import("firebase-admin/firestore");
const { default: background } = await import("../../functions/lib/post-background-outputs.js");
const { default: manifests } = await import("../../functions/lib/post-background-record-manifest.js");
const { default: context } = await import("../../functions/lib/public-context-revision.js");
const { default: pilot } = await import("../../functions/lib/no-build-post-publication.js");
const { default: admission } = await import("../../functions/lib/no-build-post-admission.js");
const { default: deployment } = await import("../../functions/lib/public-deployment.js");
const app = initializeApp({ projectId: project });
const db = getFirestore(app);
const postId = "restore-fixture";
const queueId = "11111111111111111111";
const rendererSha = "a".repeat(40);
let now = Date.parse("2026-10-10T12:00:00Z");
const hash = value => createHash("sha256").update(value).digest("hex");
// Firestore map order is not part of the data contract. Timestamp.toJSON keeps
// seconds/nanoseconds in the comparison, and array order remains significant.
const documentDigest = value => hash(JSON.stringify(value, (_, child) =>
  child && typeof child === "object" && !Array.isArray(child)
    ? Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]])) : child));
const routes = { listings: ["/posts/", "/posts/page/2/"], authors: ["/authors/fixture/"],
  feed: ["/feeds/news.xml"], contentApi: ["/api/v1/content.json"], sitemap: ["/sitemap-index.xml"],
  search: ["/pagefind/pagefind.js", "/pagefind/fragment.pf_fragment", "/search/meaning-index.json"] };
const artifactRoot = join(directory, phase === "seed" ? "source-artifacts" : "restored-artifacts");
const bytes = (output, path) => Buffer.from(`Synthetic published ${output}: ${path}\n`);
const artifactPath = key => {
  assert.match(key, /^post-background-v1\/[A-Za-z]+\/[a-f0-9-]+\/(?:[a-f0-9]{64}|manifest\.json)$/);
  return join(artifactRoot, key);
};
const artifacts = {
  async put(key, value) {
    const path = artifactPath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value, { flag: "wx" });
  },
  get: key => readFile(artifactPath(key)),
};
const owner = background.createPostBackgroundOutputs({ firestore: db, enabled: true, postIds: [postId],
  contentApiEnabled: true, artifacts, now: () => now, searchFileCount: routes.search.length,
  readContextInTransaction: transaction => context.readPublicBackgroundContextInTransaction(transaction, db),
  build: async task => ({ input: { kind: "public-background", rendererSha, contextDigest: task.contextDigest,
    routes: [{ path: "/posts/restore-fixture/", sourceVersion: 2, digest: task.dependencies.after.digest }] },
  files: routes[task.output].map(path => ({ path, contentType: "text/plain", bytes: bytes(task.output, path) })) }),
});
const read = path => owner.serve(new Request(`https://example.test${path}`));

async function seed() {
  assert.equal((await db.listCollections()).length, 0, "Seed target must be empty");
  const pointer = { ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
    activeDeploymentId: "11111111-1111-4111-8111-111111111111", activeCommitSha: rendererSha,
    lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "baseline", mediaLifecycleReady: true };
  deployment.assertPublicDeploymentPointer(pointer);
  const state = { schemaVersion: 1, postId, rendererSha, servingEnabled: true, generation: 1,
    operationId: queueId, sourceVersion: 2, slug: "restore-fixture", visible: true, ownedSlugs: ["restore-fixture"] };
  pilot.validateState(state);
  await db.doc("system/publicDeployment").set(pointer);
  await db.doc(context.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 1 });
  await db.doc(pilot.STATE_PATH).set(state);
  await db.doc(admission.ADMISSION_PATH).set({ schemaVersion: 1, revision: 1, enabled: true,
    postId, backgroundBucket: "restore-fixture-artifacts" });
  const post = { version: 3, title: "PRIVATE draft must not be served", publiclyVisible: true,
    published: { sourceVersion: 2, publishedAt: "2026-10-10T12:00:00Z", authorIds: [], blocks: [],
      metadata: { type: "post", slug: "restore-fixture", title: "Synthetic published Post", credits: [] } } };
  await db.runTransaction(async transaction => {
    const write = await owner.prepareInTransaction({ transaction, queueId, postId, nextDocument: post, homePlacementPaths: [] });
    transaction.set(db.doc(`cmsPosts/${postId}`), post);
    transaction.set(db.doc(`cmsPublishQueue/${queueId}`), { status: "success", transport: "post-no-build-v1" });
    transaction.set(db.doc(`cmsVersionHistory/${queueId}`), { sourceVersion: 2, createdAt: Timestamp.fromMillis(now) });
    write();
  });
  await owner.recover();
  const expected = [];
  // Save a hash inventory of every document, including nested collections.
  async function capture(collections) {
    for (const collection of collections) {
      for (const ref of await collection.listDocuments()) {
        const doc = await ref.get();
        if (doc.exists) expected.push({ path: ref.path, digest: documentDigest(doc.data()) });
        await capture(await ref.listCollections());
      }
    }
  }
  await capture(await db.listCollections());
  await writeFile(join(directory, "expected-documents.json"), JSON.stringify(expected));
  for (const [output, paths] of Object.entries(routes)) {
    assert.equal((await db.doc(`cmsBackgroundOutputs/${output}`).get()).data().status, "verified");
    for (const path of paths) assert.equal(await (await read(path)).text(), bytes(output, path).toString());
  }
}

async function verify() {
  const expected = JSON.parse(await readFile(join(directory, "expected-documents.json"), "utf8"));
  for (const { path, digest } of expected) {
    const doc = await db.doc(path).get();
    assert(doc.exists, `Restore omitted ${path}`);
    assert.equal(documentDigest(doc.data()), digest, `Restore changed ${path}`);
  }
  const pointer = (await db.doc("system/publicDeployment").get()).data();
  deployment.assertPublicDeploymentPointer(pointer);
  assert.equal(pointer.activeCommitSha, rendererSha);
  pilot.validateState((await db.doc(pilot.STATE_PATH).get()).data());
  const decision = await pilot.readNoBuildPostDecision({ firestore: db, path: "/posts/restore-fixture/", rendererSha });
  assert.equal(decision.kind, "post");
  assert.equal(decision.receipt.sourceVersion, 2);
  assert.equal(decision.receipt.admissionRevision, 1);
  assert.equal(decision.published.document.published.metadata.title, "Synthetic published Post");
  assert(!JSON.stringify(decision).includes("PRIVATE draft"));
  const admissionRef = db.doc(admission.ADMISSION_PATH);
  const restoredAdmission = (await admissionRef.get()).data();
  await admissionRef.delete();
  await assert.rejects(pilot.readNoBuildPostDecision({ firestore: db, path: "/posts/restore-fixture/", rendererSha }));
  await admissionRef.set(restoredAdmission);
  await assert.rejects(pilot.readNoBuildPostDecision({ firestore: db, path: "/posts/restore-fixture/", rendererSha: "b".repeat(40) }));
  for (const [output, paths] of Object.entries(routes)) {
    for (const path of paths) {
      const response = await read(path);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), bytes(output, path).toString());
    }
    const state = (await db.doc(`cmsBackgroundOutputs/${output}`).get()).data();
    const files = state.receipt.fileManifest ? await manifests.readRecordManifest({ receipt: state.receipt, output,
      artifacts, signal: new AbortController().signal, scope: project }) : state.receipt.manifest;
    const file = files[0];
    const path = artifactPath(file.key);
    const original = await readFile(path);
    await rm(path);
    assert.equal((await read(file.path)).status, 503, `${output} must refuse missing bytes`);
    await writeFile(path, Buffer.alloc(original.length, 120));
    assert.equal((await read(file.path)).status, 503, `${output} must refuse corrupt bytes`);
    await writeFile(path, original);
    assert.equal((await read(file.path)).status, 200);
  }
  assert.equal((await read("/posts/page/999/")).status, 404);
  // A restored withdrawal must still fence pre-withdrawal artifacts.
  await db.runTransaction(async transaction => {
    transaction.update(db.doc(`cmsPosts/${postId}`), { publiclyVisible: false });
    transaction.update(db.doc(pilot.STATE_PATH), { visible: false });
    context.bumpPublicContextRevision(transaction, db, { withdrawal: true });
  });
  const gone = await pilot.readNoBuildPostDecision({ firestore: db, path: "/posts/restore-fixture/", rendererSha });
  assert.equal(gone.kind, "gone");
  // The background contract permits 60 seconds of last-good listing bytes.
  for (const paths of Object.values(routes)) {
    const response = await read(paths[0]);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-njpbs-background-state"), "stale");
  }
  now += 60_000;
  for (const paths of Object.values(routes)) assert.equal((await read(paths[0])).status, 503);
  await writeFile(join(directory, "verified.json"), JSON.stringify({ documents: expected.length,
    families: Object.keys(routes).length, artifactFiles: Object.values(routes).flat().length,
    checks: ["native-export-import", "nested-documents-and-timestamps", "runtime-admission", "missing-admission", "published-version", "renderer-mismatch",
      "all-family-bytes", "missing-bytes", "corrupt-bytes", "removed-route", "withdrawal-fence"] }));
}

try {
  await (phase === "seed" ? seed() : verify());
} finally {
  await db.terminate();
  await deleteApp(app);
}
