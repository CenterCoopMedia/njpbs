import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import apiPkg from "../../functions/author-profiles.js";
import postsPkg from "../../functions/lib/author-page-posts.js";

const admin = adminPkg;
const { createListAuthorPagePostsHandler } = apiPkg;
const { listAuthorPagePosts } = postsPkg;
const PROJECT = "demo-njpbs";
const AUTHOR_A = `au_${"a".repeat(32)}`;
const AUTHOR_B = `au_${"b".repeat(32)}`;
let db;

async function clearFirestore() {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
}

function post(authorId, overrides = {}) {
  const working = {
    type: "post",
    status: "published",
    title: "Budget hearing",
    credits: [{ kind: "registered", authorId }],
    editorialDateSource: "firstPublish",
    firstPublishedAt: "2026-08-21T15:00:00.000Z",
    privateDraftField: "never return this",
    ...overrides,
  };
  if (Object.hasOwn(overrides, "published")) {
    if (working.published !== undefined) return working;
    const { published: _omitted, ...withoutPublished } = working;
    return withoutPublished;
  }
  return {
    ...working,
    publiclyVisible: overrides.publiclyVisible ?? true,
    published: {
      authorIds: [authorId],
      blocks: [],
      metadata: {
        type: working.type,
        title: working.title,
        credits: [{ kind: "registered", authorId, displayName: "Reporter" }],
        editorialDateSource: working.editorialDateSource,
        firstPublishedAt: working.firstPublishedAt,
      },
      publishedAt: "2026-08-21T15:00:00.000Z",
      publishedBy: "publisher",
      sourceVersion: 1,
    },
  };
}

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    headersSent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      this.headersSent = true;
      return this;
    },
  };
}

async function seedAccount(uid, authorId, role = "contributor") {
  await Promise.all([
    db.collection("users").doc(uid).set({ active: true, role, grants: [] }),
    db.collection("cmsStaffRecords").doc(uid).set({
      uid,
      authorId,
      status: "active",
    }),
    db.collection("cmsAuthorProfiles").doc(authorId).set({
      uid,
      authorId,
      displayName: uid,
      visibility: "private",
    }),
  ]);
}

async function callAs(uid, role, body) {
  const res = fakeRes();
  const handler = createListAuthorPagePostsHandler({
    firestore: db,
    requirePrincipalFn: async () => ({
      uid,
      email: `${uid}@example.org`,
      principal: { id: uid, grants: [{ role }] },
    }),
    log: { error: () => {} },
  });
  await handler({ method: "POST", headers: {}, body }, res);
  return res;
}

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("author-page-posts.test.js");
});

beforeEach(clearFirestore);

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

describe("author-page Post directory", () => {
  it("projects published noindex for pin availability without leaking other SEO or working fields", async () => {
    const hidden = post(AUTHOR_A);
    hidden.published.metadata.seo = { noindex: true, description: "Not needed by the picker" };
    hidden.seo = { noindex: false };
    const normal = post(AUTHOR_A);
    normal.seo = { noindex: true };
    await Promise.all([
      db.collection("cmsPosts").doc("hidden").set(hidden),
      db.collection("cmsPosts").doc("normal").set(normal),
    ]);
    const result = await listAuthorPagePosts({ firestore: db, authorId: AUTHOR_A });
    expect(result).toEqual({ posts: [
      { id: "hidden", headline: "Budget hearing", publishDate: "2026-08-21", noindex: true },
      { id: "normal", headline: "Budget hearing", publishDate: "2026-08-21" },
    ], nextCursor: null });
  });

  it("returns only safe summaries for this author's published Posts", async () => {
    await Promise.all([
      db.collection("cmsPosts").doc("post-a").set(post(AUTHOR_A)),
      db.collection("cmsPosts").doc("post-b").set(post(AUTHOR_B)),
      db
        .collection("cmsPosts")
        .doc("post-draft")
        .set(
          post(AUTHOR_A, {
            status: "draft",
            publiclyVisible: false,
            published: undefined,
          }),
        ),
      db
        .collection("cmsPosts")
        .doc("program-a")
        .set(post(AUTHOR_A, { type: "program" })),
    ]);

    const result = await listAuthorPagePosts({
      firestore: db,
      authorId: AUTHOR_A,
    });

    expect(result).toEqual({
      posts: [
        {
          id: "post-a",
          headline: "Budget hearing",
          publishDate: "2026-08-21",
        },
      ],
      nextCursor: null,
    });
    expect(result.posts[0].privateDraftField).toBeUndefined();
    expect(result.posts[0].credits).toBeUndefined();
  });

  it("uses the live snapshot while a different working revision is in draft", async () => {
    const revised = post(AUTHOR_B, {
      status: "draft",
      title: "Unreleased rewrite",
    });
    revised.published = post(AUTHOR_A).published;
    await db.collection("cmsPosts").doc("live-revision").set(revised);

    const result = await listAuthorPagePosts({
      firestore: db,
      authorId: AUTHOR_A,
    });

    expect(result.posts).toEqual([
      {
        id: "live-revision",
        headline: "Budget hearing",
        publishDate: "2026-08-21",
      },
    ]);
  });

  it("pages without gaps or duplicates and exposes an exact continuation cursor", async () => {
    await Promise.all(
      ["post-a", "post-b", "post-c"].map((id) =>
        db.collection("cmsPosts").doc(id).set(post(AUTHOR_A, { title: id })),
      ),
    );
    const first = await listAuthorPagePosts({
      firestore: db,
      authorId: AUTHOR_A,
      limit: 2,
    });
    expect(first.posts.map((row) => row.id)).toEqual(["post-a", "post-b"]);
    expect(first.nextCursor).toBe("post-b");

    const second = await listAuthorPagePosts({
      firestore: db,
      authorId: AUTHOR_A,
      limit: 2,
      startAfter: first.nextCursor,
    });
    expect(second.posts.map((row) => row.id)).toEqual(["post-c"]);
    expect(second.nextCursor).toBeNull();
  });

  it("confines ordinary staff to their own authorId and lets admins address any", async () => {
    await seedAccount("uid-self", AUTHOR_A);
    await seedAccount("uid-other", AUTHOR_B);
    await seedAccount("uid-admin", `au_${"c".repeat(32)}`, "admin");
    await db.collection("cmsPosts").doc("other-post").set(post(AUTHOR_B));

    const refused = await callAs("uid-self", "contributor", {
      authorId: AUTHOR_B,
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.body.posts).toBeUndefined();

    const self = await callAs("uid-self", "contributor", {
      authorId: AUTHOR_A,
    });
    expect(self.statusCode).toBe(200);
    expect(self.body.posts).toEqual([]);

    const adminResult = await callAs("uid-admin", "admin", {
      authorId: AUTHOR_B,
    });
    expect(adminResult.statusCode).toBe(200);
    expect(adminResult.body.posts.map((row) => row.id)).toEqual(["other-post"]);
  });

  it("refuses an unapproved Firebase account before returning any Post", async () => {
    await db.collection("cmsPosts").doc("post-a").set(post(AUTHOR_A));
    const res = await callAs("uid-missing", "contributor", {
      authorId: AUTHOR_A,
    });
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe("approval_required");
    expect(res.body.posts).toBeUndefined();
  });
});
