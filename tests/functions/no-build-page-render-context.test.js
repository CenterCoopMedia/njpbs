import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import context from "../../functions/lib/no-build-page-render-context.js";
import contextDecision from "../../functions/lib/no-build-page-context-decision.js";
import ownership from "../../functions/lib/no-build-page-ownership.js";
import deployment from "../../functions/lib/public-deployment.js";
import snapshots from "../../functions/lib/publish-snapshot.js";
import media from "../../functions/lib/media-contract.js";
import homeFixture from "../../site/tests/fixtures/home-composition-v1.json";
import postReader from "../../functions/published-post-reader.js";
import { releaseSelector } from "../helpers/private-public-release-pair.js";

const rendererSha = "a".repeat(40);
const now = new Date("2026-10-12T12:00:00.000Z");
const staffAuthorId = `au_${"a".repeat(32)}`;
const ownedPaths = ["cmsPages/contact", "cmsPosts/program-one", "media_assets/program-image",
  "media_assets_public/program-image", "system/media/replacements/program-image", "system/publicDeployment",
  "system/publicDeployment/contexts/public", ownership.pageRouteRef({ doc: path => path }, "/contact/"), "cmsPages/home", "cmsPosts/native-live",
  "cmsPages/staff", `cmsAuthorProfilesPublic/${staffAuthorId}`, "cmsSettings/public-homepage-banner",
  "system/publicDeployment/noBuildPageOwners/contact", "cmsPages/give", `cmsPages/page-${"3".repeat(32)}`,
  ...Array.from({ length: 201 }, (_, index) => `cmsPosts/historical-${index}`)];
let app;
let firestore;
function document(title = "Frozen Page") {
  const working = { version: 7, title, blocks: [
    { id: "heading", type: "headline", order: 0, visible: true, data: { text: title, level: 2 } },
  ] };
  const published = snapshots.createPublishedSnapshot({ collection: "cmsPages", document: working,
    publishedAt: "2026-10-12T11:00:00.000Z", publishedBy: "PRIVATE actor" });
  return { ...working, version: 8, title: "PRIVATE new draft", blocks: [], status: "draft", publiclyVisible: true, published };
}
const read = options => firestore.runTransaction(transaction => context.assertNoBuildPageContextInTransaction({
  firestore, transaction, pageId: "contact", rendererSha, now, ...options,
}), { readOnly: true });

