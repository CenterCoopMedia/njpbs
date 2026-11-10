"use strict";

// Readable people and content names for the activity stream (#1038).
//
// admin_logs rows are append-only compliance evidence. They record the uid, the
// stored path, and the raw action and source codes that were true at the moment
// something happened, and nothing here rewrites any of that: an audit record that
// could be edited later is not evidence. Every readable label below is derived
// when a page is READ, from the directory as it stands right now, and is returned
// alongside the untouched stored fields.
//
// That read-time join is also what makes a rename correct. The stored actorEmail
// is the address the account had that day; showing it as the primary label tells
// an editor the wrong thing about who a person is now. The current users/{uid}
// document answers "who is this" and the stored row keeps answering "what did the
// server see".
//
// `lib/review-queue.js` resolves staff labels for the editorial queue and is
// deliberately stricter: an editor there gets a name or "Another staff member"
// and never an account id, because the queue is a working surface for the whole
// newsroom. This module answers a different question for a different audience --
// an administrator holding audit.view reading the compliance stream, who needs
// the exact identifiers to act on a row. Same underlying read of users/{uid};
// different disclosure rule, which is why it is a second resolver rather than a
// shared one with a mode flag.
//
// Privacy is a capability decision, not a formatting one. Account fields -- the
// uid, the address, and the immutable id of a person-shaped target -- are only
// returned to a caller who holds users.view. Everyone else gets the display name,
// or a masked address when there is no name, so the row stays attributable without
// handing out a directory. The gate fails closed: an unreadable principal, an
// unknown role, or a failed directory read all resolve to no account fields.

const { hasCapability } = require("./rbac");

const UNKNOWN_ACTOR_LABEL = "Unknown person";
const DELETED_ACTOR_LABEL = "Deleted account";
const DELETED_CONTENT_LABEL = "Deleted content";
const UNAVAILABLE_LABEL = "Name unavailable";
const NO_TARGET_LABEL = "No target recorded";
const UNKNOWN_ACTION_LABEL = "Unknown action";
const NOT_RECORDED_LABEL = "Not recorded";

