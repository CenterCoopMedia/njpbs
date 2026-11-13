import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, createHmac } from "node:crypto";
import deployment from "../../functions/lib/public-deployment.js";
import mediaContract from "../../functions/lib/media-contract.js";
import readerModule from "../../functions/published-post-reader.js";
import { servicePublishedPostReader, createShadowPostWorker } from "../../workers/src/shadow-post-worker";
import { forwardPublishedPostRead } from "../../workers/src/published-post-reader-worker";
import "../../functions/lib/firebase.js";
import { chromeSettings, newsPageId } from "../../site/tests/fixtures/shadow-posts/chrome";
import fixture from "../../site/tests/fixtures/shadow-posts/post.json";
import { projectPublishedPostRead } from "../../site/src/lib/published-post-shadow";
import { resolvePublicCreditLinks } from "../../site/src/lib/public-author-links";
const db = isolatedFirestore("published-post-reader.test.ts");

const { createCmsGetPublishedPostHandler } = readerModule;
const now = new Date("2026-10-07T13:00:00Z");
const key = randomBytes(32).toString("hex");
const config = { enabled: true, slugs: ["shadow-fixture"] };
const records: string[] = [];
const authorId = `au_${"1".repeat(32)}`;
const otherAuthorId = `au_${"2".repeat(32)}`;
// Same public Ada fields as posts-authors.e2e.test.ts; no private working row.
function authorSnapshot(overrides: Record<string, unknown> = {}) {
  return { authorId, slug: "ada-reporter", previousSlugs: ["a-reporter"], displayName: "Ada Reporter",
    jobTitle: "Statehouse reporter", bio: "Covers the Legislature for NJ PBS.", photo: null,
    links: { x: { handle: "adareporter", url: "https://x.com/adareporter" } }, pinnedPostId: null,
    hiddenPostIds: [], publishedAt: "2026-08-20T14:00:00.000Z", snapshotVersion: 2, ...overrides };
}
function authorDocument() {
  const value = document();
  Object.assign(value.published.metadata, { credits: [
    { kind: "registered", authorId, displayName: "Ada at publication", slug: "old-ada" },
    { kind: "custom", name: "Ada Reporter" },
  ] });
  return value;
}
async function put(path: string, value: object) {
  records.push(path);
  await db.doc(path).set(value);
}
function document(overrides = {}) {
  return structuredClone({ ...fixture.document, version: 8, publicSourceVersion: 7, ...overrides });
}
function handler(overrides = {}) {
  return createCmsGetPublishedPostHandler({ firestore: db, now: () => now, readSecret: () => key,
    config: () => config, log: { warn: vi.fn() }, ...overrides });
}
async function call(request: Request, run = handler()) {
  const url = new URL(request.url);
  let status = 200;
  let body: unknown;
  const headers = new Headers({ "Content-Type": "application/json" });
  const res = { set(name: string, value: string) { headers.set(name, value); return this; },
    status(code: number) { status = code; return this; }, json(value: unknown) { body = value; return this; } };
  await run({ method: request.method, path: url.pathname, originalUrl: url.pathname + url.search,
    headers: Object.fromEntries(request.headers) }, res);
  return new Response(JSON.stringify(body), { status, headers });
}
function service(run = handler()) {
  return { fetch: (request: Request) => forwardPublishedPostRead(request,
    { PUBLISHED_POST_FUNCTION_URL: "https://us-central1-demo-njpbs.cloudfunctions.net/cmsGetPublishedPost" },
    async upstream => {
      const url = new URL(upstream.url);
      expect(url.origin).toBe("https://us-central1-demo-njpbs.cloudfunctions.net");
      expect(upstream.headers.get("cookie")).toBeNull();
      return call(new Request(`https://function.test${url.pathname.replace("/cmsGetPublishedPost", "")}`,
        { headers: upstream.headers, method: upstream.method }), run);
    }) };
}
function authenticated(path = "/posts/shadow-fixture/", timestamp = String(now.getTime())) {
  const signature = createHmac("sha256", key).update(`njpbs-post-reader-v1\nGET\n${path}\n${timestamp}`).digest("hex");
  return new Request(`https://published-posts.internal${path}`, { headers: {
    "x-njpbs-post-timestamp": timestamp, "x-njpbs-post-signature": signature,
  } });
}
beforeAll(async () => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") ||
      process.env.GCLOUD_PROJECT !== "demo-njpbs") throw new Error("This suite requires the local demo Firestore emulator");
  // The reader also checks chrome. Do not inherit another file's Page fixtures.
  const cleared = await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${db.projectId}/databases/(default)/documents`, { method: "DELETE" }, db);
  if (!cleared.ok) throw new Error("Cannot reset the published Post reader fixture");
  await db.doc("cmsPosts/reader-emulator-readiness").get();
});
afterEach(async () => { for (const path of records.splice(0)) await db.doc(path).delete(); });

describe("published Post reader with the real Firestore emulator", () => {
  it("reads live-blog update-only public profiles without consulting private reporter rows", async () => {
    const value = document();
    const stamp = value.published.publishedAt;
    Object.assign(value.published.metadata, { credits: [{ kind: "custom", name: "Example newsroom" }],
      liveBlog: { schemaVersion: 1, coverageState: "ongoing", updatedAt: stamp, updates: [{
        id: "reporter-update", headline: "Synthetic reporting", publishedAt: stamp, updatedAt: stamp, keyUpdate: false,
        body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Local proof only." }] }] },
        credits: [{ kind: "registered", authorId, displayName: "Ada at publication" },
          { kind: "registered", authorId: otherAuthorId, displayName: "Missing reporter" }],
      }] } });
    await put("cmsPosts/reader-fixture", value);
    await put(`cmsAuthorProfilesPublic/${authorId}`, authorSnapshot({ uid: "PRIVATE uid", email: "private@example.test" }));
    await put(`cmsAuthorProfiles/${otherAuthorId}`, { displayName: "PRIVATE working profile" });
    const reader = servicePublishedPostReader(service(), { secret: key, now: () => now });
    const result: any = await reader.read("shadow-fixture");
    expect(result.authors.map((author: any) => author.id)).toEqual([authorId]);
    expect(result.authors[0].bio).toBe("Covers the Legislature for NJ PBS.");
    expect(result.authors[0]).not.toHaveProperty("links");
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|private@example/);
    expect(projectPublishedPostRead(result, "shadow-fixture", "a".repeat(40), now)?.authors[0].jobTitle).toBe("Statehouse reporter");
    await db.doc(`cmsAuthorProfilesPublic/${authorId}`).delete();
    const withdrawn: any = await reader.read("shadow-fixture");
    expect(withdrawn.authors).toEqual([]);
    expect(withdrawn.document.published.metadata.liveBlog.updates[0].credits).toHaveLength(2);
  });

  it.each([
    ["  Covers state government.\nThis second sentence stays out of the card. ", "Covers state government."],
    ["Reports on \"what happens next?\" More background.", "Reports on \"what happens next?\""],
    ["Covers N.J. politics. More background.", "Covers N.J. politics."],
    ["Dr. Smith reports. More background.", "Dr. Smith reports."],
    ["U.S. Rep. X covers Congress. More background.", "U.S. Rep. X covers Congress."],
    ["A. B. Chen reports at 9 a.m. and 6 p.m. on weekdays. More background.", "A. B. Chen reports at 9 a.m. and 6 p.m. on weekdays."],
    ["A".repeat(160), `${"A".repeat(139)}…`],
    [null, undefined],
  ])("bounds the live-blog reporter profile bio for %j", async (bio, expected) => {
    const value = document();
    const stamp = value.published.publishedAt;
    Object.assign(value.published.metadata, { credits: [{ kind: "custom", name: "Example newsroom" }],
      liveBlog: { schemaVersion: 1, coverageState: "ongoing", updatedAt: stamp, updates: [{
        id: "bio-update", headline: "Synthetic reporting", publishedAt: stamp, updatedAt: stamp, keyUpdate: false,
        body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Local proof only." }] }] },
        credits: [{ kind: "registered", authorId, displayName: "Ada at publication" }],
      }] } });
    await put("cmsPosts/reader-fixture", value);
    await put(`cmsAuthorProfilesPublic/${authorId}`, authorSnapshot({ bio, uid: "PRIVATE uid", email: "private@example.test" }));
    const result: any = await servicePublishedPostReader(service(), { secret: key, now: () => now }).read("shadow-fixture");
    expect(result.authors[0].bio).toBe(expected);
    if (expected === undefined) expect(result.authors[0]).not.toHaveProperty("bio");
    else expect(Array.from(result.authors[0].bio)).toHaveLength(Array.from(expected).length);
    expect(result.authors[0]).not.toHaveProperty("links");
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|private@example/);
    expect(projectPublishedPostRead(result, "shadow-fixture", "a".repeat(40), now)?.authors[0].bio).toBe(expected ?? null);
  });

  it("reads follow-up public profiles and excludes withdrawn-parent audit authors", async () => {
    const value = document();
    const stamp = value.published.publishedAt;
    const body = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Local proof only." }] }] };
    const credits = [{ kind: "registered", authorId, displayName: "Ada at publication" },
      { kind: "registered", authorId: otherAuthorId, displayName: "Missing reporter" }];
    const auditAuthorId = `au_${"3".repeat(32)}`;
    const reply = { body, credits, publishedAt: stamp, updatedAt: stamp };
    Object.assign(value.published.metadata, { credits: [{ kind: "custom", name: "Example newsroom" }],
      liveBlog: { schemaVersion: 1, coverageState: "ongoing", updatedAt: stamp, updates: [{
        id: "follow-up-update", headline: "Synthetic reporting", publishedAt: stamp, updatedAt: stamp, keyUpdate: false,
        body, credits: [{ kind: "custom", name: "Example newsroom" }],
        followUps: [{ ...reply, id: "reply-one" }, { ...reply, id: "reply-two" }],
      }, {
        id: "withdrawn-update", headline: "Update withdrawn", publishedAt: "2026-10-07T11:59:00Z", updatedAt: stamp,
        keyUpdate: false, body: { type: "doc", content: [] }, credits: [{ kind: "custom", name: "Example newsroom" }],
        withdrawal: "The report could not be verified.",
        followUps: [{ ...reply, id: "audit-reply", credits: [{ kind: "registered", authorId: auditAuthorId, displayName: "PRIVATE audit reporter" }] }],
      }] } });
    await put("cmsPosts/reader-fixture", value);
    await put(`cmsAuthorProfilesPublic/${authorId}`, authorSnapshot());
    await put(`cmsAuthorProfilesPublic/${auditAuthorId}`, authorSnapshot({ authorId: auditAuthorId, slug: "audit-reporter" }));
    await put(`cmsAuthorProfiles/${otherAuthorId}`, { displayName: "PRIVATE working profile" });
    const result: any = await servicePublishedPostReader(service(), { secret: key, now: () => now }).read("shadow-fixture");
    expect(result.authors.map((author: any) => author.id)).toEqual([authorId]);
    expect(result.document.published.metadata.liveBlog.updates[0].followUps[1].credits).toEqual(credits);
    expect(result.document.published.metadata.liveBlog.updates[1]).not.toHaveProperty("followUps");
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    const content = projectPublishedPostRead(result, "shadow-fixture", "a".repeat(40), now)!;
    expect(content.authors.map(author => author.authorId)).toEqual([authorId]);
    expect((await db.doc("cmsPosts/reader-fixture").get()).data()?.published.metadata.liveBlog.updates[1].followUps).toHaveLength(1);
  });

  it("bounds live-blog profile reads at 100 while preserving every reporting credit", async () => {
    const value = document();
    const stamp = value.published.publishedAt;
    const ids = Array.from({ length: 101 }, (_, index) => `au_${index.toString(16).padStart(32, "0")}`);
    Object.assign(value.published.metadata, { credits: [{ kind: "custom", name: "Example newsroom" }],
      liveBlog: { schemaVersion: 1, coverageState: "ongoing", updatedAt: stamp, updates: ids.map((id, index) => ({
        id: `budget-${index}`, headline: "Synthetic reporting", publishedAt: stamp, updatedAt: stamp, keyUpdate: false,
        body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Local proof only." }] }] },
        credits: [{ kind: "registered", authorId: id, displayName: `Reporter ${index}` }],
      })) } });
    await put("cmsPosts/reader-fixture", value);
    await put(`cmsAuthorProfilesPublic/${ids[0]}`, authorSnapshot({ authorId: ids[0] }));
    await put(`cmsAuthorProfilesPublic/${ids[100]}`, authorSnapshot({ authorId: ids[100], slug: "overflow-profile" }));
    const result: any = await servicePublishedPostReader(service(), { secret: key, now: () => now }).read("shadow-fixture");
    expect(result.authors.map((author: any) => author.id)).toEqual([ids[0]]);
    expect(result.document.published.metadata.liveBlog.updates).toHaveLength(101);
    expect(result.document.published.metadata.liveBlog.updates[100].credits[0].displayName).toBe("Reporter 100");
    expect(projectPublishedPostRead(result, "shadow-fixture", "a".repeat(40), now)?.posts[0].liveBlog?.updates).toHaveLength(101);
  });
  it("round-trips only allowed published fields while a newer draft remains private", async () => {
    const value = document();
    Object.assign(value, { title: "Private draft", privateNotes: "Staff only" });
    Object.assign(value.published, { publishedBy: "Private actor", staffToken: "Private field",
      previousVideoCopies: [{ assetId: "retired-video", url: "https://media.njpbs.org/cms-media/video/retired-video/" + "a".repeat(64) + ".mp4" }] });
    Object.assign(value.published.metadata, { firstPublishedBy: "Private actor", meaningfulUpdatedBy: "Private actor",
      unknown: "Private field", seo: { title: "Public SEO", staffNote: "Private field" } });
    const prose = value.published.blocks[0];
    Object.assign(prose, { internalNote: "Private field" });
    Object.assign(prose.data.content.content[0], { attrs: { staffNote: "Private field" } });
    await put("cmsPosts/reader-fixture", value);
    const result = await servicePublishedPostReader(service(), { secret: key, now: () => now }).read("shadow-fixture") as any;
    expect(result.document).toEqual({ id: "reader-fixture", status: "published", publiclyVisible: true, deleted: false,
      publishAt: "2026-10-07T12:00:00.000Z", published: { sourceVersion: 7, publishedAt: "2026-10-07T12:00:00.000Z",
        metadata: { type: "post", title: "A published fixture", slug: "shadow-fixture", previousSlugs: [], summary: "Published fixture summary.",
          date: "2026-10-07", editorialDateSource: "editorial", categories: [], tags: [], locale: "en", spotlightNews: false, seo: { title: "Public SEO" } },
        blocks: fixture.document.published.blocks } });
    expect(result.assets).toEqual([]);
    expect(result.authors).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/Private|Staff only|staffNote|publishedBy|previousVideoCopies|retired-video/);
  });

  it("reads only referenced public author fields and preserves ordered frozen credits", async () => {
    const value = authorDocument();
    Object.assign((value.published.metadata as any).credits[0], { uid: "Private credit UID", email: "credit@example.test" });
    await put("cmsPosts/reader-fixture", value);
    await put(`cmsAuthorProfiles/${authorId}`, { displayName: "Private working name", uid: "Private account", email: "private@example.test" });
    await put(`cmsStaffRecords/${authorId}`, { displayName: "Private staff name" });
    await put(`cmsAuthorProfilesPublic/${otherAuthorId}`, authorSnapshot({ authorId: otherAuthorId, slug: "unreferenced", displayName: "Unreferenced profile" }));
    await put(`cmsAuthorProfilesPublic/${authorId}`, authorSnapshot({ uid: "Private public pollution", email: "public@example.test",
      links: { x: { handle: "adareporter", url: "https://x.com/adareporter", staffToken: "Private token" } },
      photo: { url: "https://media.njpbs.org/cms-media/ada.jpg", mimeType: "image/jpeg", width: 800, height: 800,
        focalX: 0.25, focalY: 0.75, credit: "Portrait credit", privateKey: "Private photo key",
        thumbnails: [{ url: "https://media.njpbs.org/cms-media/ada-w960.webp", width: 960, height: 960, storageKey: "Private object key" }] } }));
    const result: any = await servicePublishedPostReader(service(), { secret: key, now: () => now }).read("shadow-fixture");
    expect(result.document.published.metadata.credits).toEqual([
      { kind: "registered", authorId, displayName: "Ada at publication", slug: "old-ada" },
      { kind: "custom", name: "Ada Reporter" },
    ]);
    expect(result.authors).toEqual([{ id: authorId, authorId, slug: "ada-reporter", previousSlugs: ["a-reporter"],
      displayName: "Ada Reporter", jobTitle: "Statehouse reporter", bio: "Covers the Legislature for NJ PBS.",
      photo: { url: "https://media.njpbs.org/cms-media/ada.jpg", mimeType: "image/jpeg", width: 800, height: 800,
        focalX: 0.25, focalY: 0.75, credit: "Portrait credit",
        thumbnails: [{ url: "https://media.njpbs.org/cms-media/ada-w960.webp", width: 960, height: 960 }] },
      links: { x: { handle: "adareporter", url: "https://x.com/adareporter" } }, hiddenPostIds: [], snapshotVersion: 2 }]);
    const content = projectPublishedPostRead(result, "shadow-fixture", "a".repeat(40), now)!;
    expect(resolvePublicCreditLinks(content.posts[0].credits, content.authors)).toEqual([
      { authorId, name: "Ada Reporter", slug: "ada-reporter" }, { name: "Ada Reporter" },
    ]);
    expect(content.authors[0].photo).toMatchObject({ displayUrl: "https://media.njpbs.org/cms-media/ada-w960.webp", focalX: 25, focalY: 75 });
    expect(JSON.stringify(result)).not.toMatch(/Private|private@example|public@example|credit@example|Unreferenced|uid|email|storageKey|staffToken/);
  });

  it("uses current public names and links without moving the Post version or reading private edits", async () => {
    await put("cmsPosts/reader-fixture", authorDocument());
    await put(`cmsAuthorProfilesPublic/${authorId}`, authorSnapshot());
    await put(`cmsAuthorProfiles/${authorId}`, { displayName: "Private initial name" });
    const reader = servicePublishedPostReader(service(), { secret: key, now: () => now });
    const resolve = (result: any) => {
      const content = projectPublishedPostRead(result, "shadow-fixture", "a".repeat(40), now)!;
      expect(content.posts[0].sourceVersion).toBe(7);
      expect(content.posts[0].credits[0].name).toBe("Ada at publication");
      return resolvePublicCreditLinks(content.posts[0].credits, content.authors);
    };
    const first: any = await reader.read("shadow-fixture");
    expect(resolve(first)[0]).toEqual({ authorId, name: "Ada Reporter", slug: "ada-reporter" });
    await db.doc(`cmsAuthorProfiles/${authorId}`).update({ displayName: "Private edited name" });
    expect(await reader.read("shadow-fixture")).toEqual(first);
    await db.doc(`cmsAuthorProfilesPublic/${authorId}`).update({ displayName: "Ada Current", slug: "ada-current", previousSlugs: ["ada-reporter", "a-reporter"], snapshotVersion: 3 });
    expect(resolve(await reader.read("shadow-fixture"))[0]).toEqual({ authorId, name: "Ada Current", slug: "ada-current" });
    await db.doc(`cmsAuthorProfilesPublic/${authorId}`).delete();
    const withdrawn: any = await reader.read("shadow-fixture");
    expect(withdrawn.authors).toEqual([]);
    expect(resolve(withdrawn)[0]).toEqual({ authorId, name: "Ada at publication" });
    await db.doc(`cmsAuthorProfilesPublic/${authorId}`).set(authorSnapshot());
    expect(resolve(await reader.read("shadow-fixture"))[0]).toEqual({ authorId, name: "Ada Reporter", slug: "ada-reporter" });
  });

  it.each([{ slug: "Ada Reporter" }, { displayName: " " }, { snapshotVersion: 0 }, { displayName: { email: "Private malformed name" } }])(
    "uses the full-build fallback for an unusable public profile %j", async overrides => {
      await put("cmsPosts/reader-fixture", authorDocument());
      await put(`cmsAuthorProfilesPublic/${authorId}`, authorSnapshot(overrides));
      const result: any = await servicePublishedPostReader(service(), { secret: key, now: () => now }).read("shadow-fixture");
      const content = projectPublishedPostRead(result, "shadow-fixture", "a".repeat(40), now)!;
      expect(content.authors).toEqual([]);
      expect(resolvePublicCreditLinks(content.posts[0].credits, content.authors)[0]).toEqual({ authorId, name: "Ada at publication" });
      expect(JSON.stringify(result)).not.toContain("Private malformed name");
    });

  it("refuses a public profile whose stored identity disagrees with its path", async () => {
    await put("cmsPosts/reader-fixture", authorDocument());
    await put(`cmsAuthorProfilesPublic/${authorId}`, authorSnapshot({ authorId: otherAuthorId }));
    const response = await call(authenticated());
    expect(response.status).toBe(503);
    expect(response.headers.get("X-Njpbs-Post-Read-Failure")).toBe("refusal");
  });

  it("admits twelve distinct frozen registered credits without requiring public profiles", async () => {
    const value = document();
    const credits = Array.from({ length: 12 }, (_, index) => ({ kind: "registered",
      authorId: `au_${(index + 3).toString(16).padStart(32, "0")}`, displayName: `Registered ${index + 1}` }));
    Object.assign(value.published.metadata, { credits });
    await put("cmsPosts/reader-fixture", value);
    const result: any = await servicePublishedPostReader(service(), { secret: key, now: () => now }).read("shadow-fixture");
    expect(result.document.published.metadata.credits).toEqual(credits);
    expect(result.authors).toEqual([]);
    const content = projectPublishedPostRead(result, "shadow-fixture", "a".repeat(40), now)!;
    expect(content.posts[0].authorIds).toEqual(credits.map(credit => credit.authorId));
  });

  it.each([
    [{ kind: "registered", authorId, displayName: "" }],
    [{ kind: "registered", authorId: "private-uid", displayName: "Ada Reporter" }],
    [{ kind: "registered", authorId: `${authorId}\n`, displayName: "Ada Reporter" }],
    [{ kind: "registered", authorId, displayName: "Ada Reporter", slug: "bad/route" }],
    [{ kind: "registered", authorId, displayName: "Ada Reporter" }, { kind: "registered", authorId, displayName: "Ada duplicate" }],
    Array.from({ length: 13 }, () => ({ kind: "custom", name: "Guest writer" })),
  ].map(credits => ({ credits })))("refuses malformed frozen credits %j", async ({ credits }) => {
    const value = document();
    Object.assign(value.published.metadata, { credits });
    await put("cmsPosts/reader-fixture", value);
    const response = await call(authenticated());
    expect(response.status).toBe(503);
    expect(response.headers.get("X-Njpbs-Post-Read-Failure")).toBe("refusal");
  });

  it.each([undefined, false, true])("carries published Spotlight attribution %s through the reader and shadow projection", async spotlightNews => {
    const value = document({ spotlightNews: spotlightNews !== true });
    if (spotlightNews !== undefined) Object.assign(value.published.metadata, { spotlightNews });
    await put("cmsPosts/reader-fixture", value);
    const result: any = await servicePublishedPostReader(service(), { secret: key, now: () => now }).read("shadow-fixture");
    expect(result.document.published.metadata.spotlightNews).toBe(spotlightNews === true);
    const content = projectPublishedPostRead(result, "shadow-fixture", "a".repeat(40), now)!;
    expect(content.posts[0].spotlightNews).toBe(spotlightNews === true);
  });

  it("refuses malformed published Spotlight attribution", async () => {
    const value = document();
    Object.assign(value.published.metadata, { spotlightNews: "true" });
    await put("cmsPosts/reader-fixture", value);
    expect((await call(authenticated())).status).toBe(503);
  });

  it("reads current published chrome and page paths without exposing their drafts", async () => {
    await put("cmsPosts/reader-fixture", document());
    for (const setting of chromeSettings()) {
      const { id, ...data } = setting;
      await put(`cmsSettings/${id}`, { ...data, values: { private: "Private draft setting" } });
    }
    await put(`cmsPages/${newsPageId}`, { status: "draft", publiclyVisible: true, version: 8,
      title: "Private page title", slug: "private-draft-slug", template: "genericPage",
      published: { sourceVersion: 7, publishedAt: "2026-10-07T12:00:00.000Z",
        metadata: { title: "Public news", description: "", slug: "in-the-news" }, blocks: [] } });
    const reader = servicePublishedPostReader(service(), { secret: key, now: () => now });
    const first: any = await reader.read("shadow-fixture");
    expect(first.settings).toEqual(chromeSettings().map(({ id, published }) => ({ id, version: 3, published })));
    expect(first.navigationPages).toEqual([{ pageId: newsPageId, path: "/in-the-news/" }]);
    expect(JSON.stringify(first)).not.toMatch(/Private|private-draft-slug|Public news/);
    const next = chromeSettings("Station newsletter")[1];
    await db.doc("cmsSettings/public-site-chrome").update({ published: next.published });
    const second: any = await reader.read("shadow-fixture");
    expect(second.document.published.sourceVersion).toBe(first.document.published.sourceVersion);
    expect(second.settings[1].published.values.newsletterLabel).toBe("Station newsletter");
    await db.doc(`cmsPages/${newsPageId}`).update({ publiclyVisible: false });
    expect((await reader.read("shadow-fixture") as any).navigationPages).toEqual([]);
  });

  it("joins approved newsletter cards selected by published CTA rules without copying draft fields", async () => {
    const value = document();
    value.published.blocks.push(...Array.from({ length: 100 }, (_, index) => ({ id: `body-card-${index}`, type: "record_card", visible: true, order: index + 1,
      data: { recordKind: "newsletter", recordId: `absent-body-${index}` } })));
    await put("cmsPosts/reader-fixture", value);
    const approved = { type: "newsletter", status: "approved", version: 2, title: "Weekly reporting",
      signupUrl: "https://example.org/newsletter", imageAssetId: "missing-image", body: { type: "doc", content: [] } };
    await put("cmsPosts/cta-weekly", { ...approved, version: 3, status: "draft", title: "Private draft newsletter", signupUrl: "https://example.org/private" });
    await put("cmsVersionHistory/cta-weekly-approval", { collection: "cmsPosts", documentId: "cta-weekly", action: "approve", after: approved });
    const rule = { id: "weekly", label: "Weekly newsletter", enabled: true, target: { contentTypes: ["post"] },
      position: { kind: "after-paragraph", count: 2 }, content: { type: "newsletter_signup", data: { newsletterIds: ["bad/id", "cta-weekly"] } } };
    const published = { schemaVersion: 2, sourceVersion: 1, publishedAt: "2026-10-07T12:00:00.000Z", values: { rules: [rule] } };
    await put("cmsSettings/story-ctas", { schemaVersion: 2, version: 2, values: { rules: [] }, published });
    const response = await call(authenticated());
    expect(response.status).toBe(200);
    const read = await response.json();
    expect(read.joinedRecords).toHaveLength(1);
    expect(read.joinedRecords[0]).toMatchObject({ id: "cta-weekly", approvedLibraryVersion: { title: "Weekly reporting", signupUrl: "https://example.org/newsletter" } });
    expect(read.joinedRecords[0].approvedLibraryVersion.imageAssetId).toBeUndefined();
    expect(read.document.published.blocks).toEqual(value.published.blocks);
    expect(JSON.stringify(read)).not.toContain("Private draft newsletter");
    const cardOnly = await readerModule.readPublishedPost({ firestore: db, slug: "shadow-fixture", now, cardsOnly: true });
    expect(cardOnly.joinedRecords).toEqual([]);
    await db.doc("cmsSettings/story-ctas").update({ "published.values.rules": [{ ...rule, enabled: false }] });
    const disabled = await call(authenticated());
    expect(disabled.status).toBe(200);
    expect((await disabled.json()).joinedRecords).toEqual([]);
  });

  it("keeps an authored newsletter block while an opted-out story omits global CTA cards", async () => {
    const value = document();
    value.published.metadata.disableStoryCtas = true;
    value.published.blocks.push({ id: "authored-newsletter", type: "newsletter_signup", visible: true, order: 1,
      data: { heading: "From this story", newsletterIds: ["authored-weekly"] } });
    await put("cmsPosts/reader-fixture", value);
    for (const [id, title] of [["authored-weekly", "Authored weekly"], ["automatic-weekly", "Automatic weekly"]]) {
      const approved = { type: "newsletter", status: "approved", version: 2, title,
        signupUrl: `https://example.org/${id}`, body: { type: "doc", content: [] } };
      await put(`cmsPosts/${id}`, { ...approved, status: "draft", version: 3, title: `Private ${title}` });
      await put(`cmsVersionHistory/${id}-approval`, { collection: "cmsPosts", documentId: id, action: "approve", after: approved });
    }
    const rule = { id: "automatic-weekly", label: "Automatic newsletter", enabled: true, target: { contentTypes: ["post"] },
      position: { kind: "end" }, content: { type: "newsletter_signup", data: { newsletterIds: ["automatic-weekly"] } } };
    await put("cmsSettings/story-ctas", { schemaVersion: 2, version: 2, values: { rules: [] }, published: {
      schemaVersion: 2, sourceVersion: 1, publishedAt: "2026-10-07T12:00:00.000Z", values: { rules: [rule] },
    } });

    const response = await call(authenticated());
    expect(response.status).toBe(200);
    const read = await response.json();
    expect(read.document.published.metadata.disableStoryCtas).toBe(true);
    expect(read.document.published.blocks).toEqual(value.published.blocks);
    expect(read.joinedRecords.map((record: { id: string }) => record.id)).toEqual(["authored-weekly"]);
    expect(read.joinedRecords[0].approvedLibraryVersion.title).toBe("Authored weekly");
    expect(JSON.stringify(read)).not.toMatch(/Automatic weekly|Private Authored weekly/);
  });

  it("keeps shadow Posts available when a built-in Page has an unmigrated block-only snapshot", async () => {
    await put("cmsPosts/reader-fixture", document());
    // The publisher's legacy Page fixture has no document-level publishAt.
    await put("cmsPages/contact", { status: "published", template: "genericPage",
      published: { blocks: [], publishedAt: "2026-10-07T12:00:00.000Z", publishedBy: "Private actor" } });
    const response = await call(authenticated());
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.document.published.sourceVersion).toBe(7);
    expect(result.navigationPages).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("Private actor");
  });

  it("uses the publisher fallback for missing, unpublished or invalid chrome", async () => {
    await put("cmsPosts/reader-fixture", document());
    const reader = servicePublishedPostReader(service(), { secret: key, now: () => now });
    expect((await reader.read("shadow-fixture") as any).settings).toEqual([]);
    await put("cmsSettings/public-site-chrome", { version: 1, values: { newsletterLabel: "Private draft" } });
    await put("cmsSettings/site-navigation", { version: 1, published: { schemaVersion: 1,
      sourceVersion: 1, publishedAt: now.toISOString(), values: { header: "invalid" } } });
    expect((await reader.read("shadow-fixture") as any).settings).toEqual([]);
  });

  it.each([
    ["draft-only", { publiclyVisible: false, published: null }],
    ["withdrawn", { publiclyVisible: false }],
    ["future", { published: { ...fixture.document.published, publishedAt: "2026-10-08T12:00:00Z" } }],
  ])("returns no published data for %s", async (_name, overrides) => {
    await put("cmsPosts/reader-fixture", document(overrides));
    expect(await servicePublishedPostReader(service(), { secret: key, now: () => now }).read("shadow-fixture")).toBeNull();
  });
  it("returns not found for an unknown slug and gone for a deleted snapshot", async () => {
    const request = authenticated();
    expect((await call(request)).status).toBe(404);
    await put("cmsPosts/reader-fixture", document({ deleted: true, publiclyVisible: false }));
    const response = await call(request);
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ kind: "gone" });
    const reader = servicePublishedPostReader(service(), { secret: key, now: () => now });
    const worker = createShadowPostWorker({ reader, rendererSha: "a".repeat(40), now: () => now,
      cache: { async match() { throw new Error("Gone content must not reach cache"); }, async put() {} },
      async render() { throw new Error("Gone content must not render"); } });
    const gone = await worker.fetch(new Request("https://dev-public.example.org/posts/shadow-fixture/"),
      { SHADOW_POSTS_ENABLED: "true", SHADOW_POST_SLUGS: "shadow-fixture" });
    expect(gone.status).toBe(410);
    expect(gone.headers.get("Cache-Control")).toBe("no-store");
  });
  it("requires explicit public visibility even for a legacy published record", async () => {
    const value = document({ status: "published" });
    delete (value as any).publiclyVisible;
    await put("cmsPosts/reader-fixture", value);
    const response = await call(authenticated());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ kind: "not-found" });
  });
  it("preserves an absent legacy video public copy through the shadow projector", async () => {
    const value: any = document();
    const video = { id: "legacy-video", type: "video", order: 1, visible: true,
      data: { sourceId: "video-library", assetId: "legacy-video", title: "Legacy clip" } };
    value.published.blocks.push(video);
    await put("cmsPosts/reader-fixture", value);
    const reader = servicePublishedPostReader(service(), { secret: key, now: () => now });
    const result: any = await reader.read("shadow-fixture");
    expect(result.document.published.blocks[1].data).toEqual(video.data);
    expect(result.document.published.blocks[1].data).not.toHaveProperty("public");
    const render = vi.fn(async () => "<!doctype html><html><main>Published body</main></html>");
    const worker = createShadowPostWorker({ reader, rendererSha: "a".repeat(40), now: () => now, render,
      cache: { async match() { return undefined; }, async put() {} } });
    const response = await worker.fetch(new Request("https://dev-public.example.org/posts/shadow-fixture/"),
      { SHADOW_POSTS_ENABLED: "true", SHADOW_POST_SLUGS: "shadow-fixture" });
    expect(response.status).toBe(200);
    expect(render).toHaveBeenCalledOnce();
    expect((render.mock.calls[0] as any)[0].posts[0].blocks[1].data).toEqual(video.data);
  });
  it("distinguishes version faults and SDK refusal codes without retaining error text", async () => {
    await put("cmsPosts/reader-fixture", document({ publicSourceVersion: 9 }));
    const log = { warn: vi.fn() };
    const versionRefusal = await call(authenticated(), handler({ log }));
    expect(versionRefusal.status).toBe(503);
    expect(versionRefusal.headers.get("X-Njpbs-Post-Read-Failure")).toBe("refusal");
    expect(log.warn).toHaveBeenLastCalledWith("Published Post read unavailable", {
      code: "reader_invalid_version", slug: "shadow-fixture",
    });
    for (const [code, expected] of [[7, "reader_read_denied"], [9, "reader_read_precondition"], [14, "reader_read_unavailable"]]) {
      const firestore = { runTransaction: async () => { throw Object.assign(new Error(key), { code }); } };
      const response = await call(authenticated(), handler({ firestore, log }));
      expect(response.status).toBe(503);
      expect(response.headers.get("X-Njpbs-Post-Read-Failure")).toBe(code === 14 ? null : "refusal");
      expect(log.warn).toHaveBeenLastCalledWith("Published Post read unavailable", { code: expected, slug: "shadow-fixture" });
    }
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(key);
  });
  it.each([{ publicSourceVersion: 9 }, { version: 6 }])("fails closed on an inconsistent source version %j", async overrides => {
    await put("cmsPosts/reader-fixture", document(overrides));
    expect((await call(authenticated())).status).toBe(503);
  });
  it("does not let another record kind claim a Post namespace", async () => {
    await put("cmsPosts/reader-fixture", document());
    await put("cmsPosts/reader-program", document({ published: {
      ...fixture.document.published, metadata: { ...fixture.document.published.metadata, type: "program" } } }));
    await put("cmsPosts/reader-event", document({ published: {
      ...fixture.document.published, metadata: { ...fixture.document.published.metadata, type: "event", slug: "event-route",
        previousSlugs: ["shadow-fixture"] } } }));
    const response = await call(authenticated());
    expect(response.status).toBe(200);
    expect((await response.json()).document.id).toBe("reader-fixture");
  });
  it("refuses collisions with another canonical owner or retired alias", async () => {
    await put("cmsPosts/reader-fixture", document());
    await put("cmsPosts/reader-collision", document());
    expect((await call(authenticated())).status).toBe(503);
    await db.doc("cmsPosts/reader-collision").set(document({ published: {
      ...fixture.document.published, metadata: { ...fixture.document.published.metadata,
        slug: "renamed-post", previousSlugs: ["shadow-fixture"] } } }));
    expect((await call(authenticated())).status).toBe(503);
  });
  it("returns only validated public media and refuses missing or retired media", async () => {
    await put("cmsPosts/reader-fixture", document({ published: { ...fixture.document.published,
      metadata: { ...fixture.document.published.metadata, heroImage: "reader-image" },
      blocks: [...fixture.document.published.blocks, { id: "required-body-image", type: "image", visible: true, order: 1,
        data: { assetId: "reader-image", alt: "County meeting" } }] } }));
    expect((await call(authenticated())).status).toBe(503);
    const media = { url: "https://media.njpbs.org/cms-media/station/reader.webp", altText: "Public alt",
      mimeType: "image/webp", width: 1200, height: 800 };
    await put("media_assets/reader-image", { ...media, lifecycle: "active", source: "site_seed", privateKey: "Private object" });
    await put("media_assets_public/reader-image", media);
    const response = await call(authenticated());
    expect(response.status).toBe(200);
    expect((await response.json()).assets).toEqual([{ id: "reader-image", url: media.url, mimeType: "image/webp", width: 1200, height: 800 }]);
    await db.doc("media_assets/reader-image").update({ lifecycle: "tombstoned" });
    expect((await call(authenticated())).status).toBe(503);
  });
  it.each(["legacy", "image"])("omits a missing or retired %s lead-only image without refusing the Post", async kind => {
    await put("cmsPosts/reader-fixture", document({ published: { ...fixture.document.published,
      metadata: { ...fixture.document.published.metadata, heroImage: "reader-image",
        ...(kind === "image" ? { leadMedia: { kind: "image", data: { assetId: "reader-image", alt: "County meeting" } } } : {}) },
    } }));
    const missing = await call(authenticated());
    expect(missing.status).toBe(200);
    expect((await missing.json()).assets).toEqual([]);
    await put("media_assets/reader-image", { lifecycle: "tombstoned", source: "site_seed", mimeType: "image/webp" });
    const retired = await call(authenticated());
    expect(retired.status).toBe(200);
    expect((await retired.json()).assets).toEqual([]);
  });

  it.each(["legacy", "image"])("reads current %s lead credit, keeps frozen captions private-safe, and rejects stale pairs or lost readiness", async kind => {
    const value = document({ heroImageCaption: "Private draft caption", published: { ...fixture.document.published,
      metadata: { ...fixture.document.published.metadata, heroImage: "reader-image", heroImageCaption: "Frozen caption",
        ...(kind === "image" ? { leadMedia: { kind: "image", data: { assetId: "reader-image", alt: "County meeting" } } } : {}) },
    } });
    await put("cmsPosts/reader-fixture", value);
    const media = { url: "https://media.njpbs.org/cms-media/station/reader.webp", altText: "Library alt", credit: "First credit",
      mimeType: "image/webp", width: 1200, height: 800, source: "upload", lifecycle: "active", description: "Private description", storageKey: "Private key" };
    await put("media_assets/reader-image", media);
    await put("media_assets_public/reader-image", mediaContract.mediaProjection(media));
    await put("system/publicDeployment", { ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
      activeDeploymentId: "11111111-1111-4111-8111-111111111111", activeCommitSha: "a".repeat(40),
      lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "baseline", mediaLifecycleReady: true });
    for (const credit of ["First credit", "Changed <credit> & photographer", null]) {
      const updated = { ...media, credit };
      await db.doc("media_assets/reader-image").set(updated);
      if (credit !== "First credit") expect((await call(authenticated())).status).toBe(503);
      await db.doc("media_assets_public/reader-image").set(mediaContract.mediaProjection(updated));
      const response = await call(authenticated());
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.assets[0].credit).toBe(credit ?? undefined);
      expect(result.document.published.metadata.heroImageCaption).toBe("Frozen caption");
      expect(JSON.stringify(result)).not.toMatch(/Private|description|storageKey|Library alt/);
    }
    await db.doc("system/publicDeployment").update({ mediaLifecycleReady: false });
    expect((await call(authenticated())).status).toBe(503);
  });
  it.each(["missing", "forged", "expired", "future", "path", "query"])("refuses %s request authentication before reading", async kind => {
    const request = authenticated(kind === "query" ? "/posts/shadow-fixture/?draft=true" : undefined,
      kind === "expired" ? String(now.getTime() - 61_000) : kind === "future" ? String(now.getTime() + 61_000) : undefined);
    if (kind === "missing") request.headers.delete("x-njpbs-post-signature");
    if (kind === "forged") request.headers.set("x-njpbs-post-signature", "f".repeat(64));
    const response = await call(kind === "path" ? new Request("https://function.test/posts/another/", { headers: request.headers }) : request);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Published read refused" });
  });
  it("defaults off, rejects unlisted slugs and conceals secret/read errors", async () => {
    expect((await call(authenticated(), handler({ config: () => ({ enabled: false, slugs: [] }) }))).status).toBe(404);
    expect((await call(authenticated(), handler({ config: () => ({ enabled: true, slugs: [] }) }))).status).toBe(404);
    const log = { warn: vi.fn() };
    const response = await call(authenticated(), handler({ log, readSecret() { throw new Error(key); } }));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(key);
    expect(log.warn).toHaveBeenCalledWith("Published Post read unavailable", { code: "reader_unconfigured", slug: "shadow-fixture" });
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(key);
  });
});
