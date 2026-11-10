import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import homeOwner from "../../functions/lib/no-build-home-ownership.js";
import { createHomeSourceSnapshot } from "../../site/src/lib/home-sources";
import { readHomeEditorialSourceReceipt } from "../../packages/content-core/src/home-source-catalog";
import fixture from "../../site/tests/fixtures/home-v2-selections.json";
import media from "../../site/src/data/launch-media-manager.json";
import spotlight from "../../site/tests/fixtures/home-sources/spotlight-feed.json";

const require = createRequire(import.meta.url);
const storage = require("../../functions/lib/post-background-storage.js");
const rendererSha = "a".repeat(40);
const oldRendererSha = "b".repeat(40);
const sources = { ...createHomeSourceSnapshot(media, spotlight, fixture.editorial.receipt),
  editorial: readHomeEditorialSourceReceipt(fixture.editorial) };
const bytes = Buffer.from(JSON.stringify(sources));
const retainedSource = { file: { path: "/_home-sources.json",
  key: `post-background-v1/home/retained-claim/${"c".repeat(64)}`,
  digest: createHash("sha256").update(bytes).digest("hex"), size: bytes.length,
  contentType: "application/json; charset=utf-8" }, publication: sources.publication,
  catalogDigest: sources.editorial.receipt.digest };
const state = { schemaVersion: 1, pageId: "home", path: "/", ownedPaths: ["/", "/_home-sources.json"],
  operationId: "HOMEpageoperation001", sourceVersion: 7, generation: 22, rendererSha: oldRendererSha,
  runtime: { owner: "cloudflare", release: oldRendererSha }, visible: true,
  homeRefresh: { schemaVersion: 1, revision: 4, sourceOperationId: "POSTrefreshoperat001", status: "pending" } };
const marker = { schemaVersion: 1, owner: "page-no-build-v1", pageId: "home",
  ownerPath: homeOwner.HOME_PAGE_OWNER_PATH, operationId: state.operationId, retainedSource };
const pointer = { state: "idle", activeCommitSha: rendererSha, activeGeneration: 23 };
const contextPath = "system/publicDeployment/contexts/public";
const context = { schemaVersion: 1, revision: 9 };
const externalPayloads = { "launch-media-manager.json": { cards: [] },
  "spotlight-news.json": { cards: [] }, "schedule.json": { days: [] } };
const externalBytes = Object.fromEntries(Object.entries(externalPayloads).map(([name, value]) => [name, Buffer.from(JSON.stringify(value))]));
const externalInputs = { schemaVersion: 1, operationId: "PROVIDERrefreshop001", runtime: state.runtime,
  checkedAt: Date.parse("2026-10-12T14:01:00.000Z"),
  contentDigest: createHash("sha256").update(JSON.stringify(externalPayloads)).digest("hex"),
  files: Object.fromEntries(Object.entries(externalBytes).map(([name, bytes]) => [name, {
    key: `post-background-v1/external-inputs/PROVIDERrefreshop001/${name}`,
    digest: createHash("sha256").update(bytes).digest("hex"), size: bytes.length,
  }])) };
const home = { publiclyVisible: true, published: { sourceVersion: 7 } };
let rows: Map<string, unknown>;
let getBytes: ReturnType<typeof vi.fn>;
const firestore = { doc: (path: string) => ({ path }) };
const snapshot = ({ path }: { path: string }) => ({ data: () => structuredClone(rows.get(path)) });
const transaction = { get: async (ref: { path: string }) => snapshot(ref),
  getAll: async (...refs: { path: string }[]) => refs.map(snapshot) };
const read = (overrides = {}) => homeOwner.readHomeSourcesInTransaction({ firestore, transaction,
  state: structuredClone(state), rendererSha, ...overrides });

beforeEach(() => {
  vi.restoreAllMocks();
  rows = new Map([
    [homeOwner.HOME_PAGE_OWNER_PATH, structuredClone(state)],
    [homeOwner.HOME_BACKGROUND_PATH, structuredClone(marker)],
    ["system/publicDeployment", structuredClone(pointer)], ["cmsPages/home", structuredClone(home)],
    [contextPath, structuredClone(context)],
    ["system/noBuildPostAdmission", { schemaVersion: 2, revision: 2, enabled: true,
      families: { posts: { mode: "all" } }, backgroundBucket: "fixture-private-bucket" }],
  ]);
  getBytes = vi.fn().mockResolvedValue(bytes);
  vi.spyOn(storage, "createPostBackgroundStorage").mockReturnValue({ get: getBytes });
});

