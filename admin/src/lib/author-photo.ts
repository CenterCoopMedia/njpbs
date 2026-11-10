// Profile photographs, on the browser side: what a file has to satisfy before it
// is worth uploading, and how one reaches the media library.
//
// Two things this module is careful about.
//
// It does not open a second upload road. A profile photograph goes through the
// existing `cmsUploadMedia` boundary (#204) with the ordinary multipart contract,
// so content-hash staging, the immutable original, the duplicate claim lease, and
// the tombstone fence all apply unchanged. What is different is only the metadata
// it fixes: the category is always the staff-profile one, and the license is the
// rights attestation the person chose. The server re-checks every one of those,
// and the checks below exist so someone is told "that image is too small" before a
// five megabyte round trip, not instead of the server saying so.
//
// Profile uploads retain the source binary required by the author-photo policy.
// The 1:1 crop does not encode again: it is stored as a focal point and applied
// at render time.
import {
  AUTHOR_PHOTO_CATEGORY,
  AUTHOR_PHOTO_LICENSE_BY_BASIS,
  AUTHOR_PHOTO_MAX_BYTES,
  AUTHOR_PHOTO_MIME_TYPES,
  AUTHOR_PHOTO_MIN_DIMENSION,
  AUTHOR_PHOTO_RIGHTS_BASES,
  type AuthorPhotoRightsBasis,
} from "../../../packages/content-core/src/author-profiles";
import {
  cmsListMedia,
  cmsUploadMedia,
  type MediaAssetSummary,
} from "./functions";
import { duplicateUploadAssetId } from "./media-upload";

export {
  AUTHOR_PHOTO_CATEGORY,
  AUTHOR_PHOTO_MAX_BYTES,
  AUTHOR_PHOTO_MIN_DIMENSION,
};

export const AUTHOR_PHOTO_ACCEPT = AUTHOR_PHOTO_MIME_TYPES.join(",");

export function authorPhotoRightsBasisForLicense(
  license: string | null,
): AuthorPhotoRightsBasis | null {
  for (const basis of AUTHOR_PHOTO_RIGHTS_BASES) {
    if (AUTHOR_PHOTO_LICENSE_BY_BASIS[basis] === license) return basis;
  }
  return null;
}

/** Plain-language label and attestation sentence for each rights basis. */
export const AUTHOR_PHOTO_BASIS_LABELS: Record<
  AuthorPhotoRightsBasis,
  { label: string; description: string }
> = {
  "own-photo": {
    label: "It is my own photo",
    description:
      "You took it, or you had it taken for you, and NJ PBS may publish it.",
  },
  "station-photo": {
    label: "NJ PBS or Montclair State took it",
    description: "A staff or university photographer made this photo.",
  },
  "licensed-photo": {
    label: "Someone else took it and licensed it",
    description: "A photographer outside the station. Add their credit below.",
  },
};

export function authorPhotoMegabytes(): number {
  return Math.round(AUTHOR_PHOTO_MAX_BYTES / (1024 * 1024));
}

export interface PhotoFileCheck {
  ok: boolean;
  error: string | null;
  width: number | null;
  height: number | null;
}

/**
 * Read the dimensions of a chosen file from the decoded image rather than its
 * name or type. Resolves null when the browser cannot decode it at all, which is
 * itself an answer: a file no browser will draw is not a photograph to upload.
 */
async function readImageSize(
  file: Blob,
): Promise<{ width: number; height: number } | null> {
  const createBitmap = (
    globalThis as { createImageBitmap?: (blob: Blob) => Promise<ImageBitmap> }
  ).createImageBitmap;
  if (typeof createBitmap !== "function") return null;
  try {
    const bitmap = await createBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close?.();
    return size;
  } catch {
    return null;
  }
}

/**
 * The pre-flight a chosen file has to pass. Type and size are decided from the
 * file itself; dimensions are decided from the decoded image when the browser can
 * decode one, and skipped rather than guessed when it cannot -- the server checks
 * the pixels either way, so a missing client answer costs a round trip, not a
 * bad photograph.
 */
