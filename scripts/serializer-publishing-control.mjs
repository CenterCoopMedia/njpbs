import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
const require = createRequire(import.meta.url);
const { SERIALIZER_CONTROL_PATH, parseSerializerPublicationControl } = require("../functions/lib/serializer-publication-control.js");

export async function serializerPublishingControl({ firestore, apply = false }) {
  const ref = firestore.doc(SERIALIZER_CONTROL_PATH);
  if (!apply) {
    const row = await ref.get();
    const before = row.exists ? parseSerializerPublicationControl(row.data()) : null;
    return { applied: false, before, after: before };
  }
  const before = await firestore.runTransaction(async transaction => {
    const row = await transaction.get(ref);
    const previous = row.exists ? parseSerializerPublicationControl(row.data()) : null;
    transaction.set(ref, { schemaVersion: 1, enabled: false });
    return previous;
  });
  const after = parseSerializerPublicationControl((await ref.get()).data());
  if (after.enabled) throw new Error("Serializer publication control changed after the write.");
  return { applied: true, before, after };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("Usage: serializer-publishing-control --project <njpbs-site|njpbs-site-dev> [--apply]. Stream the target service account on stdin.");
    return;
  }
  if (args[0] !== "--project" || !["njpbs-site", "njpbs-site-dev"].includes(args[1]) ||
      !(args.length === 2 || args.length === 3 && args[2] === "--apply")) throw new Error("Invalid arguments.");
  if (process.stdin.isTTY) throw new Error("Stream the target service account on stdin.");
  let size = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 128 * 1024) throw new Error("Credential input exceeds its bound.");
    chunks.push(chunk);
  }
  const account = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (account.type !== "service_account" || account.project_id !== args[1]) throw new Error("The credential does not match the target.");
  const { initializeApp, cert, deleteApp } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");
  const app = initializeApp({ credential: cert(account), projectId: args[1] }, "serializer-publishing-control");
  try {
    console.log(JSON.stringify({ project: args[1], ...await serializerPublishingControl({
      firestore: getFirestore(app), apply: args[2] === "--apply",
    }) }));
  } finally { await deleteApp(app); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("Serializer publication control could not be read or changed."); process.exitCode = 1; });
}
