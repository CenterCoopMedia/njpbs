// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { uploadPrivatePreview, retainPrivatePreview, removeRetainedPreview } from "../scripts/upload-private-preview.mjs";
import { previewOutputTarget } from "../scripts/preview-output-target.mjs";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const { S3Client } = require("@aws-sdk/client-s3");
const { r2ClientConfig } = require("./lib/r2-media.js");
const queueId = "11111111111111111111";
const now = 1_780_000_000_000;
const cacheControl = "private, no-store, max-age=0";

afterEach(() => vi.useRealTimers());

it("moves a retained preview pointer conditionally and refuses a late older result", async () => {
  const contentKey = "a".repeat(64);
  const client = { send: vi.fn(async (command: { input: Record<string, unknown> }) => {
    if (command.input.Body) return {};
    return { ETag: '"prior"', Metadata: { schema: "njpbs-preview-current-v1",
      queueid: "22222222222222222222", requestedatms: String(now) } };
  }) };
  expect(await retainPrivatePreview({ contentKey, queueId, requestedAtMs: now + 300_000 }, { client })).toBe(true);
  expect(client.send.mock.calls[1][0].input).toMatchObject({ Key: `current/${contentKey}`, IfMatch: '"prior"',
    Metadata: { queueid: queueId, requestedatms: String(now + 300_000) } });
  client.send.mockClear();
  expect(await retainPrivatePreview({ contentKey, queueId, requestedAtMs: now - 1 }, { client })).toBe(false);
  expect(client.send).toHaveBeenCalledOnce();
});

it.each([409, 412])("re-reads a retained pointer after HTTP %s conditional conflicts", async (status) => {
  const contentKey = "a".repeat(64);
  const metadata = { schema: "njpbs-preview-current-v1", queueid: "22222222222222222222", requestedatms: String(now) };
  const client = { send: vi.fn()
    .mockResolvedValueOnce({ ETag: '"prior"', Metadata: metadata })
    .mockRejectedValueOnce({ $metadata: { httpStatusCode: status } })
    .mockResolvedValueOnce({ ETag: '"changed"', Metadata: metadata })
    .mockResolvedValueOnce({}) };
  expect(await retainPrivatePreview({ contentKey, queueId, requestedAtMs: now + 1 }, { client })).toBe(true);
  expect(client.send.mock.calls[3][0].input.IfMatch).toBe('"changed"');
});

it("cleans only the replaced saved export and refuses an out-of-prefix object", async () => {
  const client = { send: vi.fn()
    .mockResolvedValueOnce({ Contents: [{ Key: `saved/${queueId}/contact/index.html` }] })
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({ Contents: [] }) };
  await removeRetainedPreview(queueId, { client });
  expect(client.send.mock.calls[0][0].input.Prefix).toBe(`saved/${queueId}/`);
  expect(client.send.mock.calls[1][0].input.Delete.Objects)
    .toEqual([{ Key: `saved/${queueId}/contact/index.html` }]);
  client.send.mockReset().mockResolvedValueOnce({ Contents: [{ Key: "v1/unrelated/index.html" }] });
  await expect(removeRetainedPreview(queueId, { client })).rejects.toThrow("outside its queue");
  expect(client.send).toHaveBeenCalledOnce();
});

it("stores saved exports outside the expiring legacy prefix", async () => {
  const { artifact, client } = fixture();
  artifact.previewUrl = artifact.previewUrl.replace("/p/", "/s/");
  artifact.pageUrl = artifact.pageUrl.replace("/p/", "/s/");
  for (const object of artifact.files.values()) {
    object.key = object.key.replace("v1/", "saved/");
    Object.assign(object.customMetadata, { contentkey: "a".repeat(64) });
  }
  await uploadPrivatePreview(artifact, { client });
  for (const [command] of client.send.mock.calls) {
    expect(command.input.Key).toMatch(new RegExp(`^saved/${queueId}/`));
    expect(command.input.Metadata).toHaveProperty("contentkey", "a".repeat(64));
  }
});