// Plain newsroom language for every code the server writes to admin_logs. A code
// with no entry is humanized rather than hidden, and reports known:false so the
// admin can present it honestly instead of inventing a meaning -- but an ordinary
// operation must never land there, so this table covers the whole writer surface
// and `tests/functions/activity-action-coverage.test.js` collects the codes back
// out of the writers and fails when one arrives without language.
const ACTIVITY_ACTION_LABELS = Object.freeze({
  delete_live_production_device: "Studio device deleted",
  "election_source.connect": "Election results source connected",
  "election_source.approve": "Election results connection approved",
  "election_source.status": "Election result status changes approved",
  "election_source.pause": "Election results updates paused",
  "election_source.resume": "Election results updates resumed",
  "election_source.hold": "Election results update held",
  "election_source.publish": "Election results updated from source",
  // Content workflow.
  post_template_capture: "Post template saved",
  post_template_update: "Post template changed",
  post_template_remove: "Post template removed",
  "cms.approve": "Content approved",
  "cms.archive": "Content archived",
  "cms.assign": "Assignment changed",
  "cms.bulk_archive": "Content archived",
  "cms.edit": "Opened content for editing",
  "cms.media-usage-repair": "Media usage records repaired",
  "cms.preview.request": "Preview requested",
  "cms.publish": "Publication requested",
  "cms.publicationRequested": "Publication retry requested",
  "cms.publicationRechecked": "Public confirmation checked",
  "cms.publish-snapshot": "Publish snapshot saved",
  "cms.live-blog-update": "Live blog update requested",
  "cms.reopen": "Approved content reopened",
  "cms.restore": "Archived content restored",
  "cms.restore-revision": "Earlier version restored",
  "cms.revise": "Published content reopened for edits",
  "cms.save": "Content saved",
  "cms.schedule": "Publication scheduled",
  "cms.schedule-publish": "Scheduled publication requested",
  "cms.schedule-publish-failed": "Scheduled publication failed",
  "cms.sendBack": "Sent back for changes",
  "cms.settings.publish": "Settings published",
  "cms.settings.save": "Settings saved",
  "cms.siteUpdateRetried": "Site update retry requested",
  "costLedger.seed": "Cost ledger started",
  "costLedger.saveLine": "Cost line saved",
  "costLedger.savePeriodAmount": "Monthly cost amount saved",
  "costLedger.saveHardware": "Hardware cost assumptions saved",
  "costLedger.saveComparison": "CMS cost comparison saved",
  "costLedger.closeMonth": "Cost month closed",
  "costLedger.reopenMonth": "Cost month reopened",
  "cms.submit": "Sent for review",
  "cms.unpublish": "Removal requested",
  "cms.unschedule": "Publication unscheduled",
  "dataset.assign": "Dataset assignment changed",
  "dataset.save": "Dataset saved",
  "dataset.review": "Dataset sent for review",
  "dataset.approve": "Dataset approved",
  "dataset.archive": "Dataset archived",
  "content.article_converted_to_post": "Article converted to Post",
  "bug_report.create": "CMS problem reported",
  "bug_report.nudge": "Report follow-up nudge requested",
  "bug_report.nudge_approved": "Report follow-up approved",
  "bug_report.nudge_ignored": "Report nudge ignored",
  "bug_report.acknowledge": "Problem report acknowledged",
  "bug_report.assign": "Problem report assignment changed",
  "bug_report.relate": "Related problem reports changed",
  "bug_report.resolution": "Problem report resolution updated",
  "bug_report.status": "Problem report status changed",
  "bug_report.take_over": "Problem report taken over",
  "bug_report.notification_retry": "Problem report notification retried",
  "bug_report.github_create_issue": "GitHub issue queued from a problem report",
  "bug_report.github_create_issue_and_fix": "GitHub issue and draft fix queued from a problem report",
  "bug_report.github_attach_issue": "GitHub issue attached to a problem report",
  "bug_report.github_attach_pull_request": "GitHub pull request attached to a problem report",
  "bug_report.github_sync": "GitHub state sync queued from a problem report",
  "bug_report.github_create_issue_complete": "GitHub issue linked to a problem report",
  "bug_report.github_create_issue_and_fix_complete": "GitHub issue linked and draft fix started",
  "bug_report.github_attach_issue_complete": "Attached GitHub issue verified",
  "bug_report.github_attach_pull_request_complete": "Attached GitHub pull request verified",
  "bug_report.github_sync_complete": "GitHub state synced to a problem report",
  // Media.
  "media.category.archive": "Media category archived",
  "media.category.create": "Media category created",
  "media.category.restore": "Media category restored",
  "media.category.update": "Media category updated",
  "media.binary.replace": "Image file replaced",
  "media.video.replace.request": "Video file replacement requested",
  "media.video.export.request": "Vertical or horizontal video export requested",
  "media.video.export.stray": "Late video export upload found after its deadline",
  "media.video.replace": "Video file replaced",
  "media.video.rollback": "Previous video file restored",
  "media.video.version.delete": "Previous video file permanently deleted",
  "media.video.version.reconcile": "Previous video processing reconciled for cleanup",
  "media.video.search.delete.claim": "Private video search cleanup started",
  "media.video.search.delete.complete": "Private video search version permanently deleted",
  "media.lifecycle.reactivate": "Media file returned to the library",
  "media.lifecycle.tombstone": "Media file retired",
  "media.library.delete": "Media file deleted from the library",
  "media.library.restore": "Media file restored from the bin",
  "media.purge.dry_run": "Media purge dry run completed",
  "media.purge": "Image version permanently removed",
  "media.purge.run": "Image purge report recorded",
  "media.bin.backfill": "Deleted media file given a bin deadline",
  "media.source.preview.retry": "Video viewing copy retried",
  "media.original.restore": "Video original restore requested",
  "media.metadata.update": "Media details updated",
  // Staff comments on media items (media-feedback.js writes media_comment_<action>).
  media_comment_create: "Staff comment added",
  media_comment_edit: "Staff comment edited",
  media_comment_delete: "Staff comment deleted",
  media_comment_resolve: "Comment thread resolved",
  media_comment_reopen: "Comment thread reopened",
  media_comment_export: "Staff comments exported",
  "media.clip.cancel": "Video export cancelled",
  "media.clip.request": "Video clip requested",
  "media.transcription.credential.save": "Transcription key configured",
  "media.transcription.credential.disconnect": "Transcription key disconnected",
  "media.transcript.align.cancel": "Transcript timing resync cancelled",
  "media.transcript.align.request": "Transcript timing resync requested",
  "media.transcript.edit": "Video transcript edited",
  "media.transcript.request": "Video transcript requested",
  "media.transcript.policy": "Video transcription policy changed",
  "media.upload": "Media uploaded",
  "media.upload.abandon": "Abandoned upload cleaned up",
  "media.upload.discard": "Rejected upload discarded",
  // Author profiles.
  "author_profile.account_link": "Author profile linked to a CMS account",
  "author_profile.admin_update": "Author profile updated by an administrator",
  "author_profile.archive": "Author profile archived",
  "author_profile.backfill": "Author profile backfilled",
  "author_profile.create": "Author profile created",
  "author_profile.delete_draft": "Author profile draft deleted",
  "author_profile.photo_attach": "Author photo added",
  "author_profile.photo_remove": "Author photo removed",
  "author_profile.publish": "Author profile published",
  "author_profile.slug_rename": "Author profile address changed",
  "author_profile.staff_resync": "Author profile synced with the staff record",
  "author_profile.unpublish": "Author profile unpublished",
  "author_profile.update": "Author profile updated",
  "author_profile.withdraw": "Author profile withdrawn",
  // Accounts and access.
  "auth.login": "Signed in",
  "auth.login.refused": "Sign-in refused",
  "roles.bootstrap": "Super admin bootstrapped",
  "roles.grant": "Role granted",
  "roles.provision": "Staff access provisioned",
  "roles.revoke": "Role revoked",
  "staff.deactivate": "Staff account deactivated",
  "staff.level.replace": "Staff access level replaced",
  "staff.reactivate": "Staff account reactivated",
  "staff_access.approve": "Staff access request approved",
  "staff_access.deny": "Staff access request denied",
  "staff_access.onboarding_provision": "Guide access provisioned",
  // Historical actions from the retired onboarding system.
  "onboarding.invite_queue": "Onboarding invitation queued",
  "onboarding.invite_retry": "Onboarding invitation retried",
  "onboarding.plan_save": "Onboarding plan saved",
  // Public deployment.
  "public-deployment.activate": "Public deployment activated",
  "public-deployment.fail": "Public deployment failed",
  "public-deployment.reconcile": "Public deployment reconciled",
  "public-release.switch": "Public release selected",
  "public-release.bootstrap-admission": "Public publishing admission updated",
  "public-release.dev-runtime-pause": "Development public publishing paused",
  "public-release.dev-pause-failed": "Development public publishing drain failed",
  "public-release.dev-pause-quiescent": "Development public publishing failures sealed",
  "public-release.dev-runtime-restored": "Development public publishing restored before enrollment",
  "public-release.production-runtime-pause": "Production public publishing paused",
  "public-release.production-pause-failed": "Production public publishing drain failed",
  "public-release.production-runtime-restored": "Production public publishing restored before enrollment",
  "public-release.pre-enrollment-history-retired": "Old public publishing preparation cancelled",
  "public-release.publication-settle": "Public publication confirmed",
  "cms-publication-baseline.cancel-claimed": "Claimed publication baseline cancelled",
  "cms-publication-baseline.cancel-unclaimed": "Unclaimed publication baseline cancelled",
  "cms-publication-baseline.recover": "Publication baseline recovery queued",
  "cms-publication-baseline.retire": "Publication baseline retired",
  "cms-publication-content.cancel-claimed": "Claimed publication content cancelled",
  "cms-content.settle-unpublished-withdrawal": "Unpublished content withdrawal settled",
  "public-media-lifecycle.activate": "Public media publishing activated",
});

