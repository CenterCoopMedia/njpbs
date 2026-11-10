import { describe, expect, it, vi } from "vitest";
import publishBuildState from "../../functions/lib/publish-build-state.js";
import homeOwner from "../../functions/lib/no-build-home-ownership.js";

const {
  addressedPublishChanges,
  isPendingPublishChange,
  markBuildEnqueuedInTransaction,
  settleBuildQueue,
} = publishBuildState;

const BANNER_CHANGE = {
  collection: "cmsSettings",
  id: "public-homepage-banner",
  sourceVersion: 3,
};
const PAGE_CHANGE = {
  collection: "cmsPages",
  id: "home",
  sourceVersion: 7,
};

function refs() {
  const values = new Map();
  const firestore = {
    collection: vi.fn((collection) => ({
      doc: vi.fn((id) => {
        const key = `${collection}/${id}`;
        if (!values.has(key)) values.set(key, { path: key });
        return values.get(key);
      }),
    })),
  };
  return { firestore, ref: (path) => values.get(path) };
}

describe("publish build addressed changes", () => {
  it.each([
    ["exact", { status: "published", publishBuildPending: true, published: { sourceVersion: 7 } }, true],
    ["stale", { status: "published", publishBuildPending: true, published: { sourceVersion: 6 } }, false],
    ["not pending", { status: "published", publishBuildPending: false, published: { sourceVersion: 7 } }, false],
    ["claimed", { status: "published", publishBuildPending: true, publishBuildQueueId: "other", published: { sourceVersion: 7 } }, false],
    ["draft", { status: "draft", publishBuildPending: true, published: { sourceVersion: 7 } }, false],
    ["public under draft", { status: "draft", publiclyVisible: true, publishBuildPending: true, published: { sourceVersion: 7 } }, true],
  ])("identifies an %s revision", (_label, document, expected) => {
    expect(isPendingPublishChange(document, PAGE_CHANGE)).toBe(expected);
  });

  it("preserves withdrawal intent and refuses unsupported operations", () => {
    const withdrawal = { ...PAGE_CHANGE, operation: "withdraw" };
    expect(addressedPublishChanges([withdrawal])).toEqual([withdrawal]);
    expect(addressedPublishChanges([
      { ...PAGE_CHANGE, operation: "publish-anything" },
      { ...BANNER_CHANGE, operation: "withdraw" },
    ])).toEqual([]);
  });

  it.each([
    { change: PAGE_CHANGE, status: "draft", publiclyVisible: true },
    { change: { ...PAGE_CHANGE, operation: "withdraw" }, status: "draft", publiclyVisible: false },
  ])("claims an exact pending public update independently of working status", async ({ change, status, publiclyVisible }) => {
    const { firestore } = refs();
    const transaction = { get: vi.fn(async () => ({ exists: true, data: () => ({
      status, publiclyVisible, publishBuildPending: true, publishBuildQueueId: null,
      published: { sourceVersion: 7 },
    }) })), update: vi.fn() };
    expect(await markBuildEnqueuedInTransaction(firestore, transaction, { queueId: "queue-one", changes: [change] })).toBe(1);
    expect(transaction.update).toHaveBeenCalledOnce();
  });
  it("admits only the public settings documents", () => {
    const chrome = { ...BANNER_CHANGE, id: "public-site-chrome" };
    expect(addressedPublishChanges([
      BANNER_CHANGE,
      chrome,
      { ...BANNER_CHANGE, id: "newsroom-home" },
      { ...BANNER_CHANGE, sourceVersion: 0 },
    ])).toEqual([BANNER_CHANGE, chrome]);
  });

  it("marks content pending state but does not read or mutate settings rows", async () => {
    const { firestore } = refs();
    const transaction = {
      get: vi.fn(async (ref) => {
        if (ref.path.startsWith("cmsSettings/")) {
          throw new Error("A settings row must not be read for content pending state");
        }
        return {
          exists: true,
          data: () => ({
            status: "published",
            publishBuildPending: true,
            publishBuildQueueId: null,
            published: { sourceVersion: 7 },
          }),
        };
      }),
      update: vi.fn(),
    };

    const marked = await markBuildEnqueuedInTransaction(
      firestore,
      transaction,
      { queueId: "queue-one", changes: [BANNER_CHANGE, PAGE_CHANGE] },
    );

    expect(marked).toBe(1);
    expect(transaction.get).toHaveBeenCalledTimes(1);
    expect(transaction.get.mock.calls[0][0].path).toBe("cmsPages/home");
    expect(transaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ path: "cmsPages/home" }),
      { publishBuildQueueId: "queue-one" },
    );
  });

  it("settles content pending state and leaves the settings document untouched", async () => {
    const { firestore } = refs();
    const queue = {
      status: "publishing",
      changes: [BANNER_CHANGE, PAGE_CHANGE],
    };
    const transaction = {
      get: vi.fn(async (ref) => {
        if (ref.path === "cmsPublishQueue/queue-one") {
          return { exists: true, data: () => queue };
        }
        if (ref.path.startsWith("cmsSettings/")) {
          throw new Error("A settings row must not be read for content settlement");
        }
        return {
          exists: true,
          data: () => ({
            status: "published",
            publishBuildPending: true,
            publishBuildQueueId: "queue-one",
            published: { sourceVersion: 7 },
          }),
        };
      }),
      update: vi.fn(),
    };
    firestore.runTransaction = vi.fn(async (callback) => callback(transaction));

    await settleBuildQueue(firestore, {
      queueId: "queue-one",
      status: "success",
      queueUpdate: { status: "success" },
    });

    expect(transaction.get.mock.calls.map(([ref]) => ref.path)).toEqual([
      "cmsPublishQueue/queue-one",
      "cmsPages/home",
    ]);
    expect(transaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ path: "cmsPages/home" }),
      {
        publishBuildPending: false,
        publishBuildQueueId: null,
        publishBuildSettlement: { status: "success", sourceVersion: 7, operation: "publish" },
        publicSourceVersion: 7,
      },
    );
  });

  it("settles the public snapshot after its working copy returns to draft", async () => {
    const { firestore } = refs();
    const transaction = {
      get: vi.fn(async (ref) => {
        if (ref.path === "cmsPublishQueue/queue-one") {
          return {
            exists: true,
            data: () => ({ status: "publishing", changes: [PAGE_CHANGE] }),
          };
        }
        return {
          exists: true,
          data: () => ({
            status: "draft",
            publiclyVisible: true,
            publishBuildPending: true,
            publishBuildQueueId: "queue-one",
            published: { sourceVersion: 7 },
          }),
        };
      }),
      update: vi.fn(),
    };
    firestore.runTransaction = vi.fn(async (callback) => callback(transaction));

    await settleBuildQueue(firestore, {
      queueId: "queue-one",
      status: "success",
      queueUpdate: { status: "success" },
    });

    expect(transaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ path: "cmsPages/home" }),
      {
        publishBuildPending: false,
        publishBuildQueueId: null,
        publishBuildSettlement: { status: "success", sourceVersion: 7, operation: "publish" },
        publicSourceVersion: 7,
      },
    );
  });

  it.each([false, true])("settles withdrawal only while the snapshot remains withdrawn (visible=%s)", async (publiclyVisible) => {
    const { firestore } = refs();
    const transaction = {
      get: vi.fn(async (ref) => ({ exists: true, data: () => ref.path.startsWith("cmsPublishQueue/")
        ? { status: "publishing", changes: [{ ...PAGE_CHANGE, operation: "withdraw" }] }
        : { status: "draft", publiclyVisible, publishBuildPending: true, publishBuildQueueId: "queue-one",
          published: { sourceVersion: 7 }, publicSourceVersion: 7 } })),
      update: vi.fn(),
    };
    firestore.runTransaction = vi.fn(async (callback) => callback(transaction));
    await settleBuildQueue(firestore, { queueId: "queue-one", status: "success", queueUpdate: { status: "success" } });
    const updates = transaction.update.mock.calls.filter(([ref]) => ref.path === "cmsPages/home");
    expect(updates).toHaveLength(publiclyVisible ? 0 : 1);
    if (!publiclyVisible) expect(updates[0][1]).toEqual({ publishBuildPending: false, publishBuildQueueId: null,
      publishBuildSettlement: { status: "success", sourceVersion: 7, operation: "withdraw" }, publicSourceVersion: null });
  });

  it("records the confirmed version when a public receipt upgrades an unconfirmed deployment", async () => {
    const { firestore } = refs();
    const transaction = {
      get: vi.fn(async (ref) => {
        if (ref.path === "cmsPublishQueue/queue-one") {
          return {
            exists: true,
            data: () => ({
              status: "public_unconfirmed",
              changes: [PAGE_CHANGE],
            }),
          };
        }
        return {
          exists: true,
          data: () => ({
            status: "published",
            publiclyVisible: true,
            publishBuildPending: false,
            publishBuildQueueId: null,
            published: { sourceVersion: 7 },
          }),
        };
      }),
      update: vi.fn(),
    };
    firestore.runTransaction = vi.fn(async (callback) => callback(transaction));

    await settleBuildQueue(firestore, {
      queueId: "queue-one",
      status: "success",
      queueUpdate: { status: "success" },
    });

    expect(transaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ path: "cmsPages/home" }),
      {
        publishBuildPending: false,
        publishBuildQueueId: null,
        publishBuildSettlement: { status: "success", sourceVersion: 7, operation: "publish" },
        publicSourceVersion: 7,
      },
    );
  });

  it.each(["failed", "cancelled", "superseded", "public_unconfirmed"].flatMap((status) =>
    [false, true].map((withdrawal) => ({ status, withdrawal })),
  ))("stores $status with the settled revision and operation (withdrawal=$withdrawal)", async ({ status, withdrawal }) => {
    const { firestore } = refs();
    const change = { ...PAGE_CHANGE, ...(withdrawal ? { operation: "withdraw" } : {}) };
    const transaction = {
      get: vi.fn(async (ref) => ({ exists: true, data: () => ref.path.startsWith("cmsPublishQueue/")
        ? { status: "publishing", changes: [change] }
        : { status: "draft", publiclyVisible: !withdrawal, publishBuildPending: true,
          publishBuildQueueId: "queue-one", published: { sourceVersion: 7 } } })),
      update: vi.fn(),
    };
    firestore.runTransaction = vi.fn(async (callback) => callback(transaction));
    await settleBuildQueue(firestore, { queueId: "queue-one", status, queueUpdate: { status } });
    expect(transaction.update).toHaveBeenCalledWith(expect.objectContaining({ path: "cmsPages/home" }), {
      publishBuildPending: status !== "public_unconfirmed", publishBuildQueueId: null,
      publishBuildSettlement: { status, sourceVersion: 7, operation: withdrawal ? "withdraw" : "publish" },
    });
  });
});

