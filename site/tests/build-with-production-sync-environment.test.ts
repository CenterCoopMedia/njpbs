// @vitest-environment node

import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { build } from "astro";
import { tmpdir } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const buildObservation = vi.hoisted(() => ({
  cmsContentMode: "",
  cmsPreviewPageId: "",
  firebaseProjectId: "",
  root: "",
}));
const imageBoundary = vi.hoisted(() => ({ restore: vi.fn(), install: vi.fn() }));
vi.mock("../scripts/retained-public-images.ts", () => ({ installRetainedPublicImages: imageBoundary.install }));
const scheduleBoundary = vi.hoisted(() => ({ sync: vi.fn(async () => {}) }));
vi.mock("../scripts/sync-schedule.mjs", () => ({ main: scheduleBoundary.sync }));

vi.mock("astro", () => ({
  build: vi.fn(async ({ root }: { root: string }) => {
    buildObservation.cmsContentMode = process.env.CMS_CONTENT_MODE ?? "missing";
    buildObservation.cmsPreviewPageId =
      process.env.CMS_PREVIEW_PAGE_ID ?? "missing";
    buildObservation.firebaseProjectId =
      process.env.FIREBASE_PROJECT_ID ?? "missing";
    buildObservation.root = root;
  }),
}));

vi.mock("../src/lib/public-artifact-build.ts", () => ({ preparePublicArtifactBundle: vi.fn() }));
vi.mock("../src/lib/retained-public-context.ts", () => ({ retainPublicContext: vi.fn() }));
vi.mock("../src/lib/public-artifact-bundle.ts", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/public-artifact-bundle")>(),
  readPublicArtifactBundle: vi.fn(async () => ({ receipt: { buildBatchId: "test-build" } })),
}));
vi.mock("../src/lib/public-artifact-inventory.ts", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/public-artifact-inventory")>(),
  finalizePublicArtifactInventoryReceipt: vi.fn(),
}));
vi.mock("pagefind", () => ({
  createIndex: vi.fn(async () => ({ index: { addDirectory: async () => ({}), addCustomRecord: vi.fn(async () => ({ errors: [] })), writeFiles: async () => ({}) } })),
  close: vi.fn(),
}));
vi.mock("../src/search/model", () => ({
  loadSearchEncoder: async () => Object.assign(async () => ({ data: [0.25, 0.75] }), { dispose: async () => {} }),
}));

import { runBuild } from "../scripts/build-with-production-sync.mjs";
import { meaningSearchIndex } from "../src/search/build-corpus";
import { createIndex } from "pagefind";
import { retainPublicContext } from "../src/lib/retained-public-context";
import { finalizePublicArtifactInventoryReceipt } from "../src/lib/public-artifact-inventory";
import { readPublicArtifactBundle } from "../src/lib/public-artifact-bundle";

const originalEnvironment = {
  CMS_CONTENT_MODE: process.env.CMS_CONTENT_MODE,
  CMS_PREVIEW_PAGE_ID: process.env.CMS_PREVIEW_PAGE_ID,
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
};

