import { describe, expect, it, vi } from "vitest";
import { assertPublicArtifactInventoryReceipt } from "../src/lib/public-artifact-inventory";
import { assertPublicArtifactBundle } from "../src/lib/public-artifact-bundle";
import { PUBLIC_PAGES } from "../../packages/content-core/src/public-pages";
import {
  COVERAGE_LABELS_SETTINGS_ID,
  STORY_CTAS_SETTINGS_ID,
  DEFAULT_PUBLIC_SITE_CHROME_SETTINGS,
  DEFAULT_NJ_DECIDES_SETTINGS,
  NJ_DECIDES_SETTINGS_ID,
  DEFAULT_SITE_NAVIGATION,
  PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
  PUBLIC_SITE_CHROME_SETTINGS_ID,
  SITE_NAVIGATION_SETTINGS_ID,
} from "../../packages/content-core/src/cms-settings";
import {
  projectPublicArtifactContent,
  readPublicArtifactContentFromDatabase,
  resolvePublicArtifactBuildRequest,
  type CmsPageDoc,
} from "../src/lib/cms-loader";
import { approvedLibraryRecord } from "./fixtures/approved-library-record";

const COMMIT_SHA = "a".repeat(40);
const CUTOFF_MILLIS = Date.parse("2026-08-14T20:00:00.000Z");
const CUTOFF = {
  seconds: Math.floor(CUTOFF_MILLIS / 1_000),
  nanoseconds: 0,
  toMillis: () => CUTOFF_MILLIS,
};

function reservation(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    buildBatchId: "build-one",
    generation: 8,
    status: "reserved",
    commitSha: COMMIT_SHA,
    reservedAgainstGeneration: 7,
    reservedAgainstDeploymentId: "deployment-seven",
    reservedAgainstCommitSha: "b".repeat(40),
    cutoffAt: CUTOFF,
    reservedAt: CUTOFF,
    ...overrides,
  };
}

function deployedBatch(overrides: Record<string, unknown> = {}) {
  return reservation({
    status: "deployed",
    readyAt: CUTOFF,
    leaseToken: "lease-one",
    leaseAcquiredAt: CUTOFF,
    predecessorGeneration: 7,
    predecessorDeploymentId: "deployment-seven",
    predecessorCommitSha: "b".repeat(40),
    mediaManifestDigest: "c".repeat(64),
    cloudflareEvidenceDigest: "d".repeat(64),
    deployedAt: CUTOFF,
    deploymentId: "12345678-1234-1234-1234-123456789abc",
    deploymentVersionId: "abcdefab-1234-1234-1234-abcdefabcdef",
    ...overrides,
  });
}

function page(documentId: string, overrides: Partial<CmsPageDoc> = {}): CmsPageDoc {
  const definition = PUBLIC_PAGES.find(({ id }) => id === documentId)!;
  const sourceVersion = PUBLIC_PAGES.findIndex(({ id }) => id === documentId) + 1;
  return {
    id: documentId,
    title: `${definition.title} working`,
    template: definition.editorTemplate,
    status: "published",
    publishAt: "2026-08-14T19:00:00.000Z",
    blocks: [],
    version: sourceVersion,
    published: {
      blocks: [],
      metadata: { title: definition.title },
      publishedAt: "2026-08-14T19:00:00.000Z",
      publishedBy: "editor-one",
      sourceVersion,
    },
    ...overrides,
  };
}

function snapshot(id: string, value: Record<string, unknown> | undefined) {
  return {
    id,
    exists: value !== undefined,
    data: () => value ?? {},
  };
}

function databaseFixture({
  documents = Object.fromEntries(
    PUBLIC_PAGES.map(({ id }) => [id, page(id)]),
  ),
  storedReservation = reservation(),
  posts = [],
  assets = {},
  authors = [],
  history = posts.flatMap(({ id, data }) => data.approvedLibraryVersion ? [{ id: `approve-${id}`, data: {
    collection: "cmsPosts", documentId: id, action: "approve", after: data.approvedLibraryVersion,
  } }] : []),
  setting,
  navigation,
  chrome,
  njDecides,
  coverageLabels,
  storyCtas,
}: {
  documents?: Record<string, CmsPageDoc>;
  storedReservation?: Record<string, unknown>;
  posts?: { id: string; data: Record<string, unknown> }[];
  assets?: Record<string, Record<string, unknown>>;
  authors?: { id: string; data: Record<string, unknown> }[];
  history?: { id: string; data: Record<string, unknown> }[];
  setting?: Record<string, unknown>;
  navigation?: Record<string, unknown>;
  chrome?: Record<string, unknown>;
  njDecides?: Record<string, unknown>;
  coverageLabels?: Record<string, unknown>;
  storyCtas?: Record<string, unknown>;
} = {}) {
  const readBatches: string[][] = [];
  const queryReads: string[] = [];
  const runTransaction = vi.fn(async (
    callback: (transaction: {
      getAll: (...refs: Array<{ path: string; id: string }>) => Promise<unknown[]>;
      get: (query: { path: string; filters?: [string, string][] }) => Promise<{ docs: unknown[] }>;
    }) => Promise<unknown>,
    _options: unknown,
  ) => callback({
    async get(query) {
      queryReads.push(query.path);
      const rows = query.path === "cmsPages"
        ? Object.entries(documents).map(([id, data]) => ({ id, data }))
        : query.path === "cmsPosts" ? posts
        : query.path === "cmsVersionHistory" ? history.filter(row =>
          (query.filters ?? []).every(([field, value]) => row.data[field] === value)) : authors;
      return { docs: rows.map(row => snapshot(row.id, row.data)) };
    },
    async getAll(...refs) {
      const paths = refs.map(({ path }) => path);
      readBatches.push(paths);
      if (
        paths.length === 6 &&
        paths[0] === `cmsSettings/${PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID}` &&
        paths[1] === `cmsSettings/${SITE_NAVIGATION_SETTINGS_ID}` &&
        paths[2] === `cmsSettings/${PUBLIC_SITE_CHROME_SETTINGS_ID}` &&
        paths[3] === `cmsSettings/${NJ_DECIDES_SETTINGS_ID}` &&
        paths[4] === `cmsSettings/${COVERAGE_LABELS_SETTINGS_ID}` &&
        paths[5] === `cmsSettings/${STORY_CTAS_SETTINGS_ID}`
      ) {
        return [
          snapshot(PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID, setting),
          snapshot(SITE_NAVIGATION_SETTINGS_ID, navigation),
          snapshot(PUBLIC_SITE_CHROME_SETTINGS_ID, chrome),
          snapshot(NJ_DECIDES_SETTINGS_ID, njDecides),
          snapshot(COVERAGE_LABELS_SETTINGS_ID, coverageLabels),
          snapshot(STORY_CTAS_SETTINGS_ID, storyCtas),
        ];
      }
      if (refs.every(({ path }) => path.startsWith("media_assets_public/"))) {
        return refs.map(({ id }) => snapshot(id, assets[id]));
      }
      throw new Error(`Unexpected read batch: ${refs.map(({ path }) => path).join(",")}`);
    },
  }));
  const collectionReads = vi.fn();
  const database = {
    runTransaction,
    collection(collectionPath: string) {
      return {
        path: collectionPath,
        where(field: string, _op: string, value: string) {
          return { path: collectionPath, filters: [[field, value]], where(next: string, _op: string, value: string) {
            return { path: collectionPath, filters: [[field, this.filters[0][1]], [next, value]] };
          } };
        },
        async get() {
          collectionReads(collectionPath);
          throw new Error("Collection scans are forbidden");
        },
        doc(id: string) {
          return {
            id,
            path: `${collectionPath}/${id}`,
            async get() {
              if (!["system/publicDeployment/buildBatches", "system/publicReleasePreparations/entries"].includes(collectionPath)) {
                throw new Error(`Unexpected direct read ${collectionPath}/${id}`);
              }
              return snapshot(id, storedReservation);
            },
          };
        },
      };
    },
  };
  return { database, readBatches, queryReads, runTransaction, collectionReads };
}

