import type { MediaAssetSummary, UpdateMediaMetadata } from "./functions";
import type { SourceMediaAssetSummary, updateSourceMediaMetadata } from "./source-media";

export const MAX_BULK_VIDEOS = 100;
// One image bulk change covers the same 100 items as video.
export const MAX_BULK_IMAGES = 100;
// Match the existing metadata bucket's sustained rate (one request per 2s).
export const BULK_SAVE_INTERVAL_MS = 2100;
export type MetadataPatch = Parameters<typeof updateSourceMediaMetadata>[4];
export type TextField = "description" | "credit" | "license";
export type TextChange = { mode: "keep" | "set" | "clear"; value: string };
export interface BulkMetadataDraft {
  /**
   * The bulk editor's comma or line list lives in value. The inspector's tokens use mode
   * "edit": add goes on every item and remove comes off each item that holds it.
   */
  tags: {
    mode: "keep" | "add" | "remove" | "replace" | "clear" | "edit";
    value: string;
    add?: readonly string[];
    remove?: readonly string[];
  };
  description: TextChange;
  credit: TextChange;
  license: TextChange;
  rightsStatus: "keep" | SourceMediaAssetSummary["rightsStatus"];
}
/** The image fields a bulk change may write. */
export type ImageBulkPatch = Pick<UpdateMediaMetadata, "tags" | "description" | "credit" | "license">;
/** A video carries its sourceId; an image has none, so the runner compares it as absent. */
export interface BulkAsset { id: string; version: number; sourceId?: string }
export interface BulkPlanEntry<T extends BulkAsset = SourceMediaAssetSummary, P = MetadataPatch> { asset: T; changes: P }
export interface BulkMetadataPlan<T extends BulkAsset = SourceMediaAssetSummary, P = MetadataPatch> { entries: BulkPlanEntry<T, P>[]; errors: string[] }
export interface ImageBulkPlan extends BulkMetadataPlan<MediaAssetSummary, ImageBulkPatch> {
  /** Selected images the role cannot edit, named in the review and never written. */
  excluded: { asset: MediaAssetSummary; reason: string }[];
}
export type BulkResultStatus = "pending" | "saving" | "saved" | "unchanged" | "conflict" | "failed" | "unconfirmed";
export interface BulkResult<T extends BulkAsset = SourceMediaAssetSummary, P = MetadataPatch> extends BulkPlanEntry<T, P> { status: BulkResultStatus; message: string }
export interface BulkFailure { status: "conflict" | "failed" | "unconfirmed"; message: string; stop: boolean }

export function emptyBulkMetadataDraft(): BulkMetadataDraft {
  return {
    tags: { mode: "keep", value: "" },
    description: { mode: "keep", value: "" },
    credit: { mode: "keep", value: "" },
    license: { mode: "keep", value: "" },
    rightsStatus: "keep",
  };
}

function hasTagIntent(tags: BulkMetadataDraft["tags"]) {
  return tags.mode === "edit" ? Boolean(tags.add?.length || tags.remove?.length) : tags.mode !== "keep";
}

/** Trimmed, non-empty token values from an inspector edit. */
function editList(values: readonly string[] | undefined) {
  return (values ?? []).map(value => value.trim()).filter(Boolean);
}

export function hasBulkMetadataIntent(draft: BulkMetadataDraft) {
  return hasTagIntent(draft.tags) || draft.rightsStatus !== "keep" ||
    (["description", "credit", "license"] as const).some(field => draft[field].mode !== "keep");
}