const SERIALIZER_QUEUE_ID = "SERIALIZERqueue00001";
const HOME_OPERATION_ID = "HOMEpageoperation001";

function serializerFixture({ transport = "serializer", owner = true, status = "publishing", runtime } = {}) {
  const rendererSha = "a".repeat(40);
  const queuePath = `cmsPublishQueue/${SERIALIZER_QUEUE_ID}`;
  const rows = new Map([
    [queuePath, { status, transport, ...(runtime ? { runtime } : {}), changes: [
      { collection: "cmsPosts", id: "story-two", sourceVersion: 4, operation: "withdraw" },
      { collection: "cmsPosts", id: "story-one", sourceVersion: 3 },
      { collection: "cmsPosts", id: "stale-story", sourceVersion: 2 },
      { collection: "cmsPosts", id: "reclaimed-story", sourceVersion: 3 },
    ] }],
    ["cmsPages/home", { publiclyVisible: true, title: "Private Home draft", published: { sourceVersion: 7,
      metadata: { homeHero: { mode: "category", source: "cms_posts", value: "previous-category" } },
      blocks: [{ id: "saved-posts", type: "content_shelf", section: "home-posts",
        data: { source: "station_posts", title: "Station stories" } }] } }],
    ...[["story-one", 3, true], ["story-two", 4, false], ["stale-story", 9, true], ["reclaimed-story", 3, true]]
      .map(([id, sourceVersion, publiclyVisible]) => [`cmsPosts/${id}`, { publiclyVisible,
        status: "draft", publishBuildPending: true,
        publishBuildQueueId: id === "reclaimed-story" ? "another-queue" : SERIALIZER_QUEUE_ID,
        published: { sourceVersion, metadata: { slug: id, categories: ["new-category"], previousSlugs: [] } } }]),
  ]);
  if (owner) {
    rows.set(homeOwner.HOME_PAGE_OWNER_PATH, { schemaVersion: 1, pageId: "home", path: "/",
      ownedPaths: ["/", "/_home-sources.json"], operationId: HOME_OPERATION_ID, sourceVersion: 7,
      generation: 22, rendererSha, visible: true, runtime: { owner: "cloudflare", release: rendererSha } });
    rows.set(homeOwner.HOME_BACKGROUND_PATH, { schemaVersion: 1, owner: homeOwner.HOME_PAGE_OWNER,
      pageId: "home", ownerPath: homeOwner.HOME_PAGE_OWNER_PATH, operationId: HOME_OPERATION_ID });
  }
  let writing = false;
  const read = vi.fn(async ref => {
    if (writing) throw new Error("Firestore reads must precede writes");
    return { exists: rows.has(ref.path), data: () => rows.get(ref.path) };
  });
  const transaction = { get: read, getAll: vi.fn(async (...refs) => Promise.all(refs.map(read))),
    update: vi.fn((ref, update) => { writing = true; rows.set(ref.path, { ...rows.get(ref.path), ...update }); }),
    create: vi.fn((ref, value) => {
      writing = true;
      if (rows.has(ref.path)) throw new Error("Duplicate task");
      rows.set(ref.path, value);
    }) };
  const firestore = { doc: path => ({ path }), collection: collection => ({ doc: id => ({ path: `${collection}/${id}` }) }),
    runTransaction: async callback => { writing = false; return callback(transaction); } };
  const settle = (status = "success") => settleBuildQueue(firestore, { queueId: SERIALIZER_QUEUE_ID, status,
    queueUpdate: { status }, returnResult: true });
  return { rows, transaction, settle, taskPath: `${queuePath}/homePageRefresh/home` };
}

