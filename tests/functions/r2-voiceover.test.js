import { describe, expect, it, vi } from "vitest";
import storageModule from "../../functions/lib/r2-voiceover.js";

const { R2VoiceoverStorage } = storageModule;

function storage(send) {
  return new R2VoiceoverStorage({
    endpoint: "https://account.r2.cloudflarestorage.com",
    bucket: "njpbs-cms-voiceover",
    accessKeyId: "access",
    secretAccessKey: "secret",
    client: { send },
  });
}

describe("private voiceover R2 storage", () => {
  it("reads exact object metadata from the private bucket", async () => {
    const body = { pipe: vi.fn() };
    const send = vi.fn(async () => ({
      Body: body,
      ContentLength: 4,
      ContentType: "audio/wav",
      Metadata: { SHA256: "hash" },
    }));
    const result = await storage(send).getIfExists("takes/v1/take-01.wav");
    expect(result).toEqual({
      body,
      contentLength: 4,
      contentType: "audio/wav",
      metadata: { sha256: "hash" },
    });
    expect(send.mock.calls[0][0].input).toEqual({
      Bucket: "njpbs-cms-voiceover",
      Key: "takes/v1/take-01.wav",
    });
  });

  it("writes immutable private WAV objects with their content hash", async () => {
    const send = vi.fn(async () => ({}));
    const body = Buffer.from("WAVE");
    await expect(storage(send).putIfAbsent({
      key: "takes/v1/take-01.wav",
      body,
      contentHash: "a".repeat(64),
    })).resolves.toEqual({ created: true });
    expect(send.mock.calls[0][0].input).toMatchObject({
      Bucket: "njpbs-cms-voiceover",
      Key: "takes/v1/take-01.wav",
      Body: body,
      ContentLength: 4,
      ContentType: "audio/wav",
      CacheControl: "private, no-store",
      Metadata: { sha256: "a".repeat(64) },
      IfNoneMatch: "*",
    });
  });

  it("reports missing objects and immutable conflicts without replacement", async () => {
    const missing = Object.assign(new Error("missing"), {
      name: "NoSuchKey",
    });
    await expect(storage(vi.fn(async () => { throw missing; }))
      .getIfExists("takes/v1/missing.wav")).resolves.toBeNull();

    const conflict = Object.assign(new Error("exists"), {
      name: "PreconditionFailed",
      $metadata: { httpStatusCode: 412 },
    });
    await expect(storage(vi.fn(async () => { throw conflict; })).putIfAbsent({
      key: "takes/v1/take-01.wav",
      body: Buffer.from("WAVE"),
      contentHash: "a".repeat(64),
    })).resolves.toEqual({ created: false });
  });
});
