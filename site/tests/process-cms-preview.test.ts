// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { EditorialPreviewContextNotReadyError } from "../scripts/cms-preview-editorial-context";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createPublicArtifactInventoryReceipt } from "../src/lib/public-artifact-inventory";
import { type PublicArtifactBundle } from "../src/lib/public-artifact-bundle";
import { createRequire } from "node:module";
import { buildPrivatePreview, privatePreviewBuildEnvironment, processCmsPreview, removePrivatePreviewJob } from "../scripts/process-cms-preview";
import { preparePrivatePreview } from "../scripts/prepare-private-preview.mjs";

const directories: string[] = [];
const { previewContentKey } = createRequire(import.meta.url)("../../functions/lib/preview-target.js");
const claim = { queueId: "11111111111111111111", rendererSha: "a".repeat(40),
  serializerId: "preview-owner", claimToken: "22222222-2222-4222-8222-222222222222" };
const now = new Date("2026-09-06T04:00:00Z");
const cutoffAt = { seconds: now.getTime() / 1000, nanoseconds: 0, toMillis: () => now.getTime() };
const publicContext: PublicArtifactBundle = { schemaVersion: 3, pages: [], posts: [], programs: [], authors: [], settings: [],
  receipt: createPublicArtifactInventoryReceipt({
    reservation: { schemaVersion: 1, buildBatchId: "live-build", generation: 1, status: "reserved",
      commitSha: "b".repeat(40), reservedAgainstGeneration: 0, reservedAgainstDeploymentId: null,
      reservedAgainstCommitSha: null, cutoffAt, reservedAt: cutoffAt },
    pages: [], posts: [], programs: [], authors: [], settings: [],
  }) };

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(persistent = false, inputStorage?: Parameters<typeof processCmsPreview>[0]["inputStorage"]) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "njpbs-preview-processor-"));
  directories.push(stateDirectory);
  const order: string[] = [];
  const queue = { pageId: "contact", sourceVersion: 7, status: "pending", previewUrl: null as string | null,
    expiresAt: { toMillis: () => now.getTime() + 86_400_000 },
    snapshot: { id: "contact", version: 7, title: "Frozen contact", template: "genericPage", blocks: [] }, assets: [] };
  const previousQueue: Record<string, unknown> = { persistent: true,
    contentKey: previewContentKey("cmsPages", "contact"), status: "ready", previewUrl: "old-preview" };
  const firestore = { collection: vi.fn((name: string) => ({ doc: vi.fn((id: string) => ({
    name, id, get: vi.fn(async () => ({ data: () => queue })),
  })) })) };
  const head = { collection: "cmsPages", pageId: "contact", readyQueueId: "33333333333333333333",
    readyRequestedAtMs: now.getTime() - 300_000, cleanupQueueId: null as string | null };
  const retain = vi.fn(async () => { order.push("retain"); return true; });
  const removeRetained = vi.fn(async (_queueId: string) => { order.push("cleanup"); });
  if (persistent) {
    Object.assign(queue, { persistent: true, collection: "cmsPages", rendererSha: claim.rendererSha,
      contentKey: previewContentKey("cmsPages", "contact"), requestedAt: { toMillis: () => now.getTime() } });
    Object.assign(firestore, { runTransaction: async (run: (transaction: unknown) => Promise<unknown>) => run({
      get: async (ref: { name: string; id: string }) => ({ data: () => ref.name === "cmsPreviewHeads"
        ? head : ref.id === claim.queueId ? queue : previousQueue }),
      update: (ref: { name: string; id: string }, values: Record<string, unknown>) => {
        if (ref.name === "cmsPreviewHeads") {
          order.push(values.readyQueueId ? "head" : "clear-cleanup");
          Object.assign(head, values);
        } else {
          order.push("expire");
          Object.assign(ref.id === claim.queueId ? queue : previousQueue, values);
        }
      },
    }) });
  }
  const artifact = { previewUrl: `https://preview.njpbs.org/p/${claim.queueId}/`, pageUrl: "", files: new Map() };
  const dependencies = {
    assertSource: vi.fn(async () => { order.push("source"); }),
    claim: vi.fn(async (): Promise<{ outcome: string; status?: string }> => { order.push("claim"); return { outcome: "claimed" }; }),
    readPublicContext: vi.fn(async (): Promise<{ publicContext: PublicArtifactBundle; publication: never; verifyBeforeFreeze?: () => Promise<void> }> => {
      order.push("context"); return { publicContext, publication: {} as never };
    }),
    build: vi.fn(async (_environment: Record<string, string>, _output: string) => { order.push("build"); }),
    prepare: vi.fn(async (_input?: unknown) => { order.push("pack"); return artifact; }),
    finish: vi.fn(async (input: { status: string }) => { order.push(input.status); queue.status = input.status; return { status: input.status }; }),
  };
  const upload = vi.fn(async () => { order.push("upload"); });
  const run = (startup?: Parameters<typeof processCmsPreview>[0]["startup"]) => processCmsPreview({ firestore: firestore as never, claim, stateDirectory,
    publisherStateDirectory: "/private/publisher", upload, retain, removeRetained, inputStorage, dependencies, startup });
  return { run, queue, firestore, dependencies, upload, order, stateDirectory, head, retain, removeRetained, previousQueue };
}

