import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import type { PublicArtifactBundle } from "../src/lib/public-artifact-bundle";
import { assertProgramImageCatalog, programImagePath, programImageReferences, verifyProgramImageCatalog,
  PROGRAM_IMAGE_FILE_LIMIT, PROGRAM_IMAGE_CATALOG_LIMIT, ProgramImagePreparationError,
  type PreparedProgramImage, type ProgramImageCatalog, type ProgramImageFile } from "../src/lib/published-record-images.ts";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function refuse(code: ProgramImagePreparationError["code"] = "program_image_contract"): never { throw new ProgramImagePreparationError(code); }
function elements(node: Node): Element[] {
  return [...("tagName" in node ? [node] : []), ...("childNodes" in node ? node.childNodes.flatMap(elements) : [])];
}
const attribute = (node: Element, name: string) => node.attrs.find(attr => attr.name === name)?.value;
async function sealedFile(directory: string, relative: string, limit: number): Promise<Buffer> {
  const file = path.join(directory, relative);
  if (path.relative(directory, file).startsWith("..")) refuse();
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || await realpath(file) !== file) refuse("program_image_integrity");
  if (stat.size > limit) refuse("program_image_cap_exceeded");
  const bytes = await readFile(file);
  if (bytes.length !== stat.size) refuse("program_image_integrity");
  return bytes;
}
function image(picture: Element | undefined, original: NonNullable<PublicArtifactBundle["programs"][number]["keyArt"]>): PreparedProgramImage {
  if (!picture) refuse("program_image_integrity");
  const nodes = elements(picture);
  const img = nodes.find(node => node.tagName === "img");
  if (!img || attribute(img, "width") !== String(original.width) || attribute(img, "height") !== String(original.height)) refuse("program_image_integrity");
  const url = attribute(img, "src");
  if (!url) refuse("program_image_integrity");
  const srcset = attribute(img, "srcset");
  const sizes = attribute(img, "sizes");
  const sources = nodes.filter(node => node.tagName === "source").map(node => ({ type: attribute(node, "type") ?? "", srcset: attribute(node, "srcset") ?? "" }));
  return { url, mimeType: original.mimeType, width: original.width, height: original.height,
    ...(original.credit === undefined ? {} : { credit: original.credit }),
    ...(srcset === undefined ? {} : { srcset }), ...(sizes === undefined ? {} : { sizes }), ...(sources.length ? { sources } : {}) };
}

/** Capture the real responsive adapter's full-build output, never derive names or encoders again. */
export async function prepareProgramImageCatalog({ bundle, distDirectory }: { bundle: PublicArtifactBundle; distDirectory: string }): Promise<ProgramImageCatalog> {
  const directory = await realpath(distDirectory);
  const catalog: ProgramImageCatalog = { schemaVersion: 1, buildBatchId: bundle.receipt.buildBatchId,
    generation: bundle.receipt.generation, rendererSha: bundle.receipt.commitSha, mediaManifestDigest: bundle.receipt.mediaManifestDigest,
    programs: [], files: [] };
  const programs = bundle.programs.filter(program => program.keyArt);
  if (programs.length > 1000) refuse("program_image_cap_exceeded");
  if (!programs.length) return assertProgramImageCatalog(catalog, bundle.programs, { rendererSha: catalog.rendererSha });
  const index = elements(parse((await sealedFile(directory, "programs/index.html", 2 * 1024 * 1024)).toString("utf8")));
  for (const program of programs) {
    if (!/^\/programs\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(program.path)) refuse();
    const detail = elements(parse((await sealedFile(directory, `${program.path.slice(1)}index.html`, 2 * 1024 * 1024)).toString("utf8")));
    const picture = detail.find(node => node.tagName === "picture" && (attribute(node, "class") ?? "").split(" ").includes("program__art"));
    const card = index.find(node => node.tagName === "a" && attribute(node, "href") === program.path && elements(node).some(child => child.tagName === "picture"));
    const grid = card && elements(card).find(node => node.tagName === "picture");
    const original = program.keyArt!;
    catalog.programs.push({ programId: program.programId, sourceVersion: program.sourceVersion, path: program.path,
      original: { assetId: original.assetId, url: original.url, mimeType: original.mimeType, width: original.width, height: original.height,
        ...(original.credit === undefined ? {} : { credit: original.credit }) }, content: image(picture, original), grid: image(grid, original) });
  }
  const files = new Map<string, ProgramImageFile>();
  let total = 0;
  for (const program of catalog.programs) {
    for (const descriptor of [program.content, program.grid]) {
      for (const url of programImageReferences(descriptor)) {
        if (url === program.original.url && program.original.mimeType === "image/gif" || files.has(url)) continue;
        if (!programImagePath(url)) refuse("program_image_contract");
        if (files.size >= 256) refuse("program_image_cap_exceeded");
        const bytes = await sealedFile(directory, decodeURIComponent(url.slice(1)), PROGRAM_IMAGE_FILE_LIMIT);
        total += bytes.length;
        if (total > PROGRAM_IMAGE_CATALOG_LIMIT) refuse("program_image_cap_exceeded");
        const format = url.split(".").at(-1)!;
        files.set(url, { path: url, digest: hash(bytes), size: bytes.length, contentType: `image/${format === "jpg" ? "jpeg" : format}`, base64: bytes.toString("base64") });
      }
    }
  }
  catalog.files = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  assertProgramImageCatalog(catalog, bundle.programs, { rendererSha: catalog.rendererSha });
  await verifyProgramImageCatalog(catalog);
  return catalog;
}
