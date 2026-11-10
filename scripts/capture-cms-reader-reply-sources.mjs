#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cert, initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import source from "../functions/lib/cms-reader-retained-replies.js";
import p from "../functions/lib/public-release-pair.js";

// Explicit original-source capture only. This is not an install or a writer
// for compatibility receipts. No HTTP/provider/queue/selector effect exists.
async function main() {
  let app;
  try {
    const [projectId, planPath] = process.argv.slice(2);
    if (process.argv.length !== 4 || !["njpbs-site", "njpbs-site-dev"].includes(projectId) || process.env.FIRESTORE_EMULATOR_HOST) throw new Error();
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    p.exact(plan, ["oldPair", "newPair", "previewPairs", "requests"]);
    const credential = JSON.parse(readFileSync(0, "utf8"));
    if (credential.type !== "service_account" || credential.project_id !== projectId) throw new Error();
    app = initializeApp({ projectId, credential: cert(credential) }, "cms-reader-source-capture");
    process.stdout.write(`${JSON.stringify(await source.captureRetainedReaderReplySources({ firestore: getFirestore(app), ...plan }))}\n`);
  } catch { process.stderr.write("CMS reader source capture refused.\n"); process.exitCode = 1; }
  finally { if (app) await deleteApp(app); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