it("keeps the new export ready before cleanup and resumes a lost cleanup without rebuilding", async () => {
  const test = await fixture(true);
  const previous = test.head.readyQueueId;
  test.removeRetained.mockImplementationOnce(async () => { test.order.push("cleanup"); throw new Error("cleanup interrupted"); });
  await expect(test.run()).rejects.toThrow("cleanup interrupted");
  expect(test.head).toMatchObject({ readyQueueId: claim.queueId, cleanupQueueId: previous });
  expect(test.previousQueue).toMatchObject({ status: "expired", previewUrl: null });
  expect(test.order.indexOf("expire")).toBeLessThan(test.order.indexOf("cleanup"));
  expect(test.order.indexOf("retain")).toBeGreaterThan(test.order.indexOf("ready"));
  expect(test.order.indexOf("head")).toBeGreaterThan(test.order.indexOf("retain"));
  test.dependencies.claim.mockResolvedValueOnce({ outcome: "terminal", status: "ready" });
  expect(await test.run()).toMatchObject({ status: "ready" });
  expect(test.dependencies.build).toHaveBeenCalledOnce();
  expect(test.dependencies.build.mock.calls[0][0].CMS_PREVIEW_PERSISTENT).toBe("1");
  expect(test.removeRetained).toHaveBeenLastCalledWith(previous);
  expect(test.head.cleanupQueueId).toBeNull();
});

it("expires and removes a late export rejected by the current pointer", async () => {
  const test = await fixture(true);
  const previous = test.head.readyQueueId;
  test.retain.mockResolvedValueOnce(false);
  expect(await test.run()).toMatchObject({ status: "expired" });
  expect(test.queue).toMatchObject({ status: "expired", previewUrl: null });
  expect(test.removeRetained).toHaveBeenCalledWith(claim.queueId);
  expect(test.head.readyQueueId).toBe(previous);
  expect(test.previousQueue.status).toBe("ready");
});

it("removes a failed saved export without replacing the last ready file", async () => {
  const test = await fixture(true);
  const previous = test.head.readyQueueId;
  test.dependencies.build.mockRejectedValueOnce(new Error("failed renderer"));
  expect(await test.run()).toMatchObject({ status: "failed" });
  expect(test.retain).not.toHaveBeenCalled();
  expect(test.removeRetained).toHaveBeenCalledWith(claim.queueId);
  expect(test.head.readyQueueId).toBe(previous);
});

it("claims, freezes, builds, checks source, packs and uploads before recording ready", async () => {
  const test = await fixture();
  expect(await test.run()).toEqual({ status: "ready" });
  expect(test.order).toEqual(["source", "claim", "context", "build", "source", "pack", "upload", "ready"]);
  const environment = test.dependencies.build.mock.calls[0][0];
  const input = JSON.parse(await readFile(environment.CMS_PREVIEW_INPUT_PATH, "utf8"));
  expect(input).toMatchObject({ schemaVersion: 2, queueId: claim.queueId, rendererSha: claim.rendererSha,
    pageId: "contact", sourceVersion: 7, snapshot: test.queue.snapshot, publicContext });
  expect(input).not.toHaveProperty("claimToken");
  expect(input).not.toHaveProperty("serializerId");
});

