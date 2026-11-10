// Private backfill for the author/staff/profile foundation (issue #1044, lane 1).
//
// Creates the private staff record and private working author profile for every
// existing active CMS user that does not already have them. Nothing this script
// writes is public: profiles start private, and only their owner can publish
// one.
//
// What it will NOT do is guess who someone is. There is no reliable join from a
// `users/{uid}` account to an existing staff-type CONTENT record: those records
// carry a name, a role, and a bio, but no uid and no email, so matching them by
// name would silently bind one person's account to another person's public
// listing -- and the resulting authorId is the permanent join key for every
// byline they ever write. So the linkage rule is:
//
//   1. An explicit `mapping[uid]` entry wins. It may name the display name, and
//      may name a staff content record id to source it from.
//   2. Otherwise `users/{uid}.displayName` is used.
//   3. Otherwise the account is REPORTED, not seeded. Those users get their
//      linkage minted the first time they open their own profile, which is a
//      path where the person themselves supplies the name.
//
// Idempotent, in the shape of scripts/backfill-page-seed-media.mjs: a pure
// exported transactional function, a thin CLI wrapper, verify-or-create rather
// than overwrite, an audit row per creation, and a `system:*` actor.

import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deleteApp, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import storePkg from "../functions/lib/author-profile-store.js";
import contractPkg from "../functions/lib/author-profile-contract.js";

const { ensureAuthorIdentity, AUDIT_ACTIONS } = storePkg;
const { AUTHOR_NAME_MAX } = contractPkg;

export const SYSTEM_ACTOR = "system:author-profile-backfill";

/**
 * Collection holding staff-type editorial content records. The content storage
 * contract routes every non-page kind -- `staff` included -- to `cmsPosts`;
 * `cmsPages` holds only the canonical pages, so looking there made every
 * explicit `staffContentId` mapping fail as "does not exist".
 */
const STAFF_CONTENT_COLLECTION = "cmsPosts";

function trimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Decide the display name to seed one account's profile with, and say where it
 * came from. Returns null when nothing unambiguous is available -- the caller
 * reports that account instead of inventing a public-facing name for it.
 */
export function resolveSeedName({ uid, userDoc, mappingEntry, staffContentById }) {
  const mapped = mappingEntry ?? null;

  if (mapped) {
    const explicit = trimmedString(mapped.displayName);
    if (explicit) {
      return { displayName: explicit.slice(0, AUTHOR_NAME_MAX), source: "mapping" };
    }
    const contentId = trimmedString(mapped.staffContentId);
    if (contentId) {
      const record = staffContentById.get(contentId);
      if (!record) {
        throw new Error(
          `Mapping for ${uid} names staff content record ${contentId}, which does not exist`,
        );
      }
      const name = trimmedString(record.name);
      if (!name) {
        throw new Error(
          `Staff content record ${contentId} has no name to seed ${uid} with`,
        );
      }
      return {
        displayName: name.slice(0, AUTHOR_NAME_MAX),
        source: "staff_content_record",
        staffContentId: contentId,
      };
    }
    throw new Error(
      `Mapping for ${uid} must supply displayName or staffContentId`,
    );
  }

  const stored = trimmedString(userDoc?.displayName);
  if (stored) {
    return { displayName: stored.slice(0, AUTHOR_NAME_MAX), source: "user_document" };
  }
  return null;
}

/**
 * Read the staff-type content records once, keyed by id. Used only to resolve a
 * name an operator has explicitly pointed at; never scanned for a match.
 */
async function readStaffContentRecords(firestore) {
  const snapshot = await firestore
    .collection(STAFF_CONTENT_COLLECTION)
    .where("type", "==", "staff")
    .get();
  return new Map(snapshot.docs.map((doc) => [doc.id, doc.data()]));
}

