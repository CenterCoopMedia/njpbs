import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { deleteApp, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import rbacPackage from "../functions/lib/rbac.js";
import principalPackage from "../functions/lib/principal.js";
import storagePackage from "../functions/lib/r2-voiceover.js";
import contractPackage from "../functions/lib/voiceover-review.js";

const { can } = rbacPackage;
const { principalFromStoredUserDoc } = principalPackage;
const { R2VoiceoverStorage } = storagePackage;
const {
  LIBRARY_DOCUMENT,
  MAX_AUDIO_BYTES,
  SUPPORTED_MANIFEST_VERSION,
  TAKES_COLLECTION,
  VOICEOVER_SCHEMA_VERSION,
  performerProjection,
  validId,
} = contractPackage;

const EXPECTED_TAKES = 196;
const EXPECTED_FAMILIES = 25;
const EXPECTED_STYLES = 2;
const OBJECT_PREFIX = "takes/v1";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredText(value, field, maximumLength = 1_000) {
  if (typeof value !== "string" || !value.trim() || value.length > maximumLength) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function normalizedRegistry(value, field, expectedCount) {
  if (!Array.isArray(value) || value.length !== expectedCount) {
    throw new Error(`${field} must contain exactly ${expectedCount} entries`);
  }
  const seen = new Set();
  return value.map((entry, index) => {
    if (!isPlainObject(entry) || !validId(entry.id) || seen.has(entry.id)) {
      throw new Error(`${field}[${index}].id is invalid or duplicated`);
    }
    seen.add(entry.id);
    return {
      id: entry.id,
      label: requiredText(entry.label, `${field}[${index}].label`, 200).trim(),
    };
  });
}

function readChunkName(buffer, offset) {
  return buffer.toString("ascii", offset, offset + 4);
}

export function inspectWaveBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44 ||
      readChunkName(buffer, 0) !== "RIFF" ||
      readChunkName(buffer, 8) !== "WAVE") {
    throw new Error("The audio file is not a RIFF/WAVE file");
  }
  const riffSize = buffer.readUInt32LE(4);
  if (riffSize + 8 > buffer.length) {
    throw new Error("The WAV RIFF size exceeds the file size");
  }

  let format = null;
  let dataBytes = null;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const name = readChunkName(buffer, offset);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) throw new Error("The WAV chunk exceeds the file size");
    if (name === "fmt ") {
      if (size < 16) throw new Error("The WAV format chunk is incomplete");
      format = {
        codec: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        byteRate: buffer.readUInt32LE(start + 8),
        blockAlign: buffer.readUInt16LE(start + 12),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    } else if (name === "data") {
      dataBytes = size;
    }
    offset = end + (size % 2);
  }
  if (!format || !Number.isSafeInteger(dataBytes) || dataBytes < 1) {
    throw new Error("The WAV file needs format and audio data chunks");
  }
  if (format.codec !== 1 || format.channels !== 1 ||
      format.sampleRate !== 48_000 || format.bitsPerSample !== 16 ||
      format.blockAlign !== 2 || format.byteRate !== 96_000 ||
      dataBytes % format.blockAlign !== 0) {
    throw new Error("The WAV file must be mono 48 kHz 16-bit PCM");
  }
  return {
    durationSeconds: dataBytes / format.byteRate,
    dataBytes,
  };
}