it.each([true, false])("freezes a current published Page pin without changing the retained context (visible=%s)", async visible => {
  const test = await fixture();
  test.queue.pageId = "home";
  Object.assign(test.queue.snapshot, { id: "home", template: "home", homeHero: {
    mode: "tag", source: "cms_posts", value: "home", pins: [{ source: "cms_pages", sourceId: "contact" }],
  } });
  const document = { version: 3, title: "PRIVATE later draft", status: "draft", publiclyVisible: visible,
    published: { sourceVersion: 2, publishedAt: now.toISOString(), publishedBy: "fixture", metadata: { title: "Newly published contact", description: "Public summary" }, blocks: [] } };
  Object.assign(test.firestore, { doc: (path: string) => ({ path }),
    runTransaction: async (run: (transaction: unknown) => Promise<unknown>) => run({
      get: async (ref: { path: string }) => {
        expect(ref.path).toBe("cmsPages/contact");
        return { exists: true, data: () => document };
      },
    }),
  });
  expect(await test.run()).toEqual({ status: "ready" });
  const environment = test.dependencies.build.mock.calls[0][0];
  const input = JSON.parse(await readFile(environment.CMS_PREVIEW_INPUT_PATH, "utf8"));
  expect(input.publicContext).toEqual(publicContext);
  expect(input.homeHeroPages).toHaveLength(visible ? 1 : 0);
  if (visible) expect(input.homeHeroPages[0]).toMatchObject({ pageId: "contact", title: "Newly published contact", sourceVersion: 2 });
  expect(JSON.stringify(input)).not.toContain("PRIVATE later draft");
});

it("freezes selected working library cards into private saved preview input", async () => {
  const test = await fixture();
  const records = {
    sponsor: { type: "sponsor", status: "draft", version: 2, name: "Draft sponsor", href: "https://draft.example.test/" },
    newsletter: { type: "newsletter", status: "draft", version: 3, title: "Draft newsletter", signupUrl: "https://draft.example.test/join" },
  };
  Object.assign(test.queue.snapshot, { blocks: [
    { id: "s", type: "sponsor_strip", order: 0, visible: true, data: { sponsorIds: ["sponsor"], layout: "row" } },
    { id: "n", type: "newsletter_signup", order: 1, visible: true, data: { newsletterIds: ["newsletter"] } },
  ] });
  Object.assign(test.firestore, { getAll: async (...refs: { id: string }[]) => refs.map(ref => ({
    exists: true, id: ref.id, data: () => records[ref.id as keyof typeof records],
  })) });
  expect(await test.run()).toEqual({ status: "ready" });
  const environment = test.dependencies.build.mock.calls[0][0];
  const input = JSON.parse(await readFile(environment.CMS_PREVIEW_INPUT_PATH, "utf8"));
  expect(input.publicContext).toEqual(publicContext);
  expect(input.draftLibraryCards.recordIds).toEqual(["newsletter", "sponsor"]);
  expect(input.draftLibraryCards.cards).toMatchObject([
    { kind: "newsletter", id: "newsletter", title: "Draft newsletter", sourceVersion: 3,
      newsletter: { card: { signupUrl: "https://draft.example.test/join" } } },
    { kind: "sponsor", id: "sponsor", title: "Draft sponsor", sourceVersion: 2, href: "https://draft.example.test/" },
  ]);
});

it.each(["ready", "failed"])("retains startup attribution on %s with the unchanged completion claim", async status => {
  const test = await fixture();
  const startup = { startupId: "11111111-1111-4111-8111-111111111111", processStartedAtMs: now.getTime() - 1000,
    timingsMs: { "node-startup": 17, "runtime-import": 25 } };
  if (status === "failed") test.dependencies.build.mockRejectedValueOnce(new Error("private failure"));
  await test.run(() => startup);
  expect(test.dependencies.finish).toHaveBeenCalledWith(expect.objectContaining({ ...claim, status, startup }));
});

