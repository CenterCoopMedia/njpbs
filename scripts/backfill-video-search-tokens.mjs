#!/usr/bin/env node

// Writes the derived `searchTokens` word list on existing shared-video asset records, so word
// search in cmsSearchMedia finds videos uploaded before the field existed. It changes no
// name, description, tags, version or update time, and it is safe to run again.
//
// Emulator rehearsal:
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/backfill-video-search-tokens.mjs [--apply]
// A Firebase project (credential JSON on stdin; dry run unless --apply). CMS_TARGET selects
// the project through scripts/lib/cms-target.mjs, and --project must name that project:
//   node scripts/backfill-video-search-tokens.mjs --project njpbs-site [--apply] < service-account.json
//   CMS_TARGET=development node scripts/backfill-video-search-tokens.mjs --project njpbs-site-dev [--apply] < dev-service-account.json
// Output is one JSON line of counts only: dryRun, pages, scanned, current, eligible, updated, skipped.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { cert, deleteApp, initializeApp } from "firebase-admin/app";
import { FieldPath, getFirestore } from "firebase-admin/firestore";
import searchTokens from "../functions/lib/source-media-search-tokens.js";
import { cmsTarget } from "./lib/cms-target.mjs";

const { sourceMediaSearchTokens } = searchTokens;
const COLLECTION = "mediaSourceAssets";
const PAGE_SIZE = 100;

/** The token list a record needs, or null when it is not a video record with a name. */
function expectedTokens(data) {
  if (!data || data.kind !== "video" || typeof data.name !== "string" || !data.name.trim()) return null;
  return sourceMediaSearchTokens(data);
}

export async function backfillVideoSearchTokens({ firestore, apply = false, pageSize = PAGE_SIZE } = {}) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) {
    throw new Error("Page size must be a whole number from 1 through 200");
  }
  const result = { dryRun: !apply, pages: 0, scanned: 0, current: 0, eligible: 0, updated: 0, skipped: 0 };
  let cursor = null;
  for (;;) {
    let query = firestore.collection(COLLECTION).where("kind", "==", "video")
      .orderBy(FieldPath.documentId()).limit(pageSize);
    if (cursor !== null) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.empty) break;
    result.pages += 1;
    const stale = [];
    for (const document of page.docs) {
      result.scanned += 1;
      const expected = expectedTokens(document.data());
      if (!expected) result.skipped += 1;
      else if (isDeepStrictEqual(document.data().searchTokens, expected)) result.current += 1;
      else {
        result.eligible += 1;
        stale.push(document.ref);
      }
    }
    if (apply && stale.length) {
      // One bounded transaction per page re-reads each record, so a concurrent metadata edit
      // keeps its own token list and a repeated run writes nothing new.
      result.updated += await firestore.runTransaction(async (transaction) => {
        const fresh = await transaction.getAll(...stale);
        let written = 0;
        for (const snapshot of fresh) {
          const expected = snapshot.exists ? expectedTokens(snapshot.data()) : null;
          if (!expected || isDeepStrictEqual(snapshot.data().searchTokens, expected)) continue;
          transaction.update(snapshot.ref, { searchTokens: expected });
          written += 1;
        }
        return written;
      });
    }
    cursor = page.docs.at(-1).id;
    if (page.docs.length < pageSize) break;
  }
  return result;
}

/**
 * Reads the flags. A Firebase project run needs --project with the project that the configured
 * target names. An emulator run takes no --project.
 */
export function parseBackfillArgs(args, { emulator, targetProject }) {
  let apply = false;
  let project = null;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--apply" && !apply) apply = true;
    else if (args[index] === "--project" && project === null && !emulator) project = args[++index] ?? "";
    else throw new Error("Use --project <configured project> and the optional --apply flag");
  }
  if (!emulator && project !== targetProject()) throw new Error("--project must name the configured CMS_TARGET project");
  return { apply, project };
}

function connect(project) {
  if (project === null) {
    if (!/^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST)) {
      throw new Error("FIRESTORE_EMULATOR_HOST must be a local emulator");
    }
    return initializeApp({ projectId: "demo-njpbs" }, "video-search-token-backfill");
  }
  const credential = JSON.parse(readFileSync(0, "utf8"));
  if (credential.project_id !== project) throw new Error("Wrong Firebase project");
  return initializeApp({ credential: cert(credential), projectId: project }, "video-search-token-backfill");
}

async function main() {
  const { apply, project } = parseBackfillArgs(process.argv.slice(2), {
    emulator: Boolean(process.env.FIRESTORE_EMULATOR_HOST), targetProject: () => cmsTarget().projectId,
  });
  const app = connect(project);
  try {
    console.log(JSON.stringify(await backfillVideoSearchTokens({ firestore: getFirestore(app), apply })));
  } finally {
    await deleteApp(app);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error("Video search token backfill failed; credential and provider details withheld");
    process.exitCode = 1;
  });
}
