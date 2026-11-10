import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
// The byline at the write boundary (issue #1040). These run against the Firestore
// emulator because the parts that matter here are exactly the parts a pure test
// cannot reach: whether a credited author actually exists and is active, what a
// publish freezes into the snapshot, and what happens to a pre-contract post's
// free-text `author` when somebody saves it.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import save from "../../functions/save.js";
import contract from "../../functions/lib/author-profile-contract.js";

const { createCmsSaveHandler } = save;
const { AUTHOR_PROFILE_COLLECTIONS, mintAuthorId } = contract;

const admin = adminPkg;
const PROJECT = "demo-njpbs";
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";

const ADA = mintAuthorId("a".repeat(32));
const BEN = mintAuthorId("b".repeat(32));
const GONE = mintAuthorId("c".repeat(32));

let db;

function makeReq(body) {
  return { method: "POST", body, headers: {}, ip: "203.0.113.7" };
}

function makeRes() {
  const res = { statusCode: null, body: null, headersSent: false };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    res.headersSent = true;
    return res;
  };
  return res;
}

// Assert success with the server's own reason attached. A bare status assertion
// reports "expected 500 to be 200" and hides the one line that says why.
function expectOk(res) {
  expect({ status: res.statusCode, error: res.body?.error ?? null }).toEqual({
    status: 200,
    error: null,
  });
}

const adminOk = () => ({
  uid: "u1",
  email: "u1@x",
  principal: { id: "u1", grants: [{ role: "admin" }] },
});

function handler(overrides = {}) {
  return createCmsSaveHandler({
    firestore: db,
    requirePrincipalFn: adminOk,
    now: () => "2026-08-21T15:00:00.000Z",
    assertPublishReadyFn: vi.fn(async () => {}),
    ...overrides,
  });
}

async function seedAuthor(
  authorId,
  uid,
  displayName,
  { status = "active", visibility = "private", slug = null } = {},
) {
  await db.collection(AUTHOR_PROFILE_COLLECTIONS.staffRecords).doc(uid).set({
    uid,
    authorId,
    email: `${uid}@example.org`,
    status,
    version: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    createdBy: "u1",
    updatedAt: "2026-08-01T00:00:00.000Z",
    updatedBy: "u1",
  });
  await db.collection(AUTHOR_PROFILE_COLLECTIONS.workingProfiles).doc(authorId).set({
    authorId,
    uid,
    displayName,
    jobTitle: null,
    bio: null,
    photoAssetId: null,
    links: {},
    visibility,
    slug,
    previousSlugs: [],
    publishedAt: visibility === "published" ? "2026-08-02T00:00:00.000Z" : null,
    publishedBy: visibility === "published" ? "u1" : null,
    withdrawnAt: null,
    withdrawnBy: null,
    withdrawnReason: null,
    version: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    createdBy: "u1",
    updatedAt: "2026-08-01T00:00:00.000Z",
    updatedBy: "u1",
  });
}

async function seedPost(id, over = {}) {
  await db
    .collection("cmsPosts")
    .doc(id)
    .set({
      id,
      type: "post",
      title: "Budget vote",
      tags: [],
      blocks: [],
      slug: id,
      previousSlugs: [],
      locale: "en",
      status: "draft",
      createdBy: "u1",
      version: 3,
      ...over,
    });
}

async function readPost(id) {
  return (await db.collection("cmsPosts").doc(id).get()).data();
}

