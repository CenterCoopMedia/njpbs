import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "astro/zod";
import adminPkg from "../tests/helpers/firebase-admin";
import { cmsPostsLoader } from "../src/lib/cms-posts-loader";
import { cmsAuthorsLoader } from "../src/lib/cms-authors-loader";
import { PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID } from "../../packages/content-core/src/cms-settings";

// The public Post and author routes against a real Firestore, and then against a
// real build. The unit specs cover the projection rules; what only an end-to-end
// run can show is that an admitted post becomes a file at the route it claims,
// that a retired slug becomes a redirect stub beside it, that a withdrawn author
// leaves the next build entirely, and that the emitted HTML satisfies the
// post-build deploy gates (one self-resolving canonical, a breadcrumb, sized
// images, a cued new-tab link, no structured data on a noindex stub).

const admin = adminPkg;
const PROJECT = process.env.FIREBASE_PROJECT_ID || "demo-njpbs";
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const PAST = "2026-08-20T14:00:00.000Z";
const AUTHOR_ID = `au_${"1".repeat(32)}`;
const OTHER_AUTHOR_ID = `au_${"2".repeat(32)}`;
const PUBLIC_BUILD_COMMIT_SHA = "a".repeat(40);

// A NAMED admin app, not the default one. The other e2e file deletes every app
// in its teardown, and vitest may run the two files in the same worker, so
// sharing the default app makes one file's cleanup silently disconnect the
// other's writes -- which reads as an empty collection rather than as an error.
const APP_NAME = "posts-authors-e2e";

let app: { name?: string; delete: () => Promise<void> };
let db: FirebaseFirestore.Firestore;

function makeStore() {
  const map = new Map<string, unknown>();
  return {
    clear: () => map.clear(),
    set: (entry: { id: string; data: unknown }) => {
      map.set(entry.id, entry.data);
    },
    entries: () => [...map.entries()],
    get: (id: string) => map.get(id),
    keys: () => [...map.keys()],
  };
}

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fork: () => logger,
  label: "test",
} as never;

async function runLoader(loader: { load: (context: never) => Promise<void> }) {
  const store = makeStore();
  await loader.load({
    store,
    logger,
    parseData: async ({ data }: { data: unknown }) => data,
    // The loaders touch nothing else on the context.
    meta: new Map(),
    config: {},
    watcher: undefined,
    refreshContextData: undefined,
    generateDigest: () => "",
    entryTypes: new Map(),
    collection: "test",
    parseZodData: z,
  } as never);
  return store;
}

function postDocument(
  overrides: Record<string, unknown> = {},
  metadata: Record<string, unknown> = {},
) {
  return {
    type: "post",
    status: "published",
    publishAt: PAST,
    version: 3,
    blocks: [],
    published: {
      blocks: [
        {
          id: "body",
          type: "prose",
          order: 0,
          visible: true,
          data: {
            content: {
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [
                    { type: "text", text: "The hearing ran two hours." },
                  ],
                },
              ],
            },
          },
        },
      ],
      metadata: {
        type: "post",
        title: "Trenton budget hearing draws a crowd",
        slug: "trenton-budget-hearing",
        previousSlugs: ["budget-hearing-2026"],
        locale: "en",
        tags: ["budget"],
        summary: "Residents filled the room.",
        editorialDateSource: "firstPublish",
        firstPublishedAt: PAST,
        firstPublishedBy: "uid-secret-editor",
        credits: [
          {
            kind: "registered",
            authorId: AUTHOR_ID,
            displayName: "Ada Reporter",
            slug: "ada-reporter",
          },
        ],
        ...metadata,
      },
      publishedAt: PAST,
      publishedBy: "uid-secret-editor",
      sourceVersion: 3,
    },
    ...overrides,
  };
}

function authorSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    authorId: AUTHOR_ID,
    slug: "ada-reporter",
    previousSlugs: ["a-reporter"],
    displayName: "Ada Reporter",
    jobTitle: "Statehouse reporter",
    bio: "Covers the Legislature for NJ PBS.",
    photo: null,
    links: { x: { handle: "adareporter", url: "https://x.com/adareporter" } },
    pinnedPostId: null,
    hiddenPostIds: [],
    publishedAt: PAST,
    snapshotVersion: 2,
    ...overrides,
  };
}

function programDocument() {
  return {
    type: "program",
    status: "published",
    publishAt: PAST,
    version: 4,
    blocks: [],
    published: {
      blocks: [],
      metadata: {
        type: "program",
        title: "Due Process",
        genre: "public affairs",
        description: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "A weekly look at law and policy." },
              ],
            },
          ],
        },
        keyArt: "pbsmm-asset-4821",
        memberOnly: false,
        slug: "due-process",
        previousSlugs: ["due-process-tv"],
        locale: "en",
      },
      publishedAt: PAST,
      publishedBy: "uid-secret-editor",
      sourceVersion: 4,
    },
  };
}

