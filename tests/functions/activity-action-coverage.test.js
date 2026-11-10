// Every action code an audit writer can emit has newsroom language (#1038).
//
// The readable label map lives next to the reader, not the writers, so it can
// drift the moment someone adds an endpoint. This test closes that gap by
// collecting the codes from the writers themselves: literal codes are read out
// of the admin_logs entry objects in `functions/` and approved operator scripts,
// and the codes that are built from a vocabulary at run time are derived from
// the exported vocabulary the writer actually uses. A new writer, a new
// lifecycle action, or a new author profile event fails here rather than
// reaching an administrator as "Unrecognized action".

import { expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import activityDirectory from "../../functions/lib/activity-directory.js";
import lifecycleTransition from "../../functions/lifecycle-transition.js";
import setMediaLifecycle from "../../functions/set-media-lifecycle.js";
import authorProfileStore from "../../functions/lib/author-profile-store.js";
import costLedgerStore from "../../functions/lib/cost-ledger-store.js";
import postTemplates from "../../functions/post-templates.js";
import mediaCategories from "../../functions/media-categories.js";
import mediaFeedbackContract from "../../functions/lib/media-feedback.js";
import reportNudge from "../../functions/lib/bug-report-nudge.js";
import datasets from "../../functions/datasets.js";
import electionConnections from "../../functions/lib/election-source-connections.js";

const { describeActivityAction, parseActivityTarget, resolveActivityEntries } = activityDirectory;
const { LIFECYCLE_TRANSITIONS } = lifecycleTransition;
const { LIFECYCLE_ACTIONS } = setMediaLifecycle;
const { AUDIT_ACTIONS } = authorProfileStore;
const { MUTATION_ACTIONS: MEDIA_CATEGORY_MUTATION_ACTIONS } = mediaCategories;
const { MUTATION_ACTIONS: DATASET_MUTATION_ACTIONS } = datasets;

const functionsDir = fileURLToPath(
  new URL("../../functions/", import.meta.url),
);
const scriptsDir = fileURLToPath(
  new URL("../../scripts/", import.meta.url),
);
const OPERATOR_AUDIT_WRITERS = Object.freeze([
  "convert-retired-article-to-post.mjs",
  "backfill-media-bin.mjs",
  "backfill-video-previews.mjs",
]);

// The read side of the same stream. It names actors and targets too, so it looks
// like a writer to a text scan, and its own fallbacks are not emitted codes.
const READERS = new Set([
  "activity-directory.js",
  "list-audit.js",
  "revisions.js",
]);

function sourceFiles() {
  const files = [];
  for (const dir of [functionsDir, `${functionsDir}lib/`]) {
    for (const name of readdirSync(dir)) {
      if (READERS.has(name)) continue;
      if (name.endsWith(".js") && !name.endsWith(".test.js")) {
        files.push({ path: `${dir}${name}`, name });
      }
    }
  }
  for (const name of OPERATOR_AUDIT_WRITERS) {
    files.push({ path: `${scriptsDir}${name}`, name });
  }
  return files;
}

// The object literal that encloses one `action:` key, found by walking out to a
// balanced brace pair. Crude on purpose: it needs no parser and it fails loudly
// (the anchor assertions below) if the writers stop looking like this.
function enclosingObject(source, actionIndex) {
  let depth = 0;
  let start = -1;
  for (let index = actionIndex; index >= 0; index -= 1) {
    const character = source[index];
    if (character === "}") depth += 1;
    else if (character === "{") {
      if (depth === 0) {
        start = index;
        break;
      }
      depth -= 1;
    }
  }
  if (start === -1) return null;
  depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

// An admin_logs row, not a version-history row: both name an actor, only the
// history entry names the collection and document it belongs to.
function isAdminLogEntry(objectText) {
  return (
    objectText.includes("actorUid") &&
    objectText.includes("target:") &&
    !objectText.includes("collection:") &&
    !objectText.includes("documentId:")
  );
}

function actionExpression(objectText) {
  const start = objectText.indexOf("action:");
  // A shorthand `action,` names a value the writer composed above the call.
  if (start === -1) {
    return /(^|[\s{,])action\s*[,}]/.test(objectText)
      ? "action"
      : "";
  }
  let depth = 0;
  for (let index = start; index < objectText.length; index += 1) {
    const character = objectText[index];
    if ("{[(".includes(character)) depth += 1;
    else if ("}])".includes(character)) {
      if (depth === 0) {
        return objectText.slice(
          start + "action:".length,
          index,
        );
      }
      depth -= 1;
    } else if (character === "," && depth === 0) {
      return objectText.slice(
        start + "action:".length,
        index,
      );
    }
  }
  return objectText.slice(start + "action:".length);
}

// Codes a writer composes at run time, each derived from the vocabulary module
// the writer itself imports, so adding one to the vocabulary fails this test
// until it has a label.
const COMPOSED_CODES = {
  "election-source-connections.js": electionConnections.MUTATION_ACTIONS.map(action => `election_source.${action}`),
  "bug-report-nudge.js": reportNudge.NUDGE_DECISIONS.map((decision) => `bug_report.nudge_${decision}`),
  "post-templates.js": postTemplates.MUTATION_ACTIONS.map(action => `post_template_${action}`),
  "media-categories.js": [...MEDIA_CATEGORY_MUTATION_ACTIONS].map(
    (action) => `media.category.${action}`,
  ),
  "bug-report-triage.js": [
    "bug_report.acknowledge",
    "bug_report.assign",
    "bug_report.github_attach_issue",
    "bug_report.github_attach_pull_request",
    "bug_report.github_create_issue",
    "bug_report.github_create_issue_and_fix",
    "bug_report.github_sync",
    "bug_report.notification_retry",
    "bug_report.relate",
    "bug_report.resolution",
    "bug_report.status",
    "bug_report.take_over",
  ],
  "bug-report-github.js": [
    "bug_report.github_attach_issue_complete",
    "bug_report.github_attach_pull_request_complete",
    "bug_report.github_create_issue_complete",
    "bug_report.github_create_issue_and_fix_complete",
    "bug_report.github_sync_complete",
  ],
  "lifecycle-transition.js": Object.keys(
    LIFECYCLE_TRANSITIONS,
  ).map((action) => `cms.${action}`),
  "set-media-lifecycle.js": [...LIFECYCLE_ACTIONS].map(
    (action) => `media.lifecycle.${action}`,
  ).concat("media.library.restore"),
  "staff-access.js": ["approve", "deny"].map(
    (decision) => `staff_access.${decision}`,
  ),
  "author-profile-store.js": Object.values(AUDIT_ACTIONS),
  "cost-ledger-store.js": Object.values(costLedgerStore.AUDIT_ACTIONS),
  "datasets.js": DATASET_MUTATION_ACTIONS.map(action => `dataset.${action}`),
  "source-video-replacement.js": ["media.video.replace", "media.video.rollback"],
  "public-deployment-outcome-store.js": [
    "public-deployment.activate",
    "public-deployment.fail",
    "public-deployment.reconcile",
  ],
  "cms-publication-baseline-retirement.js": [
    "cms-publication-baseline.retire",
  ],
  "cms-publication-baseline-claimed-cancellation.js": [
    "cms-publication-baseline.cancel-claimed",
  ],
  "cms-publication-baseline-unclaimed-cancellation.js": [
    "cms-publication-baseline.cancel-unclaimed",
  ],
  "cms-publication-content-claimed-cancellation.js": [
    "cms-publication-content.cancel-claimed",
  ],
  "cms-content-unpublished-withdrawal-settlement.js": [
    "cms-content.settle-unpublished-withdrawal",
  ],
};

function collectWrittenActions(files = sourceFiles()) {
  const literal = new Set();
  const composedFiles = new Set();
  for (const file of files) {
    const source = readFileSync(file.path, "utf8");
    // Anchor on the actor field: every admin_logs row names one, whether the
    // action beside it is a literal, a template, or a shorthand value.
    let index = source.indexOf("actorUid");
    while (index !== -1) {
      const objectText = enclosingObject(source, index);
      if (objectText && isAdminLogEntry(objectText)) {
        const expression = actionExpression(objectText).trim();
        // A value, or each branch of a conditional choice, must be a whole
        // quoted string. Concatenation and templates still need a vocabulary.
        const literalChoice = /^(?:[^?:'"`]+\?\s*(?:'[^']+'|"[^"]+")\s*:\s*)+(?:'[^']+'|"[^"]+")$/;
        const literals = /^(?:'[^']+'|"[^"]+")$/.test(expression) || literalChoice.test(expression)
          ? (expression.match(/'[^']+'|"[^"]+"/g) ?? [])
          : [];
        for (const value of literals) {
          literal.add(value.slice(1, -1));
        }
        if (expression && literals.length === 0) {
          composedFiles.add(file.name);
        }
      }
      index = source.indexOf("actorUid", index + 1);
    }
  }
  return { literal, composedFiles };
}

it.each([
  ['"cms.save"', ["cms.save"]],
  ["'cms.save'", ["cms.save"]],
  ['"cms.save" + suffix', []],
  ["'cms.save' + suffix", []],
  ['prefix + "cms.save"', []],
  ['"cms." + "save"', []],
  ['decision ? "cms.save" : "cms.publish"', ["cms.save", "cms.publish"]],
  ['decision ? "cms.save" : other ? "cms.publish" : "cms.unlabeled"', ["cms.save", "cms.publish", "cms.unlabeled"]],
  ['decision ? "cms.save" + suffix : "cms.publish"', []],
  ['decision ? "cms.save" : "cms.publish" + suffix', []],
  ['`cms.${action}`', []],
  ['`cms.save`', []],
])("classifies the whole audit action expression: %s", (expression, codes) => {
  const directory = mkdtempSync(join(tmpdir(), "audit-action-coverage-"));
  const name = "new-audit-writer.js";
  const file = join(directory, name);
  try {
    writeFileSync(file, `log({ actorUid, action: ${expression}, target: "cmsPosts/example" });`);
    const { literal, composedFiles } = collectWrittenActions([{ path: file, name }]);
    expect([...literal]).toEqual(codes);
    expect([...composedFiles]).toEqual(codes.length ? [] : [name]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("labels every recorded literal and composed action code", () => {
  const { literal, composedFiles } = collectWrittenActions();
  // Anchors prevent an empty scan from passing.
  expect(literal.size).toBeGreaterThan(15);
  for (const code of ["cms.save", "cms.publish", "content.article_converted_to_post", "media.upload", "roles.grant", "staff.deactivate"]) {
    expect([...literal]).toContain(code);
  }
  expect([...literal].filter(code => describeActivityAction(code).known !== true)).toEqual([]);
  expect(Object.values(COMPOSED_CODES).flat().filter(code => describeActivityAction(code).known !== true)).toEqual([]);
  // Media comment records have a different target collection.
  const writer = readFileSync(`${functionsDir}media-feedback.js`, "utf8");
  expect(writer).toContain("action: `media_comment_${action}`");
  const codes = mediaFeedbackContract.COMMENT_ACTIONS.map(action => `media_comment_${action}`);
  expect(codes).toEqual(expect.arrayContaining(["media_comment_resolve", "media_comment_reopen"]));
  expect(codes.filter(code => describeActivityAction(code).known !== true)).toEqual([]);
  expect([...composedFiles].sort()).toEqual(Object.keys(COMPOSED_CODES).sort());
});

it("names a publication recheck and keeps its queue target as a publish request", () => {
  expect(describeActivityAction("cms.publicationRechecked")).toMatchObject({ known: true, label: "Public confirmation checked" });
  const target = "A".repeat(20);
  expect(parseActivityTarget({ action: "cms.publicationRechecked", target }))
    .toEqual({ kind: "request", collection: null, documentId: target, raw: target });
});

  it("registers every dataset mutation and renders its Activity target", async () => {
    expect(DATASET_MUTATION_ACTIONS).toEqual(["assign", "save", "review", "approve", "archive"]);
    expect(DATASET_MUTATION_ACTIONS.map(action => describeActivityAction(`dataset.${action}`).known))
      .toEqual([true, true, true, true, true]);
    expect(parseActivityTarget({ action: "dataset.save", target: "cmsDatasets/example-rate" }))
      .toEqual({ kind: "content", collection: "cmsDatasets", documentId: "example-rate",
        raw: "cmsDatasets/example-rate" });
    const firestore = { doc: path => ({ path }), getAll: async (...refs) => refs.map(ref => ({
      exists: true,
      data: () => ref.path === "users/editor-1"
        ? { displayName: "Dataset editor", active: true }
        : { title: "Employment rate" },
    })) };
    const [entry] = await resolveActivityEntries({ firestore, visibility: { people: true },
      entries: [{ actorUid: "editor-1", action: "dataset.save", target: "cmsDatasets/example-rate" }] });
    expect(entry.resolved).toMatchObject({ action: { label: "Dataset saved", known: true },
      target: { label: "Employment rate", type: "Dataset", status: "found",
        id: "cmsDatasets/example-rate" } });
  });
