// Backfill legacy newsroom posts into News (#2749). Dry-run by default.
// Apply is bound to a reviewed plan, including the current posts and user grants.
// Nothing infers an area on the normal read/save path, and unassigned owner drafts
// retain their deliberate one-time area choice.

import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import sections from "../functions/lib/content-sections.js";
import principals from "../functions/lib/principal.js";
import authorization from "../functions/lib/content-authorization.js";
import rbac from "../functions/lib/rbac.js";
import activation from "../functions/lib/access-tier-activation.js";

const SYSTEM_ACTOR = "system:news-area-backfill";
// At most 402 writes: one update and audit per post, plus the registry and its audit.
const MAX_POSTS_PER_APPLY = 200;
const NEWS = sections.SEEDED_CONTENT_SECTIONS.find((section) => section.id === "news");
const CONTENT_CAPABILITIES = rbac.ALL_CAPABILITIES.filter((capability) => capability.startsWith("content."));

function revision(snapshot) {
  return { id: snapshot.id, updated: snapshot.updateTime ? [snapshot.updateTime.seconds, snapshot.updateTime.nanoseconds] : null };
}

// After activation, a whole-site staff access level is authoritative over legacy grants.
function permissionChanges(users, stored, tiersActive) {
  const before = authorization.contentResource({ collection: "cmsPosts", stored });
  const after = { ...before, section: "news" };
  return users.flatMap((user) => {
    const principal = principals.principalFromUserDoc(user.id, user.data(), tiersActive);
    const gained = CONTENT_CAPABILITIES.filter((capability) =>
      !rbac.can(principal, capability, before) && rbac.can(principal, capability, after));
    const lost = CONTENT_CAPABILITIES.filter((capability) =>
      rbac.can(principal, capability, before) && !rbac.can(principal, capability, after));
    return gained.length || lost.length ? [{ uid: user.id, gained, lost }] : [];
  });
}

function auditEntry(action, target, before, after, planHash, nowIso) {
  return {
    actorUid: SYSTEM_ACTOR, actorEmail: null, action, target, before, after,
    planHash, source: "backfill-news-area", at: nowIso,
    timestamp: FieldValue.serverTimestamp(),
  };
}

export async function backfillNewsArea({
  firestore,
  apply = false,
  expectedPlan,
  postIds,
  nowIso = new Date().toISOString(),
} = {}) {
  if (!firestore || typeof firestore.runTransaction !== "function") {
    throw new Error("A Firestore Admin client is required");
  }
  if (!Number.isFinite(Date.parse(nowIso))) throw new Error("Invalid backfill timestamp");
  if (apply && !/^[a-f0-9]{64}$/.test(expectedPlan ?? "")) {
    throw new Error("Apply requires --expected-plan from a reviewed dry run");
  }
  if (postIds !== undefined && (!Array.isArray(postIds) || postIds.length === 0 ||
      postIds.some((id) => typeof id !== "string" || !id || id !== id.trim() || id.includes("/")))) {
    throw new Error("Post ids must be a non-empty list of document ids");
  }

  return firestore.runTransaction(async (transaction) => {
    const newsRef = firestore.collection("sections").doc("news");
    const [news, posts, users, tiersActive] = await Promise.all([
      transaction.get(newsRef),
      transaction.get(firestore.collection("cmsPosts").where("type", "==", "post")),
      transaction.get(firestore.collection("users")),
      activation.accessTierReadsActive(firestore, transaction),
    ]);
    const wanted = postIds === undefined ? null : new Set(postIds);
    if (wanted && [...wanted].some((id) => !posts.docs.some((doc) => doc.id === id))) {
      throw new Error("A selected post is missing or is not a newsroom post");
    }
    const selected = posts.docs.filter((doc) => !wanted || wanted.has(doc.id));
    const pending = [];
    const rows = selected.map((doc) => {
      const stored = doc.data();
      let action;
      if (authorization.isUnassignedPostDraft(stored)) action = "skip-unassigned-draft";
      else if (stored.unassignedDraft === true) action = "conflict";
      else if (stored.section === "news") action = "verify";
      else if (stored.section !== undefined && stored.section !== null) action = "conflict";
      else {
        action = "stamp";
        pending.push(doc);
      }
      return {
        id: doc.id, action, section: stored.section ?? null,
        permissionChanges: action === "stamp" ? permissionChanges(users.docs, stored, tiersActive) : [],
      };
    });
    const blocked = [];
    if (news.exists && news.data().id !== "news") blocked.push("News registry id conflicts with its key");
    if (rows.some((row) => row.action === "conflict")) blocked.push("Existing post areas or draft markers need an explicit decision");
    if (pending.length > MAX_POSTS_PER_APPLY) blocked.push("More than 200 posts: use --post-id to review and apply smaller batches");
    const plan = { registry: news.exists ? "verify" : "create", rows, blocked };
    const planHash = createHash("sha256").update(JSON.stringify({
      version: 1, plan, registryRevision: revision(news),
      postRevisions: selected.map(revision), userRevisions: users.docs.map(revision),
    })).digest("hex");
    if (apply && expectedPlan !== planHash) throw new Error("The dry-run plan changed; review a fresh dry run before applying");
    if (apply && blocked.length) throw new Error(blocked.join("; "));

    if (apply) {
      if (!news.exists) {
        const record = { ...NEWS, createdAt: nowIso, updatedAt: nowIso, createdBy: SYSTEM_ACTOR, updatedBy: SYSTEM_ACTOR };
        transaction.create(newsRef, record);
        transaction.create(firestore.collection("admin_logs").doc(), auditEntry(
          "section.registry_seed", "sections/news", null, NEWS, planHash, nowIso,
        ));
      }
      for (const doc of pending) {
        transaction.update(doc.ref, { section: "news", updatedAt: nowIso, updatedBy: SYSTEM_ACTOR });
        transaction.create(firestore.collection("admin_logs").doc(), auditEntry(
          "content.section_backfill", `cmsPosts/${doc.id}`, { section: doc.data().section ?? null },
          { section: "news", permissionChanges: rows.find((row) => row.id === doc.id).permissionChanges },
          planHash, nowIso,
        ));
      }
    }
    return { dryRun: !apply, planHash, ...plan, postsStamped: apply ? pending.length : 0 };
  });
}

async function main() {
  const { values } = parseArgs({ options: {
    apply: { type: "boolean", default: false },
    "expected-plan": { type: "string" },
    "post-id": { type: "string", multiple: true },
    project: { type: "string", default: "njpbs-site" },
  } });
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS or FIRESTORE_EMULATOR_HOST is required");
  }
  const app = initializeApp({ projectId: values.project });
  try {
    console.log(JSON.stringify(await backfillNewsArea({
      firestore: getFirestore(app), apply: values.apply,
      expectedPlan: values["expected-plan"], postIds: values["post-id"],
    }), null, 2));
  } finally {
    await deleteApp(app);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
