import { Timestamp } from "firebase-admin/firestore";
import deployment from "../../../functions/lib/public-deployment.js";
import ownership from "../../../functions/lib/no-build-page-ownership.js";
import snapshots from "../../../functions/lib/publish-snapshot.js";
import media from "../../../functions/lib/media-contract.js";
import home from "../../../site/tests/fixtures/home-composition-v1.json";

export const rendererSha = "a".repeat(40);
export const publishedAt = "2026-10-12T11:00:00.000Z";
export const postCount = 20;

export function pageDocument(title = "Fixture contact") {
  const document = { version: 7, title, blocks: [
    { id: "heading", type: "headline", order: 0, visible: true, data: { text: title, level: 2 } },
  ] };
  return { ...document, version: 8, status: "draft", publiclyVisible: true,
    title: "PRIVATE working title", published: snapshots.createPublishedSnapshot({
      collection: "cmsPages", document, publishedAt, publishedBy: "PRIVATE fixture actor",
    }) };
}

export async function seedHomeDecisionFixture(firestore) {
  const batch = firestore.batch();
  batch.set(firestore.doc("system/publicDeployment"), { ...deployment.initialPublicDeploymentPointer(),
    activeGeneration: 5, lastReservedGeneration: 5, newestEligibleGeneration: 5,
    newestEligibleBuildBatchId: "context-fixture", activeDeploymentId: "context-fixture", activeCommitSha: rendererSha });
  batch.set(firestore.doc("system/publicDeployment/contexts/public"), {
    schemaVersion: 1, revision: 4, changedAt: Timestamp.fromDate(new Date(publishedAt)),
  });
  batch.set(firestore.doc(ownership.PAGE_CAPABILITY_PATH), { schemaVersion: 1, rendererSha, servingEnabled: true, generation: 5 });
  batch.set(firestore.doc("cmsPages/contact"), pageDocument());
  batch.set(firestore.doc("cmsPages/home"), { ...home, version: 8, status: "draft", publiclyVisible: true,
    published: snapshots.createPublishedSnapshot({ collection: "cmsPages", document: home,
      publishedAt, publishedBy: "PRIVATE fixture actor" }) });
  for (let index = 0; index < 13; index++) {
    const authorId = `au_${index.toString(16).padStart(32, "0")}`;
    batch.set(firestore.doc(`cmsAuthorProfilesPublic/${authorId}`), {
      authorId, slug: `fixture-author-${index}`, displayName: `Fixture author ${index}`,
      snapshotVersion: 1, bio: "Synthetic public biography for the decision fixture. ".repeat(10),
    });
  }
  for (let index = 0; index < postCount; index++) {
    const id = `fixture-post-${String(index).padStart(2, "0")}`;
    const assetId = `fixture-image-${index}`;
    const authorId = `au_${(index % 13).toString(16).padStart(32, "0")}`;
    batch.set(firestore.doc(`cmsPosts/${id}`), { version: 2, status: "published", publiclyVisible: true,
      publishAt: publishedAt, published: { sourceVersion: 1, publishedAt, blocks: [],
        publishedBy: "PRIVATE fixture actor", metadata: {
          type: "post", title: `Fixture Post ${index}`, slug: id, locale: "en", categories: [], tags: [],
          heroImage: assetId, credits: [{ kind: "registered", authorId,
            displayName: `Fixture author ${index % 13}`, slug: `fixture-author-${index % 13}` }],
        } } });
    const asset = { id: assetId, source: "site_seed", lifecycle: "active", kind: "image",
      url: `https://media.njpbs.org/cms-media/${assetId}/fixture.webp`, altText: "Fixture image",
      mimeType: "image/webp", width: 640, height: 360 };
    batch.set(firestore.doc(`media_assets/${assetId}`), asset);
    batch.set(firestore.doc(`media_assets_public/${assetId}`), JSON.parse(JSON.stringify(media.mediaProjection(asset))));
  }
  await batch.commit();
}

export async function seedOwnedHomeDecisionFixture(firestore) {
  const document = (await firestore.doc("cmsPages/home").get()).data();
  const operationId = "H".repeat(20);
  const ownedPaths = ["/", "/_home-sources.json"];
  const state = { schemaVersion: 1, pageId: "home", rendererSha, servingEnabled: true,
    generation: 5, operationId, sourceVersion: document.published.sourceVersion, visible: true,
    path: "/", ownedPaths, snapshotDigest: ownership.digest(document.published),
    runtime: { owner: "cloudflare", release: rendererSha } };
  const batch = firestore.batch();
  batch.set(firestore.doc("system/noBuildPostAdmission"), { schemaVersion: 2, revision: 7, enabled: true,
    families: { posts: { mode: "all" }, pages: { mode: "all" } }, backgroundBucket: "njpbs-dev-public-artifacts" });
  batch.set(firestore.doc("system/publicDeployment/noBuildPageOwners/home"), state);
  for (const path of ownedPaths) batch.set(ownership.pageRouteRef(firestore, path), { schemaVersion: 1, pageId: "home", path });
  batch.set(firestore.doc("cmsBackgroundOutputs/home"), { schemaVersion: 1, owner: "page-no-build-v1",
    output: "home", pageId: "home", ownerPath: "system/publicDeployment/noBuildPageOwners/home", operationId,
    retainedSource: null });
  await batch.commit();
}