describe("serializer Post completion after Home Page transfer", () => {
  it("creates one grouped refresh for exactly settled publish and withdrawal revisions before any writes", async () => {
    const { rows, transaction, settle, taskPath } = serializerFixture();
    const savedHome = rows.get("cmsPages/home");
    expect(await settle()).toEqual({ settled: true, idempotent: false });
    expect(transaction.create).toHaveBeenCalledOnce();
    const task = rows.get(taskPath);
    expect(task).toMatchObject({ owner: homeOwner.HOME_PAGE_OWNER, revision: 1, status: "pending", input: {
      sourceTransport: "serializer", sourceOperationId: SERIALIZER_QUEUE_ID, homeOperationId: HOME_OPERATION_ID,
      homeSourceVersion: 7, postChanges: [
        { postId: "story-one", sourceVersion: 3, visible: true },
        { postId: "story-two", sourceVersion: 4, visible: false },
      ],
    } });
    expect(task.affectedSections).toEqual([
      { blockId: "saved-posts", section: "home-posts", title: "Station stories", refreshable: true },
      { blockId: "hero", section: "hero", title: "Home hero", refreshable: true },
    ]);
    expect(JSON.stringify(task)).not.toContain("Private");
    expect(rows.get("cmsPages/home")).toBe(savedHome);
    expect(rows.get("cmsPosts/story-one").publicSourceVersion).toBe(3);
    expect(rows.get("cmsPosts/story-two").publicSourceVersion).toBeNull();
    expect(rows.get("cmsPosts/stale-story").publishBuildPending).toBe(true);
    expect(rows.get("cmsPosts/reclaimed-story").publishBuildPending).toBe(true);
    expect(rows.get(homeOwner.HOME_PAGE_OWNER_PATH).homeRefresh).toMatchObject({ revision: 1, taskPath });
    const writes = transaction.update.mock.calls.length;
    expect(await settle()).toEqual({ settled: true, idempotent: true });
    expect(transaction.create).toHaveBeenCalledOnce();
    expect(transaction.update).toHaveBeenCalledTimes(writes);
    expect(rows.get(homeOwner.HOME_PAGE_OWNER_PATH).homeRefresh.revision).toBe(1);
  });

  it.each([
    { transport: "post-no-build-v1" },
    { transport: "github" },
    { transport: "github", runtime: { owner: "node-compute", release: "a".repeat(40) } },
  ])("does not add a full-build refresh to an unsupported queue $transport/$runtime.owner", async fields => {
    const { transaction, settle, taskPath, rows } = serializerFixture(fields);
    await settle();
    expect(transaction.create).not.toHaveBeenCalled();
    expect(rows.has(taskPath)).toBe(false);
    expect(transaction.getAll).not.toHaveBeenCalled();
  });

  it("refreshes the dev GitHub Cloudflare queue exactly once with its actual transport", async () => {
    const { rows, transaction, settle, taskPath } = serializerFixture({ transport: "github",
      runtime: { owner: "cloudflare", release: "a".repeat(40) } });
    expect(await settle()).toEqual({ settled: true, idempotent: false });
    expect(rows.get(taskPath).input).toMatchObject({ sourceTransport: "github", postChanges: [
      { postId: "story-one", sourceVersion: 3, visible: true },
      { postId: "story-two", sourceVersion: 4, visible: false },
    ] });
    expect(rows.get(homeOwner.HOME_PAGE_OWNER_PATH).homeRefresh)
      .toMatchObject({ sourceTransport: "github", revision: 1 });
    expect(transaction.create).toHaveBeenCalledOnce();
    const writes = transaction.update.mock.calls.length;
    expect(await settle()).toEqual({ settled: true, idempotent: true });
    expect(transaction.create).toHaveBeenCalledOnce();
    expect(transaction.update).toHaveBeenCalledTimes(writes);
  });

  it.each(["failed", "cancelled", "public_unconfirmed"])("does not invalidate Home for %s settlement", async status => {
    const { transaction, settle } = serializerFixture();
    await settle(status);
    expect(transaction.create).not.toHaveBeenCalled();
    expect(transaction.getAll).not.toHaveBeenCalled();
  });

  it("leaves the legacy Home path unchanged without a Home Page owner", async () => {
    const { transaction, settle, taskPath, rows } = serializerFixture({ owner: false });
    await settle();
    expect(transaction.create).not.toHaveBeenCalled();
    expect(rows.has(taskPath)).toBe(false);
    expect(transaction.update.mock.calls.map(([ref]) => ref.path)).toEqual([
      `cmsPublishQueue/${SERIALIZER_QUEUE_ID}`, "cmsPosts/story-two", "cmsPosts/story-one",
    ]);
  });

  it("skips Home reads and writes when every Post revision is stale", async () => {
    const { transaction, settle, rows } = serializerFixture();
    rows.get("cmsPosts/story-one").published.sourceVersion = 8;
    rows.get("cmsPosts/story-two").publiclyVisible = true;
    await settle();
    expect(transaction.create).not.toHaveBeenCalled();
    expect(transaction.getAll).not.toHaveBeenCalled();
    expect(transaction.update).toHaveBeenCalledOnce();
  });

  it("prepares catalog-only refreshes and refuses mismatched fresh Home authority before writes", async () => {
    const { transaction, settle, taskPath, rows } = serializerFixture();
    rows.get("cmsPages/home").published = { sourceVersion: 7, blocks: [], metadata: {} };
    await settle();
    expect(rows.get(taskPath).affectedSections).toEqual([]);
    const inconsistent = serializerFixture();
    inconsistent.rows.get("cmsPages/home").published.sourceVersion = 8;
    await expect(inconsistent.settle()).rejects.toMatchObject({ status: 409 });
    expect(inconsistent.transaction.update).not.toHaveBeenCalled();
    expect(inconsistent.transaction.create).not.toHaveBeenCalled();
  });

  it("invalidates copied legacy sections when previous public slugs are unavailable", async () => {
    const { settle, taskPath, rows } = serializerFixture();
    rows.get("cmsPosts/story-one").published.metadata.previousSlugs = 12;
    rows.get("cmsPages/home").published.blocks.push({ id: "copied-story", type: "html", section: "station-news",
      html: '<a href="/posts/old-slug-not-retained">Previous public story</a>' },
    { id: "hidden-story", type: "html", section: "hidden", visible: false });
    await settle();
    expect(rows.get(taskPath).affectedSections).toContainEqual({ blockId: "copied-story", section: "station-news",
      title: "station-news", refreshable: false });
    expect(rows.get(taskPath).affectedSections.some(section => section.blockId === "hidden-story")).toBe(false);
  });

  it("requires the fresh Home marker and freezes an unconfirmed receipt upgrade", async () => {
    const inconsistent = serializerFixture();
    inconsistent.rows.delete(homeOwner.HOME_BACKGROUND_PATH);
    await expect(inconsistent.settle()).rejects.toMatchObject({ status: 409 });
    expect(inconsistent.transaction.update).not.toHaveBeenCalled();
    const upgrade = serializerFixture({ status: "public_unconfirmed" });
    for (const id of ["story-one", "story-two"]) {
      Object.assign(upgrade.rows.get(`cmsPosts/${id}`), { publishBuildPending: false, publishBuildQueueId: null });
    }
    await upgrade.settle();
    expect(upgrade.rows.get(upgrade.taskPath).input.postChanges).toHaveLength(2);
    expect(upgrade.transaction.create).toHaveBeenCalledOnce();
  });
});
