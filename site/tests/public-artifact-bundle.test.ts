import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cmsAuthorsLoader } from "../src/lib/cms-authors-loader";
import { cmsPagesLoader } from "../src/lib/cms-loader";
import { cmsPostsLoader } from "../src/lib/cms-posts-loader";
import { cmsProgramsLoader } from "../src/lib/cms-programs-loader";
import { publicHomepageBannerLoader } from "../src/lib/public-homepage-banner";
import { siteNavigationLoader } from "../src/lib/site-navigation";
import { DEFAULT_SITE_NAVIGATION } from "../../packages/content-core/src/cms-settings";
import { loadHomeSourceSnapshot } from "../src/lib/home-sources-loader";
import {
  PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION,
  assertPublicArtifactBundle,
  readPublicArtifactBundle,
  normalizePublicArtifactBundle,
  resolvePublicArtifactBundlePath,
  type PublicArtifactBundle,
  writePublicArtifactBundle,
} from "../src/lib/public-artifact-bundle";
import { createPublicArtifactInventoryReceipt } from "../src/lib/public-artifact-inventory";
import { homeCompositionDefaults } from "../../packages/content-core/src/home-composition";

const COMMIT_SHA = "a".repeat(40);
const directories: string[] = [];

function reservation() {
  const cutoffAt = {
    seconds: 1_755_792_000,
    nanoseconds: 0,
    toMillis: () => 1_755_792_000_000,
  };
  return {
    schemaVersion: 1,
    buildBatchId: "build-one",
    generation: 1,
    status: "reserved",
    commitSha: COMMIT_SHA,
    reservedAgainstGeneration: 0,
    reservedAgainstDeploymentId: null,
    reservedAgainstCommitSha: null,
    cutoffAt,
    reservedAt: cutoffAt,
  };
}

