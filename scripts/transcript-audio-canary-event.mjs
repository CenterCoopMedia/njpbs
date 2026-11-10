#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import audio from "../functions/lib/video-transcript-audio-input.js";

// Offline only. The manifest contains media identities, never credentials.
const [operation, manifestPath, eventPath, receiptPath] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const identity = audio.inputIdentity(manifest.job, manifest.bucket, manifest.ffmpegArtifactSha256);
const id = audio.preparationId(manifest.job, manifest.bucket, manifest.ffmpegArtifactSha256);
if (operation === "prepare" && !eventPath && !receiptPath) {
  const invocationId = randomUUID();
  console.log(JSON.stringify({ schemaVersion: 1, preparationId: id, invocationId,
    revision: audio.PREPARATION_REVISION, ffmpegArtifactSha256: manifest.ffmpegArtifactSha256,
    input: { bucket: manifest.bucket, objectKey: identity.renditionKey, objectVersionId: identity.renditionVersion,
      sizeBytes: identity.renditionSize, durationSeconds: identity.durationSeconds },
    output: { bucket: manifest.bucket, ...audio.preparationKeys(id, invocationId) } }, null, 2));
} else if (operation === "validate" && eventPath && receiptPath) {
  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  if (event.preparationId !== id) throw Error("canary identity changed");
  const receipt = audio.validateReceipt(identity, id, event.invocationId, JSON.parse(readFileSync(receiptPath, "utf8")));
  if (receipt.outcome !== "ready") throw Error("audio preparation failed");
  console.log(JSON.stringify({ preparationId: id, invocationId: event.invocationId,
    mp4Bytes: identity.renditionSize, audioBytes: receipt.output.sizeBytes,
    savedBytesPerRead: identity.renditionSize - receipt.output.sizeBytes,
    inputAudioSeconds: receipt.sourceAudio.durationSamples / receipt.sourceAudio.sampleRate,
    outputAudioSeconds: receipt.outputAudio.durationSamples / receipt.outputAudio.sampleRate,
    output: receipt.output }, null, 2));
} else throw Error("usage: transcript-audio-canary-event.mjs prepare manifest.json | validate manifest.json event.json receipt.json");