afterEach(() => {
  for (const [field, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[field];
    else process.env[field] = value;
  }
});

describe("production-sync build environment", () => {
  it.each([false, true])("removes the build-only input while preserving custom-link search (PUBLIC_ONLY=%s)", async publicOnly => {
    const directory = fileURLToPath(new URL("../dist/", import.meta.url));
    const input = path.join(directory, "search/content-links.json");
    const backup = await mkdtemp(path.join(path.dirname(directory), ".search-build-test-"));
    const hadDist = existsSync(directory);
    if (hadDist) await rename(directory, path.join(backup, "dist"));
    const records = [true, false].map((newTab, index) => ({
      path: index ? "/contact/" : "/posts/linked-story/",
      title: index ? "Linked page" : "Linked post",
      text: index ? "Page description" : "Post summary",
      contentLinkMode: "custom",
      contentLinkUrl: `https://example.test/report-${index}?edition=nj`,
      contentLinkNewTab: newTab,
    }));
    vi.mocked(createIndex).mockClear();
    vi.mocked(build).mockImplementationOnce(async () => {
      await mkdir(path.dirname(input), { recursive: true });
      await writeFile(input, JSON.stringify(records));
      const hook = meaningSearchIndex().hooks["astro:build:done"]!;
      await (hook as (options: { dir: URL }) => Promise<void>)({ dir: pathToFileURL(`${directory}/`) });
      // Full builds retain it for Pagefind; direct rollback builds remove it.
      expect(existsSync(input)).toBe(!publicOnly);
    });
    try {
      await runBuild({ PUBLIC_ONLY: publicOnly ? "1" : undefined, CMS_PREVIEW_INPUT_PATH: undefined });
      expect(existsSync(input)).toBe(false);
      if (publicOnly) {
        expect(createIndex).not.toHaveBeenCalled();
        return;
      }
      const semantic = JSON.parse(await readFile(path.join(directory, "search/meaning-index.json"), "utf8"));
      expect(semantic.passages).toEqual(records.map(record => ({
        id: createHash("sha256").update(`${record.path}\n${record.title}\n${record.text}`).digest("hex").slice(0, 24),
        url: record.path, title: record.title, text: record.text,
        contentLinkUrl: record.contentLinkUrl, contentLinkNewTab: record.contentLinkNewTab,
        vector: [0.25, 0.75],
      })));
      const { index } = await vi.mocked(createIndex).mock.results.at(-1)!.value;
      expect(index!.addCustomRecord).toHaveBeenCalledTimes(records.length);
      for (const record of records) expect(index!.addCustomRecord).toHaveBeenCalledWith({
        url: record.path, content: `${record.title} ${record.text}`, language: "en",
        meta: { title: record.title, contentLinkUrl: record.contentLinkUrl, contentLinkNewTab: String(record.contentLinkNewTab) },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
      if (hadDist) await rename(path.join(backup, "dist"), directory);
      await rm(backup, { recursive: true, force: true });
    }
  });

  it("finishes the Workers production schedule bake before invoking Astro", async () => {
    scheduleBoundary.sync.mockClear();
    vi.mocked(build).mockClear();
    await runBuild({ CMS_CONTENT_MODE: "published", PUBLIC_ONLY: "1", WORKERS_CI: "1", WORKERS_CI_BRANCH: "production" });
    expect(scheduleBoundary.sync).toHaveBeenCalledOnce();
    expect(build).toHaveBeenCalledOnce();
    expect(scheduleBoundary.sync.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(build).mock.invocationCallOrder[0]);
  });
  it("installs retained images before Astro, uses a cold cache and restores the image boundary after failure", async () => {
    const commitSha = "a".repeat(40);
    const previousReady = process.env.CMS_RETAINED_IMAGES_READY;
    imageBoundary.restore.mockClear();
    imageBoundary.install.mockResolvedValueOnce(imageBoundary.restore);
    vi.mocked(readPublicArtifactBundle).mockResolvedValueOnce({ receipt: { buildBatchId: "test-build", commitSha } } as never);
    vi.mocked(build).mockImplementationOnce(async config => {
      expect(process.env.CMS_OFFLINE_BUILD).toBe("1");
      expect(process.env.CMS_RETAINED_IMAGES_READY).toBe("1");
      expect(String(config.cacheDir)).toContain(tmpdir());
      expect(String(config.cacheDir)).not.toBe(path.join(process.cwd(), "node_modules/.astro"));
      throw new Error("Astro fixture failure");
    });
    await expect(runBuild({ CMS_CONTENT_MODE: "published", CMS_OFFLINE_BUILD: "1", PUBLIC_ARTIFACT_BATCH_MODE: "background",
      PUBLIC_BUILD_BATCH_ID: "test-build", PUBLIC_BUILD_COMMIT_SHA: commitSha,
      PUBLIC_ARTIFACT_INVENTORY_PATH: "/tmp/fixture-inventory.json", PUBLIC_POST_RENDERER_COMPILE: "0",
      PUBLIC_ARTIFACT_RETAINED_BUNDLE_PATH: "/tmp/fixture-input.json", PUBLIC_ARTIFACT_RETAINED_IMAGES_PATH: "/tmp/fixture-images.json" }))
      .rejects.toThrow("Astro fixture failure");
    expect(imageBoundary.install).toHaveBeenCalledWith("/tmp/fixture-images.json", { buildBatchId: "test-build", commitSha });
    expect(imageBoundary.restore).toHaveBeenCalledOnce();
    expect(process.env.CMS_RETAINED_IMAGES_READY).toBe(previousReady);
  });
  it("retains the exact build bundle only after the public inventory check succeeds", async () => {
    vi.mocked(retainPublicContext).mockClear();
    vi.mocked(execFileSync).mockClear();
    const env = { CMS_CONTENT_MODE: "published", PUBLIC_BUILD_BATCH_ID: "test-build",
      PUBLIC_BUILD_COMMIT_SHA: "a".repeat(40), PUBLIC_ARTIFACT_INVENTORY_PATH: "/tmp/test-inventory.json",
      PUBLIC_ARTIFACT_RETAINED_CONTEXT_PATH: "/tmp/test-private/public-context.json",
      PUBLIC_GA4_MEASUREMENT_ID: "G-TEST123", PUBLIC_REPORT_ENDPOINT: "https://report.example.test/",
      PUBLIC_TURNSTILE_SITEKEY: "public-test-sitekey", FIREBASE_SERVICE_ACCOUNT: "private-placeholder" };
    await runBuild(env);
    const compiler = vi.mocked(execFileSync).mock.calls.find(call =>
      Array.isArray(call[1]) && call[1].some(argument => argument.endsWith("build-public-post-renderer.ts")));
    const compilerEnv = (compiler?.[2] as { env: Record<string, string> }).env;
    expect(compilerEnv).toMatchObject({ PUBLIC_GA4_MEASUREMENT_ID: "G-TEST123",
      PUBLIC_REPORT_ENDPOINT: "https://report.example.test/", PUBLIC_TURNSTILE_SITEKEY: "public-test-sitekey" });
    expect(compilerEnv).not.toHaveProperty("FIREBASE_SERVICE_ACCOUNT");
    expect(retainPublicContext).toHaveBeenCalledWith({ bundle: { receipt: { buildBatchId: "test-build" } },
      outputPath: env.PUBLIC_ARTIFACT_RETAINED_CONTEXT_PATH,
      distDirectory: fileURLToPath(new URL("../dist", import.meta.url)) });
    expect(vi.mocked(finalizePublicArtifactInventoryReceipt).mock.invocationCallOrder.at(-1))
      .toBeLessThan(vi.mocked(retainPublicContext).mock.invocationCallOrder.at(-1)!);
    vi.mocked(retainPublicContext).mockClear();
    vi.mocked(finalizePublicArtifactInventoryReceipt).mockRejectedValueOnce(new Error("Inventory failed"));
    await expect(runBuild(env)).rejects.toThrow("Inventory failed");
    expect(retainPublicContext).not.toHaveBeenCalled();
  });

  it("refuses context retention without the complete published-build identity", async () => {
    await expect(runBuild({ PUBLIC_ARTIFACT_RETAINED_CONTEXT_PATH: "/tmp/public-context.json" }))
      .rejects.toThrow(/requires an exact public artifact build/);
  });

  it("applies the supplied environment during build and restores ambient values", async () => {
    process.env.CMS_CONTENT_MODE = "draft";
    process.env.CMS_PREVIEW_PAGE_ID = "stale-preview";
    process.env.FIREBASE_PROJECT_ID = "ambient-project";

    await runBuild({
      PUBLIC_ONLY: "1",
      CMS_CONTENT_MODE: "published",
      CMS_PREVIEW_PAGE_ID: undefined,
      FIREBASE_PROJECT_ID: "njpbs-site",
    });

    expect(buildObservation).toEqual({
      cmsContentMode: "published",
      cmsPreviewPageId: "missing",
      firebaseProjectId: "njpbs-site",
      root: fileURLToPath(new URL("..", import.meta.url)),
    });
    expect(process.env.CMS_CONTENT_MODE).toBe("draft");
    expect(process.env.CMS_PREVIEW_PAGE_ID).toBe("stale-preview");
    expect(process.env.FIREBASE_PROJECT_ID).toBe("ambient-project");
  });
});
