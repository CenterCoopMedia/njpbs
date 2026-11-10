import { DEFAULT_SITE_NAVIGATION } from "../../packages/content-core/src/cms-settings";
import type { PostsBrowseConfig } from "../../packages/content-core/src/posts-browse";
import homeSelection from "./fixtures/home-v2-selections.json";
import { parseBlocks, type PageBlock } from "../../packages/content-core/src/content-model";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { createCurrentCodeContextReader } from "../scripts/cms-current-code-context";
import { createPublicArtifactInventoryReceipt } from "../src/lib/public-artifact-inventory";
import targets from "../../functions/lib/publication-target.js";
import { handlePrivateRecordCode } from "../../cms-api/src/record-code";
import { createHomeNewsletterBlock } from "../../packages/content-core/src/home-newsletter-section";
import home from "./fixtures/home-composition-v1.json";
const generated = createRequire(import.meta.url)("../../functions/lib/home-retained-sources.js");
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
function fixture(homeBlocks?: PageBlock[] | boolean, postsBrowse?: PostsBrowseConfig) {
  const timestamp = { seconds: 1_780_000_000, nanoseconds: 0, toMillis: () => 1_780_000_000_000 };
  const reservation = { schemaVersion: 1 as const, buildBatchId: "cms-" + "C".repeat(20), generation: 1, status: "reserved" as const,
    commitSha: "a".repeat(40), reservedAgainstGeneration: 0, reservedAgainstDeploymentId: null, reservedAgainstCommitSha: null, cutoffAt: timestamp, reservedAt: timestamp };
  const blocks = Array.isArray(homeBlocks) ? homeBlocks : [...home.blocks, createHomeNewsletterBlock("empty-newsletter")].map((block, order) => ({ ...block, order }));
  const pages = homeBlocks ? [{ pageId: "home", path: "/", previousSlugs: [], sourceVersion: 7, homeCompositionVersion: 2, blocks }] : [];
  const values = { ...DEFAULT_SITE_NAVIGATION, postsBrowse };
  const publishedAt = "2026-05-01T12:00:00.000Z";
  const settings = postsBrowse ? [{ documentId: "site-navigation" as const, sourceVersion: 2,
    publishedSnapshot: { schemaVersion: 2, sourceVersion: 2, publishedAt, values } }] : [];
  const input = { schemaVersion: 3, pages, posts: [], programs: [], authors: [], settings: postsBrowse ? [{ settingId: "site-navigation", ...values, sourceVersion: 2, publishedAt }] : [], receipt:
    createPublicArtifactInventoryReceipt({ reservation, pages: homeBlocks ? [{ documentId: "home", sourceVersion: 7,
      publishedSnapshot: { blocks, metadata: { title: "Home", homeCompositionVersion: 2 }, sourceVersion: 7 } }] : [],
      posts: [], programs: [], authors: [], settings }) };
  const bytes = Buffer.from(JSON.stringify(input)), publication = { schemaVersion: 1, digestAlgorithm: "sha256", buildBatchId: reservation.buildBatchId,
    generation: reservation.generation, commitSha: reservation.commitSha, artifactDigest: "d".repeat(64), artifactReceiptDigest: digest(JSON.stringify(input.receipt)), mediaManifestDigest: input.receipt.mediaManifestDigest };
  const manifest = { schemaVersion: 1, buildBatchId: publication.buildBatchId, artifactReceiptDigest: publication.artifactReceiptDigest,
    byteLength: bytes.length, sha256: digest(bytes), key: `public-context/${publication.buildBatchId}/${digest(bytes)}.json` };
  return { input, bytes, reference: { publication, manifest } };
}
function reader(wire: unknown, request = vi.fn(async () => Response.json(wire)), create = createCurrentCodeContextReader) {
  return { request, source: create({ target: targets.publicationTarget("development"), rendererSha: "a".repeat(40),
    firestore: { projectId: "njpbs-site-dev" }, readSecret: () => "synthetic", request }) };
}
describe("qualified current CODE Node boundary", () => {
  it.each([createCurrentCodeContextReader, generated.createCurrentCodeContextReader])("reads v2 Posts browsing through source and generated retained readers", async createReader => {
    const postsBrowse: PostsBrowseConfig = { groups: [{ id: "schools", label: "Schools", icon: "heart", terms: [{ filter: "category", value: "Education" }] }] };
    const f = fixture(undefined, postsBrowse);
    const wire = { schemaVersion: 1, kind: "current-code", reference: f.reference, bytes: f.bytes.toString("base64") };
    const result = await reader(wire, undefined, createReader).source.readCurrentCodeContext();
    expect(result.publicContext.settings.find(setting => setting.settingId === "site-navigation")).toHaveProperty("postsBrowse", postsBrowse);
  });
  it.each([createCurrentCodeContextReader, generated.createCurrentCodeContextReader])("accepts a published empty Home slot through source and deployed current CODE readers", async createReader => {
    const f = fixture(true);
    const source = createReader({ target: targets.publicationTarget("development"), rendererSha: "a".repeat(40),
      firestore: { projectId: "njpbs-site-dev" }, readSecret: () => "synthetic",
      request: async () => Response.json({ schemaVersion: 1, kind: "current-code", reference: f.reference, bytes: f.bytes.toString("base64") }) });
    const result = await source.readCurrentCodeContext();
    expect(result.publicContext.pages[0].blocks.at(-1)).toMatchObject({ section: "home-newsletter", data: { newsletterIds: [] } });
  });
  it.each(["two_features", "list"])("accepts a %s Home through the deployed generated reader and source reader", async presentation => {
    const blocks = structuredClone(homeSelection.home.blocks);
    for (const block of blocks) if (block.type === "content_shelf") Object.assign(block.data, { presentation });
    const parsed = parseBlocks(blocks);
    if (!parsed.ok) throw new Error(parsed.error);
    const f = fixture(parsed.blocks);
    const wire = { schemaVersion: 1, kind: "current-code", reference: f.reference, bytes: f.bytes.toString("base64") };
    for (const create of [createCurrentCodeContextReader, generated.createCurrentCodeContextReader]) {
      const result = await reader(wire, undefined, create).source.readCurrentCodeContext();
      expect(result.publicContext.pages[0].blocks).toEqual(parsed.blocks);
      expect(result.publicContext.pages[0].homeCompositionVersion).toBe(2);
    }
  });
  it("roundtrips a sealed reference through the authenticated API without CODE bytes", async () => {
    const f = fixture();
    const request: typeof fetch = async (url, init) => handlePrivateRecordCode(new Request(String(url), init), {
      CMS_EDGE_ORIGIN_SECRET: "synthetic", FIREBASE_PROJECT_ID: "njpbs-site-dev", CMS_DEPLOYMENT_ENVIRONMENT: "development",
      FUNCTIONS_ORIGIN: "https://us-central1-njpbs-site-dev.cloudfunctions.net", ADMIN_ORIGIN: "https://dev-admin.example.org",
      PREVIEW_RENDERER: { readCurrentCodeReference: async () => f.reference } });
    expect(await reader(undefined, request as any).source.readCurrentCodeReference()).toEqual(f.reference);
  });
  it.each(["browser", "wrong secret", "caller key", "foreign target"])("refuses %s on the reference-only private channel", async reason => {
    const f = fixture();
    const headers: Record<string, string> = { "content-type": "application/json", "x-njpbs-cms-edge": reason === "wrong secret" ? "wrong" : "synthetic" };
    if (reason === "browser") headers.origin = "https://admin.njpbs.org";
    const request = new Request("https://api.example.org/_internal/record-code", {
      method: "POST", headers, body: JSON.stringify({ mode: "current-code-reference", rendererSha: "a".repeat(40),
        ...(reason === "caller key" ? { key: f.reference.manifest.key } : {}) }) });
    // Happy DOM strips forbidden request headers at construction. The server
    // boundary must receive the Origin sent by a browser, as a real Worker does.
    if (reason === "browser") {
      request.headers.set("origin", headers.origin);
      expect(request.headers.has("origin")).toBe(true);
    }
    const response = await handlePrivateRecordCode(request, {
      CMS_EDGE_ORIGIN_SECRET: "synthetic", FIREBASE_PROJECT_ID: reason === "foreign target" ? "njpbs-site-dev" : "njpbs-site",
      FUNCTIONS_ORIGIN: "https://us-central1-njpbs-site.cloudfunctions.net",
      PREVIEW_RENDERER: { readCurrentCodeReference: async () => f.reference } });
    expect(response.status).toBe(reason === "foreign target" ? 503 : reason === "caller key" ? 400 : 403);
    expect(await response.text()).not.toContain(f.reference.manifest.key);
  });
  it("refuses malformed and foreign reference replies before cache qualification", async () => {
    const f = fixture();
    for (const reference of [{ ...f.reference, arbitrary: true }, { ...f.reference,
      publication: { ...f.reference.publication, commitSha: "b".repeat(40) } }]) {
      await expect(reader({ schemaVersion: 1, kind: "current-code-reference", reference }).source.readCurrentCodeReference()).rejects.toThrow();
    }
  });
  it("roundtrips an actual16MiB qualified CODE body through API base64 and the Node transport/validator", async () => {
    const f = fixture(), maximum = 16 * 1024 * 1024, bytes = Buffer.alloc(maximum, 32);
    f.bytes.copy(bytes);
    const reference = structuredClone(f.reference); reference.manifest.byteLength = maximum;
    reference.manifest.sha256 = digest(bytes); reference.manifest.key = `public-context/${reference.publication.buildBatchId}/${digest(bytes)}.json`;
    const readCurrentCode = vi.fn(async () => ({ reference, bytes }));
    const request: typeof fetch = async (url, init) => handlePrivateRecordCode(new Request(String(url), init), {
      CMS_EDGE_ORIGIN_SECRET: "synthetic", FIREBASE_PROJECT_ID: "njpbs-site-dev", CMS_DEPLOYMENT_ENVIRONMENT: "development",
      FUNCTIONS_ORIGIN: "https://us-central1-njpbs-site-dev.cloudfunctions.net", ADMIN_ORIGIN: "https://dev-admin.example.org",
      PREVIEW_RENDERER: { readCurrentCode } });
    const r = reader(undefined, request as any), result = await r.source.readCurrentCodeContext();
    expect(result.publicContext.receipt).toEqual(f.input.receipt); expect(result.publication).toEqual(reference.publication);
    expect(readCurrentCode).toHaveBeenCalledOnce();
  });
  it("refuses raw16MiB+1 at the API without emitting a larger wire", async () => {
    const response = await handlePrivateRecordCode(new Request("https://api.example.org/_internal/record-code", {
      method: "POST", headers: { "content-type": "application/json", "x-njpbs-cms-edge": "synthetic" },
      body: JSON.stringify({ mode: "current-code", rendererSha: "a".repeat(40) }) }), {
      CMS_EDGE_ORIGIN_SECRET: "synthetic", FIREBASE_PROJECT_ID: "njpbs-site", FUNCTIONS_ORIGIN: "https://us-central1-njpbs-site.cloudfunctions.net",
      PREVIEW_RENDERER: { readCurrentCode: async () => ({ reference: {}, bytes: new Uint8Array(16 * 1024 * 1024 + 1) }) } });
    expect(response.status).toBe(503); expect((await response.text()).length).toBeLessThan(100);
  });
  it("rejects noncanonical base64 by its decode/encode roundtrip", async () => {
    const f = fixture(); await expect(reader({ schemaVersion: 1, kind: "current-code", reference: f.reference,
      bytes: f.bytes.toString("base64") + "\n" }).source.readCurrentCodeContext()).rejects.toThrow();
  });
  it("returns the full qualified DTO/publication after the existing context validator, with no caller key", async () => {
    const f = fixture(), r = reader({ schemaVersion: 1, kind: "current-code", reference: f.reference, bytes: f.bytes.toString("base64") });
    const result = await r.source.readCurrentCodeContext();
    expect(result.publication).toEqual(f.reference.publication); expect(result.publicContext.receipt).toEqual(f.input.receipt);
    const [url, options] = r.request.mock.calls[0] as any;
    expect(url).toBe("https://dev-api.example.org/_internal/record-code");
    expect(JSON.parse(options.body)).toEqual({ mode: "current-code", rendererSha: "a".repeat(40) });
  });
  it("refuses wrong bytes even if a full-looking publication/manifest is supplied", async () => {
    const f = fixture(); const bytes = Buffer.from(f.bytes); bytes[0] ^= 1;
    await expect(reader({ schemaVersion: 1, kind: "current-code", reference: f.reference, bytes: bytes.toString("base64") }).source.readCurrentCodeContext()).rejects.toThrow();
  });
  it("runs full CODE DTO validation instead of treating a hash-bound arbitrary payload as Page input", async () => {
    const f = fixture(), invalid = { ...f.input, posts: [{ draftTitle: "PRIVATE" }] }, bytes = Buffer.from(JSON.stringify(invalid));
    const reference = structuredClone(f.reference); reference.manifest.sha256 = digest(bytes); reference.manifest.byteLength = bytes.length;
    reference.manifest.key = `public-context/${reference.publication.buildBatchId}/${digest(bytes)}.json`;
    await expect(reader({ schemaVersion: 1, kind: "current-code", reference, bytes: bytes.toString("base64") }).source.readCurrentCodeContext()).rejects.toThrow();
  });
  it("refuses missing transport, a retained reply kind, and mixed environment", async () => {
    const f = fixture(); await expect(reader({ schemaVersion: 1, kind: "record-code", reference: f.reference, bytes: f.bytes.toString("base64") }).source.readCurrentCodeContext()).rejects.toThrow();
    expect(() => createCurrentCodeContextReader({ target: targets.publicationTarget("development"), rendererSha: "a".repeat(40), firestore: { projectId: "njpbs-site" } })).toThrow();
  });
});