it("writes, retains and removes dev saved outputs only in the dev bucket", async () => {
  const { artifact, client } = fixture();
  artifact.previewUrl = artifact.previewUrl.replace("preview.njpbs.org", "dev-preview.example.org");
  artifact.pageUrl = artifact.pageUrl.replace("preview.njpbs.org", "dev-preview.example.org");
  const target = previewOutputTarget("development", "njpbs-site-dev");
  await uploadPrivatePreview(artifact, { client, target });
  expect(client.send.mock.calls.every(([command]) => command.input.Bucket === target.bucket)).toBe(true);
  client.send.mockReset().mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } }).mockResolvedValue({});
  await retainPrivatePreview({ contentKey: "a".repeat(64), queueId, requestedAtMs: now }, { client, target });
  expect(client.send.mock.calls.every(([command]) => command.input.Bucket === target.bucket)).toBe(true);
  client.send.mockReset().mockResolvedValue({ Contents: [] });
  await removeRetainedPreview(queueId, { client, target });
  expect(client.send.mock.calls[0][0].input.Bucket).toBe(target.bucket);
});

it("refuses cross-environment URLs and bucket substitutions before storage access", async () => {
  const { artifact, client } = fixture();
  const dev = previewOutputTarget("development", "njpbs-site-dev");
  await expect(uploadPrivatePreview(artifact, { client, target: dev })).rejects.toThrow("upload identity");
  await expect(uploadPrivatePreview(artifact, { client, target: { ...dev, bucket: "njpbs-cms-previews" } })).rejects.toThrow("target differs");
  await expect(retainPrivatePreview({ contentKey: "a".repeat(64), queueId, requestedAtMs: now },
    { client, target: { ...dev, bucket: "njpbs-cms-previews" } })).rejects.toThrow("target differs");
  await expect(removeRetainedPreview(queueId, { client, target: { ...dev, bucket: "njpbs-cms-previews" } })).rejects.toThrow("target differs");
  expect(client.send).not.toHaveBeenCalled();
});

function fixture() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  const files = new Map(["contact/index.html", "one.css", "two.js", "three.svg", "four.png", "five.woff2", "six.css", "seven.js", "eight.png", "nine.svg"].map(file => {
    const body = Buffer.from(file);
    return [file, { key: `v1/${queueId}/${file}`, body,
      sha256: createHash("sha256").update(body).digest("hex"),
      customMetadata: { schema: "njpbs-preview-v1", queueid: queueId, expiresatms: String(now + 60_000) } }];
  }));
  const artifact = { previewUrl: `https://preview.njpbs.org/p/${queueId}/`,
    pageUrl: `https://preview.njpbs.org/p/${queueId}/contact/`, files };
  const client = { send: vi.fn(async (_command: { input: Record<string, unknown> }) => ({})) };
  return { artifact, client };
}

it("uploads immutable private assets before HTML with bounded concurrency", async () => {
  const { artifact, client } = fixture();
  let active = 0;
  let maximum = 0;
  client.send.mockImplementation(async () => {
    active++;
    maximum = Math.max(active, maximum);
    await Promise.resolve();
    active--;
    return {};
  });
  await uploadPrivatePreview(artifact, { client });
  expect(maximum).toBe(8);
  expect(client.send).toHaveBeenCalledTimes(10);
  expect(client.send.mock.calls[8][0].input.Key).toBe(`v1/${queueId}/nine.svg`);
  expect(client.send.mock.calls.at(-1)![0].input.Key).toBe(`v1/${queueId}/contact/index.html`);
  for (const [command] of client.send.mock.calls) {
    expect(command.input).toMatchObject({ Bucket: "njpbs-cms-previews", IfNoneMatch: "*",
      CacheControl: cacheControl, ContentType: "application/octet-stream",
      Metadata: { schema: "njpbs-preview-v1", queueid: queueId, expiresatms: String(now + 60_000) } });
  }
});

it("waits for in-flight assets after failure and never starts HTML or another asset", async () => {
  const { artifact, client } = fixture();
  let completed = 0;
  client.send.mockImplementation(async command => {
    if (String(command.input.Key).endsWith("one.css")) throw new Error("storage unavailable");
    await new Promise(resolve => setTimeout(resolve, 10));
    completed++;
    return {};
  });
  await expect(uploadPrivatePreview(artifact, { client })).rejects.toThrow("storage unavailable");
  expect(completed).toBe(7);
  expect(client.send).toHaveBeenCalledTimes(8);
  expect(client.send.mock.calls.map(([command]) => command.input.Key)).not.toContain(`v1/${queueId}/nine.svg`);
  expect(client.send.mock.calls.map(([command]) => command.input.Key)).not.toContain(`v1/${queueId}/contact/index.html`);
});

