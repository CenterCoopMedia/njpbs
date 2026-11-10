#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { cert, initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { BRIDGE_ATTEMPTS, BRIDGE_PROOFS, CmsReaderBridgeError, createCmsReaderReplayTransport,
  dryRunCmsReaderBridge, proveCmsReaderBridge, installCmsReaderBridge, parseCmsReaderBridgeRequest,
} from "./lib/cms-reader-bridge-install.mjs";

export function parseBridgeArguments(args) {
  const [command, projectId, inputPath, adapterPath, adapterDigest] = args;
  if (args.length !== 5 || !["dry-run", "prove", "install", "readback"].includes(command) ||
      !(["njpbs-site", "njpbs-site-dev"].includes(projectId) || /^demo-[a-z0-9-]{1,50}$/.test(projectId)) || !inputPath || !adapterPath ||
      !/^[a-f0-9]{64}$/.test(adapterDigest)) throw new Error("Bridge arguments refused");
  return { command, projectId, inputPath, adapterPath, adapterDigest };
}
export async function runBridgeOperator({ command, firestore, request, adapter, signal }) {
  request = parseCmsReaderBridgeRequest(request);
  const common = { ...adapter, firestore, request, signal };
  if (command === "dry-run") return dryRunCmsReaderBridge(common);
  if (command === "prove") return proveCmsReaderBridge({ ...common,
    transport: createCmsReaderReplayTransport({ ...adapter, projectId: firestore.projectId, signal }) });
  if (command === "install") {
    // Exact owned candidate/legacy/reader CAS. No copy or alternative writer.
    const { commitLiveReaderReceipt } = await import("./lib/cms-component-receipt.mjs");
    return installCmsReaderBridge({ ...common, commitReader: commitLiveReaderReceipt });
  }
  if (command === "readback") {
    const [attempt, installed] = await firestore.getAll(firestore.collection(BRIDGE_ATTEMPTS).doc(request.operationId),
      firestore.collection(BRIDGE_PROOFS).doc(request.operationId));
    const { default: { digest } } = await import("../functions/lib/cms-preview-pair.js");
    if (attempt.exists && attempt.data().requestDigest !== digest(request) ||
        installed.exists && installed.data().proof?.requestDigest !== digest(request)) throw new CmsReaderBridgeError("bridge-operation-conflict");
    return { attempt: attempt.data() ?? null, installed: installed.data() ?? null };
  }
  throw new Error("Bridge command refused");
}

async function main() {
  let app, adapter, closePipes;
  const controller = new AbortController(), cancel = () => controller.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
    const args = parseBridgeArguments(process.argv.slice(2));
    const emulator = process.env.FIRESTORE_EMULATOR_HOST, demo = args.projectId.startsWith("demo-");
    if (demo !== Boolean(emulator) || emulator && !/^(127\.0\.0\.1|localhost):\d{1,5}$/.test(emulator)) throw new Error("Bridge target refused");
    const request = parseCmsReaderBridgeRequest(JSON.parse(readFileSync(args.inputPath, "utf8")));
    const bytes = readFileSync(args.adapterPath);
    if (createHash("sha256").update(bytes).digest("hex") !== args.adapterDigest) throw new Error("Bridge adapter refused");
    // The reviewed single-file adapter is executed from the verified bytes.
    // It supplies actual authority/provider reads and just-in-time credentials.
    const module = await import(`data:text/javascript;base64,${bytes.toString("base64")}`);
    if (typeof module.openBridgeInstallAdapter !== "function") throw new Error("Bridge adapter unbound");
    closePipes = module.prepareCredentialPipes?.({ purpose: args.command === "prove" ? "reader-prove" : args.command === "install" ? "reader-install" : "none", signal: controller.signal });
    const options = { projectId: args.projectId };
    if (!demo) {
      const credential = JSON.parse(readFileSync(0, "utf8"));
      if (credential.type !== "service_account" || credential.project_id !== args.projectId ||
          typeof credential.private_key !== "string" || typeof credential.client_email !== "string") throw new Error("Bridge credential refused");
      options.credential = cert(credential);
    }
    app = initializeApp(options, "cms-reader-bridge-operator");
    const firestore = getFirestore(app);
    adapter = args.command === "readback" ? {} : await module.openBridgeInstallAdapter({ firestore, signal: controller.signal });
    const result = await runBridgeOperator({ command: args.command, firestore, request, adapter, signal: controller.signal });
    const resultDigest = createHash("sha256").update(JSON.stringify(result)).digest("hex");
    // Private request bodies, errors, credentials and responses are never printed.
    process.stdout.write(`${JSON.stringify({ schemaVersion: 2, operationId: request.operationId, command: args.command,
      stage: request.stage ?? "public-converted", resultDigest, ...(args.command === "dry-run" ? result : {}) })}\n`);
  } catch (error) {
    const code = error instanceof CmsReaderBridgeError && /^bridge-[a-z-]+$/.test(error.code) ? error.code : "bridge-operation-refused";
    process.stderr.write(`CMS reader bridge refused: ${code}.\n`); process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
    adapter?.close?.();
    closePipes?.();
    if (app) try { await deleteApp(app); } catch { process.exitCode = 1; }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
