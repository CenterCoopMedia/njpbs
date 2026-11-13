import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  PUBLIC_PAGES,
  publicPage,
  publicPagePath,
  isPublicPagePath,
  publicPageAliases,
  isAvailablePageSlug,
  type PublicPageDefinition,
} from "../../../packages/content-core/src/public-pages.ts";
import {
  publicRouteBaseForRecordKind,
  type PubliclyRoutedRecordKind,
} from "../../../packages/content-core/src/public-record-kinds.ts";
import {
  COVERAGE_LABELS_SETTINGS_ID,
  STORY_CTAS_SETTINGS_ID,
  PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
  PUBLIC_SITE_CHROME_SETTINGS_ID,
  NJ_DECIDES_SETTINGS_ID,
  SITE_NAVIGATION_SETTINGS_ID,
  cmsSettingsSchemaFor,
  createCmsSettingsPublishedSnapshot,
  collectCmsSettingsAssetOccurrences,
} from "../../../packages/content-core/src/cms-settings.ts";

const requireModule = createRequire(import.meta.url);
const manifestModule = requireModule(
  "../../../functions/lib/public-media-manifest.js",
) as {
  PUBLIC_MEDIA_MANIFEST_COLLECTIONS: readonly PublicArtifactCollection[];
  PUBLIC_MEDIA_MANIFEST_SCHEMA_VERSION: number;
  createPublicMediaManifest: (input: {
    reservation: PublicBuildReservation;
    artifactInventory: PublicMediaArtifactInventory[];
    owners: PublicArtifactMediaOwner[];
  }) => PublicMediaManifest;
};
const mediaUsageModule = requireModule(
  "../../../functions/lib/media-usage.js",
) as {
  collectPublishedMediaUsage: (input: {
    collection: PublicArtifactCollection;
    snapshot: unknown;
  }) => { assetIds: string[]; occurrenceCount: number };
};
const deploymentModule = requireModule(
  "../../../functions/lib/public-deployment.js",
) as {
  PUBLIC_DEPLOYMENT_SCHEMA_VERSION: number;
  assertPublicDeploymentReservedBatch: (
    value: unknown,
    expectedBuildBatchId?: string | null,
  ) => PublicBuildReservation;
  assertPublicDeploymentTerminalBatchStructure: (
    value: unknown,
    expectedBuildBatchId?: string | null,
  ) => Record<string, unknown>;
  projectPublicBuildReservation: (
    value: unknown,
    expectedBuildBatchId?: string | null,
  ) => PublicBuildReservation;
};

const {
  PUBLIC_MEDIA_MANIFEST_COLLECTIONS,
  PUBLIC_MEDIA_MANIFEST_SCHEMA_VERSION,
  createPublicMediaManifest,
} = manifestModule;
const { collectPublishedMediaUsage } = mediaUsageModule;
const {
  PUBLIC_DEPLOYMENT_SCHEMA_VERSION,
  assertPublicDeploymentReservedBatch,
  assertPublicDeploymentTerminalBatchStructure,
  projectPublicBuildReservation,
} = deploymentModule;

export const PUBLIC_ARTIFACT_INVENTORY_SCHEMA_VERSION = 2;
export const MAX_PUBLIC_ARTIFACT_CUTOFF_AGE_MILLIS = 60_000;
const MAX_BACKGROUND_ARTIFACT_CUTOFF_AGE_MILLIS = 60 * 60_000;

const RECEIPT_FIELDS = new Set([
  "schemaVersion",
  "mediaManifestSchemaVersion",
  "digestAlgorithm",
  "buildBatchId",
  "generation",
  "commitSha",
  "cutoffAt",
  "aggregateRoutes",
  "families",
  "ownerCount",
  "owners",
  "mediaManifestDigest",
]);
// Present only when a build rendered a settings seed in place of a published
// snapshot. Receipts without a fallback keep the exact shape above.
const SETTINGS_FALLBACKS_FIELD = "settingsFallbacks";
const SETTINGS_FALLBACK_FIELDS = new Set(["documentId", "sourceVersion"]);
// The public settings documents a build may read. Each contributes to every
// page from the root identity and owns no route of its own.
const PUBLIC_SETTINGS_IDS: ReadonlySet<string> = new Set([
  STORY_CTAS_SETTINGS_ID,
  COVERAGE_LABELS_SETTINGS_ID,
  NJ_DECIDES_SETTINGS_ID,
  PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
  PUBLIC_SITE_CHROME_SETTINGS_ID,
  SITE_NAVIGATION_SETTINGS_ID,
]);
// Only navigation and header chrome have a source default. The banner fails a
// strict build instead.
const FALLBACK_SETTINGS_IDS: ReadonlySet<string> = new Set([
  STORY_CTAS_SETTINGS_ID,
  COVERAGE_LABELS_SETTINGS_ID,
  NJ_DECIDES_SETTINGS_ID,
  PUBLIC_SITE_CHROME_SETTINGS_ID,
  SITE_NAVIGATION_SETTINGS_ID,
]);
type FallbackSettingsId = typeof STORY_CTAS_SETTINGS_ID | typeof COVERAGE_LABELS_SETTINGS_ID | typeof PUBLIC_SITE_CHROME_SETTINGS_ID | typeof SITE_NAVIGATION_SETTINGS_ID | typeof NJ_DECIDES_SETTINGS_ID;
const FAMILY_FIELDS = new Set(["collection", "complete", "artifacts"]);
const ARTIFACT_FIELDS = new Set([
  "documentId",
  "sourceVersion",
  "canonicalPath",
  "aliases",
]);
const OWNER_FIELDS = new Set([
  "collection",
  "documentId",
  "sourceVersion",
  "assetIds",
  "occurrenceCount",
]);
const PAGE_INPUT_FIELDS = new Set([
  "documentId",
  "sourceVersion",
  "publishedSnapshot",
]);
const SETTINGS_INPUT_FIELDS = new Set([
  "documentId",
  "sourceVersion",
  "publishedSnapshot",
]);
const SETTINGS_MEDIA_INPUT_FIELDS = new Set([...SETTINGS_INPUT_FIELDS, "assetIds"]);
const SAFE_ROUTE = /^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)*$/;