describe("public artifact Firestore build read", () => {
  it("reads detached preparation content at its exact cutoff without a live build reservation", async () => {
    const preparationId = "Release0000000000001";
    const stored = { schemaVersion: 1, preparationId, commitSha: COMMIT_SHA, proposedGeneration: 8, cutoffAt: CUTOFF,
      predecessor: { generation: 7, deploymentId: "deployment-seven", commitSha: "b".repeat(40),
        buildBatchId: "batch-seven", contextRevision: 11 } };
    const { database, runTransaction } = databaseFixture({ storedReservation: stored });
    const collection = vi.spyOn(database, "collection");
    const read = await readPublicArtifactContentFromDatabase(database as never,
      { buildBatchId: `cms-${preparationId}`, commitSha: COMMIT_SHA, preparationId }, new Date(CUTOFF_MILLIS + 30_000));
    expect(read.reservation).toMatchObject({ buildBatchId: `cms-${preparationId}`, generation: 8, commitSha: COMMIT_SHA,
      reservedAgainstGeneration: 7, reservedAgainstCommitSha: "b".repeat(40) });
    expect(read.admissionTime).toEqual(new Date(CUTOFF_MILLIS));
    expect(runTransaction.mock.calls[0][1]).toEqual({ readOnly: true, readTime: CUTOFF });
    expect(collection.mock.calls.map(([name]) => name)).not.toContain("system/publicDeployment/buildBatches");
    expect(projectPublicArtifactContent(read).receipt).toMatchObject({ buildBatchId: `cms-${preparationId}`, generation: 8,
      commitSha: COMMIT_SHA, cutoffAt: { seconds: CUTOFF.seconds, nanoseconds: 0 } });
  });

  it.each([
    { preparationId: "invalid" },
    { commitSha: "c".repeat(40) },
    { proposedGeneration: 9 },
    { unexpected: true },
    { cutoffAt: { ...CUTOFF, toMillis: () => CUTOFF_MILLIS - 60_001 } },
  ])("rejects invalid or stale detached preparation before a content read (%j)", async patch => {
    const preparationId = "Release0000000000001";
    const { database, runTransaction } = databaseFixture({ storedReservation: {
      schemaVersion: 1, preparationId, commitSha: COMMIT_SHA, proposedGeneration: 8, cutoffAt: CUTOFF,
      predecessor: { generation: 7, deploymentId: "deployment-seven", commitSha: "b".repeat(40),
        buildBatchId: "batch-seven", contextRevision: 11 }, ...patch,
    } });
    await expect(readPublicArtifactContentFromDatabase(database as never,
      { buildBatchId: `cms-${preparationId}`, commitSha: COMMIT_SHA, preparationId }, new Date(CUTOFF_MILLIS + 30_000))).rejects.toThrow();
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it("refuses mixed preparation and background modes before database access", async () => {
    const { database } = databaseFixture();
    await expect(readPublicArtifactContentFromDatabase(database as never, { buildBatchId: "build-one", commitSha: COMMIT_SHA,
      preparationId: "Release0000000000001", batchMode: "background" }, new Date(CUTOFF_MILLIS))).rejects.toThrow("detached");
  });

  it("exports approved library fields, media and receipt versions after draft edits", async () => {
    const sponsor = approvedLibraryRecord({ type: "sponsor", status: "draft", version: 3,
      name: "Approved sponsor", href: "https://public.example.test/", logoAssetId: "public-logo",
      logoAlt: "Approved logo", activeUntil: "2026-08-15" });
    const newsletter = approvedLibraryRecord({ type: "newsletter", status: "review", version: 4,
      title: "Approved newsletter", signupUrl: "https://public.example.test/join", imageAssetId: "public-image" });
    const { database } = databaseFixture({ documents: {}, posts: [
      { id: "sponsor", data: { ...sponsor, name: "Draft sponsor", href: "https://draft.example.test/",
        logoAssetId: "draft-logo", logoAlt: "Draft logo", activeUntil: "2026-08-15", version: 8 } },
      { id: "newsletter", data: { ...newsletter, title: "Draft newsletter",
        signupUrl: "https://draft.example.test/join", imageAssetId: "draft-image", version: 9 } },
      { id: "never-approved", data: { type: "newsletter", status: "draft", title: "Private newsletter",
        signupUrl: "https://private.example.test/join", version: 1 } },
    ], assets: Object.fromEntries(["public-logo", "public-image"].map(id => [id, {
      url: `https://media.example.test/${id}.png`, mimeType: "image/png", width: 640, height: 360,
    }])) });
    const read = await readPublicArtifactContentFromDatabase(database as never,
      { buildBatchId: "build-one", commitSha: COMMIT_SHA }, new Date(CUTOFF_MILLIS + 30_000));
    expect(read.assets.map(asset => asset.id)).toEqual(["public-image", "public-logo"]);
    const artifact = projectPublicArtifactContent(read);
    expect(artifact.recordCards).toMatchObject([
      { kind: "sponsor", title: "Approved sponsor", href: "https://public.example.test/", sourceVersion: 3 },
      { kind: "newsletter", title: "Approved newsletter", sourceVersion: 4 },
    ]);
    expect(artifact.receipt.owners).toEqual([
      { collection: "cmsPosts", documentId: "newsletter", sourceVersion: 4, assetIds: ["public-image"], occurrenceCount: 1 },
      { collection: "cmsPosts", documentId: "sponsor", sourceVersion: 3, assetIds: ["public-logo"], occurrenceCount: 1 },
    ]);
    expect(JSON.stringify(artifact)).not.toMatch(/Draft|Private|draft\.example|draft-logo|draft-image/);
    expect(assertPublicArtifactBundle({ schemaVersion: 3, ...artifact }).recordCards).toEqual(artifact.recordCards);
  });

  it("reads approval history at the reserved cutoff and ignores a forged working projection", async () => {
    const { database, queryReads, runTransaction, collectionReads } = databaseFixture({ documents: {},
      posts: [{ id: "sponsor", data: { type: "sponsor", name: "Draft sponsor", status: "draft", version: 9,
        approvedLibraryVersion: { type: "sponsor", status: "approved", name: "Forged approval", version: 9 } } }],
      history: [
        { id: "first", data: { collection: "cmsPosts", documentId: "sponsor", action: "approve",
          after: { type: "sponsor", status: "approved", name: "Old approval", version: 3 } } },
        { id: "latest", data: { collection: "cmsPosts", documentId: "sponsor", action: "approve",
          after: { type: "sponsor", status: "approved", name: "Latest approval", href: "https://approved.example.test/", version: 6 } } },
        { id: "edit", data: { collection: "cmsPosts", documentId: "sponsor", action: "edit",
          after: { type: "sponsor", status: "draft", name: "Draft sponsor", version: 7 } } },
      ],
    });
    const read = await readPublicArtifactContentFromDatabase(database as never,
      { buildBatchId: "build-one", commitSha: COMMIT_SHA }, new Date(CUTOFF_MILLIS + 30_000));
    expect(queryReads).toContain("cmsVersionHistory");
    expect(runTransaction.mock.calls[0][1]).toEqual({ readOnly: true, readTime: CUTOFF });
    expect(collectionReads).not.toHaveBeenCalled();
    expect(projectPublicArtifactContent(read).recordCards).toMatchObject([
      { id: "sponsor", title: "Latest approval", href: "https://approved.example.test/", sourceVersion: 6 },
    ]);
  });

  it("omits approved-status records with no retained approval, and withdrawals after approval", async () => {
    const { database } = databaseFixture({ documents: {}, posts: [
      { id: "no-history", data: { type: "sponsor", name: "Unproven", status: "approved", version: 3 } },
      { id: "withdrawn", data: { type: "newsletter", title: "Withdrawn", signupUrl: "https://example.test/", status: "draft", version: 7 } },
    ], history: [
      { id: "approval", data: { collection: "cmsPosts", documentId: "withdrawn", action: "approve",
        after: { type: "newsletter", status: "approved", title: "Approved newsletter", signupUrl: "https://example.test/", version: 3 } } },
      { id: "withdrawal", data: { collection: "cmsPosts", documentId: "withdrawn", action: "unpublish", after: { version: 4 } } },
    ] });
    const read = await readPublicArtifactContentFromDatabase(database as never,
      { buildBatchId: "build-one", commitSha: COMMIT_SHA }, new Date(CUTOFF_MILLIS + 30_000));
    const artifact = projectPublicArtifactContent(read);
    expect(artifact.recordCards).toEqual([]);
    expect(artifact.receipt.owners).toEqual([]);
  });

  it("exports active approved sponsor data from the fixed read and resolves its logo", async () => {
    const sponsor = { type: "sponsor", name: "Foundation", href: "https://example.org/", logoAssetId: "asset-logo", logoAlt: "Foundation logo", status: "draft", activeFrom: "2026-08-14", activeUntil: "2026-08-14" };
    const { database } = databaseFixture({
      posts: [
        { id: "active", data: approvedLibraryRecord(sponsor) },
        { id: "archived", data: approvedLibraryRecord({ ...sponsor, status: "archived" }) },
        { id: "future", data: approvedLibraryRecord({ ...sponsor, activeFrom: "2026-08-15" }) },
      ],
      assets: { "asset-logo": { url: "https://media.njpbs.org/cms-media/logo.png", mimeType: "image/png" } },
    });
    const read = await readPublicArtifactContentFromDatabase(database as never,
      { buildBatchId: "build-one", commitSha: COMMIT_SHA }, new Date(CUTOFF_MILLIS + 30_000));
    const artifact = projectPublicArtifactContent(read);
    expect(artifact.recordCards.filter(card => card.kind === "sponsor").map(card => card.sponsor)).toEqual([{
      sponsorId: "active", name: "Foundation", href: "https://example.org/",
      logoUrl: "https://media.njpbs.org/cms-media/logo.png", logoAlt: "Foundation logo", logoDecorative: false,
    }]);
    expect(artifact.receipt.owners).toContainEqual(expect.objectContaining({
      collection: "cmsPosts", documentId: "active", assetIds: ["asset-logo"], occurrenceCount: 1,
    }));
    expect(assertPublicArtifactInventoryReceipt(artifact.receipt).ownerCount).toBeGreaterThan(0);
    expect(assertPublicArtifactBundle({ schemaVersion: 3, ...artifact }).recordCards).toEqual(artifact.recordCards);
  });
  it("exports approved active newsletters without adding public routes", async () => {
    const { database } = databaseFixture({ documents: {}, posts: [
      { id: "weekly", data: approvedLibraryRecord({ type: "newsletter", title: "Weekly", status: "draft", signupUrl: "https://example.org/join", summary: "Station updates", frequency: "Weekly", imageAssetId: "newsletter-art", imageAlt: "Newsletter illustration", imageDecorative: false }) },
      { id: "archived", data: approvedLibraryRecord({ type: "newsletter", title: "Old", status: "archived", signupUrl: "https://example.org/old" }) },
      { id: "no-link", data: approvedLibraryRecord({ type: "newsletter", title: "Pending", status: "draft" }) },
    ], assets: { "newsletter-art": { url: "https://media.njpbs.org/cms-media/newsletter.png", mimeType: "image/png", width: 640, height: 360 } } });
    const read = await readPublicArtifactContentFromDatabase(database as never,
      { buildBatchId: "build-one", commitSha: COMMIT_SHA }, new Date(CUTOFF_MILLIS + 30_000));
    expect(read.assets.map(asset => asset.id)).toContain("newsletter-art");
    const artifact = projectPublicArtifactContent(read);
    expect(artifact.recordCards.filter(card => card.kind === "newsletter")).toMatchObject([{ kind: "newsletter", id: "weekly", newsletter: { card: {
      title: "Weekly", signupUrl: "https://example.org/join", summary: "Station updates", frequency: "Weekly", imageAssetId: "newsletter-art", imageAlt: "Newsletter illustration", imageDecorative: false,
    }, image: { url: "https://media.njpbs.org/cms-media/newsletter.png", width: 640, height: 360 } } }]);
    expect(artifact.posts).toEqual([]);
    expect(artifact.programs).toEqual([]);
    expect(artifact.receipt.owners).toContainEqual(expect.objectContaining({
      collection: "cmsPosts", documentId: "weekly", assetIds: ["newsletter-art"], occurrenceCount: 1,
    }));
    expect(assertPublicArtifactBundle({ schemaVersion: 3, ...artifact }).recordCards).toEqual(artifact.recordCards);
  });

  it("requires one complete published-build opt-in", () => {
    expect(resolvePublicArtifactBuildRequest({ mode: "published" }, {})).toBeNull();
    expect(resolvePublicArtifactBuildRequest(
      { mode: "published" },
      {
        PUBLIC_BUILD_BATCH_ID: "build-one",
        PUBLIC_BUILD_COMMIT_SHA: COMMIT_SHA,
        PUBLIC_ARTIFACT_INVENTORY_PATH: "/tmp/receipt.json",
        PUBLIC_ARTIFACT_BUNDLE_PATH: "/tmp/bundle.json",
      },
    )).toEqual({
      buildBatchId: "build-one",
      commitSha: COMMIT_SHA,
      outputPath: "/tmp/receipt.json",
      bundlePath: "/tmp/bundle.json",
      batchMode: "reserved",
    });
    expect(resolvePublicArtifactBuildRequest(
      { mode: "published" },
      {
        PUBLIC_BUILD_BATCH_ID: "build-one",
        PUBLIC_BUILD_COMMIT_SHA: COMMIT_SHA,
        PUBLIC_ARTIFACT_INVENTORY_PATH: "/tmp/receipt.json",
        PUBLIC_ARTIFACT_BUNDLE_PATH: "/tmp/bundle.json",
        PUBLIC_ARTIFACT_BATCH_MODE: "deployed",
      },
    )).toMatchObject({ batchMode: "deployed" });
    expect(() => resolvePublicArtifactBuildRequest(
      { mode: "published" },
      { PUBLIC_ARTIFACT_BATCH_MODE: "deployed" },
    )).toThrow(/requires an exact public artifact build/i);
    expect(() => resolvePublicArtifactBuildRequest(
      { mode: "published" },
      {
        PUBLIC_BUILD_BATCH_ID: "build-one",
        PUBLIC_BUILD_COMMIT_SHA: COMMIT_SHA,
        PUBLIC_ARTIFACT_INVENTORY_PATH: "/tmp/receipt.json",
        PUBLIC_ARTIFACT_BUNDLE_PATH: "/tmp/bundle.json",
        PUBLIC_ARTIFACT_BATCH_MODE: "terminal",
      },
    )).toThrow(/must be reserved, deployed or background/i);
    expect(() => resolvePublicArtifactBuildRequest(
      { mode: "published" },
      { PUBLIC_BUILD_BATCH_ID: "build-one" },
    )).toThrow(/configured together/i);
    expect(() => resolvePublicArtifactBuildRequest(
      { mode: "draft", pageId: "home" },
      {
        PUBLIC_BUILD_BATCH_ID: "build-one",
        PUBLIC_BUILD_COMMIT_SHA: COMMIT_SHA,
        PUBLIC_ARTIFACT_INVENTORY_PATH: "/tmp/receipt.json",
        PUBLIC_ARTIFACT_BUNDLE_PATH: "/tmp/bundle.json",
      },
    )).toThrow(/requires published/i);
  });

  it("includes custom pages in the frozen inventory and keeps draft URL changes private", async () => {
    const id = `page-${"a".repeat(32)}`;
    const source = page("contact", { id, title: "Draft title", slug: "draft-route",
      published: { blocks: [], metadata: { title: "Community", slug: "community", previousSlugs: ["old-community"] },
        sourceVersion: 5, publishedAt: "2026-08-14T19:00:00.000Z", publishedBy: "editor-one" } });
    const { database } = databaseFixture({ documents: { [id]: source } });
    const read = await readPublicArtifactContentFromDatabase(database as never,
      { buildBatchId: "build-one", commitSha: COMMIT_SHA }, new Date(CUTOFF_MILLIS + 30_000));
    const projected = projectPublicArtifactContent(read);
    expect(projected.pages).toHaveLength(1);
    expect(projected.pages[0]).toMatchObject({ pageId: id, title: "Community", path: "/community/" });
    const artifact = projected.receipt.families.find(family => family.collection === "cmsPages")?.artifacts[0];
    expect(artifact).toMatchObject({ canonicalPath: "/community/", aliases: ["/old-community/"] });
  });

  it("reads all page identities and the allowlisted settings at the reservation cutoff", async () => {
    const { database, readBatches, queryReads, runTransaction, collectionReads } =
      databaseFixture({
        documents: Object.fromEntries(PUBLIC_PAGES.map(({ id }) => [
          id,
          page(id, { id: "hostile-stored-id" }),
        ])),
      });

    const result = await readPublicArtifactContentFromDatabase(
      database as never,
      { buildBatchId: "build-one", commitSha: COMMIT_SHA },
      new Date(CUTOFF_MILLIS + 30_000),
    );

    expect(runTransaction).toHaveBeenCalledOnce();
    expect(runTransaction.mock.calls[0][1]).toEqual({
      readOnly: true,
      readTime: CUTOFF,
    });
    expect(readBatches).toEqual([
      [
        `cmsSettings/${PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID}`,
        `cmsSettings/${SITE_NAVIGATION_SETTINGS_ID}`,
        `cmsSettings/${PUBLIC_SITE_CHROME_SETTINGS_ID}`,
        `cmsSettings/${NJ_DECIDES_SETTINGS_ID}`,
        `cmsSettings/${COVERAGE_LABELS_SETTINGS_ID}`,
        `cmsSettings/${STORY_CTAS_SETTINGS_ID}`,
      ],
    ]);
    expect(queryReads).toEqual(["cmsPages", "cmsPosts", "cmsAuthorProfilesPublic"]);
    expect(collectionReads).not.toHaveBeenCalled();
    expect(result.pages.map(({ id }) => id)).toEqual(
      PUBLIC_PAGES.map(({ id }) => id),
    );
    expect(result.setting).toBeUndefined();
    expect(result.navigation).toBeUndefined();
    expect(result.chrome).toBeUndefined();
    expect(result.admissionTime.toISOString()).toBe(
      new Date(CUTOFF_MILLIS).toISOString(),
    );
  });

  it("projects only the fixed setting's published snapshot and exact source version", async () => {
    const { database } = databaseFixture({
      setting: {
        id: "hostile-stored-id",
        schemaVersion: 1,
        version: 5,
        values: {
          enabled: true,
          message: "Unpublished working message",
        },
        published: {
          schemaVersion: 1,
          values: {
            enabled: true,
            message: "Published public update",
          },
          sourceVersion: 4,
          publishedAt: "2026-08-14T19:00:00.000Z",
        },
      },
    });
    const read = await readPublicArtifactContentFromDatabase(
      database as never,
      { buildBatchId: "build-one", commitSha: COMMIT_SHA },
      new Date(CUTOFF_MILLIS + 30_000),
    );
    const artifact = projectPublicArtifactContent(read);

    expect(read.setting?.id).toBe(PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID);
    expect(artifact.settings).toEqual([expect.objectContaining({
      settingId: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
      message: "Published public update",
      sourceVersion: 4,
    })]);
    expect(artifact.receipt.families.find(({ collection }) =>
      collection === "cmsSettings")?.artifacts).toEqual([{
        documentId: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
        sourceVersion: 4,
        canonicalPath: "/",
        aliases: [],
      }]);
    expect(artifact.receipt.owners.find(({ collection }) =>
      collection === "cmsSettings")).toEqual({
        collection: "cmsSettings",
        documentId: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
        sourceVersion: 4,
        assetIds: [],
        occurrenceCount: 0,
      });
  });

  it("keeps the current bundle and receipt shape when navigation is missing or unpublished", async () => {
    for (const navigation of [
      undefined,
      { schemaVersion: 1, version: 2, values: DEFAULT_SITE_NAVIGATION },
    ]) {
      const { database } = databaseFixture({ navigation });
      const read = await readPublicArtifactContentFromDatabase(
        database as never,
        { buildBatchId: "build-one", commitSha: COMMIT_SHA },
        new Date(CUTOFF_MILLIS + 30_000),
      );
      const artifact = projectPublicArtifactContent(read);
      expect(artifact.settings).toEqual([]);
      expect(artifact.receipt.families.find(({ collection }) =>
        collection === "cmsSettings")?.artifacts).toEqual([]);
      expect(artifact.receipt).not.toHaveProperty("settingsFallbacks");
    }
  });

  it("projects the published navigation snapshot beside the banner and records both versions", async () => {
    const header = [
      ...DEFAULT_SITE_NAVIGATION.header,
      {
        id: "events",
        label: "Events",
        target: { type: "href", href: "https://events.example.org/" },
        external: true,
      },
    ];
    const { database } = databaseFixture({
      setting: {
        schemaVersion: 1,
        version: 4,
        values: { enabled: true, message: "Published public update" },
        published: {
          schemaVersion: 1,
          values: { enabled: true, message: "Published public update" },
          sourceVersion: 4,
          publishedAt: "2026-08-14T19:00:00.000Z",
        },
      },
      navigation: {
        id: "hostile-stored-id",
        schemaVersion: 1,
        version: 7,
        values: { header: [], footer: [] },
        published: {
          schemaVersion: 1,
          values: { header, footer: DEFAULT_SITE_NAVIGATION.footer },
          sourceVersion: 6,
          publishedAt: "2026-08-14T19:00:00.000Z",
        },
      },
    });
    const read = await readPublicArtifactContentFromDatabase(
      database as never,
      { buildBatchId: "build-one", commitSha: COMMIT_SHA },
      new Date(CUTOFF_MILLIS + 30_000),
    );
    const artifact = projectPublicArtifactContent(read);

    expect(read.navigation?.id).toBe(SITE_NAVIGATION_SETTINGS_ID);
    expect(artifact.settings.map(({ settingId }) => settingId)).toEqual([
      PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
      SITE_NAVIGATION_SETTINGS_ID,
    ]);
    expect(artifact.settings[1]).toEqual({
      settingId: SITE_NAVIGATION_SETTINGS_ID,
      header,
      footer: DEFAULT_SITE_NAVIGATION.footer,
      sourceVersion: 6,
      publishedAt: "2026-08-14T19:00:00.000Z",
    });
    expect(artifact.receipt.families.find(({ collection }) =>
      collection === "cmsSettings")?.artifacts.map(({ documentId, sourceVersion }) =>
      [documentId, sourceVersion])).toEqual([
      [PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID, 4],
      [SITE_NAVIGATION_SETTINGS_ID, 6],
    ]);
    expect(artifact.receipt.owners.filter(({ collection }) =>
      collection === "cmsSettings").map(({ documentId }) => documentId)).toEqual([
      PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
      SITE_NAVIGATION_SETTINGS_ID,
    ]);
    expect(artifact.receipt).not.toHaveProperty("settingsFallbacks");
  });

  it("renders the seed for an invalid published navigation and records the fallback version", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { database } = databaseFixture({
        navigation: {
          schemaVersion: 1,
          version: 9,
          values: DEFAULT_SITE_NAVIGATION,
          published: {
            schemaVersion: 1,
            values: {
              header: [{
                id: "bad",
                label: "Bad",
                target: { type: "href", href: "javascript:alert(1)" },
                external: false,
              }],
              footer: DEFAULT_SITE_NAVIGATION.footer,
            },
            sourceVersion: 8,
            publishedAt: "2026-08-14T19:00:00.000Z",
          },
        },
      });
      const read = await readPublicArtifactContentFromDatabase(
        database as never,
        { buildBatchId: "build-one", commitSha: COMMIT_SHA },
        new Date(CUTOFF_MILLIS + 30_000),
      );
      const artifact = projectPublicArtifactContent(read);

      expect(artifact.settings).toEqual([]);
      expect(artifact.receipt.families.find(({ collection }) =>
        collection === "cmsSettings")?.artifacts).toEqual([{
          documentId: SITE_NAVIGATION_SETTINGS_ID,
          sourceVersion: 8,
          canonicalPath: "/",
          aliases: [],
        }]);
      expect(artifact.receipt.settingsFallbacks).toEqual([
        { documentId: SITE_NAVIGATION_SETTINGS_ID, sourceVersion: 8 },
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("rendering the default navigation"));
    } finally {
      warn.mockRestore();
    }
  });

  it("projects published header chrome and records its version", async () => {
    const published = {
      newsletterEnabled: true,
      newsletterLabel: "Newsletter",
      newsletterHref: "https://example.org/newsletter",
      newsletterOpensInNewTab: true,
    };
    const { database } = databaseFixture({
      chrome: {
        id: "hostile-stored-id",
        schemaVersion: 1,
        version: 3,
        values: { ...published, newsletterLabel: "Working draft" },
        published: {
          schemaVersion: 1,
          values: published,
          sourceVersion: 2,
          publishedAt: "2026-08-14T19:00:00.000Z",
        },
      },
    });
    const read = await readPublicArtifactContentFromDatabase(
      database as never,
      { buildBatchId: "build-one", commitSha: COMMIT_SHA },
      new Date(CUTOFF_MILLIS + 30_000),
    );
    const artifact = projectPublicArtifactContent(read);

    expect(read.chrome?.id).toBe(PUBLIC_SITE_CHROME_SETTINGS_ID);
    expect(artifact.settings).toEqual([{
      settingId: PUBLIC_SITE_CHROME_SETTINGS_ID,
      ...published,
      sourceVersion: 2,
      publishedAt: "2026-08-14T19:00:00.000Z",
    }]);
    expect(artifact.receipt.families.find(({ collection }) =>
      collection === "cmsSettings")?.artifacts.map(({ documentId, sourceVersion }) =>
      [documentId, sourceVersion])).toEqual([[PUBLIC_SITE_CHROME_SETTINGS_ID, 2]]);
    expect(artifact.receipt).not.toHaveProperty("settingsFallbacks");
    expect(assertPublicArtifactBundle({
      schemaVersion: 3,
      ...artifact,
    }).settings).toEqual(artifact.settings);
  });

  it("includes frozen election appearance and its Media references in the exact receipt", async () => {
    const published = { ...DEFAULT_NJ_DECIDES_SETTINGS, logoAssetId: "election-logo", logoAlt: "Election coverage" };
    const { database } = databaseFixture({
      njDecides: { schemaVersion: 1, version: 3, values: { ...published, backgroundColor: "#ffffff" },
        published: { schemaVersion: 1, values: published, sourceVersion: 2, publishedAt: "2026-08-14T19:00:00.000Z" } },
      assets: { "election-logo": { url: "https://media.njpbs.org/cms-media/election-logo.webp", mimeType: "image/webp", width: 800, height: 300 } },
    });
    const read = await readPublicArtifactContentFromDatabase(database as never,
      { buildBatchId: "build-one", commitSha: COMMIT_SHA }, new Date(CUTOFF_MILLIS + 30_000));
    const artifact = projectPublicArtifactContent(read);
    expect(artifact.settings[0]).toMatchObject({ settingId: NJ_DECIDES_SETTINGS_ID, backgroundColor: "#e9eaee", sourceVersion: 2,
      assets: { "election-logo": { mimeType: "image/webp", width: 800, height: 300 } } });
    expect(artifact.receipt.owners).toContainEqual({ collection: "cmsSettings", documentId: NJ_DECIDES_SETTINGS_ID,
      sourceVersion: 2, assetIds: ["election-logo"], occurrenceCount: 1 });
    expect(assertPublicArtifactBundle({ schemaVersion: 3, ...artifact }).settings).toEqual(artifact.settings);
  });

  it("falls back for missing branding-only Media without weakening content Media admission", async () => {
    const published = { ...DEFAULT_NJ_DECIDES_SETTINGS, logoAssetId: "missing-logo", logoAlt: "Election coverage" };
    const brand = { schemaVersion: 1, version: 3, values: published,
      published: { schemaVersion: 1, values: published, sourceVersion: 2, publishedAt: "2026-08-14T19:00:00.000Z" } };
    const { database } = databaseFixture({ njDecides: brand });
    const read = await readPublicArtifactContentFromDatabase(database as never,
      { buildBatchId: "build-one", commitSha: COMMIT_SHA }, new Date(CUTOFF_MILLIS + 30_000));
    const artifact = projectPublicArtifactContent(read);
    expect(artifact.settings[0]).toMatchObject({ settingId: NJ_DECIDES_SETTINGS_ID, assets: {} });
    expect(assertPublicArtifactBundle({ schemaVersion: 3, ...artifact }).settings).toEqual(artifact.settings);
    const required = databaseFixture({ njDecides: brand, documents: { contact: page("contact", {
      published: { blocks: [{ id: "image", type: "image", visible: true, order: 0, data: { assetId: "missing-logo", alt: "Required reporting image" } }],
        metadata: { title: "Contact" }, sourceVersion: 1, publishedAt: "2026-08-14T19:00:00.000Z" },
    }) } });
    await expect(readPublicArtifactContentFromDatabase(required.database as never,
      { buildBatchId: "build-one", commitSha: COMMIT_SHA }, new Date(CUTOFF_MILLIS + 30_000))).rejects.toThrow(/exact public media read is incomplete/i);
  });

  it("keeps the build and records sorted fallbacks when chrome and navigation are invalid", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { database } = databaseFixture({
        navigation: {
          schemaVersion: 1,
          version: 9,
          values: DEFAULT_SITE_NAVIGATION,
          published: {
            schemaVersion: 1,
            values: { header: [], footer: DEFAULT_SITE_NAVIGATION.footer },
            sourceVersion: 8,
            publishedAt: "2026-08-14T19:00:00.000Z",
          },
        },
        chrome: {
          schemaVersion: 1,
          version: 5,
          values: DEFAULT_PUBLIC_SITE_CHROME_SETTINGS,
          published: {
            schemaVersion: 1,
            // A relative link fails the schema because it would resolve
            // differently on each page.
            values: { ...DEFAULT_PUBLIC_SITE_CHROME_SETTINGS, newsletterHref: "newsletter" },
            sourceVersion: 4,
            publishedAt: "2026-08-14T19:00:00.000Z",
          },
        },
      });
      const read = await readPublicArtifactContentFromDatabase(
        database as never,
        { buildBatchId: "build-one", commitSha: COMMIT_SHA },
        new Date(CUTOFF_MILLIS + 30_000),
      );
      const artifact = projectPublicArtifactContent(read);

      expect(artifact.settings).toEqual([]);
      expect(artifact.receipt.settingsFallbacks).toEqual([
        { documentId: PUBLIC_SITE_CHROME_SETTINGS_ID, sourceVersion: 4 },
        { documentId: SITE_NAVIGATION_SETTINGS_ID, sourceVersion: 8 },
      ]);
      expect(assertPublicArtifactInventoryReceipt(artifact.receipt).settingsFallbacks)
        .toEqual(artifact.receipt.settingsFallbacks);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("rendering the default header action"));
    } finally {
      warn.mockRestore();
    }
  });

  it("uses cutoffAt instead of the later wall clock for page admission", async () => {
    const documents = Object.fromEntries(
      PUBLIC_PAGES.map(({ id }) => [id, page(id)]),
    );
    documents.contact = page("contact", {
      publishAt: new Date(CUTOFF_MILLIS + 1).toISOString(),
    });
    const { database } = databaseFixture({ documents });
    const read = await readPublicArtifactContentFromDatabase(
      database as never,
      { buildBatchId: "build-one", commitSha: COMMIT_SHA },
      new Date(CUTOFF_MILLIS + 30_000),
    );

    const artifact = projectPublicArtifactContent(read);
    expect(artifact.pages.some(({ pageId }) => pageId === "contact")).toBe(false);
    expect(
      artifact.receipt.families[0].artifacts.some(
        ({ documentId }) => documentId === "contact",
      ),
    ).toBe(false);
  });

  it("returns one projected owner for every canonical page, including zero-media pages", async () => {
    const { database } = databaseFixture();
    const read = await readPublicArtifactContentFromDatabase(
      database as never,
      { buildBatchId: "build-one", commitSha: COMMIT_SHA },
      new Date(CUTOFF_MILLIS + 30_000),
    );

    const result = projectPublicArtifactContent(read);

    expect(result.pages).toHaveLength(PUBLIC_PAGES.length);
    expect(result.receipt.owners).toHaveLength(PUBLIC_PAGES.length);
    expect(result.receipt.owners.every(({ sourceVersion }) => sourceVersion > 0))
      .toBe(true);
    expect(result.receipt.owners.every(({ assetIds, occurrenceCount }) =>
      assetIds.length === 0 && occurrenceCount === 0)).toBe(true);
  });

  it("projects complete Post, Program, and author families from the same cutoff", async () => {
    const publishedAt = "2026-08-14T19:00:00.000Z";
    const authorId = `au_${"1".repeat(32)}`;
    const post = {
      status: "published",
      publishAt: publishedAt,
      published: {
        blocks: [],
        metadata: {
          type: "post",
          title: "Cutoff Post",
          slug: "cutoff-post",
          previousSlugs: ["old-cutoff-post"],
          locale: "en",
          tags: [],
          editorialDateSource: "firstPublish",
          firstPublishedAt: publishedAt,
          credits: [],
        },
        publishedAt,
        publishedBy: "editor-one",
        sourceVersion: 4,
      },
    };
    const program = {
      status: "published",
      publishAt: publishedAt,
      published: {
        blocks: [],
        metadata: {
          type: "program",
          title: "Cutoff Show",
          slug: "cutoff-show",
          previousSlugs: ["old-cutoff-show"],
          locale: "en",
          description: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "A show." }] }],
          },
        },
        publishedAt,
        publishedBy: "editor-one",
        sourceVersion: 5,
      },
    };
    const author = {
      authorId,
      slug: "cutoff-author",
      previousSlugs: ["old-cutoff-author"],
      displayName: "Cutoff Author",
      jobTitle: null,
      bio: null,
      photo: null,
      links: {},
      pinnedPostId: null,
      hiddenPostIds: [],
      publishedAt,
      snapshotVersion: 6,
    };
    const { database } = databaseFixture({
      posts: [
        { id: "post-one", data: post },
        { id: "program-one", data: program },
        {
          id: "draft-one",
          data: {
            ...post,
            status: "draft",
            published: {
              ...post.published,
              metadata: { ...post.published.metadata, slug: "draft-one" },
            },
          },
        },
        {
          id: "withdrawn-one",
          data: {
            ...post,
            publiclyVisible: false,
            published: {
              ...post.published,
              metadata: { ...post.published.metadata, slug: "withdrawn-one" },
            },
          },
        },
        {
          id: "deleted-one",
          data: {
            ...post,
            deleted: true,
            published: {
              ...post.published,
              metadata: { ...post.published.metadata, slug: "deleted-one" },
            },
          },
        },
        {
          id: "future-one",
          data: {
            ...post,
            status: "scheduled",
            publishAt: "2027-08-14T19:00:00.000Z",
            published: {
              ...post.published,
              metadata: { ...post.published.metadata, slug: "future-one" },
            },
          },
        },
      ],
      authors: [{ id: authorId, data: author }],
    });

    const read = await readPublicArtifactContentFromDatabase(
      database as never,
      { buildBatchId: "build-one", commitSha: COMMIT_SHA },
      new Date(CUTOFF_MILLIS + 30_000),
    );
    const result = projectPublicArtifactContent(read);

    expect(result.posts.map(({ postId }) => postId)).toEqual(["post-one"]);
    expect(result.programs.map(({ programId }) => programId)).toEqual(["program-one"]);
    expect(result.authors).toMatchObject([{ authorId, sourceVersion: 6 }]);
    expect(result.receipt.aggregateRoutes).toEqual(["/posts/", "/programs/", "/events/", "/staff/"]);
    expect(result.receipt.families.find(({ collection }) => collection === "cmsPosts")?.artifacts)
      .toMatchObject([
        { documentId: "post-one", canonicalPath: "/posts/cutoff-post/", sourceVersion: 4 },
        { documentId: "program-one", canonicalPath: "/programs/cutoff-show/", sourceVersion: 5 },
      ]);
    expect(result.receipt.owners.filter(({ collection }) => collection === "cmsPosts"))
      .toHaveLength(2);
  });

  it("records a missing canonical document as a committed-route fallback", async () => {
    const documents = Object.fromEntries(
      PUBLIC_PAGES.filter(({ id }) => id !== "watch")
        .map(({ id }) => [id, page(id)]),
    );
    const { database } = databaseFixture({ documents });

    const read = await readPublicArtifactContentFromDatabase(
      database as never,
      { buildBatchId: "build-one", commitSha: COMMIT_SHA },
      new Date(CUTOFF_MILLIS + 30_000),
    );
    const artifact = projectPublicArtifactContent(read);

    expect(artifact.pages).toHaveLength(PUBLIC_PAGES.length - 1);
    expect(artifact.receipt.owners).toHaveLength(PUBLIC_PAGES.length - 1);
    expect(
      artifact.receipt.families[0].artifacts.some(
        ({ documentId }) => documentId === "watch",
      ),
    ).toBe(false);
  });

  it("uses the committed Staff route when its Page snapshot is absent", async () => {
    const documents = Object.fromEntries(
      PUBLIC_PAGES.filter(({ id }) => id !== "staff")
        .map(({ id }) => [id, page(id)]),
    );
    const { database } = databaseFixture({ documents });
    const read = await readPublicArtifactContentFromDatabase(
      database as never,
      { buildBatchId: "build-one", commitSha: COMMIT_SHA },
      new Date(CUTOFF_MILLIS + 30_000),
    );

    const artifact = projectPublicArtifactContent(read);

    expect(artifact.pages).toHaveLength(PUBLIC_PAGES.length - 1);
    expect(artifact.receipt.aggregateRoutes).toContain("/staff/");
    expect(
      artifact.receipt.families[0].artifacts.some(
        ({ documentId }) => documentId === "staff",
      ),
    ).toBe(false);
  });

  it("rejects a malformed published Staff Page snapshot", async () => {
    const staff = page("staff");
    const documents = Object.fromEntries(
      PUBLIC_PAGES.map(({ id }) => [id, id === "staff"
        ? page(id, {
            published: {
              ...staff.published!,
              metadata: { title: "" },
            },
          })
        : page(id)]),
    );
    const { database } = databaseFixture({ documents });
    const read = await readPublicArtifactContentFromDatabase(
      database as never,
      { buildBatchId: "build-one", commitSha: COMMIT_SHA },
      new Date(CUTOFF_MILLIS + 30_000),
    );

    expect(() => projectPublicArtifactContent(read)).toThrow(/title/i);
  });

  it("rejects a stale, mismatched, or non-reserved stored batch", async () => {
    const stale = databaseFixture();
    await expect(readPublicArtifactContentFromDatabase(
      stale.database as never,
      { buildBatchId: "build-one", commitSha: COMMIT_SHA },
      new Date(CUTOFF_MILLIS + 60_001),
    )).rejects.toThrow(/cutoff is stale/i);
    expect(stale.runTransaction).not.toHaveBeenCalled();

    const mismatch = databaseFixture();
    await expect(readPublicArtifactContentFromDatabase(
      mismatch.database as never,
      { buildBatchId: "build-one", commitSha: "c".repeat(40) },
      new Date(CUTOFF_MILLIS + 30_000),
    )).rejects.toThrow(/different commit/i);
    expect(mismatch.runTransaction).not.toHaveBeenCalled();

    const ready = databaseFixture({
      storedReservation: reservation({
        status: "ready",
        readyAt: CUTOFF,
      }),
    });
    await expect(readPublicArtifactContentFromDatabase(
      ready.database as never,
      { buildBatchId: "build-one", commitSha: COMMIT_SHA },
      new Date(CUTOFF_MILLIS + 30_000),
    )).rejects.toThrow(/build batch is invalid/i);
    expect(ready.runTransaction).not.toHaveBeenCalled();
  });

  it("reuses a fully validated deployed batch after the reservation freshness window", async () => {
    const { database, runTransaction } = databaseFixture({
      storedReservation: deployedBatch(),
    });
    const read = await readPublicArtifactContentFromDatabase(
      database as never,
      {
        buildBatchId: "build-one",
        commitSha: COMMIT_SHA,
        batchMode: "deployed",
      },
      new Date(CUTOFF_MILLIS + 86_400_000),
    );

    expect(read.reservation).toMatchObject({
      buildBatchId: "build-one",
      generation: 8,
      commitSha: COMMIT_SHA,
    });
    expect(runTransaction).toHaveBeenCalledOnce();
  });

  it("rejects an unvalidated terminal batch in deployed mode", async () => {
    const { database, runTransaction } = databaseFixture({
      storedReservation: deployedBatch({ deploymentId: "invalid" }),
    });
    await expect(readPublicArtifactContentFromDatabase(
      database as never,
      {
        buildBatchId: "build-one",
        commitSha: COMMIT_SHA,
        batchMode: "deployed",
      },
      new Date(CUTOFF_MILLIS + 86_400_000),
    )).rejects.toThrow(/deployed public build batch is invalid/i);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it("rejects a failed, mismatched, or future deployed batch", async () => {
    const failedBatch: Record<string, unknown> = deployedBatch({
      status: "failed",
      failedAt: CUTOFF,
      terminalOutcome: "fail",
    });
    delete failedBatch.deployedAt;
    delete failedBatch.deploymentId;
    delete failedBatch.deploymentVersionId;
    const failed = databaseFixture({ storedReservation: failedBatch });
    await expect(readPublicArtifactContentFromDatabase(
      failed.database as never,
      {
        buildBatchId: "build-one",
        commitSha: COMMIT_SHA,
        batchMode: "deployed",
      },
      new Date(CUTOFF_MILLIS + 86_400_000),
    )).rejects.toThrow(/deployed public build batch is invalid/i);
    expect(failed.runTransaction).not.toHaveBeenCalled();

    const mismatch = databaseFixture({ storedReservation: deployedBatch() });
    await expect(readPublicArtifactContentFromDatabase(
      mismatch.database as never,
      {
        buildBatchId: "build-one",
        commitSha: "c".repeat(40),
        batchMode: "deployed",
      },
      new Date(CUTOFF_MILLIS + 86_400_000),
    )).rejects.toThrow(/different commit/i);
    expect(mismatch.runTransaction).not.toHaveBeenCalled();

    const future = databaseFixture({ storedReservation: deployedBatch() });
    await expect(readPublicArtifactContentFromDatabase(
      future.database as never,
      {
        buildBatchId: "build-one",
        commitSha: COMMIT_SHA,
        batchMode: "deployed",
      },
      new Date(CUTOFF_MILLIS - 1),
    )).rejects.toThrow(/cutoff is in the future/i);
    expect(future.runTransaction).not.toHaveBeenCalled();
  });
});


