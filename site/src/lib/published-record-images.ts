/** Private prepared Program art; public HTML receives descriptors only. */
export const PROGRAM_IMAGE_FILE_LIMIT = 2 * 1024 * 1024;
export const PROGRAM_IMAGE_DESCRIPTOR_LIMIT = 2 * 1024 * 1024;
export const PROGRAM_IMAGE_CATALOG_LIMIT = 4 * 1024 * 1024;
export const PROGRAM_IMAGE_CATALOG_JSON_LIMIT = 6 * 1024 * 1024;
export class ProgramImagePreparationError extends Error {
  readonly code: "program_image_cap_exceeded" | "program_image_integrity" | "program_image_contract";
  constructor(code: ProgramImagePreparationError["code"]) {
    super(code); this.name = "ProgramImagePreparationError"; this.code = code;
  }
}
export interface ProgramImageSource {
  programId: string; sourceVersion: number; path: string;
  keyArt: { assetId: string; url: string; mimeType: string; width: number; height: number; credit?: string } | null;
}
export interface PreparedProgramImage {
  url: string; mimeType: string; width: number; height: number; credit?: string;
  srcset?: string; sizes?: string; sources?: { type: string; srcset: string }[];
}
export interface ProgramImageFile {
  path: string; digest: string; size: number; contentType: string; base64: string;
}
export interface ProgramImageCatalog {
  schemaVersion: 1; buildBatchId: string; generation: number; rendererSha: string; mediaManifestDigest: string;
  programs: { programId: string; sourceVersion: number; path: string; original: NonNullable<ProgramImageSource["keyArt"]>;
    content: PreparedProgramImage; grid: PreparedProgramImage }[];
  files: ProgramImageFile[];
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function refuse(code: ProgramImagePreparationError["code"] = "program_image_contract"): never { throw new ProgramImagePreparationError(code); }
function fields(value: unknown, names: string[]): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some(name => !names.includes(name))) refuse();
}
function sized(value: unknown, ceiling: number): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) refuse();
  if (Number(value) > ceiling) refuse("program_image_cap_exceeded");
}
export function programImagePath(value: unknown): value is string {
  return typeof value === "string" && /^\/_astro\/[A-Za-z0-9._-]+\.(avif|webp|jpeg|jpg|png)$/.test(value) &&
    !value.includes("..") && !/%(?:2f|5c|00)/i.test(value);
}
export function programImageReferences(image: PreparedProgramImage): string[] {
  const paths = [image.url];
  for (const srcset of [image.srcset, ...(image.sources ?? []).map(source => source.srcset)]) {
    if (!srcset) continue;
    for (const candidate of srcset.split(",")) {
      const match = /^(\S+) ([1-9][0-9]*w)$/.exec(candidate.trim());
      if (!match || !programImagePath(match[1])) refuse();
      paths.push(match[1]);
    }
  }
  return [...new Set(paths)];
}
function descriptor(value: unknown, original: NonNullable<ProgramImageSource["keyArt"]>): asserts value is PreparedProgramImage {
  fields(value, ["url", "mimeType", "width", "height", "credit", "srcset", "sizes", "sources"]);
  if (value.mimeType !== original.mimeType || value.width !== original.width || value.height !== original.height ||
      value.credit !== original.credit) refuse();
  if (original.mimeType === "image/gif") {
    if (value.url !== original.url || value.srcset !== undefined || value.sizes !== undefined || value.sources !== undefined) refuse();
    return;
  }
  if (!programImagePath(value.url) || typeof value.srcset !== "string" || !value.srcset || value.srcset.length > 16_384 ||
      typeof value.sizes !== "string" || !value.sizes || value.sizes.length > 300 || !Array.isArray(value.sources) || value.sources.length !== 2) refuse();
  for (const [index, source] of value.sources.entries()) {
    fields(source, ["type", "srcset"]);
    if (source.type !== ["image/avif", "image/webp"][index] || typeof source.srcset !== "string" || !source.srcset || source.srcset.length > 16_384) refuse();
  }
  programImageReferences(value as unknown as PreparedProgramImage);
}