export type PublicArtifactCollection =
  | "cmsPages"
  | "cmsPosts"
  | "cmsSettings"
  | "cmsAuthorProfilesPublic";

export interface PublicBuildReservation {
  schemaVersion: number;
  buildBatchId: string;
  generation: number;
  commitSha: string;
  reservedAgainstGeneration: number;
  reservedAgainstDeploymentId: string | null;
  reservedAgainstCommitSha: string | null;
  cutoffAt: {
    seconds: number;
    nanoseconds: number;
    toMillis(): number;
  };
  reservedAt: {
    seconds: number;
    nanoseconds: number;
    toMillis(): number;
  };
}

export interface PublicArtifactPageInput {
  documentId: string;
  sourceVersion: number;
  publishedSnapshot: unknown;
}

export interface PublicArtifactSettingsInput {
  documentId:
    | typeof STORY_CTAS_SETTINGS_ID
    | typeof COVERAGE_LABELS_SETTINGS_ID
    | typeof NJ_DECIDES_SETTINGS_ID
    | typeof PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID
    | typeof PUBLIC_SITE_CHROME_SETTINGS_ID
    | typeof SITE_NAVIGATION_SETTINGS_ID;
  sourceVersion: number;
  publishedSnapshot: unknown;
  /** Optional brand images may fall back; list only resolved public images. */
  assetIds?: string[];
}

/**
 * A published settings version the build read but rendered from the seed,
 * because the snapshot no longer passed the settings contract at cutoff.
 */
export interface PublicArtifactSettingsFallback {
  documentId: FallbackSettingsId;
  sourceVersion: number;
}

/**
 * One emitted Post or author page.
 *
 * Unlike a canonical page, whose route is declared in `PUBLIC_PAGES`, these
 * routes come from the content itself, so the producer states the route it
 * actually emitted and the receipt checks the shape rather than looking it up.
 * `aliases` are the retired slugs that still resolve -- the redirect stubs --
 * which the finalizer then requires to exist as real files in `dist`.
 */
export interface PublicArtifactRoutedInput {
  documentId: string;
  sourceVersion: number;
  canonicalPath: string;
  aliases: string[];
  publishedSnapshot: unknown;
}

export interface PublicArtifactContentInput extends PublicArtifactRoutedInput {
  kind: PubliclyRoutedRecordKind;
}

export interface PublicArtifactIdentity {
  documentId: string;
  sourceVersion: number;
  /** Library cards have an owner in the media manifest but no public route. */
  canonicalPath: string | null;
  aliases: string[];
}

export interface PublicArtifactLibraryCardInput {
  documentId: string;
  sourceVersion: number;
  kind: "sponsor" | "newsletter";
  assetIds: string[];
}

export interface PublicArtifactFamily {
  collection: PublicArtifactCollection;
  complete: true;
  artifacts: PublicArtifactIdentity[];
}

export interface PublicArtifactMediaOwner {
  collection: PublicArtifactCollection;
  documentId: string;
  sourceVersion: number;
  assetIds: string[];
  occurrenceCount: number;
}

export interface PublicArtifactInventoryReceipt {
  schemaVersion: number;
  mediaManifestSchemaVersion: number;
  digestAlgorithm: "sha256";
  buildBatchId: string;
  generation: number;
  commitSha: string;
  cutoffAt: { seconds: number; nanoseconds: number };
  aggregateRoutes: string[];
  families: PublicArtifactFamily[];
  ownerCount: number;
  owners: PublicArtifactMediaOwner[];
  mediaManifestDigest: string;
  settingsFallbacks?: PublicArtifactSettingsFallback[];
}

interface PublicMediaArtifactInventory {
  collection: PublicArtifactCollection;
  complete: true;
  documentIds: string[];
}

interface PublicMediaManifest {
  schemaVersion: number;
  digestAlgorithm: "sha256";
  buildBatchId: string;
  generation: number;
  commitSha: string;
  cutoffAt: { seconds: number; nanoseconds: number };
  ownerCount: number;
  owners: PublicArtifactMediaOwner[];
  mediaManifestDigest: string;
}

export class PublicArtifactInventoryError extends Error {
  constructor(message = "The public artifact inventory receipt is invalid") {
    super(message);
    this.name = "PublicArtifactInventoryError";
  }
}