const ACTIVITY_SOURCE_LABELS = Object.freeze({
  scheduler: "Scheduled automation",
  upload: "Media upload",
});

// A uid the server writes for work no person performed. Naming these keeps
// "system:scheduler" out of a newsroom-facing column.
const SYSTEM_ACTOR_LABELS = Object.freeze({
  "system:article-to-post-migration": "Article-to-Post migration",
  "system:media": "Media store maintenance",
  "system:bug-report-github": "Problem report GitHub sync",
  "system:scheduler": "Scheduled publishing",
  "system:public-deployment": "Public deployment",
  "system:public-release-switch": "Public release selection",
  "system:public-release-bootstrap": "Public release bootstrap",
  "system:public-release-terminal": "Public publication confirmation",
  "system:video-preview-retry": "Video viewing copy recovery",
});
const SYSTEM_ACTOR_PREFIX = "system:";
const GENERIC_SYSTEM_ACTOR_LABEL = "Automated task";

// Collections whose documents an editor can be shown by name, with the type word
// used when the document itself does not carry a more specific kind.
const CONTENT_COLLECTION_LABELS = Object.freeze({
  cmsPages: "Page",
  cmsPosts: "Post",
  cmsPostTemplates: "Post template",
  media_assets: "Media file",
  cmsSettings: "Setting",
  cmsAuthorProfiles: "Author profile",
  cmsDatasets: "Dataset",
});