function emptyBundle(): PublicArtifactBundle {
  return {
    schemaVersion: PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION,
    pages: [],
    posts: [],
    programs: [],
    events: [],
    authors: [],
    settings: [],
    receipt: createPublicArtifactInventoryReceipt({
      reservation: reservation(),
      pages: [],
      posts: [],
      programs: [],
      authors: [],
      settings: [],
    }),
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("public artifact bundle", () => {
  it("admits a frozen two-link banner and rejects orphaned or unsafe second actions", () => {
    const publishedAt = "2026-11-03T19:00:00.000Z";
    const values = { enabled: true, njDecides: true, message: "Election night", linkLabel: "Results", linkHref: "/results/",
      secondLinkLabel: "Watch live", secondLinkHref: "https://live.njpbs.org/" };
    const setting = { settingId: "public-homepage-banner", enabled: true, njDecides: true, message: "Election night",
      link: { label: "Results", href: "/results/" }, secondLink: { label: "Watch live", href: "https://live.njpbs.org/" }, sourceVersion: 4, publishedAt };
    const bundle = { ...emptyBundle(), settings: [setting], receipt: createPublicArtifactInventoryReceipt({
      reservation: reservation(), pages: [], posts: [], programs: [], authors: [], settings: [{
        documentId: "public-homepage-banner", sourceVersion: 4,
        publishedSnapshot: { schemaVersion: 4, sourceVersion: 4, publishedAt, values },
      }],
    }) };
    expect(assertPublicArtifactBundle(bundle).settings).toEqual([setting]);
    for (const invalid of [
      { ...setting, link: undefined },
      { ...setting, secondLink: { label: "", href: "/live/" } },
      { ...setting, secondLink: { label: "Watch", href: "javascript:alert(1)" } },
      { ...setting, secondLink: { label: "Watch", href: "relative/path" } },
      { ...setting, secondLink: { label: "Watch", href: "/live/", unknown: true } },
    ]) expect(() => assertPublicArtifactBundle({ ...bundle, settings: [invalid] })).toThrow(/settings list is invalid/i);
  });
  it("reads an old Program bundle for a preview with current routes and defaults", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "old-program-bundle-"));
    directories.push(directory);
    const bundlePath = path.join(directory, "bundle.json");
    const publishedSnapshot = { blocks: [], metadata: { type: "program" }, sourceVersion: 4 };
    const bundle = { ...emptyBundle(), programs: [{ programId: "program-one", slug: "program-one",
      previousSlugs: [], path: "/programs/program-one/", sourceVersion: 4 }],
      receipt: createPublicArtifactInventoryReceipt({ reservation: reservation(), pages: [], posts: [],
        programs: [{ kind: "program", documentId: "program-one", sourceVersion: 4,
          canonicalPath: "/programs/program-one/", aliases: [], publishedSnapshot }],
        authors: [], settings: [] }) };
    const old = structuredClone(bundle);
    old.programs[0].path = "/shows/program-one/";
    const family = old.receipt.families.find(item => item.collection === "cmsPosts")!;
    family.artifacts[0].canonicalPath = "/shows/program-one/";
    old.receipt.aggregateRoutes = ["/posts/", "/staff/"];
    await writeFile(bundlePath, JSON.stringify(old));
    const read = await readPublicArtifactBundle(bundlePath);
    expect(normalizePublicArtifactBundle(structuredClone(old))).toEqual(read);
    expect(read.receipt.aggregateRoutes).toEqual(["/posts/", "/programs/", "/events/", "/staff/"]);
    expect(read.programs[0]).toMatchObject({ path: "/programs/program-one/", keyArt: null, keyArtAlt: "",
      keyArtDecorative: false, watchUrl: null });
    expect(read.receipt.families.find(item => item.collection === "cmsPosts")?.artifacts[0].canonicalPath)
      .toBe("/programs/program-one/");
  });

  it("accepts the bounded record card export and rejects extra fields", () => {
    const bundle = { ...emptyBundle(), recordCards: [
      { kind: "sponsor", id: "sponsor_1", title: "Station supporter", href: "https://example.org" },
    ] };
    expect(assertPublicArtifactBundle(bundle).recordCards).toEqual(bundle.recordCards);
    expect(() => assertPublicArtifactBundle({ ...bundle, recordCards: [{
      kind: "newsletter", id: "weekly", title: "Weekly", href: null,
      newsletter: { card: { title: "Weekly" } },
    }] })).toThrow(/record card/);
    expect(() => assertPublicArtifactBundle({ ...bundle, recordCards: [{
      kind: "sponsor", id: "sponsor_1", title: "Station supporter", href: "HTTPS://example.org/",
      sponsor: { sponsorId: "sponsor_1", name: "Station supporter", href: "HTTPS://example.org/",
        logoUrl: null, logoAlt: "", logoDecorative: false },
    }] })).not.toThrow();
    expect(() => assertPublicArtifactBundle({ ...bundle, recordCards: [
      { ...bundle.recordCards[0], privateNote: "do not publish" },
    ] })).toThrow(/record card/);
  });
  it("reads a pre-Event v3 bundle with an empty Event family", () => {
    const previous = { ...emptyBundle() };
    delete previous.events;
    expect(assertPublicArtifactBundle(previous).events ?? []).toEqual([]);
  });
  it("carries a minimal sponsor export without adding a public route", () => {
    const sponsor = { sponsorId: "s1", name: "Foundation", href: "https://example.org/", logoUrl: null, logoAlt: "", logoDecorative: false };
    expect(assertPublicArtifactBundle({ ...emptyBundle(), recordCards: [{ kind: "sponsor", id: "s1", title: "Foundation", href: sponsor.href, sponsor }] }).recordCards?.[0]).toMatchObject({ sponsor });
    expect(() => assertPublicArtifactBundle({ ...emptyBundle(), recordCards: [{ kind: "sponsor", id: "s1", title: "Foundation", href: sponsor.href, sponsor: { ...sponsor, privateNotes: "secret" } }] })).toThrow(/record card/i);
  });
  it("keeps library newsletters in the private build input without creating routes", () => {
    const bundle = { ...emptyBundle(), recordCards: [
      { kind: "newsletter", id: "weekly", title: "Weekly", href: null, newsletter: { card: { title: "Weekly", signupUrl: "https://example.org/join" } } },
    ] };
    expect(assertPublicArtifactBundle(bundle).recordCards).toEqual(bundle.recordCards);
    expect(() => assertPublicArtifactBundle({ ...bundle, recordCards: [
      { kind: "newsletter", id: "pending", title: "Pending", href: null, newsletter: { card: { title: "Pending" } } },
    ] })).toThrow(/record card/);
    expect(() => assertPublicArtifactBundle({ ...bundle, recordCards: [
      { kind: "newsletter", id: "weekly", title: "Weekly", href: null, newsletter: { card: { title: "Weekly", signupUrl: "http://example.org/join" } } },
    ] })).toThrow(/record card/);
  });

  it("preserves valid Home composition and refuses malformed or misplaced markers", () => {
    const publishedSnapshot = { blocks: homeCompositionDefaults(), metadata: { title: "Home", homeCompositionVersion: 1 }, sourceVersion: 7 };
    const bundle = {
      ...emptyBundle(),
      pages: [{ pageId: "home", path: "/", sourceVersion: 7, homeCompositionVersion: 1, blocks: publishedSnapshot.blocks }],
      receipt: createPublicArtifactInventoryReceipt({ reservation: reservation(), pages: [{ documentId: "home", sourceVersion: 7, publishedSnapshot }], posts: [], programs: [], authors: [], settings: [] }),
    };
    expect(assertPublicArtifactBundle(bundle).pages[0].homeCompositionVersion).toBe(1);
    for (const page of [
      { ...bundle.pages[0], homeCompositionVersion: "1" },
      { ...bundle.pages[0], pageId: "about", path: "/about/" },
      { ...bundle.pages[0], blocks: [] },
      { ...bundle.pages[0], blocks: [{ ...publishedSnapshot.blocks[0], visible: false }, ...publishedSnapshot.blocks.slice(1)] },
    ]) expect(() => assertPublicArtifactBundle({ ...bundle, pages: [page] })).toThrow(/Home|home-start/);
  });

  it("admits optional shelf presentation fields on a frozen Home bundle", () => {
    const blocks = homeCompositionDefaults().map(block => block.type === "content_shelf"
      ? { ...block, data: { ...block.data, presentation: "grid", columns: 3, itemLimit: 6 } }
      : block);
    const publishedSnapshot = { blocks, metadata: { title: "Home", homeCompositionVersion: 1 }, sourceVersion: 7 };
    const bundle = {
      ...emptyBundle(),
      pages: [{ pageId: "home", path: "/", sourceVersion: 7, homeCompositionVersion: 1, blocks }],
      receipt: createPublicArtifactInventoryReceipt({ reservation: reservation(),
        pages: [{ documentId: "home", sourceVersion: 7, publishedSnapshot }],
        posts: [], programs: [], authors: [], settings: [] }),
    };
    expect(assertPublicArtifactBundle(bundle).pages[0].blocks).toEqual(blocks);
    const invalid = structuredClone(blocks);
    const shelf = invalid.find(block => block.type === "content_shelf")!;
    Object.assign(shelf.data, { columns: 5 });
    expect(() => assertPublicArtifactBundle({ ...bundle, pages: [{ ...bundle.pages[0], blocks: invalid }] }))
      .toThrow(/Home composition blocks are invalid/);
  });

  it("binds Home sources to the validated bundle without exposing its private receipt", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "home-source-bundle-"));
    directories.push(directory);
    const bundlePath = path.join(directory, "bundle.json");
    await writePublicArtifactBundle(bundlePath, emptyBundle());
    const env = {
      PUBLIC_BUILD_BATCH_ID: "build-one",
      PUBLIC_BUILD_COMMIT_SHA: COMMIT_SHA,
      PUBLIC_ARTIFACT_BUNDLE_PATH: bundlePath,
      PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION: String(PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION),
    };
    const sources = await loadHomeSourceSnapshot(env);
    expect(sources.publication).toEqual({ buildBatchId: "build-one", generation: 1, commitSha: COMMIT_SHA });
    const { editorial, ...legacySources } = sources;
    expect(JSON.stringify(legacySources)).not.toMatch(/"(?:cutoffAt|owners|documentId|mediaManifestDigest)"\s*:/);
    expect(JSON.stringify(sources)).not.toMatch(/"(?:owners|documentId|mediaManifestDigest)"\s*:/);
    expect(editorial?.catalog.cutoffAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await expect(loadHomeSourceSnapshot({ ...env, PUBLIC_BUILD_BATCH_ID: "another-build" }))
      .rejects.toThrow("belongs to another build");
  });
  it("seeds approved Newsletter choices when a full-build bundle already carries retained Home sources", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "home-retained-newsletter-bundle-"));
    directories.push(directory);
    const bundlePath = path.join(directory, "bundle.json");
    const bundle = emptyBundle();
    await writePublicArtifactBundle(bundlePath, bundle);
    const env = { PUBLIC_BUILD_BATCH_ID: "build-one", PUBLIC_BUILD_COMMIT_SHA: COMMIT_SHA,
      PUBLIC_ARTIFACT_BUNDLE_PATH: bundlePath, PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION: String(PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION) };
    const retained = await loadHomeSourceSnapshot(env);
    const receipt = createPublicArtifactInventoryReceipt({ reservation: reservation(), pages: [], posts: [], programs: [],
      authors: [], settings: [], libraryCards: [{ documentId: "approved-choice", kind: "newsletter", sourceVersion: 2, assetIds: [] }] });
    await writePublicArtifactBundle(bundlePath, { ...bundle, receipt, homeSources: retained, recordCards: [{
      id: "approved-choice", kind: "newsletter", title: "Approved updates", href: null, sourceVersion: 2,
      newsletter: { card: { title: "Approved updates", signupUrl: "https://example.org/signup" } },
    }] });
    const current = await loadHomeSourceSnapshot(env);
    expect(current.pbs).toEqual(retained.pbs);
    expect(current.spotlight).toEqual(retained.spotlight);
    const pool = current.editorial!.catalog.services!.newsletters;
    expect(pool.status).toBe("ready");
    if (pool.status !== "ready") throw new Error("Expected approved Newsletter pool");
    expect(pool.records).toHaveLength(1);
    expect(pool.records[0]).toMatchObject({ id: "approved-choice", sourceVersion: 2 });
    expect(current.editorial!.receipt.digest).not.toBe(retained.editorial!.receipt.digest);
  });
  it("loads a valid large approved Newsletter library without exceeding the shared catalog byte limit", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "home-large-newsletter-bundle-"));
    directories.push(directory);
    const bundlePath = path.join(directory, "bundle.json");
    const env = { PUBLIC_BUILD_BATCH_ID: "build-one", PUBLIC_BUILD_COMMIT_SHA: COMMIT_SHA,
      PUBLIC_ARTIFACT_BUNDLE_PATH: bundlePath, PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION: String(PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION) };
    const bundle = emptyBundle();
    await writePublicArtifactBundle(bundlePath, bundle);
    const retained = await loadHomeSourceSnapshot(env);
    const recordCards = Array.from({ length: 200 }, (_, index) => ({ id: `long-${index}`, kind: "newsletter" as const,
      title: "T".repeat(300), href: null, sourceVersion: 2,
      newsletter: { card: { title: "T".repeat(300), summary: "S".repeat(300), signupUrl: "https://example.org/" + "a".repeat(1900) } } }));
    const receipt = createPublicArtifactInventoryReceipt({ reservation: reservation(), pages: [], posts: [], programs: [],
      authors: [], settings: [], libraryCards: recordCards.map(card => ({ documentId: card.id, kind: "newsletter", sourceVersion: 2, assetIds: [] })) });
    await writePublicArtifactBundle(bundlePath, { ...bundle, receipt, homeSources: retained, recordCards });
    const current = await loadHomeSourceSnapshot(env);
    expect(new TextEncoder().encode(JSON.stringify(current.editorial!.catalog)).byteLength).toBeLessThanOrEqual(400_000);
    const pool = current.editorial!.catalog.services!.newsletters;
    if (pool.status !== "ready") throw new Error("Expected bounded approved choices");
    expect(pool.records.length).toBeGreaterThan(0);
    expect(pool.records.length).toBeLessThan(200);
    expect(current.pbs).toEqual(retained.pbs);
    expect(current.spotlight).toEqual(retained.spotlight);
  });

  it("emits no homepage setting when no cutoff bundle is configured", async () => {
    const prior = { ...process.env };
    delete process.env.PUBLIC_BUILD_BATCH_ID;
    delete process.env.PUBLIC_ARTIFACT_BUNDLE_PATH;
    delete process.env.PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION;
    try {
      const entries: unknown[] = [];
      let clears = 0;
      const messages: string[] = [];
      await publicHomepageBannerLoader().load({
        store: {
          clear: () => { clears += 1; },
          set: (entry: unknown) => entries.push(entry),
        },
        logger: {
          info: (message: string) => messages.push(message),
          warn: () => {},
        },
        parseData: async ({ data }: { data: unknown }) => data,
      } as never);

      expect(clears).toBe(1);
      expect(entries).toEqual([]);
      expect(messages).toEqual([
        "public homepage banner loader: no public artifact bundle; skipping.",
      ]);
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in prior)) delete process.env[key];
      }
      Object.assign(process.env, prior);
    }
  });

  it("writes and reads only the v3 shape", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "njpbs-bundle-test-"));
    directories.push(directory);
    const bundlePath = path.join(directory, "bundle.json");
    const bundle = emptyBundle();

    await writePublicArtifactBundle(bundlePath, bundle);

    expect(await readPublicArtifactBundle(bundlePath)).toEqual(bundle);
    expect(resolvePublicArtifactBundlePath({
      PUBLIC_BUILD_BATCH_ID: "build-one",
      PUBLIC_ARTIFACT_BUNDLE_PATH: bundlePath,
      PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION: "3",
    })).toBe(bundlePath);
    expect(() => resolvePublicArtifactBundlePath({
      PUBLIC_BUILD_BATCH_ID: "build-one",
      PUBLIC_ARTIFACT_BUNDLE_PATH: bundlePath,
      PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION: "2",
    })).toThrow(/configuration is incomplete/i);
  });

  it("rejects projected routes that do not match the receipt", () => {
    const publishedSnapshot = {
      blocks: [],
      metadata: { type: "post" },
      sourceVersion: 3,
    };
    const bundle = {
      ...emptyBundle(),
      posts: [{
        postId: "post-one",
        sourceVersion: 3,
        path: "/posts/changed-after-receipt/",
        previousSlugs: [],
      }],
      receipt: createPublicArtifactInventoryReceipt({
        reservation: reservation(),
        pages: [],
        posts: [{
          kind: "post",
          documentId: "post-one",
          sourceVersion: 3,
          canonicalPath: "/posts/receipt-route/",
          aliases: [],
          publishedSnapshot,
        }],
        programs: [],
        authors: [],
        settings: [],
      }),
    };

    expect(() => assertPublicArtifactBundle(bundle)).toThrow(/coverage is invalid/);
  });

  it("lets every artifact loader consume an empty exact bundle without Firestore", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "njpbs-bundle-loader-"));
    directories.push(directory);
    const bundlePath = path.join(directory, "bundle.json");
    const outputPath = path.join(directory, "receipt.json");
    await writePublicArtifactBundle(bundlePath, emptyBundle());
    const prior = { ...process.env };
    Object.assign(process.env, {
      PUBLIC_BUILD_BATCH_ID: "build-one",
      PUBLIC_BUILD_COMMIT_SHA: COMMIT_SHA,
      PUBLIC_ARTIFACT_INVENTORY_PATH: outputPath,
      PUBLIC_ARTIFACT_BUNDLE_PATH: bundlePath,
      PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION: "3",
      CMS_CONTENT_MODE: "published",
      CMS_LOADER_STRICT: "1",
    });
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIRESTORE_EMULATOR_HOST;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    try {
      const entries: unknown[] = [];
      const context = {
        store: { clear: () => {}, set: (entry: unknown) => entries.push(entry) },
        logger: { info: () => {}, warn: () => {} },
        parseData: async ({ data }: { data: unknown }) => data,
      } as never;
      for (const loader of [
        cmsPagesLoader(),
        cmsPostsLoader(),
        cmsProgramsLoader(),
        cmsAuthorsLoader(),
        publicHomepageBannerLoader(),
        siteNavigationLoader(),
      ]) {
        await loader.load(context);
      }
      expect(entries).toEqual([]);
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in prior)) delete process.env[key];
      }
      Object.assign(process.env, prior);
    }
  });

  it("binds the fixed homepage setting to its exact receipt source version", () => {
    const publishedSnapshot = {
      schemaVersion: 1,
      values: { enabled: true, message: "A public update" },
      sourceVersion: 4,
      publishedAt: "2026-08-31T14:00:00.000Z",
    };
    const bundle = {
      ...emptyBundle(),
      settings: [{
        settingId: "public-homepage-banner",
        enabled: true,
        message: "A public update",
        sourceVersion: 4,
        publishedAt: "2026-08-31T14:00:00.000Z",
      }],
      receipt: createPublicArtifactInventoryReceipt({
        reservation: reservation(),
        pages: [],
        posts: [],
        programs: [],
        authors: [],
        settings: [{
          documentId: "public-homepage-banner",
          sourceVersion: 4,
          publishedSnapshot,
        }],
      }),
    };

    expect(assertPublicArtifactBundle(bundle)).toMatchObject({
      schemaVersion: 3,
      settings: [expect.objectContaining({ sourceVersion: 4 })],
    });
    expect(() => assertPublicArtifactBundle({
      ...bundle,
      settings: [{ ...bundle.settings[0], sourceVersion: 5 }],
    })).toThrow(/cmsSettings coverage is invalid/);
  });

  it("carries bounded page exclusions through the frozen artifact contract", () => {
    const values = { enabled: true, njDecides: true, message: "Vote", excludedPaths: ["/", "/posts/election-guide/"] };
    const publishedAt = "2026-10-29T12:00:00.000Z";
    const bundle = { ...emptyBundle(), settings: [{ settingId: "public-homepage-banner", ...values, sourceVersion: 4, publishedAt }],
      receipt: createPublicArtifactInventoryReceipt({ reservation: reservation(), pages: [], posts: [], programs: [], authors: [], settings: [{
        documentId: "public-homepage-banner", sourceVersion: 4, publishedSnapshot: { schemaVersion: 3, values, sourceVersion: 4, publishedAt },
      }] }) };
    expect(assertPublicArtifactBundle(bundle).settings).toEqual(bundle.settings);
    expect(() => assertPublicArtifactBundle({ ...bundle, settings: [{ ...bundle.settings[0], excludedPaths: ["/posts/*/"] }] })).toThrow(/settings list is invalid/i);
  });

  it("accepts a frozen scheduled election band, including an empty optional message", () => {
    const values = { enabled: true, njDecides: true, message: "", liveLabel: "Live",
      startsAt: "2026-11-03T23:00:00.000Z", endsAt: "2026-11-04T06:00:00.000Z" };
    const publishedAt = "2026-08-31T14:00:00.000Z";
    const bundle = { ...emptyBundle(), settings: [{ settingId: "public-homepage-banner", ...values,
      sourceVersion: 4, publishedAt }], receipt: createPublicArtifactInventoryReceipt({
      reservation: reservation(), pages: [], posts: [], programs: [], authors: [], settings: [{
        documentId: "public-homepage-banner", sourceVersion: 4, publishedSnapshot: {
          schemaVersion: 2, values, sourceVersion: 4, publishedAt,
        },
      }],
    }) };
    expect(assertPublicArtifactBundle(bundle).settings).toEqual(bundle.settings);
    expect(() => assertPublicArtifactBundle({ ...bundle, settings: [{ ...bundle.settings[0], endsAt: values.startsAt }] })).toThrow(/settings list is invalid/i);
  });

  it("rejects a tampered homepage setting through the shared settings contract", () => {
    const message = "a".repeat(241);
    const bundle = {
      ...emptyBundle(),
      settings: [{
        settingId: "public-homepage-banner",
        enabled: true,
        message,
        sourceVersion: 4,
        publishedAt: "2026-08-31T14:00:00.000Z",
      }],
      receipt: createPublicArtifactInventoryReceipt({
        reservation: reservation(),
        pages: [],
        posts: [],
        programs: [],
        authors: [],
        settings: [{
          documentId: "public-homepage-banner",
          sourceVersion: 4,
          publishedSnapshot: {
            schemaVersion: 1,
            values: { enabled: true, message: "Valid source message" },
            sourceVersion: 4,
            publishedAt: "2026-08-31T14:00:00.000Z",
          },
        }],
      }),
    };

    expect(() => assertPublicArtifactBundle(bundle)).toThrow(
      /settings list is invalid/i,
    );
  });

  function navigationBundle(postsBrowse?: import("../../packages/content-core/src/posts-browse").PostsBrowseConfig) {
    const values = JSON.parse(JSON.stringify(DEFAULT_SITE_NAVIGATION));
    if (postsBrowse) values.postsBrowse = postsBrowse;
    const bannerSnapshot = {
      schemaVersion: 1,
      values: { enabled: true, message: "A public update" },
      sourceVersion: 4,
      publishedAt: "2026-08-31T14:00:00.000Z",
    };
    const navigationSnapshot = {
      schemaVersion: postsBrowse ? 2 : 1,
      values,
      sourceVersion: 9,
      publishedAt: "2026-08-31T15:00:00.000Z",
    };
    return {
      ...emptyBundle(),
      settings: [
        {
          settingId: "public-homepage-banner",
          enabled: true,
          message: "A public update",
          sourceVersion: 4,
          publishedAt: "2026-08-31T14:00:00.000Z",
        },
        {
          settingId: "site-navigation",
          ...(postsBrowse ? { postsBrowse } : {}),
          header: values.header,
          footer: values.footer,
          sourceVersion: 9,
          publishedAt: "2026-08-31T15:00:00.000Z",
        },
      ],
      receipt: createPublicArtifactInventoryReceipt({
        reservation: reservation(),
        pages: [],
        posts: [],
        programs: [],
        authors: [],
        settings: [
          { documentId: "site-navigation", sourceVersion: 9, publishedSnapshot: navigationSnapshot },
          { documentId: "public-homepage-banner", sourceVersion: 4, publishedSnapshot: bannerSnapshot },
        ],
      }),
    };
  }

  it("retains an explicitly empty published Posts arrangement through the frozen bundle", () => {
    const accepted = assertPublicArtifactBundle(navigationBundle({ groups: [] }));
    expect(accepted.settings.find(s => s.settingId === "site-navigation")).toHaveProperty("postsBrowse", { groups: [] });
  });

  it("carries the published site navigation beside the banner and binds its version", () => {
    const bundle = navigationBundle();
    expect(bundle.receipt.families.find(({ collection }) => collection === "cmsSettings")
      ?.artifacts.map(({ documentId }) => documentId)).toEqual([
      "public-homepage-banner",
      "site-navigation",
    ]);
    expect(assertPublicArtifactBundle(bundle).settings).toHaveLength(2);
    expect(() => assertPublicArtifactBundle({
      ...bundle,
      settings: [bundle.settings[0], { ...bundle.settings[1], sourceVersion: 8 }],
    })).toThrow(/cmsSettings coverage is invalid/);
    expect(() => assertPublicArtifactBundle({
      ...bundle,
      settings: [bundle.settings[0], bundle.settings[0]],
    })).toThrow(/settings list is invalid/);
  });

  it("rejects a tampered navigation entry through the shared settings contract", () => {
    const bundle = navigationBundle();
    const navigation = bundle.settings[1] as Record<string, unknown>;
    const header = [...(navigation.header as unknown[])];
    header[0] = {
      id: "bad",
      label: "Bad",
      target: { type: "href", href: "javascript:alert(1)" },
      external: false,
    };
    expect(() => assertPublicArtifactBundle({
      ...bundle,
      settings: [bundle.settings[0], { ...navigation, header }],
    })).toThrow(/settings list is invalid/);
    expect(() => assertPublicArtifactBundle({
      ...bundle,
      settings: [bundle.settings[0], { ...navigation, extra: true }],
    })).toThrow(/settings list is invalid/);
  });

  it("accepts a seed fallback only when the receipt names that exact version", () => {
    const withFallback = {
      ...emptyBundle(),
      receipt: createPublicArtifactInventoryReceipt({
        reservation: reservation(),
        pages: [],
        posts: [],
        programs: [],
        authors: [],
        settings: [],
        settingsFallbacks: [{ documentId: "site-navigation", sourceVersion: 8 }],
      }),
    };
    expect(withFallback.receipt.settingsFallbacks).toEqual([
      { documentId: "site-navigation", sourceVersion: 8 },
    ]);
    expect(assertPublicArtifactBundle(withFallback).settings).toEqual([]);

    const { settingsFallbacks: _dropped, ...withoutFallback } = withFallback.receipt;
    expect(() => assertPublicArtifactBundle({
      ...withFallback,
      receipt: withoutFallback,
    })).toThrow(/cmsSettings coverage is incomplete/);
    expect(() => createPublicArtifactInventoryReceipt({
      reservation: reservation(),
      pages: [],
      posts: [],
      programs: [],
      authors: [],
      settings: [],
      settingsFallbacks: [{ documentId: "public-homepage-banner" as never, sourceVersion: 8 }],
    })).toThrow();
  });

  it("loads only the navigation entry into the navigation collection", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "njpbs-bundle-navigation-"));
    directories.push(directory);
    const bundlePath = path.join(directory, "bundle.json");
    await writePublicArtifactBundle(bundlePath, navigationBundle() as PublicArtifactBundle);
    const prior = { ...process.env };
    Object.assign(process.env, {
      PUBLIC_BUILD_BATCH_ID: "build-one",
      PUBLIC_BUILD_COMMIT_SHA: COMMIT_SHA,
      PUBLIC_ARTIFACT_INVENTORY_PATH: path.join(directory, "receipt.json"),
      PUBLIC_ARTIFACT_BUNDLE_PATH: bundlePath,
      PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION: "3",
      CMS_CONTENT_MODE: "published",
      CMS_LOADER_STRICT: "1",
    });
    try {
      const load = async (loader: { load: (context: never) => Promise<void> }) => {
        const entries: Array<{ id: string; data: Record<string, unknown> }> = [];
        await loader.load({
          store: { clear: () => {}, set: (entry: never) => entries.push(entry) },
          logger: { info: () => {}, warn: () => {} },
          parseData: async ({ data }: { data: unknown }) => data,
        } as never);
        return entries;
      };
      const navigation = await load(siteNavigationLoader(null));
      expect(navigation.map(({ id, data }) => [id, data.settingId, data.sourceVersion])).toEqual([
        ["site-navigation", "site-navigation", 9],
      ]);
      const banners = await load(publicHomepageBannerLoader(null));
      expect(banners.map(({ id }) => id)).toEqual(["public-homepage-banner"]);
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in prior)) delete process.env[key];
      }
      Object.assign(process.env, prior);
    }
  });
});
