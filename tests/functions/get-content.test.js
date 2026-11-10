// cmsGetContent, the capability-authorized single-record read boundary (#536).
// The handler takes its Firestore and its principal resolver by injection, so
// these run against fakes rather than the emulator: the decision under test is
// which caller gets which document, not how Firestore stores it.

import { describe, expect, it, vi } from "vitest";

import getContent from "../../functions/get-content.js";

const {
  DELETED_MESSAGE,
  FORBIDDEN_MESSAGE,
  createCmsGetContentHandler,
  validateReadRequest,
} = getContent;

function makeReq({ method = "POST", body = {}, headers = {} } = {}) {
  return { method, body, headers, ip: "203.0.113.9" };
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

/** A Firestore stub holding one document per "collection/id" path. */
function makeFirestore(documents = {}) {
  const reads = [];
  const document = path => ({ get: async () => {
    reads.push(path);
    const data = documents[path];
    return { exists: data !== undefined, data: () => data };
  } });
  return {
    reads,
    doc: document,
    runTransaction: async work => work({ get: ref => ref.get() }),
    collection: (collectionId) => ({
      doc: documentId => document(`${collectionId}/${documentId}`),
    }),
  };
}

const siteWide = (role, uid = "user-1") => ({
  uid,
  email: `${uid}@example.org`,
  principal: { id: uid, grants: [{ role }] },
});

const noGrants = (uid = "user-9") => ({
  uid,
  email: `${uid}@example.org`,
  principal: { id: uid, grants: [] },
});

const silentLog = () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() });

function handlerFor(user, documents = {}, log = silentLog()) {
  const firestore = makeFirestore(documents);
  return {
    firestore,
    log,
    handler: createCmsGetContentHandler({
      firestore,
      requirePrincipalFn: async () => user,
      log,
    }),
  };
}

async function call(user, body, documents = {}, log = silentLog()) {
  const { handler, firestore } = handlerFor(user, documents, log);
  const res = makeRes();
  await handler(makeReq({ body }), res);
  return { res, firestore, log };
}

const storedPage = {
  status: "draft",
  createdBy: "user-2",
  blocks: [{ id: "b-1", type: "richText" }],
  version: 3,
};

describe("validateReadRequest", () => {
  it("accepts the two content collections", () => {
    for (const collection of ["cmsPages", "cmsPosts"]) {
      expect(validateReadRequest({ collection, id: "home" })).toBeNull();
    }
  });

  it("refuses a collection this endpoint does not serve", () => {
    // The guard is what keeps a read boundary from being pointed at user
    // documents, audit rows, or system state.
    for (const collection of ["users", "adminLogs", "system", "", undefined]) {
      expect(validateReadRequest({ collection, id: "home" })).toMatch(/collection/);
    }
  });

  it("refuses a document id that would address a different document", () => {
    const overlong = "a".repeat(1501);
    for (const id of ["", " home", "a/b", ".", "..", "__proto__", overlong, 7, undefined]) {
      expect(
        validateReadRequest({ collection: "cmsPages", id }),
        JSON.stringify(id) ?? String(id),
      ).toMatch(/id must be/);
    }
  });
});