// A queue reference has nothing to look up, so the action says what the id is a
// receipt for instead of leaving a bare token as the label.
const REQUEST_TARGET_LABELS = Object.freeze({
  "cms.publish": "Publish request",
  "cms.publicationRequested": "Publication retry request",
  "cms.publicationRechecked": "Publish request",
  "cms.preview.request": "Preview request",
});

// Names for a kind an audit row already recorded, so this table is wider than what
// can be created today: article is retired (#1039) and no boundary writes one any
// more, but history that names one still has to read as English.
const CONTENT_KIND_LABELS = Object.freeze({
  page: "Page",
  post: "Post",
  article: "Article",
  episode: "Episode",
  event: "Event",
  person: "Person",
  show: "Show",
});

const PERSON_COLLECTION = "users";
// A staff record is keyed by the account uid, so it resolves as the person it
// describes rather than as a second, unnamed record type.
const PERSON_COLLECTION_ALIASES = new Set(["users", "cmsStaffRecords"]);
const PERSON_ACTION_PREFIXES = ["roles.", "staff."];
const PERSON_TYPE_LABEL = "Staff account";
const MAX_ACTIVITY_LABEL_BYTES = 256;
const MAX_TARGET_BYTES = 1_500;

function trimmedString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function truncateUtf8(value, maxBytes) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const marker = "…";
  const contentBytes = maxBytes - Buffer.byteLength(marker, "utf8");
  let result = "";
  let resultBytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (resultBytes + characterBytes > contentBytes) break;
    result += character;
    resultBytes += characterBytes;
  }
  return `${result}${marker}`;
}

function titleCaseFirst(value) {
  return `${value[0].toLocaleUpperCase("en-US")}${value.slice(1)}`;
}

