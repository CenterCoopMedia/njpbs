#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { parseBrowserCredential } from "./cms-debug-browser.mjs";
import { parseCredential } from "./cms-diagnostics.mjs";

const require = createRequire(import.meta.url);
const fail = () => { throw Error("audio_canary_stopped"); };
const ACCOUNT = (process.env.CMS_MEDIA_AWS_VIDEO_ACCOUNT_ID ?? "");
const BUCKET = `njpbs-video-renditions-${ACCOUNT}-us-east-2`;

export function validateManifest(value) {
  if (!value || !/^[a-f0-9]{64}$/.test(value.campaignId ?? "") ||
    typeof value.actorUid !== "string" || !value.actorUid || value.actorUid.length > 128 ||
    !/^[1-9]\d{0,9}$/.test(value.keyVersion ?? "") ||
    !Number.isSafeInteger(value.credentialRevision) || value.credentialRevision < 1 ||
    !["en-US", "es-US"].includes(value.languageCode) || !Number.isInteger(value.maxSpeakers) ||
    value.maxSpeakers < 2 || value.maxSpeakers > 10 || value.bucket !== BUCKET ||
    !(value.job?.durationSeconds > 0 && value.job.durationSeconds <= 120) ||
    !(value.job?.input?.sizeBytes > 0 && value.job.input.sizeBytes <= 50_000_000)) fail();
  const audio = require("../functions/lib/video-transcript-audio-input");
  audio.inputIdentity(value.job, BUCKET, value.ffmpegArtifactSha256);
  return value;
}

async function signIn(auth, expectedUid) {
  const apiKey = process.env.AUDIO_CANARY_FIREBASE_API_KEY;
  if (!apiKey || !/^[A-Za-z0-9_-]{20,100}$/.test(apiKey)) fail();
  const bytes = readFileSync(3);
  let credential;
  try { credential = parseBrowserCredential(bytes.toString("utf8")); }
  finally { bytes.fill(0); }
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { "content-type": "application/json", origin: "https://admin.njpbs.org" },
    body: JSON.stringify({ ...credential, returnSecureToken: true }),
  });
  credential = undefined;
  if (!response.ok) fail();
  const result = await response.json();
  const claims = await auth.verifyIdToken(result.idToken, true);
  if (claims.uid !== expectedUid || !Number.isFinite(claims.auth_time)) fail();
  return { uid: claims.uid, authTime: claims.auth_time };
}

