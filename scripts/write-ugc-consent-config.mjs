import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEXT_FIELDS = ["release", "checkbox", "age", "ageHelp", "privacy", "closed", "thanks"];
const PROJECT_ID = "njpbs-site";

export function validateUgcConsentFile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value.open !== "boolean" ||
      typeof value.consentVersion !== "string" ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.consentVersion) ||
      typeof value.approvedBy !== "string" || !value.approvedBy.trim() ||
      !value.texts || typeof value.texts !== "object" || Array.isArray(value.texts) ||
      TEXT_FIELDS.some((field) => typeof value.texts[field] !== "string" ||
        !value.texts[field].trim())) {
    throw new Error("Consent file requires open, consentVersion, approvedBy and all seven nonempty texts");
  }
  if (Object.keys(value).some((field) => !["open", "consentVersion", "approvedBy", "texts"].includes(field)) ||
      Object.keys(value.texts).some((field) => !TEXT_FIELDS.includes(field))) {
    throw new Error("Consent file contains an unsupported field");
  }
  return {
    open: value.open, consentVersion: value.consentVersion,
    approvedBy: value.approvedBy,
    texts: Object.fromEntries(TEXT_FIELDS.map((field) => [field, value.texts[field]])),
    consentTextHash: createHash("sha256").update(value.texts.release, "utf8").digest("hex"),
  };
}

export function assertConsentVersionChange(current, next) {
  if (current?.consentVersion === next.consentVersion && current?.texts &&
      TEXT_FIELDS.some((field) => current.texts[field] !== next.texts[field])) {
    throw new Error("Changed consent wording requires a new consentVersion");
  }
}

export async function run(args, env = process.env) {
  if (args.length < 1 || args.length > 2 || args[1] !== undefined && args[1] !== "--apply") {
    throw new Error("Usage: node scripts/write-ugc-consent-config.mjs <reviewed.json> [--apply]");
  }
  const next = validateUgcConsentFile(JSON.parse(await readFile(args[0], "utf8")));
  console.log(`Release paragraph SHA-256: ${next.consentTextHash}`);
  console.log(`Consent version: ${next.consentVersion}; form: ${next.open ? "open" : "closed"}`);
  if (args[1] !== "--apply") {
    console.log("Dry run. No Firestore data was read or written.");
    return;
  }
  if (!env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS is required for --apply");
  }
  const { applicationDefault, deleteApp, initializeApp } = await import("firebase-admin/app");
  const { FieldValue, getFirestore } = await import("firebase-admin/firestore");
  const app = initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
  try {
    const firestore = getFirestore(app);
    const ref = firestore.collection("ugcConfig").doc("current");
    const versionRef = firestore.collection("ugcConsentVersions").doc(next.consentVersion);
    await firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const version = await transaction.get(versionRef);
      assertConsentVersionChange(snapshot.data(), next);
      assertConsentVersionChange(version.data(), next);
      if (!version.exists) transaction.create(versionRef, {
        consentVersion: next.consentVersion, texts: next.texts,
        consentTextHash: next.consentTextHash,
      });
      transaction.set(ref, {
        consentVersion: next.consentVersion, approvedBy: next.approvedBy,
        approvedAt: next.open ? FieldValue.serverTimestamp() : null,
        texts: next.texts,
      });
    });
    console.log(`Wrote ugcConfig/current in ${PROJECT_ID}.`);
  } finally {
    await deleteApp(app);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await run(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
