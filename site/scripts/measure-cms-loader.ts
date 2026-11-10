// Phase timing harness for the CMS pages loader.
// A projection-level digest is computed after `projectCmsPage`, so it cannot
// skip the Firestore read, block parsing, section validation or asset resolution.
// It can skip Astro schema validation (`parseData`) and content-store writes.
// Time five phases separately to measure that skippable pair.
//
// Method notes, so the numbers can be read honestly:
//   * Firestore itself is not measured. The harness substitutes an in-memory
//     database with the same shape so the CPU phases are isolated from network
//     latency; real Firestore read time is additive and is not skippable by any
//     digest, so excluding it only makes the skippable share look LARGER than it
//     is in a real build. That is the conservative direction for this decision.
//   * `parseData` mirrors what Astro does at this boundary: it runs the
//     `cmsPages` collection schema through `safeParseAsync`. The schema below is
//     kept identical to the one in `src/content.config.ts`; that file cannot be
//     imported outside a build because it depends on the `astro:content` virtual
//     module.
//   * The store phase drives Astro's real `MutableDataStore` scoped store, not a
//     stand-in Map. That matters more than it sounds: the real `set` deep-walks
//     the whole entry with neotraverse looking for image imports. A Map insert
//     would omit that work and would not measure the content-store phase.
//   * The realistic content set is the 18 canonical public pages with their
//     committed compositions. That is not a sample of a larger corpus: the
//     loader reads `PUBLIC_PAGE_IDS`, so 18 is the ceiling, not the current
//     size. `--inflate=N` additionally repeats each rich text document's nodes N
//     times as a sensitivity check on much heavier pages; it is explicitly
//     synthetic and is labeled as such in the output.
//   * Every phase is timed per run, and the net effect of a digest is the median
//     of per-run paired differences rather than a subtraction of independently
//     taken medians, so the reported net is a value some single run actually
//     produced.
//
// Usage:
//   npx tsx scripts/measure-cms-loader.ts [--runs=N] [--inflate=N] [--json]

import type { HomeHeroConfig } from "../../packages/content-core/src/home-hero.ts";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "astro/zod";
import {
  projectCmsPage,
  readCmsContentFromDatabase,
  type CmsPageBuildData,
  type CmsPageDoc,
  type CmsPublicAsset,
} from "../src/lib/cms-loader";
import {
  pageCompositionSeed,
  pageSeedAsset,
  pageSeedAssetIds,
} from "../../packages/content-core/src/page-composition-seeds";
import { PUBLIC_PAGE_IDS } from "../../packages/content-core/src/public-pages";
import type { PageBlock } from "../../packages/content-core/src/content-model";
import { isDatasetFigures, type DatasetFigures } from "../../packages/content-core/src/dataset-figures";

const BUILD_NOW = new Date("2026-08-22T12:00:00.000Z");
const PUBLISHED_AT = "2026-08-01T12:00:00.000Z";

// The loader writes into the scoped store Astro hands it, whose real `set` does
// considerably more than a Map insert. `MutableDataStore` is not in Astro's
// package exports, so it is loaded by absolute path from the resolved package
// root. That is deliberate rather than convenient: measuring a stand-in would
// understate exactly the phase this measurement is deciding about. If a future
// Astro release moves the file, this throws instead of silently falling back to
// a cheaper substitute and reporting a smaller number.
interface ScopedStore {
  set: (entry: { id: string; data: unknown; digest?: string }) => boolean;
  clear: () => void;
  keys: () => Iterable<string>;
}

interface MutableStore {
  scopedStore: (collectionName: string) => ScopedStore;
  waitUntilSaveComplete: () => Promise<void>;
}

