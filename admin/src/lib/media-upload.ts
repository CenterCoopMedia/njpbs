import type { Principal } from "../../../packages/content-core/src/rbac";
import { canUploadMedia } from "./access";
import {
  cmsListMedia,
  cmsUploadMedia,
  type UploadMediaMetadata,
  type UploadMediaResponse,
} from "./functions";

export const MAX_MEDIA_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_AUDIO_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_MEDIA_UPLOAD_BATCH_FILES = 20;

export const IMAGE_UPLOAD_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

/** Uncompressed PCM WAV, the voiceover library's format. The server checks the header. */
export const AUDIO_UPLOAD_MIME_TYPE = "audio/wav";

export const MEDIA_UPLOAD_MIME_TYPES = new Set([
  ...IMAGE_UPLOAD_MIME_TYPES,
  "application/pdf",
  AUDIO_UPLOAD_MIME_TYPE,
]);

export function validateMediaUploadFile(
  file: File,
  imagesOnly = false,
): string | null {
  const fileName = file.name.trim();
  if (fileName.length === 0) return "Choose a file with a name.";
  if (fileName.length > 255) {
    return "Choose a filename that is 255 characters or fewer.";
  }
  const hasInvalidFileNameCharacter = [...fileName].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      character === "/" ||
      character === "\\" ||
      codePoint <= 31 ||
      (codePoint >= 127 && codePoint <= 159)
    );
  });
  if (hasInvalidFileNameCharacter) {
    return "Choose a filename without control characters, slashes, or backslashes.";
  }
  const acceptedTypes = imagesOnly
    ? IMAGE_UPLOAD_MIME_TYPES
    : MEDIA_UPLOAD_MIME_TYPES;
  if (!acceptedTypes.has(file.type)) {
    return imagesOnly
      ? "Choose a JPEG, PNG, WebP, GIF, or AVIF file."
      : "Choose a JPEG, PNG, WebP, GIF, AVIF, PDF, or WAV file.";
  }
  if (file.size < 1) return "Choose a non-empty file.";
  if (file.type === AUDIO_UPLOAD_MIME_TYPE && file.size > MAX_AUDIO_UPLOAD_BYTES) {
    return "Choose a WAV file that is 10 MiB or smaller.";
  }
  if (file.size > MAX_MEDIA_UPLOAD_BYTES) {
    return "Choose a file that is 25 MB or smaller.";
  }
  return null;
}

/** A comma string from a text field, or the tag editor's tokens (one tag each). */
export function normalizeMediaTags(value: string | readonly string[]): {
  tags: string[];
  error: string | null;
} {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const part of typeof value === "string" ? value.split(",") : value) {
    const tag = part.trim();
    if (!tag) continue;
    if (tag.length > 40) {
      return { tags: [], error: "Keep each tag under 41 characters." };
    }
    const key = tag.toLocaleLowerCase("en-US");
    if (!seen.has(key)) {
      seen.add(key);
      tags.push(tag);
    }
  }
  return tags.length > 20
    ? { tags: [], error: "Use 20 tags or fewer." }
    : { tags, error: null };
}

export function defaultMediaUploadCategory(_principal: Principal): string {
  return "general";
}

export function authorizedMediaUploadCategory(
  principal: Principal,
  categories: readonly { id: string; active: boolean; canUpload: boolean }[],
): string {
  const authorized = categories.filter(
    (category) =>
      category.active &&
      category.canUpload &&
      canUploadMedia(principal, category.id),
  );
  const preferred = defaultMediaUploadCategory(principal);
  return authorized.find((category) => category.id === preferred)?.id ?? authorized[0]?.id ?? "";
}

/**
 * The asset id the server disclosed for a duplicate upload, or null. The server
 * sends `duplicateAssetId: null` when the caller may not see the existing file.
 */
export function duplicateUploadAssetId(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as {
    status?: unknown;
    data?: { duplicateAssetId?: unknown };
  };
  return candidate.status === 409 &&
    typeof candidate.data?.duplicateAssetId === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(candidate.data.duplicateAssetId)
    ? candidate.data.duplicateAssetId
    : null;
}

function isHiddenDuplicate(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { status?: unknown; data?: Record<string, unknown> };
  return (
    candidate.status === 409 &&
    candidate.data !== undefined &&
    "duplicateAssetId" in candidate.data &&
    candidate.data.duplicateAssetId === null
  );
}

export const HIDDEN_DUPLICATE_MESSAGE =
  "This file is already in the media library, in a category you cannot open. " +
  "Ask an editor who can open that category to use the existing file.";

/**
 * Upload one file, and turn a duplicate into reuse of the existing file. When the
 * server discloses the existing asset and the caller can read it, the upload
 * resolves with that asset and `reusedDuplicate: true`, so the form warns
 * instead of failing. A duplicate the caller may not see still fails, with a
 * message that says who can help.
 */
export async function uploadMediaReusingDuplicates(
  idToken: string,
  file: File,
  metadata: UploadMediaMetadata,
  signal: AbortSignal,
  onRateLimitWait?: (seconds: number) => void,
): Promise<UploadMediaResponse> {
  try {
    return await uploadPacedByRateLimit(
      () => cmsUploadMedia(idToken, file, metadata, signal),
      signal,
      onRateLimitWait,
    );
  } catch (error) {
    if (isHiddenDuplicate(error)) throw new Error(HIDDEN_DUPLICATE_MESSAGE);
    const assetId = duplicateUploadAssetId(error);
    if (!assetId) throw error;
    const asset = await cmsListMedia(idToken, { assetIds: [assetId] }, signal)
      .then((response) => response.records.find((record) => record.id === assetId))
      .catch(() => undefined);
    if (signal.aborted) throw new Error("The upload was canceled.");
    if (!asset) throw error;
    return { success: true, asset, reusedDuplicate: true };
  }
}

// The upload budget refills over time, so a large batch waits for it instead
// of failing. The server says how long to wait; the batch resumes on its own.
export const MAX_RATE_LIMIT_WAITS = 20;
const DEFAULT_RATE_LIMIT_WAIT_SECONDS = 5;
const MAX_RATE_LIMIT_WAIT_SECONDS = 60;

export function rateLimitWaitSeconds(error: unknown): number | null {
  const candidate = error as { status?: unknown; data?: Record<string, unknown> };
  if (candidate?.status !== 429) return null;
  const hinted = Number(candidate.data?.retryAfterSeconds);
  const seconds = Number.isFinite(hinted) && hinted > 0 ? hinted : DEFAULT_RATE_LIMIT_WAIT_SECONDS;
  return Math.min(Math.ceil(seconds), MAX_RATE_LIMIT_WAIT_SECONDS);
}

function waitForBudget(seconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("The upload was canceled."));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, seconds * 1000);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("The upload was canceled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function uploadPacedByRateLimit<T>(
  send: () => Promise<T>,
  signal: AbortSignal,
  onRateLimitWait?: (seconds: number) => void,
): Promise<T> {
  for (let waits = 0; ; waits += 1) {
    try {
      return await send();
    } catch (error) {
      const seconds = rateLimitWaitSeconds(error);
      if (seconds === null || waits >= MAX_RATE_LIMIT_WAITS) throw error;
      onRateLimitWait?.(seconds);
      await waitForBudget(seconds, signal);
    }
  }
}

export function reusedUploadMessage(fileName: string, assetName: string): string {
  return (
    `${fileName} is already in the media library as "${assetName}". ` +
    "The existing file was used. The details entered for this upload were not saved; " +
    "edit the existing file to change them."
  );
}
