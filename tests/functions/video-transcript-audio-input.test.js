import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const audio = require("../../functions/lib/video-transcript-audio-input");
const ARTIFACT = "a".repeat(64);
const INVOCATIONS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
];

function job(patch = {}) {
  return {
    sourceId: "video-library",
    assetId: "asset",
    sourceBucket: "originals",
    sourceObjectKey: "objects/asset.mov",
    sourceObjectVersionId: "original-v1",
    sourceSizeBytes: 1000,
    renditionBucket: "renditions",
    input: {
      objectKey: "outputs/job/attempt/preview.mp4",
      objectVersionId: "preview-v1",
      sizeBytes: 900,
      durationSeconds: 20,
    },
    durationSeconds: 20,
    ...patch,
  };
}

function receipt(id, invocationId, patch = {}) {
  const stream = {
    codec: "aac",
    profile: "LC",
    sampleRate: 48000,
    channels: 2,
    startSamples: 0,
    durationSamples: 960000,
    frameSamples: 1024,
    packetCount: 938,
    elementarySha256: "b".repeat(64),
  };
  return {
    schemaVersion: 1,
    preparationId: id,
    invocationId,
    revision: audio.PREPARATION_REVISION,
    ffmpegArtifactSha256: ARTIFACT,
    outcome: "ready",
    input: {
      objectKey: job().input.objectKey,
      objectVersionId: job().input.objectVersionId,
      sizeBytes: job().input.sizeBytes,
    },
    output: {
      objectKey: audio.preparationKeys(id, invocationId).audioKey,
      objectVersionId: "audio-v1",
      sizeBytes: 800,
      sha256: "c".repeat(64),
      mimeType: "audio/x-m4a",
    },
    sourceAudio: stream,
    outputAudio: { ...stream, durationSamples: 959968 },
    ...patch,
  };
}

function failureReceipt(id, invocationId, failureCode) {
  return {
    schemaVersion: 1,
    preparationId: id,
    invocationId,
    revision: audio.PREPARATION_REVISION,
    ffmpegArtifactSha256: ARTIFACT,
    outcome: "failed",
    input: {
      objectKey: job().input.objectKey,
      objectVersionId: job().input.objectVersionId,
      sizeBytes: job().input.sizeBytes,
    },
    failureCode,
  };
}

function store() {
  const rows = new Map();
  let tail = Promise.resolve();
  const firestore = {
    collection: (name) => ({ doc: (id) => ({ path: `${name}/${id}` }) }),
    runTransaction: (fn) => {
      const work = tail.then(async () => {
        const next = new Map([...rows].map(([key, value]) => [key, structuredClone(value)]));
        const tx = {
          get: async (ref) => ({ data: () => structuredClone(next.get(ref.path)) }),
          set: (ref, value) => next.set(ref.path, structuredClone(value)),
        };
        const result = await fn(tx);
        rows.clear();
        for (const [key, value] of next) rows.set(key, value);
        return result;
      });
      tail = work.catch(() => {});
      return work;
    },
  };
  return { firestore, rows };
}

const rowKey = (id) => `${audio.COLLECTION}/${id}`;