function staffPageDocument() {
  return {
    title: "Staff",
    description: "Meet the people who make NJ PBS.",
    template: "genericPage",
    status: "published",
    publishAt: PAST,
    blocks: [],
    version: 1,
    published: {
      blocks: [],
      metadata: {
        title: "Staff",
        description: "Meet the people who make NJ PBS.",
      },
      publishedAt: PAST,
      publishedBy: "uid-secret-editor",
      sourceVersion: 1,
    },
  };
}

async function clear(collection: string) {
  const snapshot = await db.collection(collection).get();
  await Promise.all(snapshot.docs.map((document) => document.ref.delete()));
}

beforeAll(() => {
  process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_HOST;
  process.env.FIREBASE_PROJECT_ID = PROJECT;
  // Strict is how the publish build runs, and it is what makes a read or
  // projection failure here an error the test reports rather than a warning the
  // loader swallows into an empty collection.
  process.env.CMS_LOADER_STRICT = "1";
  app = ((admin.apps as { name?: string; delete: () => Promise<void> }[]).find(
    (candidate) => candidate?.name === APP_NAME,
  ) ?? admin.initializeApp({ projectId: PROJECT }, APP_NAME)) as typeof app;
  db = admin.firestore(app as never);
});

afterAll(async () => {
  await app.delete().catch(() => {});
});

beforeEach(async () => {
  await Promise.all([
    clear("cmsPages"),
    clear("cmsPosts"),
    clear("cmsAuthorProfilesPublic"),
    clear("cmsSettings"),
    clear("media_assets_public"),
    clear("system/publicDeployment/buildBatches"),
  ]);
});

describe("the post loader against Firestore", () => {
  it("loads an admitted published post and nothing else", async () => {
    await db.collection("cmsPosts").doc("post-live").set(postDocument());
    await db
      .collection("cmsPosts")
      .doc("post-draft")
      .set(postDocument({ status: "draft" }));
    await db
      .collection("cmsPosts")
      .doc("post-deleted")
      .set(postDocument({ deleted: true }));

    const store = await runLoader(cmsPostsLoader() as never);
    expect(store.keys()).toEqual(["post-live"]);
    expect(store.get("post-live")).toMatchObject({
      path: "/posts/trenton-budget-hearing/",
      previousSlugs: ["budget-hearing-2026"],
      authorIds: [AUTHOR_ID],
    });
  });

  it("drops an unpublished post from the next load, leaving no route behind", async () => {
    const ref = db.collection("cmsPosts").doc("post-live");
    await ref.set(postDocument());
    expect((await runLoader(cmsPostsLoader() as never)).keys()).toEqual([
      "post-live",
    ]);
    await ref.set(postDocument({ status: "draft", publiclyVisible: false }));
    expect((await runLoader(cmsPostsLoader() as never)).keys()).toEqual([]);
  });

  it("refuses the whole build when two posts claim one route", async () => {
    await db.collection("cmsPosts").doc("post-one").set(postDocument());
    await db.collection("cmsPosts").doc("post-two").set(postDocument());
    await expect(runLoader(cmsPostsLoader() as never)).rejects.toThrow(
      /routes collide/,
    );
  });
});

describe("the author loader against Firestore", () => {
  it("loads a published author snapshot with its retired slug", async () => {
    await db
      .collection("cmsAuthorProfilesPublic")
      .doc(AUTHOR_ID)
      .set(authorSnapshot());
    const store = await runLoader(cmsAuthorsLoader() as never);
    expect(store.get(AUTHOR_ID)).toMatchObject({
      path: "/authors/ada-reporter/",
      previousSlugs: ["a-reporter"],
      links: [{ platform: "x", url: "https://x.com/adareporter" }],
    });
  });

  it("leaves the next build entirely when the profile is withdrawn", async () => {
    const ref = db.collection("cmsAuthorProfilesPublic").doc(AUTHOR_ID);
    await ref.set(authorSnapshot());
    expect((await runLoader(cmsAuthorsLoader() as never)).keys()).toEqual([
      AUTHOR_ID,
    ]);
    // Withdrawal deletes the snapshot in the same transaction that turns the
    // working profile private. Nothing else has to happen for the route to go.
    await ref.delete();
    expect((await runLoader(cmsAuthorsLoader() as never)).keys()).toEqual([]);
  });

  it("refuses the whole build when two authors claim one route", async () => {
    await db
      .collection("cmsAuthorProfilesPublic")
      .doc(AUTHOR_ID)
      .set(authorSnapshot());
    await db
      .collection("cmsAuthorProfilesPublic")
      .doc(OTHER_AUTHOR_ID)
      .set(
        authorSnapshot({
          authorId: OTHER_AUTHOR_ID,
          slug: "other-reporter",
          previousSlugs: ["ada-reporter"],
        }),
      );
    await expect(runLoader(cmsAuthorsLoader() as never)).rejects.toThrow(
      /routes collide/,
    );
  });
});