/**
 * Create the private staff record and working profile for every active CMS user
 * that lacks them.
 *
 * @param {object} options
 * @param {import("firebase-admin/firestore").Firestore} options.firestore
 * @param {string} [options.nowIso]
 * @param {Record<string, {displayName?: string, staffContentId?: string}>} [options.mapping]
 *   Explicit uid -> identity mapping for accounts the automatic rules cannot
 *   resolve. Required for any account with no stored display name.
 * @param {() => string} [options.randomHex] entropy source for authorId minting.
 * @returns {Promise<{created: string[], verified: string[], needsMapping: string[], skippedInactive: string[]}>}
 */
export async function backfillAuthorProfiles({
  firestore,
  nowIso = new Date().toISOString(),
  mapping = {},
  randomHex = () => randomBytes(16).toString("hex"),
} = {}) {
  if (!firestore || typeof firestore.runTransaction !== "function") {
    throw new Error("A Firestore Admin client is required");
  }
  if (!Number.isFinite(Date.parse(nowIso))) {
    throw new Error("The author profile backfill timestamp is invalid");
  }

  const [usersSnapshot, staffContentById] = await Promise.all([
    firestore.collection("users").get(),
    readStaffContentRecords(firestore),
  ]);

  const unknownMappings = Object.keys(mapping).filter(
    (uid) => !usersSnapshot.docs.some((doc) => doc.id === uid),
  );
  if (unknownMappings.length > 0) {
    // Fail before writing anything. A mapping entry for a uid that is not in the
    // roster is almost always a typo, and half-applying the batch would leave an
    // operator guessing which half ran.
    throw new Error(
      `Mapping names uids that are not CMS users: ${unknownMappings.join(", ")}`,
    );
  }

  const created = [];
  const verified = [];
  const needsMapping = [];
  const skippedInactive = [];

  for (const doc of usersSnapshot.docs) {
    const uid = doc.id;
    const userDoc = doc.data();
    if (userDoc?.active === false) {
      skippedInactive.push(uid);
      continue;
    }

    const seed = resolveSeedName({
      uid,
      userDoc,
      mappingEntry: mapping[uid],
      staffContentById,
    });
    if (!seed) {
      needsMapping.push(uid);
      continue;
    }

    // One transaction per account. Verify-or-create is idempotent, so a rerun
    // after a partial failure resumes rather than duplicating, and one bad
    // account cannot roll back the whole roster.
    const result = await ensureAuthorIdentity({
      firestore,
      uid,
      email: userDoc?.email ?? null,
      displayName: seed.displayName,
      nowIso,
      actorUid: SYSTEM_ACTOR,
      actorEmail: null,
      source: "cms_backfill",
      randomHex: randomHex(),
      auditAction: AUDIT_ACTIONS.backfill,
      // resolveSeedName has already applied the linkage rule above: an explicit
      // mapping entry wins, then the user document. Letting the store fall back
      // to `users/{uid}.displayName` again would invert rule 1 and throw away
      // the operator's correction whenever the stale name is nonempty.
      preferSuppliedName: true,
    });
    if (result.created) created.push(uid);
    else verified.push(uid);
  }

  return { created, verified, needsMapping, skippedInactive };
}

async function main() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS is required");
  }
  const mappingJson = process.env.AUTHOR_PROFILE_MAPPING;
  let mapping = {};
  if (mappingJson) {
    mapping = JSON.parse(mappingJson);
    if (mapping === null || typeof mapping !== "object" || Array.isArray(mapping)) {
      throw new Error("AUTHOR_PROFILE_MAPPING must be a JSON object");
    }
  }

  const app = getApps()[0] || initializeApp({ projectId: "njpbs-site" });
  try {
    const result = await backfillAuthorProfiles({
      firestore: getFirestore(app),
      mapping,
    });
    console.log(
      `Author profiles ready: ${result.created.length} created, ` +
        `${result.verified.length} verified, ` +
        `${result.skippedInactive.length} inactive accounts skipped.`,
    );
    if (result.needsMapping.length > 0) {
      // Not a failure. These accounts have no stored display name, so they get
      // their linkage when the person opens their own profile -- or sooner, if
      // an operator supplies AUTHOR_PROFILE_MAPPING and reruns.
      console.log(
        `Needs an explicit mapping (no stored display name): ${result.needsMapping.join(", ")}`,
      );
    }
  } finally {
    await deleteApp(app);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
