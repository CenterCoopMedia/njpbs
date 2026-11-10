import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import "../../functions/lib/firebase.js";
import context from "../../functions/lib/library-card-context.js";
import media from "../../functions/lib/media-contract.js";
import deployment from "../../functions/lib/public-deployment.js";
import { exportRecordCards, resolveRecordCard } from "../../site/src/lib/record-card-resolution";
import { createExternalContentManifest } from "../../site/src/lib/external-content-feed";
const db = isolatedFirestore("library-card-context.test.ts");

const at = "2026-10-12T12:00:00.000Z";
const rich = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const fields = {
  sponsor: { name: "Approved sponsor", href: "https://example.test/", logoAssetId: "card-art", logoAlt: "Sponsor logo" },
  newsletter: { title: "Approved newsletter", signupUrl: "https://example.test/join", body: rich("Approved summary"),
    imageAssetId: "card-art", imageAlt: "Newsletter image" },
};
const asset = { lifecycle: "active", source: "site_seed", category: "general", mimeType: "image/png",
  url: "https://media.njpbs.org/cms-media/card.png", width: 640, height: 360, altText: null };
const records = (kind: keyof typeof fields) => ({ id: kind, type: kind, ...fields[kind], status: "in_review", version: 2 });
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") ||
      !/^demo-njpbs(?:-[a-z0-9-]+)?$/.test(process.env.GCLOUD_PROJECT ?? "")) throw new Error("Use a local demo Firestore emulator.");
});
beforeEach(async () => {
  const reset = await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${process.env.GCLOUD_PROJECT}/databases/(default)/documents`, { method: "DELETE" }, db);
  expect(reset.ok).toBe(true);
  await db.doc("media_assets/card-art").set(asset);
  await db.doc("media_assets_public/card-art").set(media.mediaProjection(asset));
});
async function prepare(kind: keyof typeof fields, action = "approve", options: Record<string, unknown> = {}) {
  const beforeDocument = records(kind);
  const nextDocument = { ...beforeDocument, status: action === "approve" ? "approved" : "archived", version: 3 };
  return db.runTransaction(transaction => context.prepareLibraryCardContextInTransaction({ firestore: db, transaction,
    collection: "cmsPosts", documentId: kind, beforeDocument, nextDocument, action, ...options }));
}
const approval = (kind: keyof typeof fields) => ({ collection: "cmsPosts", documentId: kind, action: "approve",
  before: { ...records(kind), version: 0 }, after: { ...records(kind), status: "approved", version: 1 } });

describe("approved library context preparation", () => {
  it.each(["sponsor", "newsletter"] as const)("projects exact %s approval for joined cards and feed content without writing", async kind => {
    const prepared = await prepare(kind);
    expect(prepared.operation).toMatchObject({ schemaVersion: 1, recordId: kind, kind, action: "approve", sourceVersion: 3, withdrawal: false });
    expect(prepared.operation.projectionDigest).toMatch(/^[a-f0-9]{64}$/);
    const cards = exportRecordCards([prepared.record], [], new Date(at), [{ id: "card-art", ...asset }]);
    expect(cards).toHaveLength(1);
    const block = { id: "joined", type: "record_card", data: { recordKind: kind, recordId: kind, variant: "card" } } as const;
    expect(resolveRecordCard(block, cards)).toMatchObject({ id: kind, kind, title: kind === "sponsor" ? fields.sponsor.name : fields.newsletter.title });
    const manifest = createExternalContentManifest({ site: new URL("https://example.test/"), programs: [], authors: [], recordCards: cards,
      posts: [{ postId: "joined-post", slug: "joined-post", previousSlugs: [], locale: "en", path: "/posts/joined-post/",
        title: "Joined Post", summary: "", excerpt: "", categories: [], tags: [], credits: [], authorIds: [], displayDate: null,
        sortInstant: null, updateShown: false, updatedAt: null, updatedDate: null, heroImage: null, heroImageAlt: "", heroImageDecorative: false,
        blocks: [block], assets: {}, noindex: false, sourceVersion: 1, firstPublishedAt: at, publishedAt: at }] });
    expect(JSON.stringify(manifest)).toContain(kind === "sponsor" ? fields.sponsor.name : fields.newsletter.title);
    expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
    expect((await db.collection("cmsVersionHistory").get()).empty).toBe(true);
    expect((await db.collection("cmsPosts").get()).empty).toBe(true);
  });

  it.each(["save", "reopen", "submit", "sendBack", "restore", "revise"])("does not accept working %s as public context", async action => {
    expect(await prepare("newsletter", action)).toBeNull();
  });

  it.each(["program", "event", "post", "staff"])("leaves %s to its existing owner", async type => {
    expect(await prepare("sponsor", "approve", { nextDocument: { ...records("sponsor"), type, status: "approved", version: 3 } })).toBeNull();
  });

  it.each(["archive", "unpublish"])("removes only approved fields on %s and permits missing removed media", async action => {
    await db.doc("cmsVersionHistory/prior").set(approval("newsletter"));
    await db.doc("media_assets/card-art").delete();
    await db.doc("media_assets_public/card-art").delete();
    const beforeDocument = { ...records("newsletter"), title: "Unpublished working title", signupUrl: "https://draft.example.test/" };
    const nextDocument = { ...beforeDocument, version: 3, status: action === "archive" ? "archived" : "draft", publiclyVisible: false };
    const prepared = await prepare("newsletter", action, { beforeDocument, nextDocument });
    expect(prepared).toMatchObject({ operation: { withdrawal: true, action, sourceVersion: 3 }, record: null });
    expect(exportRecordCards([], [], new Date(at))).toEqual([]);
    expect(resolveRecordCard({ data: { recordKind: "newsletter", recordId: "newsletter", variant: "card" } }, [])).toBeNull();
  });

  it("does not create withdrawal context when no approved card ever existed", async () => {
    expect(await prepare("sponsor", "archive")).toBeNull();
  });

  it("uses stable public projection identity and excludes mutable/vendor/private fields", async () => {
    const beforeDocument = records("newsletter");
    const nextDocument = { ...beforeDocument, status: "approved", version: 3, privateNotes: "Do not publish", assignee: "private-owner" };
    const first = await prepare("newsletter", "approve", { nextDocument });
    const retry = await prepare("newsletter", "approve", { nextDocument: { ...nextDocument, privateNotes: "New private note" } });
    expect(retry.operation).toEqual(first.operation);
    expect(JSON.stringify(first.record)).not.toMatch(/privateNotes|private-owner|assignee/);
    expect((await db.collection("cmsVersionHistory").get()).empty).toBe(true);
  });

  it("does not promote a newer working field through prior approved history", async () => {
    await db.doc("cmsVersionHistory/prior").set(approval("newsletter"));
    const beforeDocument = { ...records("newsletter"), status: "draft", title: "Working title" };
    expect(await prepare("newsletter", "save", { beforeDocument,
      nextDocument: { ...beforeDocument, title: "Newer private title", version: 3 } })).toBeNull();
    const prior = (await db.doc("cmsVersionHistory/prior").get()).data();
    expect(prior.after.title).toBe(fields.newsletter.title);
  });

  it.each([{ version: 2 }, { version: 4 }, { status: "draft" }, { deleted: true }])("refuses changed approval identity: %j", async changes => {
    await expect(prepare("sponsor", "approve", { nextDocument: { ...records("sponsor"), status: "approved", version: 3, ...changes } })).rejects.toThrow("identity");
  });

  it("refuses ambiguous approval history instead of falling back to older content", async () => {
    await db.doc("cmsVersionHistory/conflict").set({ ...approval("sponsor"), after: { ...records("sponsor"), status: "approved", version: 3 } });
    await expect(prepare("sponsor")).rejects.toThrow("history is unavailable");
  });

  it.each(["missing", "mismatch", "replacement", "inactive", "origin"])("keeps the public media fence at approval (%s)", async fault => {
    if (fault === "missing") await db.doc("media_assets_public/card-art").delete();
    if (fault === "mismatch") await db.doc("media_assets_public/card-art").update({ width: 5 });
    if (fault === "replacement") await db.doc("system/media/replacements/card-art").set({ phase: "pending" });
    if (fault === "inactive") await db.doc("media_assets/card-art").update({ lifecycle: "archived" });
    if (fault === "origin") {
      const invalid = { ...asset, url: "https://unapproved.example.test/card.png" };
      await db.doc("media_assets/card-art").set(invalid);
      await db.doc("media_assets_public/card-art").set(media.mediaProjection(invalid));
    }
    await expect(prepare("newsletter")).rejects.toThrow();
    expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
  });

  it("requires the existing idle generation fence for uploaded card images", async () => {
    const upload = { ...asset, source: "upload" };
    await db.doc("media_assets/card-art").set(upload);
    await db.doc("media_assets_public/card-art").set(media.mediaProjection(upload));
    await expect(prepare("newsletter")).rejects.toThrow();
    await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
      activeDeploymentId: "11111111-1111-4111-8111-111111111111", activeCommitSha: "a".repeat(40), lastReservedGeneration: 1,
      newestEligibleGeneration: 1, newestEligibleBuildBatchId: "baseline", mediaLifecycleReady: true });
    expect(await prepare("newsletter")).not.toBeNull();
    await db.doc("system/publicDeployment").update({ lastReservedGeneration: 2 });
    await expect(prepare("newsletter")).rejects.toThrow();
  });
});
