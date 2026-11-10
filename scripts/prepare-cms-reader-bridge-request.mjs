#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cert, initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// Independent SDK/chunk derivation; never takes caller cases or expectations.
async function main() {
  let app, adapter, closePipes;
  const controller = new AbortController(), cancel = () => controller.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
    const [projectId, operationId, stage, adapterPath, adapterDigest, output] = process.argv.slice(2);
    if (process.argv.length !== 8 || !["njpbs-site", "njpbs-site-dev"].includes(projectId) || process.env.FIRESTORE_EMULATOR_HOST ||
        !["legacy-first-install", "public-converted"].includes(stage) || !/^[a-f0-9]{64}$/.test(adapterDigest ?? "")) throw new Error();
    const bytes = readFileSync(adapterPath);
    if (createHash("sha256").update(bytes).digest("hex") !== adapterDigest) throw new Error();
    const module = await import(`data:text/javascript;base64,${bytes.toString("base64")}`);
    closePipes = module.prepareCredentialPipes?.({ purpose: "none", signal: controller.signal });
    const credential = JSON.parse(readFileSync(0, "utf8"));
    if (credential.type !== "service_account" || credential.project_id !== projectId) throw new Error();
    app = initializeApp({ projectId, credential: cert(credential) }, "cms-reader-case-preparation");
    adapter = await module.openBridgeInstallAdapter({ firestore: getFirestore(app), signal: controller.signal });
    const request = await adapter.prepareRequest({ operationId, ...(stage === "legacy-first-install" ? { stage } : {}) });
    controller.signal.throwIfAborted();
    writeFileSync(output, `${JSON.stringify(request)}\n`, { flag: "wx", mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ operationId, stage, cases: request.cases.length, refusals: request.refusals?.length ?? 0,
      requestDigest: createHash("sha256").update(JSON.stringify(request)).digest("hex") })}\n`);
  } catch { process.stderr.write("CMS reader request preparation refused.\n"); process.exitCode = 1; }
  finally {
    process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
    adapter?.close?.(); closePipes?.(); if (app) await deleteApp(app);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