/** Plain language for one stored action code. */
function describeActivityAction(action) {
  const code = trimmedString(action);
  if (!code) return { code: null, label: UNKNOWN_ACTION_LABEL, known: false };
  if (Object.hasOwn(ACTIVITY_ACTION_LABELS, code)) {
    return { code, label: ACTIVITY_ACTION_LABELS[code], known: true };
  }
  // Drop the writer's namespace when it is one this server owns. "cms" and
  // "media" are machine vocabulary; leaving them in reads as a defect on the
  // card, and the exact code is still returned and shown in support details. An
  // unfamiliar namespace is kept, because there it may be the only clue to what
  // wrote the row.
  const withoutNamespace = code.replace(
    /^(auth|cms|media|roles|staff|staff_access|author_profile|public-deployment)\./,
    "",
  );
  const words = (withoutNamespace || code).replace(/[._-]+/g, " ").trim();
  return {
    code,
    label: words ? titleCaseFirst(words) : UNKNOWN_ACTION_LABEL,
    known: false,
  };
}

// The stored source is either a named origin the server chose or the request
// address it saw. An address is not a sentence, so it becomes supporting detail
// under a label a person can read.
function describeActivitySource(source) {
  const value = trimmedString(source);
  if (!value) return { label: NOT_RECORDED_LABEL, detail: null };
  if (Object.hasOwn(ACTIVITY_SOURCE_LABELS, value)) {
    return { label: ACTIVITY_SOURCE_LABELS[value], detail: null };
  }
  if (/^[0-9a-fA-F.:]+$/.test(value) && /[.:]/.test(value)) {
    return { label: "Admin app", detail: value };
  }
  return { label: titleCaseFirst(value.replace(/[._-]+/g, " ")), detail: null };
}

function isPersonAction(action) {
  const code = trimmedString(action) ?? "";
  return PERSON_ACTION_PREFIXES.some((prefix) => code.startsWith(prefix));
}

/**
 * What a stored target names, without reading anything. Returns the kind, the
 * collection and document id when there is one, and the raw stored value so the
 * immutable id survives into the response.
 */
function parseActivityTarget({ action, target }) {
  const raw = trimmedString(target);
  if (!raw || Buffer.byteLength(raw, "utf8") > MAX_TARGET_BYTES) {
    return { kind: "none", collection: null, documentId: null, raw: null };
  }
  const segments = raw.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 1) {
    // Role and staff endpoints record a bare uid. Nothing else does, so the
    // action decides; an unattributed bare id stays opaque rather than being
    // read as a person and joined against the account directory.
    if (isPersonAction(action)) {
      return {
        kind: "person",
        collection: PERSON_COLLECTION,
        documentId: segments[0],
        raw,
      };
    }
    return Object.hasOwn(REQUEST_TARGET_LABELS, trimmedString(action) ?? "")
      ? { kind: "request", collection: null, documentId: segments[0], raw }
      : { kind: "opaque", collection: null, documentId: segments[0], raw };
  }
  if (segments.length === 2) {
    const [collection, documentId] = segments;
    if (PERSON_COLLECTION_ALIASES.has(collection)) {
      return { kind: "person", collection: PERSON_COLLECTION, documentId, raw };
    }
    if (Object.hasOwn(CONTENT_COLLECTION_LABELS, collection)) {
      return { kind: "content", collection, documentId, raw };
    }
    return { kind: "opaque", collection, documentId, raw };
  }
  return { kind: "system", collection: null, documentId: null, raw };
}

// The one address rule. A caller who may view accounts sees the address; anyone
// else sees enough to tell two people apart and not enough to write to either.
function maskEmail(email) {
  const value = trimmedString(email);
  const at = value ? value.lastIndexOf("@") : -1;
  if (!value || at <= 0 || at === value.length - 1) return null;
  return `${value.slice(0, 1)}•••${value.slice(at)}`;
}

function personFromRecord({ record, people }) {
  if (record === null || record === undefined) {
    return { label: DELETED_ACTOR_LABEL, status: "deleted" };
  }
  const displayName = trimmedString(record.displayName);
  const email = trimmedString(record.email);
  const label =
    displayName ??
    (people ? email : maskEmail(email)) ??
    PERSON_TYPE_LABEL;
  return { label, status: record.active === false ? "deactivated" : "active" };
}