async function main() {
  const [operation, manifestPath] = process.argv.slice(2);
  if (!["prepare", "run-amazon", "run-elevenlabs", "status"].includes(operation) || !manifestPath ||
      process.argv.length !== 4 || process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST ||
      process.env.NODE_DEBUG || process.env.DEBUG) fail();
  const manifestBytes = readFileSync(manifestPath);
  const manifest = validateManifest(JSON.parse(manifestBytes));
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  const credentialBytes = readFileSync(0);
  const { initializeApp, cert } = require("firebase-admin/app");
  try { initializeApp({ credential: cert(parseCredential(credentialBytes.toString("utf8"))) }); }
  finally { credentialBytes.fill(0); }
  const { getFirestore } = require("firebase-admin/firestore");
  const { getAuth } = require("firebase-admin/auth");
  const firestore = getFirestore();
  const auth = getAuth();
  const actor = await signIn(auth, manifest.actorUid);
  const { registeredPrincipalFromUserDoc } = require("../functions/lib/principal");
  const { buildMediaSourceRegistry, authorizeMediaSource } = require("../functions/lib/media-sources");
  const { assertBillingEnabled } = require("../functions/lib/billing-state");
  const { activeAsset, requestTranscript, claimTranscript, saveTranscript } = require("../functions/lib/video-transcript-job");
  const { transcriptInput } = require("../functions/lib/video-transcript-contract");
  const audioContract = require("../functions/lib/video-transcript-audio-input");
  const source = buildMediaSourceRegistry({ videoEnabled: true, videoAccountId: ACCOUNT,
    videoBucket: `njpbs-video-originals-${ACCOUNT}-us-east-2`, videoPrefix: "",
    videoRoleArn: `arn:aws:iam::${ACCOUNT}:role/njpbs-boardwalk-video-read` }).get("video-library");
  const config = { audioEnabled: true, audioFunctionArn: `arn:aws:lambda:us-east-2:${ACCOUNT}:function:njpbs-boardwalk-transcript-audio-worker`,
    audioArtifactSha256: manifest.ffmpegArtifactSha256, bucket: BUCKET, accountId: ACCOUNT, region: "us-east-2", source,
    dataRoleArn: `arn:aws:iam::${ACCOUNT}:role/njpbs-boardwalk-transcript-data` };
  const current = async () => {
    const user = await auth.getUser(actor.uid);
    if (user.disabled || actor.authTime < Date.parse(user.tokensValidAfterTime ?? "1970-01-01") / 1000) fail();
    const record = (await firestore.collection("users").doc(actor.uid).get()).data();
    if (!record || record.active === false) fail();
    actor.principal = await registeredPrincipalFromUserDoc(firestore, actor.uid, record);
    await authorizeMediaSource({ firestore, actor, source, operation: "transcript" });
    await assertBillingEnabled(firestore);
    const asset = activeAsset(await firestore.collection("mediaSourceAssets").doc(manifest.job.assetId).get(), source);
    const projected = { sourceId: source.id, assetId: asset.id, sourceBucket: source.bucket,
      sourceObjectKey: asset.objectKey, sourceObjectVersionId: asset.objectVersionId, sourceSizeBytes: asset.sizeBytes,
      input: transcriptInput(asset), durationSeconds: asset.rendition.web.durationSeconds };
    if (!isDeepStrictEqual(audioContract.inputIdentity(projected, BUCKET, manifest.ffmpegArtifactSha256),
      audioContract.inputIdentity(manifest.job, BUCKET, manifest.ffmpegArtifactSha256))) fail();
  };
  await current();
  const campaign = firestore.collection("mediaTranscriptAudioCanaries").doc(manifest.campaignId);
  if (operation !== "status") await firestore.runTransaction(async (tx) => {
    const previous = (await tx.get(campaign)).data();
    if (previous && previous.manifestSha256 !== manifestSha256) fail();
    if (!previous) tx.create(campaign, { manifestSha256, actorUid: actor.uid, createdAt: new Date().toISOString() });
  });
  if (execFileSync("aws", ["--profile", "njpbs-admin", "--region", "us-east-2", "sts", "get-caller-identity",
    "--query", "Account", "--output", "text"], { encoding: "utf8", timeout: 15000 }).trim() !== ACCOUNT) fail();
  const { fromIni } = require("@aws-sdk/credential-providers");
  const { S3Client } = require("@aws-sdk/client-s3");
  const credentials = fromIni({ profile: "njpbs-admin" });
  const s3 = new S3Client({ region: config.region, credentials, maxAttempts: 2 });
  const { createTranscriptAudioRuntime } = require("../functions/lib/video-transcript-audio-runtime");
  const audio = createTranscriptAudioRuntime(config, { firestore, s3, credentials,
    assertBillingEnabled: () => assertBillingEnabled(firestore) });
  let saved = (await campaign.get()).data();
  if (operation === "prepare") {
    const request = { sourceId: source.id, assetId: manifest.job.assetId,
      languageCode: manifest.languageCode, maxSpeakers: manifest.maxSpeakers };
    const amazon = await requestTranscript({ firestore, source, request, actor,
      operatorCanaryId: manifest.campaignId, localEnabled: false, paidFallbackEnabled: false });
    if (amazon.job.operatorCanaryId !== manifest.campaignId) fail();
    const { admit } = require("../functions/video-transcript-byok");
    const eleven = await admit({ firestore, source, actor, now: Date.now(), operatorCanaryId: manifest.campaignId,
      settings: { enabled: true, audioEnabled: true, bucket: BUCKET, accountId: ACCOUNT },
      request: { ...request, provider: "elevenlabs", credentialScope: "organization", credentialRevision: manifest.credentialRevision } });
    if (eleven.job.operatorCanaryId !== manifest.campaignId) fail();
    await campaign.update({ amazonId: amazon.job.id, elevenId: eleven.job.id });
    for (const job of [amazon.job, eleven.job]) {
      try { await audio.ensure(job); }
      catch (error) { if (error.code !== "audio_preparation_waiting") throw error; }
    }
    saved = (await campaign.get()).data();
  }
  if (!saved.amazonId || !saved.elevenId) fail();
  const refs = [saved.amazonId, saved.elevenId].map((id) => firestore.collection("mediaSourceTranscriptJobs").doc(id));
  const readJobs = async () => Promise.all(refs.map(async (ref) => (await ref.get()).data()));
  const jobs = await readJobs();
  if (jobs.some((job) => !job || job.operatorCanaryId !== manifest.campaignId || job.requestedBy !== actor.uid)) fail();
  if (operation.startsWith("run-")) {
    if (jobs.some((job) => !job.audioInput) || !isDeepStrictEqual(jobs[0].audioInput, jobs[1].audioInput)) fail();
    await current();
    if (operation === "run-amazon") {
      const { TranscribeClient } = require("@aws-sdk/client-transcribe");
      const provider = new TranscribeClient({ region: config.region, credentials, maxAttempts: 1 });
      const { createVideoTranscriptProcessor } = require("../functions/lib/video-transcript-processor");
      const processor = createVideoTranscriptProcessor(config, { firestore, s3, credentials, audio,
        transcribe: { send: async (command) => {
          if (command.constructor.name === "StartTranscriptionJobCommand") await current();
          return provider.send(command);
        } } });
      const claimed = await claimTranscript(firestore, refs[0], source);
      if (claimed) {
        const save = async (patch) => {
          const ok = await saveTranscript(firestore, refs[0], claimed, patch);
          if (ok) Object.assign(claimed, patch);
          return ok;
        };
        try {
          if (Date.now() - Date.parse(claimed.createdAt) > 86400000) {
            await save({ active: false, phase: "needs_reconciliation", errorCode: "processing_timeout" });
          } else await processor.process(claimed, save);
        }
        finally { await save({ leaseUntil: 0 }); }
      }
    } else {
      const { createVideoTranscriptByokStorage } = require("../functions/lib/video-transcript-byok-storage");
      const { createByokRunner } = require("../functions/lib/video-transcript-byok-runner");
      const keyModule = require("../functions/lib/video-transcription-credentials");
      const storage = createVideoTranscriptByokStorage(config, { s3, audio,
        assertBillingEnabledFn: () => assertBillingEnabled(firestore) });
      const run = createByokRunner({ firestore, source, renditionBucket: BUCKET, storage, onlyJobId: saved.elevenId,
        getAuthUser: (uid) => auth.getUser(uid), loadCredential: async (job) => {
          await current();
          const expected = { ...keyModule.credentialIdentity(actor, { scope: "organization", provider: "elevenlabs" }),
            revision: job.identity.credentialRevision };
          const record = (await firestore.collection(keyModule.CREDENTIAL_COLLECTION).doc(expected.id).get()).data();
          const raw = readFileSync(4);
          let key;
          try { key = keyModule.encryptionKey(raw.toString("utf8").trim()); }
          finally { raw.fill(0); }
          try { return { key: keyModule.decryptCredential(record, expected, key, manifest.keyVersion),
            revision: record.revision, keyVersion: record.keyVersion }; }
          finally { key.fill(0); }
        }, transcribe: async (input, key, settings) => {
          await current();
          return require("../functions/lib/video-transcript-elevenlabs").transcribe(input, key, settings, { fetchFn: fetch });
        } });
      await run();
    }
  }
  if (operation !== "status") {
    const bound = (await readJobs()).map((job) => job.audioInput?.receipt).filter(Boolean);
    for (const receipt of bound) await audio.cleanupReceipt(receipt);
  }
  const results = await readJobs();
  console.log(JSON.stringify({ campaignId: manifest.campaignId, operation, jobs: results.map((job) => ({
    id: job.id, provider: job.provider, phase: job.phase, active: job.active,
    startIntentAt: job.startIntentAt ?? job.submissionIntentAt ?? null,
    preparationId: job.audioInput?.preparationId ?? null, invocationId: job.audioInput?.invocationId ?? null,
    audioVersion: job.audioInput?.receipt.output.objectVersionId ?? null,
  })) }));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try { await main(); }
  catch { process.stderr.write("Audio canary stopped; inspect the exact campaign and job states before another step.\n"); process.exitCode = 1; }
}
