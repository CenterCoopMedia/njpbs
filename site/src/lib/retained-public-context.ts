import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertPublicArtifactBundle, normalizePublicArtifactBundle, type PublicArtifactBundle } from "./public-artifact-bundle.ts";
import { prepareProgramImageCatalog } from "../../scripts/prepare-published-record-images.ts";
import { ProgramImagePreparationError } from "./published-record-images.ts";
import { canonicalPublicationReceipt } from "./public-publication-receipt.ts";

/** The caller obtains the current receipt from the verified public Worker.
 * A bundle's own inventory is not evidence that it is the active deployment.
 */
export function assertContextMatchesPublication(context: unknown, publication: unknown): PublicArtifactBundle {
  const live = canonicalPublicationReceipt(publication);
  // The live digest covers the receipt as it was written. Hash it before an
  // older context is normalized to the current route shape.
  const writtenReceipt = context !== null && typeof context === "object"
    ? (context as { receipt?: unknown }).receipt
    : undefined;
  const digest = createHash("sha256").update(JSON.stringify(writtenReceipt) ?? "").digest("hex");
  const bundle = normalizePublicArtifactBundle(structuredClone(context));
  const receipt = bundle.receipt;
  if (receipt.buildBatchId !== live.buildBatchId || receipt.generation !== live.generation ||
      receipt.commitSha !== live.commitSha || receipt.mediaManifestDigest !== live.mediaManifestDigest ||
      digest !== live.artifactReceiptDigest) {
    throw new Error("Retained public context does not match the current publication");
  }
  return bundle;
}

async function privateContextDirectory(outputPath: string, distDirectory: string): Promise<string> {
  if (!path.isAbsolute(outputPath) || path.basename(outputPath) !== "public-context.json") {
    throw new Error("Retained public context requires its fixed private filename");
  }
  const directory = path.dirname(outputPath);
  const status = await lstat(directory);
  if (!status.isDirectory() || (status.mode & 0o077) !== 0 || status.uid !== process.getuid?.()) {
    throw new Error("Retained public context requires an owner-only directory");
  }
  const [resolved, dist] = await Promise.all([realpath(directory), realpath(distDirectory)]);
  const relative = path.relative(dist, resolved);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("Retained public context must stay outside the public artifact");
  }
  return path.join(resolved, "public-context.json");
}

export async function readPrivateContextBytes(file: string): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const status = await handle.stat();
    if (!status.isFile() || (status.mode & 0o077) !== 0 || status.uid !== process.getuid?.()) {
      throw new Error("Retained public context must be an owner-only regular file");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export interface PairedProgramDescriptorReaders {
  "node-compute": { rendererSha: string; schemaVersion: 1 };
  cloudflare: { rendererSha: string; schemaVersion: 1 };
}

/** Retain one immutable private copy after the public build passes its inventory
 * checks. A completed file appears atomically; only an exact retry may reuse it.
 */
export async function retainPublicContext({ bundle, outputPath, distDirectory, programImageReaders }: {
  bundle: PublicArtifactBundle;
  outputPath: string;
  distDirectory: string;
  /** Dormant until a trusted caller supplies verified paired publisher support. */
  programImageReaders?: PairedProgramDescriptorReaders;
}): Promise<void> {
  const output = await privateContextDirectory(outputPath, distDirectory);
  let homeSources = bundle.homeSources;
  try {
    const rendered = JSON.parse(await readFile(path.join(distDirectory, "_home-sources.json"), "utf8"));
    homeSources = rendered;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (bundle.pages.some(page => page.pageId === "home" && page.homeCompositionVersion === 2 && page.blocks.some(block =>
      block.type === "content_shelf"))) {
      throw new Error("Curated Home requires its rendered published source catalog.");
    }
  }
  const validated = assertPublicArtifactBundle({ ...bundle,
    ...(homeSources === undefined ? {} : { homeSources }) });
  const { programImageDescriptors: _internalProgramImages, ...legacy } = validated;
  let retained: PublicArtifactBundle = legacy;
  if (programImageReaders !== undefined) {
    if (!programImageReaders || typeof programImageReaders !== "object" || Array.isArray(programImageReaders) ||
        Object.keys(programImageReaders).length !== 2 ||
        ["node-compute", "cloudflare"].some(owner => {
          const reader = programImageReaders[owner as keyof PairedProgramDescriptorReaders];
          return !reader || typeof reader !== "object" || Array.isArray(reader) || Object.keys(reader).length !== 2 ||
            reader.rendererSha !== legacy.receipt.commitSha || reader.schemaVersion !== 1;
        })) throw new ProgramImagePreparationError("program_image_contract");
    const programImageDescriptors = await prepareProgramImageCatalog({ bundle: legacy, distDirectory });
    retained = assertPublicArtifactBundle({ ...legacy, programImageDescriptors });
  }
  const bytes = Buffer.from(`${JSON.stringify(retained)}\n`);
  if (programImageReaders !== undefined && bytes.length > 16 * 1024 * 1024) throw new ProgramImagePreparationError("program_image_cap_exceeded");
  const temporary = path.join(path.dirname(output), `.public-context.${randomUUID()}.tmp`);
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  try {
    try {
      await link(temporary, output);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await readPrivateContextBytes(output)).equals(bytes)) {
        throw new Error("Retained public context cannot be replaced by different content");
      }
    }
  } finally {
    await unlink(temporary);
  }
}

export async function readRetainedPublicContext(file: string, publication: unknown): Promise<PublicArtifactBundle> {
  const bytes = await readPrivateContextBytes(file);
  return assertContextMatchesPublication(JSON.parse(bytes.toString("utf8")), publication);
}