describe("cmsGetContent", () => {
  it("returns empty publication status for an authorized absent Post", async () => {
    const { res, firestore } = await call(siteWide("editor"), {
      collection: "cmsPosts", id: "missing-post", publicationOnly: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.found).toBe(false);
    expect(res.body.publication).toMatchObject({ publicUpdatePending: false,
      publiclyVisible: false, publicBuildQueueId: null, queueStatus: null });
    expect(firestore.reads).toEqual(["cmsPosts/missing-post"]);
  });
  it("projects only the durable Home fallback warning while its full build is pending", async () => {
    const { res } = await call(siteWide("editor"), { collection: "cmsPosts", id: "placed", publicationOnly: true }, {
      "cmsPosts/placed": { ...storedPage, publiclyVisible: false, published: { sourceVersion: 2 },
        publishBuildPending: true, publishBuildQueueId: "fallback" },
      "cmsPublishQueue/fallback": { status: "pending", homeFallback: { schemaVersion: 1 },
        changes: ["private"], error: "private" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.publication.homeWarning).toBe("Removal is taking the slower path; the story stays on Home until the full build finishes");
    expect(JSON.stringify(res.body)).not.toContain("private");
  });
  it("projects publication state without editor content or queue details", async () => {
    const { res, firestore } = await call(siteWide("editor"), {
      collection: "cmsPages", id: "home", publicationOnly: true,
    }, {
      "cmsPages/home": { ...storedPage, published: { sourceVersion: 2, blocks: ["private"] },
        publishBuildPending: true, publicSourceVersion: 1, publishBuildQueueId: "queue-one" },
      "cmsPublishQueue/queue-one": { status: "failed", changes: ["other-document"], error: "private log" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, found: true, publication: {
      workingVersion: 3, contentVersion: 3, publishedContentVersion: null, workingStatus: "draft", publishedSourceVersion: 2,
      publicSourceVersion: 1, publicUpdatePending: true,
      publiclyVisible: false,
      publicBuildQueueId: "queue-one", queueStatus: "failed", canResumeReservation: false,
    } });
    expect(firestore.reads).toEqual(["cmsPages/home", "cmsPublishQueue/queue-one"]);
  });

  it("authorizes publication reads before touching a queue", async () => {
    const { res, firestore } = await call(noGrants(), {
      collection: "cmsPages", id: "home", publicationOnly: true,
    }, { "cmsPages/home": { ...storedPage, publishBuildQueueId: "queue-one" } });
    expect(res.statusCode).toBe(403);
    expect(firestore.reads).toEqual([]);
  });

  it.each([{ status: "pending", retryPending: true }, { status: "failed", retryPending: true },
    { status: "failed", retryPending: false }, { status: "verified", retryPending: false }])(
    "projects exact Post proof $status (retry $retryPending) without another queue read", async ({ status, retryPending }) => {
    const { res, firestore } = await call(siteWide("editor"), {
      collection: "cmsPosts", id: "proof-post", publicationOnly: true,
    }, { "cmsPosts/proof-post": { type: "post", status: "published", section: "news", version: 3,
      publiclyVisible: true, published: { sourceVersion: 2 }, publicSourceVersion: 2,
      publishBuildPending: false, publishBuildQueueId: null,
      publishBuildSettlement: { status: "success", sourceVersion: 2, operation: "publish" },
      publicPostProof: { operationId: "P".repeat(20), sourceVersion: 2, status, retryPending },
    } });
    expect(res.statusCode).toBe(200);
    expect(res.body.publication).toMatchObject({ queueStatus: "success", postServingConfirmed: status !== "failed",
      postProofStatus: status, postProofPending: retryPending });
    if (status === "failed") expect(res.body.publication.postProofWarning)
      .toBe(retryPending ? "The public check failed after publication. The publisher will retry."
        : "The public check failed after publication. The publisher needs attention.");
    expect(firestore.reads).toEqual(["cmsPosts/proof-post"]);
  });

  it("does not expose a previous Post version's proof warning", async () => {
    const { res } = await call(siteWide("editor"), { collection: "cmsPosts", id: "proof-post", publicationOnly: true },
      { "cmsPosts/proof-post": { type: "post", status: "published", section: "news", version: 4,
        publiclyVisible: true, published: { sourceVersion: 4 }, publicSourceVersion: 2,
        publishBuildPending: true, publishBuildSettlement: { status: "success", sourceVersion: 2, operation: "publish" },
        publicPostProof: { operationId: "P".repeat(20), sourceVersion: 2, status: "failed", retryPending: true } } });
    expect(res.statusCode).toBe(200);
    expect(res.body.publication.postProofWarning).toBeUndefined();
    expect(res.body.publication.postServingConfirmed).toBeUndefined();
  });

  it.each(["success", "failed", "cancelled", "superseded", "public_unconfirmed"].flatMap((status) =>
    ["publish", "withdraw"].map((operation) => ({ status, operation })),
  ))("retains settled $status metadata for $operation without another queue read", async ({ status, operation }) => {
    const { res, firestore } = await call(siteWide("editor"), {
      collection: "cmsPages", id: "home", publicationOnly: true,
    }, {
      "cmsPages/home": { ...storedPage, published: { sourceVersion: 2 },
        publiclyVisible: operation === "publish", publishBuildQueueId: null,
        publishBuildPending: ["failed", "cancelled", "superseded"].includes(status),
        publishBuildSettlement: { status, sourceVersion: 2, operation },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.publication.queueStatus).toBe(status);
    expect(res.body.publication.publicBuildQueueId).toBeNull();
    expect(res.body.publication.canResumeReservation).toBe(false);
    expect(firestore.reads).toEqual(["cmsPages/home"]);
  });

  it.each([
    { status: "failed", sourceVersion: 1, operation: "publish" },
    { status: "failed", sourceVersion: 2, operation: "withdraw" },
    { status: "publishing", sourceVersion: 2, operation: "publish" },
  ])("ignores settlement for another revision, operation or nonterminal status: %j", async (publishBuildSettlement) => {
    const { res } = await call(siteWide("editor"), {
      collection: "cmsPages", id: "home", publicationOnly: true,
    }, { "cmsPages/home": { ...storedPage, publiclyVisible: true,
      published: { sourceVersion: 2 }, publishBuildQueueId: null, publishBuildSettlement,
    } });
    expect(res.body.publication.queueStatus).toBeNull();
  });

  it("uses the active queue instead of an earlier settlement", async () => {
    const { res } = await call(siteWide("editor"), {
      collection: "cmsPages", id: "home", publicationOnly: true,
    }, {
      "cmsPages/home": { ...storedPage, publiclyVisible: true, published: { sourceVersion: 2 },
        publishBuildQueueId: "queue-two",
        publishBuildSettlement: { status: "failed", sourceVersion: 2, operation: "publish" },
      },
      "cmsPublishQueue/queue-two": { status: "pending" },
    });
    expect(res.body.publication.queueStatus).toBe("pending");
  });

  it.each([1, 2])("exposes only whether a %s-change reservation can be resumed", async (count) => {
    const { res } = await call(siteWide("editor"), {
      collection: "cmsPages", id: "home", publicationOnly: true,
    }, {
      "cmsPages/home": { ...storedPage, publishBuildQueueId: "queue-one" },
      "cmsPublishQueue/queue-one": { status: "reserved", changes: Array(count).fill({ id: "private" }) },
    });
    expect(res.body.publication.canResumeReservation).toBe(count === 1);
    expect(JSON.stringify(res.body)).not.toContain("private");
  });

  it("rejects a non-POST request", async () => {
    const { handler } = handlerFor(siteWide("admin"));
    const res = makeRes();
    await handler(makeReq({ method: "GET" }), res);
    expect(res.statusCode).toBe(405);
  });

  it("returns the stored document to a principal who may edit any record", async () => {
    const { res } = await call(
      siteWide("editor"),
      { collection: "cmsPages", id: "home" },
      { "cmsPages/home": storedPage },
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.document).toEqual({ ...storedPage, id: "home" });
  });

  it("reports an absent page as found: false without a document", async () => {
    // The client owns what an absent record hydrates to (a composition seed, or
    // an empty editor whose first save creates the page). This says only that
    // nothing is stored.
    const { res } = await call(siteWide("editor"), {
      collection: "cmsPages",
      id: "contact",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, found: false, document: null });
  });

  it("refuses a page id the editor would never ask about", async () => {
    // No page is stored or storable there, so answering would only tell the
    // caller whether the id names something.
    const { res } = await call(siteWide("editor"), {
      collection: "cmsPages",
      id: "not-a-public-page",
    });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe(FORBIDDEN_MESSAGE);
  });

  it("answers an absent legacy template singleton the editor probes for a seed", async () => {
    // The client reads the page id, then falls back to the template singleton to
    // find out whether there is older work to inherit. Refusing that second read
    // would fail every unmigrated page on the read that exists to answer it.
    for (const id of ["programLanding", "genericPage"]) {
      const { res } = await call(siteWide("editor"), {
        collection: "cmsPages",
        id,
      });
      expect(res.statusCode, id).toBe(200);
      expect(res.body, id).toEqual({ success: true, found: false, document: null });
    }
  });

  it("reads a page stored under a legacy template singleton id", async () => {
    const { res } = await call(
      siteWide("editor"),
      { collection: "cmsPages", id: "programLanding" },
      { "cmsPages/programLanding": storedPage },
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.found).toBe(true);
  });

  it("reports an absent post to a principal who may edit every record", async () => {
    // A site-wide editor may already list and open every active record, so an
    // honest missing answer adds no existence oracle and lets a stale deep link
    // render the editor's safe missing state instead of a permission error.
    const { res } = await call(siteWide("editor"), {
      collection: "cmsPosts",
      id: "p-missing",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, found: false, document: null });
  });

  it("answers an absent post exactly as it answers one the caller may not read", async () => {
    // The existence probe this closes: without the identical answer, a caller
    // who may not read a stored post still learns that the id names one, from
    // the difference between "absent" and "refused".
    const absent = await call(
      siteWide("contributor", "user-7"),
      { collection: "cmsPosts", id: "p-missing" },
    );
    const denied = await call(
      siteWide("contributor", "user-7"),
      { collection: "cmsPosts", id: "p-1" },
      { "cmsPosts/p-1": storedPage },
    );
    expect(absent.res.statusCode).toBe(denied.res.statusCode);
    expect(absent.res.body).toEqual(denied.res.body);
  });

  it("does not widen an absent-post answer for a section-scoped editor", async () => {
    const scopedEditor = {
      uid: "editor-7",
      email: "editor-7@example.org",
      principal: {
        id: "editor-7",
        grants: [{ role: "editor", sections: ["news"] }],
      },
    };
    const { res } = await call(scopedEditor, {
      collection: "cmsPosts",
      id: "p-missing",
    });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe(FORBIDDEN_MESSAGE);
  });

  it("lets a contributor read a record they own", async () => {
    const { res } = await call(
      siteWide("contributor", "user-2"),
      { collection: "cmsPosts", id: "p-1" },
      { "cmsPosts/p-1": storedPage },
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.document.id).toBe("p-1");
  });

  it("refuses a contributor reading someone else's record", async () => {
    const { res } = await call(
      siteWide("contributor", "user-7"),
      { collection: "cmsPosts", id: "p-1" },
      { "cmsPosts/p-1": storedPage },
    );
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe(FORBIDDEN_MESSAGE);
    // The refusal says nothing about the record: same message a caller with no
    // content capability at all gets.
    expect(res.body.document).toBeUndefined();
  });

  it("lets a contributor read their own record after it has left draft", async () => {
    // The draft-only rule on own-content authority (#380) bounds what a
    // contributor may change, not what they may see, so the record they
    // submitted stays visible to them once it is in review.
    const { res } = await call(
      siteWide("contributor", "user-2"),
      { collection: "cmsPosts", id: "p-1" },
      { "cmsPosts/p-1": { ...storedPage, status: "in_review" } },
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.document.status).toBe("in_review");
  });

  it("answers with the addressed id over one the document carries", async () => {
    // An older record can still hold a conflicting id, and the client keys its
    // editor on the document it asked for.
    const { res } = await call(
      siteWide("editor"),
      { collection: "cmsPosts", id: "p-1" },
      { "cmsPosts/p-1": { ...storedPage, id: "p-stale" } },
    );
    expect(res.body.document.id).toBe("p-1");
  });

  it("logs every refusal, so a denied read stays visible", async () => {
    const noCapability = await call(
      noGrants(),
      { collection: "cmsPages", id: "home" },
      { "cmsPages/home": storedPage },
    );
    const unauthorized = await call(
      siteWide("contributor", "user-7"),
      { collection: "cmsPosts", id: "p-1" },
      { "cmsPosts/p-1": storedPage },
    );
    const absent = await call(siteWide("contributor", "user-7"), {
      collection: "cmsPosts",
      id: "p-missing",
    });
    const deleted = await call(
      siteWide("admin"),
      { collection: "cmsPages", id: "home" },
      { "cmsPages/home": { ...storedPage, deleted: true } },
    );
    for (const { log } of [noCapability, unauthorized, absent, deleted]) {
      expect(log.warn).toHaveBeenCalledTimes(1);
    }
  });

  it("refuses a caller with no content capability before reading anything", async () => {
    const { res, firestore } = await call(
      noGrants(),
      { collection: "cmsPages", id: "home" },
      { "cmsPages/home": storedPage },
    );
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe(FORBIDDEN_MESSAGE);
    expect(firestore.reads).toEqual([]);
  });

  it("validates the request before the capability pre-check", async () => {
    // A malformed request from an authorized caller is a 400, so the client sees
    // its own bug rather than a permission message that would send it looking in
    // the wrong place.
    const { res } = await call(siteWide("admin"), {
      collection: "users",
      id: "user-1",
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a soft-deleted record rather than reporting it absent", async () => {
    // found: false is what opens a blank editor, and a blank editor over a
    // deleted record invites a save that resurrects it as empty content.
    const { res } = await call(
      siteWide("admin"),
      { collection: "cmsPages", id: "home" },
      { "cmsPages/home": { ...storedPage, deleted: true } },
    );
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toBe(DELETED_MESSAGE);
  });

  it("refuses an unauthorized caller before the record's deleted state is used", async () => {
    // Ordering: an unauthorized caller gets the same 403 whether or not the
    // record was deleted, so the response never confirms a record exists.
    const { res } = await call(
      siteWide("contributor", "user-7"),
      { collection: "cmsPages", id: "home" },
      { "cmsPages/home": { ...storedPage, deleted: true } },
    );
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe(FORBIDDEN_MESSAGE);
  });

  it("maps a failed precondition to 503", async () => {
    const log = silentLog();
    const handler = createCmsGetContentHandler({
      firestore: {
        collection: () => ({
          doc: () => ({
            get: async () => {
              const error = new Error("The service is unavailable");
              error.code = "failed-precondition";
              throw error;
            },
          }),
        }),
      },
      requirePrincipalFn: async () => siteWide("admin"),
      log,
    });
    const res = makeRes();
    await handler(makeReq({ body: { collection: "cmsPages", id: "home" } }), res);
    expect(res.statusCode).toBe(503);
  });

  it("passes an auth failure's own status through", async () => {
    const log = silentLog();
    const handler = createCmsGetContentHandler({
      firestore: makeFirestore(),
      requirePrincipalFn: async () => {
        const error = new Error("Authentication required");
        error.status = 401;
        throw error;
      },
      log,
    });
    const res = makeRes();
    await handler(makeReq({ body: { collection: "cmsPages", id: "home" } }), res);
    expect(res.statusCode).toBe(401);
  });
});

describe("section-scoped reads (#845)", () => {
  // The read boundary states the document's own editorial desk, so a section-scoped grant
  // reaches the records in its desks and nothing else. Before #845 it stated no section at
  // all, so a scoped grant was refused every record in the CMS.
  const scoped = (sections, uid = "user-7") => ({
    uid,
    email: `${uid}@example.org`,
    principal: { id: uid, grants: [{ role: "editor", sections }] },
  });

  const watchRecord = {
    status: "draft",
    createdBy: "user-2",
    section: "watch",
    title: "Tonight",
    version: 2,
  };
  const stationRecord = { ...watchRecord, section: "station", title: "Tower" };
  const legacyRecord = { status: "draft", createdBy: "user-2", title: "Legacy", version: 1 };

  it("serves a scoped editor a record in their own desk", async () => {
    const { res } = await call(
      scoped(["watch"]),
      { collection: "cmsPosts", id: "a-1" },
      { "cmsPosts/a-1": watchRecord },
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.document).toMatchObject({ title: "Tonight" });
  });

  it("refuses a scoped editor a record in another desk", async () => {
    const { res } = await call(
      scoped(["watch"]),
      { collection: "cmsPosts", id: "a-2" },
      { "cmsPosts/a-2": stationRecord },
    );
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe(FORBIDDEN_MESSAGE);
  });

  it("refuses a scoped editor a record stored before the registry existed", async () => {
    // Deny-by-default: an unsectioned record is outside every scope until a backfill puts
    // it in one, not implicitly available to all of them.
    const { res } = await call(
      scoped(["watch"]),
      { collection: "cmsPosts", id: "a-3" },
      { "cmsPosts/a-3": legacyRecord },
    );
    expect(res.statusCode).toBe(403);
  });

  it("authorizes a canonical page against its server-owned public area", async () => {
    // The page's desk comes from the public page registry, never from the stored document:
    // /watch/ is the watch desk even though nothing in the document says so.
    const { res } = await call(
      scoped(["watch"]),
      { collection: "cmsPages", id: "watch" },
      { "cmsPages/watch": storedPage },
    );
    expect(res.statusCode).toBe(200);
  });

  it("refuses a scoped editor a page whose public area is another desk", async () => {
    const { res } = await call(
      scoped(["watch"]),
      { collection: "cmsPages", id: "support" },
      { "cmsPages/support": storedPage },
    );
    expect(res.statusCode).toBe(403);
  });

  it("ignores a stored section that disagrees with the page registry", async () => {
    // A page's desk is recomputed on every save, so a stored value that disagrees is stale.
    // Honoring it would let a page that moved areas stay readable from the desk it left.
    const { res } = await call(
      scoped(["watch"]),
      { collection: "cmsPages", id: "support" },
      { "cmsPages/support": { ...storedPage, section: "watch" } },
    );
    expect(res.statusCode).toBe(403);
  });

  it("leaves a site-wide editor's reads unchanged", async () => {
    for (const [id, document] of [
      ["a-1", watchRecord],
      ["a-2", stationRecord],
      ["a-3", legacyRecord],
    ]) {
      const { res } = await call(
        siteWide("editor"),
        { collection: "cmsPosts", id },
        { [`cmsPosts/${id}`]: document },
      );
      expect(res.statusCode, id).toBe(200);
    }
  });
});
