// @vitest-environment node
import { expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { parsePreviewRuntimeControl, confirmPreviewRuntimeReady, assertPreviewRuntimeIdentity } from "../scripts/cms-preview-cloud-control";

const rendererSha = "a".repeat(40);
const serializerId = "cloud-preview-primary";
const control = { schemaVersion: 1, phase: "starting", rendererSha, serializerId };
function database(value: unknown) {
  const ref = { get: async () => ({ data: () => value }) };
  const liveBlogRef = {}, readerRef = {};
  const set = vi.fn();
  const create = vi.fn();
  const firestore = { doc: vi.fn((path: string) => path === "system/cmsPreviewRuntime" ? ref :
    path.startsWith("system/pageReaderContracts/") ? readerRef : liveBlogRef), runTransaction: async (run: (transaction: unknown) => Promise<void>) =>
    run({ get: async (target: unknown) => ({ exists: target === ref, data: () => target === ref ? value : undefined }), set, create }) } as unknown as Firestore;
  return { firestore, set, create, ref, liveBlogRef, readerRef };
}

it.each(["paused", "starting", "ready"])("accepts valid %s runtime controls", phase => {
  expect(parsePreviewRuntimeControl({ ...control, phase })).toEqual({ ...control, phase });
});
it("keeps live blog support optional and refuses unknown preview versions", () => {
  expect(parsePreviewRuntimeControl(control)).not.toHaveProperty("liveBlogVersion");
  expect(parsePreviewRuntimeControl({ ...control, liveBlogVersion: 1 }).liveBlogVersion).toBe(1);
  expect(() => parsePreviewRuntimeControl({ ...control, liveBlogVersion: 2 })).toThrow("invalid");
});
it.each([undefined, null, {}, { ...control, schemaVersion: 2 }, { ...control, phase: "invalid" },
  { ...control, rendererSha: "invalid" }, { ...control, serializerId: "../other" },
  { ...control, rendererSha: [rendererSha] }, { ...control, serializerId: [serializerId] },
  { ...control, dataHubCompositionVersion: 2 }])("rejects malformed runtime controls", value => {
  expect(() => parsePreviewRuntimeControl(value)).toThrow("Cloud preview release control is invalid");
});
it("turns the exact starting runtime ready in its transaction", async () => {
  const db = database(control);
  await confirmPreviewRuntimeReady(db.firestore, rendererSha, serializerId);
  expect(db.set).toHaveBeenCalledTimes(2);
  expect(db.set).toHaveBeenCalledWith(db.liveBlogRef, { schemaVersion: 1, rendererSha, liveBlogContractVersion: 3 });
  expect(db.create).toHaveBeenCalledExactlyOnceWith(db.readerRef, { schemaVersion: 1, rendererSha, pageReaderVersion: 1 });
  expect(db.set).toHaveBeenCalledWith(db.ref, { ...control, phase: "ready", dataHubCompositionVersion: 1, liveBlogVersion: 1, electionResultsVersion: 2,
    checkedAt: expect.any(String), startupTimingsMs: {} });
});
it("does not reopen a runtime paused while startup was in progress", async () => {
  const db = database({ ...control, phase: "paused" });
  await confirmPreviewRuntimeReady(db.firestore, rendererSha, serializerId, { "source-check": 100 });
  expect(db.set).not.toHaveBeenCalled();
  expect(db.create).not.toHaveBeenCalled();
});
it.each([{ rendererSha: "b".repeat(40) }, { serializerId: "new-owner" }])("refuses changed startup identity %j", async change => {
  const db = database({ ...control, ...change });
  await expect(confirmPreviewRuntimeReady(db.firestore, rendererSha, serializerId)).rejects.toThrow("changed during startup");
  await expect(assertPreviewRuntimeIdentity(db.firestore, rendererSha, serializerId)).rejects.toThrow("another renderer");
  expect(db.set).not.toHaveBeenCalled();
});

it("persists only bounded stage totals in the existing ready write", async () => {
  const db = database(control);
  await confirmPreviewRuntimeReady(db.firestore, rendererSha, serializerId, {
    "node-startup": 25, "source-check": 12, "runtime-import": 740, "package-check": 86_400_000,
    render: -1, upload: NaN, pack: 0.5, finish: 86_400_001, token: "secret",
  } as never);
  expect(db.set).toHaveBeenCalledWith(db.ref, { ...control, phase: "ready", dataHubCompositionVersion: 1, liveBlogVersion: 1, electionResultsVersion: 2, checkedAt: expect.any(String),
    startupTimingsMs: { "node-startup": 25, "source-check": 12, "runtime-import": 740, "package-check": 86_400_000 } });
});