function actorFromRecord({ uid, record, people, failed = false }) {
  const identity = uid
    ? { uid: people ? uid : null }
    : { uid: null };
  if (!uid) {
    return { label: UNKNOWN_ACTOR_LABEL, status: "unknown", email: null, ...identity };
  }
  if (uid.startsWith(SYSTEM_ACTOR_PREFIX)) {
    return {
      label: Object.hasOwn(SYSTEM_ACTOR_LABELS, uid)
        ? SYSTEM_ACTOR_LABELS[uid]
        : GENERIC_SYSTEM_ACTOR_LABEL,
      status: "system",
      email: null,
      ...identity,
    };
  }
  if (failed) {
    return { label: UNAVAILABLE_LABEL, status: "unknown", email: null, ...identity };
  }
  const person = personFromRecord({ record, people });
  return {
    ...person,
    email: people && record ? trimmedString(record.email) : null,
    ...identity,
  };
}

function contentTypeLabel(collection, record) {
  if (collection === "cmsPostTemplates") return CONTENT_COLLECTION_LABELS[collection];
  const kind = trimmedString(record?.type);
  if (kind && Object.hasOwn(CONTENT_KIND_LABELS, kind)) return CONTENT_KIND_LABELS[kind];
  if (kind) return titleCaseFirst(kind.replace(/[._-]+/g, " "));
  return CONTENT_COLLECTION_LABELS[collection] ?? "Content";
}

function contentTitle(record, typeLabel) {
  const label =
    trimmedString(record?.title) ??
    trimmedString(record?.name) ??
    // An author profile carries a person's name rather than a title.
    trimmedString(record?.displayName) ??
    trimmedString(record?.slug) ??
    `Untitled ${typeLabel.toLocaleLowerCase("en-US")}`;
  // A content document can approach Firestore's size limit. Keep one record
  // from making the 50-row activity response too large to serve.
  return truncateUtf8(label, MAX_ACTIVITY_LABEL_BYTES);
}

function targetFromRecord({ parsed, action, record, people, failed = false }) {
  if (parsed.kind === "none") {
    return { label: NO_TARGET_LABEL, type: "None", status: "none", id: null };
  }
  if (parsed.kind === "system") {
    return { label: "System record", type: "System", status: "found", id: parsed.raw };
  }
  if (parsed.kind === "request") {
    return {
      label: REQUEST_TARGET_LABELS[trimmedString(action) ?? ""] ?? parsed.raw,
      type: "Request",
      status: "found",
      id: parsed.raw,
    };
  }
  if (parsed.kind === "opaque") {
    // Nothing to look up, so the stored path is the most useful thing to show. A
    // generic label here would throw away the only fact the row actually has.
    return { label: parsed.raw, type: "Reference", status: "unknown", id: parsed.raw };
  }
  if (parsed.kind === "person") {
    // A person-shaped target IS an account id, so the immutable id is only
    // support detail for a caller who may already see accounts.
    const id = people ? parsed.raw : null;
    if (failed) {
      return { label: UNAVAILABLE_LABEL, type: PERSON_TYPE_LABEL, status: "unknown", id };
    }
    const person = personFromRecord({ record, people });
    return {
      label: person.label,
      type: PERSON_TYPE_LABEL,
      status: record ? person.status === "deactivated" ? "deactivated" : "found" : "deleted",
      id,
    };
  }
  const typeLabel = contentTypeLabel(parsed.collection, record);
  if (failed) {
    return { label: UNAVAILABLE_LABEL, type: typeLabel, status: "unknown", id: parsed.raw };
  }
  if (!record) {
    return { label: DELETED_CONTENT_LABEL, type: typeLabel, status: "deleted", id: parsed.raw };
  }
  return {
    label: contentTitle(record, typeLabel),
    type: typeLabel,
    status: "found",
    id: parsed.raw,
  };
}