/** Validate without decoding unbounded input. Digests are checked separately on every read. */
export function assertProgramImageCatalog(value: unknown, programs: readonly ProgramImageSource[], identity: {
  buildBatchId?: string; generation?: number; rendererSha: string; mediaManifestDigest?: string;
}): ProgramImageCatalog {
  fields(value, ["schemaVersion", "buildBatchId", "generation", "rendererSha", "mediaManifestDigest", "programs", "files"]);
  if (value.schemaVersion !== 1 || typeof value.buildBatchId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value.buildBatchId) ||
      !Number.isSafeInteger(value.generation) || Number(value.generation) < 1 || value.rendererSha !== identity.rendererSha ||
      !/^[a-f0-9]{40}$/.test(String(value.rendererSha)) || !/^[a-f0-9]{64}$/.test(String(value.mediaManifestDigest)) ||
      identity.buildBatchId !== undefined && value.buildBatchId !== identity.buildBatchId ||
      identity.generation !== undefined && value.generation !== identity.generation ||
      identity.mediaManifestDigest !== undefined && value.mediaManifestDigest !== identity.mediaManifestDigest ||
      !Array.isArray(value.programs) || value.programs.length > 1000 || !Array.isArray(value.files) || value.files.length > 256) refuse();
  if (new TextEncoder().encode(JSON.stringify(value)).length > PROGRAM_IMAGE_CATALOG_JSON_LIMIT) refuse("program_image_cap_exceeded");
  const wanted = new Map<string, ProgramImageSource>();
  for (const program of programs) {
    if (!program.keyArt) continue;
    const original = program.keyArt;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(program.programId) || wanted.has(program.programId) ||
        !Number.isSafeInteger(program.sourceVersion) || program.sourceVersion < 1 ||
        !/^\/programs\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(program.path) ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(original.assetId) ||
        !["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"].includes(original.mimeType) ||
        !Number.isSafeInteger(original.width) || original.width < 1 || !Number.isSafeInteger(original.height) || original.height < 1) refuse();
    wanted.set(program.programId, program);
  }
  const seen = new Set<string>();
  const references = new Set<string>();
  const fileMap = new Map<string, ProgramImageFile>();
  let total = 0;
  for (const file of value.files) {
    fields(file, ["path", "digest", "size", "contentType", "base64"]);
    if (!programImagePath(file.path) || fileMap.has(file.path) || !/^[a-f0-9]{64}$/.test(String(file.digest)) ||
        typeof file.base64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(file.base64) || file.base64.length % 4 !== 0 ||
        file.contentType !== `image/${(file.path.endsWith(".jpeg") || file.path.endsWith(".jpg")) ? "jpeg" : file.path.split(".").at(-1)}`) refuse();
    sized(file.size, PROGRAM_IMAGE_FILE_LIMIT);
    total += file.size;
    if (total > PROGRAM_IMAGE_CATALOG_LIMIT) refuse("program_image_cap_exceeded");
    fileMap.set(file.path, file as unknown as ProgramImageFile);
  }
  for (const entry of value.programs) {
    fields(entry, ["programId", "sourceVersion", "path", "original", "content", "grid"]);
    const program = typeof entry.programId === "string" ? wanted.get(entry.programId) : undefined;
    if (!program?.keyArt || seen.has(program.programId) || entry.sourceVersion !== program.sourceVersion || entry.path !== program.path) refuse();
    fields(entry.original, ["assetId", "url", "mimeType", "width", "height", "credit"]);
    for (const key of ["assetId", "url", "mimeType", "width", "height", "credit"] as const) {
      if (entry.original[key] !== program.keyArt[key]) refuse();
    }
    for (const role of ["content", "grid"] as const) {
      descriptor(entry[role], program.keyArt);
      const paths = programImageReferences(entry[role]);
      let size = 0;
      for (const path of paths) {
        if (path === program.keyArt.url && program.keyArt.mimeType === "image/gif") continue;
        const file = fileMap.get(path);
        if (!file) refuse("program_image_integrity");
        references.add(path); size += file.size;
      }
      if (size > PROGRAM_IMAGE_DESCRIPTOR_LIMIT) refuse("program_image_cap_exceeded");
    }
    seen.add(program.programId);
  }
  if (seen.size !== wanted.size || references.size !== fileMap.size) refuse("program_image_integrity");
  return value as unknown as ProgramImageCatalog;
}
export function programImageBytes(file: ProgramImageFile): Uint8Array {
  sized(file.size, PROGRAM_IMAGE_FILE_LIMIT);
  if (file.base64.length > Math.ceil(PROGRAM_IMAGE_FILE_LIMIT / 3) * 4) refuse("program_image_cap_exceeded");
  let decoded: string;
  try { decoded = atob(file.base64); } catch { refuse("program_image_integrity"); }
  if (decoded.length !== file.size) refuse("program_image_integrity");
  return Uint8Array.from(decoded, value => value.charCodeAt(0));
}
export async function verifyProgramImageCatalog(catalog: ProgramImageCatalog): Promise<void> {
  for (const file of catalog.files) {
    const bytes = programImageBytes(file);
    const result = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
    const digest = Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, "0")).join("");
    if (digest !== file.digest) refuse("program_image_integrity");
  }
}
