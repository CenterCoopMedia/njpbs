import { describe, expect, it, vi } from "vitest";
import listMediaUsage from "../../functions/list-media-usage.js";

const {
  MAX_USAGE_SCAN,
  createCmsListMediaUsageHandler,
} = listMediaUsage;

const ASSET_ID = "asset-one";
const ACTIVE_COMMIT = "b".repeat(40);
const CANDIDATE_COMMIT = "c".repeat(40);

function makeReq({
  method = "POST",
  body = { assetId: ASSET_ID },
  headers = { "content-type": "application/json" },
  rawBody,
} = {}) {
  return { method, body, headers, rawBody, ip: "203.0.113.9" };
}

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    headersSent: false,
    headers: new Map(),
  };
  res.set = (name, value) => {
    res.headers.set(name.toLocaleLowerCase(), value);
    return res;
  };
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

function actor(role = "editor", uid = "editor-1", grants = [{ role }]) {
  return {
    uid,
    email: `${uid}@example.org`,
    principal: { id: uid, grants },
  };
}

function asset(category = "news", overrides = {}) {
  return { lifecycle: "active", category, ...overrides };
}

function usage(state = "working", overrides = {}) {
  return {
    state,
    sourceVersion: 2,
    assetIds: [ASSET_ID],
    occurrenceCount: 4,
    privateIndexDetail: "do-not-return",
    ...(state === "deployed"
      ? { generation: 7, commitSha: ACTIVE_COMMIT }
      : {}),
    ...overrides,
  };
}

function post(overrides = {}) {
  return {
    type: "post",
    title: "News item",
    version: 2,
    published: { sourceVersion: 2 },
    section: "news",
    createdBy: "editor-2",
    privateBody: "do-not-return",
    ...overrides,
  };
}

function readyPointer(overrides = {}) {
  return {
    schemaVersion: 1,
    mediaLifecycleReady: true,
    state: "idle",
    activeGeneration: 7,
    activeDeploymentId: "deployment-7",
    activeCommitSha: ACTIVE_COMMIT,
    lastReservedGeneration: 7,
    newestEligibleGeneration: 7,
    newestEligibleBuildBatchId: "build-seven",
    ...overrides,
  };
}

const timestamp = { toMillis: () => Date.parse("2026-08-14T15:00:00.000Z") };

function busyPointer(state) {
  return readyPointer({
    state,
    lastReservedGeneration: 8,
    newestEligibleGeneration: 8,
    newestEligibleBuildBatchId: "build-eight",
    leaseToken: "11111111-1111-4111-8111-111111111111",
    leaseAcquiredAt: timestamp,
    candidateGeneration: 8,
    candidateBuildBatchId: "build-eight",
    candidateCommitSha: CANDIDATE_COMMIT,
    predecessorGeneration: 7,
    predecessorDeploymentId: "deployment-7",
    predecessorCommitSha: ACTIVE_COMMIT,
    ...(state === "reconciling"
      ? { reconcilingAt: timestamp, cloudflareEvidenceDigest: "d".repeat(64) }
      : {}),
  });
}

function fakeFirestore(seed = {}, { transactionError = null } = {}) {
  const documents = new Map(Object.entries(seed));
  const observed = {
    documentReads: [],
    ownerReads: [],
    queries: [],
    transactionOptions: [],
  };

  const documentSnapshot = (ref) => ({
    exists: documents.has(ref.path),
    ref,
    data: () => documents.get(ref.path),
  });

  const firestore = {
    doc: (path) => ({ kind: "document", path }),
    collectionGroup: (name) => {
      const spec = { name, filters: [], limit: null };
      const query = {
        kind: "query",
        spec,
        where(field, operator, value) {
          spec.filters.push([field, operator, value]);
          return query;
        },
        limit(value) {
          spec.limit = value;
          return query;
        },
      };
      return query;
    },
    runTransaction: vi.fn(async (callback, options) => {
      observed.transactionOptions.push(options);
      if (transactionError) throw transactionError;
      const transaction = {
        get: vi.fn(async (ref) => {
          if (ref.kind !== "query") {
            observed.documentReads.push(ref.path);
            return documentSnapshot(ref);
          }
          const { name, filters, limit } = ref.spec;
          observed.queries.push({
            name,
            filters: filters.map((filter) => [...filter]),
            limit,
          });
          let matches = [...documents.entries()].filter(([path]) => {
            const parts = path.split("/");
            return parts.at(-2) === name;
          });
          for (const [field, operator, expected] of filters) {
            matches = matches.filter(([, value]) => {
              if (operator === "==") return value?.[field] === expected;
              if (operator === "array-contains") {
                return Array.isArray(value?.[field]) && value[field].includes(expected);
              }
              throw new Error(`Unsupported fake query operator ${operator}`);
            });
          }
          if (limit !== null) matches = matches.slice(0, limit);
          return {
            docs: matches.map(([path]) =>
              documentSnapshot({ kind: "document", path })),
          };
        }),
        getAll: vi.fn(async (...refs) => {
          observed.ownerReads.push(...refs.map((ref) => ref.path));
          return refs.map(documentSnapshot);
        }),
      };
      return callback(transaction);
    }),
  };
  return { firestore, observed };
}

