import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveCmsResponsiveAssets, resolveCmsResponsiveImage, type CmsImageOptimizer } from "../src/lib/cms-responsive-image";
import { newsletterSignupResolution } from "../src/lib/newsletter-signup";
import type { PublicArtifactBundle } from "../src/lib/public-artifact-bundle";

export const MAX_RETAINED_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_BYTES = MAX_RETAINED_IMAGE_BYTES;
const MAX_TOTAL_BYTES = 96 * 1024 * 1024;
const MAX_IMAGES = 256;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif", "image/svg+xml"]);
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export const retainedImageManifestFile = "remote-images.json";
interface Identity { buildBatchId: string; commitSha: string }
interface ImageReceipt { url: string; file: string; digest: string; size: number; contentType: string }
interface ImageManifest extends Identity { schemaVersion: 1; images: ImageReceipt[] }

function imageLocation(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      ((url.hostname === "media.njpbs.org" && url.pathname.startsWith("/cms-media/")) ||
        (url.hostname === "njpbs.org" && url.pathname.startsWith("/brand/"))) ? url : null;
  } catch { return null; }
}
function admittedImageUrl(value: string): boolean {
  const url = imageLocation(value);
  return Boolean(url && !url.username && !url.password && !url.port && !url.search && !url.hash);
}

async function optimizedImages(bundle: PublicArtifactBundle): Promise<Set<string>> {
  const urls = new Set<string>();
  // Use the rendering adapters themselves to select optimizer inputs. Post
  // body/lead images, author photos and feed thumbnails remain public originals.
  const observe: CmsImageOptimizer = async ({ src }) => {
    if (imageLocation(src)) {
      if (!admittedImageUrl(src)) throw new Error("Public image URL has credentials or mutable arguments");
      urls.add(new URL(src).href);
    }
    return { src, srcSet: { attribute: "" } };
  };
  const records = bundle.recordCards ?? [];
  for (const page of bundle.pages ?? []) {
    await resolveCmsResponsiveAssets(page.blocks ?? [], page.assets ?? {}, observe);
    await newsletterSignupResolution(page.blocks ?? [], observe, page.pageId === "kids" ? records.filter(record => record.kind !== "newsletter") : records);
  }
  for (const program of bundle.programs ?? []) {
    if (program.keyArt) await resolveCmsResponsiveImage(program.keyArt, "content", observe);
  }
  for (const post of bundle.posts ?? []) await newsletterSignupResolution(post.blocks ?? [], observe, records);
  return urls;
}

async function imageBytes(response: Response): Promise<Buffer> {
  if (!response.ok || !response.body) throw new Error("Public image freeze request failed");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_IMAGE_BYTES) throw new Error("Public image exceeds its checkpoint bound");
      chunks.push(Buffer.from(next.value));
    }
  } finally { await reader.cancel(); }
  if (!size) throw new Error("Public image is empty");
  return Buffer.concat(chunks);
}

/** Fetch public originals only in the online operator, before input is sealed. */
export async function freezeRetainedPublicImages(directory: string, identity: Identity, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const input = await readFile(path.join(directory, "input.json"));
  if (input.length > 16 * 1024 * 1024) throw new Error("Public image input exceeds its bound");
  const urls = await optimizedImages(JSON.parse(input.toString("utf8")) as PublicArtifactBundle);
  if (urls.size > MAX_IMAGES) throw new Error("Public image count exceeds its checkpoint bound");
  await mkdir(path.join(directory, "images"), { recursive: true, mode: 0o700 });
  const images: ImageReceipt[] = [];
  let total = 0;
  for (const url of [...urls].sort()) {
    const signal = AbortSignal.timeout(120_000);
    let target = url;
    let response: Response | undefined;
    for (let hop = 0; hop < 4; hop++) {
      response = await fetchImpl(target, { redirect: "manual", signal });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("Public image redirect is missing");
      target = new URL(location, target).href;
      if (!admittedImageUrl(target)) throw new Error("Public image redirect is outside the allowlist");
    }
    if (!response || !response.ok) throw new Error("Public image freeze request failed");
    const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
    if (!IMAGE_TYPES.has(contentType)) { await response.body?.cancel(); throw new Error("Public image MIME type differs"); }
    const bytes = await imageBytes(response);
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new Error("Public images exceed their checkpoint bound");
    const digest = hash(bytes);
    const file = `images/${digest}`;
    await writeFile(path.join(directory, file), bytes, { mode: 0o600 });
    images.push({ url, file, digest, size: bytes.length, contentType });
  }
  await writeFile(path.join(directory, retainedImageManifestFile), JSON.stringify({ schemaVersion: 1, ...identity, images }), { mode: 0o600 });
  return [retainedImageManifestFile, ...new Set(images.map(image => image.file))];
}