export function buildBulkMetadataPlan(sourceId: string, assets: readonly SourceMediaAssetSummary[], draft: BulkMetadataDraft): BulkMetadataPlan {
  const errors: string[] = [];
  if (!assets.length || assets.length > MAX_BULK_VIDEOS) errors.push(`Select 1–${MAX_BULK_VIDEOS} videos.`);
  if (new Set(assets.map(asset => asset.id)).size !== assets.length) errors.push("A video is selected more than once.");
  if (assets.some(asset => asset.sourceId !== sourceId || asset.kind !== "video" || !Number.isSafeInteger(asset.version) || asset.version < 1)) {
    errors.push("The selection is no longer valid for this library. Close and select the videos again.");
  }
  const edit = draft.tags.mode === "edit";
  const editAdd = edit ? editList(draft.tags.add) : [];
  const editRemove = edit ? editList(draft.tags.remove) : [];
  const tags = edit ? editAdd : draft.tags.mode === "keep" || draft.tags.mode === "clear" ? []
    : [...new Set(draft.tags.value.split(/[,\n]/).map(value => value.trim()).filter(Boolean))];
  if (!["keep", "clear", "edit"].includes(draft.tags.mode) && !tags.length) errors.push("Enter at least one tag, or choose Leave unchanged.");
  if (tags.some(tag => tag.length > 80)) errors.push("Each tag must be 80 characters or fewer.");
  for (const field of ["description", "credit", "license"] as const) {
    if (draft[field].mode !== "set") continue;
    const limit = field === "description" ? 2000 : 500;
    if (!draft[field].value.trim()) errors.push(`Enter a ${field}, or choose Clear this field.`);
    if (draft[field].value.trim().length > limit) errors.push(`${field[0].toUpperCase() + field.slice(1)} must be ${limit} characters or fewer.`);
  }
  const entries = assets.map(asset => {
    const changes: MetadataPatch = {};
    if (hasTagIntent(draft.tags)) {
      // Video tags match exactly: removing "interview" leaves "Interview".
      const next = edit ? [...new Set([...asset.tags.filter(tag => !editRemove.includes(tag)), ...editAdd])]
        : draft.tags.mode === "add" ? [...new Set([...asset.tags, ...tags])]
        : draft.tags.mode === "remove" ? asset.tags.filter(tag => !tags.includes(tag))
          : draft.tags.mode === "clear" ? [] : tags;
      if (next.length > 30) errors.push(`${asset.name}: this change would exceed 30 tags.`);
      // Tag order has no meaning. Do not create a revision just to reorder it.
      if (next.length !== asset.tags.length || next.some(tag => !asset.tags.includes(tag))) changes.tags = next;
    }
    for (const field of ["description", "credit", "license"] as const) {
      if (draft[field].mode === "keep") continue;
      const next = draft[field].mode === "clear" ? "" : draft[field].value.trim();
      if (next !== (asset[field] ?? "")) changes[field] = next;
    }
    if (draft.rightsStatus !== "keep" && draft.rightsStatus !== asset.rightsStatus) changes.rightsStatus = draft.rightsStatus;
    return { asset, changes };
  });
  return { entries, errors };
}

export function pendingBulkResults<T extends BulkAsset, P extends object>(plan: BulkMetadataPlan<T, P>): BulkResult<T, P>[] {
  return plan.entries.map(entry => ({ ...entry,
    status: Object.keys(entry.changes).length ? "pending" : "unchanged",
    message: Object.keys(entry.changes).length ? "Not saved yet" : "Already matches; no save needed",
  }));
}

export interface BulkRunPorts<T extends BulkAsset = SourceMediaAssetSummary, P = MetadataPatch> {
  save: (entry: BulkPlanEntry<T, P>) => Promise<T>;
  classifyFailure: (error: unknown) => BulkFailure;
  shouldStop: () => boolean;
  wait: () => Promise<void>;
  onProgress: (results: BulkResult<T, P>[]) => void;
}