it("passes accumulated stage totals with the unchanged completion claim", async () => {
  const test = await fixture();
  let time = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => time);
  test.dependencies.assertSource.mockImplementation(async () => { time += 11; });
  test.dependencies.build.mockImplementation(async () => { time += 17; });
  try {
    await test.run();
    expect(test.dependencies.finish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      ...claim, status: "ready", timingsMs: expect.objectContaining({ "source-check": 22, render: 17 }),
    }));
    expect(test.dependencies.finish.mock.calls[0][0]).not.toHaveProperty("timingsMs.finish");
  } finally { clock.mockRestore(); }
});

it.each([
  { pageId: "contact", slug: "in-the-news", route: "in-the-news/" },
  { pageId: `page-${"a".repeat(32)}`, slug: "in-the-news", route: "in-the-news/" },
  { pageId: "home", slug: "home", route: "" },
])("packages the saved URL of page $pageId", async ({ pageId, slug, route }) => {
  const test = await fixture();
  test.queue.pageId = pageId;
  Object.assign(test.queue.snapshot, { id: pageId, slug });
  test.dependencies.build.mockImplementation(async (_environment, output) => {
    await mkdir(path.join(output, route), { recursive: true });
    await writeFile(path.join(output, route, "index.html"), "<h1>Saved page</h1>");
    await writeFile(path.join(output, "_preview-assets.json"), "{}");
  });
  test.dependencies.prepare.mockImplementation(async input => preparePrivatePreview(input as never));

  expect(await test.run()).toEqual({ status: "ready" });
  expect(test.upload).toHaveBeenCalledWith(expect.objectContaining({
    pageUrl: `https://preview.njpbs.org/p/${claim.queueId}/${route}`,
  }));
});

it("does not pass ambient secrets or process injection settings into the renderer", () => {
  for (const name of ["FIREBASE_SERVICE_ACCOUNT", "GOOGLE_APPLICATION_CREDENTIALS", "AWS_SECRET_ACCESS_KEY", "NODE_OPTIONS", "CLOUDFLARE_API_TOKEN"]) {
    vi.stubEnv(name, "must-not-reach-the-build");
  }
  const environment = privatePreviewBuildEnvironment("/private/input.json", "d".repeat(64), claim, "contact");
  expect(Object.keys(environment).sort()).toEqual(["PATH", "NODE_ENV", "ASTRO_TELEMETRY_DISABLED", "TZ", "CMS_OFFLINE_BUILD", "CMS_CONTENT_MODE", "CMS_PREVIEW_PAGE_ID",
    "CMS_PREVIEW_QUEUE_ID", "CMS_PREVIEW_RENDERER_SHA", "CMS_PREVIEW_INPUT_PATH", "CMS_PREVIEW_INPUT_SHA256"].sort());
  expect(JSON.stringify(environment)).not.toContain("must-not-reach-the-build");
  expect(JSON.stringify(environment)).not.toContain(claim.claimToken);
});

it("renders a dev preview with the dev deployment environment and production without it", () => {
  const dev = privatePreviewBuildEnvironment("/private/input.json", "d".repeat(64), claim, "contact", "cmsPages", false, "development");
  expect(dev.CMS_DEPLOYMENT_ENVIRONMENT).toBe("development");
  const production = privatePreviewBuildEnvironment("/private/input.json", "d".repeat(64), claim, "contact", "cmsPages", false, "production");
  expect(production).not.toHaveProperty("CMS_DEPLOYMENT_ENVIRONMENT");
  expect(production).toEqual(privatePreviewBuildEnvironment("/private/input.json", "d".repeat(64), claim, "contact"));
});

