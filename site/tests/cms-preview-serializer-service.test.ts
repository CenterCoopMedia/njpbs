// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startCmsPreviewSerializerService } from "../scripts/cms-preview-serializer-service";
import { openCmsPublicationTokenJournal } from "../scripts/cms-publication-token-journal";

const directories: string[] = [];
const queueId = "11111111111111111111";
const rendererSha = "a".repeat(40);
const serializerId = "preview-owner";
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "njpbs-preview-service-"));
  directories.push(stateDirectory);
  const journal = await openCmsPublicationTokenJournal({ stateDirectory, serializerId });
  const queue = { status: "pending", transport: "serializer", rendererSha };
  const firestore = { collection: () => ({ doc: () => ({ get: async () => ({ data: () => queue }) }) }) };
  const listeners: Array<{ processQueue: (queueId: string) => Promise<void> }> = [];
  const process = vi.fn(async (_input: Parameters<typeof import("../scripts/process-cms-preview").processCmsPreview>[0]) => ({ status: "ready" }));
  const dependencies = { assertSource: vi.fn(async () => {}), process,
    startListener: vi.fn(async listener => { listeners.push(listener); return { stop: vi.fn() }; }) };
  const options = { firestore: firestore as never, serializerId, rendererSha, stateDirectory,
    publisherStateDirectory: "/private/publisher", accessKeyId: "synthetic-id", secretAccessKey: "synthetic-secret", dependencies };
  return { journal, queue, listeners, process, dependencies, options, start: () => startCmsPreviewSerializerService(options) };
}

it("reserves a durable token before processing and clears it only after confirmed completion", async () => {
  const test = await fixture();
  test.process.mockImplementationOnce(async input => {
    const retained = await test.journal.read();
    expect(retained).toMatchObject({ queueId, commitSha: rendererSha, buildBatchId: `preview-${queueId}` });
    expect(input.claim.claimToken).toBe(retained!.claimToken);
    expect(input).not.toHaveProperty("secretAccessKey");
    return { status: "ready" };
  });
  await test.start();
  await test.listeners[0].processQueue(queueId);
  expect(test.process).toHaveBeenCalledOnce();
  expect(await test.journal.read()).toBeNull();
});

it("passes the dev tuple to packing and every saved-output operation", async () => {
  const test = await fixture();
  const upload = vi.fn(async () => {});
  const retain = vi.fn(async () => true);
  const removeRetained = vi.fn(async () => {});
  const target = { environment: "development", projectId: "njpbs-site-dev",
    bucket: "template-dev-cms-previews", origin: "https://dev-preview.example.org" };
  test.process.mockImplementationOnce(async input => {
    expect(input).toMatchObject({ deploymentEnvironment: target.environment, projectId: target.projectId });
    await input.upload({} as never);
    await input.retain!({ contentKey: "a".repeat(64), queueId, requestedAtMs: 1 });
    await input.removeRetained!(queueId);
    return { status: "ready" };
  });
  await startCmsPreviewSerializerService({ ...test.options, deploymentEnvironment: "development",
    projectId: "njpbs-site-dev", dependencies: { ...test.dependencies, upload, retain, removeRetained } });
  await test.listeners[0].processQueue(queueId);
  for (const operation of [upload, retain, removeRetained]) expect(operation.mock.calls[0].at(-1)).toMatchObject({ target });
});

it.each([["development", "njpbs-site"], ["production", "njpbs-site-dev"]])(
  "refuses service output for %s with %s before opening a journal", async (deploymentEnvironment, projectId) => {
    const test = await fixture();
    await expect(startCmsPreviewSerializerService({ ...test.options, deploymentEnvironment, projectId }))
      .rejects.toThrow("target differs");
    expect(test.dependencies.startListener).not.toHaveBeenCalled();
  });

it("recovers the same token before listening after an uncertain completion", async () => {
  const test = await fixture();
  test.process.mockRejectedValueOnce(new Error("lost response"));
  await test.start();
  await expect(test.listeners[0].processQueue(queueId)).rejects.toThrow("lost response");
  const retained = await test.journal.read();
  expect(retained).not.toBeNull();
  test.process.mockImplementationOnce(async input => {
    expect(input.claim.claimToken).toBe(retained!.claimToken);
    expect(test.listeners).toHaveLength(1);
    return { status: "ready" };
  });
  await test.start();
  expect(test.listeners).toHaveLength(2);
  expect(await test.journal.read()).toBeNull();
});

it("recovers a journal reservation made before the queue claim", async () => {
  const test = await fixture();
  const { job } = await test.journal.reserve({ queueId, buildBatchId: `preview-${queueId}`, commitSha: rendererSha });
  await test.start();
  expect(test.process).toHaveBeenCalledWith(expect.objectContaining({ claim: expect.objectContaining({ claimToken: job.claimToken }) }));
  expect(await test.journal.read()).toBeNull();
});

it("retains ownership for a busy or unconfirmed processor result", async () => {
  const test = await fixture();
  test.process.mockResolvedValueOnce({ outcome: "busy" } as never);
  await test.start();
  await expect(test.listeners[0].processQueue(queueId)).rejects.toThrow("unconfirmed");
  expect(await test.journal.read()).not.toBeNull();
});

it("never replaces a missing token for a building queue or a retained job's renderer", async () => {
  const test = await fixture();
  await test.start();
  test.queue.status = "building";
  await expect(test.listeners[0].processQueue(queueId)).rejects.toThrow("no retained claim token");
  expect(await test.journal.read()).toBeNull();
  await test.journal.reserve({ queueId, buildBatchId: `preview-${queueId}`, commitSha: "b".repeat(40) });
  await expect(test.start()).rejects.toThrow("original renderer");
  expect(test.process).not.toHaveBeenCalled();
});

it("refuses sharing the publication state directory", async () => {
  const test = await fixture();
  await expect(startCmsPreviewSerializerService({ ...test.options,
    publisherStateDirectory: test.options.stateDirectory })).rejects.toThrow();
  expect(test.dependencies.startListener).not.toHaveBeenCalled();
});

it("keeps the token when terminal-job cleanup is interrupted", async () => {
  const test = await fixture();
  await startCmsPreviewSerializerService({ ...test.options, dependencies: { ...test.dependencies,
    cleanup: vi.fn(async () => { throw new Error("cleanup interrupted"); }) } });
  await expect(test.listeners[0].processQueue(queueId)).rejects.toThrow("cleanup interrupted");
  const retained = await test.journal.read();
  expect(retained).not.toBeNull();
  await test.start();
  expect(test.process.mock.calls.at(-1)![0].claim.claimToken).toBe(retained!.claimToken);
  expect(await test.journal.read()).toBeNull();
});