describe("story credits at the save boundary", () => {
  beforeAll(() => {
    if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
    db = isolatedFirestore("save-story-credits.test.js");
  });

  beforeEach(async () => {
    await clearEmulatorFirestore(
      `http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
      { method: "DELETE" }, db,
    );
    await seedAuthor(ADA, "ada", "Ada Reporter", {
      visibility: "published",
      slug: "ada-reporter",
    });
    await seedAuthor(BEN, "ben", "Ben Producer");
  });

  afterAll(async () => {
    await Promise.all(admin.apps.map((app) => app.delete()));
  });

  it("stores an ordered mix of registered and custom credits", async () => {
    await seedPost("post-1");
    const res = makeRes();
    await handler()(
      makeReq({
        collection: "cmsPosts",
        id: "post-1",
        baseVersion: 3,
        document: {
          type: "post",
          title: "Budget vote",
          tags: [],
          blocks: [],
          credits: [
            { kind: "registered", authorId: ADA },
            { kind: "custom", name: "NJ PBS staff" },
            { kind: "registered", authorId: BEN },
          ],
        },
      }),
      res,
    );

    expectOk(res);
    expect((await readPost("post-1")).credits).toEqual([
      { kind: "registered", authorId: ADA },
      { kind: "custom", name: "NJ PBS staff" },
      { kind: "registered", authorId: BEN },
    ]);
  });

  it("keeps a reorder as a reorder", async () => {
    await seedPost("post-1", {
      credits: [
        { kind: "registered", authorId: ADA },
        { kind: "registered", authorId: BEN },
      ],
    });
    const res = makeRes();
    await handler()(
      makeReq({
        collection: "cmsPosts",
        id: "post-1",
        baseVersion: 3,
        document: {
          type: "post",
          title: "Budget vote",
          tags: [],
          blocks: [],
          credits: [
            { kind: "registered", authorId: BEN },
            { kind: "registered", authorId: ADA },
          ],
        },
      }),
      res,
    );

    expectOk(res);
    expect((await readPost("post-1")).credits).toEqual([
      { kind: "registered", authorId: BEN },
      { kind: "registered", authorId: ADA },
    ]);
  });

  it("strips a client-asserted display name from a stored credit", async () => {
    await seedPost("post-1");
    const res = makeRes();
    await handler()(
      makeReq({
        collection: "cmsPosts",
        id: "post-1",
        baseVersion: 3,
        document: {
          type: "post",
          title: "Budget vote",
          tags: [],
          blocks: [],
          credits: [
            { kind: "registered", authorId: ADA, displayName: "Someone Else" },
          ],
        },
      }),
      res,
    );

    expectOk(res);
    expect((await readPost("post-1")).credits).toEqual([
      { kind: "registered", authorId: ADA },
    ]);
  });

  it("refuses a credit naming an author identity that does not exist", async () => {
    await seedPost("post-1");
    const res = makeRes();
    await handler()(
      makeReq({
        collection: "cmsPosts",
        id: "post-1",
        baseVersion: 3,
        document: {
          type: "post",
          title: "Budget vote",
          tags: [],
          blocks: [],
          credits: [{ kind: "registered", authorId: GONE }],
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/do not recognize/);
  });

  it("refuses newly crediting a deactivated author", async () => {
    await seedAuthor(GONE, "gone", "Cam Editor", { status: "inactive" });
    await seedPost("post-1");
    const res = makeRes();
    await handler()(
      makeReq({
        collection: "cmsPosts",
        id: "post-1",
        baseVersion: 3,
        document: {
          type: "post",
          title: "Budget vote",
          tags: [],
          blocks: [],
          credits: [{ kind: "registered", authorId: GONE }],
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/no longer active/);
  });

  it("keeps a story editable after the author it already credits leaves", async () => {
    await seedAuthor(GONE, "gone", "Cam Editor", { status: "inactive" });
    await seedPost("post-1", {
      credits: [{ kind: "registered", authorId: GONE }],
    });
    const res = makeRes();
    await handler()(
      makeReq({
        collection: "cmsPosts",
        id: "post-1",
        baseVersion: 3,
        document: {
          type: "post",
          title: "Budget vote, corrected",
          tags: [],
          blocks: [],
          credits: [{ kind: "registered", authorId: GONE }],
        },
      }),
      res,
    );

    expectOk(res);
    expect((await readPost("post-1")).credits).toEqual([
      { kind: "registered", authorId: GONE },
    ]);
  });

  it("refuses a byline longer than the contract allows", async () => {
    await seedPost("post-1");
    const res = makeRes();
    await handler()(
      makeReq({
        collection: "cmsPosts",
        id: "post-1",
        baseVersion: 3,
        document: {
          type: "post",
          title: "Budget vote",
          tags: [],
          blocks: [],
          credits: Array.from({ length: 13 }, (_unused, index) => ({
            kind: "custom",
            name: `Contributor ${index}`,
          })),
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/at most/);
  });

  it("bounds and sanitizes custom credit text without trying to detect an identity", async () => {
    await seedPost("post-1");
    const res = makeRes();
    await handler()(
      makeReq({
        collection: "cmsPosts",
        id: "post-1",
        baseVersion: 3,
        document: {
          type: "post",
          title: "Budget vote",
          tags: [],
          blocks: [],
          credits: [
            { kind: "custom", name: "  NJ\tPBS \n staff " },
            { kind: "custom", name: "x".repeat(400) },
            { kind: "custom", name: "ada@example.org" },
          ],
        },
      }),
      res,
    );

    expectOk(res);
    const credits = (await readPost("post-1")).credits;
    expect(credits[0]).toEqual({ kind: "custom", name: "NJ PBS staff" });
    expect(credits[1].name).toHaveLength(120);
    // An address in a custom credit is text. Nothing resolves it, and nothing
    // rejects it either; deciding it "means" an account is exactly the fuzzy
    // matching this contract forbids.
    expect(credits[2]).toEqual({ kind: "custom", name: "ada@example.org" });
  });

  it("converts a pre-contract free-text author to one custom credit and drops the old field", async () => {
    await seedPost("legacy", { author: "Dana Freelancer", version: 4 });
    const res = makeRes();
    await handler()(
      makeReq({
        collection: "cmsPosts",
        id: "legacy",
        baseVersion: 4,
        document: { type: "post", title: "Budget vote, corrected", tags: [], blocks: [] },
      }),
      res,
    );

    expectOk(res);
    const stored = await readPost("legacy");
    expect(stored.credits).toEqual([{ kind: "custom", name: "Dana Freelancer" }]);
    expect(stored.author).toBeUndefined();
  });

  it("never promotes a legacy name that matches a staff member to a registered credit", async () => {
    await seedPost("legacy", { author: "Ada Reporter", version: 4 });
    const res = makeRes();
    await handler()(
      makeReq({
        collection: "cmsPosts",
        id: "legacy",
        baseVersion: 4,
        document: { type: "post", title: "Budget vote", tags: [], blocks: [] },
      }),
      res,
    );

    expectOk(res);
    expect((await readPost("legacy")).credits).toEqual([
      { kind: "custom", name: "Ada Reporter" },
    ]);
  });

  it("leaves the byline alone on a save that does not mention it", async () => {
    await seedPost("post-1", {
      credits: [{ kind: "registered", authorId: ADA }],
    });
    const res = makeRes();
    await handler()(
      makeReq({
        collection: "cmsPosts",
        id: "post-1",
        baseVersion: 3,
        document: { type: "post", title: "Budget vote, corrected", tags: [], blocks: [] },
      }),
      res,
    );

    expectOk(res);
    expect((await readPost("post-1")).credits).toEqual([
      { kind: "registered", authorId: ADA },
    ]);
  });
});

describe("story credits at the publish boundary", () => {
  beforeAll(() => {
    if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
    db = isolatedFirestore("save-story-credits.test.js");
  });

  beforeEach(async () => {
    await clearEmulatorFirestore(
      `http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
      { method: "DELETE" }, db,
    );
    await seedAuthor(ADA, "ada", "Ada Reporter", {
      visibility: "published",
      slug: "ada-reporter",
    });
    await seedAuthor(BEN, "ben", "Ben Producer");
  });

  afterAll(async () => {
    await Promise.all(admin.apps.map((app) => app.delete()));
  });

  async function publish(credits) {
    await seedPost("post-1", { status: "approved", credits });
    const res = makeRes();
    await handler({ enablePublishSnapshot: true })(
      makeReq({
        collection: "cmsPosts",
        id: "post-1",
        baseVersion: 3,
        publish: true,
        // Publishing an approved record sends no content: the point of approval is
        // that what goes live is what was reviewed. The byline therefore comes off
        // the stored document, which is exactly the path the freeze has to handle.
        document: {},
      }),
      res,
    );
    return res;
  }

  it("freezes the display name and public slug into the snapshot", async () => {
    const res = await publish([{ kind: "registered", authorId: ADA }]);
    expectOk(res);
    const stored = await readPost("post-1");
    expect(stored.published.metadata.credits).toEqual([
      {
        kind: "registered",
        authorId: ADA,
        displayName: "Ada Reporter",
        slug: "ada-reporter",
      },
    ]);
    expect(stored.published.authorIds).toEqual([ADA]);
    // The working document keeps the bare id, so a later rename still corrects
    // every draft while this revision keeps the name it went out with.
    expect(stored.credits).toEqual([{ kind: "registered", authorId: ADA }]);
  });

  it("freezes a private author's name with no link", async () => {
    const res = await publish([{ kind: "registered", authorId: BEN }]);
    expectOk(res);
    const frozen = (await readPost("post-1")).published.metadata.credits[0];
    expect(frozen.displayName).toBe("Ben Producer");
    expect(frozen.slug).toBeUndefined();
  });

  it("keeps a published byline stable after the author is renamed", async () => {
    await publish([{ kind: "registered", authorId: ADA }]);
    await db
      .collection(AUTHOR_PROFILE_COLLECTIONS.workingProfiles)
      .doc(ADA)
      .update({ displayName: "Ada Newname" });
    expect(
      (await readPost("post-1")).published.metadata.credits[0].displayName,
    ).toBe("Ada Reporter");
  });

  it("carries custom credits into the snapshot in order", async () => {
    const res = await publish([
      { kind: "custom", name: "NJ PBS staff" },
      { kind: "registered", authorId: ADA },
    ]);
    expectOk(res);
    expect(
      (await readPost("post-1")).published.metadata.credits.map((credit) =>
        credit.kind === "custom" ? credit.name : credit.displayName,
      ),
    ).toEqual(["NJ PBS staff", "Ada Reporter"]);
  });

  it("publishes no byline when every credit is unresolvable", async () => {
    // The freeze exists so the public snapshot carries names, not ids. When it
    // resolves nothing -- a deleted profile, a corrupted linkage -- the answer is
    // an empty byline, never the raw stored credits: a bare `{kind, authorId}`
    // going public is precisely the shape the freeze is there to stop.
    const res = await publish([{ kind: "registered", authorId: GONE }]);
    expectOk(res);
    const stored = await readPost("post-1");
    expect(stored.published.metadata.credits).toEqual([]);
    // The working document is untouched, so the byline is repairable: restore the
    // profile and the next publish resolves it again.
    expect(stored.credits).toEqual([{ kind: "registered", authorId: GONE }]);
  });

  it("keeps the resolvable half of a partly unresolvable byline", async () => {
    const res = await publish([
      { kind: "registered", authorId: GONE },
      { kind: "registered", authorId: ADA },
    ]);
    expectOk(res);
    expect((await readPost("post-1")).published.metadata.credits).toEqual([
      {
        kind: "registered",
        authorId: ADA,
        displayName: "Ada Reporter",
        slug: "ada-reporter",
      },
    ]);
  });

  it("publishes a pre-contract free-text byline as one custom credit", async () => {
    await seedPost("legacy", {
      status: "approved",
      author: "Dana Freelancer",
      version: 4,
    });
    const res = makeRes();
    await handler({ enablePublishSnapshot: true })(
      makeReq({
        collection: "cmsPosts",
        id: "legacy",
        baseVersion: 4,
        publish: true,
        document: {},
      }),
      res,
    );

    expectOk(res);
    expect((await readPost("legacy")).published.metadata.credits).toEqual([
      { kind: "custom", name: "Dana Freelancer" },
    ]);
  });
});