export async function checkAuthorPhotoFile(file: File): Promise<PhotoFileCheck> {
  const failure = (error: string): PhotoFileCheck => ({
    ok: false,
    error,
    width: null,
    height: null,
  });
  if (!(AUTHOR_PHOTO_MIME_TYPES as readonly string[]).includes(file.type)) {
    return failure("Choose a JPEG, PNG, WebP or AVIF image.");
  }
  if (file.size > AUTHOR_PHOTO_MAX_BYTES) {
    return failure(`Choose a photo under ${authorPhotoMegabytes()} MB.`);
  }
  if (file.size === 0) {
    return failure("That file is empty. Choose another photo.");
  }
  const size = await readImageSize(file);
  if (!size) return { ok: true, error: null, width: null, height: null };
  if (
    size.width < AUTHOR_PHOTO_MIN_DIMENSION ||
    size.height < AUTHOR_PHOTO_MIN_DIMENSION
  ) {
    return {
      ok: false,
      error: `Choose a photo at least ${AUTHOR_PHOTO_MIN_DIMENSION} pixels wide and ${AUTHOR_PHOTO_MIN_DIMENSION} pixels tall.`,
      width: size.width,
      height: size.height,
    };
  }
  return { ok: true, error: null, width: size.width, height: size.height };
}

async function reusableAuthorPhoto(
  idToken: string,
  assetId: string,
): Promise<MediaAssetSummary | null> {
  const query = {
    q: assetId,
    categories: [AUTHOR_PHOTO_CATEGORY],
    kinds: ["image" as const],
    sort: "updatedAt" as const,
    direction: "desc" as const,
    page: 1,
  };
  // The general attempt reads the exact id in any category, so a file that was
  // taken out of the staff-profile category is still reused.
  const attempts = [
    { ...query, profilePhotoScope: "self" as const },
    { ...query, q: "", categories: [], assetIds: [assetId] },
  ];
  for (const attempt of attempts) {
    try {
      const response = await cmsListMedia(idToken, attempt);
      const asset = response.records.find((record) => record.id === assetId);
      if (asset) return asset;
    } catch {
      // A contributor cannot use the general library, while an admin may need it
      // when the existing file was uploaded by another staff member.
    }
  }
  return null;
}

/**
 * Send one profile photograph to the media library. The category and the license
 * are fixed here rather than offered as fields: this path exists so a staff member
 * can set their own head shot without the general media form, and a caller who
 * could choose the category would be choosing which part of the library to write
 * to. The server enforces the same two things, so this is convenience, not the
 * boundary.
 */
export async function uploadAuthorPhoto(
  idToken: string,
  file: File,
  {
    displayName,
    rightsBasis,
    credit,
    signal,
  }: {
    displayName: string;
    rightsBasis: AuthorPhotoRightsBasis;
    credit?: string | null;
    signal?: AbortSignal;
  },
): Promise<{ asset: MediaAssetSummary }> {
  const name = displayName.trim() || "Staff member";
  try {
    return await cmsUploadMedia(
      idToken,
      file,
      {
        name: `Profile photo: ${name}`.slice(0, 180),
        category: AUTHOR_PHOTO_CATEGORY,
        // The alt text of a portrait is the person. Anything longer describes the
        // photograph rather than telling a screen-reader user whose face it is.
        altText: name,
        license: AUTHOR_PHOTO_LICENSE_BY_BASIS[rightsBasis],
        ...(credit && credit.trim() !== "" ? { credit: credit.trim() } : {}),
      },
      signal,
    );
  } catch (error) {
    const assetId = duplicateUploadAssetId(error);
    if (!assetId) throw error;
    const asset = await reusableAuthorPhoto(idToken, assetId);
    if (!asset) throw error;
    return { asset };
  }
}