it("refuses broad output paths and symlinks before the renderer can empty them", async () => {
  const test = await fixture();
  await expect(buildPrivatePreview({ CMS_OFFLINE_BUILD: "1" }, test.stateDirectory)).rejects.toThrow("job dist directory");
  const sentinel = path.join(test.stateDirectory, "keep.txt");
  await writeFile(sentinel, "keep");
  await symlink(test.stateDirectory, path.join(test.stateDirectory, "dist"));
  await expect(buildPrivatePreview({ CMS_OFFLINE_BUILD: "1" }, path.join(test.stateDirectory, "dist"))).rejects.toThrow("owner-only directory");
  expect(await readFile(sentinel, "utf8")).toBe("keep");
});

it("cleans only the exact private preview job and refuses a symlinked jobs directory", async () => {
  const test = await fixture();
  await test.run();
  const inputPath = test.dependencies.build.mock.calls[0][0].CMS_PREVIEW_INPUT_PATH;
  const other = path.join(test.stateDirectory, "jobs", "22222222222222222222");
  await mkdir(other, { mode: 0o700 });
  await writeFile(path.join(other, "keep.txt"), "keep");
  await removePrivatePreviewJob(test.stateDirectory, claim.queueId);
  await expect(readFile(inputPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(other, "keep.txt"), "utf8")).toBe("keep");
  const second = await fixture();
  await symlink(path.join(test.stateDirectory, "jobs"), path.join(second.stateDirectory, "jobs"));
  await expect(removePrivatePreviewJob(second.stateDirectory, "22222222222222222222")).rejects.toThrow("owner-only");
  expect(await readFile(path.join(other, "keep.txt"), "utf8")).toBe("keep");
  await expect(removePrivatePreviewJob(test.stateDirectory, "../outside")).rejects.toThrow("identity");
});

it.each(["busy", "terminal"])("does not build or finish a %s queue", async outcome => {
  const test = await fixture();
  test.dependencies.claim.mockResolvedValueOnce({ outcome });
  expect(await test.run()).toEqual({ outcome });
  expect(test.order).toEqual(["source"]);
  expect(test.upload).not.toHaveBeenCalled();
  expect(test.dependencies.finish).not.toHaveBeenCalled();
});

it.each(["build", "prepare"] as const)("records a %s error as failed without uploading", async stage => {
  const test = await fixture();
  test.dependencies[stage].mockRejectedValueOnce(new Error("secret build log"));
  expect(await test.run()).toEqual({ status: "failed" });
  expect(test.upload).not.toHaveBeenCalled();
  expect(test.dependencies.finish).toHaveBeenCalledWith(expect.objectContaining({ ...claim, status: "failed", pageId: "contact", timingsMs: expect.any(Object) }));
  expect(JSON.stringify(test.dependencies.finish.mock.calls)).not.toContain("secret build log");
});

it("passes only the bounded readiness reason to failed completion", async () => {
  const test = await fixture();
  test.dependencies.readPublicContext.mockRejectedValueOnce(new EditorialPreviewContextNotReadyError());
  expect(await test.run()).toEqual({ status: "failed" });
  expect(test.dependencies.finish).toHaveBeenCalledWith(expect.objectContaining({
    status: "failed", failureReason: "preview_context_refreshing",
  }));
  expect(test.upload).not.toHaveBeenCalled();
});

it("never records ready after upload failure or changed build input", async () => {
  const test = await fixture();
  test.upload.mockRejectedValueOnce(new Error("upload failed"));
  expect(await test.run()).toEqual({ status: "failed" });
  test.upload.mockClear();
  test.dependencies.build.mockImplementationOnce(async environment => {
    await writeFile(environment.CMS_PREVIEW_INPUT_PATH, "changed");
  });
  expect(await test.run()).toEqual({ status: "failed" });
  expect(test.upload).not.toHaveBeenCalled();
});

