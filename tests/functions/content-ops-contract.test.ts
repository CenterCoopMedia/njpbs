import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import save from "../../functions/save.js";
import getContent from "../../functions/get-content.js";
import contract from "../../functions/lib/author-profile-contract.js";
import { blockEditorReducer, initialBlockEditorState, type BlockEditorAction } from "../../admin/src/lib/block-editor-state";
import { createBlock, type AdminBlock } from "../../admin/src/lib/block-factory";
import { editableBlocksForPublicPage } from "../../admin/src/lib/public-page-block-ownership";
import { pageBlocksSaveRequest, recordSaveRequest, storedPageContentFromDocument } from "../../admin/src/lib/content-save-request";
import { moveStoryCredit, type StoryCredit } from "../../packages/content-core/src/story-credits";
import { handleContentOps } from "../../cms-api/src/content-ops-route";
import { claimLease, renewLease } from "../../cms-api/src/editor-lease";
import type { PublicPageId } from "../../packages/content-core/src/public-pages";

// #4716 contract: the Boardwalk editor's action sequence and a content API ops file store the
// same document, the same history row and one audit row each. Expected values come from the
// editor path (the reducer, the extracted request builder and cmsSaveContent), never from the
// API path. The API path runs the real cms-api route; only the network is replaced, and the
// editing lease goes through the Firestore emulator REST API under the real rules.
const { createCmsSaveHandler } = save;
const { createCmsGetContentHandler } = getContent;
const { AUTHOR_PROFILE_COLLECTIONS, mintAuthorId } = contract;

const admin = adminPkg;
const PROJECT = "demo-njpbs";
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const FUNCTIONS_ORIGIN = "https://functions.invalid";
const AGENT = "agent-1";
const STAFF = "editor-1";
const PAGE = "page-0123456789abcdef0123456789abcdef" as PublicPageId;
const ADA = mintAuthorId("a".repeat(32));
const BEN = mintAuthorId("b".repeat(32));
const NOW = "2026-11-03T20:00:00.000Z";
const silentLog = { warn() {}, error() {}, info() {} };

let db: FirebaseFirestore.Firestore;

const principal = (uid: string) => () => ({ uid, email: `${uid}@example.org`,
  principal: { id: uid, grants: [{ role: "editor" }] } });

function sequentialMinter() {
  let next = 0;
  return () => `srv-${++next}`;
}

interface CallResult { statusCode: number; body: Record<string, unknown> }

async function call(handler: (req: unknown, res: unknown) => Promise<void>, body: unknown): Promise<CallResult> {
  const res = { statusCode: 0, body: {} as Record<string, unknown>, headersSent: false,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: Record<string, unknown>) { this.body = payload; this.headersSent = true; return this; } };
  await handler({ method: "POST", body, headers: {}, ip: "203.0.113.9" }, res);
  return res;
}

// A fresh minter for every save gives a dry run and its apply the same canonical ids.
const saveHandler = (uid: string) => createCmsSaveHandler({ firestore: db, requirePrincipalFn: principal(uid),
  mintId: sequentialMinter(),
  now: () => NOW, log: silentLog });

const richText = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

function storedPage() {
  return {
    id: PAGE, template: "genericPage", title: "Agent contract page", status: "draft", createdBy: STAFF, version: 4,
    blocks: [
      { id: "row-a", type: "row", order: 0, visible: true, data: { columns: [6, 6] } },
      { id: "head-a", type: "headline", order: 1, visible: true, layout: { rowId: "row-a", column: 0 }, data: { text: "Left" } },
      { id: "prose-a", type: "prose", order: 2, visible: true, layout: { rowId: "row-a", column: 1 }, data: { content: richText("Right") } },
      { id: "row-b", type: "row", order: 3, visible: true, data: { columns: [4, 4, 4] } },
      { id: "cta-b", type: "cta_row", order: 4, visible: true, layout: { rowId: "row-b", column: 2 },
        data: { ctas: [{ label: "Donate", href: "https://www.pbs.org/donation/", variant: "primary" }] } },
    ],
  };
}

function storedPost() {
  return { id: "post-1", type: "post", title: "Budget vote", tags: [], blocks: [], slug: "post-1", previousSlugs: [],
    locale: "en", status: "draft", createdBy: STAFF, version: 3,
    credits: [{ kind: "registered", authorId: ADA }, { kind: "custom", name: "NJ PBS staff" }] };
}

