import { contentLinkReadFits } from "../../../packages/content-core/src/content-link.ts";
import type { PublishedPostContent } from "./published-post-shadow";
import { projectChrome } from "./published-post-shadow";
import { projectCmsProgram, type CmsProgramBuildData } from "./cms-programs-projection";
import { projectCmsEvent, type CmsEventBuildData } from "./cms-events-projection";
import { exportRecordCards } from "./record-card-resolution";
import { assertProgramImageCatalog, verifyProgramImageCatalog, ProgramImagePreparationError,
  type ProgramImageCatalog } from "./published-record-images";

export type PublicRecordFamily = "programs" | "events";
export type PublishedRecordContent = Omit<PublishedPostContent, "kind" | "target"> & {
  readonly kind: "public-record-family";
  readonly target: Readonly<{ family: PublicRecordFamily; documentId: string | null; sourceVersion: number | null;
    pagePath: string; rendererSha: string; contextRevision: number; contextDigest: string; renderedAt: string }>;
  readonly events: readonly CmsEventBuildData[];
  readonly programImageDescriptors?: ProgramImageCatalog;
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
async function digest(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
export function recordPaths(family: PublicRecordFamily, record: CmsProgramBuildData | CmsEventBuildData): string[] {
  const slugs = [record.slug, ...record.previousSlugs];
  return slugs.flatMap(slug => family === "programs" ? [`/programs/${slug}/`, `/shows/${slug}/`] : [`/events/${slug}/`]);
}

/** Pure route ownership over frozen published records. No catalog byte reads,
 * SDK or provider requests; parent receipt verification shares this boundary. */
export function projectPublishedRecordRoute(input: unknown, path: string, now: Date) {
  if (!object(input) || input.kind !== "published-record-family" || !["programs", "events"].includes(String(input.family)) ||
      input.complete !== true || !Array.isArray(input.documents) || input.documents.length > 1000 ||
      !Array.isArray(input.assets) || input.assets.length > 1000 || !Number.isFinite(now.getTime())) {
    throw new Error("Invalid published record route input");
  }
  const family = input.family as PublicRecordFamily;
  const index = path === `/${family}/` || family === "programs" && path === "/shows/";
  if (!index && !(family === "programs" ? /^\/(programs|shows)\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/ : /^\/events\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/).test(path)) {
    throw new Error("Invalid published record route");
  }
  const assets = new Map<string, Record<string, unknown>>();
  for (const asset of input.assets) {
    if (!object(asset) || !validId(asset.id) || assets.has(asset.id)) throw new Error("Invalid record media");
    assets.set(asset.id, structuredClone(asset));
  }
  const programs: CmsProgramBuildData[] = [];
  const events: CmsEventBuildData[] = [];
  const seen = new Set<string>();
  const owners = new Map<string, CmsProgramBuildData | CmsEventBuildData>();
  for (const raw of input.documents) {
    if (!object(raw) || !validId(raw.id) || seen.has(raw.id)) throw new Error("Invalid record identity");
    seen.add(raw.id);
    const doc = structuredClone(raw);
    if (object(doc.published) && object(doc.published.metadata) && doc.published.metadata.type !== (family === "programs" ? "program" : "event")) {
      throw new Error("Record family differs");
    }
    const record = family === "programs" ? projectCmsProgram(doc as never, { now, assets }) : projectCmsEvent(doc as never, { now, assets: assets as never });
    if (!record) continue;
    if (doc.version !== undefined && (!Number.isSafeInteger(doc.version) || record.sourceVersion > Number(doc.version)) ||
        doc.publicSourceVersion !== undefined && (!Number.isSafeInteger(doc.publicSourceVersion) || record.sourceVersion < Number(doc.publicSourceVersion))) {
      throw new Error("Published record source differs");
    }
    if (family === "programs") programs.push(record as CmsProgramBuildData); else events.push(record as CmsEventBuildData);
    for (const route of recordPaths(family, record)) {
      if (owners.has(route)) throw new Error("Published record routes collide");
      owners.set(route, record);
    }
  }
  const target = index ? null : owners.get(path);
  if (!index && !target) return null;
  return { family, programs, events, target: target ?? null };
}

/** Complete authoritative family reads, never working documents, own indexes.
 * The caller owns database authority, media fences and after-render revalidation. */
export async function projectPublishedRecordRead(input: unknown, path: string, rendererSha: string,
  now: Date): Promise<PublishedRecordContent | null> {
  if (!object(input) || input.kind !== "published-record-family" || !["programs", "events"].includes(String(input.family)) ||
      input.complete !== true || !Array.isArray(input.documents) || input.documents.length > 1000 ||
      !Array.isArray(input.assets) || input.assets.length > 1000 || !object(input.sourceSeal) ||
      input.sourceSeal.rendererSha !== rendererSha || !/^[a-f0-9]{40}$/.test(rendererSha) ||
      !Number.isSafeInteger(input.sourceSeal.contextRevision) || Number(input.sourceSeal.contextRevision) < 1 ||
      input.sourceSeal.contextDigest !== await digest(`njpbs-public-context-v1:${input.sourceSeal.contextRevision}`) ||
      !Number.isFinite(now.getTime()) || !contentLinkReadFits(input, 8 * 1024 * 1024)) {
    throw new Error("Invalid published record family read");
  }
  const projected = projectPublishedRecordRoute(input, path, now);
  if (!projected) return null;
  const { family, programs, events, target } = projected;
  let programImageDescriptors: ProgramImageCatalog | undefined;
  if (family === "programs" && input.programImageDescriptors !== undefined) {
    programImageDescriptors = assertProgramImageCatalog(structuredClone(input.programImageDescriptors), programs, { rendererSha });
    await verifyProgramImageCatalog(programImageDescriptors);
  }
  if (programs.some(program => program.keyArt && program.keyArt.mimeType !== "image/gif") && !programImageDescriptors) {
    throw new ProgramImagePreparationError("program_image_contract");
  }
  return freeze({ kind: "public-record-family", target: { family,
    documentId: target ? ("programId" in target ? target.programId : target.eventId) : null,
    sourceVersion: target?.sourceVersion ?? null, pagePath: path, rendererSha,
    contextRevision: Number(input.sourceSeal.contextRevision), contextDigest: String(input.sourceSeal.contextDigest), renderedAt: now.toISOString() },
    pages: [], posts: [], authors: [], programs, events, ...projectChrome(input),
    recordCards: exportRecordCards([], programs, now, [], events),
    ...(programImageDescriptors ? { programImageDescriptors } : {}) });
}