it.each([true, false])("reads only the published coverage registry at the artifact cutoff (valid %s)", async valid => {
  const label = { id: "nj-decides-2026", name: "NJ Decides 2026", textColor: "#011375", backgroundColor: "#e9eaee", retired: true };
  const coverageLabels = { schemaVersion: 1, version: 3, values: { labels: [] }, published: {
    schemaVersion: 1, sourceVersion: 2, publishedAt: "2026-08-14T19:00:00.000Z",
    values: { labels: [{ ...label, ...(valid ? {} : { textColor: "invalid" }) }] } } };
  const fixture = databaseFixture({ coverageLabels });
  const read = await readPublicArtifactContentFromDatabase(fixture.database as never,
    { buildBatchId: "build-one", commitSha: COMMIT_SHA }, new Date(CUTOFF_MILLIS + 30_000));
  const artifact = projectPublicArtifactContent(read);
  if (valid) {
    expect(artifact.settings).toContainEqual({ settingId: "coverage-labels", sourceVersion: 2, publishedAt: "2026-08-14T19:00:00.000Z", labels: [label] });
    expect(assertPublicArtifactBundle({ schemaVersion: 3, ...artifact }).settings).toEqual(artifact.settings);
  } else {
    expect(artifact.settings.some(setting => setting.settingId === "coverage-labels")).toBe(false);
    expect(artifact.receipt.settingsFallbacks).toContainEqual({ documentId: "coverage-labels", sourceVersion: 2 });
  }
});
