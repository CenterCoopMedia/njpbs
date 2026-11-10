import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cert, deleteApp, initializeApp } from "firebase-admin/app";
import { FieldPath, FieldValue, getFirestore } from "firebase-admin/firestore";

const hash = value => createHash("sha256").update(value).digest("hex");
const ACTIVATION_PATH = "system/staffAccessActivation";
const PAGE_SIZE = 200;
const MAX_USERS = 10_000;

// The whole deployed source must match the reviewed checkout. A partial helper
// match cannot establish that every profile update path uses the protection.
export async function verifyProtectedLiveRules({ projectId, credential, expectedRules, fetchFn = fetch }) {
  if (!/\.hasAny\(\['role', 'grants', 'active', 'tokensValidAfter', 'accessTier'\]\)/.test(expectedRules)) {
    throw new Error("Reviewed checkout does not contain access tier field protection");
  }
  const { access_token: token } = await credential.getAccessToken();
  async function get(resource) {
    const response = await fetchFn(`https://firebaserules.googleapis.com/v1/${resource}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error("Cannot verify the deployed Firestore rules");
    return response.json();
  }
  const releaseName = `projects/${projectId}/releases/cloud.firestore`;
  const release = await get(releaseName);
  if (typeof release.rulesetName !== "string" || !release.rulesetName.startsWith(`projects/${projectId}/rulesets/`)) {
    throw new Error("Invalid deployed Firestore ruleset reference");
  }
  const ruleset = await get(release.rulesetName);
  const files = ruleset.source?.files;
  if (!Array.isArray(files) || files.length !== 1 || typeof files[0].content !== "string" ||
      hash(files[0].content) !== hash(expectedRules)) {
    throw new Error("Live Firestore rules differ from the reviewed protected checkout");
  }
  return { rulesetName: release.rulesetName, protectedRulesSha256: hash(expectedRules) };
}

export async function scanUsersForExistingTiers(firestore, maxUsers = MAX_USERS) {
  let cursor;
  let scannedUsers = 0;
  const documentIds = [];
  for (;;) {
    let query = firestore.collection("users").select("accessTier").orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor !== undefined) query = query.startAfter(cursor);
    const page = await query.get();
    for (const document of page.docs) {
      scannedUsers += 1;
      if (Object.hasOwn(document.data(), "accessTier")) documentIds.push(document.id);
    }
    if (scannedUsers > maxUsers) return { complete: false, scannedUsers, documentIds };
    if (page.size < PAGE_SIZE) return { complete: true, scannedUsers, documentIds };
    cursor = page.docs.at(-1).id;
  }
}

export async function inspectStaffTierReaders({ firestore, projectId, credential, expectedRules, fetchFn = fetch }) {
  const verifyRules = () => verifyProtectedLiveRules({ projectId, credential, expectedRules, fetchFn });
  if ((await firestore.doc(ACTIVATION_PATH).get()).exists) throw new Error("Activation evidence already exists; do not rescan or replace it");
  const protectedRules = await verifyRules();
  const scan = await scanUsersForExistingTiers(firestore);
  if (!scan.complete || scan.documentIds.length) return { ready: false, ...scan };
  const confirmedRules = await verifyRules();
  if (confirmedRules.rulesetName !== protectedRules.rulesetName) throw new Error("Deployed rules changed during the scan");
  return { ready: true, ...scan, ...protectedRules };
}

export async function activateStaffTierReaders(options) {
  const { ready, rulesetName, protectedRulesSha256, ...scan } = await inspectStaffTierReaders(options);
  if (!ready) return { activated: false, ...scan };
  await options.firestore.doc(ACTIVATION_PATH).create({ schema: 1, state: "active", cleanScan: true, rulesetName, protectedRulesSha256,
    scannedUsers: scan.scannedUsers, activatedAt: FieldValue.serverTimestamp() });
  return { activated: true, ...scan };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 3 || !["--check", "--activate"].includes(args[0]) || args[1] !== "--project" || args[2] !== "njpbs-site" ||
      process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new Error("Use --check or the separately approved --activate with --project njpbs-site");
  }
  let key;
  try { key = JSON.parse(readFileSync(0, "utf8")); } catch { throw new Error("Approved credential JSON is required on stdin"); }
  if (key.type !== "service_account" || key.project_id !== args[2]) throw new Error("Credential project does not match activation project");
  const credential = cert(key);
  const app = initializeApp({ credential, projectId: args[2] }, "staff-tier-reader-activation");
  try {
    const expectedRules = readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");
    const operation = args[0] === "--activate" ? activateStaffTierReaders : inspectStaffTierReaders;
    const result = await operation({ firestore: getFirestore(app),
      projectId: args[2], credential, expectedRules });
    // No names, email addresses, user fields, credentials or provider response bodies.
    console.log(JSON.stringify(result));
    if (!(result.activated || result.ready)) process.exitCode = 1;
  } finally { await deleteApp(app); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("Staff tier reader activation stopped; no activation evidence written"); process.exitCode = 1; });
}
