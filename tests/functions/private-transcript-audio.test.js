import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { fakeFirestore } from "../helpers/master-cleanup-firestore.js";
import delivery from "../../functions/lib/private-transcript-audio.js";

const bytes = Buffer.from("Exact shared audio fixture bytes");
const hash = createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const store = fakeFirestore();
  const objects = new Map(), uploads = new Map();
  const receipt = { preparationId: "a".repeat(64), invocationId: "11111111-1111-4111-8111-111111111111",
    input: { objectKey: "outputs/fixture/preview.mp4", objectVersionId: "web-v1", sizeBytes: 1000 },
    output: { objectKey: "transcripts/inputs/audio/fixture.m4a", objectVersionId: "audio-v1", sizeBytes: bytes.length,
      sha256: hash, mimeType: "audio/x-m4a" } };
  const uses = { state: "active", receipt };
  store.rows.set(`mediaTranscriptAudioUses/${receipt.preparationId}-${receipt.invocationId}`, uses);
  store.rows.set(`mediaTranscriptAudioPreparations/${receipt.preparationId}`, { state: "ready", receipt,
    identity: { assetId: "fixture", originalKey: "objects/fixture", originalVersion: "original-v1", originalSize: 9999 } });
  store.rows.set("mediaSourceAssets/fixture", { lifecycle: "active", sourceId: "video-library", objectKey: "objects/fixture",
    objectVersionId: "original-v1", sizeBytes: 9999, rendition: { state: "ready", web: receipt.input } });
  const s3 = { send: async command => {
    expect(command.input.VersionId).toBe("audio-v1");
    if (command.constructor.name === "HeadObjectCommand") return { ContentLength: bytes.length, VersionId: "audio-v1" };
    return { Body: Readable.from([bytes]), ContentLength: bytes.length, VersionId: "audio-v1", ContentRange: `bytes 0-${bytes.length - 1}/${bytes.length}` };
  } };
  const r2 = { send: async command => {
    const input = command.input;
    switch (command.constructor.name) {
      case "CreateMultipartUploadCommand": uploads.set("upload", { ...input }); return { UploadId: "upload" };
      case "UploadPartCommand": uploads.get("upload").bytes = Buffer.from(input.Body); return { ETag: '"part"' };
      case "CompleteMultipartUploadCommand": objects.set(input.Key, { ...uploads.get("upload"), ETag: '"audio"' }); return {};
      case "HeadObjectCommand": {
        if (!objects.has(input.Key)) throw Object.assign(Error("missing"), { name: "NotFound" });
        return { ContentLength: bytes.length, Metadata: objects.get(input.Key).Metadata, ETag: '"audio"' };
      }
      case "GetObjectCommand": return { Body: Readable.from([objects.get(input.Key).bytes]), ContentLength: bytes.length,
        ContentRange: `bytes 0-${bytes.length - 1}/${bytes.length}`, ETag: '"audio"' };
      case "AbortMultipartUploadCommand": return {};
      case "DeleteObjectCommand": objects.delete(input.Key); return {};
      default: throw Error(command.constructor.name);
    }
  } };
  const run = delivery.createPrivateTranscriptAudio({ firestore: store.firestore, s3,
    storage: () => ({ client: r2, bucket: "private" }), config: { bucket: "renditions", accountId: "123456789012" },
    clock: () => 1000, sign: async () => "https://private.invalid/input" });
  return { ...store, run, receipt, uses, objects };
}

describe("receipt-bound private R2 audio transport", () => {
  it("queues missing audio, verifies it and returns the unchanged canonical version/hash", async () => {
    const { run, receipt, objects } = fixture();
    expect(await run.signedInput(receipt)).toBeNull();
    await run.tick();
    const input = await run.signedInput(receipt);
    expect(input).toMatchObject({ storage: "private-r2", versionId: "audio-v1", sha256: hash,
      sizeBytes: bytes.length, preparationId: receipt.preparationId, invocationId: receipt.invocationId });
    expect(objects.size).toBe(1);
    expect(await run.tick()).toEqual({ idle: true });
  });
  it("fences private reads and deletes the R2 audio when canonical cleanup starts", async () => {
    const { run, receipt, uses, objects } = fixture();
    await run.enqueue(receipt);
    await run.tick();
    uses.state = "deleting";
    expect(await run.signedInput(receipt)).toBeNull();
    await run.revoke({ receipt });
    expect(objects.size).toBe(0);
    await run.tick();
    expect(await run.enqueue(receipt)).toBeNull();
  });
  it("refuses a different receipt or a replaced original", async () => {
    const { run, receipt, rows } = fixture();
    expect(await run.enqueue({ ...receipt, output: { ...receipt.output, objectVersionId: "other" } })).toBeNull();
    rows.get("mediaSourceAssets/fixture").objectVersionId = "replaced";
    expect(await run.enqueue(receipt)).toBeNull();
  });
});

it("never releases private audio whose full SHA-256 differs from its canonical receipt", async () => {
  const { run, receipt, rows } = fixture();
  receipt.output.sha256 = "0".repeat(64);
  await run.enqueue(receipt);
  for (let attempt = 0; attempt < 5; attempt++) await run.tick();
  expect(await run.signedInput(receipt)).toBeNull();
  const copy = [...rows.entries()].find(([path]) => path.startsWith("mediaPrivateAudioCopies/"))[1];
  expect(copy).toMatchObject({ phase: "failed", active: false });
});


it("finishes revocation while admission is disabled and leaves pending audio copies alone", async () => {
  const { run, receipt, rows, objects } = fixture();
  await run.enqueue(receipt);
  expect(await run.tick({ copyEnabled: false })).toEqual({ idle: true });
  expect(objects.size).toBe(0);
  await run.tick();
  await run.revoke({ receipt });
  expect(objects.size).toBe(0);
  await run.tick({ copyEnabled: false });
  const copy = [...rows.entries()].find(([path]) => path.startsWith("mediaPrivateAudioCopies/"))[1];
  expect(copy).toMatchObject({ phase: "deleted", active: false });
});