async function readManifest(manifestPath: string, identity: Identity): Promise<ImageManifest> {
  const stat = await lstat(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error("Invalid retained image manifest");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ImageManifest;
  if (manifest?.schemaVersion !== 1 || manifest.buildBatchId !== identity.buildBatchId || manifest.commitSha !== identity.commitSha ||
      !Array.isArray(manifest.images) || manifest.images.length > MAX_IMAGES) throw new Error("Retained image identity differs");
  const urls = new Set<string>();
  let total = 0;
  for (const image of manifest.images) {
    if (!image || typeof image.url !== "string" || !admittedImageUrl(image.url) || urls.has(image.url) ||
        !/^[a-f0-9]{64}$/.test(image.digest) || image.file !== `images/${image.digest}` ||
        !Number.isSafeInteger(image.size) || image.size <= 0 || image.size > MAX_IMAGE_BYTES || !IMAGE_TYPES.has(image.contentType)) {
      throw new Error("Invalid retained image receipt");
    }
    urls.add(image.url); total += image.size;
  }
  if (total > MAX_TOTAL_BYTES) throw new Error("Retained images exceed their bound");
  return manifest;
}

/** The image catalog must be complete inside the same immutable checkpoint. */
export async function assertRetainedImageCheckpoint(directory: string, identity: Identity,
  files: { path: string; digest: string; size: number }[]) {
  if (!files.some(file => file.path === retainedImageManifestFile)) return;
  const manifest = await readManifest(path.join(directory, retainedImageManifestFile), identity);
  const retained = new Map(files.filter(file => file.path.startsWith("images/")).map(file => [file.path, file]));
  for (const image of manifest.images) {
    const file = retained.get(image.file);
    if (!file || file.digest !== image.digest || file.size !== image.size) throw new Error("Retained image checkpoint is incomplete");
  }
  if (retained.size !== new Set(manifest.images.map(image => image.file)).size) throw new Error("Retained image checkpoint has extra files");
}

/** Preview requires the complete original media roster even without Astro. */
export async function assertRetainedPreviewImages(directory: string, bundle: PublicArtifactBundle) {
  const manifest = await readManifest(path.join(directory, retainedImageManifestFile), bundle.receipt);
  const required = await optimizedImages(bundle);
  if (manifest.images.length !== required.size || manifest.images.some(image => !required.has(image.url))) {
    throw new Error("Preview media catalog is incomplete");
  }
  for (const image of manifest.images) {
    const bytes = await readFile(path.join(directory, image.file));
    if (bytes.length !== image.size || hash(bytes) !== image.digest) throw new Error("Preview media bytes differ");
  }
}

/** Astro receives the sealed bytes for admitted remote images on both owners.
 * Provider requests in the online operator keep their existing fetch boundary. */
export async function installRetainedPublicImages(manifestPath: string, identity: Identity): Promise<() => void> {
  const manifest = await readManifest(manifestPath, identity);
  const directory = path.dirname(manifestPath);
  const images = new Map<string, { bytes: Buffer; contentType: string }>();
  for (const image of manifest.images) {
    const file = path.join(directory, image.file);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== image.size || await realpath(file) !== file) throw new Error("Invalid retained image file");
    const bytes = await readFile(file);
    if (bytes.length !== image.size || hash(bytes) !== image.digest) throw new Error("Retained image bytes differ");
    images.set(image.url, { bytes, contentType: image.contentType });
  }
  const previous = globalThis.fetch;
  const retainedFetch: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!imageLocation(url)) return previous.call(globalThis, input, init);
    if (!admittedImageUrl(url)) throw new Error("Invalid retained public image URL");
    const image = images.get(new URL(url).href);
    if (!image) throw new Error("Public image is missing from retained input");
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (!["GET", "HEAD"].includes(method)) throw new Error("Invalid retained image request");
    return new Response(method === "HEAD" ? null : new Uint8Array(image.bytes), { status: 200, headers: {
      "content-type": image.contentType, "content-length": String(image.bytes.length), "cache-control": "public, max-age=31536000, immutable",
    } });
  };
  globalThis.fetch = retainedFetch;
  return () => { if (globalThis.fetch === retainedFetch) globalThis.fetch = previous; };
}
