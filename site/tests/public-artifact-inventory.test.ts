import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PUBLIC_PAGES } from "../../packages/content-core/src/public-pages";
import {
  assertFreshPublicArtifactCutoff,
  assertPublicArtifactInventoryReceipt,
  createPublicArtifactInventoryReceipt,
  finalizePublicArtifactInventoryReceipt,
  type PublicArtifactInventoryReceipt,
} from "../src/lib/public-artifact-inventory";

const COMMIT_SHA = "a".repeat(40);
const CUTOFF_MILLIS = Date.parse("2026-08-14T20:00:00.000Z");
const temporaryDirectories: string[] = [];

function timestamp(millis = CUTOFF_MILLIS) {
  return {
    seconds: Math.floor(millis / 1_000),
    nanoseconds: (millis % 1_000) * 1_000_000,
    toMillis: () => millis,
  };
}

function reservation(millis = CUTOFF_MILLIS) {
  const cutoffAt = timestamp(millis);
  return {
    schemaVersion: 1,
    buildBatchId: "build-one",
    generation: 8,
    status: "reserved",
    commitSha: COMMIT_SHA,
    reservedAgainstGeneration: 7,
    reservedAgainstDeploymentId: "deployment-seven",
    reservedAgainstCommitSha: "b".repeat(40),
    cutoffAt,
    reservedAt: cutoffAt,
  };
}

function pages() {
  return PUBLIC_PAGES.map((definition, index) => {
    const sourceVersion = index + 1;
    const blocks = definition.id === "home"
      ? [{
          id: "hero-image",
          type: "image",
          order: 0,
          visible: true,
          data: { assetId: "launch-home", alt: "NJ PBS" },
        }]
      : [];
    return {
      documentId: definition.id,
      sourceVersion,
      publishedSnapshot: {
        blocks,
        metadata: { title: definition.title },
        publishedAt: "2026-08-14T19:00:00.000Z",
        publishedBy: "editor-one",
        sourceVersion,
      },
    };
  });
}

function receipt(): PublicArtifactInventoryReceipt {
  return createPublicArtifactInventoryReceipt({
    reservation: reservation(),
    pages: pages(),
    // Named explicitly, never defaulted: an absent list now fails closed rather
    // than declaring a routed family complete and empty.
    posts: [],
    programs: [],
    authors: [],
    settings: [],
  });
}

function mutableReceipt() {
  return structuredClone(receipt()) as unknown as Record<string, unknown>;
}

function family(
  value: Record<string, unknown>,
  collection: "cmsPages" | "cmsPosts" | "cmsSettings",
) {
  return (value.families as Array<Record<string, unknown>>)
    .find((candidate) => candidate.collection === collection)!;
}