function invalid(message = "The public artifact inventory receipt is invalid"): never {
  throw new PublicArtifactInventoryError(message);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactFields(value: unknown, fields: Set<string>): value is Record<string, unknown> {
  return plainObject(value) &&
    Object.keys(value).length === fields.size &&
    Object.keys(value).every((field) => fields.has(field));
}

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function safeRoute(value: unknown): value is string {
  return typeof value === "string" && SAFE_ROUTE.test(value);
}

const AUTHOR_ROUTE_BASE = "/authors/";
const POSTS_ROUTE = "/posts/";
const PROGRAMS_ROUTE = "/programs/";
const EVENTS_ROUTE = "/events/";
const STAFF_ROUTE = "/staff/";

/**
 * A route under one family's base and nowhere else.
 *
 * `safeRoute` already refuses anything but lowercase hyphenated segments, so
 * this adds the two remaining facts: the route sits under the family's own base,
 * and it names exactly one segment below it. Without the segment count, a post
 * could claim `/posts/a/b/` and the finalizer would happily look for a file two
 * directories down that the route emitter never produced.
 */
function routeUnderBase(route: unknown, base: string): boolean {
  if (!safeRoute(route) || !route.startsWith(base)) return false;
  const rest = route.slice(base.length, -1);
  return rest.length > 0 && !rest.includes("/");
}

function routedFamilyRoute(collection: PublicArtifactCollection, route: unknown): boolean {
  if (collection === "cmsAuthorProfilesPublic") {
    return routeUnderBase(route, AUTHOR_ROUTE_BASE);
  }
  if (collection !== "cmsPosts") return false;
  return ["post", "program", "event"].some((kind) => {
    const base = publicRouteBaseForRecordKind(kind);
    return base !== null && routeUnderBase(route, base);
  });
}

function definitionFor(documentId: string): PublicPageDefinition {
  const definition = publicPage(documentId);
  if (!definition) invalid();
  return definition;
}

function artifactForPage(
  definition: PublicPageDefinition,
  sourceVersion: number,
  metadata: unknown,
): PublicArtifactIdentity {
  if (!plainObject(metadata)) invalid();
  const canonicalPath = publicPagePath(definition.id, metadata);
  if (!canonicalPath || (metadata.previousSlugs !== undefined &&
      (!Array.isArray(metadata.previousSlugs) || metadata.previousSlugs.some(slug => !isAvailablePageSlug(definition.id, slug))))) invalid();
  const previous = Array.isArray(metadata.previousSlugs) ? metadata.previousSlugs as string[] : [];
  return {
    documentId: definition.id,
    sourceVersion,
    canonicalPath,
    aliases: publicPageAliases(definition, canonicalPath, previous),
  };
}

function inventoryFromFamilies(
  families: readonly PublicArtifactFamily[],
): PublicMediaArtifactInventory[] {
  return families.map(({ collection, artifacts }) => ({
    collection,
    complete: true,
    documentIds: artifacts.map(({ documentId }) => documentId),
  }));
}

function syntheticReservation(value: PublicArtifactInventoryReceipt): PublicBuildReservation {
  const cutoffAt = {
    seconds: value.cutoffAt.seconds,
    nanoseconds: value.cutoffAt.nanoseconds,
    toMillis: () =>
      value.cutoffAt.seconds * 1_000 +
      Math.floor(value.cutoffAt.nanoseconds / 1_000_000),
  };
  return {
    schemaVersion: PUBLIC_DEPLOYMENT_SCHEMA_VERSION,
    buildBatchId: value.buildBatchId,
    generation: value.generation,
    commitSha: value.commitSha,
    reservedAgainstGeneration: 0,
    reservedAgainstDeploymentId: null,
    reservedAgainstCommitSha: null,
    cutoffAt,
    reservedAt: cutoffAt,
  };
}

function canonicalFamilies(value: unknown): PublicArtifactFamily[] {
  if (!Array.isArray(value) || value.length !== PUBLIC_MEDIA_MANIFEST_COLLECTIONS.length) {
    invalid();
  }
  const families: PublicArtifactFamily[] = [];
  const routeOwners = new Set<string>();
  for (const [index, collection] of PUBLIC_MEDIA_MANIFEST_COLLECTIONS.entries()) {
    const family = value[index];
    if (
      !hasExactFields(family, FAMILY_FIELDS) ||
      family.collection !== collection ||
      family.complete !== true ||
      !Array.isArray(family.artifacts)
    ) {
      invalid();
    }
    // The public settings contribute to rendered pages from the root identity.
    // They do not own a second route, so their root identity is not added to the
    // cross-family route collision set below. Routed content remains an open set.
    const routed = collection === "cmsPosts" || collection === "cmsAuthorProfilesPublic";
    if (
      collection === "cmsSettings" &&
      (family.artifacts.length > PUBLIC_SETTINGS_IDS.size ||
        family.artifacts.some((artifact) =>
          !plainObject(artifact) ||
          typeof artifact.documentId !== "string" ||
          !PUBLIC_SETTINGS_IDS.has(artifact.documentId)))
    ) {
      invalid();
    }
    const artifacts: PublicArtifactIdentity[] = family.artifacts.map((artifact) => {
      if (
        !hasExactFields(artifact, ARTIFACT_FIELDS) ||
        typeof artifact.documentId !== "string" ||
        !Number.isSafeInteger(artifact.sourceVersion) ||
        Number(artifact.sourceVersion) < 1 ||
        !(collection === "cmsPosts" && artifact.canonicalPath === null &&
          Array.isArray(artifact.aliases) && artifact.aliases.length === 0) &&
          !safeRoute(artifact.canonicalPath) ||
        !Array.isArray(artifact.aliases) ||
        artifact.aliases.some((alias) => !safeRoute(alias))
      ) {
        invalid();
      }
      const canonical = {
        documentId: artifact.documentId,
        sourceVersion: Number(artifact.sourceVersion),
        canonicalPath: artifact.canonicalPath,
        aliases: [...artifact.aliases],
      };
      if (routed) {
        // The route is content-derived, so it is checked rather than looked up:
        // under this family's base, one segment deep, aliases the same, no
        // duplicates, and sorted so the receipt is byte-stable.
        const sortedAliases = [...canonical.aliases].sort(compareText);
        if (
          !(collection === "cmsPosts" && canonical.canonicalPath === null && canonical.aliases.length === 0) &&
          (!routedFamilyRoute(collection, canonical.canonicalPath) ||
          canonical.aliases.some((alias) => !routedFamilyRoute(collection, alias)) ||
          canonical.aliases.includes(canonical.canonicalPath) ||
          new Set(canonical.aliases).size !== canonical.aliases.length ||
          !isDeepStrictEqual(canonical.aliases, sortedAliases))
        ) {
          invalid();
        }
      } else if (collection === "cmsSettings") {
        const expected: PublicArtifactIdentity = {
          documentId: canonical.documentId,
          sourceVersion: Number(artifact.sourceVersion),
          canonicalPath: "/",
          aliases: [],
        };
        if (!isDeepStrictEqual(canonical, expected)) invalid();
      } else {
        const definition = definitionFor(artifact.documentId);
        const validPath = (route: string) => isPublicPagePath(definition.id, route);
        if (canonical.canonicalPath === null || !validPath(canonical.canonicalPath) || canonical.aliases.some(alias => !validPath(alias)) ||
            canonical.aliases.includes(canonical.canonicalPath) || new Set(canonical.aliases).size !== canonical.aliases.length ||
            !isDeepStrictEqual(canonical.aliases, [...canonical.aliases].sort(compareText))) invalid();
      }
      if (collection !== "cmsSettings" && canonical.canonicalPath !== null) {
        for (const route of [canonical.canonicalPath, ...canonical.aliases]) {
          if (routeOwners.has(route)) invalid();
          routeOwners.add(route);
        }
      }
      return canonical;
    });
    const sorted = [...artifacts].sort((left, right) =>
      compareText(left.documentId, right.documentId));
    if (
      !isDeepStrictEqual(artifacts, sorted) ||
      new Set(artifacts.map(({ documentId }) => documentId)).size !== artifacts.length
    ) {
      invalid();
    }
    families.push({
      collection,
      complete: true,
      artifacts,
    });
  }
  return families;
}

/**
 * Build the receipt from what the build actually emitted.
 *
 * `posts`, `programs`, `authors`, and `settings` are required. Older v3
 * bundles lack Events, so that family defaults to empty when reading them.
 * Each required array must state an explicit empty set when nothing is admitted.
 * They used to default to `[]`, which let a caller that simply did not know about
 * them produce a receipt declaring routed families complete and empty. A default
 * cannot tell "nothing was emitted" apart from "nobody asked". It could let the
 * receipt vouch for routes it never saw and drop their media owners from the
 * deployment manifest. An empty array is a legitimate answer; not answering is
 * not.
 */
export function createPublicArtifactInventoryReceipt({
  reservation,
  pages,
  posts,
  programs,
  events = [],
  libraryCards = [],
  authors,
  settings,
  settingsFallbacks = [],
}: {
  reservation: unknown;
  pages: readonly PublicArtifactPageInput[];
  /** Every Post the build emitted, with the routes it emitted for it. */
  posts: readonly PublicArtifactContentInput[];
  /** Every Program the build emitted, with the routes it emitted for it. */
  programs: readonly PublicArtifactContentInput[];
  events?: readonly PublicArtifactContentInput[];
  /** Saved library records whose card images ship in this exact build. */
  libraryCards?: readonly PublicArtifactLibraryCardInput[];
  /** Every author page the build emitted, with its retired-slug stubs. */
  authors: readonly PublicArtifactRoutedInput[];
  /** Each published public setting, or an explicit empty list. */
  settings: readonly PublicArtifactSettingsInput[];
  /** Published setting versions the build rendered from the seed instead. */
  settingsFallbacks?: readonly PublicArtifactSettingsFallback[];
}): PublicArtifactInventoryReceipt {
  if (
    !Array.isArray(posts) ||
    !Array.isArray(programs) ||
    !Array.isArray(authors) ||
    !Array.isArray(settings)
  ) {
    invalid(
      "The public artifact receipt needs the emitted posts, programs, author pages, and settings; a missing list cannot be read as an empty one",
    );
  }
  let projectedReservation: PublicBuildReservation;
  try {
    projectedReservation = projectPublicBuildReservation(
      reservation,
      plainObject(reservation) && typeof reservation.buildBatchId === "string"
        ? reservation.buildBatchId
        : null,
    );
  } catch {
    invalid();
  }
  if (!Array.isArray(pages)) invalid();
  const artifacts: PublicArtifactIdentity[] = [];
  const owners: PublicArtifactMediaOwner[] = [];
  const documentIds = new Set<string>();
  for (const page of pages) {
    const sourceVersion = page.sourceVersion;
    if (
      !hasExactFields(page, PAGE_INPUT_FIELDS) ||
      typeof page.documentId !== "string" ||
      typeof sourceVersion !== "number" ||
      !Number.isSafeInteger(sourceVersion) ||
      sourceVersion < 1 ||
      !plainObject(page.publishedSnapshot) ||
      page.publishedSnapshot.sourceVersion !== sourceVersion ||
      documentIds.has(page.documentId)
    ) {
      invalid();
    }
    const definition = definitionFor(page.documentId);
    documentIds.add(page.documentId);
    artifacts.push(artifactForPage(definition, sourceVersion, page.publishedSnapshot.metadata));
    let usage: { assetIds: string[]; occurrenceCount: number };
    try {
      usage = collectPublishedMediaUsage({
        collection: "cmsPages",
        snapshot: page.publishedSnapshot,
      });
    } catch {
      invalid();
    }
    owners.push({
      collection: "cmsPages",
      documentId: page.documentId,
      sourceVersion,
      assetIds: usage.assetIds,
      occurrenceCount: usage.occurrenceCount,
    });
  }
  artifacts.sort((left, right) => compareText(left.documentId, right.documentId));

  if (!Array.isArray(settingsFallbacks)) invalid();
  if (settings.length + settingsFallbacks.length > PUBLIC_SETTINGS_IDS.size) invalid();
  const settingArtifacts: PublicArtifactIdentity[] = [];
  const settingIds = new Set<string>();
  const addSettingArtifact = (documentId: string, sourceVersion: number, usage = { assetIds: [] as string[], occurrenceCount: 0 }) => {
    if (settingIds.has(documentId)) invalid();
    settingIds.add(documentId);
    settingArtifacts.push({
      documentId,
      sourceVersion,
      canonicalPath: "/",
      aliases: [],
    });
    owners.push({
      collection: "cmsSettings",
      documentId,
      sourceVersion,
      ...usage,
    });
  };
  for (const setting of settings) {
    const sourceVersion = setting.sourceVersion;
    if (
      !hasExactFields(setting, Object.hasOwn(setting, "assetIds") ? SETTINGS_MEDIA_INPUT_FIELDS : SETTINGS_INPUT_FIELDS) ||
      typeof setting.documentId !== "string" ||
      !PUBLIC_SETTINGS_IDS.has(setting.documentId) ||
      typeof sourceVersion !== "number" ||
      !Number.isSafeInteger(sourceVersion) ||
      sourceVersion < 1 ||
      !plainObject(setting.publishedSnapshot) ||
      setting.publishedSnapshot.sourceVersion !== sourceVersion
    ) {
      invalid();
    }
    const schema = cmsSettingsSchemaFor(
      setting.documentId,
      setting.publishedSnapshot.schemaVersion,
    );
    if (!schema) invalid();
    try {
      const canonicalSnapshot = createCmsSettingsPublishedSnapshot({
        schema,
        values: setting.publishedSnapshot.values,
        sourceVersion,
        publishedAt: setting.publishedSnapshot.publishedAt,
      });
      if (!isDeepStrictEqual(canonicalSnapshot, setting.publishedSnapshot)) invalid();
    } catch {
      invalid();
    }
    const occurrences = collectCmsSettingsAssetOccurrences(schema, setting.publishedSnapshot.values);
    const resolved = setting.assetIds ?? [...new Set(occurrences)];
    if (!Array.isArray(resolved) || new Set(resolved).size !== resolved.length ||
        resolved.some(id => !occurrences.includes(id)) ||
        (Object.hasOwn(setting, "assetIds") && setting.documentId !== NJ_DECIDES_SETTINGS_ID)) invalid();
    addSettingArtifact(setting.documentId, sourceVersion, { assetIds: [...resolved].sort(compareText),
      occurrenceCount: occurrences.filter(id => resolved.includes(id)).length });
  }
  const canonicalFallbacks: PublicArtifactSettingsFallback[] = [];
  for (const fallback of settingsFallbacks) {
    if (
      !hasExactFields(fallback, SETTINGS_FALLBACK_FIELDS) ||
      typeof fallback.documentId !== "string" ||
      !FALLBACK_SETTINGS_IDS.has(fallback.documentId) ||
      !Number.isSafeInteger(fallback.sourceVersion) ||
      Number(fallback.sourceVersion) < 1
    ) {
      invalid();
    }
    const sourceVersion = Number(fallback.sourceVersion);
    addSettingArtifact(fallback.documentId, sourceVersion);
    canonicalFallbacks.push({
      documentId: fallback.documentId as FallbackSettingsId,
      sourceVersion,
    });
  }
  canonicalFallbacks.sort((left, right) => compareText(left.documentId, right.documentId));
  settingArtifacts.sort((left, right) => compareText(left.documentId, right.documentId));

  // The routed families are built the same way for both collections: check the
  // input shape, derive the artifact identity from the routes the build says it
  // emitted, and collect one media owner per document -- including documents
  // with no media, which stay in the manifest with an empty list so removing
  // the last reference to an asset is visible rather than silent.
  const routedFamily = (
    collection: "cmsPosts" | "cmsAuthorProfilesPublic",
    inputs: readonly (PublicArtifactRoutedInput | PublicArtifactContentInput)[],
  ): PublicArtifactFamily => {
    const seen = new Set<string>();
    const family: PublicArtifactIdentity[] = [];
    for (const input of inputs) {
      const sourceVersion = input.sourceVersion;
      if (
        !plainObject(input) ||
        typeof input.documentId !== "string" ||
        !Number.isSafeInteger(sourceVersion) ||
        sourceVersion < 1 ||
        !Array.isArray(input.aliases) ||
        !plainObject(input.publishedSnapshot) ||
        seen.has(input.documentId)
      ) {
        invalid();
      }
      if (collection === "cmsPosts") {
        const content = input as PublicArtifactContentInput;
        const snapshot = content.publishedSnapshot as Record<string, unknown>;
        const base = publicRouteBaseForRecordKind(content.kind);
        if (
          base === null ||
          !plainObject(snapshot.metadata) ||
          snapshot.metadata.type !== content.kind ||
          snapshot.sourceVersion !== sourceVersion ||
          !routeUnderBase(content.canonicalPath, base) ||
          content.aliases.some((alias) => !routeUnderBase(alias, base))
        ) {
          invalid();
        }
      } else if (input.publishedSnapshot.snapshotVersion !== sourceVersion) {
        invalid();
      }
      seen.add(input.documentId);
      const identity: PublicArtifactIdentity = {
        documentId: input.documentId,
        sourceVersion,
        canonicalPath: input.canonicalPath,
        aliases: [...input.aliases].sort(compareText),
      };
      if (
        !routedFamilyRoute(collection, identity.canonicalPath) ||
        identity.aliases.some((alias) => !routedFamilyRoute(collection, alias))
      ) {
        invalid();
      }
      family.push(identity);
      let usage: { assetIds: string[]; occurrenceCount: number };
      try {
        usage = collectPublishedMediaUsage({
          collection,
          snapshot: input.publishedSnapshot,
        });
      } catch {
        invalid();
      }
      owners.push({
        collection,
        documentId: input.documentId,
        sourceVersion,
        assetIds: usage.assetIds,
        occurrenceCount: usage.occurrenceCount,
      });
    }
    family.sort((left, right) => compareText(left.documentId, right.documentId));
    return { collection, complete: true, artifacts: family };
  };

  const postFamily = routedFamily("cmsPosts", [...posts, ...programs, ...events]);
  for (const card of libraryCards) {
    if (
      !plainObject(card) ||
      !["sponsor", "newsletter"].includes(String(card.kind)) ||
      typeof card.documentId !== "string" ||
      !Number.isSafeInteger(card.sourceVersion) || card.sourceVersion < 1 ||
      !Array.isArray(card.assetIds) ||
      card.assetIds.some((id) => typeof id !== "string") ||
      new Set(card.assetIds).size !== card.assetIds.length ||
      postFamily.artifacts.some((artifact) => artifact.documentId === card.documentId)
    ) invalid();
    postFamily.artifacts.push({
      documentId: card.documentId,
      sourceVersion: card.sourceVersion,
      canonicalPath: null,
      aliases: [],
    });
    owners.push({
      collection: "cmsPosts",
      documentId: card.documentId,
      sourceVersion: card.sourceVersion,
      assetIds: [...card.assetIds].sort(compareText),
      occurrenceCount: card.assetIds.length,
    });
  }
  postFamily.artifacts.sort((left, right) => compareText(left.documentId, right.documentId));

  const families: PublicArtifactFamily[] = [
    { collection: "cmsPages", complete: true, artifacts },
    postFamily,
    { collection: "cmsSettings", complete: true, artifacts: settingArtifacts },
    routedFamily("cmsAuthorProfilesPublic", authors),
  ];
  let manifest: PublicMediaManifest;
  try {
    manifest = createPublicMediaManifest({
      reservation: projectedReservation,
      artifactInventory: inventoryFromFamilies(families),
      owners,
    });
  } catch {
    invalid();
  }
  return {
    schemaVersion: PUBLIC_ARTIFACT_INVENTORY_SCHEMA_VERSION,
    mediaManifestSchemaVersion: manifest.schemaVersion,
    digestAlgorithm: manifest.digestAlgorithm,
    buildBatchId: manifest.buildBatchId,
    generation: manifest.generation,
    commitSha: manifest.commitSha,
    cutoffAt: manifest.cutoffAt,
    aggregateRoutes: [POSTS_ROUTE, PROGRAMS_ROUTE, EVENTS_ROUTE, STAFF_ROUTE],
    families,
    ownerCount: manifest.ownerCount,
    owners: manifest.owners,
    mediaManifestDigest: manifest.mediaManifestDigest,
    ...(canonicalFallbacks.length > 0 ? { settingsFallbacks: canonicalFallbacks } : {}),
  };
}

function canonicalSettingsFallbacks(
  value: unknown,
  families: readonly PublicArtifactFamily[],
): PublicArtifactSettingsFallback[] {
  if (!Array.isArray(value) || value.length === 0) invalid();
  const settingsFamily = families.find(({ collection }) => collection === "cmsSettings");
  const seen = new Set<string>();
  return value.map((fallback) => {
    if (
      !hasExactFields(fallback, SETTINGS_FALLBACK_FIELDS) ||
      typeof fallback.documentId !== "string" ||
      !FALLBACK_SETTINGS_IDS.has(fallback.documentId) ||
      !Number.isSafeInteger(fallback.sourceVersion) ||
      Number(fallback.sourceVersion) < 1 ||
      seen.has(fallback.documentId) ||
      [...seen].some((previous) => compareText(previous, String(fallback.documentId)) > 0) ||
      !settingsFamily?.artifacts.some((artifact) =>
        artifact.documentId === fallback.documentId &&
        artifact.sourceVersion === fallback.sourceVersion)
    ) {
      invalid();
    }
    seen.add(fallback.documentId);
    return {
      documentId: fallback.documentId as FallbackSettingsId,
      sourceVersion: Number(fallback.sourceVersion),
    };
  });
}

export function assertPublicArtifactInventoryReceipt(
  value: unknown,
  expectedReservation: unknown = null,
): PublicArtifactInventoryReceipt {
  const hasSettingsFallbacks =
    plainObject(value) && Object.hasOwn(value, SETTINGS_FALLBACKS_FIELD);
  const receiptFields = hasSettingsFallbacks
    ? new Set([...RECEIPT_FIELDS, SETTINGS_FALLBACKS_FIELD])
    : RECEIPT_FIELDS;
  if (
    !hasExactFields(value, receiptFields) ||
    value.schemaVersion !== PUBLIC_ARTIFACT_INVENTORY_SCHEMA_VERSION ||
    value.mediaManifestSchemaVersion !== PUBLIC_MEDIA_MANIFEST_SCHEMA_VERSION ||
    value.digestAlgorithm !== "sha256" ||
    !plainObject(value.cutoffAt) ||
    !Number.isSafeInteger(value.cutoffAt.seconds) ||
    Number(value.cutoffAt.seconds) < 0 ||
    !Number.isSafeInteger(value.cutoffAt.nanoseconds) ||
    Number(value.cutoffAt.nanoseconds) < 0 ||
    Number(value.cutoffAt.nanoseconds) > 999_999_999 ||
    !Array.isArray(value.aggregateRoutes) ||
    !isDeepStrictEqual(value.aggregateRoutes, [POSTS_ROUTE, PROGRAMS_ROUTE, EVENTS_ROUTE, STAFF_ROUTE]) ||
    !Array.isArray(value.owners) ||
    !Number.isSafeInteger(value.ownerCount) ||
    value.ownerCount !== value.owners.length ||
    typeof value.mediaManifestDigest !== "string"
  ) {
    invalid();
  }
  const families = canonicalFamilies(value.families);
  const owners = value.owners.map((owner) => {
    if (!hasExactFields(owner, OWNER_FIELDS)) invalid();
    return { ...owner } as unknown as PublicArtifactMediaOwner;
  });
  const receipt = {
    schemaVersion: Number(value.schemaVersion),
    mediaManifestSchemaVersion: Number(value.mediaManifestSchemaVersion),
    digestAlgorithm: value.digestAlgorithm,
    buildBatchId: value.buildBatchId,
    generation: value.generation,
    commitSha: value.commitSha,
    cutoffAt: {
      seconds: Number(value.cutoffAt.seconds),
      nanoseconds: Number(value.cutoffAt.nanoseconds),
    },
    aggregateRoutes: [...value.aggregateRoutes],
    families,
    ownerCount: Number(value.ownerCount),
    owners,
    mediaManifestDigest: value.mediaManifestDigest,
    ...(hasSettingsFallbacks
      ? { settingsFallbacks: canonicalSettingsFallbacks(value.settingsFallbacks, families) }
      : {}),
  } as PublicArtifactInventoryReceipt;
  let manifest: PublicMediaManifest;
  try {
    const reservation = expectedReservation === null
      ? syntheticReservation(receipt)
      : projectPublicBuildReservation(expectedReservation, receipt.buildBatchId);
    manifest = createPublicMediaManifest({
      reservation,
      artifactInventory: inventoryFromFamilies(families),
      owners,
    });
  } catch {
    invalid();
  }
  if (
    manifest.schemaVersion !== receipt.mediaManifestSchemaVersion ||
    manifest.digestAlgorithm !== receipt.digestAlgorithm ||
    manifest.buildBatchId !== receipt.buildBatchId ||
    manifest.generation !== receipt.generation ||
    manifest.commitSha !== receipt.commitSha ||
    !isDeepStrictEqual(manifest.cutoffAt, receipt.cutoffAt) ||
    manifest.ownerCount !== receipt.ownerCount ||
    !isDeepStrictEqual(manifest.owners, receipt.owners) ||
    manifest.mediaManifestDigest !== receipt.mediaManifestDigest
  ) {
    invalid();
  }
  const sourceVersions = new Map(
    families.flatMap((family) => family.artifacts.map((artifact) => [
      `${family.collection}\u0000${artifact.documentId}`,
      artifact.sourceVersion,
    ] as const)),
  );
  for (const owner of owners) {
    if (
      sourceVersions.get(`${owner.collection}\u0000${owner.documentId}`) !==
      owner.sourceVersion
    ) {
      invalid();
    }
  }
  return receipt;
}

export function assertFreshPublicArtifactCutoff<T>(
  reservation: T,
  now: Date,
): T {
  return assertPublicArtifactCutoffAge(reservation, now, MAX_PUBLIC_ARTIFACT_CUTOFF_AGE_MILLIS);
}

function assertPublicArtifactCutoffAge<T>(reservation: T, now: Date, maxAgeMillis: number): T {
  let projected: PublicBuildReservation;
  try {
    projected = projectPublicBuildReservation(
      reservation,
      plainObject(reservation) && typeof reservation.buildBatchId === "string"
        ? reservation.buildBatchId
        : null,
    );
  } catch {
    invalid("The public artifact reservation is invalid");
  }
  const nowMillis = now.getTime();
  const cutoffMillis = projected.cutoffAt.toMillis();
  if (!Number.isFinite(nowMillis)) invalid("The public artifact build time is invalid");
  if (cutoffMillis > nowMillis) {
    invalid("The public artifact reservation cutoff is in the future");
  }
  if (nowMillis - cutoffMillis > maxAgeMillis) {
    invalid("The public artifact reservation cutoff is stale");
  }
  return reservation;
}

interface StoredArtifactReservationRequest {
  value: unknown;
  buildBatchId: string;
  commitSha: string;
  now: Date;
}

export function assertStoredPublicArtifactReservation(input: StoredArtifactReservationRequest): PublicBuildReservation {
  return assertStoredArtifactReservation(input, MAX_PUBLIC_ARTIFACT_CUTOFF_AGE_MILLIS);
}

/** A retained preparation keeps the same cutoff across retries before its input
 * checkpoint exists. Firestore supports microsecond read times for one hour. */
export function assertStoredBackgroundArtifactReservation(input: StoredArtifactReservationRequest): PublicBuildReservation {
  if (!/^post-background-[A-Za-z0-9]{20}-[a-f0-9]{64}$/.test(input.buildBatchId)) {
    invalid("The background publication identity is invalid");
  }
  return assertStoredArtifactReservation(input, MAX_BACKGROUND_ARTIFACT_CUTOFF_AGE_MILLIS);
}

function assertStoredArtifactReservation({ value, buildBatchId, commitSha, now }: StoredArtifactReservationRequest,
  maxAgeMillis: number): PublicBuildReservation {
  let reservation: PublicBuildReservation;
  try {
    reservation = assertPublicDeploymentReservedBatch(value, buildBatchId);
  } catch {
    invalid("The public deployment build batch is invalid");
  }
  if (reservation.commitSha !== commitSha) {
    invalid("This public build batch belongs to a different commit");
  }
  assertPublicArtifactCutoffAge(reservation, now, maxAgeMillis);
  return reservation;
}

export function assertStoredDeployedPublicArtifactBatch({
  value,
  buildBatchId,
  commitSha,
  now,
}: {
  value: unknown;
  buildBatchId: string;
  commitSha: string;
  now: Date;
}): PublicBuildReservation {
  let reservation: PublicBuildReservation;
  try {
    const batch = assertPublicDeploymentTerminalBatchStructure(value, buildBatchId);
    if (batch.status !== "deployed") throw new Error("not deployed");
    reservation = projectPublicBuildReservation(batch, buildBatchId);
  } catch {
    invalid("The deployed public build batch is invalid");
  }
  if (reservation.commitSha !== commitSha) {
    invalid("This public build batch belongs to a different commit");
  }
  const nowMillis = now.getTime();
  if (!Number.isFinite(nowMillis)) invalid("The public artifact build time is invalid");
  if (reservation.cutoffAt.toMillis() > nowMillis) {
    invalid("The public artifact reservation cutoff is in the future");
  }
  return reservation;
}

function builtFileForRoute(distDirectory: string, route: string): string {
  if (!safeRoute(route)) invalid();
  const relative = route === "/" ? "index.html" : `${route.slice(1)}index.html`;
  const target = path.resolve(distDirectory, relative);
  const relation = path.relative(path.resolve(distDirectory), target);
  if (relation.startsWith("..") || path.isAbsolute(relation)) invalid();
  return target;
}

async function atomicWriteJson(outputPath: string, value: unknown): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

export async function finalizePublicArtifactInventoryReceipt({
  receipt,
  recordContextPostPaths = [],
  distDirectory,
  outputPath,
}: {
  receipt: PublicArtifactInventoryReceipt;
  recordContextPostPaths?: string[];
  distDirectory: string;
  outputPath: string;
}): Promise<void> {
  const canonical = assertPublicArtifactInventoryReceipt(receipt);
  if (!path.isAbsolute(outputPath)) {
    invalid("The public artifact inventory output path must be absolute");
  }
  const [distRoot, outputParent] = await Promise.all([
    realpath(distDirectory),
    realpath(path.dirname(outputPath)),
  ]).catch(() => invalid("The public artifact inventory output path is invalid"));
  const resolvedOutput = path.join(outputParent, path.basename(outputPath));
  const outputRelation = path.relative(distRoot, resolvedOutput);
  if (
    outputRelation === "" ||
    (!outputRelation.startsWith("..") && !path.isAbsolute(outputRelation))
  ) {
    invalid("The public artifact inventory receipt must stay outside site/dist");
  }
  for (const family of canonical.families) {
    for (const artifact of family.artifacts) {
      if (artifact.canonicalPath === null) continue;
      for (const route of [artifact.canonicalPath, ...artifact.aliases]) {
        const builtPath = builtFileForRoute(distRoot, route);
        let built;
        try {
          built = await lstat(builtPath);
        } catch {
          invalid(`The built path ${route} is missing from the public artifact`);
        }
        if (!built.isFile()) {
          invalid(`The built path ${route} is missing from the public artifact`);
        }
      }
    }
  }
  for (const route of canonical.aggregateRoutes) {
    const builtPath = builtFileForRoute(distRoot, route);
    let built;
    try {
      built = await lstat(builtPath);
    } catch {
      invalid(`The built path ${route} is missing from the public artifact`);
    }
    if (!built.isFile()) {
      invalid(`The built path ${route} is missing from the public artifact`);
    }
  }
  // This public projection contains only emitted routes and versions. Keep the
  // private inventory (document ids, media owners, and cutoff) outside dist.
  // The later artifact binding includes these bytes in its content digest.
  const routes: Array<{
    path: string;
    source: "site" | "cms";
    contentKey?: string;
    sourceVersion?: number;
    recordContext?: true;
  }> = [];
  const cmsPages = canonical.families.find((family) => family.collection === "cmsPages")!;
  for (const page of PUBLIC_PAGES) {
    // The Data Hub keeps its explicit publication gate. Its committed frame is
    // inventoried only when the gated route was actually emitted.
    if (page.id === "data-hub" && !(await lstat(builtFileForRoute(distRoot,page.path)).catch(() => null))?.isFile()) continue;
    if (cmsPages.artifacts.some((artifact) => artifact.canonicalPath === page.path)) continue;
    for (const route of [page.path, ...("aliases" in page ? page.aliases : [])]) {
      const built = await lstat(builtFileForRoute(distRoot, route)).catch(() => null);
      if (!built?.isFile()) invalid(`The built path ${route} is missing from the public artifact`);
    }
    routes.push({ path: page.path, source: "site" });
  }
  for (const family of canonical.families) {
    if (family.collection !== "cmsPages" && family.collection !== "cmsPosts") continue;
    for (const artifact of family.artifacts) {
      if (artifact.canonicalPath === null) continue;
      routes.push({
        path: artifact.canonicalPath,
        source: "cms",
        contentKey: createHash("sha256")
          .update(`${family.collection}/${artifact.documentId}`)
          .digest("hex"),
        sourceVersion: artifact.sourceVersion,
      });
    }
  }
  if (!Array.isArray(recordContextPostPaths)) invalid("Invalid joined-card Post route catalog");
  // A hint overflow must retain static serving, never stop an unrelated build.
  const contextPaths = recordContextPostPaths.length <= 10_000 ? recordContextPostPaths : [];
  if (new Set(contextPaths).size !== contextPaths.length || contextPaths.some(path =>
        typeof path !== "string" || path.length > 512 || !/^\/posts\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(path) ||
        !routes.some(route => route.source === "cms" && route.path === path))) invalid("Invalid joined-card Post route catalog");
  for (const route of routes) if (contextPaths.includes(route.path)) route.recordContext = true;
  await atomicWriteJson(resolvedOutput, canonical);
  await atomicWriteJson(path.join(distRoot, "_content-status.json"), {
    schemaVersion: 1,
    collections: ["cmsPages", "cmsPosts"],
    buildBatchId: canonical.buildBatchId,
    generation: canonical.generation,
    commitSha: canonical.commitSha,
    routes: routes.sort((left, right) => compareText(left.path, right.path)),
  });
}
