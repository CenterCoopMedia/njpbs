// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { projectCmsProgram } from "../src/lib/cms-programs-projection";
import { createPublicArtifactInventoryReceipt } from "../src/lib/public-artifact-inventory";
import { prepareProgramImageCatalog } from "../scripts/prepare-published-record-images";
import { retainPublicContext } from "../src/lib/retained-public-context";
import { PROGRAM_IMAGE_FILE_LIMIT } from "../src/lib/published-record-images";
import { recordDocument, recordAsset, now } from "./fixtures/published-records/fixtures";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(url = "/_astro/a.png") {
  const root = await mkdtemp(path.join(tmpdir(), "program-image-preparation-")); roots.push(root);
  const distDirectory = path.join(root, "dist"); const directory = path.join(root, "private");
  await mkdir(path.join(distDirectory, "programs/current-program-one"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(distDirectory, "_astro"), { mode: 0o700 }); await mkdir(directory, { mode: 0o700 });
  const document = recordDocument("program"); const asset = recordAsset("png");
  const program = projectCmsProgram(document, { now, assets: new Map([[asset.id, asset]]) })!;
  const cutoffAt = { seconds: Math.floor(now.getTime() / 1000), nanoseconds: 0, toMillis: () => now.getTime() };
  const bundle = { schemaVersion: 3 as const, pages: [], posts: [], programs: [program], authors: [], settings: [],
    receipt: createPublicArtifactInventoryReceipt({ reservation: { schemaVersion: 1, buildBatchId: "record-image-test", generation: 1,
      status: "reserved", commitSha: "a".repeat(40), reservedAgainstGeneration: 0, reservedAgainstDeploymentId: null,
      reservedAgainstCommitSha: null, cutoffAt, reservedAt: cutoffAt }, pages: [], posts: [], programs: [{ documentId: document.id,
        sourceVersion: 7, kind: "program", canonicalPath: program.path, aliases: program.previousSlugs.map(slug => `/programs/${slug}/`),
        publishedSnapshot: document.published }], authors: [], settings: [] }) };
  const picture = `<picture class="program__art"><source type="image/avif" srcset="/_astro/a.avif 960w"><source type="image/webp" srcset="/_astro/a.webp 960w"><img src="${url}" srcset="/_astro/a.png 960w" sizes="100vw" width="960" height="540"></picture>`;
  await writeFile(path.join(distDirectory, "programs/index.html"), `<a href="${program.path}">${picture}</a>`);
  await writeFile(path.join(distDirectory, "programs/current-program-one/index.html"), picture);
  for (const format of ["png", "avif", "webp"]) await writeFile(path.join(distDirectory, `_astro/a.${format}`), "abc");
  return { bundle, distDirectory, outputPath: path.join(directory, "public-context.json"), directory };
}
it.each(["/_astro/%2e%2e.png", "/_astro/%2e%2e%2foutside.png", "/_astro/a%20b.png"])("refuses descriptor %s before any path can escape _astro", async url => {
  const input = await fixture(url);
  await expect(prepareProgramImageCatalog(input)).rejects.toMatchObject({ code: "program_image_contract" });
  expect(await readdir(input.directory)).toEqual([]);
});
it("refuses an oversized derivative without truncating or replacing retained context", async () => {
  const input = await fixture();
  await retainPublicContext(input);
  const original = await readFile(input.outputPath);
  // Sparse filesystem length exercises the read bound without allocating load.
  await truncate(path.join(input.distDirectory, "_astro/a.png"), PROGRAM_IMAGE_FILE_LIMIT + 1);
  await expect(retainPublicContext({ ...input, programImageReaders: {
    "node-compute": { rendererSha: "a".repeat(40), schemaVersion: 1 }, cloudflare: { rendererSha: "a".repeat(40), schemaVersion: 1 },
  } })).rejects.toMatchObject({ code: "program_image_cap_exceeded" });
  expect(await readFile(input.outputPath)).toEqual(original);
  expect(await readdir(input.directory)).toEqual(["public-context.json"]);
});