async function seedAuthor(authorId: string, uid: string, displayName: string) {
  await db.collection(AUTHOR_PROFILE_COLLECTIONS.staffRecords).doc(uid).set({ uid, authorId, email: `${uid}@example.org`,
    status: "active", version: 1, createdAt: NOW, createdBy: STAFF, updatedAt: NOW, updatedBy: STAFF });
  await db.collection(AUTHOR_PROFILE_COLLECTIONS.workingProfiles).doc(authorId).set({ authorId, uid, displayName,
    jobTitle: null, bio: null, photoAssetId: null, links: {}, visibility: "private", slug: null, previousSlugs: [],
    publishedAt: null, publishedBy: null, withdrawnAt: null, withdrawnBy: null, withdrawnReason: null, version: 1,
    createdAt: NOW, createdBy: STAFF, updatedAt: NOW, updatedBy: STAFF });
}

async function reset() {
  await clearEmulatorFirestore(`http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" });
  await db.collection("cmsPages").doc(PAGE).set(storedPage());
  await db.collection("cmsPosts").doc("post-1").set(storedPost());
  await db.collection("cmsAutomationAccounts").doc(AGENT).set({ label: "NJ PBS agent" });
  // The lease rules read the caller's staff profile.
  await db.collection("users").doc(AGENT).set({ role: null, grants: [{ role: "editor" }], active: true, tokensValidAfter: 0 });
  await db.collection("users").doc(STAFF).set({ role: null, grants: [{ role: "editor" }], active: true, tokensValidAfter: 0 });
  await seedAuthor(ADA, "ada", "Ada Reporter");
  await seedAuthor(BEN, "ben", "Ben Producer");
}

// An unsigned emulator token, so firestore.rules evaluate the lease writes as this account.
function emulatorToken(uid: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT,
    sub: uid, user_id: uid, auth_time: now - 10, iat: now - 10, exp: now + 3600, email: `${uid}@example.org`,
    email_verified: true, firebase: { sign_in_provider: "password", identities: {} } })}.`;
}

async function fetcher(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (url.startsWith("https://firestore.googleapis.com/")) {
    return fetch(url.replace("https://firestore.googleapis.com", `http://${FIRESTORE_HOST}`), init);
  }
  const endpoint = url.slice(FUNCTIONS_ORIGIN.length + 1);
  const handler = endpoint === "cmsGetContent"
    ? createCmsGetContentHandler({ firestore: db, requirePrincipalFn: principal(AGENT), log: silentLog })
    : endpoint === "cmsSaveContent" ? saveHandler(AGENT) : null;
  if (!handler) return new Response(JSON.stringify({ error: "unexpected endpoint" }), { status: 599 });
  const result = await call(handler, JSON.parse(String(init?.body)));
  return new Response(JSON.stringify(result.body), { status: result.statusCode });
}

async function contentOps(request: Record<string, unknown>) {
  const response = await handleContentOps({
    body: new TextEncoder().encode(JSON.stringify({ schema: 1, requestReference: "Slack thread 1001 from Emery", ...request })).buffer,
    token: emulatorToken(AGENT), uid: AGENT, projectId: PROJECT, functionsOrigin: FUNCTIONS_ORIGIN,
    forwardHeaders: new Headers({ "content-type": "application/json" }), fetcher, now: Date.now,
    randomUUID: () => crypto.randomUUID(), chargeVideoCopy: async () => null,
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function applyOps(collection: string, id: string, baseVersion: number, ops: unknown[]) {
  const dryRun = await contentOps({ mode: "dry-run", collection, id, baseVersion, ops });
  expect(dryRun.status, String(dryRun.body.error)).toBe(200);
  const applied = await contentOps({ mode: "apply", collection, id, baseVersion, ops, expectDigest: dryRun.body.digest });
  expect(applied.status, String(applied.body.error)).toBe(200);
  return { dryRun, applied };
}

const VOLATILE = new Set(["updatedBy", "timestamp", "at", "userId", "userEmail", "actorUid", "actorEmail", "automation"]);
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object" && !(value instanceof admin.firestore.Timestamp)) {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !VOLATILE.has(key)).map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

async function captured(collection: string, id: string) {
  const document = (await db.collection(collection).doc(id).get()).data();
  const history = (await db.collection("cmsVersionHistory").get()).docs.map(doc => doc.data());
  const audit = (await db.collection("admin_logs").get()).docs.map(doc => doc.data());
  return { document, history, audit };
}

async function editorPageSave(actions: (blocks: AdminBlock[]) => BlockEditorAction[]) {
  const stored = (await db.collection("cmsPages").doc(PAGE).get()).data()!;
  const storedContent = storedPageContentFromDocument(PAGE, stored);
  let state = initialBlockEditorState(editableBlocksForPublicPage(PAGE, storedContent.blocks, storedContent.homeCompositionVersion));
  for (const action of actions(state.blocks)) {
    state = blockEditorReducer("genericPage", state, action);
    expect(state.error).toBeNull();
  }
  const body = pageBlocksSaveRequest({ pageId: PAGE, section: "genericPage", storedPage: storedContent, blocks: state.blocks,
    enforcePublicPageOwnership: true, baseVersion: stored.version });
  const result = await call(saveHandler(STAFF), body);
  expect(result.statusCode, String(result.body.error)).toBe(200);
}

async function expectSameStoredResult(collection: string, id: string, editor: () => Promise<void>, api: () => Promise<unknown>) {
  await editor();
  const expected = await captured(collection, id);
  await reset();
  await api();
  const actual = await captured(collection, id);
  expect(stable(actual.document)).toEqual(stable(expected.document));
  expect(actual.history.map(stable)).toEqual(expected.history.map(stable));
  expect(expected.audit).toHaveLength(1);
  expect(actual.audit).toHaveLength(1);
  expect(stable(actual.audit[0])).toEqual(stable(expected.audit[0]));
  expect(actual.audit[0]).toMatchObject({ actorUid: AGENT,
    automation: { requestReference: "Slack thread 1001 from Emery", planDigest: expect.stringMatching(/^[a-f0-9]{64}$/) } });
}

const dataOf = (blocks: AdminBlock[], id: string) => blocks.find(block => block.id === id)!.data;

describe("content API contract with the Boardwalk editor", () => {
  beforeAll(() => {
    if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
    db = admin.firestore();
  });
  beforeEach(reset);
  afterAll(async () => {
    await Promise.all(admin.apps.map((app: { delete: () => Promise<void> }) => app.delete()));
  });

  const pageCases: Array<[string, (blocks: AdminBlock[]) => BlockEditorAction[], unknown[]]> = [
    ["adds a row", () => [{ kind: "editRows", edit: { kind: "insert", block: createBlock("row", "tmp-1"), destination: {} } }],
      [{ op: "insert", type: "row" }]],
    ["adds a block in a column", blocks => {
      const block = createBlock("prose", "tmp-1");
      return [
        { kind: "editRows", edit: { kind: "insert", block, destination: { layout: { rowId: "row-a", column: 0 } } } },
        { kind: "setData", id: "tmp-1", data: { ...block.data, content: richText("Added") }, discrete: true },
      ];
    }, [{ op: "insert", type: "prose", destination: { rowId: "row-a", column: 0 }, data: { content: richText("Added") } }]],
    ["moves a row with its children", () => [{ kind: "editRows", edit: { kind: "move", id: "row-b", destination: { beforeId: "row-a" } } }],
      [{ op: "move", id: "row-b", destination: { beforeId: "row-a" } }]],
    ["splits a row to 4 and 8", () => [{ kind: "editRows", edit: { kind: "split", id: "row-a", columns: [4, 8] } }],
      [{ op: "split", id: "row-a", columns: [4, 8] }]],
    ["reduces columns and moves content into the final column", () => [{ kind: "editRows", edit: { kind: "split", id: "row-b", columns: [6, 6] } }],
      [{ op: "split", id: "row-b", columns: [6, 6] }]],
    ["removes a populated row", () => [{ kind: "editRows", edit: { kind: "remove", id: "row-a" } }],
      [{ op: "remove", id: "row-a" }]],
    ["sets text, rich text and button fields", blocks => [
      { kind: "setData", id: "head-a", data: { ...dataOf(blocks, "head-a"), text: "Updated" }, discrete: true },
      { kind: "setData", id: "prose-a", data: { ...dataOf(blocks, "prose-a"), content: richText("New body") }, discrete: true },
      { kind: "setData", id: "cta-b", data: { ...dataOf(blocks, "cta-b"),
        ctas: [{ label: "Give now", href: "https://www.pbs.org/donation/", variant: "secondary" }] }, discrete: true },
    ], [
      { op: "setData", id: "head-a", data: { text: "Updated" } },
      { op: "setData", id: "prose-a", data: { content: richText("New body") } },
      { op: "setData", id: "cta-b", data: { ctas: [{ label: "Give now", href: "https://www.pbs.org/donation/", variant: "secondary" }] } },
    ]],
  ];

  it.each(pageCases)("%s the same way as the editor", async (_label, actions, ops) => {
    await expectSameStoredResult("cmsPages", PAGE, () => editorPageSave(actions),
      () => applyOps("cmsPages", PAGE, 4, ops));
  });

  it("reorders and adds Post credits the same way as the editor", async () => {
    const credits = [...moveStoryCredit(storedPost().credits as StoryCredit[], 1, -1),
      { kind: "registered", authorId: BEN }];
    await expectSameStoredResult("cmsPosts", "post-1", async () => {
      const { id, version, title, tags, blocks } = storedPost();
      const result = await call(saveHandler(STAFF), recordSaveRequest("post", { id, version, title, tags, blocks, credits }));
      expect(result.statusCode, String(result.body.error)).toBe(200);
    }, () => applyOps("cmsPosts", "post-1", 3, [{ op: "setCredits", credits }]));
  });

  it("returns the document from a dry run that the apply then stores, and writes nothing until apply", async () => {
    const ops = [{ op: "insert", type: "prose", destination: { rowId: "row-b", column: 0 }, data: { content: richText("Dry run") } }];
    const dryRun = await contentOps({ mode: "dry-run", collection: "cmsPages", id: PAGE, baseVersion: 4, ops });
    expect(dryRun.status, String(dryRun.body.error)).toBe(200);
    expect(dryRun.body.changes).toEqual([{ path: "/blocks/tmp-1", change: "added", type: "prose" }]);
    expect((await captured("cmsPages", PAGE)).document).toMatchObject({ version: 4 });
    expect((await db.collection("cmsVersionHistory").get()).size).toBe(0);
    expect((await db.collection("admin_logs").get()).size).toBe(0);
    expect((await db.collection("cmsEditorLocks").get()).size).toBe(0);

    const applied = await contentOps({ mode: "apply", collection: "cmsPages", id: PAGE, baseVersion: 4, ops,
      expectDigest: dryRun.body.digest });
    expect(applied.status, String(applied.body.error)).toBe(200);
    expect(stable((await captured("cmsPages", PAGE)).document)).toEqual(stable(dryRun.body.document));
    const lease = (await db.collection("cmsEditorLocks").doc(`cmsPages:${PAGE}`).get()).data();
    expect(lease).toMatchObject({ ownerId: AGENT, releasedAt: expect.anything() });
  });

  it("refuses an apply whose plan differs from the reviewed dry run", async () => {
    const res = await contentOps({ mode: "apply", collection: "cmsPages", id: PAGE, baseVersion: 4,
      ops: [{ op: "remove", id: "row-a" }], expectDigest: "0".repeat(64) });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ digestMismatch: true });
    expect((await captured("cmsPages", PAGE)).document).toMatchObject({ version: 4 });
  });

  it("refuses a stale baseVersion before composing", async () => {
    const res = await contentOps({ mode: "dry-run", collection: "cmsPages", id: PAGE, baseVersion: 3, ops: [{ op: "remove", id: "row-a" }] });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ versionConflict: true });
  });

  it("renews its own lease under the real rules and reports a lease it no longer owns", async () => {
    const target = { projectId: PROJECT, token: emulatorToken(AGENT), uid: AGENT, ownerName: "NJ PBS agent",
      collection: "cmsPages" as const, id: PAGE, fetcher, nowMs: Date.now(), sessionId: "content-api-renewal-test" };
    expect(await claimLease(target)).toMatchObject({ status: "acquired" });
    const lockRef = db.collection("cmsEditorLocks").doc(`cmsPages:${PAGE}`);
    const claimed = (await lockRef.get()).data()!;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(await renewLease(target)).toBe(true);
    const renewed = (await lockRef.get()).data()!;
    expect(renewed.heartbeatAt.toMillis()).toBeGreaterThan(claimed.heartbeatAt.toMillis());
    expect(renewed.acquiredAt.toMillis()).toBe(claimed.acquiredAt.toMillis());
    expect(await renewLease({ ...target, sessionId: "content-api-other-session" })).toBe(false);
  });

  it("reports a person's live lease and changes nothing", async () => {
    await db.collection("cmsEditorLocks").doc(`cmsPages:${PAGE}`).set({
      surfaceKey: `cmsPages:${PAGE}`, contentCollection: "cmsPages", contentId: PAGE, ownerId: STAFF,
      ownerName: "Emery", sessionId: "staff-session-0123456789", acquiredAt: admin.firestore.Timestamp.now(),
      heartbeatAt: admin.firestore.Timestamp.now(),
    });
    const ops = [{ op: "remove", id: "row-a" }];
    const dryRun = await contentOps({ mode: "dry-run", collection: "cmsPages", id: PAGE, baseVersion: 4, ops });
    const res = await contentOps({ mode: "apply", collection: "cmsPages", id: PAGE, baseVersion: 4, ops, expectDigest: dryRun.body.digest });
    expect(res.status).toBe(423);
    expect(res.body).toMatchObject({ lockHeld: true, holder: { ownerName: "Emery" } });
    expect((await captured("cmsPages", PAGE)).document).toMatchObject({ version: 4 });
    expect((await db.collection("cmsEditorLocks").doc(`cmsPages:${PAGE}`).get()).data()).toMatchObject({ ownerId: STAFF });
  });
});