it("keeps an uncertain ready result out of the failure path and reuses frozen context on retry", async () => {
  const test = await fixture();
  test.dependencies.finish.mockRejectedValueOnce(new Error("lost completion response"));
  await expect(test.run()).rejects.toThrow("lost completion response");
  expect(test.dependencies.finish).toHaveBeenCalledTimes(1);
  expect(test.dependencies.finish.mock.calls[0][0].status).toBe("ready");
  expect(await test.run()).toEqual({ status: "ready" });
  for (const [completion] of test.dependencies.finish.mock.calls) {
    expect(completion).toMatchObject({ ...claim, status: "ready", timingsMs: expect.any(Object) });
  }
  expect(test.dependencies.readPublicContext).toHaveBeenCalledOnce();
  expect(test.dependencies.build.mock.calls[0][0]).toEqual(test.dependencies.build.mock.calls[1][0]);
});


it("recovers frozen cloud input after lost ready writeback and complete local job loss", async () => {
  const frozen = new Map<string, Buffer>();
  const inputStorage = {
    read: vi.fn(async (queueId: string) => frozen.get(queueId) ?? null),
    freeze: vi.fn(async (queueId: string, bytes: Buffer) => {
      if (!frozen.has(queueId)) frozen.set(queueId, Buffer.from(bytes));
      return frozen.get(queueId)!;
    }),
  };
  const test = await fixture(false, inputStorage);
  test.dependencies.finish.mockRejectedValueOnce(new Error("lost ready response"));
  await expect(test.run()).rejects.toThrow("lost ready response");
  expect(test.upload).toHaveBeenCalledOnce();
  expect(test.dependencies.finish).toHaveBeenCalledTimes(1);
  expect(test.dependencies.finish).toHaveBeenLastCalledWith(expect.objectContaining({ ...claim, status: "ready" }));
  const original = Buffer.from(frozen.get(claim.queueId)!);
  const firstEnvironment = test.dependencies.build.mock.calls[0][0];
  expect(await readFile(firstEnvironment.CMS_PREVIEW_INPUT_PATH)).toEqual(original);

  await rm(path.join(test.stateDirectory, "jobs", claim.queueId), { recursive: true });
  await expect(readFile(firstEnvironment.CMS_PREVIEW_INPUT_PATH)).rejects.toMatchObject({ code: "ENOENT" });
  // The current publication can change while the admitted claim retains its exact input.
  test.dependencies.readPublicContext.mockRejectedValue(new Error("new publication must not be read on recovery"));
  test.dependencies.claim.mockResolvedValueOnce({ outcome: "claimed" });
  expect(await test.run()).toEqual({ status: "ready" });
  const recoveredEnvironment = test.dependencies.build.mock.calls[1][0];
  expect(await readFile(recoveredEnvironment.CMS_PREVIEW_INPUT_PATH)).toEqual(original);
  expect(JSON.parse(original.toString()).publicContext).toEqual(publicContext);
  expect(recoveredEnvironment).toEqual(firstEnvironment);
  expect(inputStorage.read.mock.calls).toEqual([[claim.queueId], [claim.queueId]]);
  expect(inputStorage.freeze).toHaveBeenCalledOnce();
  expect(test.dependencies.readPublicContext).toHaveBeenCalledOnce();
  expect(test.upload).toHaveBeenCalledTimes(2);
  expect(test.dependencies.finish.mock.calls.map(([input]) => input.status)).toEqual(["ready", "ready"]);
});

it("refuses a changed fallback authority before freezing or rendering the accepted draft", async () => {
  const inputStorage = { read: vi.fn(async () => null), freeze: vi.fn(async (_id: string, bytes: Buffer) => bytes) };
  const test = await fixture(false, inputStorage);
  const verifyBeforeFreeze = vi.fn(async () => { throw new EditorialPreviewContextNotReadyError(); });
  test.dependencies.readPublicContext.mockResolvedValueOnce({ publicContext, publication: {} as never, verifyBeforeFreeze });
  expect(await test.run()).toEqual({ status: "failed" });
  expect(verifyBeforeFreeze).toHaveBeenCalledOnce();
  expect(inputStorage.freeze).not.toHaveBeenCalled();
  expect(test.dependencies.build).not.toHaveBeenCalled();
  expect(test.upload).not.toHaveBeenCalled();
  expect(test.dependencies.finish).toHaveBeenCalledWith(expect.objectContaining({ failureReason: "preview_context_refreshing" }));
});