/** No retries or parallel writes. A lost response cannot be called a failed save. */
export async function runBulkMetadataPlan<T extends BulkAsset, P extends object>(plan: BulkMetadataPlan<T, P>, ports: BulkRunPorts<T, P>): Promise<BulkResult<T, P>[]>;
// The video signature stays last, so Parameters<typeof runBulkMetadataPlan> still names video ports.
export async function runBulkMetadataPlan(plan: BulkMetadataPlan, ports: BulkRunPorts): Promise<BulkResult[]>;
export async function runBulkMetadataPlan<T extends BulkAsset, P extends object>(plan: BulkMetadataPlan<T, P>, ports: BulkRunPorts<T, P>): Promise<BulkResult<T, P>[]> {
  if (plan.errors.length) throw new Error("Fix all batch validation errors before saving.");
  const results = pendingBulkResults(plan);
  const notify = () => ports.onProgress(results.map(result => ({ ...result })));
  let attempted = false;
  for (let index = 0; index < results.length; index += 1) {
    if (results[index].status === "unchanged") continue;
    if (ports.shouldStop()) break;
    if (attempted) await ports.wait();
    if (ports.shouldStop()) break;
    const entry = results[index];
    results[index] = { ...entry, status: "saving", message: "Saving" };
    notify();
    attempted = true;
    try {
      const saved = await ports.save(entry);
      // A video must come back from the same source; an image has no source on either side.
      if (saved.id !== entry.asset.id || saved.sourceId !== entry.asset.sourceId || !Number.isSafeInteger(saved.version) || saved.version <= entry.asset.version) {
        throw new Error(`The server did not confirm this ${entry.asset.sourceId === undefined ? "image" : "video"}'s new revision.`);
      }
      results[index] = { ...entry, asset: saved, status: "saved", message: "Saved" };
    } catch (error) {
      const failure = ports.classifyFailure(error);
      results[index] = { ...entry, status: failure.status, message: failure.message };
      if (failure.stop) { notify(); break; }
    }
    notify();
  }
  return results;
}

const IMAGE_TEXT_LIMITS = { description: 2000, credit: 300, license: 120 } as const;
const MAX_IMAGE_TAGS = 20;
const MAX_IMAGE_TAG_LENGTH = 40;
const imageTagKey = (tag: string) => tag.toLocaleLowerCase("en-US");

/**
 * Keeps the first spelling of each tag in any letter case, as normalizeMediaTags and
 * functions/update-media.js do. Kept here rather than imported, so the media card and
 * selection modules that read MAX_BULK_VIDEOS do not load the upload module's requests.
 */