function safeAudioPath(root, file, takeId) {
  if (typeof file !== "string" || file.includes("\\") ||
      file.startsWith("/") || basename(file) !== `${takeId}.wav`) {
    throw new Error(`Take ${takeId} has an invalid audio path`);
  }
  const path = resolve(root, file);
  const pathFromRoot = relative(root, path);
  if (!pathFromRoot || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`)) {
    throw new Error(`Take ${takeId} audio leaves the import directory`);
  }
  return path;
}

function normalizedTake(take, index, registries) {
  if (!isPlainObject(take) || !validId(take.id)) {
    throw new Error(`takes[${index}].id is invalid`);
  }
  if (!validId(take.family_id) || !registries.families.has(take.family_id) ||
      take.family !== registries.families.get(take.family_id)) {
    throw new Error(`Take ${take.id} has an invalid family`);
  }
  if (!validId(take.style) || !registries.styles.has(take.style)) {
    throw new Error(`Take ${take.id} has an invalid style`);
  }
  if (!validId(take.performer_id) ||
      !Object.hasOwn(registries.performers, take.performer_id)) {
    throw new Error(`Take ${take.id} has an invalid performer`);
  }
  if (!Number.isSafeInteger(take.take) || take.take < 1 || take.take > 999) {
    throw new Error(`Take ${take.id} has an invalid take number`);
  }
  const stableId = `${take.style}-${take.family_id}-${String(take.take).padStart(2, "0")}`;
  if (take.id !== stableId) {
    throw new Error(`Take ${take.id} does not match its stable ID fields`);
  }
  if (!Number.isFinite(take.start) || !Number.isFinite(take.end) ||
      take.start < 0 || take.end <= take.start ||
      !Number.isFinite(take.duration_seconds) || take.duration_seconds <= 0 ||
      Math.abs(take.duration_seconds - (take.end - take.start)) > 0.002) {
    throw new Error(`Take ${take.id} has invalid timing`);
  }
  if (typeof take.complete !== "boolean" || !Array.isArray(take.flags) ||
      take.flags.length > 20 ||
      take.flags.some((flag) => typeof flag !== "string" || !flag || flag.length > 80)) {
    throw new Error(`Take ${take.id} has invalid completion data`);
  }
  const insertNote = take.insert_note ?? "";
  if (typeof insertNote !== "string" || insertNote.length > 500) {
    throw new Error(`Take ${take.id} has an invalid insert note`);
  }
  return {
    id: take.id,
    family_id: take.family_id,
    family: take.family,
    take: take.take,
    style: take.style,
    performer_id: take.performer_id,
    text: requiredText(take.text, `Take ${take.id} text`),
    display_text: requiredText(take.display_text, `Take ${take.id} display_text`),
    complete: take.complete,
    flags: [...take.flags],
    insert_note: insertNote,
    duration_seconds: take.duration_seconds,
    sourceStartSeconds: take.start,
    sourceEndSeconds: take.end,
    file: take.file,
  };
}

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function buildImportPlan({ manifestPath, audioRoot }) {
  const [manifestBytes, root] = await Promise.all([
    readFile(manifestPath),
    realpath(audioRoot),
  ]);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("The voiceover manifest is not valid JSON");
  }
  if (!isPlainObject(manifest) || manifest.version !== SUPPORTED_MANIFEST_VERSION ||
      manifest.status !== "review-ready" || !Array.isArray(manifest.takes) ||
      manifest.takes.length !== EXPECTED_TAKES) {
    throw new Error(`The import requires the review-ready v1 manifest with ${EXPECTED_TAKES} takes`);
  }

  const styles = normalizedRegistry(manifest.styles, "styles", EXPECTED_STYLES);
  const families = normalizedRegistry(manifest.families, "families", EXPECTED_FAMILIES);
  const performers = performerProjection(manifest.performers);
  const registries = {
    styles: new Set(styles.map(({ id }) => id)),
    families: new Map(families.map(({ id, label }) => [id, label])),
    performers,
  };
  const ids = new Set();
  const takes = [];
  for (const [index, sourceTake] of manifest.takes.entries()) {
    const take = normalizedTake(sourceTake, index, registries);
    if (ids.has(take.id)) throw new Error(`Take ID ${take.id} is duplicated`);
    ids.add(take.id);
    const path = safeAudioPath(root, take.file, take.id);
    const resolvedFile = await realpath(path).catch(() => null);
    if (!resolvedFile || (relative(root, resolvedFile) === "..") ||
        relative(root, resolvedFile).startsWith(`..${sep}`)) {
      throw new Error(`Take ${take.id} audio is missing or leaves the import directory`);
    }
    const audio = await readFile(resolvedFile);
    if (audio.length > MAX_AUDIO_BYTES) {
      throw new Error(`Take ${take.id} exceeds the ${MAX_AUDIO_BYTES}-byte audio limit`);
    }
    const wave = inspectWaveBuffer(audio);
    if (Math.abs(wave.durationSeconds - take.duration_seconds) > 0.01) {
      throw new Error(`Take ${take.id} duration does not match its WAV file`);
    }
    const contentHash = createHash("sha256").update(audio).digest("hex");
    takes.push({
      ...take,
      order: index,
      objectKey: `${OBJECT_PREFIX}/${take.id}.wav`,
      sizeBytes: audio.length,
      contentHash,
      audio,
    });
  }

  const publicManifest = {
    version: manifest.version,
    status: manifest.status,
    styles,
    families,
    performers,
    takes: takes.map(({ audio, file, ...take }) => take),
  };
  return {
    schemaVersion: VOICEOVER_SCHEMA_VERSION,
    manifestVersion: manifest.version,
    status: manifest.status,
    performers,
    styles,
    families,
    takeCount: takes.length,
    manifestHash: hashJson(publicManifest),
    takes,
  };
}

export async function resolveRecorder({ auth, firestore, email }) {
  const normalizedEmail = requiredText(email, "recorder email", 254)
    .trim()
    .toLowerCase();
  const account = await auth.getUserByEmail(normalizedEmail);
  const snapshot = await firestore.collection("users").doc(account.uid).get();
  const profile = snapshot.exists ? snapshot.data() : null;
  const principal = await principalFromStoredUserDoc(firestore, account.uid, profile);
  const storedEmail = typeof profile?.email === "string"
    ? profile.email.trim().toLowerCase()
    : "";
  const displayName = typeof profile?.displayName === "string"
    ? profile.displayName.trim()
    : "";
  if (account.disabled || account.emailVerified !== true ||
      account.email?.trim().toLowerCase() !== normalizedEmail ||
      storedEmail !== normalizedEmail || !displayName || displayName.length > 120 ||
      !can(principal, "settings.manage")) {
    throw new Error("The recorder must be an active verified CMS settings manager");
  }
  return { uid: account.uid, displayName };
}

function storedTake(planTake, recorder, importedAt) {
  const { audio, file, ...take } = planTake;
  return {
    schemaVersion: VOICEOVER_SCHEMA_VERSION,
    manifestVersion: SUPPORTED_MANIFEST_VERSION,
    active: true,
    ...take,
    recordedByUid: recorder.uid,
    recordedByName: recorder.displayName,
    createdAt: importedAt,
    updatedAt: importedAt,
  };
}

function libraryDocument(plan, recorder, importedAt) {
  return {
    schemaVersion: VOICEOVER_SCHEMA_VERSION,
    manifestVersion: plan.manifestVersion,
    status: plan.status,
    performers: plan.performers,
    styles: plan.styles,
    families: plan.families,
    takeCount: plan.takeCount,
    manifestHash: plan.manifestHash,
    importedByUid: recorder.uid,
    importedAt,
  };
}

function sameFields(existing, expected, ignored = []) {
  const omitted = new Set(ignored);
  const selected = Object.fromEntries(
    Object.keys(expected)
      .filter((key) => !omitted.has(key))
      .map((key) => [key, existing?.[key]]),
  );
  return hashJson(selected) === hashJson(
    Object.fromEntries(Object.entries(expected).filter(([key]) => !omitted.has(key))),
  );
}

function assertStoredCompatibility(snapshot, expected, label, ignored = []) {
  if (snapshot.exists && !sameFields(snapshot.data(), expected, ignored)) {
    throw new Error(`${label} already exists with different content or identity`);
  }
}

async function verifyFirestoreCompatibility({ firestore, plan, recorder, importedAt }) {
  const libraryRef = firestore.collection("voiceoverLibrary").doc("current");
  const takeRefs = plan.takes.map((take) =>
    firestore.collection(TAKES_COLLECTION).doc(take.id));
  const [librarySnapshot, ...takeSnapshots] = await Promise.all([
    libraryRef.get(),
    ...takeRefs.map((reference) => reference.get()),
  ]);
  assertStoredCompatibility(
    librarySnapshot,
    libraryDocument(plan, recorder, importedAt),
    LIBRARY_DOCUMENT,
    ["importedAt"],
  );
  for (const [index, snapshot] of takeSnapshots.entries()) {
    const expected = storedTake(plan.takes[index], recorder, importedAt);
    assertStoredCompatibility(snapshot, expected, snapshot.ref.path, ["createdAt", "updatedAt"]);
  }
}

async function ensureAudioObjects(storage, takes) {
  let created = 0;
  let verified = 0;
  for (const take of takes) {
    let head = await storage.headIfExists(take.objectKey);
    if (!head) {
      const result = await storage.putIfAbsent({
        key: take.objectKey,
        body: take.audio,
        contentHash: take.contentHash,
      });
      if (result.created) created += 1;
      head = await storage.headIfExists(take.objectKey);
    }
    if (!head || head.contentLength !== take.sizeBytes ||
        head.contentType !== "audio/wav" ||
        head.metadata?.sha256 !== take.contentHash) {
      throw new Error(`Stored audio for ${take.id} does not match the import`);
    }
    verified += 1;
  }
  return { created, verified };
}

export async function applyImport({
  firestore,
  storage,
  plan,
  recorder,
  importedAt = new Date().toISOString(),
}) {
  if (!firestore || !storage || !Number.isFinite(Date.parse(importedAt))) {
    throw new Error("The voiceover import dependencies are invalid");
  }
  await verifyFirestoreCompatibility({ firestore, plan, recorder, importedAt });
  const objects = await ensureAudioObjects(storage, plan.takes);
  const libraryRef = firestore.collection("voiceoverLibrary").doc("current");
  const takeRefs = plan.takes.map((take) =>
    firestore.collection(TAKES_COLLECTION).doc(take.id));
  const documents = await firestore.runTransaction(async (transaction) => {
    const [librarySnapshot, ...takeSnapshots] = await Promise.all([
      transaction.get(libraryRef),
      ...takeRefs.map((reference) => transaction.get(reference)),
    ]);
    const expectedLibrary = libraryDocument(plan, recorder, importedAt);
    assertStoredCompatibility(
      librarySnapshot,
      expectedLibrary,
      LIBRARY_DOCUMENT,
      ["importedAt"],
    );
    let created = 0;
    let verified = 0;
    if (!librarySnapshot.exists) transaction.create(libraryRef, expectedLibrary);
    for (const [index, snapshot] of takeSnapshots.entries()) {
      const expected = storedTake(plan.takes[index], recorder, importedAt);
      assertStoredCompatibility(snapshot, expected, snapshot.ref.path, ["createdAt", "updatedAt"]);
      if (snapshot.exists) {
        verified += 1;
      } else {
        transaction.create(takeRefs[index], expected);
        created += 1;
      }
    }
    return { created, verified };
  });
  return { objects, documents };
}

export function parseArguments(args) {
  const options = { apply: false, project: "njpbs-site" };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") {
      options.apply = true;
      continue;
    }
    if (["--manifest", "--audio-root", "--recorder-email", "--project"].includes(argument)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} needs a value`);
      const key = {
        "--manifest": "manifestPath",
        "--audio-root": "audioRoot",
        "--recorder-email": "recorderEmail",
        "--project": "project",
      }[argument];
      options[key] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  for (const [field, flag] of [
    ["manifestPath", "--manifest"],
    ["audioRoot", "--audio-root"],
    ["recorderEmail", "--recorder-email"],
  ]) {
    if (!options[field]) throw new Error(`${flag} is required`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS is required for recorder verification");
  }
  const plan = await buildImportPlan({
    manifestPath: resolve(options.manifestPath),
    audioRoot: resolve(options.audioRoot),
  });
  const app = getApps()[0] || initializeApp({ projectId: options.project });
  try {
    const firestore = getFirestore(app);
    const recorder = await resolveRecorder({
      auth: getAuth(app),
      firestore,
      email: options.recorderEmail,
    });
    if (!options.apply) {
      console.log(
        `Voiceover import dry run passed: ${plan.takeCount} takes, ` +
        `${plan.families.length} families and ${plan.styles.length} styles. ` +
        "The recorder account is verified. Use --apply to write R2 and Firestore.",
      );
      return;
    }
    const storage = new R2VoiceoverStorage({
      endpoint: process.env.CMS_VOICEOVER_R2_ENDPOINT,
      bucket: process.env.CMS_VOICEOVER_R2_BUCKET,
      accessKeyId: process.env.CMS_VOICEOVER_IMPORT_R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.CMS_VOICEOVER_IMPORT_R2_SECRET_ACCESS_KEY,
    });
    const result = await applyImport({ firestore, storage, plan, recorder });
    console.log(
      `Voiceover import applied: ${result.objects.created} objects created, ` +
      `${result.objects.verified} objects verified, ` +
      `${result.documents.created} take documents created and ` +
      `${result.documents.verified} take documents verified.`,
    );
  } finally {
    await deleteApp(app);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