async function loadAstroDataStore(): Promise<{
  fromMap: (data: Map<string, unknown>) => Promise<MutableStore>;
}> {
  const requireModule = createRequire(import.meta.url);
  const astroRoot = path.dirname(requireModule.resolve("astro"));
  const file = path.join(astroRoot, "content", "mutable-data-store.js");
  let module: Record<string, unknown>;
  try {
    module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Astro's MutableDataStore was not found at ${file}. The measurement must ` +
        "drive the real content store, so update this path rather than " +
        `substituting a stand-in: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const store = module.MutableDataStore as
    | { fromMap: (data: Map<string, unknown>) => Promise<MutableStore> }
    | undefined;
  if (!store || typeof store.fromMap !== "function") {
    throw new Error(`${file} no longer exports a MutableDataStore with fromMap`);
  }
  return store;
}

// Mirrors the `cmsPages` schema in src/content.config.ts. Kept in sync by hand;
// the loader's own contract tests cover the projection shape.
const searchMetadata = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    noindex: z.boolean().optional(),
  })
  .loose();

const socialMetadata = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    imageAssetId: z.string().optional(),
  })
  .loose();

const cmsPagesSchema = z.object({
  pageId: z.string(),
  childDirected: z.boolean().optional(),
  previousSlugs: z.array(z.string()).optional(),
  homeCompositionVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  serviceCompositionVersion: z.literal(1).optional(),
  path: z.string(),
  family: z.enum(["home", "service", "schedule", "article", "staff", "dataHub"]),
  template: z.enum(["home", "programLanding", "genericPage"]),
  title: z.string(),
  pageTheme: z.enum(["default", "nj-decides"]).optional(),
  description: z.string(),
  heroBackgroundImage: z.string().optional(),
  heroBackgroundPosition: z.enum(["center", "top", "bottom"]).optional(),
  dataHubCompositionVersion: z.literal(1).optional(),
  dataHubReporting: z.custom<import("../../packages/content-core/src/data-hub-reporting").DataHubReporting>().optional(),
  homeHero: z.custom<HomeHeroConfig>().optional(),
  homeHeroTitle: z.string().optional(),
  homeHeroSubtitle: z.string().optional(),
  contentLinkMode: z.enum(["normal", "custom"]).optional(),
  contentLinkUrl: z.string().optional(),
  contentLinkNewTab: z.boolean().optional(),
  noindex: z.boolean(),
  seo: searchMetadata.optional(),
  social: socialMetadata.optional(),
  blocks: z.array(z.custom<PageBlock>()),
  datasetFigures: z.custom<DatasetFigures>(isDatasetFigures).optional(),
  assets: z.record(
    z.string(),
    z.union([z.object({
      url: z.url(),
      mimeType: z.enum([
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/gif",
        "image/avif",
      ]),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      thumbnails: z.array(z.object({ url: z.url(), width: z.number().int().positive(), height: z.number().int().positive() })).optional(),
    }), z.object({ url: z.url(), mimeType: z.literal("application/pdf") })]),
  ),
  contentMode: z.enum(["published", "draft"]),
  sourceVersion: z.number().int().positive().nullable(),
  publishedAt: z.string().nullable(),
});

// Grows rich text by repeating whole top-level nodes inside each document rather
// than by lengthening strings. That distinction turned out to matter: the content
// store's cost tracks the number of nodes it walks, not the number of bytes, so
// stretching strings would have grown the digest's cost while leaving the store's
// untouched and quietly biased the comparison.
function inflateRichText(value: unknown, factor: number): unknown {
  if (Array.isArray(value)) return value.map((entry) => inflateRichText(entry, factor));
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    output[key] = inflateRichText(entry, factor);
  }
  if (record.type === "doc" && Array.isArray(output.content)) {
    const content = output.content as unknown[];
    output.content = Array.from({ length: factor }, () => content).flat();
  }
  return output;
}

function seededPageDocuments(inflate: number): CmsPageDoc[] {
  const docs: CmsPageDoc[] = [];
  for (const pageId of PUBLIC_PAGE_IDS) {
    const seed = pageCompositionSeed(pageId);
    if (!seed) continue;
    const blocks =
      inflate > 1 ? (inflateRichText(seed.blocks, inflate) as PageBlock[]) : seed.blocks;
    const metadata = seed.metadata as Record<string, unknown>;
    docs.push({
      id: pageId,
      title: metadata.title,
      description: metadata.description,
      seo: metadata.seo,
      template: undefined,
      status: "published",
      publiclyVisible: true,
      publishAt: PUBLISHED_AT,
      blocks,
      version: 4,
      published: {
        blocks,
        metadata,
        publishedAt: PUBLISHED_AT,
        publishedBy: "measurement-harness",
        sourceVersion: 4,
      },
    });
  }
  return docs;
}

function seededAssetDocuments(): Record<string, Record<string, unknown>> {
  const assets: Record<string, Record<string, unknown>> = {};
  for (const id of pageSeedAssetIds()) {
    const asset = pageSeedAsset(id);
    if (!asset) continue;
    assets[id] = {
      url: asset.sourceUrl,
      mimeType: asset.mimeType,
      width: asset.width,
      height: asset.height,
    };
  }
  return assets;
}

// An in-memory stand-in with the shape `readCmsContentFromDatabase` consumes.
// It answers instantly so the report separates loader CPU work from network I/O
// rather than burying one in the other.
function inMemoryDatabase(
  pages: readonly CmsPageDoc[],
  assets: Record<string, Record<string, unknown>>,
) {
  const collections: Record<string, Record<string, Record<string, unknown>>> = {
    cmsPages: Object.fromEntries(
      pages.map((page) => [page.id, page as Record<string, unknown>]),
    ),
    media_assets_public: assets,
  };
  const snapshot = (id: string, data: Record<string, unknown> | undefined) => ({
    id,
    exists: data !== undefined,
    data: () => ({ ...(data ?? {}) }),
  });
  return {
    collection: (name: string) => ({
      get: async () => ({
        docs: Object.entries(collections[name] ?? {}).map(([id, data]) =>
          snapshot(id, data),
        ),
      }),
      doc: (id: string) => ({
        id,
        get: async () => snapshot(id, collections[name]?.[id]),
      }),
    }),
  };
}

// Compute one hash over serialized projection output to measure the digest
// itself. Serialization
// and hashing are timed separately because a reviewer's first question about a
// too-expensive digest is whether a cheaper hash would rescue it.
function serializeProjection(projected: CmsPageBuildData): string {
  return JSON.stringify(projected);
}

function hashProjection(serialized: string): string {
  return createHash("sha256").update(serialized).digest("hex");
}

interface PhaseTimings {
  read: number;
  project: number;
  serialize: number;
  hash: number;
  validate: number;
  storeWrite: number;
}

async function runOnce(
  pages: readonly CmsPageDoc[],
  assets: Record<string, Record<string, unknown>>,
  dataStore: { fromMap: (data: Map<string, unknown>) => Promise<MutableStore> },
): Promise<PhaseTimings> {
  const database = inMemoryDatabase(pages, assets);

  const readStart = performance.now();
  const read = await readCmsContentFromDatabase(
    database as never,
    { mode: "published" },
    BUILD_NOW,
  );
  const readEnd = performance.now();

  const assetMap = new Map<string, CmsPublicAsset>(
    read.assets.map((asset) => [asset.id, asset]),
  );

  const projectStart = performance.now();
  const projections: CmsPageBuildData[] = [];
  for (const doc of read.pages) {
    const projected = projectCmsPage(doc, {
      mode: "published",
      now: BUILD_NOW,
      assets: assetMap,
    });
    if (projected) projections.push(projected);
  }
  const projectEnd = performance.now();

  const serializeStart = performance.now();
  const serialized = projections.map((projected) => serializeProjection(projected));
  const serializeEnd = performance.now();

  const hashStart = performance.now();
  for (const entry of serialized) hashProjection(entry);
  const hashEnd = performance.now();

  const validateStart = performance.now();
  const validated: unknown[] = [];
  for (const projected of projections) {
    const parsed = await cmsPagesSchema.safeParseAsync({ ...projected });
    if (!parsed.success) {
      throw new Error(`projection for ${projected.pageId} failed the cmsPages schema`);
    }
    validated.push(parsed.data);
  }
  const validateEnd = performance.now();

  // The real store, driven exactly as `cmsPagesLoader` drives it: one clear,
  // then one `set` per projected page.
  const owner = await dataStore.fromMap(new Map());
  const store = owner.scopedStore("cmsPages");
  const storeStart = performance.now();
  store.clear();
  for (const [index, projected] of projections.entries()) {
    store.set({ id: projected.pageId, data: validated[index] });
  }
  const storeEnd = performance.now();

  if ([...store.keys()].length !== projections.length) {
    throw new Error("the content store did not receive every projected page");
  }
  // Drain the store's debounced save outside the timed section so its timer
  // cannot leak into the next sample or leave the process holding a handle.
  await owner.waitUntilSaveComplete();

  return {
    read: readEnd - readStart,
    project: projectEnd - projectStart,
    serialize: serializeEnd - serializeStart,
    hash: hashEnd - hashStart,
    validate: validateEnd - validateStart,
    storeWrite: storeEnd - storeStart,
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function parseFlag(argv: readonly string[], name: string, fallback: number): number {
  const raw = argv.find((entry) => entry.startsWith(`--${name}=`));
  if (!raw) return fallback;
  const value = Number(raw.slice(name.length + 3));
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`--${name} must be a number of at least 1`);
  }
  return Math.floor(value);
}

export async function measureCmsLoader(options: {
  runs: number;
  inflate: number;
}): Promise<{
  pages: number;
  blocks: number;
  runs: number;
  inflate: number;
  phases: PhaseTimings;
  total: number;
  skippable: number;
  skippableShare: number;
  digestCost: number;
  netSaving: number;
  netSavingRange: { worst: number; best: number };
  runsWhereDigestWins: number;
}> {
  const pages = seededPageDocuments(options.inflate);
  const assets = seededAssetDocuments();
  const blocks = pages.reduce(
    (count, page) => count + (Array.isArray(page.blocks) ? page.blocks.length : 0),
    0,
  );
  const dataStore = await loadAstroDataStore();

  // One untimed warm-up run so JIT compilation does not land inside the sample.
  await runOnce(pages, assets, dataStore);

  const samples: PhaseTimings[] = [];
  for (let index = 0; index < options.runs; index += 1) {
    samples.push(await runOnce(pages, assets, dataStore));
  }

  const phases: PhaseTimings = {
    read: median(samples.map((sample) => sample.read)),
    project: median(samples.map((sample) => sample.project)),
    serialize: median(samples.map((sample) => sample.serialize)),
    hash: median(samples.map((sample) => sample.hash)),
    validate: median(samples.map((sample) => sample.validate)),
    storeWrite: median(samples.map((sample) => sample.storeWrite)),
  };
  const digestCost = phases.serialize + phases.hash;
  // The current loader does no digest work, so the total it is measured against
  // excludes it; the digest is priced separately as the cost a digest build adds.
  const total = phases.read + phases.project + phases.validate + phases.storeWrite;
  const skippable = phases.validate + phases.storeWrite;

  // Paired within each run, then reduced. Subtracting independently taken medians
  // would report a net no single run produced, and would hide how often the sign
  // actually flips.
  const nets = samples.map(
    (sample) => sample.validate + sample.storeWrite - sample.serialize - sample.hash,
  );

  return {
    pages: pages.length,
    blocks,
    runs: options.runs,
    inflate: options.inflate,
    phases,
    total,
    skippable,
    skippableShare: total === 0 ? 0 : skippable / total,
    digestCost,
    netSaving: median(nets),
    netSavingRange: { worst: Math.min(...nets), best: Math.max(...nets) },
    runsWhereDigestWins: nets.filter((net) => net > 0).length,
  };
}

function formatMilliseconds(value: number): string {
  return `${value.toFixed(3)} ms`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const runs = parseFlag(argv, "runs", 25);
  const inflate = parseFlag(argv, "inflate", 1);
  const result = await measureCmsLoader({ runs, inflate });

  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const label =
    inflate === 1
      ? "real committed compositions"
      : `synthetic: rich text inflated ${inflate}x`;
  process.stdout.write(
    [
      "CMS pages loader phase timings (issue #484)",
      `content set: ${result.pages} canonical pages, ${result.blocks} blocks (${label})`,
      `samples: median of ${result.runs} runs after one warm-up`,
      "",
      "current loader path:",
      `  read (in-memory stand-in)   ${formatMilliseconds(result.phases.read)}`,
      `  projectCmsPage              ${formatMilliseconds(result.phases.project)}`,
      `  parseData (zod schema)      ${formatMilliseconds(result.phases.validate)}  <- skippable`,
      `  content store write         ${formatMilliseconds(result.phases.storeWrite)}  <- skippable`,
      `  measured total              ${formatMilliseconds(result.total)}`,
      "",
      "cost a projection digest would add:",
      `  JSON serialization          ${formatMilliseconds(result.phases.serialize)}`,
      `  sha256 hash                 ${formatMilliseconds(result.phases.hash)}`,
      `  digest total                ${formatMilliseconds(result.digestCost)}`,
      "",
      `  skippable work              ${formatMilliseconds(result.skippable)} (${(
        result.skippableShare * 100
      ).toFixed(1)}% of measured loader CPU time)`,
      `  net saving per unchanged build ${formatMilliseconds(
        result.netSaving,
      )} (median of per-run paired nets)`,
      `  per-run range               ${formatMilliseconds(
        result.netSavingRange.worst,
      )} to ${formatMilliseconds(result.netSavingRange.best)}`,
      `  runs where the digest wins  ${result.runsWhereDigestWins} of ${result.runs}`,
      "",
      "Firestore network time is excluded and is not skippable by any digest, so the",
      "share above is an upper bound on what a projection-level digest could save.",
      "",
    ].join("\n"),
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");
if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
