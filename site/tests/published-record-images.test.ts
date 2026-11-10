// @vitest-environment node
import { describe, expect, it } from "vitest";
import { assertProgramImageCatalog, verifyProgramImageCatalog, programImagePath, programImageBytes,
  ProgramImagePreparationError, PROGRAM_IMAGE_FILE_LIMIT, PROGRAM_IMAGE_DESCRIPTOR_LIMIT, PROGRAM_IMAGE_CATALOG_LIMIT } from "../src/lib/published-record-images";

const rendererSha = "a".repeat(40);
const original = { assetId: "art", url: "https://media.njpbs.org/cms-media/art/original.png", mimeType: "image/png", width: 960, height: 540 };
const program = { programId: "program-one", sourceVersion: 7, path: "/programs/public-program/", keyArt: original };
function fixture() {
  const image = { url: "/_astro/a.png", mimeType: "image/png", width: 960, height: 540, srcset: "/_astro/a.png 960w", sizes: "100vw",
    sources: [{ type: "image/avif", srcset: "/_astro/a.avif 960w" }, { type: "image/webp", srcset: "/_astro/a.webp 960w" }] };
  return { schemaVersion: 1 as const, buildBatchId: "image-proof", generation: 1, rendererSha, mediaManifestDigest: "b".repeat(64),
    programs: [{ programId: program.programId, sourceVersion: 7, path: program.path, original, content: image, grid: image }],
    files: ["png", "avif", "webp"].map(format => ({ path: `/_astro/a.${format}`, contentType: `image/${format}`, size: 3, base64: "YWJj",
      // SHA-256's standard ASCII "abc" vector, independent of this implementation.
      digest: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" })) };
}
function validate(value: unknown) { return assertProgramImageCatalog(value, [program], { rendererSha }); }

describe("private prepared Program image catalog", () => {
  it("round-trips the binary vector and verifies digests on read", async () => {
    const catalog = validate(fixture());
    expect(new TextDecoder().decode(programImageBytes(catalog.files[0]))).toBe("abc");
    await verifyProgramImageCatalog(catalog);
    const corrupt = structuredClone(catalog);
    corrupt.files[0].base64 = "YWJk";
    await expect(verifyProgramImageCatalog(corrupt)).rejects.toMatchObject({ code: "program_image_integrity" });
  });
  it("rejects source, missing-file and metadata mismatches", () => {
    const value = fixture();
    expect(() => assertProgramImageCatalog(value, [program], { rendererSha: "b".repeat(40) })).toThrow(ProgramImagePreparationError);
    expect(() => validate({ ...value, files: value.files.slice(1) })).toThrow(ProgramImagePreparationError);
    const stale = structuredClone(value); stale.programs[0].sourceVersion = 8;
    expect(() => validate(stale)).toThrow(ProgramImagePreparationError);
  });
  it("refuses file, descriptor and bundle overflow before decoding large data", () => {
    // Oversized declared lengths exercise the defensive budget without allocating
    // artificial load on a CI host. Every overflow refuses rather than truncates.
    const file = fixture(); file.files[0].size = PROGRAM_IMAGE_FILE_LIMIT + 1;
    expect(() => validate(file)).toThrow("program_image_cap_exceeded");
    const descriptor = fixture(); descriptor.files[0].size = PROGRAM_IMAGE_DESCRIPTOR_LIMIT;
    expect(() => validate(descriptor)).toThrow("program_image_cap_exceeded");
    const bundle = fixture(); bundle.files.forEach(file => { file.size = PROGRAM_IMAGE_FILE_LIMIT; });
    expect(bundle.files.reduce((sum, file) => sum + file.size, 0)).toBeGreaterThan(PROGRAM_IMAGE_CATALOG_LIMIT);
    expect(() => validate(bundle)).toThrow("program_image_cap_exceeded");
  });
  it.each(["/_astro/%2e%2e.png", "/_astro/%2e%2e%2foutside.png", "/_astro/a%20b.png", "/_astro/../outside.png"])("refuses encoded/traversal filename %s", path => {
    expect(programImagePath(path)).toBe(false);
    const escaped = fixture(); escaped.files[0].path = path;
    expect(() => validate(escaped)).toThrow("program_image_contract");
  });
  it("accepts .jpg as image/jpeg without changing bytes", async () => {
    const value = fixture(); value.files[0].path = "/_astro/a.jpg"; value.files[0].contentType = "image/jpeg";
    value.programs[0].content.url = "/_astro/a.jpg"; value.programs[0].content.srcset = "/_astro/a.jpg 960w";
    value.programs[0].grid.url = "/_astro/a.jpg"; value.programs[0].grid.srcset = "/_astro/a.jpg 960w";
    await verifyProgramImageCatalog(validate(value));
  });
});
