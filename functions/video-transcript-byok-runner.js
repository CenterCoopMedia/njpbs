"use strict";

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { getAuth } = require("firebase-admin/auth");
const { S3Client } = require("@aws-sdk/client-s3");
const logger = require("firebase-functions/logger");
const { db } = require("./lib/firebase");
const { runtimeRegistry, runtimeAwsConfig } = require("./source-media");
const { transcriptConfig } = require("./video-transcripts");
const { assertBillingEnabled } = require("./lib/billing-state");
const { createAwsRoleCredentialProvider } = require("./lib/aws-workload-credentials");
const { createByokRunner } = require("./lib/video-transcript-byok-runner");
const { createVideoTranscriptByokStorage } = require("./lib/video-transcript-byok-storage");
const { createTranscriptAudioRuntime } = require("./lib/video-transcript-audio-runtime");
const { transcribe } = require("./lib/video-transcript-elevenlabs");
const { credentialIdentity, CREDENTIAL_COLLECTION, encryptionKey, decryptCredential } = require("./lib/video-transcription-credentials");
const { KEY, KEY_VERSION, BYOK_ENABLED, DATA_ROLE, RUNNER_SERVICE_ACCOUNT, isConfigured } = require("./lib/video-transcription-config");

const { READ_SECRETS, WRITE_SECRETS, privateVideoStorage, privateVideoStreamStorage } = require("./lib/private-video-runtime");

function runnerConfig() {
  const aws = runtimeAwsConfig();
  const transcript = transcriptConfig();
  return { ...aws, audioEnabled: transcript.audioEnabled, audioFunctionArn: transcript.audioFunctionArn,
    audioArtifactSha256: transcript.audioArtifactSha256, enabled: transcript.enabled && BYOK_ENABLED.value() === "true",
    roleArn: DATA_ROLE.value(), keyVersion: KEY_VERSION.value() };
}
function createRunnerTick(dependencies = {}) {
  let s3;
  return async () => {
    const config = (dependencies.configFn ?? runnerConfig)();
    if (!config.enabled) return { outcome: "disabled" };
    if (!isConfigured(config)) throw Error("byok_runner_configuration_invalid");
    const firestore = dependencies.firestore ?? db;
    s3 ??= dependencies.s3 ?? new S3Client({ region: config.region, maxAttempts: 2,
      credentials: createAwsRoleCredentialProvider(config),
      requestHandler: { connectionTimeout: 5000, requestTimeout: 15000, throwOnRequestTimeout: true } });
    const assertBillingEnabledFn = () => (dependencies.billingFn ?? assertBillingEnabled)(firestore);
    const audio = config.audioEnabled ? createTranscriptAudioRuntime({ ...config,
      bucket: config.renditionBucket, accountId: config.renditionExpectedBucketOwner },
    { firestore, s3, credentials: createAwsRoleCredentialProvider(config), assertBillingEnabled: assertBillingEnabledFn }) : null;
    const privateAudio = require("./lib/private-transcript-audio").createPrivateTranscriptAudio({ firestore, s3,
      config: { bucket: config.renditionBucket, accountId: config.renditionExpectedBucketOwner }, storage: privateVideoStorage,
      streamStorage: privateVideoStreamStorage });
    const storage = createVideoTranscriptByokStorage({ bucket: config.renditionBucket, accountId: config.renditionExpectedBucketOwner },
      { s3, audio, privateAudio, assertBillingEnabledFn });
    const loadCredential = async (job) => {
      const expected = { ...credentialIdentity({ uid: job.requestedBy }, { scope: job.identity.credentialScope, provider: "elevenlabs" }),
        revision: job.identity.credentialRevision };
      const record = (await firestore.collection(CREDENTIAL_COLLECTION).doc(expected.id).get()).data();
      if (!record) throw Error("byok_credential_unavailable");
      const encryption = encryptionKey((dependencies.keyFn ?? (() => KEY.value()))());
      try { return { key: decryptCredential(record, expected, encryption, config.keyVersion), revision: record.revision, keyVersion: record.keyVersion }; }
      finally { encryption.fill(0); }
    };
    const run = (dependencies.createRunnerFn ?? createByokRunner)({ firestore,
      source: (dependencies.registryFn ?? runtimeRegistry)().get("video-library"), renditionBucket: config.renditionBucket,
      storage, loadCredential, getAuthUser: dependencies.getAuthUser ?? ((uid) => getAuth().getUser(uid)),
      transcribe: (input, key, settings) => transcribe(input, key, settings, { fetchFn: dependencies.fetchFn ?? fetch }) });
    try { return await run(); }
    finally {
      try { await audio?.cleanup(); }
      catch { logger.warn("Transcript audio cleanup failed"); }
    }
  };
}
const tick = createRunnerTick();
const onVideoTranscriptByokTick = onSchedule({ schedule: "every 1 minutes", region: "us-central1", timeoutSeconds: 900,
  memory: "512MiB", maxInstances: 1, concurrency: 1, retryCount: 0, serviceAccount: RUNNER_SERVICE_ACCOUNT, secrets: [KEY, ...READ_SECRETS, ...WRITE_SECRETS] },
async () => {
  try { const result = await tick(); if (result.outcome !== "disabled" && result.outcome !== "idle") logger.info("BYOK transcription tick", { outcome: result.outcome }); }
  catch { logger.warn("BYOK transcription tick failed"); throw Error("byok_runner_failed"); }
});
module.exports = { runnerConfig, isConfigured, createRunnerTick, onVideoTranscriptByokTick };
