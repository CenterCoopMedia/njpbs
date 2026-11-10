import { assertDevelopmentSource } from "./render-development-config.mjs";
import { readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const fail = () => { throw new Error("Private preview operator refused"); };
async function main() {
  const [mode, filename, ...extra] = process.argv.slice(2);
  if (!["plan", "apply", "qualify", "receipt"].includes(mode) || !filename || extra.length) fail();
  const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
  // Credential descriptors may already be attached. Load no repository module
  // until its exact clean source is established using only Node builtins.
  const bytes = readFileSync(filename); if (!bytes.length || bytes.length > 64 * 1024) fail();
  const sourceSha = JSON.parse(bytes.toString("utf8"))?.sourceSha;
  const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (typeof sourceSha !== "string" || !/^[a-f0-9]{40}$/.test(sourceSha) || git(["rev-parse", "HEAD"]) !== sourceSha ||
      !assertDevelopmentSource(root)) fail();
  const { loadPrivatePreviewPacket, privatePreviewPacketReadback } = await import("./lib/private-preview-packet.mjs");
  const loaded = await loadPrivatePreviewPacket(filename, root, mode);
  const { packet, prepared } = loaded;
  const { installPrivatePreviewPair, qualifyPrivatePreviewPair } = await import("./lib/install-private-preview-pair.mjs");
  if (mode === "plan") {
    const result = await installPrivatePreviewPair({ prepared, request: packet.request, readToken: fail, readSecret: fail, dryRun: true });
    process.stdout.write(JSON.stringify(result) + "\n"); return;
  }
  if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST || process.env.FUNCTIONS_EMULATOR) fail();
  const lazyFd = fd => {
    let value;
    return () => { if (value === undefined) {
      const bytes = readFileSync(fd); if (!bytes.length || bytes.length > 64 * 1024) fail();
      value = bytes.toString("utf8").trim(); if (!value) fail();
    } return value; };
  };
  // These streams are read only on first actual use; never argv, files, logs or
  // environment-variable credentials. FD3 is also the uploaded Firebase secret.
  const readToken = lazyFd(0), account = lazyFd(3), r2 = lazyFd(4), edge = lazyFd(5);
  const devId = lazyFd(6), devSecret = lazyFd(7);
  const project = packet.config.vars.FIREBASE_PROJECT_ID;
  const { parsePreviewPairInstallAccount, assertPreviewPairUploadSecrets } = await import("../site/scripts/cms-preview-pair-install-credentials.ts");
  const require = createRequire(new URL("../functions/package.json", import.meta.url));
  const { initializeApp, cert, deleteApp } = require("firebase-admin/app"), { getFirestore } = require("firebase-admin/firestore");
  const parsed = parsePreviewPairInstallAccount(account(), project);
  if (mode === "apply") assertPreviewPairUploadSecrets({ rawStorage: r2(), edgeSecret: edge(),
    ...(project === "njpbs-site-dev" ? { developmentAccess: { clientId: devId(), clientSecret: devSecret() } } : {}) });
  const app = initializeApp({ projectId: project, credential: cert(parsed) }, "private-preview-pair-operator");
  try {
    const firestore = getFirestore(app);
    if (mode === "receipt") {
      const [resource, health] = await firestore.getAll(firestore.doc(`cmsPreviewPrivateInstalls/${packet.resourceOperationId}`), firestore.doc(`cmsPreviewPrivateHealth/${packet.request.operationId}`));
      process.stdout.write(JSON.stringify(privatePreviewPacketReadback(loaded, resource.exists ? resource.data() : null,
        health.exists ? health.data() : null)) + "\n"); return;
    }
    const input = { firestore, prepared, request: packet.request, readToken,
      readSecret: name => ({ FIREBASE_SERVICE_ACCOUNT: account, R2_PREVIEW_CREDENTIAL: r2, CMS_EDGE_ORIGIN_SECRET: edge,
        CMS_DEV_ACCESS_CLIENT_ID: devId, CMS_DEV_ACCESS_CLIENT_SECRET: devSecret })[name]?.() ?? fail() };
    const result = mode === "qualify" ? await qualifyPrivatePreviewPair({ ...input, resourceOperationId: packet.resourceOperationId })
      : await installPrivatePreviewPair({ ...input, dryRun: false });
    process.stdout.write(JSON.stringify(result) + "\n");
  } finally { await deleteApp(app); }
}
main().catch(() => { process.stderr.write("Private preview pair operation was not confirmed; preserve and reconcile the original attempt\n"); process.exitCode = 1; });