describe("Home retained sources in a fresh authority transaction", () => {
  it("applies the trusted artwork policy in the generated Functions reader without losing cards", async () => {
    const card = { title: "Retained image card", description: "Published description", href: "https://watch.njpbs.org/show/retained/" };
    const changed = { ...sources, pbs: { ...sources.pbs, featured: [
      { ...card, image: "https://tracker.example/pixel.png" },
      { ...card, title: "Trusted image card", image: "https://image.pbs.org/program.jpg" },
    ] } };
    const changedBytes = Buffer.from(JSON.stringify(changed));
    rows.set(homeOwner.HOME_BACKGROUND_PATH, { ...marker, retainedSource: { ...retainedSource,
      file: { ...retainedSource.file, digest: createHash("sha256").update(changedBytes).digest("hex"), size: changedBytes.length },
    } });
    getBytes.mockResolvedValue(changedBytes);
    const result = await read();
    expect(result.homeSources.pbs.featured).toEqual([
      card, { ...card, title: "Trusted image card", image: "https://image.pbs.org/program.jpg" },
    ]);
  });

  it("keeps retained source provenance and returns the current rendering publication", async () => {
    const result = await read();
    expect(result.homeSources).toEqual(sources);
    expect(result.publication).toEqual({ buildBatchId: state.operationId, generation: 23, commitSha: rendererSha });
    expect(result.homeRefresh).toEqual(state.homeRefresh);
    expect(result.publicContextRevision).toBe(9);
    expect(result.externalInputs).toBeNull();
    expect(getBytes).toHaveBeenCalledWith(retainedSource.file.key, { signal: expect.any(AbortSignal) });
    expect(result.homeSources.publication).toEqual(sources.publication);
  });

  it("refuses missing or changed authority before reading private bytes", async () => {
    for (const [path, value] of [
      [homeOwner.HOME_PAGE_OWNER_PATH, undefined],
      [homeOwner.HOME_PAGE_OWNER_PATH, { ...state, operationId: "HOMEpageoperation002" }],
      [homeOwner.HOME_PAGE_OWNER_PATH, { ...state, homeRefresh: { ...state.homeRefresh, revision: 5 } }],
      [homeOwner.HOME_BACKGROUND_PATH, { ...marker, operationId: "HOMEpageoperation002" }],
      ["system/publicDeployment", { ...pointer, state: "deploying" }],
      ["system/publicDeployment", { ...pointer, activeCommitSha: oldRendererSha }],
      ["cmsPages/home", { ...home, published: { sourceVersion: 8 } }],
      ["cmsPages/home", { ...home, publiclyVisible: false }],
      [contextPath, undefined], [contextPath, { ...context, revision: 0 }],
    ] as [string, unknown][]) {
      const original = rows.get(path);
      rows.set(path, value);
      await expect(read()).rejects.toMatchObject({ status: 409 });
      rows.set(path, original);
    }
    expect(getBytes).not.toHaveBeenCalled();
  });

  it("requests the verified active code baseline only when no retained source exists", async () => {
    rows.set(homeOwner.HOME_BACKGROUND_PATH, { ...marker, retainedSource: null });
    expect(await read()).toEqual({ homeSources: null, publication: null,
      homeRefresh: state.homeRefresh, needsBaseline: true, publicContextRevision: 9, externalInputs: null });
    expect(getBytes).not.toHaveBeenCalled();
  });

  it("uses the prepared provider receipt before legacy sources, preserving its runtime and current revision", async () => {
    rows.set(contextPath, { ...context, revision: 10, externalInputs });
    rows.set(homeOwner.HOME_BACKGROUND_PATH, { ...marker, retainedSource: null });
    getBytes.mockImplementation(async key => externalBytes[key.split("/").at(-1)!]);
    const result = await read();
    expect(result.externalInputs).toEqual(externalInputs);
    expect(result.publicContextRevision).toBe(10);
    expect(result.homeSources.publication).toEqual(result.publication);
    expect(result.publication.commitSha).toBe(rendererSha);
    expect(result.externalInputs.runtime.release).toBe(oldRendererSha);
    expect(result.needsBaseline).toBeUndefined();
    expect(getBytes.mock.calls.map(([key]) => key)).toEqual(Object.values(externalInputs.files).map(file => file.key));
  });

  it("refuses broken prepared sources without reading legacy bytes or selecting the baseline", async () => {
    rows.set(contextPath, { ...context, externalInputs: { ...externalInputs, contentDigest: "f".repeat(64) } });
    getBytes.mockImplementation(async key => externalBytes[key.split("/").at(-1)!]);
    await expect(read()).rejects.toMatchObject({ status: 409 });
    expect(getBytes).not.toHaveBeenCalledWith(retainedSource.file.key, expect.anything());
    rows.set(homeOwner.HOME_BACKGROUND_PATH, { ...marker, retainedSource: null });
    rows.set(contextPath, { ...context, externalInputs: {} });
    getBytes.mockClear();
    await expect(read()).rejects.toMatchObject({ status: 409 });
    expect(getBytes).not.toHaveBeenCalled();
  });

  it("refuses corrupt retained sources and unavailable storage", async () => {
    rows.set(homeOwner.HOME_BACKGROUND_PATH, { ...marker,
      retainedSource: { ...retainedSource, catalogDigest: "f".repeat(64) } });
    await expect(read()).rejects.toMatchObject({ status: 409 });
    rows.set(homeOwner.HOME_BACKGROUND_PATH, marker);
    getBytes.mockResolvedValue(Buffer.from("changed bytes"));
    await expect(read()).rejects.toMatchObject({ status: 409 });
    getBytes.mockRejectedValue(new Error("Storage unavailable"));
    await expect(read()).rejects.toMatchObject({ status: 409 });
  });
});