it("reads a pinned Page's immutable public fields and safely omits withdrawn, deleted, absent and expired Page pins", async () => {
  const homeHero = { mode: "tag", source: "cms_posts", value: "home", pins: [{ source: "cms_pages", sourceId: "contact" }] };
  const published = snapshots.createPublishedSnapshot({ collection: "cmsPages", document: { ...homeFixture, homeHero },
    publishedAt: "2026-10-12T11:00:00.000Z", publishedBy: "PRIVATE actor" });
  await firestore.doc("cmsPages/home").set({ ...homeFixture, version: 8, status: "draft", publiclyVisible: true, published });
  const result = await read({ pageId: "home" });
  expect(result.homeHeroPages).toMatchObject([{ pageId: "contact", title: "Frozen Page", path: "/contact/", sourceVersion: 7 }]);
  expect(JSON.stringify(result.homeHeroPages)).not.toMatch(/PRIVATE|publishedBy/);
  for (const patch of [{ publiclyVisible: false }, { publiclyVisible: true, deleted: true }]) {
    await firestore.doc("cmsPages/contact").update(patch);
    expect(await read({ pageId: "home" })).not.toHaveProperty("homeHeroPages");
  }
  await firestore.doc("cmsPages/contact").set(document());
  await firestore.doc("cmsPages/home").update({ "published.metadata.homeHero.pins": [{ source: "cms_pages", sourceId: "contact", endsAt: now.toISOString() }] });
  expect(await read({ pageId: "home" })).not.toHaveProperty("homeHeroPages");
  await firestore.doc("cmsPages/home").update({ "published.metadata.homeHero.pins": [{ source: "cms_pages", sourceId: "missing-page" }] });
  expect(await read({ pageId: "home" })).not.toHaveProperty("homeHeroPages");
});
it.each(["pending replacement", "missing media", "retired media", "unready media fence", "invalid snapshot"])(
  "drops a Page pin with %s while retaining another valid Page pin", async reason => {
    const pageId = `page-${"3".repeat(32)}`;
    const homeHero = { mode: "tag", source: "cms_posts", value: "home", pins: [
      { source: "cms_pages", sourceId: pageId }, { source: "cms_pages", sourceId: "give" },
    ] };
    const published = snapshots.createPublishedSnapshot({ collection: "cmsPages", document: { ...homeFixture, homeHero },
      publishedAt: "2026-10-12T11:00:00.000Z", publishedBy: "PRIVATE actor" });
    await firestore.doc("cmsPages/home").set({ ...homeFixture, version: 8, status: "draft", publiclyVisible: true, published });
    await firestore.doc("cmsPages/give").set(document("Safe public Page"));
    const broken = document();
    broken.published.metadata.slug = "pinned-page";
    broken.published.blocks.push({ id: "body-art", type: "image", order: 1, visible: true,
      data: { assetId: "program-image", alt: "Body art" } });
    await firestore.doc(`cmsPages/${pageId}`).set(broken);
    const asset = { source: reason === "unready media fence" ? "upload" : "site_seed", lifecycle: "active", kind: "image",
      url: "https://media.njpbs.org/cms-media/program-image/fixture.webp", altText: "Body art",
      mimeType: "image/webp", width: 640, height: 360 };
    await firestore.doc("media_assets/program-image").set(asset);
    await firestore.doc("media_assets_public/program-image").set(JSON.parse(JSON.stringify(media.mediaProjection(asset))));
    await firestore.doc("system/publicDeployment").update({ mediaLifecycleReady: true });
    expect((await read({ pageId: "home" })).homeHeroPages.map(page => page.pageId)).toEqual([pageId, "give"]);
    if (reason === "pending replacement") await firestore.doc("system/media/replacements/program-image").set({ state: "pending" });
    if (reason === "missing media") await firestore.doc("media_assets/program-image").delete();
    if (reason === "retired media") await firestore.doc("media_assets/program-image").update({ lifecycle: "tombstoned" });
    if (reason === "unready media fence") await firestore.doc("system/publicDeployment").update({ mediaLifecycleReady: false });
    if (reason === "invalid snapshot") await firestore.doc(`cmsPages/${pageId}`).update({ "published.sourceVersion": 0 });
    const result = await read({ pageId: "home" });
    expect(result.homeHeroPages.map(page => page.pageId)).toEqual(["give"]);
    expect(result.homeHeroPages[0]).toMatchObject({ title: "Safe public Page", path: "/give/", sourceVersion: 7 });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  },
);
beforeAll(async () => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") ||
      process.env.GCLOUD_PROJECT !== "demo-njpbs") throw new Error("Use the local demo Firestore emulator");
  // The emulator holds the fixed dev database identity; no dev credentials or
  // external endpoint are used. Its project differs from the demo harness.
  app = initializeApp({ projectId: "njpbs-site-dev" }, "page-context-emulator");
  firestore = getFirestore(app);
  await firestore.doc("system/publicDeployment").get();
});
afterAll(async () => {
  if (firestore) {
    const batch = firestore.batch(); for (const path of ownedPaths) batch.delete(firestore.doc(path));
    await batch.commit();
  }
  if (app) await deleteApp(app);
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/njpbs-site-dev/databases/(default)/documents`, { method: "DELETE" });
  const batch = firestore.batch(); for (const path of ownedPaths) batch.delete(firestore.doc(path));
  batch.set(firestore.doc("system/publicDeployment"), { ...deployment.initialPublicDeploymentPointer(),
    activeGeneration: 5, lastReservedGeneration: 5, newestEligibleGeneration: 5,
    newestEligibleBuildBatchId: "context-fixture", activeDeploymentId: "context-fixture", activeCommitSha: rendererSha });
  batch.set(firestore.doc("system/publicDeployment/contexts/public"), { schemaVersion: 1, revision: 4 });
  batch.set(firestore.doc(ownership.PAGE_CAPABILITY_PATH), { schemaVersion: 1, rendererSha, servingEnabled: true, generation: 5 });
  batch.set(firestore.doc("cmsPages/contact"), document());
  await batch.commit();
});

it("reads public Page, chrome, navigation and a numeric context seal in one real authority transaction", async () => {
  const result = await read();
  expect(result.page).toMatchObject({ pageId: "contact", title: "Frozen Page", path: "/contact/", sourceVersion: 7 });
  expect(result.sourceSeal).toMatchObject({ rendererSha, contextRevision: 4 });
  expect(result.sourceSeal.contextDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(result.navigationPages).toContainEqual({ pageId: "contact", path: "/contact/" });
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|publishedBy|triggeredBy|privateNotes/);
  await firestore.doc("cmsPages/contact").update({ title: "PRIVATE later draft" });
  expect(await read()).toEqual(result);
});

it("validates the caller's next immutable snapshot before acceptance writes", async () => {
  const nextDocument = document("Next accepted Page");
  expect((await read({ nextDocument })).page.title).toBe("Next accepted Page");
  expect((await read()).page.title).toBe("Frozen Page");
  expect((await firestore.doc("cmsPages/contact").get()).data().title).toBe("PRIVATE new draft");
});

it("reads published joined cards without card bodies, actors or working library values", async () => {
  const page = document();
  page.published.blocks.push({ id: "card", type: "record_card", order: 1, visible: true,
    data: { recordKind: "program", recordId: "program-one" } });
  await firestore.doc("cmsPages/contact").set(page);
  await firestore.doc("cmsPosts/program-one").set({ status: "draft", publiclyVisible: true, version: 5,
    title: "PRIVATE program draft", published: { sourceVersion: 4, publishedAt: "2026-10-12T10:00:00.000Z",
      publishedBy: "PRIVATE actor", metadata: { type: "program", title: "Public program", slug: "public-program",
        locale: "en", firstPublishedBy: "PRIVATE actor", privateNote: "PRIVATE sibling" },
      blocks: [{ privateNote: "PRIVATE body" }] } });
  const result = await read();
  expect(result.joinedRecords[0].published.metadata.title).toBe("Public program");
  expect(result.joinedRecords[0].published.blocks).toEqual([]);
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
});

it("refuses mismatched or replacing joined public media before accepting a Page", async () => {
  const page = document();
  page.published.blocks.push({ id: "card", type: "record_card", order: 1, visible: true,
    data: { recordKind: "program", recordId: "program-one" } });
  await firestore.doc("cmsPages/contact").set(page);
  await firestore.doc("cmsPosts/program-one").set({ status: "published", publishAt: "2026-10-12T10:00:00.000Z", publiclyVisible: true,
    published: { sourceVersion: 4, publishedAt: "2026-10-12T10:00:00.000Z", blocks: [],
      metadata: { type: "program", title: "Public program", slug: "public-program", keyArtAssetId: "program-image" } } });
  const asset = { id: "program-image", source: "site_seed", lifecycle: "active", kind: "image",
    url: "https://media.njpbs.org/cms-media/program-image/fixture.webp", altText: "Program art",
    mimeType: "image/webp", width: 640, height: 360 };
  await firestore.doc("media_assets/program-image").set(asset);
  await firestore.doc("media_assets_public/program-image").set(JSON.parse(JSON.stringify(media.mediaProjection(asset))));
  expect((await read()).assets).toContainEqual({ id: "program-image", url: asset.url, mimeType: asset.mimeType, width: 640, height: 360 });
  await firestore.doc("system/media/replacements/program-image").set({ state: "pending" });
  await expect(read()).rejects.toThrow("replacement is pending");
  await firestore.doc("system/media/replacements/program-image").delete();
  await firestore.doc("media_assets_public/program-image").update({ width: 999 });
  await expect(read()).rejects.toThrow();
});

it.each(["wrong source", "busy code release", "invalid public revision", "withdrawal", "stale version"])(
  "refuses %s rather than selecting older context", async reason => {
    if (reason === "wrong source") await firestore.doc("system/publicDeployment").update({ activeCommitSha: "c".repeat(40) });
    if (reason === "busy code release") await firestore.doc("system/publicDeployment").update({ state: "deploying" });
    if (reason === "invalid public revision") await firestore.doc("system/publicDeployment/contexts/public").update({ revision: 0 });
    if (reason === "withdrawal") await firestore.doc("cmsPages/contact").update({ publiclyVisible: false });
    if (reason === "stale version") await firestore.doc("cmsPages/contact").update({ publicSourceVersion: 9 });
    await expect(read()).rejects.toThrow();
  },
);

it("refuses a mismatched target before it can read a Page dependency", async () => {
  await expect(context.assertNoBuildPageContextInTransaction({ firestore: { projectId: "njpbs-site" },
    target: (await import("../../functions/lib/publication-target.js")).default.publicationTarget("development"),
    pageId: "contact", rendererSha })).rejects.toThrow("mixed publication database");
});

it("counts current public Home Posts rather than retained withdrawn/deleted history", async () => {
  const published = snapshots.createPublishedSnapshot({ collection: "cmsPages", document: homeFixture,
    publishedAt: "2026-10-12T11:00:00.000Z", publishedBy: "PRIVATE actor" });
  const post = { version: 2, status: "published", publiclyVisible: true, deleted: false,
    publishAt: "2026-10-12T11:00:00.000Z", published: { sourceVersion: 1,
      publishedAt: "2026-10-12T11:00:00.000Z", publishedBy: "PRIVATE actor", blocks: [
        { id: "embed", type: "embed", order: 0, visible: true,
          data: { url: "https://example.test/embedded-story", caption: "Not part of the Home card" } },
        { id: "body-image", type: "image", order: 1, visible: true,
          data: { assetId: "body-only-unavailable", alt: "Body image" } },
      ],
      metadata: { type: "post", title: "Live native Post", slug: "live-native-post", locale: "en", categories: [], tags: [] } } };
  const batch = firestore.batch();
  batch.set(firestore.doc("cmsPages/home"), { ...homeFixture, version: 8, status: "draft", publiclyVisible: true, published });
  batch.set(firestore.doc("cmsPosts/native-live"), post);
  for (let index = 0; index < 201; index++) batch.set(firestore.doc(`cmsPosts/historical-${index}`), {
    ...post, publiclyVisible: false, deleted: index % 2 === 0, status: "archived",
    published: { ...post.published, metadata: { ...post.published.metadata, slug: `historical-post-${index}` } },
  });
  await batch.commit();
  const result = await read({ pageId: "home" });
  expect(result.posts.map(post => post.document.id)).toEqual(["native-live"]);
  expect(result.posts[0].kind).toBe("published-post-card");
  expect(result.posts[0].document.published.blocks).toEqual([]);
  await expect(postReader.readPublishedPost({ firestore, slug: "live-native-post", now }))
    .rejects.toThrow("Published content is unavailable");
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
  const visible = firestore.batch();
  for (let index = 0; index < 200; index++) visible.update(firestore.doc(`cmsPosts/historical-${index}`), {
    publiclyVisible: true, deleted: false, status: "published",
  });
  await visible.commit();
  await expect(read({ pageId: "home" })).rejects.toThrow("Home Post dependencies exceed the current bound");
});

it.each(["schedule", "live"])("retains the sealed lineup release gate for %s", async pageId => {
  await expect(context.assertNoBuildPageContextInTransaction({ firestore: { projectId: "njpbs-site-dev" },
    pageId, rendererSha, now })).rejects.toThrow("Schedule and Live require qualified sealed schedule authority");
});


it.each(["legacy", "image"])("Home lead media retains transient readiness refusals and omits retired assets (%s)", async kind => {
  const published = snapshots.createPublishedSnapshot({ collection: "cmsPages", document: homeFixture,
    publishedAt: "2026-10-12T11:00:00.000Z", publishedBy: "PRIVATE actor" });
  await firestore.doc("cmsPages/home").set({ ...homeFixture, version: 8, status: "draft", publiclyVisible: true, published });
  await firestore.doc("cmsPosts/native-live").set({ version: 2, status: "published", publiclyVisible: true,
    publishAt: "2026-10-12T11:00:00.000Z", published: { sourceVersion: 1, publishedAt: "2026-10-12T11:00:00.000Z", blocks: [],
      metadata: { type: "post", title: "Lead-only Post", slug: "lead-only-post", locale: "en", categories: [], tags: [], heroImage: "program-image",
        ...(kind === "image" ? { leadMedia: { kind: "image", data: { assetId: "program-image", alt: "County meeting" } } } : {}) } } });
  const asset = { source: "upload", lifecycle: "active", altText: "County meeting", url: "https://media.njpbs.org/cms-media/station/current.webp",
    mimeType: "image/webp", width: 1200, height: 800 };
  await firestore.doc("media_assets/program-image").set(asset);
  await firestore.doc("media_assets_public/program-image").set(JSON.parse(JSON.stringify(media.mediaProjection(asset))));
  await firestore.doc("system/publicDeployment").update({ mediaLifecycleReady: true });
  expect((await read({ pageId: "home" })).posts[0].assets[0].id).toBe("program-image");
  await firestore.doc("system/publicDeployment").update({ mediaLifecycleReady: false });
  await expect(read({ pageId: "home" })).rejects.toMatchObject({ readerCode: "reader_media_fence" });
  await firestore.doc("system/publicDeployment").update({ mediaLifecycleReady: true });
  await firestore.doc("system/media/replacements/program-image").set({ state: "pending" });
  await expect(read({ pageId: "home" })).rejects.toThrow("Home Post media replacement is pending");
  await firestore.doc("system/media/replacements/program-image").delete();
  await firestore.doc("media_assets_public/program-image").update({ width: 999 });
  await expect(read({ pageId: "home" })).rejects.toMatchObject({ readerCode: "reader_media_ineligible" });
  await firestore.doc("media_assets/program-image").update({ lifecycle: "tombstoned" });
  expect((await read({ pageId: "home" })).posts[0].assets).toEqual([]);
});

it("includes legacy-visible Home Posts and excludes explicit withdrawals before bounding live dependencies", async () => {
  const home = snapshots.createPublishedSnapshot({ collection: "cmsPages", document: homeFixture,
    publishedAt: "2026-10-12T11:00:00.000Z", publishedBy: "PRIVATE actor" });
  await firestore.doc("cmsPages/home").set({ ...homeFixture, version: 8, status: "draft", publiclyVisible: true, published: home });
  const legacy = { version: 2, status: "published", publishAt: "2026-10-12T11:00:00.000Z",
    published: { sourceVersion: 1, publishedAt: "2026-10-12T11:00:00.000Z", blocks: [],
      metadata: { type: "post", title: "Legacy public native Post", slug: "legacy-native", locale: "en", categories: [], tags: [] } } };
  const batch = firestore.batch(); batch.set(firestore.doc("cmsPosts/native-live"), legacy);
  for (let index = 0; index < 201; index++) batch.set(firestore.doc(`cmsPosts/historical-${index}`), {
    ...legacy, publiclyVisible: false, published: { ...legacy.published, metadata: { ...legacy.published.metadata, slug: `legacy-history-${index}` } },
  });
  await batch.commit();
  expect((await read({ pageId: "home" })).posts.map(post => post.document.id)).toEqual(["native-live"]);
});
it("refuses a malformed published Home banner while preserving missing/unpublished banners", async () => {
  const published = snapshots.createPublishedSnapshot({ collection: "cmsPages", document: homeFixture,
    publishedAt: "2026-10-12T11:00:00.000Z", publishedBy: "PRIVATE actor" });
  await firestore.doc("cmsPages/home").set({ ...homeFixture, version: 8, status: "draft", publiclyVisible: true, published });
  expect((await read({ pageId: "home" })).settings.some(setting => setting.id === "public-homepage-banner")).toBe(false);
  await firestore.doc("cmsSettings/public-homepage-banner").set({ version: 1, values: { message: "PRIVATE draft" } });
  expect((await read({ pageId: "home" })).settings.some(setting => setting.id === "public-homepage-banner")).toBe(false);
  await firestore.doc("cmsSettings/public-homepage-banner").set({ version: 2, published: { schemaVersion: 1, sourceVersion: 1,
    publishedAt: "2026-10-12T11:00:00.000Z", values: { enabled: true, message: 42 } } });
  await expect(read({ pageId: "home" })).rejects.toThrow();
});
it.each([{ slug: "Invalid Slug" }, { displayName: "" }, { snapshotVersion: 0 }])("refuses invalid detached Staff identity %j before acceptance", async invalid => {
  await firestore.doc("cmsPages/staff").set(document());
  await firestore.doc(`cmsAuthorProfilesPublic/${staffAuthorId}`).set({ slug: "staff-author", displayName: "Staff Author", snapshotVersion: 1, ...invalid });
  await expect(read({ pageId: "staff" })).rejects.toMatchObject({ readerCode: "reader_invalid_snapshot" });
});

it("keeps a new Staff profile visible but unlinked until its actual author manifest promotes", async () => {
  await firestore.doc("cmsPages/staff").set(document());
  await firestore.doc(`cmsAuthorProfilesPublic/${staffAuthorId}`).set({ slug: "staff-author", displayName: "Staff Author", snapshotVersion: 1 });
  const contextDigest = (await import("../../functions/lib/public-context-revision.js")).default.publicContextDigest(4);
  await firestore.doc("system/publicDeployment/aggregateContexts/current").set({ schemaVersion: 1,
    runtime: { owner: "cloudflare", release: rendererSha }, operationId: "A".repeat(20), contextDigest,
    servingEstablished: true, baselineWithdrawalRevision: 0 });
  const expected = { id: staffAuthorId, slug: "staff-author", displayName: "Staff Author", snapshotVersion: 1 };
  expect((await read({ pageId: "staff", legacyStaffServing: true })).authors).toContainEqual(expect.objectContaining({ ...expected, profilePageReady: false }));
  // Initial and retained pair captures do not opt into live link readiness.
  expect((await read({ pageId: "staff" })).authors[0]).not.toHaveProperty("profilePageReady");
  expect((await read({ pageId: "staff", strictPublicReleaseInputs: true, legacyStaffServing: true })).authors[0]).not.toHaveProperty("profilePageReady");
  await firestore.doc("cmsBackgroundOutputs/authors").set({ owner: "post-background-v1", schemaVersion: 1,
    output: "authors", status: "verified", contextOnly: true, revision: 1, contextDigest,
    after: { digest: "unused" }, receipt: { revision: 1, contextDigest, rendererSha, verifiedAt: now.getTime(),
      assets: [], manifest: [{ path: "/authors/staff-author/", size: 100, contentType: "text/html; charset=utf-8" }] } });
  expect((await read({ pageId: "staff", legacyStaffServing: true })).authors).toContainEqual(expect.objectContaining({ ...expected, profilePageReady: true }));
});
it("never adds live readiness to a paired site Staff frame even when its legacy pointer projection is schema one", async () => {
  const selector = releaseSelector();
  await firestore.doc("system/publicDeployment").set(selector);
  await firestore.doc(`cmsAuthorProfilesPublic/${staffAuthorId}`).set({ slug: "staff-author", displayName: "Staff Author", snapshotVersion: 1 });
  for (const legacyStaffServing of [false, true]) {
    const result = await firestore.runTransaction(transaction => contextDecision.readNoBuildPageContextDecision({
      firestore, transaction, path: "/staff/", rendererSha, now, legacyStaffServing,
    }), { readOnly: true });
    expect(result.kind).toBe("context-page");
    expect(result.renderContext.authors[0]).toMatchObject({ id: staffAuthorId });
    expect(result.renderContext.authors[0]).not.toHaveProperty("profilePageReady");
  }
});

it("refuses a saturated Home candidate read before it can certify a truncated public pool", async () => {
  const published = snapshots.createPublishedSnapshot({ collection: "cmsPages", document: homeFixture,
    publishedAt: "2026-10-12T11:00:00.000Z", publishedBy: "PRIVATE actor" });
  await firestore.doc("cmsPages/home").set({ ...homeFixture, version: 8, status: "draft", publiclyVisible: true, published });
  const paths = Array.from({ length: 1001 }, (_, index) => `cmsPosts/candidate-cap-${index}`);
  try {
    for (let offset = 0; offset < paths.length; offset += 400) {
      const batch = firestore.batch();
      for (const path of paths.slice(offset, offset + 400)) batch.set(firestore.doc(path), { status: "published", publiclyVisible: false,
        published: { metadata: { type: "post" } } });
      await batch.commit();
    }
    await expect(read({ pageId: "home" })).rejects.toThrow("candidate reads exceed the current bound");
  } finally {
    for (let offset = 0; offset < paths.length; offset += 400) {
      const batch = firestore.batch(); for (const path of paths.slice(offset, offset + 400)) batch.delete(firestore.doc(path));
      await batch.commit();
    }
  }
});

const decide = (path = "/contact/") => firestore.runTransaction(transaction =>
  contextDecision.readNoBuildPageContextDecision({ firestore, transaction, path, rendererSha, now }), { readOnly: true });
it.each(["missing", "disabled", "another renderer"])("keeps unowned Pages on Assets until %s capability activates", async mode => {
  const ref = firestore.doc(ownership.PAGE_CAPABILITY_PATH);
  if (mode === "missing") await ref.delete();
  if (mode === "disabled") await ref.update({ servingEnabled: false });
  if (mode === "another renderer") await ref.update({ rendererSha: "f".repeat(40) });
  expect(await decide()).toEqual({ kind: "pass", path: "/contact/" });
  await ref.set({ schemaVersion: 1, rendererSha, servingEnabled: true, generation: 5 });
  expect(await decide()).toMatchObject({ kind: "context-page", receipt: { source: "cms", sourceVersion: 7 } });
});
it("gives an unowned CMS Page a context receipt without inventing its editorial operation", async () => {
  const decision = await decide();
  expect(decision.kind).toBe("context-page");
  expect(decision.receipt).toMatchObject({ path: "/contact/", source: "cms", sourceVersion: 7, contextRevision: 4, codeGeneration: 5 });
  expect(decision.renderContext.page.title).toBe("Frozen Page");
  expect(decision.renderContext.kind).toBe("published-page-context");
  expect(JSON.stringify(decision)).not.toContain("PRIVATE");
});
it("preserves absent/draft committed frames and their current shell with no editorial source version", async () => {
  await firestore.doc("cmsPages/contact").delete();
  const absent = await decide();
  expect(absent.receipt.source).toBe("site");
  expect(absent.receipt.sourceVersion).toBeUndefined();
  expect(absent.renderContext.page).toBeNull();
  await firestore.doc("cmsPages/contact").set({ version: 1, title: "PRIVATE draft", blocks: [] });
  expect(await decide()).toEqual(absent);
});
it("keeps unowned builtin frames while exclusive claims and malformed bodies refuse fallback", async () => {
  await firestore.doc("cmsPages/contact").update({ publiclyVisible: false });
  expect(await decide()).toMatchObject({ kind: "context-page", renderContext: { page: null }, receipt: { source: "site", contextRevision: 4 } });
  await ownership.pageRouteRef(firestore, "/contact/").set({ schemaVersion: 1, pageId: "contact", path: "/contact/" });
  await expect(decide()).rejects.toThrow("exclusive Page owner");
  await ownership.pageRouteRef(firestore, "/contact/").delete();
  await firestore.doc("cmsPages/contact").update({ publiclyVisible: true, "published.blocks": [{ type: "invalid" }] });
  await expect(decide()).rejects.toThrow();
});
it("seals canonical and alias decisions for a renamed unowned Page; unrelated roots alone pass", async () => {
  await firestore.doc("cmsPages/contact").update({ "published.metadata.slug": "station-contact", "published.metadata.previousSlugs": ["contact-previous"] });
  expect(await decide()).toMatchObject({ kind: "redirect", location: "/station-contact/", receipt: { source: "cms", sourceVersion: 7 } });
  expect(await decide("/contact-previous/")).toMatchObject({ kind: "redirect", location: "/station-contact/", receipt: { path: "/contact-previous/" } });
  expect(await decide("/station-contact/")).toMatchObject({ kind: "context-page", receipt: { path: "/station-contact/" } });
  expect(await decide("/search/")).toEqual({ kind: "pass", path: "/search/" });
});
it.each(["/schedule/", "/live/"])("keeps %s behind the sealed lineup/PDF owner", async path => {
  await expect(decide(path)).rejects.toThrow("Schedule and Live require qualified sealed schedule authority");

});

it.each([["/public-meetings/", "/meeting-notices/"]])("seals retained builtin alias %s without static fallback", async (path, location) => {
  expect(await decide(path)).toMatchObject({ kind: "redirect", location, receipt: { path, source: "site", codeGeneration: 5 } });
});
it("refuses a logical owner on an old builtin alias even before its route claim is backfilled", async () => {
  await firestore.doc("cmsPages/contact").update({ "published.metadata.slug": "station-contact" });
  await firestore.doc("system/publicDeployment/noBuildPageOwners/contact").set({ schemaVersion: 1, pageId: "contact", rendererSha,
    servingEnabled: false, generation: 1, operationId: "C".repeat(20), sourceVersion: 7, visible: true,
    path: "/station-contact/", ownedPaths: ["/station-contact/"], snapshotDigest: "d".repeat(64), runtime: { owner: "cloudflare", release: rendererSha } });
  await expect(decide()).rejects.toThrow("logical Page");
});

it.each(["withdrawn", "scheduled", "deleted"])("keeps the unowned builtin frame for %s snapshots", async state => {
  await firestore.doc("cmsPages/contact").update(state === "withdrawn" ? { publiclyVisible: false } : state === "deleted" ? { deleted: true } :
    { publishAt: "2027-01-01T00:00:00.000Z", "published.publishedAt": "2027-01-01T00:00:00.000Z" });
  const decision = await decide();
  expect(decision).toMatchObject({ kind: "context-page", renderContext: { page: null }, receipt: { source: "site" } });
  expect(decision.receipt.sourceVersion).toBeUndefined();
});
it("serves the exact unmigrated Donate frame and only redirects it after Give is public", async () => {
  expect(await decide("/donate/")).toMatchObject({ kind: "context-page", renderContext: { pageId: "give", path: "/donate/", page: null }, receipt: { source: "site" } });
  await firestore.doc("cmsPages/give").set(document());
  expect(await decide("/donate/")).toMatchObject({ kind: "redirect", location: "/give/", receipt: { source: "cms", sourceVersion: 7 } });
});
it("withdraws a custom Page without manufacturing a committed frame", async () => {
  const id = `page-${"3".repeat(32)}`;
  const value = document(); value.publiclyVisible = false; value.published.metadata.slug = "custom-context";
  await firestore.doc(`cmsPages/${id}`).set(value);
  expect(await decide("/custom-context/")).toMatchObject({ kind: "gone", receipt: { source: "cms", sourceVersion: 7 } });
});

it("omits not-yet-due native Posts using the same Home admission cutoff as the full build", async () => {
  const published = snapshots.createPublishedSnapshot({ collection: "cmsPages", document: homeFixture,
    publishedAt: "2026-10-12T11:00:00.000Z", publishedBy: "PRIVATE actor" });
  await firestore.doc("cmsPages/home").set({ ...homeFixture, version: 8, status: "draft", publiclyVisible: true, published });
  const post = { version: 2, status: "published", publiclyVisible: true, publishAt: "2027-01-01T00:00:00.000Z",
    published: { sourceVersion: 1, publishedAt: "2027-01-01T00:00:00.000Z", blocks: [],
      metadata: { type: "post", title: "Future native Post", slug: "future-native", locale: "en", categories: [], tags: [] } } };
  await firestore.doc("cmsPosts/native-live").set(post);
  expect((await read({ pageId: "home" })).posts).toEqual([]);
  await firestore.doc("cmsPosts/native-live").update({ status: "draft", "published.publishedAt": "2026-10-12T11:00:00.000Z" });
  expect((await read({ pageId: "home" })).posts.map(post => post.document.id)).toEqual(["native-live"]);
});

it("carries published custom destinations into Page render contexts for embedded and navigation links", async () => {
  const publishedAt = "2026-10-01T00:00:00.000Z";
  await firestore.doc("cmsPosts/native-live").set({ type: "post", status: "published", publiclyVisible: true, publishAt: publishedAt,
    contentLinkMode: "normal", published: { sourceVersion: 1, publishedAt, blocks: [], metadata: {
      type: "post", title: "Linked reporting", slug: "linked-reporting", previousSlugs: [],
      contentLinkMode: "custom", contentLinkUrl: "https://example.test/reporting", contentLinkNewTab: true,
    } } });
  expect((await read()).contentLinks).toContainEqual({ path: "/posts/linked-reporting/", previousSlugs: [],
    contentLinkMode: "custom", contentLinkUrl: "https://example.test/reporting", contentLinkNewTab: true });
});