function dedupeImageTags(tags: readonly string[]) {
  const seen = new Set<string>();
  return tags.filter(tag => {
    const key = imageTagKey(tag);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The image bulk adapter: one cmsUpdateMediaMetadata call per image, written by the same serial
 * runner as video. Images match tags in any letter case, as normalizeMediaTags and the server
 * do, so removing a tag removes whichever spelling an image holds and adding one it holds in
 * another spelling keeps its own. Images the role cannot edit are left out and named.
 */
export function buildImageBulkPlan(
  assets: readonly MediaAssetSummary[],
  draft: Omit<BulkMetadataDraft, "rightsStatus">,
  canEdit: (asset: MediaAssetSummary) => boolean,
): ImageBulkPlan {
  const errors: string[] = [];
  const noun = assets.some(asset => asset.kind === "audio") ? "file" : "image";
  if (!assets.length || assets.length > MAX_BULK_IMAGES) errors.push(`Select 1–${MAX_BULK_IMAGES} ${noun}s.`);
  if (new Set(assets.map(asset => asset.id)).size !== assets.length) errors.push(noun === "image" ? "An image is selected more than once." : "A selected file is included more than once.");
  if (assets.some(asset => !Number.isSafeInteger(asset.version) || asset.version < 1 || !asset.etag)) {
    errors.push(`The selection is no longer valid. Close and select the ${noun}s again.`);
  }
  const editable = assets.filter(asset => canEdit(asset));
  const excluded = assets.filter(asset => !canEdit(asset)).map(asset => ({ asset, reason: `Your role cannot edit this ${asset.kind === "audio" ? "audio file" : "image"}.` }));
  if (assets.length && !editable.length) errors.push(`Your role cannot edit any of the selected ${noun}s.`);

  const key = imageTagKey;
  const mode = draft.tags.mode;
  const listed = mode === "edit" || mode === "keep" || mode === "clear" ? []
    : draft.tags.value.split(/[,\n]/).map(value => value.trim()).filter(Boolean);
  const add = mode === "edit" ? editList(draft.tags.add) : mode === "add" ? listed : [];
  const remove = new Set((mode === "edit" ? editList(draft.tags.remove) : mode === "remove" ? listed : []).map(key));
  if (["add", "remove", "replace"].includes(mode) && !listed.length) errors.push("Enter at least one tag, or choose Leave unchanged.");
  // The server's per-tag limit, with normalizeMediaTags's message.
  if ([...add, ...listed].some(tag => tag.length > MAX_IMAGE_TAG_LENGTH)) errors.push("Keep each tag under 41 characters.");
  for (const field of ["description", "credit", "license"] as const) {
    if (draft[field].mode !== "set") continue;
    const limit = IMAGE_TEXT_LIMITS[field];
    if (!draft[field].value.trim()) errors.push(`Enter a ${field}, or choose Clear this field.`);
    if (draft[field].value.trim().length > limit) errors.push(`${field[0].toUpperCase() + field.slice(1)} must be ${limit} characters or fewer.`);
  }

  const entries = editable.map(asset => {
    const changes: ImageBulkPatch = {};
    if (hasTagIntent(draft.tags)) {
      const kept = mode === "replace" ? listed : mode === "clear" ? [] : asset.tags.filter(tag => !remove.has(key(tag)));
      // The first spelling wins, so an image keeps its own spelling of a tag it already holds.
      const tags = dedupeImageTags([...kept, ...add]);
      if (tags.length > MAX_IMAGE_TAGS) errors.push(`${asset.name}: this change would exceed ${MAX_IMAGE_TAGS} tags.`);
      if (tags.length !== asset.tags.length || tags.some(tag => !asset.tags.includes(tag))) changes.tags = tags;
    }
    for (const field of ["description", "credit", "license"] as const) {
      if (draft[field].mode === "keep") continue;
      const next = draft[field].mode === "clear" ? "" : draft[field].value.trim();
      if (next !== (asset[field] ?? "")) changes[field] = next || null;
    }
    return { asset, changes };
  });
  return { entries, errors: [...new Set(errors)], excluded };
}

/** The runner's save port for images. cmsUpdateMediaMetadata sends the summary's ETag as If-Match. */
export function imageBulkSave(
  token: string,
  update: (token: string, asset: MediaAssetSummary, metadata: ImageBulkPatch) => Promise<{ asset: MediaAssetSummary }>,
): (entry: BulkPlanEntry<MediaAssetSummary, ImageBulkPatch>) => Promise<MediaAssetSummary> {
  return async entry => (await update(token, entry.asset, entry.changes)).asset;
}

function httpStatus(error: unknown): number | null {
  const status = error instanceof Error ? (error as Error & { status?: unknown }).status : undefined;
  return typeof status === "number" ? status : null;
}

/** Image saves use If-Match, so a changed image answers 412. No failure is retried. */
export function classifyImageBulkFailure(error: unknown): BulkFailure {
  const status = httpStatus(error);
  if (status === 412) return { status: "conflict", stop: false, message: "Changed elsewhere. Reopen this file and review its latest details before retrying." };
  if (status === 401 || status === 403) return { status: "failed", stop: true, message: "Access could not be verified. The batch stopped; check your access before retrying." };
  if (status === 429) return { status: "failed", stop: true, message: "The save limit was reached. The batch stopped; wait before retrying the remaining files." };
  if (status !== null && status >= 400 && status < 500 && status !== 408) return { status: "failed", stop: false, message: (error as Error).message || "This file could not be updated. Review its details before retrying." };
  return { status: "unconfirmed", stop: true, message: "The save was not confirmed and may have completed. The batch stopped. Reopen this file to check before retrying." };
}
