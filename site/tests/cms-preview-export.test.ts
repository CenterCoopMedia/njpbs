// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CMS_PREVIEW_EXPORT_COLLECTIONS, cmsPreviewExportLoader } from "../src/lib/cms-preview-export";

const directories: string[] = [];
const savedPage = { id: "contact", data: { pageId: "contact", sourceVersion: 7,
  contentMode: "draft", title: "The saved revision", blocks: [] } };
const input = { schemaVersion: 1, queueId: "a".repeat(20), pageId: "contact",
  rendererSha: "b".repeat(40), sourceVersion: 7, expiresAtMs: 4102444800000,
  collections: Object.fromEntries(CMS_PREVIEW_EXPORT_COLLECTIONS.map(name =>
    [name, name === "cmsPages" ? [savedPage] : []])) };

async function fixture(value: unknown = input) {
  const directory = await mkdtemp(path.join(tmpdir(), "cms-preview-export-"));
  directories.push(directory);
  const file = path.join(directory, "data.json");
  const bytes = JSON.stringify(value);
  await writeFile(file, bytes);
  for (const [key, value] of Object.entries({ CMS_CONTENT_MODE: "draft", SOURCE_VERSION: "7",
    CMS_PREVIEW_EXPORT_PATH: file, CMS_PREVIEW_EXPORT_SHA256: createHash("sha256").update(bytes).digest("hex"),
    CMS_PREVIEW_QUEUE_ID: input.queueId, CMS_PREVIEW_PAGE_ID: input.pageId,
    CMS_PREVIEW_RENDERER_SHA: input.rendererSha })) vi.stubEnv(key, value);
  for (const key of ["GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_SERVICE_ACCOUNT", "FIREBASE_PROJECT_ID", "FIRESTORE_EMULATOR_HOST"]) vi.stubEnv(key, undefined);
  return file;
}

async function load() {
  const entries: unknown[] = [];
  for (const collection of CMS_PREVIEW_EXPORT_COLLECTIONS) {
    await cmsPreviewExportLoader(collection)!.load({
      store: { clear: () => {}, set: (entry: unknown) => { entries.push(entry); return true; } },
      parseData: async ({ data }: { data: unknown }) => data,
    } as never);
  }
  return entries;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("CMS preview export file boundary", () => {
  it("loads the exact saved revision in all collections without database credentials", async () => {
    await fixture();
    expect(await load()).toEqual([savedPage]);
  });

  it("refuses changed artifact bytes", async () => {
    const file = await fixture();
    await writeFile(file, JSON.stringify({ ...input, sourceVersion: 8 }));
    await expect(load()).rejects.toThrow("digest does not match");
  });

  it.each([
    { queueId: "c".repeat(20) }, { pageId: "home" }, { rendererSha: "c".repeat(40) },
    { sourceVersion: 8 }, { expiresAtMs: 0 }, { collections: { cmsPages: [savedPage] } },
  ])("refuses another request, expiry or incomplete collection export: %j", async patch => {
    await fixture({ ...input, ...patch });
    await expect(load()).rejects.toThrow("identity, expiry or collections");
  });

  it.each([undefined, "published"])("refuses non-draft mode: %s", async mode => {
    await fixture();
    vi.stubEnv("CMS_CONTENT_MODE", mode);
    expect(() => cmsPreviewExportLoader("cmsPages")).toThrow("draft mode");
  });

  it.each([{ pages: [] }, { pages: [{ ...savedPage, data: { ...savedPage.data, sourceVersion: 8 } }] }])(
    "refuses a missing or different draft revision: %j", async ({ pages }) => {
      await fixture({ ...input, collections: { ...input.collections, cmsPages: pages } });
      await expect(load()).rejects.toThrow("exact saved draft");
    },
  );

  it("keeps Astro schema rejection blocking", async () => {
    await fixture();
    await expect(cmsPreviewExportLoader("cmsPages")!.load({ store: { clear: () => {}, set: () => true },
      parseData: async () => { throw new Error("Invalid page schema"); } } as never)).rejects.toThrow("Invalid page schema");
  });
});
