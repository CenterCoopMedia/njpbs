import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "astro/zod";
import adminPkg from "../tests/helpers/firebase-admin";
import { PUBLIC_PAGES } from "../../packages/content-core/src/public-pages";
import {
  cmsPagesLoader,
  projectPublicArtifactContent,
  readPublicArtifactContentFromDatabase,
} from "../src/lib/cms-loader";
import {
  pageCompositionSeed,
  pageSeedAsset,
} from "../../packages/content-core/src/page-composition-seeds";
import {
  PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION,
  writePublicArtifactBundle,
} from "../src/lib/public-artifact-bundle";
import {
  PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
  publicHomepageBannerLoader,
} from "../src/lib/public-homepage-banner";

const admin = adminPkg;
const PROJECT = process.env.FIREBASE_PROJECT_ID || "demo-njpbs";
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const RENDERER_SHA = "0123456789abcdef0123456789abcdef01234567";
const PUBLIC_BUILD_COMMIT_SHA = "a".repeat(40);

let db: FirebaseFirestore.Firestore;

async function withEnv(
  updates: Record<string, string | undefined>,
  run: () => Promise<void>,
) {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(updates)) {
    saved.set(key, process.env[key]);
    const value = updates[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function makeStore() {
  const map = new Map<string, unknown>();
  return {
    clear: () => map.clear(),
    set: (entry: { id: string; data: unknown }) => {
      map.set(entry.id, entry.data);
      return true;
    },
    get: (id: string) => map.get(id),
    keys: () => map.keys(),
    values: () => map.values(),
    entries: () => map.entries(),
    has: (id: string) => map.has(id),
    delete: (id: string) => map.delete(id),
    _map: map,
  };
}

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

const cmsPageSchema = z.object({
  pageId: z.string(),
  path: z.string(),
  family: z.enum(["home", "service", "schedule", "article", "staff", "dataHub"]),
  template: z.enum(["home", "programLanding", "genericPage"]),
  title: z.string(),
  description: z.string(),
  homeHeroTitle: z.string().optional(),
  homeHeroSubtitle: z.string().optional(),
  noindex: z.boolean(),
  seo: z.record(z.string(), z.unknown()).optional(),
  social: z.record(z.string(), z.unknown()).optional(),
  blocks: z.array(z.unknown()),
  assets: z.record(
    z.string(),
    z.object({
      url: z.url(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
    }),
  ),
  contentMode: z.enum(["published", "draft"]),
  sourceVersion: z.number().int().positive().nullable(),
  publishedAt: z.string().nullable(),
});

const PAST = "2026-01-01T00:00:00.000Z";

function cmsPage(overrides: Record<string, unknown> = {}) {
  return {
    title: "Contact",
    description: "Contact NJ PBS",
    template: "genericPage",
    status: "published",
    publishAt: PAST,
    blocks: [],
    version: 2,
    published: {
      blocks: [],
      metadata: {
        title: "Contact",
        description: "Contact NJ PBS",
      },
      publishedAt: PAST,
      publishedBy: "editor-1",
      sourceVersion: 2,
    },
    ...overrides,
  };
}

function publishedStaffPage() {
  return cmsPage({
    title: "Staff",
    description: "Meet the people who make NJ PBS.",
    version: 1,
    published: {
      blocks: [],
      metadata: {
        title: "Staff",
        description: "Meet the people who make NJ PBS.",
      },
      publishedAt: PAST,
      publishedBy: "editor-1",
      sourceVersion: 1,
    },
  });
}

async function runLoader(
  store: ReturnType<typeof makeStore>,
  loader = cmsPagesLoader(),
) {
  await loader.load({
    store,
    logger: noopLogger,
    parseData: async ({ data }: { id: string; data: unknown }) =>
      cmsPageSchema.parse(data),
    // the loader only uses store, logger, parseData
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

beforeAll(() => {
  admin.initializeApp({ projectId: PROJECT });
  db = admin.firestore();
});

beforeEach(async () => {
  await fetch(
    `http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" },
  );
});

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app?.delete()));
});

describe("cmsPages loader against the Firestore emulator", () => {
  it("loads admitted published snapshots and excludes working drafts", async () => {
    await db.collection("cmsPages").doc("contact").set(cmsPage());
    const workingDraft = cmsPage({
      title: "Working about",
      template: "programLanding",
      status: "draft",
    });
    delete (workingDraft as { published?: unknown }).published;
    await db.collection("cmsPages").doc("about").set(workingDraft);
    // Legacy template singleton: valid storage seed, never a public route.
    await db.collection("cmsPages").doc("genericPage").set(cmsPage());

    const store = makeStore();
    await runLoader(store);

    expect([...store.keys()]).toEqual(["contact"]);
    expect(store.get("contact")).toMatchObject({
      title: "Contact",
      path: "/contact/",
      contentMode: "published",
    });
    expect(store.has("about")).toBe(false);
    expect(store.has("genericPage")).toBe(false);
  });

  it("reads title and blocks from the frozen snapshot, never the working copy", async () => {
    await db.collection("cmsPages").doc("contact").set(
      cmsPage({
        title: "Unpublished title edit",
        blocks: [
          { id: "working", type: "divider", order: 0, visible: true, data: {} },
        ],
        published: {
          blocks: [
            { id: "public", type: "divider", order: 0, visible: true, data: {} },
          ],
          metadata: {
            title: "Frozen title",
            description: "Frozen description",
          },
          publishedAt: PAST,
          publishedBy: "editor-1",
          sourceVersion: 2,
        },
      }),
    );

    const store = makeStore();
    await runLoader(store);

    expect(store.get("contact")).toMatchObject({
      title: "Frozen title",
      description: "Frozen description",
      blocks: [{ id: "public" }],
    });
  });

  it("strict builds retain the committed route for legacy block-only snapshots", async () => {
    const legacy = cmsPage({
      title: "Legacy contact",
      description: "Existing live page",
      version: 3,
      published: {
        blocks: [
          { id: "legacy", type: "divider", order: 0, visible: true, data: {} },
        ],
        publishedAt: PAST,
        publishedBy: "legacy-editor",
      },
    });
    delete (legacy as { publishAt?: unknown }).publishAt;
    await db.collection("cmsPages").doc("contact").set(legacy);
    await db.collection("cmsPages").doc("staff").set(publishedStaffPage());

    const store = makeStore();
    await withEnv({ CMS_LOADER_STRICT: "1" }, async () => {
      await runLoader(store);
    });

    expect(store.has("contact")).toBe(false);
  });

  it("skips malformed docs and keeps loading valid docs", async () => {
    await db.collection("cmsPages").doc("contact").set(
      cmsPage({
        published: {
          blocks: [{ id: "bad", type: "unknown" }],
          metadata: { title: "Bad" },
          publishedAt: PAST,
          publishedBy: "editor-1",
          sourceVersion: 2,
        },
      }),
    );
    await db.collection("cmsPages").doc("about").set(
      cmsPage({
        title: "About",
        template: "programLanding",
        published: {
          blocks: [],
          metadata: { title: "About", description: "About us" },
          publishedAt: PAST,
          publishedBy: "editor-1",
          sourceVersion: 2,
        },
      }),
    );

    const store = makeStore();
    await runLoader(store);

    expect(store.has("contact")).toBe(false);
    expect(store.get("about")).toMatchObject({ title: "About" });
    expect([...store.keys()]).toEqual(["about"]);
  });

  it("no-ops when Firestore is not configured", async () => {
    const savedEmu = process.env.FIRESTORE_EMULATOR_HOST;
    const savedCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.FIRESTORE_EMULATOR_HOST;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    try {
      const store = makeStore();
      await runLoader(store);
      expect([...store.keys()]).toEqual([]);
    } finally {
      if (savedEmu !== undefined) process.env.FIRESTORE_EMULATOR_HOST = savedEmu;
      if (savedCreds !== undefined) process.env.GOOGLE_APPLICATION_CREDENTIALS = savedCreds;
    }
  });

  it("clears a previously loaded store when Firestore is not configured", async () => {
    await db.collection("cmsPages").doc("contact").set(cmsPage());

    const store = makeStore();
    const loader = cmsPagesLoader();
    await runLoader(store, loader);
    expect([...store.keys()]).toEqual(["contact"]);

    const savedEmu = process.env.FIRESTORE_EMULATOR_HOST;
    const savedCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.FIRESTORE_EMULATOR_HOST;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    try {
      await runLoader(store, loader);
      expect([...store.keys()]).toEqual([]);
    } finally {
      if (savedEmu !== undefined) process.env.FIRESTORE_EMULATOR_HOST = savedEmu;
      if (savedCreds !== undefined) process.env.GOOGLE_APPLICATION_CREDENTIALS = savedCreds;
    }
  });

  it("rejects when strict mode is enabled and Firestore is not configured", async () => {
    await withEnv(
      {
        CMS_LOADER_STRICT: "1",
        FIRESTORE_EMULATOR_HOST: undefined,
        GOOGLE_APPLICATION_CREDENTIALS: undefined,
      },
      async () => {
        const store = makeStore();
        await expect(runLoader(store)).rejects.toThrow(/Firestore is not configured/);
      },
    );
  });

  it("rejects when strict mode is enabled and configured Firestore cannot be read", async () => {
    await withEnv(
      {
        CMS_LOADER_STRICT: "true",
        FIRESTORE_EMULATOR_HOST: undefined,
        FIREBASE_PROJECT_ID: PROJECT,
        GOOGLE_APPLICATION_CREDENTIALS: "missing-service-account.json",
      },
      async () => {
        const store = makeStore();
        await expect(runLoader(store)).rejects.toThrow(/Firestore read failed/);
      },
    );
  });

  it("fails strict publish builds on an admitted malformed snapshot", async () => {
    await db.collection("cmsPages").doc("contact").set(
      cmsPage({
        published: {
          blocks: [{ id: "bad", type: "unknown" }],
          metadata: { title: "Bad" },
          publishedAt: PAST,
          publishedBy: "editor-1",
          sourceVersion: 2,
        },
      }),
    );
    await db.collection("cmsPages").doc("about").set(
      cmsPage({
        template: "programLanding",
        published: {
          blocks: [],
          metadata: { title: "About" },
          publishedAt: PAST,
          publishedBy: "editor-1",
          sourceVersion: 2,
        },
      }),
    );

    const store = makeStore();
    await withEnv({ CMS_LOADER_STRICT: "1" }, async () => {
      await expect(runLoader(store)).rejects.toThrow(/invalid document contact/);
    });

    expect(store.has("contact")).toBe(false);
  });

  it("builds all canonical artifact owners from the reservation readTime", async () => {
    for (const [index, definition] of PUBLIC_PAGES.entries()) {
      const sourceVersion = index + 1;
      await db.collection("cmsPages").doc(definition.id).set(cmsPage({
        title: `${definition.title} working`,
        description: definition.title,
        template: definition.editorTemplate,
        version: sourceVersion,
        published: {
          blocks: [],
          metadata: {
            title: definition.title,
            description: definition.title,
          },
          publishedAt: PAST,
          publishedBy: "editor-1",
          sourceVersion,
        },
      }));
    }
    await db.collection("cmsSettings")
      .doc(PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID)
      .set({
        schemaVersion: 1,
        version: 7,
        values: {
          enabled: true,
          message: "Unpublished working message",
          linkLabel: "Working link",
          linkHref: "/working/",
        },
        published: {
          schemaVersion: 1,
          values: {
            enabled: true,
            message: "Published public update",
            linkLabel: "Read the update",
            linkHref: "/about/",
          },
          sourceVersion: 6,
          publishedAt: "2026-08-31T14:00:00.000Z",
        },
      });
    const batchRef = db
      .collection("system/publicDeployment/buildBatches")
      .doc("artifact-build-one");
    const serverTimestamp = admin.firestore.FieldValue.serverTimestamp();
    await batchRef.set({
      schemaVersion: 1,
      buildBatchId: "artifact-build-one",
      generation: 1,
      status: "reserved",
      commitSha: PUBLIC_BUILD_COMMIT_SHA,
      reservedAgainstGeneration: 0,
      reservedAgainstDeploymentId: null,
      reservedAgainstCommitSha: null,
      cutoffAt: serverTimestamp,
      reservedAt: serverTimestamp,
    });
    const batch = (await batchRef.get()).data()!;
    await db.collection("cmsPages").doc("contact").update({
      version: 99,
      "published.metadata.title": "Later title",
      "published.sourceVersion": 99,
    });

    const read = await readPublicArtifactContentFromDatabase(
      db as never,
      {
        buildBatchId: "artifact-build-one",
        commitSha: PUBLIC_BUILD_COMMIT_SHA,
      },
      new Date(),
    );
    const artifact = projectPublicArtifactContent(read);

    expect({
      seconds: read.reservation.cutoffAt.seconds,
      nanoseconds: read.reservation.cutoffAt.nanoseconds,
    }).toEqual({
      seconds: batch.cutoffAt.seconds,
      nanoseconds: batch.cutoffAt.nanoseconds,
    });
    expect(artifact.pages).toHaveLength(PUBLIC_PAGES.length);
    expect(artifact.settings).toEqual([{
      settingId: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
      enabled: true,
      message: "Published public update",
      link: { label: "Read the update", href: "/about/" },
      sourceVersion: 6,
      publishedAt: "2026-08-31T14:00:00.000Z",
    }]);
    const contactSourceVersion =
      PUBLIC_PAGES.findIndex(({ id }) => id === "contact") + 1;
    expect(artifact.pages.find(({ pageId }) => pageId === "contact"))
      .toMatchObject({ title: "Contact NJ PBS", sourceVersion: contactSourceVersion });
    const expectedOwnerCount = artifact.pages.length + artifact.settings.length;
    expect(artifact.receipt.owners).toHaveLength(expectedOwnerCount);
    expect(artifact.receipt.owners.find(({ documentId }) =>
      documentId === "contact")).toMatchObject({ sourceVersion: contactSourceVersion });
    expect(artifact.receipt.owners.find(({ documentId }) =>
      documentId === PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID))
      .toMatchObject({ sourceVersion: 6 });

    const directory = await mkdtemp(path.join(tmpdir(), "njpbs-loader-artifact-"));
    const bundlePath = path.join(directory, "bundle.json");
    try {
      await writePublicArtifactBundle(bundlePath, {
        schemaVersion: PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION,
        ...artifact,
      });
      const store = makeStore();
      const bannerStore = makeStore();
      await withEnv({
        PUBLIC_BUILD_BATCH_ID: "artifact-build-one",
        PUBLIC_BUILD_COMMIT_SHA,
        PUBLIC_ARTIFACT_INVENTORY_PATH: path.join(directory, "receipt.json"),
        PUBLIC_ARTIFACT_BUNDLE_PATH: bundlePath,
        PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION: "3",
      }, async () => {
        await runLoader(store);
        await publicHomepageBannerLoader().load({
          store: bannerStore,
          logger: noopLogger,
          parseData: async ({ data }: { data: unknown }) => data,
        } as never);
      });

      expect([...store.keys()]).toHaveLength(PUBLIC_PAGES.length);
      expect(store.get("contact")).toMatchObject({
        title: "Contact NJ PBS",
        sourceVersion: contactSourceVersion,
      });
      expect(bannerStore.get(PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID)).toMatchObject({
        message: "Published public update",
        sourceVersion: 6,
      });
      expect(JSON.parse(await readFile(bundlePath, "utf8"))).toMatchObject({
        receipt: {
          buildBatchId: "artifact-build-one",
          commitSha: PUBLIC_BUILD_COMMIT_SHA,
          ownerCount: expectedOwnerCount,
        },
        settings: [{
          settingId: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
          message: "Published public update",
          sourceVersion: 6,
        }],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails a strict artifact projection for an invalid published homepage setting", async () => {
    await db.collection("cmsPages").doc("staff").set(publishedStaffPage());
    await db.collection("cmsSettings")
      .doc(PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID)
      .set({
        schemaVersion: 1,
        version: 2,
        values: { enabled: false, message: "Valid working value" },
        published: {
          schemaVersion: 1,
          values: { enabled: true, message: "" },
          sourceVersion: 1,
          publishedAt: "2026-08-31T14:00:00.000Z",
        },
      });
    const serverTimestamp = admin.firestore.FieldValue.serverTimestamp();
    await db.collection("system/publicDeployment/buildBatches")
      .doc("artifact-build-invalid-setting")
      .set({
        schemaVersion: 1,
        buildBatchId: "artifact-build-invalid-setting",
        generation: 1,
        status: "reserved",
        commitSha: PUBLIC_BUILD_COMMIT_SHA,
        reservedAgainstGeneration: 0,
        reservedAgainstDeploymentId: null,
        reservedAgainstCommitSha: null,
        cutoffAt: serverTimestamp,
        reservedAt: serverTimestamp,
      });

    const read = await readPublicArtifactContentFromDatabase(
      db as never,
      {
        buildBatchId: "artifact-build-invalid-setting",
        commitSha: PUBLIC_BUILD_COMMIT_SHA,
      },
      new Date(),
    );

    expect(() => projectPublicArtifactContent(read)).toThrow(
      /public homepage banner published snapshot is invalid/i,
    );
  });

  it("loads exactly the requested mutable page for a strict draft build", async () => {
    await db.collection("cmsPages").doc("contact").set(
      cmsPage({
        status: "in_review",
        title: "Draft contact",
        description: "Reviewer copy",
        blocks: [
          { id: "draft", type: "divider", order: 0, visible: true, data: {} },
        ],
      }),
    );
    await db.collection("cmsPages").doc("about").set(
      cmsPage({ template: "programLanding" }),
    );

    const store = makeStore();
    await withEnv(
      {
        CMS_LOADER_STRICT: "1",
        CMS_CONTENT_MODE: "draft",
        CMS_PREVIEW_PAGE_ID: "contact",
      },
      async () => {
        await runLoader(store);
      },
    );

    expect([...store.keys()]).toEqual(["contact"]);
    expect(store.get("contact")).toMatchObject({
      title: "Draft contact",
      noindex: true,
      contentMode: "draft",
      blocks: [{ id: "draft" }],
    });
  });

  it("loads the queued revision even when the working page changes later", async () => {
    const requested = cmsPage({
      status: "in_review",
      title: "Captured draft",
      description: "The reviewer-requested revision.",
      version: 7,
      blocks: [
        {
          id: "captured",
          type: "image",
          order: 0,
          visible: true,
          data: { assetId: "mural", alt: "Captured mural" },
        },
      ],
    });
    await db.collection("cmsPages").doc("contact").set(requested);
    await db.collection("cmsPreviewQueue").doc("queue123").set({
      status: "building",
      transport: "github",
      pageId: "contact",
      sourceVersion: 7,
      rendererSha: RENDERER_SHA,
      snapshot: {
        id: "contact",
        title: requested.title,
        description: requested.description,
        template: requested.template,
        blocks: requested.blocks,
        version: requested.version,
      },
      assets: [
        {
          id: "mural",
          url: "https://media.njpbs.org/cms-media/captured-mural.jpg",
          mimeType: "image/jpeg",
          width: 1200,
          height: 675,
        },
      ],
      expiresAt: admin.firestore.Timestamp.fromDate(
        new Date("2099-07-30T12:00:00.000Z"),
      ),
    });
    await db.collection("cmsPages").doc("contact").update({
      title: "A later save",
      version: 8,
      blocks: [
        { id: "later", type: "divider", order: 0, visible: true, data: {} },
      ],
    });

    const store = makeStore();
    await withEnv(
      {
        CMS_LOADER_STRICT: "1",
        CMS_CONTENT_MODE: "draft",
        CMS_PREVIEW_PAGE_ID: "contact",
        CMS_PREVIEW_QUEUE_ID: "queue123",
        CMS_PREVIEW_RENDERER_SHA: RENDERER_SHA,
      },
      async () => {
        await runLoader(store);
      },
    );

    expect([...store.keys()]).toEqual(["contact"]);
    expect(store.get("contact")).toMatchObject({
      title: "Captured draft",
      sourceVersion: 7,
      blocks: [{ id: "captured" }],
      assets: {
        mural: {
          url: "https://media.njpbs.org/cms-media/captured-mural.jpg",
          width: 1200,
          height: 675,
        },
      },
    });
  });

  it("loads the saved Watch composition and its finite seed assets as one exact reviewer revision", async () => {
    const seed = pageCompositionSeed("watch");
    if (!seed) throw new Error("Watch composition seed is missing");
    const assetIds = [
      "launch-watch",
      "launch-support",
      "launch-under-the-dome",
      "launch-about",
    ];
    const assets = assetIds.map((assetId) => {
      const asset = pageSeedAsset(assetId);
      if (!asset) throw new Error(`Watch seed asset ${assetId} is missing`);
      return {
        id: asset.id,
        url: asset.sourceUrl,
        mimeType: asset.mimeType,
        width: asset.width,
        height: asset.height,
      };
    });

    await db.collection("cmsPreviewQueue").doc("watchqueue1").set({
      status: "building",
      transport: "github",
      pageId: "watch",
      sourceVersion: 1,
      rendererSha: RENDERER_SHA,
      snapshot: {
        id: "watch",
        ...seed.metadata,
        template: "programLanding",
        blocks: seed.blocks,
        version: 1,
      },
      assets,
      expiresAt: admin.firestore.Timestamp.fromDate(
        new Date("2099-07-30T12:00:00.000Z"),
      ),
    });

    const store = makeStore();
    await withEnv(
      {
        CMS_LOADER_STRICT: "1",
        CMS_CONTENT_MODE: "draft",
        CMS_PREVIEW_PAGE_ID: "watch",
        CMS_PREVIEW_QUEUE_ID: "watchqueue1",
        CMS_PREVIEW_RENDERER_SHA: RENDERER_SHA,
      },
      async () => {
        await runLoader(store);
      },
    );

    expect([...store.keys()]).toEqual(["watch"]);
    expect(store.get("watch")).toMatchObject({
      title: "Watch NJ PBS",
      family: "service",
      contentMode: "draft",
      sourceVersion: 1,
      blocks: [
        { section: "hero-actions", type: "cta_row" },
        { section: "body-copy", type: "prose" },
        { section: "watch-destinations", type: "card_grid" },
        { section: "service-note", type: "prose" },
      ],
      assets: {
        "launch-watch": {
          url: "https://njpbs.org/brand/spotlight/watch.jpg",
          width: 640,
          height: 360,
        },
      },
    });
  });

  it("fails closed when a queued snapshot identity is inconsistent", async () => {
    await db.collection("cmsPreviewQueue").doc("queue123").set({
      status: "building",
      transport: "github",
      pageId: "contact",
      sourceVersion: 7,
      rendererSha: RENDERER_SHA,
      snapshot: {
        id: "about",
        title: "Wrong page",
        template: "programLanding",
        blocks: [],
        version: 7,
      },
      assets: [],
      expiresAt: admin.firestore.Timestamp.fromDate(
        new Date("2099-07-30T12:00:00.000Z"),
      ),
    });

    const store = makeStore();
    await withEnv(
      {
        CMS_LOADER_STRICT: "1",
        CMS_CONTENT_MODE: "draft",
        CMS_PREVIEW_PAGE_ID: "contact",
        CMS_PREVIEW_QUEUE_ID: "queue123",
        CMS_PREVIEW_RENDERER_SHA: RENDERER_SHA,
      },
      async () => {
        await expect(runLoader(store)).rejects.toThrow(/identity/);
      },
    );
  });

  it("refuses to rebuild a terminal preview queue", async () => {
    await db.collection("cmsPreviewQueue").doc("queue123").set({
      status: "ready",
      transport: "github",
      pageId: "contact",
      sourceVersion: 7,
      rendererSha: RENDERER_SHA,
      snapshot: {
        id: "contact",
        title: "Already deployed",
        template: "genericPage",
        blocks: [],
        version: 7,
      },
      assets: [],
      expiresAt: admin.firestore.Timestamp.fromDate(
        new Date("2099-07-30T12:00:00.000Z"),
      ),
    });

    const store = makeStore();
    await withEnv(
      {
        CMS_LOADER_STRICT: "1",
        CMS_CONTENT_MODE: "draft",
        CMS_PREVIEW_PAGE_ID: "contact",
        CMS_PREVIEW_QUEUE_ID: "queue123",
        CMS_PREVIEW_RENDERER_SHA: RENDERER_SHA,
      },
      async () => {
        await expect(runLoader(store)).rejects.toThrow(
          /preview queue queue123 is ready/,
        );
      },
    );
  });

  it("refuses a serializer queue in the GitHub preview loader", async () => {
    await db.collection("cmsPreviewQueue").doc("serializer1").set({
      status: "building",
      transport: "serializer",
      pageId: "contact",
      sourceVersion: 7,
      rendererSha: RENDERER_SHA,
      snapshot: {
        id: "contact",
        title: "Serializer-owned preview",
        template: "genericPage",
        blocks: [],
        version: 7,
      },
      assets: [],
      expiresAt: admin.firestore.Timestamp.fromDate(
        new Date("2099-07-30T12:00:00.000Z"),
      ),
    });

    const store = makeStore();
    await withEnv(
      {
        CMS_LOADER_STRICT: "1",
        CMS_CONTENT_MODE: "draft",
        CMS_PREVIEW_PAGE_ID: "contact",
        CMS_PREVIEW_QUEUE_ID: "serializer1",
        CMS_PREVIEW_RENDERER_SHA: RENDERER_SHA,
      },
      async () => {
        await expect(runLoader(store)).rejects.toThrow(
          /not owned by the GitHub preview transport/,
        );
      },
    );
  });

  it("loads the collection during a real astro build", { timeout: 300000 }, async () => {
    if (process.env.CMS_LOADER_E2E_BUILD !== "1") {
      // The full astro build is slow; it runs locally as the real-run proof (set
      // CMS_LOADER_E2E_BUILD=1) and is skipped by default so the emulator gate stays fast.
      return;
    }
    await db.collection("cmsPages").doc("contact").set(
      cmsPage({
        title: "Draft CMS contact",
        description: "A reviewer-only draft.",
        blocks: [
          {
            id: "draft-headline",
            type: "headline",
            order: 0,
            visible: true,
            data: { text: "Draft built from Firestore", level: 2 },
          },
        ],
        published: {
          blocks: [
            {
              id: "headline",
              type: "headline",
              order: 0,
              visible: true,
              data: { text: "Built from Firestore", level: 2 },
            },
            {
              id: "image",
              type: "image",
              order: 1,
              visible: true,
              data: {
                assetId: "mural",
                alt: "A New Jersey mural",
                caption: "Community art",
              },
            },
          ],
          metadata: {
            title: "CMS contact",
            description: "A static CMS page.",
            seo: {
              title: "Search-specific contact",
              description: "Search-result contact copy.",
            },
            social: {
              title: "Share NJ PBS contact",
              description: "Social-card contact copy.",
              imageAssetId: "mural",
            },
          },
          publishedAt: PAST,
          publishedBy: "editor-1",
          sourceVersion: 2,
        },
      }),
    );
    await db.collection("cmsPages").doc("staff").set(publishedStaffPage());
    await db.collection("media_assets_public").doc("mural").set({
      url: "https://njpbs.org/brand/spotlight/watch.jpg",
      mimeType: "image/webp",
      width: 1600,
      height: 900,
    });

    const build = spawnSync("npm", ["exec", "--", "astro", "build"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PUBLIC_ONLY: "",
        CMS_LOADER_STRICT: "1",
        CMS_CONTENT_MODE: "published",
      },
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    expect(build.status, `${build.stdout}${build.stderr}`).toBe(0);
    expect(`${build.stdout}${build.stderr}`).toMatch(
      /cmsPages loader: loaded 2 page\(s\)/,
    );
    const html = readFileSync("dist/contact/index.html", "utf8");
    expect(html).toContain('data-cms-page="contact"');
    expect(html).toContain("Built from Firestore");
    expect(html).toContain('data-asset-id="mural"');
    expect(html).toContain('alt="A New Jersey mural"');
    expect(html).toContain("<title>Search-specific contact — NJ PBS</title>");
    expect(html).toContain(
      '<meta name="description" content="Search-result contact copy.">',
    );
    expect(html).toContain(
      '<meta property="og:title" content="Share NJ PBS contact">',
    );
    expect(html).toContain(
      '<meta property="og:description" content="Social-card contact copy.">',
    );
    expect(html).toContain(
      '<meta property="og:image" content="https://njpbs.org/brand/spotlight/watch.jpg">',
    );
    expect(html).toContain(
      '<meta name="twitter:title" content="Share NJ PBS contact">',
    );
    // CMS migration is route-by-route. A strict build for Contact must retain
    // the committed homepage until a published home snapshot is admitted.
    const homeHtml = readFileSync("dist/index.html", "utf8");
    expect(homeHtml).toContain('id="hero-h"');
    expect(homeHtml).toContain("We're the new NJ PBS");
    expect(homeHtml).not.toContain('data-cms-page="home"');

    await db.collection("cmsPages").doc("give").set(
      cmsPage({
        title: "CMS-backed Give",
        description: "Give through the preserved service page.",
        template: "programLanding",
        blocks: [],
        published: {
          blocks: [
            {
              id: "give-heading",
              type: "headline",
              order: 0,
              visible: true,
              data: { text: "CMS Give editorial region", level: 2 },
            },
          ],
          metadata: {
            title: "CMS-backed Give",
            description: "Give through the preserved service page.",
          },
          publishedAt: PAST,
          publishedBy: "editor-1",
          sourceVersion: 2,
        },
      }),
    );
    await db.collection("cmsPages").doc("schedule").set(
      cmsPage({
        title: "CMS-backed schedule",
        description: "Schedule metadata and editorial content.",
        template: "programLanding",
        blocks: [],
        published: {
          blocks: [
            {
              id: "schedule-heading",
              type: "headline",
              order: 0,
              visible: true,
              data: { text: "CMS schedule editorial region", level: 2 },
            },
          ],
          metadata: {
            title: "CMS-backed schedule",
            description: "Schedule metadata and editorial content.",
          },
          publishedAt: PAST,
          publishedBy: "editor-1",
          sourceVersion: 2,
        },
      }),
    );
    await db.collection("cmsPages").doc("home").set(
      cmsPage({
        title: "CMS-backed NJ PBS home",
        description: "The accepted homepage with an editorial region.",
        template: "home",
        blocks: [
          {
            id: "working-home-heading",
            type: "headline",
            order: 0,
            visible: true,
            data: { text: "Unpublished home copy", level: 2 },
          },
        ],
        published: {
          blocks: [
            {
              id: "home-heading",
              type: "headline",
              order: 0,
              visible: true,
              data: { text: "CMS home editorial region", level: 2 },
            },
            {
              id: "home-manual-shelf",
              type: "promotion_playlist",
              order: 1,
              visible: true,
              data: {
                title: "CMS manual shelf",
                placement: "before_featured",
                cards: [1, 2, 3].map((number) => ({
                  itemId: `home-shelf-item-${number}`,
                  title: `CMS shelf item ${number}`,
                  summary: `CMS shelf summary ${number}`,
                  imageAssetId: `home-shelf-image-${number}`,
                  alt: `CMS shelf image ${number}`,
                  href: `/watch/item-${number}/`,
                })),
              },
            },
          ],
          metadata: {
            title: "CMS-backed NJ PBS home",
            description: "The accepted homepage with an editorial region.",
          },
          publishedAt: PAST,
          publishedBy: "editor-1",
          sourceVersion: 2,
        },
      }),
    );
    for (const number of [1, 2, 3]) {
      await db.collection("media_assets_public").doc(`home-shelf-image-${number}`).set({
        url: "https://njpbs.org/brand/starthere/kids.webp",
        mimeType: "image/webp",
        width: 1600,
        height: 900,
      });
    }
    const cmsHomeBuild = spawnSync("npm", ["exec", "--", "astro", "build"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PUBLIC_ONLY: "",
        CMS_LOADER_STRICT: "1",
        CMS_CONTENT_MODE: "published",
      },
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    expect(cmsHomeBuild.status).toBe(0);
    expect(`${cmsHomeBuild.stdout}${cmsHomeBuild.stderr}`).toMatch(
      /cmsPages loader: loaded 5 page\(s\)/,
    );
    const cmsHomeHtml = readFileSync("dist/index.html", "utf8");
    expect(cmsHomeHtml).toContain('id="hero-h"');
    expect(cmsHomeHtml).toContain("We're the new NJ PBS");
    expect(cmsHomeHtml).not.toContain('data-cms-page-blocks="home"');
    expect(cmsHomeHtml).not.toContain("CMS home editorial region");
    expect(cmsHomeHtml).toContain("CMS manual shelf");
    expect(cmsHomeHtml).toContain("CMS shelf item 1");
    expect(cmsHomeHtml).toContain('aria-label="CMS manual shelf items"');
    expect(cmsHomeHtml).not.toContain('class="page-hero"');
    const giveHtml = readFileSync("dist/give/index.html", "utf8");
    const donateHtml = readFileSync("dist/donate/index.html", "utf8");
    for (const aliasHtml of [giveHtml, donateHtml]) {
      expect(aliasHtml).toContain('class="public-page');
      expect(aliasHtml).toContain('data-cms-page-blocks="give"');
      expect(aliasHtml).toContain("CMS Give editorial region");
    }
    const scheduleHtml = readFileSync("dist/schedule/index.html", "utf8");
    expect(scheduleHtml).toContain("data-native-schedule");
    expect(scheduleHtml).toContain('data-cms-page-blocks="schedule"');
    expect(scheduleHtml).toContain("CMS schedule editorial region");

    const draftBuild = spawnSync("npm", ["exec", "--", "astro", "build"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PUBLIC_ONLY: "",
        CMS_LOADER_STRICT: "1",
        CMS_CONTENT_MODE: "draft",
        CMS_PREVIEW_PAGE_ID: "contact",
      },
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    expect(draftBuild.status).toBe(0);
    expect(`${draftBuild.stdout}${draftBuild.stderr}`).toMatch(
      /loaded 1 page.*draft content/,
    );
    const draftHtml = readFileSync("dist/contact/index.html", "utf8");
    expect(draftHtml).toContain('data-cms-content-mode="draft"');
    expect(draftHtml).toContain("Draft CMS contact");
    expect(draftHtml).toContain("Draft built from Firestore");
    expect(draftHtml).toContain("Private preview. The public site has not changed.");
    expect(draftHtml).not.toContain("Built from Firestore</h2>");

    await db.collection("cmsPreviewQueue").doc("queuedbuild1").set({
      status: "building",
      transport: "github",
      pageId: "contact",
      sourceVersion: 2,
      rendererSha: RENDERER_SHA,
      snapshot: {
        id: "contact",
        title: "Queued reviewer contact",
        description: "The exact revision sent to review.",
        template: "genericPage",
        version: 2,
        blocks: [
          {
            id: "queued-headline",
            type: "headline",
            order: 0,
            visible: true,
            data: { text: "Queued revision built from Firestore", level: 2 },
          },
        ],
      },
      assets: [],
      expiresAt: admin.firestore.Timestamp.fromDate(
        new Date("2099-07-30T12:00:00.000Z"),
      ),
    });
    await db.collection("cmsPages").doc("contact").update({
      title: "Later mutable contact",
      version: 3,
      blocks: [
        {
          id: "later-headline",
          type: "headline",
          order: 0,
          visible: true,
          data: { text: "This later save must not reach the queue", level: 2 },
        },
      ],
    });
    const queuedDraftBuild = spawnSync("npm", ["exec", "--", "astro", "build"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PUBLIC_ONLY: "",
        CMS_LOADER_STRICT: "1",
        CMS_CONTENT_MODE: "draft",
        CMS_PREVIEW_PAGE_ID: "contact",
        CMS_PREVIEW_QUEUE_ID: "queuedbuild1",
        CMS_PREVIEW_RENDERER_SHA: RENDERER_SHA,
      },
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    expect(queuedDraftBuild.status).toBe(0);
    expect(`${queuedDraftBuild.stdout}${queuedDraftBuild.stderr}`).toMatch(
      /loaded 1 page.*draft content/,
    );
    const queuedDraftHtml = readFileSync("dist/contact/index.html", "utf8");
    expect(queuedDraftHtml).toContain("Queued reviewer contact");
    expect(queuedDraftHtml).toContain("Queued revision built from Firestore");
    expect(queuedDraftHtml).not.toContain("Later mutable contact");
    expect(queuedDraftHtml).not.toContain(
      "This later save must not reach the queue",
    );

    const watchSeed = pageCompositionSeed("watch");
    if (!watchSeed) throw new Error("Watch composition seed is missing");
    const watchPreviewBlocks = structuredClone(watchSeed.blocks);
    const watchDestinations = watchPreviewBlocks.find(
      (block) => block.section === "watch-destinations",
    );
    if (watchDestinations?.type !== "card_grid" || !watchDestinations.data.cards[0]) {
      throw new Error("Watch destination card fixture is missing");
    }
    watchDestinations.data.cards[0].body = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Open the PBS-hosted video portal. " },
            {
              type: "text",
              text: "See Watch help",
              marks: [{ type: "link", attrs: { href: "/faq/" } }],
            },
          ],
        },
      ],
    };
    const watchAssetIds = [
      "launch-watch",
      "launch-support",
      "launch-under-the-dome",
      "launch-about",
    ];
    const watchAssets = watchAssetIds.map((assetId) => {
      const asset = pageSeedAsset(assetId);
      if (!asset) throw new Error(`Watch seed asset ${assetId} is missing`);
      return {
        id: asset.id,
        url: asset.sourceUrl,
        mimeType: asset.mimeType,
        width: asset.width,
        height: asset.height,
      };
    });
    await db.collection("cmsPreviewQueue").doc("watchbuild1").set({
      status: "building",
      transport: "github",
      pageId: "watch",
      sourceVersion: 1,
      rendererSha: RENDERER_SHA,
      snapshot: {
        id: "watch",
        ...watchSeed.metadata,
        template: "programLanding",
        blocks: watchPreviewBlocks,
        version: 1,
      },
      assets: watchAssets,
      expiresAt: admin.firestore.Timestamp.fromDate(
        new Date("2099-07-30T12:00:00.000Z"),
      ),
    });
    const watchPreviewBuild = spawnSync("npm", ["exec", "--", "astro", "build"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PUBLIC_ONLY: "",
        CMS_LOADER_STRICT: "1",
        CMS_CONTENT_MODE: "draft",
        CMS_PREVIEW_PAGE_ID: "watch",
        CMS_PREVIEW_QUEUE_ID: "watchbuild1",
        CMS_PREVIEW_RENDERER_SHA: RENDERER_SHA,
      },
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    expect(watchPreviewBuild.status).toBe(0);
    const watchPreviewHtml = readFileSync("dist/watch/index.html", "utf8");
    expect(watchPreviewHtml).toContain("Private preview. The public site has not changed.");
    expect(watchPreviewHtml).toContain('data-cms-service-page="watch"');
    expect(watchPreviewHtml.match(/Open PBS video portal/g)).toHaveLength(1);
    expect(watchPreviewHtml.match(/Programs on demand/g)).toHaveLength(1);
    expect(watchPreviewHtml.match(/PBS handles the player/g)).toHaveLength(1);
    expect(watchPreviewHtml).not.toContain('<a class="public-page__card"');
    expect(watchPreviewHtml).toContain(
      '<a class="public-page__card-title-link" href="https://watch.njpbs.org/"',
    );
    expect(watchPreviewHtml).toContain('<a href="/faq/">See Watch help</a>');
    expect(watchPreviewHtml.indexOf("Use Watch for NJ PBS video")).toBeLessThan(
      watchPreviewHtml.indexOf("Programs on demand"),
    );
    expect(watchPreviewHtml.indexOf("Programs on demand")).toBeLessThan(
      watchPreviewHtml.indexOf("PBS handles the player"),
    );
    expect(watchPreviewHtml).not.toContain('data-cms-page-blocks="watch"');
  });
});
