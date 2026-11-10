import { expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import { createBootstrapS3Reads } from "../../site/scripts/public-release-bootstrap-s3-read";
const key = `release-pair-inputs/v2/fixture/objects/${"a".repeat(64)}.json`;
it("uses the existing S3 GET path and exact environment bucket without a write or list command", async () => {
  const readCredential = vi.fn(), destroy = vi.fn(), bytes = new Uint8Array([1, 2, 3]);
  const send = vi.fn(async (command: unknown) => {
    expect((command as object).constructor.name).toBe("GetObjectCommand");
    expect((command as { input: unknown }).input).toEqual({ Bucket: "njpbs-dev-cms-publication", Key: key });
    return { ContentLength: 3, Metadata: { bodydigest: "a".repeat(64) }, Body: { transformToWebStream: () => new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) } };
  });
  const objects = createBootstrapS3Reads({ environment: "development", client: { send, destroy } as any, readCredential });
  expect(send).not.toHaveBeenCalled(); expect(readCredential).not.toHaveBeenCalled();
  const object = await objects.get(key); expect(object?.size).toBe(3); expect(await new Response(object!.body).arrayBuffer()).toEqual(bytes.buffer);
  objects.close(); await expect(objects.get(key)).rejects.toThrow(); expect(send).toHaveBeenCalledTimes(1); expect(destroy).not.toHaveBeenCalled();
});
it("does not consume the credential source at construction or after close", async () => {
  const readCredential = vi.fn();
  const objects = createBootstrapS3Reads({ environment: "development", readCredential });
  expect(readCredential).not.toHaveBeenCalled(); objects.close();
  await expect(objects.get(key)).rejects.toThrow(); expect(readCredential).not.toHaveBeenCalled();
});
it("keeps a real inherited pipe unread before the first guarded GET", async () => {
  const child = spawn(process.execPath, ["--import", path.resolve("site/node_modules/tsx/dist/loader.mjs"), "--eval", `
    const { createBootstrapS3Reads } = require('./site/scripts/public-release-bootstrap-s3-read.ts');
    const objects = createBootstrapS3Reads({ environment: 'development' });
    const source = process._getActiveHandles().find(handle => handle._handle?.fd === 3);
    setTimeout(() => {
      const state = { found: !!source, buffered: source?.readableLength, reading: !!source?._handle?.reading };
      objects.close(); process.stdout.write(JSON.stringify(state));
    }, 50);
  `], { stdio: ["ignore", "pipe", "pipe", "pipe"] });
  let output = "", error = "";
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { error += chunk; });
  // Synthetic bytes only; no credential is fetched or used by this test.
  (child.stdio[3] as import("node:stream").Writable).on("error", () => {}).end(Buffer.alloc(256, 120));
  const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  expect({ code, error }).toEqual({ code: 0, error: "" });
  expect(JSON.parse(output)).toEqual({ found: true, buffered: 0, reading: false });
});
it("propagates the shared bootstrap abort signal to the supported S3 request", async () => {
  const controller = new AbortController();
  const send = vi.fn(async (_command, options) => {
    expect(options.abortSignal).toBe(controller.signal); controller.abort(); throw new Error("fixture-aborted");
  });
  const objects = createBootstrapS3Reads({ environment: "development", client: { send, destroy: vi.fn() } as any });
  await expect(objects.getWithSignal(key, controller.signal)).rejects.toThrow("Bootstrap storage provider read was refused");
  expect(send).toHaveBeenCalledTimes(1);
});
it.each(["oversized", "provider-error", "missing"])("refuses %s provider responses without exposing provider errors", async fault => {
  const cancel = vi.fn(), send = vi.fn(async () => {
    if (fault === "provider-error") throw new Error("fixture-private-provider-error-canary");
    if (fault === "missing") throw { $metadata: { httpStatusCode: 404 } };
    return { ContentLength: 16 * 1024 * 1024 + 1, Body: { transformToWebStream: () => new ReadableStream({ cancel }) } };
  });
  const objects = createBootstrapS3Reads({ environment: "development", client: { send, destroy: vi.fn() } as any });
  if (fault === "missing") expect(await objects.get(key)).toBe(null);
  else await expect(objects.get(key)).rejects.toThrow("Bootstrap storage provider read was refused");
  if (fault === "oversized") expect(cancel).toHaveBeenCalledTimes(1);
});
