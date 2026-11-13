import { isCoverageLabelsBuildData, type CoverageLabelsBuildData } from "../../../packages/content-core/src/coverage-labels.ts";
import { isStoryCtasBuildData, type StoryCtasBuildData } from "../../../packages/content-core/src/story-ctas.ts";
import { STORY_CTAS_SETTINGS_ID } from "../../../packages/content-core/src/cms-settings.ts";
import { serviceCompositionError } from "../../../packages/content-core/src/service-composition.ts";
import { assertHomeSourcePublication } from "./home-editorial-catalog.ts";
import { createHash, randomUUID } from "node:crypto";
import { assertProgramImageCatalog, programImageBytes, ProgramImagePreparationError, type ProgramImageCatalog } from "./published-record-images.ts";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { authorPublicPath } from "../../../packages/content-core/src/author-profiles.ts";
import { publicPage, isPublicPagePath, isAvailablePageSlug, publicPageAliases } from "../../../packages/content-core/src/public-pages.ts";
import { parseBlocks, safeHref } from "../../../packages/content-core/src/content-model.ts";
import { homeCompositionError } from "../../../packages/content-core/src/home-composition-contract.ts";
import type { CmsAuthorBuildData } from "./cms-authors-loader";
import type { CmsPageBuildData } from "./cms-loader";
import type { CmsPostBuildData } from "./cms-posts-loader";
import type { CmsEventBuildData } from "./cms-events-loader.ts";
import type { CmsProgramBuildData } from "./cms-programs-loader";
import type { RecordCardPayload } from "./record-card-resolution";
import { programCardData } from "./program-card-data.ts";
import { eventCardData } from "./event-card-data.ts";
import { eventPublicPath, postPublicPath, programPublicPath } from "./public-content-routes.ts";
import {
  COVERAGE_LABELS_SETTINGS_ID,
  PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
  PUBLIC_SITE_CHROME_SETTINGS_ID,
  NJ_DECIDES_SETTINGS_ID,
  SITE_NAVIGATION_SETTINGS_ID,
  cmsSettingsSchemaFor,
  validateCmsSettingsValues,
} from "../../../packages/content-core/src/cms-settings.ts";
import type { PublicHomepageBannerBuildData } from "./public-homepage-banner";
import { isNjDecidesBuildData, type NjDecidesBuildData } from "./nj-decides-settings.ts";

import type { SiteNavigationBuildData } from "./site-navigation";
import type { PublicSiteChromeBuildData } from "./public-site-chrome";
import { projectDatasetFigures } from "./dataset-figures-projection.ts";
import {
  assertPublicArtifactInventoryReceipt,
  type PublicArtifactInventoryReceipt,
} from "./public-artifact-inventory.ts";

export const PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION = 3;

/** One published public setting. Each settingId appears at most once. */
export type PublicSettingBuildData =
  | StoryCtasBuildData
  | CoverageLabelsBuildData
  | PublicHomepageBannerBuildData
  | PublicSiteChromeBuildData
  | NjDecidesBuildData
  | SiteNavigationBuildData;

type Env = Record<string, string | undefined>;

export interface PublicArtifactBundle {
  /** Private preparation only; normalized legacy consumer bundles omit this field. */
  programImageDescriptors?: ProgramImageCatalog;
  schemaVersion: 3;
  pages: CmsPageBuildData[];
  posts: CmsPostBuildData[];
  programs: CmsProgramBuildData[];
  recordCards?: RecordCardPayload[];
  events?: CmsEventBuildData[];
  authors: CmsAuthorBuildData[];
  settings: PublicSettingBuildData[];
  receipt: PublicArtifactInventoryReceipt;
  homeSources?: import("../../../packages/content-core/src/home-rail-render").HomeSourceSnapshot;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertArray(value: unknown, label: string): asserts value is Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((entry) => !plainObject(entry))) {
    throw new Error(`The public artifact bundle ${label} list is invalid`);
  }
}

function projectedAliases(
  value: unknown,
  pathFor: (slug: string) => string,
): string[] | null {
  if (!Array.isArray(value) || value.some((slug) => typeof slug !== "string")) {
    return null;
  }
  try {
    return value.map((slug) => pathFor(slug as string));
  } catch {
    return null;
  }
}