/** What the signed-in caller is allowed to be told. Deny by default. */
function activityVisibility(principal) {
  return { people: hasCapability(principal, "users.view") === true };
}

async function readDocuments(firestore, keys) {
  const found = new Map();
  if (keys.length === 0) return found;
  // Prefer the path form so a resolution read is one call that cannot be
  // mistaken for the audit query itself.
  const refs = keys.map(({ collection, documentId }) =>
    typeof firestore.doc === "function"
      ? firestore.doc(`${collection}/${documentId}`)
      : firestore.collection(collection).doc(documentId),
  );
  const snapshots =
    typeof firestore.getAll === "function"
      ? await firestore.getAll(...refs)
      : await Promise.all(refs.map((ref) => ref.get()));
  keys.forEach((key, index) => {
    const snapshot = snapshots[index];
    found.set(
      `${key.collection}/${key.documentId}`,
      snapshot && snapshot.exists ? (snapshot.data() ?? null) : null,
    );
  });
  return found;
}

/**
 * Return the same entries with a `resolved` block added: current actor identity,
 * the target's title and type, and plain language for the action and source. The
 * stored fields are handed back untouched, and nothing is written.
 *
 * A directory read that fails does not fail the page -- the compliance stream
 * still has to be readable -- but it also does not fall back to printing raw
 * identifiers. It resolves to an explicit unavailable label and is logged.
 */
async function resolveActivityEntries({ firestore, entries, visibility, log = console }) {
  const rows = Array.isArray(entries) ? entries : [];
  const people = visibility?.people === true;
  const parsedTargets = rows.map((entry) =>
    parseActivityTarget({ action: entry?.action, target: entry?.target }),
  );

  const keys = new Map();
  const remember = (collection, documentId) => {
    if (!collection || !documentId) return;
    keys.set(`${collection}/${documentId}`, { collection, documentId });
  };
  rows.forEach((entry, index) => {
    const uid = trimmedString(entry?.actorUid);
    if (uid && !uid.startsWith(SYSTEM_ACTOR_PREFIX)) remember(PERSON_COLLECTION, uid);
    const parsed = parsedTargets[index];
    if (parsed.kind === "content" || parsed.kind === "person") {
      remember(parsed.collection, parsed.documentId);
    }
  });

  let records = new Map();
  let failed = false;
  try {
    records = await readDocuments(firestore, [...keys.values()]);
  } catch (error) {
    failed = true;
    log.error?.("cmsListAudit could not resolve activity names", error);
  }

  return rows.map((entry, index) => {
    const parsed = parsedTargets[index];
    const uid = trimmedString(entry?.actorUid);
    const actorRecord = uid ? (records.get(`${PERSON_COLLECTION}/${uid}`) ?? null) : null;
    const targetRecord =
      parsed.collection && parsed.documentId
        ? (records.get(`${parsed.collection}/${parsed.documentId}`) ?? null)
        : null;
    return {
      ...entry,
      // The stored account fields are themselves directory data.
      actorUid: people ? (entry?.actorUid ?? null) : null,
      actorEmail: people ? (entry?.actorEmail ?? null) : null,
      resolved: {
        action: describeActivityAction(entry?.action),
        actor: actorFromRecord({ uid, record: actorRecord, people, failed }),
        target: targetFromRecord({
          parsed,
          action: entry?.action,
          record: targetRecord,
          people,
          failed,
        }),
        source: describeActivitySource(entry?.source),
      },
    };
  });
}

module.exports = {
  ACTIVITY_ACTION_LABELS,
  ACTIVITY_SOURCE_LABELS,
  CONTENT_COLLECTION_LABELS,
  DELETED_ACTOR_LABEL,
  DELETED_CONTENT_LABEL,
  NO_TARGET_LABEL,
  UNAVAILABLE_LABEL,
  UNKNOWN_ACTOR_LABEL,
  activityVisibility,
  describeActivityAction,
  describeActivitySource,
  maskEmail,
  parseActivityTarget,
  resolveActivityEntries,
};