it("fills a free upload slot while another asset is still pending", async () => {
  const { artifact, client } = fixture();
  const pending = new Map<string, () => void>();
  client.send.mockImplementation(command => new Promise(resolve => {
    pending.set(String(command.input.Key).split("/").at(-1)!, () => resolve({}));
  }));
  const upload = uploadPrivatePreview(artifact, { client });
  expect(pending.size).toBe(8);
  pending.get("two.js")!();
  await vi.waitFor(() => expect(pending.has("nine.svg")).toBe(true));
  expect(client.send).toHaveBeenCalledTimes(9);
  expect(pending.has("index.html")).toBe(false);
  for (const [name, resolve] of pending) if (name !== "one.css") resolve();
  await Promise.resolve();
  expect(pending.has("index.html")).toBe(false);
  pending.get("one.css")!();
  await vi.waitFor(() => expect(pending.has("index.html")).toBe(true));
  pending.get("index.html")!();
  await upload;
});

it("does not upload queued assets or HTML after expiry during an active upload", async () => {
  const { artifact, client } = fixture();
  client.send.mockImplementation(async () => {
    await Promise.resolve();
    vi.setSystemTime(now + 60_000);
    return {};
  });
  await expect(uploadPrivatePreview(artifact, { client })).rejects.toThrow("expired");
  expect(client.send).toHaveBeenCalledTimes(8);
});

it.each([false, true])("accepts only an exact immutable retry (conflict=%s)", async conflict => {
  const { artifact, client } = fixture();
  client.send.mockImplementation(async command => {
    const object = [...artifact.files.values()].find(file => file.key === command.input.Key)!;
    if (command.input.Body) throw Object.assign(new Error("exists"), { name: "PreconditionFailed" });
    return { ContentLength: object.body.length, ContentType: "application/octet-stream", CacheControl: cacheControl,
      Metadata: { ...object.customMetadata, sha256: conflict ? "wrong" : object.sha256 } };
  });
  const result = uploadPrivatePreview(artifact, { client });
  if (conflict) await expect(result).rejects.toThrow("does not match");
  else await expect(result).resolves.toBeUndefined();
});

it.each(["queue", "digest", "expiry", "page"])("rejects an invalid %s before any storage request", async field => {
  const { artifact, client } = fixture();
  const object = artifact.files.get("one.css")!;
  if (field === "queue") object.customMetadata.queueid = "22222222222222222222";
  if (field === "digest") object.body = Buffer.from("changed");
  if (field === "expiry") object.customMetadata.expiresatms = String(now);
  if (field === "page") artifact.pageUrl = `${artifact.previewUrl}watch/`;
  await expect(uploadPrivatePreview(artifact, { client })).rejects.toThrow();
  expect(client.send).not.toHaveBeenCalled();
});

it("sends lowercase metadata and create-only headers through the installed S3 serializer", async () => {
  const { artifact } = fixture();
  const requests: Array<{ headers: Record<string, string>; path: string }> = [];
  const client = new S3Client({ ...r2ClientConfig({ endpoint: "https://storage.example.test",
    accessKeyId: "synthetic-test-id", secretAccessKey: "synthetic-test-secret" }), maxAttempts: 1,
    requestHandler: { handle: async (request: typeof requests[number]) => {
      requests.push(request);
      return { response: { statusCode: 200, headers: { etag: '"test"' }, body: new Uint8Array() } };
    } } });
  try {
    await uploadPrivatePreview(artifact, { client });
    expect(requests).toHaveLength(10);
    expect(requests.at(-1)!.path).toBe(`/njpbs-cms-previews/v1/${queueId}/contact/index.html`);
    for (const request of requests) expect(request.headers).toMatchObject({
      "if-none-match": "*", "cache-control": cacheControl,
      "x-amz-meta-schema": "njpbs-preview-v1", "x-amz-meta-queueid": queueId,
      "x-amz-meta-expiresatms": String(now + 60_000),
    });
  } finally { client.destroy(); }
});