describe("a real build", () => {
  it(
    "emits all routed families from one exact public artifact bundle",
    { timeout: 600000 },
    async () => {
      if (process.env.CMS_LOADER_E2E_BUILD !== "1") {
        // Same rule as the page loader's build proof: the full build is slow, so
        // it runs on request and the emulator gate stays fast by default.
        return;
      }
      await db.collection("cmsPages").doc("staff").set(staffPageDocument());
      await db.collection("cmsPosts").doc("post-live").set(postDocument());
      await db
        .collection("cmsPosts")
        .doc("post-hidden")
        .set(
          postDocument(
            {},
            {
              title: "A story the author left off their page",
              slug: "left-off-story",
              previousSlugs: [],
            },
          ),
        );
      await db
        .collection("cmsPosts")
        .doc("program-live")
        .set(programDocument());
      await db
        .collection("cmsAuthorProfilesPublic")
        .doc(AUTHOR_ID)
        .set(authorSnapshot({ hiddenPostIds: ["post-hidden"] }));
      await db.collection("cmsSettings")
        .doc(PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID)
        .set({
          schemaVersion: 1,
          version: 1,
          values: {
            enabled: true,
            message: "The public artifact banner is live.",
          },
          published: {
            schemaVersion: 1,
            values: {
              enabled: true,
              message: "The public artifact banner is live.",
            },
            sourceVersion: 1,
            publishedAt: PAST,
          },
        });

      const buildBatchId = "artifact-routes-one";
      const serverTimestamp = admin.firestore.FieldValue.serverTimestamp();
      await db
        .collection("system/publicDeployment/buildBatches")
        .doc(buildBatchId)
        .set({
          schemaVersion: 1,
          buildBatchId,
          generation: 1,
          status: "reserved",
          commitSha: PUBLIC_BUILD_COMMIT_SHA,
          reservedAgainstGeneration: 0,
          reservedAgainstDeploymentId: null,
          reservedAgainstCommitSha: null,
          cutoffAt: serverTimestamp,
          reservedAt: serverTimestamp,
        });
      const directory = await mkdtemp(
        path.join(tmpdir(), "njpbs-routed-artifact-"),
      );
      const receiptPath = path.join(directory, "receipt.json");

      try {
        const build = spawnSync("npm", ["run", "build"], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            PUBLIC_ONLY: "",
            CMS_LOADER_STRICT: "1",
            CMS_CONTENT_MODE: "published",
            PUBLIC_BUILD_BATCH_ID: buildBatchId,
            PUBLIC_BUILD_COMMIT_SHA,
            PUBLIC_ARTIFACT_INVENTORY_PATH: receiptPath,
          },
          encoding: "utf8",
          shell: process.platform === "win32",
        });
        expect(build.status, `${build.stdout}${build.stderr}`).toBe(0);

        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        expect(receipt).toMatchObject({
          schemaVersion: 2,
          mediaManifestSchemaVersion: 1,
          buildBatchId,
          aggregateRoutes: ["/posts/", "/staff/"],
          families: [
            { collection: "cmsPages", complete: true },
            { collection: "cmsPosts", complete: true },
            {
              collection: "cmsSettings",
              complete: true,
              artifacts: [{
                documentId: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
                sourceVersion: 1,
                canonicalPath: "/",
                aliases: [],
              }],
            },
            { collection: "cmsAuthorProfilesPublic", complete: true },
          ],
        });

        const post = readFileSync(
          "dist/posts/trenton-budget-hearing/index.html",
          "utf8",
        );
        expect(post).toContain("Trenton budget hearing draws a crowd");
        expect(post).toContain("The hearing ran two hours.");
        // The byline links the author page because a public slug was frozen with
        // the credit, and prints the DATE rather than a publish clock time.
        expect(post).toContain('href="/authors/ada-reporter/"');
        expect(post).toContain("Aug. 20, 2026");
        // One self-resolving canonical, a breadcrumb, and no leaked uid.
        expect(post).toContain(
          '<link rel="canonical" href="https://njpbs.org/posts/trenton-budget-hearing/"',
        );
        expect(post).toContain('"@type":"BreadcrumbList"');
        expect(post).toContain('"@type":"NewsArticle"');
        expect(post).not.toContain("uid-secret-editor");
        expect(post.match(/data-post-share(?:\s|>)/g)).toHaveLength(2);

        const homepage = readFileSync("dist/index.html", "utf8");
        expect(homepage).toContain('aria-label="Homepage announcement"');
        expect(homepage).toContain("The public artifact banner is live.");
        expect(homepage.indexOf("The public artifact banner is live.")).toBeLessThan(
          homepage.indexOf('class="hero"'),
        );

        // The retired slug is a noindex stub that canonicalizes to the live route
        // and carries no structured data.
        const stub = readFileSync(
          "dist/posts/budget-hearing-2026/index.html",
          "utf8",
        );
        expect(stub).toContain('content="noindex');
        expect(stub).toContain(
          '<link rel="canonical" href="https://njpbs.org/posts/trenton-budget-hearing/"',
        );
        expect(stub).toContain('http-equiv="refresh"');
        expect(stub).not.toContain("application/ld+json");

        const author = readFileSync(
          "dist/authors/ada-reporter/index.html",
          "utf8",
        );
        expect(author).toContain("Ada Reporter");
        expect(author).toContain('"@type":"ProfilePage"');
        expect(author).toContain('href="/posts/trenton-budget-hearing/"');
        // The hidden post is off THIS page but still has its own route.
        expect(author).not.toContain('href="/posts/left-off-story/"');
        expect(existsSync("dist/posts/left-off-story/index.html")).toBe(true);
        // The social link opens a new tab and carries the screen-reader cue.
        expect(author).toContain("(opens in new tab)");
        const authorStub = readFileSync(
          "dist/authors/a-reporter/index.html",
          "utf8",
        );
        expect(authorStub).toContain('content="noindex');

        const program = readFileSync(
          "dist/programs/due-process/index.html",
          "utf8",
        );
        expect(program).toContain("Due Process");
        expect(program).toContain("A weekly look at law and policy.");
        const programStub = readFileSync(
          "dist/programs/due-process-tv/index.html",
          "utf8",
        );
        expect(programStub).toContain('content="noindex');
        const oldProgram = readFileSync("dist/shows/due-process/index.html", "utf8");
        expect(oldProgram).toContain("/programs/due-process/");
        expect(readFileSync("dist/programs/index.html", "utf8")).toContain("Due Process");

        const staff = readFileSync("dist/staff/index.html", "utf8");
        expect(staff).toContain("Ada Reporter");
        expect(staff).toContain('href="/authors/ada-reporter/"');

        const sitemap = readFileSync("dist/sitemap-0.xml", "utf8");
        expect(sitemap).toContain("/posts/trenton-budget-hearing/");
        expect(sitemap).toContain("/programs/due-process/");
        expect(sitemap).toContain("/programs/");
        expect(sitemap).not.toContain("/shows/due-process/");
        expect(sitemap).not.toContain("/posts/budget-hearing-2026/");
        expect(sitemap).not.toContain("/programs/due-process-tv/");
        expect(sitemap).not.toContain("/authors/a-reporter/");

        await Promise.all([
          clear("cmsPosts"),
          clear("cmsAuthorProfilesPublic"),
        ]);
        await db.collection("cmsSettings")
          .doc(PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID)
          .set({
            schemaVersion: 1,
            version: 2,
            values: {
              enabled: false,
              message: "The disabled public artifact banner.",
            },
            published: {
              schemaVersion: 1,
              values: {
                enabled: false,
                message: "The disabled public artifact banner.",
              },
              sourceVersion: 2,
              publishedAt: PAST,
            },
          });
        const emptyBuildBatchId = "artifact-routes-empty";
        const emptyServerTimestamp =
          admin.firestore.FieldValue.serverTimestamp();
        await db
          .collection("system/publicDeployment/buildBatches")
          .doc(emptyBuildBatchId)
          .set({
            schemaVersion: 1,
            buildBatchId: emptyBuildBatchId,
            generation: 2,
            status: "reserved",
          commitSha: PUBLIC_BUILD_COMMIT_SHA,
          reservedAgainstGeneration: 0,
          reservedAgainstDeploymentId: null,
          reservedAgainstCommitSha: null,
            cutoffAt: emptyServerTimestamp,
            reservedAt: emptyServerTimestamp,
          });
        const emptyReceiptPath = path.join(directory, "empty-receipt.json");
        const emptyBuild = spawnSync("npm", ["run", "build"], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            PUBLIC_ONLY: "",
            CMS_LOADER_STRICT: "1",
            CMS_CONTENT_MODE: "published",
            PUBLIC_BUILD_BATCH_ID: emptyBuildBatchId,
            PUBLIC_BUILD_COMMIT_SHA,
            PUBLIC_ARTIFACT_INVENTORY_PATH: emptyReceiptPath,
          },
          encoding: "utf8",
          shell: process.platform === "win32",
        });
        expect(
          emptyBuild.status,
          `${emptyBuild.stdout}${emptyBuild.stderr}`,
        ).toBe(0);
        const emptyReceipt = JSON.parse(
          await readFile(emptyReceiptPath, "utf8"),
        );
        expect(
          emptyReceipt.families.find(
            ({ collection }: { collection: string }) =>
              collection === "cmsPosts",
          )?.artifacts,
        ).toEqual([]);
        expect(
          emptyReceipt.families.find(
            ({ collection }: { collection: string }) =>
              collection === "cmsSettings",
          )?.artifacts,
        ).toEqual([expect.objectContaining({
          documentId: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
          sourceVersion: 2,
        })]);
        expect(
          emptyReceipt.families.find(
            ({ collection }: { collection: string }) =>
              collection === "cmsAuthorProfilesPublic",
          )?.artifacts,
        ).toEqual([]);
        expect(existsSync("dist/posts/trenton-budget-hearing/index.html")).toBe(
          false,
        );
        expect(existsSync("dist/programs/due-process/index.html")).toBe(false);
        expect(existsSync("dist/authors/ada-reporter/index.html")).toBe(false);
        expect(readFileSync("dist/staff/index.html", "utf8")).toContain(
          'content="noindex',
        );
        expect(readFileSync("dist/index.html", "utf8")).not.toContain(
          'aria-label="Homepage announcement"',
        );

        await db.collection("cmsSettings")
          .doc(PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID)
          .set({
            schemaVersion: 1,
            version: 3,
            values: {
              enabled: false,
              message: "Valid working value",
            },
            published: {
              schemaVersion: 1,
              values: {
                enabled: true,
                message: "",
              },
              sourceVersion: 3,
              publishedAt: PAST,
            },
          });
        const invalidBuildBatchId = "artifact-routes-invalid-setting";
        const invalidServerTimestamp =
          admin.firestore.FieldValue.serverTimestamp();
        await db
          .collection("system/publicDeployment/buildBatches")
          .doc(invalidBuildBatchId)
          .set({
            schemaVersion: 1,
            buildBatchId: invalidBuildBatchId,
            generation: 3,
            status: "reserved",
            commitSha: PUBLIC_BUILD_COMMIT_SHA,
            reservedAgainstGeneration: 0,
            reservedAgainstDeploymentId: null,
            reservedAgainstCommitSha: null,
            cutoffAt: invalidServerTimestamp,
            reservedAt: invalidServerTimestamp,
          });
        const invalidBuild = spawnSync("npm", ["run", "build"], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            PUBLIC_ONLY: "",
            CMS_LOADER_STRICT: "1",
            CMS_CONTENT_MODE: "published",
            PUBLIC_BUILD_BATCH_ID: invalidBuildBatchId,
            PUBLIC_BUILD_COMMIT_SHA,
            PUBLIC_ARTIFACT_INVENTORY_PATH: path.join(
              directory,
              "invalid-receipt.json",
            ),
          },
          encoding: "utf8",
          shell: process.platform === "win32",
        });
        expect(invalidBuild.status).not.toBe(0);
        expect(`${invalidBuild.stdout}${invalidBuild.stderr}`).toMatch(
          /public homepage banner published snapshot is invalid/i,
        );

        // The coming-soon rollback drops both bases entirely.
        const publicOnly = spawnSync("npm", ["exec", "--", "astro", "build"], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            PUBLIC_ONLY: "1",
            CMS_LOADER_STRICT: "1",
            CMS_CONTENT_MODE: "published",
          },
          encoding: "utf8",
          shell: process.platform === "win32",
        });
        expect(
          publicOnly.status,
          `${publicOnly.stdout}${publicOnly.stderr}`,
        ).toBe(0);
        expect(existsSync("dist/posts/trenton-budget-hearing/index.html")).toBe(
          false,
        );
        expect(existsSync("dist/authors/ada-reporter/index.html")).toBe(false);
        expect(existsSync("dist/programs/due-process/index.html")).toBe(false);
        expect(existsSync("dist/staff/index.html")).toBe(false);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
