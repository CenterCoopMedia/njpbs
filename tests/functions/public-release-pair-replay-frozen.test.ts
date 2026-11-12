import { createHash } from "node:crypto";
import { beforeAll, afterAll, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";
import { frozenReplayScheduleFixture, frozenReplayProgramRead } from "../helpers/public-release-replay-inputs";
import { releasePair } from "../helpers/private-public-release-pair.js";
import protocol from "../../functions/lib/public-release-pair.js";
import { publishedPageRead, fallbackPageRead, now } from "../../site/tests/fixtures/published-pages/fixtures";
import { projectPublicReleasePairReplay, parsePublicReleasePairReplayTargetReceipt, type PairReplayContext } from "../../site/scripts/public-release-pair-replay";
import { projectPublishedRecordRead } from "../../site/src/lib/published-record-render";
import compiledRendererAdapter from "../../site/scripts/compiled-renderer-adapter.mjs";
const app = vi.hoisted(() => ({ render: vi.fn(async (_request: Request, options: any) => new Response(`<main>${options.locals.cmsRender.content.target.pagePath}</main>`)) }));
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const old = releasePair("b", "b".repeat(40)), pair = releasePair();
let compiled: any, directory: string;
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "pair-replay-entry-"));
  const output = path.join(directory, "entry.mjs");
  // Compile the actual private and unchanged public entry code. Only Astro's
  // generated application is a boundary fixture; real projectors/seals run.
  const graph = await build({ entryPoints: [fileURLToPath(new URL("../../site/scripts/compiled-public-release-pair-entry.ts", import.meta.url))], outfile: output, metafile: true,
    bundle: true, platform: "node", format: "esm", target: "node22", define: { __CMS_RENDERER_SHA__: JSON.stringify(pair.commitSha), __CMS_DATA_HUB_PUBLIC__: "false" },
    banner: { js: 'import { createRequire as __pairTestCreateRequire } from "node:module"; const require = __pairTestCreateRequire(import.meta.url);' },
    plugins: [{ name: "fixture-astro-app", setup(builder) {
      builder.onResolve({ filter: /^astro\/app\/entrypoint$/ }, () => ({ path: "app", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const createApp = () => ({render: (...args) => globalThis.__pairReplayTestRender(...args)});" }));
    } }] });
  // Frozen rendering uses retained bytes and pure contracts. Loading live
  // database owners here also bundles their SDK and its growing transport graph.
  expect(Object.keys(graph.metafile.inputs).filter(input => /(?:^|\/)node_modules\/firebase-admin\//.test(input))).toEqual([]);
  vi.stubGlobal("__pairReplayTestRender", app.render);
  compiled = await import(/* @vite-ignore */ pathToFileURL(output).href);
});
afterAll(async () => { vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });
afterEach(() => { vi.restoreAllMocks(); app.render.mockClear(); });
function context(read: any, renderer: "page" | "context" | "record", path: string, files = new Map<string, Uint8Array>()) {
  const request = { schemaVersion: 1, read, homeSourcesFile: null, resources: [] };
  const provenance = { schemaVersion: 1, pair: old, rendererSha: old.commitSha, readerContractDigest: old.readerContractDigest, readerReceiptDigest: old.readerReceiptDigest };
  const inputDigest = hash(encode(request)), provenanceDigest = hash(encode(provenance));
  files.set("read.json", encode(request)); files.set("reader-provenance.json", encode(provenance));
  const value: PairReplayContext = { pair, identity: { schemaVersion: 2, pair: protocol.publicReleasePairReference(pair), kind: "qualification",
    sourceOperationId: "original-operation", sourceVersion: 7, snapshotDigest: "c".repeat(64), contextSequence: 12, inputManifestDigest: "d".repeat(64) },
    route: { path, method: "GET", renderer, inputFile: "read.json", dependencies: [{ name: "read.json", digest: inputDigest }, { name: "reader-provenance.json", digest: provenanceDigest }] },
    request, provenance, inputDigest, provenanceDigest, renderedAt: now.toISOString(),
    readFrozenFile: async name => { const file = files.get(name); if (!file) throw new Error("Missing H file"); return file; } };
  return { value, files, request };
}
async function scheduleContext(pageId = "schedule", renderer: "page" | "context" = "page") {
  const frozen = await frozenReplayScheduleFixture(old.commitSha);
  const read = renderer === "page" ? publishedPageRead(pageId, old.commitSha) : fallbackPageRead(pageId, old.commitSha);
  Object.assign(read, { schedule: frozen.schedule }); Object.assign(read.sourceSeal, { codeGeneration: 5 });
  return { ...context(read, renderer, `/${pageId}/`, frozen.files), frozen };
}
function programContext() {
  return context(frozenReplayProgramRead(old.commitSha), "record", "/programs/one/");
}

it("replays normalized legacy CODE receipts while retaining the original publication receipt digest", async () => {
  const frozen = await frozenReplayScheduleFixture(old.commitSha, true);
  expect(hash(JSON.stringify(frozen.qualifiedCode.publicContext.receipt))).not.toBe(frozen.qualifiedCode.publication.artifactReceiptDigest);
  const read = publishedPageRead("schedule", old.commitSha);
  Object.assign(read, { schedule: frozen.schedule }); Object.assign(read.sourceSeal, { codeGeneration: 5 });
  const { value } = context(read, "page", "/schedule/", frozen.files);
  const result = await projectPublicReleasePairReplay(value);
  expect((result.content as any).schedule.receipt.code.artifactReceiptDigest).toBe(frozen.qualifiedCode.publication.artifactReceiptDigest);
  expect((result.content as any).schedule.data.days.broadcast[0].entries[0].title).toBe("Frozen program");
});

it.each([["schedule", "page"], ["live", "context"]] as const)("rederives %s from frozen packet/CODE bytes and renders with NEW while keeping OLD source seals", async (id, renderer) => {
  const { value, request, files } = await scheduleContext(id, renderer), before = JSON.stringify(request);
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Mutable network forbidden"); });
  const result = await projectPublicReleasePairReplay(value);
  expect((result.content as any).schedule.data.days.broadcast[0].entries[0].title).toBe("Frozen program");
  expect((result.content as any).schedule.receipt.code.commitSha).toBe(old.commitSha);
  expect((result.content as any).schedule.receipt).toEqual((request.read as any).schedule.receipt);
  expect(result.content.target.rendererSha).toBe(pair.commitSha);
  expect(result.receipt.source.rendererSha).toBe(old.commitSha);
  expect(result.receipt.source.inputDigest).toBe(hash(files.get("read.json")!));
  expect(parsePublicReleasePairReplayTargetReceipt(result.receipt, value)).toEqual(result.receipt);
  const privateEntry = compiled;
  expect(await privateEntry.renderPublicReleasePairProjection(value, result.receipt)).toBe(`<main>/${id}/</main>`);
  expect(JSON.stringify(request)).toBe(before);
  expect(network).not.toHaveBeenCalled();
  // The separate ordinary entry still rejects the OLD code-bound receipt.
  const publicEntry = compiled;
  await expect(renderer === "page" ? publicEntry.renderPublishedPage(result.content as any) : publicEntry.renderPublicPageContext(result.content as any)).rejects.toThrow();
});
it.each(["missing-json", "missing-pdf", "corrupt-pdf", "corrupt-json", "missing-code", "corrupt-code", "provider-identity"])("refuses %s frozen Schedule dependencies by name", async mode => {
  const { value, files, frozen } = await scheduleContext();
  const member = frozen.roster.find(file => file.name === (mode.includes("json") ? "schedule-packet/json" : "schedule-packet/pdf"))!;
  if (mode === "missing-json" || mode === "missing-pdf") files.delete(member.chunkFiles[0]);
  if (mode === "corrupt-pdf" || mode === "corrupt-json") files.set(member.chunkFiles[0], encode({ bodyBase64: "YmFk" }));
  if (mode === "missing-code") files.delete("code-source.json");
  if (mode === "corrupt-code") files.set("code-source/objects/0000.json", encode({ bodyBase64: "YmFk" }));
  if (mode === "provider-identity") { const manifest = JSON.parse(new TextDecoder().decode(files.get("provider-inputs.json"))); manifest.externalInputs.runtime.release = pair.commitSha; files.set("provider-inputs.json", encode(manifest)); }
  await expect(projectPublicReleasePairReplay(value)).rejects.toMatchObject({ code: `replay-frozen-${mode.includes("code") ? "code" : "schedule"}-${mode.startsWith("missing") ? "missing" : "mismatch"}` });
});
it("replays a nonempty Program catalog from its embedded frozen image bytes without a mutable image read", async () => {
  const { value, request } = programContext(), before = JSON.stringify(request);
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Mutable image forbidden"));
  const original = await projectPublishedRecordRead(request.read, value.route.path, old.commitSha, now);
  const result = await projectPublicReleasePairReplay(value);
  expect((result.content as any).programImageDescriptors).toEqual(original!.programImageDescriptors);
  expect((result.content as any).programImageDescriptors.files).toHaveLength(3);
  expect((result.content as any).programImageDescriptors.rendererSha).toBe(old.commitSha);
  expect(result.content.target.rendererSha).toBe(pair.commitSha);
  const privateEntry = compiled;
  expect(await privateEntry.renderPublicReleasePairProjection(value, result.receipt)).toBe("<main>/programs/one/</main>");
  const publicEntry = compiled;
  await expect(publicEntry.renderPublishedRecordFamily(result.content as any)).rejects.toThrow();
  expect(JSON.stringify(request)).toBe(before); expect(network).not.toHaveBeenCalled();
});
it.each(["missing", "corrupt", "different-owner", "wrong-sha"])("refuses %s frozen Program catalog", async mode => {
  const { request, value } = programContext();
  if (mode === "missing") delete request.read.programImageDescriptors;
  if (mode === "corrupt") request.read.programImageDescriptors.files[0].base64 = "YWJk";
  if (mode === "different-owner") request.read.programImageDescriptors.programs[0].sourceVersion = 8;
  if (mode === "wrong-sha") request.read.programImageDescriptors.rendererSha = pair.commitSha;
  const rebuilt = context(request.read, "record", value.route.path);
  await expect(projectPublicReleasePairReplay(rebuilt.value)).rejects.toMatchObject({ code: `replay-frozen-program-images-${mode === "missing" ? "missing" : "mismatch"}` });
});
it("refuses a changed/unsealed OLD read and a substituted NEW receipt before private rendering", async () => {
  const { value } = await scheduleContext(), result = await projectPublicReleasePairReplay(value);
  const { renderPublicReleasePairProjection } = compiled;
  const changed = { ...value, request: structuredClone(value.request) as any };
  changed.request.read.page.title = "Unsealed replacement";
  await expect(renderPublicReleasePairProjection(changed, result.receipt)).rejects.toMatchObject({ code: "replay-frozen-request-mismatch" });
  await expect(renderPublicReleasePairProjection({ ...value, readFrozenFile: undefined }, result.receipt)).rejects.toMatchObject({ code: "replay-frozen-request-missing" });
  const substituted = structuredClone(result.receipt); substituted.target.rendererSha = old.commitSha;
  await expect(renderPublicReleasePairProjection(value, substituted)).rejects.toThrow();
  expect(app.render).not.toHaveBeenCalled();
});
it("selects the private entry only with the explicit pair adapter option", () => {
  for (const pairReplay of [false, true]) {
    let adapter: any;
    compiledRendererAdapter({ publicPages: true, pairReplay }).hooks["astro:config:done"]({ setAdapter: (value: unknown) => { adapter = value; } });
    expect(adapter.serverEntrypoint.pathname.endsWith(pairReplay ? "/compiled-public-release-pair-entry.ts" : "/compiled-public-page-entry.ts")).toBe(true);
  }
});