function owner(value: Record<string, unknown>, documentId: string) {
  return (value.owners as Array<Record<string, unknown>>)
    .find((candidate) => candidate.documentId === documentId)!;
}

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "njpbs-artifact-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function emitBuiltPaths(
  distDirectory: string,
  value: PublicArtifactInventoryReceipt,
) {
  for (const page of PUBLIC_PAGES) {
    for (const route of [page.path, ...("aliases" in page ? page.aliases : [])]) {
      const target = path.join(distDirectory, route.slice(1), "index.html");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "<!doctype html>\n", "utf8");
    }
  }
  for (const familyEntry of value.families) {
    for (const artifact of familyEntry.artifacts) {
      for (const route of [artifact.canonicalPath, ...artifact.aliases]) {
        if (route === null) continue;
        const relative = route === "/"
          ? "index.html"
          : `${route.slice(1)}index.html`;
        const target = path.join(distDirectory, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, "<!doctype html>\n", "utf8");
      }
    }
  }
  for (const route of value.aggregateRoutes) {
    const target = path.join(distDirectory, `${route.slice(1)}index.html`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "<!doctype html>\n", "utf8");
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("the routed families are stated, not assumed", () => {
  it("refuses to claim completeness when a routed list was not supplied", () => {
    // A default of [] cannot tell "nothing was emitted" apart from "nobody
    // asked". An explicit empty array proves the cutoff read found no admitted
    // route. A silent default could vouch for routes the caller never supplied
    // and drop their media owners from the deployment manifest.
    const base = { reservation: reservation(), pages: pages() };
    expect(() =>
      createPublicArtifactInventoryReceipt({ ...base, programs: [], authors: [], settings: [] } as never),
    ).toThrow(/emitted posts, programs, author pages, and settings/);
    expect(() =>
      createPublicArtifactInventoryReceipt({ ...base, posts: [], authors: [], settings: [] } as never),
    ).toThrow(/emitted posts, programs, author pages, and settings/);
    expect(() =>
      createPublicArtifactInventoryReceipt({
        ...base,
        posts: [],
        programs: [],
        authors: [],
      } as never),
    ).toThrow(/emitted posts, programs, author pages, and settings/);
  });

  it("accepts explicit empty routed families", () => {
    expect(() =>
      createPublicArtifactInventoryReceipt({
        reservation: reservation(),
        pages: pages(),
        posts: [],
        programs: [],
        authors: [],
        settings: [],
      }),
    ).not.toThrow();
  });
});

describe("public artifact inventory receipt", () => {
  it("binds the fixed homepage setting to the root route with a zero-media owner", () => {
    const value = createPublicArtifactInventoryReceipt({
      reservation: reservation(),
      pages: pages().filter(({ documentId }) => documentId === "home"),
      posts: [],
      programs: [],
      authors: [],
      settings: [{
        documentId: "public-homepage-banner",
        sourceVersion: 9,
        publishedSnapshot: {
          schemaVersion: 1,
          values: { enabled: true, message: "A public update" },
          sourceVersion: 9,
          publishedAt: "2026-08-31T14:00:00.000Z",
        },
      }],
    });

    expect(value.families.find(({ collection }) => collection === "cmsSettings"))
      .toEqual({
        collection: "cmsSettings",
        complete: true,
        artifacts: [{
          documentId: "public-homepage-banner",
          sourceVersion: 9,
          canonicalPath: "/",
          aliases: [],
        }],
      });
    expect(value.owners.find(({ collection }) => collection === "cmsSettings"))
      .toEqual({
        collection: "cmsSettings",
        documentId: "public-homepage-banner",
        sourceVersion: 9,
        assetIds: [],
        occurrenceCount: 0,
      });
    expect(assertPublicArtifactInventoryReceipt(value, reservation())).toEqual(value);
  });

  it("records a site navigation seed fallback only against its exact settings artifact", () => {
    const value = createPublicArtifactInventoryReceipt({
      reservation: reservation(),
      pages: pages().filter(({ documentId }) => documentId === "home"),
      posts: [],
      programs: [],
      authors: [],
      settings: [],
      settingsFallbacks: [{ documentId: "site-navigation", sourceVersion: 3 }],
    });
    expect(value.families.find(({ collection }) => collection === "cmsSettings")?.artifacts)
      .toEqual([{ documentId: "site-navigation", sourceVersion: 3, canonicalPath: "/", aliases: [] }]);
    expect(value.settingsFallbacks).toEqual([{ documentId: "site-navigation", sourceVersion: 3 }]);
    expect(assertPublicArtifactInventoryReceipt(value, reservation())).toEqual(value);

    for (const settingsFallbacks of [
      [],
      [{ documentId: "site-navigation", sourceVersion: 4 }],
      [{ documentId: "public-homepage-banner", sourceVersion: 3 }],
      [{ documentId: "site-navigation", sourceVersion: 3, reason: "invalid" }],
    ]) {
      expect(() => assertPublicArtifactInventoryReceipt(
        { ...value, settingsFallbacks },
        reservation(),
      )).toThrow();
    }
    // A receipt without the optional field keeps its exact prior shape.
    const plain = createPublicArtifactInventoryReceipt({
      reservation: reservation(),
      pages: pages().filter(({ documentId }) => documentId === "home"),
      posts: [],
      programs: [],
      authors: [],
      settings: [],
    });
    expect(Object.hasOwn(plain, "settingsFallbacks")).toBe(false);
  });

  it("binds Post, Program, and author routes to their immutable source versions", () => {
    const post = {
      kind: "post" as const,
      documentId: "post-one",
      sourceVersion: 4,
      canonicalPath: "/posts/current-post/",
      aliases: ["/posts/old-post/"],
      publishedSnapshot: {
        blocks: [],
        metadata: { type: "post" },
        sourceVersion: 4,
      },
    };
    const program = {
      kind: "program" as const,
      documentId: "program-one",
      sourceVersion: 5,
      canonicalPath: "/programs/current-show/",
      aliases: ["/programs/old-show/"],
      publishedSnapshot: {
        blocks: [],
        metadata: { type: "program" },
        sourceVersion: 5,
      },
    };
    const author = {
      documentId: "au_11111111111111111111111111111111",
      sourceVersion: 6,
      canonicalPath: "/authors/current-author/",
      aliases: ["/authors/old-author/"],
      publishedSnapshot: { snapshotVersion: 6, photo: null },
    };
    const value = createPublicArtifactInventoryReceipt({
      reservation: reservation(),
      pages: [],
      posts: [post],
      programs: [program],
      authors: [author],
      settings: [],
    });

    expect(value.families.find(({ collection }) => collection === "cmsPosts")?.artifacts)
      .toMatchObject([
        { documentId: "post-one", canonicalPath: "/posts/current-post/" },
        { documentId: "program-one", canonicalPath: "/programs/current-show/" },
      ]);
    expect(() => createPublicArtifactInventoryReceipt({
      reservation: reservation(),
      pages: [],
      posts: [{ ...post, sourceVersion: 7 }],
      programs: [program],
      authors: [author],
      settings: [],
    })).toThrow(/invalid/i);
    expect(() => createPublicArtifactInventoryReceipt({
      reservation: reservation(),
      pages: [],
      posts: [post],
      programs: [program],
      authors: [{ ...author, sourceVersion: 7 }],
      settings: [],
    })).toThrow(/invalid/i);
    expect(() => createPublicArtifactInventoryReceipt({
      reservation: reservation(),
      pages: [],
      posts: [{ ...post, canonicalPath: "/programs/current-post/" }],
      programs: [program],
      authors: [author],
      settings: [],
    })).toThrow(/invalid/i);
  });

  it("binds all canonical page artifacts and media owners to one reservation", () => {
    const value = receipt();
    const pageFamily = value.families[0];

    expect(value).toMatchObject({
      schemaVersion: 2,
      mediaManifestSchemaVersion: 1,
      aggregateRoutes: ["/posts/", "/programs/", "/events/", "/staff/"],
      digestAlgorithm: "sha256",
      buildBatchId: "build-one",
      generation: 8,
      commitSha: COMMIT_SHA,
      cutoffAt: {
        seconds: Math.floor(CUTOFF_MILLIS / 1_000),
        nanoseconds: 0,
      },
      ownerCount: PUBLIC_PAGES.length,
    });
    expect(value.families.map(({ collection, complete, artifacts }) => ({
      collection,
      complete,
      count: artifacts.length,
    }))).toEqual([
      { collection: "cmsPages", complete: true, count: 19 },
      { collection: "cmsPosts", complete: true, count: 0 },
      { collection: "cmsSettings", complete: true, count: 0 },
      { collection: "cmsAuthorProfilesPublic", complete: true, count: 0 },
    ]);
    expect(pageFamily.artifacts.map(({ documentId }) => documentId))
      .toEqual([...PUBLIC_PAGES.map(({ id }) => id)].sort());
    expect(pageFamily.artifacts.find(({ documentId }) => documentId === "give"))
      .toMatchObject({
        canonicalPath: "/give/",
        aliases: ["/donate/"],
      });
    expect(value.owners).toHaveLength(19);
    expect(value.owners.find(({ documentId }) => documentId === "home"))
      .toMatchObject({
        collection: "cmsPages",
        sourceVersion: 1,
        assetIds: ["launch-home"],
        occurrenceCount: 1,
      });
    expect(value.owners.find(({ documentId }) => documentId === "watch"))
      .toMatchObject({ assetIds: [], occurrenceCount: 0 });
    expect(value.mediaManifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(assertPublicArtifactInventoryReceipt(value, reservation()))
      .toEqual(value);
  });

  it("accepts a complete read with only the CMS pages admitted at the cutoff", () => {
    const admitted = pages().filter(({ documentId }) => documentId === "watch");
    const value = createPublicArtifactInventoryReceipt({
      reservation: reservation(),
      pages: admitted,
      posts: [],
      programs: [],
      authors: [],
      settings: [],
    });

    expect(value.families[0].artifacts).toEqual([
      expect.objectContaining({ documentId: "watch" }),
    ]);
    expect(value.owners).toEqual([
      expect.objectContaining({
        collection: "cmsPages",
        documentId: "watch",
      }),
    ]);
    expect(assertPublicArtifactInventoryReceipt(value, reservation())).toEqual(value);
  });

  it.each([
    ["top-level", (value: Record<string, unknown>) => {
      value.futureField = true;
    }],
    ["family", (value: Record<string, unknown>) => {
      family(value, "cmsPages").futureField = true;
    }],
    ["artifact", (value: Record<string, unknown>) => {
      const artifacts = family(value, "cmsPages").artifacts as Array<Record<string, unknown>>;
      artifacts[0].futureField = true;
    }],
    ["owner", (value: Record<string, unknown>) => {
      owner(value, "home").futureField = true;
    }],
  ])("rejects an unknown %s field", (_label, mutate) => {
    const value = mutableReceipt();
    mutate(value);

    expect(() => assertPublicArtifactInventoryReceipt(value, reservation()))
      .toThrow(/artifact inventory receipt is invalid/i);
  });

  it.each([
    ["duplicate artifact", (value: Record<string, unknown>) => {
      const artifacts = family(value, "cmsPages").artifacts as unknown[];
      artifacts.push(structuredClone(artifacts[0]));
    }],
    ["duplicate owner", (value: Record<string, unknown>) => {
      const owners = value.owners as unknown[];
      owners.push(structuredClone(owners[0]));
      value.ownerCount = owners.length;
    }],
    ["missing artifact", (value: Record<string, unknown>) => {
      const artifacts = family(value, "cmsPages").artifacts as unknown[];
      artifacts.pop();
    }],
    ["artifact without owner", (value: Record<string, unknown>) => {
      value.owners = (value.owners as Array<Record<string, unknown>>)
        .filter((candidate) => candidate.documentId !== "watch");
      value.ownerCount = (value.owners as unknown[]).length;
    }],
    ["owner without artifact", (value: Record<string, unknown>) => {
      const pageFamily = family(value, "cmsPages");
      pageFamily.artifacts = (pageFamily.artifacts as Array<Record<string, unknown>>)
        .filter((candidate) => candidate.documentId !== "watch");
    }],
    ["partial families", (value: Record<string, unknown>) => {
      value.families = (value.families as unknown[]).slice(0, 2);
    }],
    ["incomplete family", (value: Record<string, unknown>) => {
      family(value, "cmsPosts").complete = false;
    }],
  ])("rejects %s", (_label, mutate) => {
    const value = mutableReceipt();
    mutate(value);

    expect(() => assertPublicArtifactInventoryReceipt(value, reservation()))
      .toThrow(/artifact inventory receipt is invalid/i);
  });

  it("rejects missing and mismatched source versions", () => {
    const missing = mutableReceipt();
    delete owner(missing, "watch").sourceVersion;
    expect(() => assertPublicArtifactInventoryReceipt(missing, reservation()))
      .toThrow(/artifact inventory receipt is invalid/i);

    const mismatch = mutableReceipt();
    owner(mismatch, "watch").sourceVersion = 99;
    expect(() => assertPublicArtifactInventoryReceipt(mismatch, reservation()))
      .toThrow(/artifact inventory receipt is invalid/i);

    const artifactMissing = mutableReceipt();
    const artifacts = family(artifactMissing, "cmsPages").artifacts as Array<
      Record<string, unknown>
    >;
    delete artifacts[0].sourceVersion;
    expect(() => assertPublicArtifactInventoryReceipt(
      artifactMissing,
      reservation(),
    )).toThrow(/artifact inventory receipt is invalid/i);

    const artifactMismatch = mutableReceipt();
    const watchArtifact = (family(
      artifactMismatch,
      "cmsPages",
    ).artifacts as Array<Record<string, unknown>>)
      .find((artifact) => artifact.documentId === "watch")!;
    watchArtifact.sourceVersion = 99;
    expect(() => assertPublicArtifactInventoryReceipt(
      artifactMismatch,
      reservation(),
    )).toThrow(/artifact inventory receipt is invalid/i);
  });

  it.each(["../outside/", "/../outside/", "/safe/%2e%2e/outside/"])(
    "rejects the unsafe built path %s",
    (unsafePath) => {
      const value = mutableReceipt();
      const artifacts = family(value, "cmsPages").artifacts as Array<Record<string, unknown>>;
      artifacts[0].canonicalPath = unsafePath;

      expect(() => assertPublicArtifactInventoryReceipt(value, reservation()))
        .toThrow(/artifact inventory receipt is invalid/i);
    },
  );

  it("rejects a cutoff older than Firestore's 60-second read window", () => {
    expect(() => assertFreshPublicArtifactCutoff(
      reservation(),
      new Date(CUTOFF_MILLIS + 60_001),
    )).toThrow(/cutoff is stale/i);
    const exactBoundary = reservation();
    expect(assertFreshPublicArtifactCutoff(
      exactBoundary,
      new Date(CUTOFF_MILLIS + 60_000),
    )).toBe(exactBoundary);
    expect(() => assertFreshPublicArtifactCutoff(
      reservation(),
      new Date(CUTOFF_MILLIS - 1),
    )).toThrow(/cutoff is in the future/i);
  });

  it("writes no receipt until every canonical and alias output exists", async () => {
    const directory = await temporaryDirectory();
    const distDirectory = path.join(directory, "dist");
    const outputPath = path.join(directory, "public-artifact-inventory.json");
    const value = receipt();
    await emitBuiltPaths(distDirectory, value);
    await rm(path.join(distDirectory, "donate", "index.html"));

    await expect(finalizePublicArtifactInventoryReceipt({
      receipt: value,
      distDirectory,
      outputPath,
    })).rejects.toThrow(/built path.*donate/i);
    await expect(readFile(outputPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    await mkdir(path.join(distDirectory, "donate"), { recursive: true });
    await writeFile(
      path.join(distDirectory, "donate", "index.html"),
      "<!doctype html>\n",
      "utf8",
    );
    await finalizePublicArtifactInventoryReceipt({
      receipt: value,
      distDirectory,
      outputPath,
    });

    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(value);
  });

  it("requires the staff aggregate output", async () => {
    const directory = await temporaryDirectory();
    const distDirectory = path.join(directory, "dist");
    const outputPath = path.join(directory, "public-artifact-inventory.json");
    const value = receipt();
    await emitBuiltPaths(distDirectory, value);
    await rm(path.join(distDirectory, "staff", "index.html"));

    await expect(finalizePublicArtifactInventoryReceipt({
      receipt: value,
      distDirectory,
      outputPath,
    })).rejects.toThrow(/built path.*staff/i);
  });

  it("publishes only the emitted version projection, including built-in pages", async () => {
    const directory = await temporaryDirectory();
    const distDirectory = path.join(directory, "dist");
    const value = createPublicArtifactInventoryReceipt({
      reservation: reservation(),
      pages: pages().filter((page) => page.documentId === "home"),
      posts: [], programs: [], authors: [], settings: [],
    });
    await emitBuiltPaths(distDirectory, value);
    await finalizePublicArtifactInventoryReceipt({
      receipt: value, distDirectory, outputPath: path.join(directory, "private.json"),
    });
    const bytes = await readFile(path.join(distDirectory, "_content-status.json"), "utf8");
    const status = JSON.parse(bytes);
    expect(status).toEqual({
      schemaVersion: 1, buildBatchId: value.buildBatchId,
      collections: ["cmsPages", "cmsPosts"],
      generation: value.generation, commitSha: value.commitSha,
      routes: expect.any(Array),
    });
    expect(status.routes).toHaveLength(PUBLIC_PAGES.length);
    expect(status.routes).toContainEqual({
      path: "/", source: "cms", sourceVersion: 1,
      contentKey: createHash("sha256").update("cmsPages/home").digest("hex"),
    });
    expect(status.routes).toContainEqual({ path: "/contact/", source: "site" });
    expect(bytes).not.toMatch(/documentId|publishedBy|assetIds|cutoffAt|owners/);

    await rm(path.join(distDirectory, "donate", "index.html"));
    await expect(finalizePublicArtifactInventoryReceipt({
      receipt: value, distDirectory, outputPath: path.join(directory, "private.json"),
    })).rejects.toThrow(/built path.*donate/i);
    await writeFile(path.join(distDirectory, "donate", "index.html"), "<!doctype html>\n");
    await rm(path.join(distDirectory, "contact", "index.html"));
    await expect(finalizePublicArtifactInventoryReceipt({
      receipt: value, distDirectory, outputPath: path.join(directory, "private.json"),
    })).rejects.toThrow(/built path.*contact/i);
  });

  it("keeps library card art in the private media manifest without claiming a route", async () => {
    const directory = await temporaryDirectory();
    const distDirectory = path.join(directory, "dist");
    const value = createPublicArtifactInventoryReceipt({
      reservation: reservation(), pages: pages(), posts: [], programs: [], authors: [], settings: [],
      libraryCards: [{ documentId: "newsletter-one", kind: "newsletter", sourceVersion: 3, assetIds: ["newsletter-art"] }],
    });
    expect(value.owners).toContainEqual(expect.objectContaining({
      collection: "cmsPosts", documentId: "newsletter-one", sourceVersion: 3,
      assetIds: ["newsletter-art"], occurrenceCount: 1,
    }));
    expect(assertPublicArtifactInventoryReceipt(value)).toEqual(value);
    await emitBuiltPaths(distDirectory, value);
    await finalizePublicArtifactInventoryReceipt({
      receipt: value, distDirectory, outputPath: path.join(directory, "private.json"),
    });
    const status = JSON.parse(await readFile(path.join(distDirectory, "_content-status.json"), "utf8"));
    expect(status.routes).not.toContainEqual(expect.objectContaining({ path: null }));
    expect(status.routes).toHaveLength(PUBLIC_PAGES.length);
  });

  it("refuses to place the receipt inside the deployed artifact", async () => {
    const directory = await temporaryDirectory();
    const distDirectory = path.join(directory, "dist");
    const value = receipt();
    await emitBuiltPaths(distDirectory, value);

    await expect(finalizePublicArtifactInventoryReceipt({
      receipt: value,
      distDirectory,
      outputPath: path.join(distDirectory, "public-artifact-inventory.json"),
    })).rejects.toThrow(/outside site\/dist/i);
  });
});

it("marks only released canonical Posts selected for joined-card context", async () => {
  const directory = await temporaryDirectory();
  const distDirectory = path.join(directory, "dist");
  const post = (id: string) => ({ kind: "post" as const, documentId: id, sourceVersion: 4,
    canonicalPath: `/posts/${id}/`, aliases: [`/posts/old-${id}/`],
    publishedSnapshot: { metadata: { type: "post" }, blocks: [], sourceVersion: 4 } });
  const value = createPublicArtifactInventoryReceipt({ reservation: reservation(), pages: [],
    posts: [post("with-joins"), post("without-joins")], programs: [], authors: [], settings: [] });
  await emitBuiltPaths(distDirectory, value);
  const outputPath = path.join(directory, "inventory.json");
  await finalizePublicArtifactInventoryReceipt({ receipt: value, distDirectory, outputPath,
    recordContextPostPaths: ["/posts/with-joins/"] });
  const status = JSON.parse(await readFile(path.join(distDirectory, "_content-status.json"), "utf8"));
  expect(status.routes.filter((route: { recordContext?: boolean }) => route.recordContext).map((route: { path: string }) => route.path))
    .toEqual(["/posts/with-joins/"]);
  for (const recordContextPostPaths of [["/posts/unknown/"], ["/posts/old-with-joins/"], ["/programs/with-joins/"],
    ["/posts/with-joins/", "/posts/with-joins/"]]) {
    await expect(finalizePublicArtifactInventoryReceipt({ receipt: value, distDirectory, outputPath, recordContextPostPaths })).rejects.toThrow("catalog");
  }
});

it("admits 1,001 joined-card hints and drops an overflowing hint catalog", async () => {
  const directory = await temporaryDirectory();
  const distDirectory = path.join(directory, "dist");
  const posts = Array.from({ length: 1001 }, (_, index) => ({ kind: "post" as const, documentId: `post-${index}`,
    sourceVersion: 4, canonicalPath: `/posts/post-${index}/`, aliases: [],
    publishedSnapshot: { metadata: { type: "post" }, blocks: [], sourceVersion: 4 } }));
  const value = createPublicArtifactInventoryReceipt({ reservation: reservation(), pages: [], posts, programs: [], authors: [], settings: [] });
  await emitBuiltPaths(distDirectory, value);
  const outputPath = path.join(directory, "inventory.json");
  await finalizePublicArtifactInventoryReceipt({ receipt: value, distDirectory, outputPath,
    recordContextPostPaths: posts.map(post => post.canonicalPath) });
  const status = () => readFile(path.join(distDirectory, "_content-status.json"), "utf8").then(JSON.parse);
  expect((await status()).routes.filter((route: { recordContext?: boolean }) => route.recordContext)).toHaveLength(1001);
  await finalizePublicArtifactInventoryReceipt({ receipt: value, distDirectory, outputPath,
    recordContextPostPaths: Array(10_001).fill("/posts/post-0/") });
  expect((await status()).routes.some((route: { recordContext?: boolean }) => route.recordContext)).toBe(false);
});