async function call({
  seed = {},
  user = actor(),
  request = makeReq(),
  transactionError = null,
} = {}) {
  const { firestore, observed } = fakeFirestore(seed, { transactionError });
  const requirePrincipalFn = vi.fn(async () => user);
  const log = { error: vi.fn() };
  const handler = createCmsListMediaUsageHandler({
    firestore,
    requirePrincipalFn,
    log,
  });
  const response = makeRes();
  await handler(request, response);
  return { response, observed, requirePrincipalFn, firestore, log };
}

describe("cmsListMediaUsage request boundary", () => {
  it("rejects unsupported methods before authentication", async () => {
    const result = await call({ request: makeReq({ method: "GET" }) });

    expect(result.response.statusCode).toBe(405);
    expect(result.requirePrincipalFn).not.toHaveBeenCalled();
    expect(result.firestore.runTransaction).not.toHaveBeenCalled();
    expect(result.response.headers.get("cache-control")).toBe("private, no-store");
  });

  it.each([
    ["a non-JSON request", makeReq({ headers: { "content-type": "text/plain" } }), 415],
    ["a compressed request", makeReq({ headers: {
      "content-type": "application/json",
      "content-encoding": "gzip",
    } }), 415],
    ["an oversized request", makeReq({ rawBody: Buffer.alloc(4 * 1024 + 1) }), 413],
  ])("rejects %s before authentication", async (_label, request, status) => {
    const result = await call({ request });

    expect(result.response.statusCode).toBe(status);
    expect(result.requirePrincipalFn).not.toHaveBeenCalled();
    expect(result.firestore.runTransaction).not.toHaveBeenCalled();
  });

  it.each([
    [null],
    [[]],
    [{}],
    [{ assetId: ASSET_ID, unknown: true }],
    [{ assetId: ASSET_ID, state: "candidate" }],
    [{ assetId: ASSET_ID, page: 0 }],
    [{ assetId: ASSET_ID, page: MAX_USAGE_SCAN + 1 }],
    [{ assetId: ASSET_ID, pageSize: 51 }],
  ])("rejects the invalid body %j before Firestore", async (body) => {
    const result = await call({ request: makeReq({ body }) });

    expect(result.response.statusCode).toBe(400);
    expect(result.firestore.runTransaction).not.toHaveBeenCalled();
  });

  it("rejects a caller with no media grant before Firestore", async () => {
    const result = await call({ user: actor("staff") });

    expect(result.response.statusCode).toBe(403);
    expect(result.firestore.runTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing asset", {}],
    ["an inactive asset", { [`media_assets/${ASSET_ID}`]: { ...asset("sports"), lifecycle: "tombstoned" } }],
  ])("returns the same refusal for %s before querying usage", async (_label, seed) => {
    const user = actor("editor", "editor-1", [
      { role: "editor", sections: ["news"], registeredMediaSections: ["news"] },
    ]);
    const result = await call({ seed, user });

    expect(result.response).toMatchObject({
      statusCode: 403,
      body: { error: "You do not have permission to read this media usage." },
    });
    expect(result.observed.queries).toEqual([]);
    expect(result.observed.ownerReads).toEqual([]);
  });
});

describe("cmsListMediaUsage owner authorization", () => {
  it("filters content owners before totals and paging and projects public fields only", async () => {
    const seed = {
      [`media_assets/${ASSET_ID}`]: asset(),
      "cmsPosts/news-row/mediaUsage/working": usage(),
      "cmsPosts/own-row/mediaUsage/working": usage(),
      "cmsPosts/denied-row/mediaUsage/working": usage(),
      "cmsPosts/deleted-row/mediaUsage/working": usage(),
      "cmsPosts/missing-row/mediaUsage/working": usage(),
      "otherOwners/unknown/mediaUsage/working": usage(),
      "tenants/acme/cmsPosts/nested/mediaUsage/working": usage(),
      "cmsPosts/news-row": post({ title: "Desk report" }),
      "cmsPosts/own-row": post({
        title: "My report",
        section: "sports",
        createdBy: "editor-1",
      }),
      "cmsPosts/denied-row": post({ section: "sports" }),
      "cmsPosts/deleted-row": post({ deleted: true }),
    };
    const user = actor("editor", "editor-1", [
      { role: "editor", sections: ["news"], registeredMediaSections: ["news"] },
      { role: "contributor" },
    ]);
    const result = await call({
      seed,
      user,
      request: makeReq({ body: {
        assetId: ASSET_ID,
        state: "working",
        page: 2,
        pageSize: 1,
      } }),
    });

    expect(result.response.statusCode).toBe(200);
    expect(result.response.body).toMatchObject({
      success: true,
      total: 2,
      page: 2,
      pageSize: 1,
      pageCount: 2,
      items: [{
        collection: "cmsPosts",
        documentId: "own-row",
        title: "My report",
        sourceVersion: 2,
      }],
    });
    expect(Object.keys(result.response.body.items[0]).sort()).toEqual([
      "collection",
      "documentId",
      "sourceVersion",
      "title",
    ]);
    expect(result.observed.queries).toEqual([{
      name: "mediaUsage",
      filters: [
        ["state", "==", "working"],
        ["assetIds", "array-contains", ASSET_ID],
      ],
      limit: MAX_USAGE_SCAN + 1,
    }]);
    expect(result.observed.transactionOptions).toEqual([{ readOnly: true }]);
    expect(result.observed.ownerReads.sort()).toEqual([
      "cmsPosts/deleted-row",
      "cmsPosts/denied-row",
      "cmsPosts/missing-row",
      "cmsPosts/news-row",
      "cmsPosts/own-row",
    ]);
  });

  it.each(["working", "deployed"])(
    "applies settings.manage to %s usage",
    async (state) => {
      const path = state === "deployed"
        ? "cmsSettings/site-brand/mediaUsage/deployed-7"
        : "cmsSettings/site-brand/mediaUsage/working";
      const seed = {
        [`media_assets/${ASSET_ID}`]: asset(),
        [path]: usage(state, { sourceVersion: 3 }),
        "cmsSettings/site-brand": { version: 3, published: { sourceVersion: 3 } },
        ...(state === "deployed"
          ? { "system/publicDeployment": readyPointer() }
          : {}),
      };
      const request = makeReq({ body: { assetId: ASSET_ID, state } });

      const allowed = await call({
        seed,
        request,
        user: actor("admin", "admin-1"),
      });
      const denied = await call({
        seed,
        request,
        user: actor("editor", "editor-1"),
      });

      expect(allowed.response.statusCode).toBe(200);
      expect(allowed.response.body.items).toEqual([
        expect.objectContaining({ collection: "cmsSettings", documentId: "site-brand" }),
      ]);
      expect(denied.response.statusCode).toBe(200);
      expect(denied.response.body).toMatchObject({ items: [], total: 0, pageCount: 0 });
    },
  );

  it.each(["working", "deployed"])(
    "resolves %s profile usage through the private uid or users.manage",
    async (state) => {
      const path = state === "deployed"
        ? "cmsAuthorProfilesPublic/author-one/mediaUsage/deployed-7"
        : "cmsAuthorProfiles/author-one/mediaUsage/working";
      const seed = {
        [`media_assets/${ASSET_ID}`]: asset(),
        [path]: usage(state, { sourceVersion: 4 }),
        "cmsAuthorProfiles/author-one": {
          uid: "editor-1",
          displayName: "Alex Rivera",
          visibility: "published",
          version: 4,
          privateNotes: "do-not-return",
        },
        // The public projection is not an identity authority.
        "cmsAuthorProfilesPublic/author-one": {
          authorId: "author-one",
          uid: "someone-else",
          snapshotVersion: 4,
        },
        ...(state === "deployed"
          ? { "system/publicDeployment": readyPointer() }
          : {}),
      };
      const request = makeReq({ body: { assetId: ASSET_ID, state } });

      const self = await call({ seed, request });
      const other = await call({ seed, request, user: actor("editor", "editor-2") });
      const admin = await call({ seed, request, user: actor("admin", "admin-1") });

      expect(self.response.body.items).toEqual([
        expect.objectContaining({
          collection: state === "deployed"
            ? "cmsAuthorProfilesPublic"
            : "cmsAuthorProfiles",
          documentId: "author-one",
          title: "Alex Rivera",
        }),
      ]);
      expect(other.response.body).toMatchObject({ items: [], total: 0 });
      expect(admin.response.body.items).toHaveLength(1);
      expect(self.observed.ownerReads).toEqual(["cmsAuthorProfiles/author-one"]);
    },
  );
});

describe("cmsListMediaUsage state integrity", () => {
  it("selects only the active deployed generation and validates its commit", async () => {
    const seed = {
      [`media_assets/${ASSET_ID}`]: asset(),
      "system/publicDeployment": readyPointer(),
      "cmsPosts/old/mediaUsage/deployed-6": usage("deployed", {
        generation: 6,
        commitSha: "a".repeat(40),
      }),
      "cmsPosts/active/mediaUsage/deployed-7": usage("deployed", {
        sourceVersion: 4,
      }),
      "cmsPosts/candidate/mediaUsage/deployed-8": usage("deployed", {
        generation: 8,
        commitSha: CANDIDATE_COMMIT,
      }),
      "cmsPosts/old": post({ version: 4 }),
      "cmsPosts/active": post({ title: "Active version", version: 4 }),
      "cmsPosts/candidate": post({ version: 4 }),
    };
    const request = makeReq({ body: { assetId: ASSET_ID, state: "deployed" } });
    const result = await call({ seed, request });

    expect(result.response.statusCode).toBe(200);
    expect(result.response.body).toMatchObject({
      generation: 7,
      total: 1,
      items: [{ documentId: "active", title: "Active version" }],
    });
    expect(result.observed.queries[0].filters).toEqual([
      ["state", "==", "deployed"],
      ["assetIds", "array-contains", ASSET_ID],
      ["generation", "==", 7],
    ]);
    expect(result.observed.ownerReads).toEqual(["cmsPosts/active"]);

    const wrongCommit = await call({
      request,
      seed: {
        [`media_assets/${ASSET_ID}`]: asset(),
        "system/publicDeployment": readyPointer(),
        "cmsPosts/active/mediaUsage/deployed-7": usage("deployed", {
          commitSha: CANDIDATE_COMMIT,
        }),
        "cmsPosts/active": post(),
      },
    });
    expect(wrongCommit.response.statusCode).toBe(503);
  });

  it.each([
    ["a missing pointer", null],
    ["a deploying pointer", busyPointer("deploying")],
    ["a reconciling pointer", busyPointer("reconciling")],
  ])("refuses deployed reads with %s", async (_label, pointer) => {
    const seed = { [`media_assets/${ASSET_ID}`]: asset() };
    if (pointer) seed["system/publicDeployment"] = pointer;
    const result = await call({
      seed,
      request: makeReq({ body: { assetId: ASSET_ID, state: "deployed" } }),
    });

    expect(result.response.statusCode).toBe(503);
    expect(result.observed.queries).toEqual([]);
    expect(result.observed.ownerReads).toEqual([]);
  });

  it("serves an empty mutable result without reading the deployment pointer", async () => {
    const result = await call({
      seed: { [`media_assets/${ASSET_ID}`]: asset() },
      request: makeReq({ body: {
        assetId: ASSET_ID,
        state: "published",
        page: 3,
        pageSize: 10,
      } }),
    });

    expect(result.response.statusCode).toBe(200);
    expect(result.response.body).toMatchObject({
      generation: null,
      coverage: "indexed_only",
      items: [],
      total: 0,
      page: 3,
      pageSize: 10,
      pageCount: 0,
    });
    expect(result.observed.documentReads).toEqual([`media_assets/${ASSET_ID}`]);
  });

  it("fails a stale visible owner and ignores a stale unauthorized owner", async () => {
    const user = actor("editor", "editor-1", [
      { role: "editor", sections: ["news"], registeredMediaSections: ["news"] },
    ]);
    const hiddenStale = await call({
      user,
      seed: {
        [`media_assets/${ASSET_ID}`]: asset(),
        "cmsPosts/visible/mediaUsage/working": usage(),
        "cmsPosts/hidden/mediaUsage/working": usage("working", { sourceVersion: 99 }),
        "cmsPosts/visible": post(),
        "cmsPosts/hidden": post({ section: "sports" }),
      },
    });
    expect(hiddenStale.response.statusCode).toBe(200);
    expect(hiddenStale.response.body.items.map((item) => item.documentId)).toEqual([
      "visible",
    ]);

    const visibleStale = await call({
      user,
      seed: {
        [`media_assets/${ASSET_ID}`]: asset(),
        "cmsPosts/visible/mediaUsage/working": usage("working", { sourceVersion: 99 }),
        "cmsPosts/visible": post(),
      },
    });
    expect(visibleStale.response.statusCode).toBe(503);
  });

  it("refuses more than 500 matching references before owner reads", async () => {
    const seed = { [`media_assets/${ASSET_ID}`]: asset() };
    for (let index = 0; index <= MAX_USAGE_SCAN; index += 1) {
      const id = String(index).padStart(3, "0");
      seed[`cmsPosts/post-${id}/mediaUsage/working`] = usage();
    }
    const result = await call({ seed });

    expect(result.response.statusCode).toBe(503);
    expect(result.observed.queries[0].limit).toBe(MAX_USAGE_SCAN + 1);
    expect(result.observed.ownerReads).toEqual([]);
  });

  it("redacts unexpected failures", async () => {
    const result = await call({
      transactionError: new Error("sensitive database failure"),
    });

    expect(result.response).toMatchObject({
      statusCode: 500,
      body: { error: "Failed to read media usage" },
    });
    expect(JSON.stringify(result.response.body)).not.toContain("sensitive");
    expect(result.log.error).toHaveBeenCalledOnce();
  });
});