function projectedCanonicalPath(
  storedPath: unknown,
  slug: unknown,
  pathFor: (slug: string) => string,
): string | null {
  if (typeof storedPath !== "string" || typeof slug !== "string") return null;
  try {
    const projected = pathFor(slug);
    return storedPath === projected ? projected : null;
  } catch {
    return null;
  }
}

function canonicalInstantString(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function assertSiteNavigationSetting(setting: Record<string, unknown>): void {
  const allowed = new Set(["settingId", "header", "footer", "sourceVersion", "publishedAt", "postsBrowse"]);
  if (
    !["settingId", "header", "footer", "sourceVersion", "publishedAt"].every(key => Object.hasOwn(setting, key)) ||
    Object.keys(setting).some((field) => !allowed.has(field)) ||
    !Number.isSafeInteger(setting.sourceVersion) ||
    Number(setting.sourceVersion) < 1 ||
    !canonicalInstantString(setting.publishedAt)
  ) {
    throw new Error("The public artifact bundle settings list is invalid");
  }
  const schema = cmsSettingsSchemaFor(SITE_NAVIGATION_SETTINGS_ID, setting.postsBrowse === undefined ? 1 : 2);
  const settingsError = schema
    ? validateCmsSettingsValues(schema, { header: setting.header, footer: setting.footer, ...(setting.postsBrowse === undefined ? {} : { postsBrowse: setting.postsBrowse }) })
    : "The site navigation settings schema is missing";
  if (settingsError) {
    throw new Error(`The public artifact bundle settings list is invalid: ${settingsError}`);
  }
}

const PUBLIC_SITE_CHROME_BUNDLE_FIELDS = new Set([
  "settingId",
  "newsletterEnabled",
  "newsletterLabel",
  "newsletterHref",
  "newsletterOpensInNewTab",
  "sourceVersion",
  "publishedAt",
]);

function assertPublicSiteChromeSetting(setting: Record<string, unknown>): void {
  if (
    Object.keys(setting).length !== PUBLIC_SITE_CHROME_BUNDLE_FIELDS.size ||
    Object.keys(setting).some((field) => !PUBLIC_SITE_CHROME_BUNDLE_FIELDS.has(field)) ||
    !Number.isSafeInteger(setting.sourceVersion) ||
    Number(setting.sourceVersion) < 1 ||
    !canonicalInstantString(setting.publishedAt)
  ) {
    throw new Error("The public artifact bundle settings list is invalid");
  }
  const schema = cmsSettingsSchemaFor(PUBLIC_SITE_CHROME_SETTINGS_ID, 1);
  const settingsError = schema
    ? validateCmsSettingsValues(schema, {
        newsletterEnabled: setting.newsletterEnabled,
        newsletterLabel: setting.newsletterLabel,
        newsletterHref: setting.newsletterHref,
        newsletterOpensInNewTab: setting.newsletterOpensInNewTab,
      })
    : "The public-site chrome settings schema is missing";
  if (settingsError) {
    throw new Error(`The public artifact bundle settings list is invalid: ${settingsError}`);
  }
}

function validSponsorCard(value: unknown, id: unknown): boolean {
  if (!plainObject(value)) return false;
  const fields = ["sponsorId", "name", "href", "logoUrl", "logoAlt", "logoDecorative", "tier", "description"];
  return Object.keys(value).every(field => fields.includes(field)) &&
    value.sponsorId === id && typeof value.name === "string" && !!value.name.trim() &&
    (value.href === null || (typeof value.href === "string" && /^https?:\/\//i.test(value.href) && !!safeHref(value.href))) &&
    (value.logoUrl === null || (typeof value.logoUrl === "string" && value.logoUrl.startsWith("https://"))) &&
    typeof value.logoAlt === "string" && typeof value.logoDecorative === "boolean" &&
    (value.tier === undefined || typeof value.tier === "string") &&
    (value.description === undefined || typeof value.description === "string");
}

function validNewsletterCard(value: unknown, title: unknown): boolean {
  if (!plainObject(value) || !plainObject(value.card) ||
    Object.keys(value).some(key => !["card", "image"].includes(key))) return false;
  const card = value.card;
  if (card.title !== title || Object.keys(card).some(key => ![
    "title", "signupUrl", "frequency", "summary", "imageAssetId", "imageAlt", "imageDecorative",
  ].includes(key))) return false;
  if (typeof card.signupUrl !== "string") return false;
  try {
    const url = new URL(card.signupUrl);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return false;
  } catch { return false; }
  if (["frequency", "summary", "imageAssetId", "imageAlt"].some(key =>
    card[key] !== undefined && typeof card[key] !== "string")) return false;
  if (card.imageDecorative !== undefined && typeof card.imageDecorative !== "boolean") return false;
  if (value.image !== undefined) {
    const image = value.image;
    if (!plainObject(image) || Object.keys(image).some(key => !["url", "mimeType", "width", "height"].includes(key)) ||
      typeof image.url !== "string" || !image.url.startsWith("https://") ||
      typeof image.mimeType !== "string" || !/^image\/(png|jpeg|webp|gif|avif)$/.test(image.mimeType) ||
      !Number.isSafeInteger(image.width) || Number(image.width) < 1 ||
      !Number.isSafeInteger(image.height) || Number(image.height) < 1 || !card.imageAssetId) return false;
  }
  return true;
}

export function assertRecordCards(value: unknown): asserts value is RecordCardPayload[] {
  assertArray(value, "record card");
  const seenCards = new Set<string>();
  for (const card of value) {
    const key = `${card.kind}:${card.id}`;
    if (!["program", "event", "sponsor", "newsletter"].includes(String(card.kind)) ||
      typeof card.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(card.id) ||
      typeof card.title !== "string" || !card.title.trim() ||
      ((card.kind === "program" || card.kind === "event") &&
        (typeof card.href !== "string" || !/^\/(?!\/)/.test(card.href))) ||
      (card.kind === "sponsor" &&
        !(card.href === null || (typeof card.href === "string" && /^https?:\/\//i.test(card.href)))) ||
      (card.kind === "newsletter" && card.href !== null) ||
      Object.keys(card).some(field => !["kind", "id", "title", "href", "program", "event", "sponsor", "newsletter", "sourceVersion"].includes(field)) ||
      (card.sourceVersion !== undefined && (!Number.isSafeInteger(card.sourceVersion) || Number(card.sourceVersion) < 1 ||
        (card.kind !== "sponsor" && card.kind !== "newsletter"))) ||
      (card.sponsor !== undefined && (card.kind !== "sponsor" || !validSponsorCard(card.sponsor, card.id))) ||
      (card.newsletter !== undefined && (card.kind !== "newsletter" || !validNewsletterCard(card.newsletter, card.title))) ||
      (card.program !== undefined && card.kind !== "program") ||
      (card.event !== undefined && card.kind !== "event") ||
      seenCards.has(key)) {
      throw new Error("The public artifact bundle record card list is invalid");
    }
    seenCards.add(key);
  }
}

export function assertPublicArtifactBundle(value: unknown): PublicArtifactBundle {
  if (
    !plainObject(value) ||
    Object.keys(value).some(key => ![
      "schemaVersion", "pages", "posts", "programs", "events", "recordCards", "authors", "settings", "receipt", "homeSources", "programImageDescriptors",
    ].includes(key)) ||
    !["schemaVersion", "pages", "posts", "programs", "authors", "settings", "receipt"].every(
      (field) => Object.hasOwn(value, field),
    ) ||
    value.schemaVersion !== PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION
  ) {
    throw new Error("The public artifact bundle is invalid");
  }
  assertArray(value.pages, "Page");
  assertArray(value.posts, "Post");
  assertArray(value.programs, "Program");
  for (const [label, records] of [["Page", value.pages], ["Post", value.posts]] as const) {
    for (const record of records) {
      const hasDataFigure = Array.isArray(record.blocks) && record.blocks.some(block =>
        plainObject(block) && block.type === "data_figure");
      if (record.datasetFigures === undefined && !hasDataFigure) continue;
      const parsed = parseBlocks(record.blocks);
      if (!parsed.ok) throw new Error(`The public artifact bundle ${label} blocks are invalid`);
      projectDatasetFigures(
        record.datasetFigures,
        parsed.blocks,
        `public artifact ${label.toLowerCase()} ${String(record.pageId ?? record.postId ?? "unknown")}`,
      );
    }
  }
  if (value.recordCards !== undefined) assertRecordCards(value.recordCards);
  if (Array.isArray(value.recordCards)) {
    for (const card of value.recordCards) {
      if (card.kind === "program" && card.program !== undefined) {
        const source = value.programs.find(program => program.programId === card.id);
        if (!source || !isDeepStrictEqual(card.program, programCardData(source as unknown as CmsProgramBuildData))) {
          throw new Error("The public artifact bundle record card list is invalid");
        }
      }
      if (card.kind === "event" && card.event !== undefined) {
        const source = (Array.isArray(value.events) ? value.events : []).find((event: Record<string, unknown>) => event.eventId === card.id);
        if (!source || !isDeepStrictEqual(card.event, eventCardData(source as unknown as CmsEventBuildData))) {
          throw new Error("The public artifact bundle record card list is invalid");
        }
      }
    }
  }
  if (value.events !== undefined) assertArray(value.events, "Event");
  assertArray(value.authors, "author");
  assertArray(value.settings, "settings");
  for (const page of value.pages) {
    const serviceError = serviceCompositionError(String(page.pageId), page.serviceCompositionVersion);
    if (serviceError) throw new Error(serviceError);
    if (page.homeCompositionVersion === undefined) continue;
    const parsed = parseBlocks(page.blocks);
    if (!parsed.ok) throw new Error(`The public Home composition blocks are invalid: ${parsed.error}`);
    const error = homeCompositionError(String(page.pageId), page.homeCompositionVersion, parsed.blocks);
    if (error) throw new Error(error);
  }
  const settingIds = value.settings.map((setting) => setting.settingId);
  if (
    value.settings.length > 6 ||
    new Set(settingIds).size !== settingIds.length
  ) {
    throw new Error("The public artifact bundle settings list is invalid");
  }
  for (const setting of value.settings) {
    if (setting.settingId === STORY_CTAS_SETTINGS_ID) {
      if (!isStoryCtasBuildData(setting)) throw new Error("The story CTA settings are invalid");
      continue;
    }
    if (setting.settingId === COVERAGE_LABELS_SETTINGS_ID) {
      if (!isCoverageLabelsBuildData(setting)) throw new Error("The coverage label settings are invalid");
      continue;
    }
    if (setting.settingId === NJ_DECIDES_SETTINGS_ID) {
      if (!isNjDecidesBuildData(setting)) throw new Error("The NJ Decides settings are invalid");
      continue;
    }
    if (setting.settingId === SITE_NAVIGATION_SETTINGS_ID) {
      assertSiteNavigationSetting(setting);
      continue;
    }
    if (setting.settingId === PUBLIC_SITE_CHROME_SETTINGS_ID) {
      assertPublicSiteChromeSetting(setting);
      continue;
    }
    const allowed = new Set([
      "settingId",
      "enabled",
      "message",
      "link",
      "secondLink",
      "njDecides",
      "liveLabel",
      "startsAt",
      "endsAt",
      "excludedPaths",
      "sourceVersion",
      "publishedAt",
    ]);
    const parsedAt = typeof setting.publishedAt === "string"
      ? new Date(setting.publishedAt)
      : null;
    if (
      Object.keys(setting).some((field) => !allowed.has(field)) ||
      !Object.hasOwn(setting, "settingId") ||
      !Object.hasOwn(setting, "enabled") ||
      !Object.hasOwn(setting, "message") ||
      !Object.hasOwn(setting, "sourceVersion") ||
      !Object.hasOwn(setting, "publishedAt") ||
      setting.settingId !== PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID ||
      typeof setting.enabled !== "boolean" ||
      typeof setting.message !== "string" ||
      (setting.njDecides !== true && setting.message.trim() === "") ||
      !Number.isSafeInteger(setting.sourceVersion) ||
      Number(setting.sourceVersion) < 1 ||
      !parsedAt ||
      Number.isNaN(parsedAt.getTime()) ||
      parsedAt.toISOString() !== setting.publishedAt ||
      (setting.link !== undefined && (
        !plainObject(setting.link) || Object.keys(setting.link).length !== 2 ||
        typeof setting.link.label !== "string" || setting.link.label.trim() === "" || typeof setting.link.href !== "string"
      )) ||
      (setting.secondLink !== undefined && (
        !plainObject(setting.secondLink) || Object.keys(setting.secondLink).length !== 2 ||
        typeof setting.secondLink.label !== "string" || setting.secondLink.label.trim() === "" || typeof setting.secondLink.href !== "string"
      ))
    ) {
      throw new Error("The public artifact bundle settings list is invalid");
    }
    const schema = cmsSettingsSchemaFor(PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID, 4);
    const settingsError = schema
      ? validateCmsSettingsValues(schema, {
          enabled: setting.enabled,
          message: setting.message,
          ...(setting.njDecides !== undefined ? { njDecides: setting.njDecides } : {}),
          ...(setting.liveLabel !== undefined ? { liveLabel: setting.liveLabel } : {}),
          ...(setting.startsAt !== undefined ? { startsAt: setting.startsAt } : {}),
          ...(setting.endsAt !== undefined ? { endsAt: setting.endsAt } : {}),
          ...(setting.excludedPaths !== undefined ? { excludedPaths: setting.excludedPaths } : {}),
          ...(setting.secondLink
            ? { secondLinkLabel: setting.secondLink.label, secondLinkHref: setting.secondLink.href }
            : {}),
          ...(setting.link
            ? {
                linkLabel: setting.link.label,
                linkHref: setting.link.href,
              }
            : {}),
        })
      : "The public homepage banner settings schema is missing";
    if (settingsError) {
      throw new Error(`The public artifact bundle settings list is invalid: ${settingsError}`);
    }
  }
  const receipt = assertPublicArtifactInventoryReceipt(value.receipt);
  for (const setting of value.settings) if (isNjDecidesBuildData(setting)) {
    const owner = receipt.owners.find(row => row.collection === "cmsSettings" && row.documentId === NJ_DECIDES_SETTINGS_ID);
    if (!owner || !isDeepStrictEqual(owner.assetIds, Object.keys(setting.assets).sort())) {
      throw new Error("The NJ Decides image inventory differs from its rendered assets");
    }
  }
  const homeSources = value.homeSources === undefined ? undefined : assertHomeSourcePublication(
    value.homeSources as import("../../../packages/content-core/src/home-rail-render").HomeSourceSnapshot, receipt);
  const familyVersions = new Map(
    receipt.families.map((family) => [
      family.collection,
      new Map(family.artifacts.map((artifact) => [artifact.documentId, artifact])),
    ]),
  );
  const exactVersions = (
    collection: "cmsPages" | "cmsPosts" | "cmsSettings" | "cmsAuthorProfilesPublic",
    entries: readonly {
      id: unknown;
      sourceVersion: unknown;
      canonicalPath: unknown;
      aliases: unknown;
    }[],
  ) => {
    const expected = familyVersions.get(collection);
    if (!expected || expected.size !== entries.length) {
      throw new Error(`The public artifact bundle ${collection} coverage is incomplete`);
    }
    const seen = new Set<string>();
    for (const entry of entries) {
      const id = entry.id;
      const artifact = typeof id === "string" ? expected.get(id) : undefined;
      if (
        typeof id !== "string" ||
        seen.has(id) ||
        !artifact ||
        artifact.sourceVersion !== entry.sourceVersion ||
        artifact.canonicalPath !== entry.canonicalPath ||
        !isDeepStrictEqual(
          artifact.aliases,
          Array.isArray(entry.aliases) ? [...entry.aliases].sort() : null,
        )
      ) {
        throw new Error(`The public artifact bundle ${collection} coverage is invalid`);
      }
      seen.add(id);
    }
  };
  exactVersions("cmsPages", value.pages.map((entry) => {
    const definition = typeof entry.pageId === "string"
      ? publicPage(entry.pageId)
      : undefined;
    const previous = entry.previousSlugs ?? [];
    const validPrevious = definition && Array.isArray(previous) && previous.every(slug => isAvailablePageSlug(definition.id, slug));
    const canonicalPath = definition && isPublicPagePath(definition.id, entry.path) ? entry.path : null;
    return {
      id: entry.pageId,
      sourceVersion: entry.sourceVersion,
      canonicalPath,
      aliases: definition && canonicalPath && validPrevious ? publicPageAliases(definition, canonicalPath, previous) : null,
    };
  }));
  // Programs use a different public id field while sharing the cmsPosts family.
  exactVersions("cmsPosts", [
    ...value.posts.map((entry) => ({
      id: entry.postId,
      sourceVersion: entry.sourceVersion,
      canonicalPath: projectedCanonicalPath(entry.path, entry.slug, postPublicPath),
      aliases: projectedAliases(entry.previousSlugs, postPublicPath),
    })),
    ...(value.events ?? []).map((entry) => ({
      id: entry.eventId, sourceVersion: entry.sourceVersion,
      canonicalPath: projectedCanonicalPath(entry.path, entry.slug, eventPublicPath),
      aliases: projectedAliases(entry.previousSlugs, eventPublicPath),
    })),
    ...value.programs.map((entry) => ({
      id: entry.programId,
      sourceVersion: entry.sourceVersion,
      canonicalPath: projectedCanonicalPath(entry.path, entry.slug, programPublicPath),
      aliases: projectedAliases(entry.previousSlugs, programPublicPath),
    })),
    ...(value.recordCards ?? []).flatMap(card => {
      if ((card.kind !== "sponsor" && card.kind !== "newsletter") || card.sourceVersion === undefined) return [];
      return [{ id: card.id, sourceVersion: card.sourceVersion, canonicalPath: null, aliases: [] }];
    }),
  ]);
  exactVersions("cmsAuthorProfilesPublic", value.authors.map((entry) => ({
    id: entry.authorId,
    sourceVersion: entry.sourceVersion,
    canonicalPath: projectedCanonicalPath(entry.path, entry.slug, authorPublicPath),
    aliases: projectedAliases(entry.previousSlugs, authorPublicPath),
  })));
  // A navigation snapshot that failed the contract at cutoff is rendered from
  // the seed. The receipt still names its exact version and records the fallback.
  exactVersions("cmsSettings", [
    ...value.settings.map((entry) => ({
      id: entry.settingId,
      sourceVersion: entry.sourceVersion,
      canonicalPath: "/",
      aliases: [],
    })),
    ...(receipt.settingsFallbacks ?? []).map((fallback) => ({
      id: fallback.documentId,
      sourceVersion: fallback.sourceVersion,
      canonicalPath: "/",
      aliases: [],
    })),
  ]);
  const programImageDescriptors = value.programImageDescriptors === undefined ? undefined :
    assertProgramImageCatalog(value.programImageDescriptors, value.programs as unknown as CmsProgramBuildData[], {
      rendererSha: receipt.commitSha, buildBatchId: receipt.buildBatchId, generation: receipt.generation,
      mediaManifestDigest: receipt.mediaManifestDigest,
    });
  for (const file of programImageDescriptors?.files ?? []) {
    if (createHash("sha256").update(programImageBytes(file)).digest("hex") !== file.digest) {
      throw new ProgramImagePreparationError("program_image_integrity");
    }
  }
  return {
    schemaVersion: PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION,
    ...(programImageDescriptors === undefined ? {} : { programImageDescriptors }),
    pages: value.pages as unknown as CmsPageBuildData[],
    posts: value.posts as unknown as CmsPostBuildData[],
    programs: value.programs as unknown as CmsProgramBuildData[],
    ...(value.recordCards === undefined ? {} : { recordCards: value.recordCards as unknown as RecordCardPayload[] }),
    ...(value.events === undefined ? {} : { events: value.events as unknown as CmsEventBuildData[] }),
    authors: value.authors as unknown as CmsAuthorBuildData[],
    settings: value.settings as unknown as PublicSettingBuildData[],
    receipt,
    ...(homeSources === undefined ? {} : { homeSources }),
  };
}

export function resolvePublicArtifactBundlePath(env: Env = process.env): string | null {
  const buildBatchId = (env.PUBLIC_BUILD_BATCH_ID ?? "").trim();
  const bundlePath = (env.PUBLIC_ARTIFACT_BUNDLE_PATH ?? "").trim();
  const bundleVersion = (env.PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION ?? "").trim();
  if (buildBatchId === "" && bundlePath === "" && bundleVersion === "") return null;
  if (
    buildBatchId === "" ||
    bundlePath === "" ||
    bundleVersion !== String(PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION) ||
    !path.isAbsolute(bundlePath)
  ) {
    throw new Error("The public artifact bundle configuration is incomplete");
  }
  return bundlePath;
}

export function normalizePublicArtifactBundle(value: unknown): PublicArtifactBundle {
  // A saved preview can reuse a public context written before Programs moved
  // from /shows/ to /programs/. Normalize its route and receipt together before
  // the normal exact-coverage check; malformed routes still fail that check.
  if (plainObject(value) && Array.isArray(value.programs) && plainObject(value.receipt)) {
    const oldPrograms = value.programs.filter(program => plainObject(program) &&
      typeof program.slug === "string" && program.path === `/shows/${program.slug}/`);
    if (oldPrograms.length > 0) {
      const oldIds = new Set(oldPrograms.map(program => program.programId));
      value.programs = value.programs.map(program => plainObject(program) && oldIds.has(program.programId)
        ? { ...program, path: programPublicPath(String(program.slug)) }
        : program);
      if (Array.isArray(value.receipt.families)) {
        value.receipt = { ...value.receipt, families: value.receipt.families.map(family =>
          plainObject(family) && family.collection === "cmsPosts" && Array.isArray(family.artifacts)
            ? { ...family, artifacts: family.artifacts.map(artifact =>
              plainObject(artifact) && oldIds.has(artifact.documentId)
                ? { ...artifact,
                    canonicalPath: typeof artifact.canonicalPath === "string" ? artifact.canonicalPath.replace(/^\/shows\//, "/programs/") : artifact.canonicalPath,
                    aliases: Array.isArray(artifact.aliases) ? artifact.aliases.map(alias => typeof alias === "string" ? alias.replace(/^\/shows\//, "/programs/") : alias) : artifact.aliases }
                : artifact) }
            : family) };
      }
    }
    value.programs = (value.programs as unknown[]).map(program => plainObject(program) ? {
      ...program,
      keyArt: program.keyArt ?? null,
      keyArtAlt: program.keyArtAlt ?? "",
      keyArtDecorative: program.keyArtDecorative ?? false,
      watchUrl: program.watchUrl ?? null,
    } : program);
    const receipt = value.receipt as Record<string, unknown>;
    if (isDeepStrictEqual(receipt.aggregateRoutes, ["/posts/", "/staff/"]) ||
        isDeepStrictEqual(receipt.aggregateRoutes, ["/posts/", "/programs/", "/staff/"])) {
      value.receipt = { ...receipt, aggregateRoutes: ["/posts/", "/programs/", "/events/", "/staff/"] };
    }
  }
  const bundle = assertPublicArtifactBundle(value);
  // Older private renderer/rollback/migration validators retain their exact v3
  // shape. Only the typed record receiver reads the internal catalog directly.
  const { programImageDescriptors: _privateProgramImages, ...legacy } = bundle;
  return legacy;
}

export async function readPublicArtifactBundle(
  inputPath: string,
  env: Env = process.env,
): Promise<PublicArtifactBundle> {
  if (!path.isAbsolute(inputPath)) {
    throw new Error("The public artifact bundle path must be absolute");
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(inputPath, "utf8"));
  } catch {
    throw new Error("The public artifact bundle is missing or invalid");
  }
  const bundle = normalizePublicArtifactBundle(value);
  const expectedBatchId = (env.PUBLIC_BUILD_BATCH_ID ?? "").trim();
  const expectedCommitSha = (env.PUBLIC_BUILD_COMMIT_SHA ?? "").trim();
  if (
    (expectedBatchId !== "" && bundle.receipt.buildBatchId !== expectedBatchId) ||
    (expectedCommitSha !== "" && bundle.receipt.commitSha !== expectedCommitSha)
  ) {
    throw new Error("The public artifact bundle belongs to another build");
  }
  return bundle;
}

export async function writePublicArtifactBundle(
  outputPath: string,
  value: PublicArtifactBundle,
): Promise<void> {
  if (!path.isAbsolute(outputPath)) {
    throw new Error("The public artifact bundle path must be absolute");
  }
  const canonical = assertPublicArtifactBundle(value);
  const temporaryPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(canonical)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}