describe("paid transcript audio preparation", () => {
  it("binds every immutable media field and the FFmpeg artifact", () => {
    const base = job();
    const id = audio.preparationId(base, "renditions", ARTIFACT);
    for (const changed of [
      job({ assetId: "other-asset" }),
      job({ sourceBucket: "other-originals" }),
      job({ sourceObjectKey: "objects/other.mov" }),
      job({ sourceObjectVersionId: "original-v2" }),
      job({ sourceSizeBytes: 1001 }),
      job({ input: { ...base.input, objectKey: "outputs/job/attempt/other.mp4" } }),
      job({ input: { ...base.input, objectVersionId: "preview-v2" } }),
      job({ input: { ...base.input, sizeBytes: 899 } }),
      job({ durationSeconds: 19.5, input: { ...base.input, durationSeconds: 19.5 } }),
    ]) expect(audio.preparationId(changed, "renditions", ARTIFACT)).not.toBe(id);
    const projected = job({ renditionBucket: undefined });
    expect(audio.preparationId(projected, "other-renditions", ARTIFACT))
      .not.toBe(audio.preparationId(projected, "renditions", ARTIFACT));
    expect(audio.preparationId(base, "renditions", "d".repeat(64))).not.toBe(id);
    expect(() => audio.preparationId(job({ input: { ...base.input, sizeBytes: 2_000_000_001 } }), "renditions", ARTIFACT))
      .toThrow("audio_preparation_identity_invalid");
    expect(() => audio.preparationId(job({ input: { ...base.input, durationSeconds: 19 } }), "renditions", ARTIFACT))
      .toThrow("audio_preparation_identity_invalid");
    expect(() => audio.preparationId(job({ identity: { renditionBucket: "other" } }), "renditions", ARTIFACT))
      .toThrow("audio_preparation_identity_invalid");
    expect(() => audio.preparationId(job(), "other-renditions", ARTIFACT))
      .toThrow("audio_preparation_identity_invalid");
    expect(() => audio.preparationId(job({ sourceObjectKey: "archive/objects/asset.mov" }), "renditions", ARTIFACT))
      .not.toThrow();
  });

  it("shares an identity across provider-specific job fields", () => {
    const amazon = job({ provider: "amazon-transcribe", requestedBy: "one", renditionBucket: undefined });
    const eleven = { ...job({ renditionBucket: undefined }), provider: "elevenlabs", requestedBy: "two",
      identity: { renditionBucket: "renditions", credentialRevision: 9 } };
    expect(audio.preparationId(eleven, "renditions", ARTIFACT))
      .toBe(audio.preparationId(amazon, "renditions", ARTIFACT));
  });

  it("gives one concurrent claimant an invocation and makes peers wait without another attempt", async () => {
    const db = store();
    let next = 0;
    const args = { firestore: db.firestore, job: job(), renditionBucket: "renditions", ffmpegArtifactSha256: ARTIFACT,
      now: 1000, uuid: () => INVOCATIONS[next++] };
    const results = await Promise.all([audio.claimPreparation(args), audio.claimPreparation(args)]);
    expect(results.map((result) => result.outcome).sort()).toEqual(["invoke", "waiting"]);
    const id = audio.preparationId(job(), "renditions", ARTIFACT);
    expect(db.rows.get(rowKey(id))).toMatchObject({ state: "waiting", invocationCount: 1,
      invocationId: INVOCATIONS[0], leaseUntil: 1000 + audio.LEASE_MS });
  });

  it("starts one replacement after expiry and then fails closed at the bounded limit", async () => {
    const db = store();
    let next = 0;
    const claim = (now) => audio.claimPreparation({ firestore: db.firestore, job: job(),
      renditionBucket: "renditions", ffmpegArtifactSha256: ARTIFACT, now, uuid: () => INVOCATIONS[next++] });
    expect((await claim(1000)).outcome).toBe("invoke");
    expect((await claim(1000 + audio.LEASE_MS)).outcome).toBe("invoke");
    expect((await claim(1000 + audio.LEASE_MS * 2)).outcome).toBe("failed");
    const id = audio.preparationId(job(), "renditions", ARTIFACT);
    expect(db.rows.get(rowKey(id))).toMatchObject({ state: "failed", invocationCount: 2, leaseUntil: 0 });
  });

  it("accepts only the current invocation and exact stream-copy receipt", async () => {
    const db = store();
    const claimed = await audio.claimPreparation({ firestore: db.firestore, job: job(),
      renditionBucket: "renditions", ffmpegArtifactSha256: ARTIFACT, now: 1000, uuid: () => INVOCATIONS[0] });
    const valid = receipt(claimed.id, claimed.invocationId);
    await expect(audio.acceptPreparation({ firestore: db.firestore, id: claimed.id,
      invocationId: claimed.invocationId, receipt: valid, now: 1500 }))
      .rejects.toThrow("audio_preparation_output_unverified");
    await expect(audio.acceptPreparation({ firestore: db.firestore, id: claimed.id,
      invocationId: claimed.invocationId, receipt: valid,
      verifiedOutput: { ...valid.output, objectVersionId: "other-version" }, now: 1500 }))
      .rejects.toThrow("audio_preparation_output_unverified");
    expect(await audio.acceptPreparation({ firestore: db.firestore, id: claimed.id,
      invocationId: claimed.invocationId, receipt: valid, verifiedOutput: valid.output,
      now: 2000 })).toMatchObject({ outcome: "ready" });
    expect(db.rows.get(rowKey(claimed.id))).toMatchObject({ state: "ready", leaseUntil: 0, receipt: valid });
    expect(await audio.acceptPreparation({ firestore: db.firestore, id: claimed.id,
      invocationId: claimed.invocationId, receipt: valid, verifiedOutput: valid.output,
      now: 3000 })).toMatchObject({ outcome: "ready" });
    expect(await audio.acceptPreparation({ firestore: db.firestore, id: claimed.id,
      invocationId: INVOCATIONS[1], receipt: receipt(claimed.id, INVOCATIONS[1]),
      verifiedOutput: receipt(claimed.id, INVOCATIONS[1]).output, now: 3000 }))
      .toMatchObject({ outcome: "stale" });
  });

  it("rejects codec, timeline, payload, identity and duration drift", async () => {
    const id = audio.preparationId(job(), "renditions", ARTIFACT);
    const base = receipt(id, INVOCATIONS[0]);
    const invalid = [
      { ...base, ffmpegArtifactSha256: "d".repeat(64) },
      { ...base, preparationId: "d".repeat(64) },
      { ...base, invocationId: INVOCATIONS[1] },
      { ...base, input: { ...base.input, objectKey: "outputs/other.mp4" } },
      { ...base, input: { ...base.input, objectVersionId: "other-version" } },
      { ...base, input: { ...base.input, sizeBytes: 899 } },
      { ...base, output: { ...base.output, objectKey: "transcripts/inputs/audio/other/input.m4a" } },
      { ...base, output: { ...base.output, objectVersionId: "" } },
      { ...base, output: { ...base.output, sizeBytes: job().input.sizeBytes + 1 } },
      { ...base, output: { ...base.output, mimeType: "audio/mp4" } },
      { ...base, sourceAudio: { ...base.sourceAudio, profile: "HE-AAC" } },
      { ...base, sourceAudio: { ...base.sourceAudio, startSamples: 2 } },
      { ...base, outputAudio: { ...base.outputAudio, startSamples: 1 },
        sourceAudio: { ...base.sourceAudio, startSamples: -1 } },
      { ...base, outputAudio: { ...base.outputAudio, sampleRate: 44100 } },
      { ...base, outputAudio: { ...base.outputAudio, channels: 1 } },
      { ...base, outputAudio: { ...base.outputAudio, packetCount: 937 } },
      { ...base, outputAudio: { ...base.outputAudio, elementarySha256: "e".repeat(64) } },
      { ...base, outputAudio: { ...base.outputAudio, durationSamples: 958000 } },
      { ...base, unexpected: true },
    ];
    for (const value of invalid) {
      expect(() => audio.validateReceipt(audio.inputIdentity(job(), "renditions", ARTIFACT), id, INVOCATIONS[0], value))
        .toThrow("audio_preparation_receipt_invalid");
    }
  });

  it("records a terminal worker failure without waiting for lease expiry", async () => {
    const db = store();
    const claimed = await audio.claimPreparation({ firestore: db.firestore, job: job(),
      renditionBucket: "renditions", ffmpegArtifactSha256: ARTIFACT, now: 1000, uuid: () => INVOCATIONS[0] });
    const failed = failureReceipt(claimed.id, claimed.invocationId, "audio_track_missing");
    await expect(audio.acceptPreparation({ firestore: db.firestore, id: claimed.id,
      invocationId: claimed.invocationId, receipt: failed,
      verifiedOutput: receipt(claimed.id, claimed.invocationId).output, now: 1500 }))
      .rejects.toThrow("audio_preparation_output_unverified");
    expect(await audio.acceptPreparation({ firestore: db.firestore, id: claimed.id,
      invocationId: claimed.invocationId, receipt: failed, now: 2000 }))
      .toEqual({ outcome: "failed", failureCode: "audio_track_missing" });
    expect(await audio.claimPreparation({ firestore: db.firestore, job: job(), renditionBucket: "renditions",
      ffmpegArtifactSha256: ARTIFACT, now: 3000, uuid: () => INVOCATIONS[1] }))
      .toEqual({ outcome: "failed", id: claimed.id, failureCode: "audio_track_missing" });
    expect(() => audio.validateReceipt(audio.inputIdentity(job(), "renditions", ARTIFACT), claimed.id,
      claimed.invocationId, failureReceipt(claimed.id, claimed.invocationId, "temporary_error")))
      .toThrow("audio_preparation_receipt_invalid");
  });

  it("fails closed when a stored identity is changed", async () => {
    const db = store();
    const claimed = await audio.claimPreparation({ firestore: db.firestore, job: job(),
      renditionBucket: "renditions", ffmpegArtifactSha256: ARTIFACT, now: 1000, uuid: () => INVOCATIONS[0] });
    const stored = db.rows.get(rowKey(claimed.id));
    db.rows.set(rowKey(claimed.id), { ...stored, identity: { ...stored.identity, renditionVersion: "changed" } });
    await expect(audio.claimPreparation({ firestore: db.firestore, job: job(), renditionBucket: "renditions",
      ffmpegArtifactSha256: ARTIFACT, now: 2000, uuid: () => INVOCATIONS[1] }))
      .rejects.toThrow("audio_preparation_record_invalid");
  });

  it("rejects a receipt after its invocation lease expires", async () => {
    const db = store();
    const claimed = await audio.claimPreparation({ firestore: db.firestore, job: job(),
      renditionBucket: "renditions", ffmpegArtifactSha256: ARTIFACT, now: 1000, uuid: () => INVOCATIONS[0] });
    expect(await audio.acceptPreparation({ firestore: db.firestore, id: claimed.id,
      invocationId: claimed.invocationId, receipt: receipt(claimed.id, claimed.invocationId),
      verifiedOutput: receipt(claimed.id, claimed.invocationId).output,
      now: claimed.leaseUntil })).toEqual({ outcome: "stale" });
  });

  it("invalidates only the matching ready receipt and resets lifecycle-expired work", async () => {
    const db = store();
    const claimed = await audio.claimPreparation({ firestore: db.firestore, job: job(),
      renditionBucket: "renditions", ffmpegArtifactSha256: ARTIFACT, now: 1000, uuid: () => INVOCATIONS[0] });
    const valid = receipt(claimed.id, claimed.invocationId);
    await audio.acceptPreparation({ firestore: db.firestore, id: claimed.id,
      invocationId: claimed.invocationId, receipt: valid, verifiedOutput: valid.output, now: 2000 });
    expect(await audio.invalidatePreparation({ firestore: db.firestore, id: claimed.id,
      receipt: { ...valid, output: { ...valid.output, sha256: "d".repeat(64) } },
      reason: "output_missing", now: 3000 })).toBe(false);
    await expect(audio.invalidatePreparation({ firestore: db.firestore, id: claimed.id,
      receipt: valid, reason: "read_failed", now: 3000 }))
      .rejects.toThrow("audio_preparation_invalidation_invalid");
    expect(await audio.invalidatePreparation({ firestore: db.firestore, id: claimed.id,
      receipt: valid, reason: "output_missing", now: 3000 })).toBe(true);
    const next = await audio.claimPreparation({ firestore: db.firestore, job: job(),
      renditionBucket: "renditions", ffmpegArtifactSha256: ARTIFACT, now: 4000, uuid: () => INVOCATIONS[1] });
    expect(next).toMatchObject({ outcome: "invoke", invocationId: INVOCATIONS[1] });
    expect(db.rows.get(rowKey(claimed.id))).toMatchObject({ generation: 2,
      invocationCount: 1, totalInvocationCount: 2 });
    const replacement = await audio.claimPreparation({ firestore: db.firestore, job: job(),
      renditionBucket: "renditions", ffmpegArtifactSha256: ARTIFACT,
      now: next.leaseUntil, uuid: () => INVOCATIONS[2] });
    expect(replacement).toMatchObject({ outcome: "invoke", invocationId: INVOCATIONS[2] });
    expect(await audio.claimPreparation({ firestore: db.firestore, job: job(),
      renditionBucket: "renditions", ffmpegArtifactSha256: ARTIFACT,
      now: replacement.leaseUntil, uuid: () => "unused" }))
      .toMatchObject({ outcome: "failed", failureCode: "attempts_exhausted" });
    expect(db.rows.get(rowKey(claimed.id))).toMatchObject({ generation: 2,
      invocationCount: 2, totalInvocationCount: 3, failureCode: "attempts_exhausted" });
  });
});
