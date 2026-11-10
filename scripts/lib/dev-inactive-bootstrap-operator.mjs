import { parseRetainedPrivateAccess } from "./dev-retained-private-access.mjs";
import { deploymentEmail } from "./deployment-settings.mjs";
import p from "../../functions/lib/public-release-pair.js";
import owner from "./dev-inactive-bootstrap.cjs";
import { developmentInstallCredential } from "./development-install-credentials.mjs";
import { assertDevelopmentRehearsalEnvironment } from "./development-rehearsal-credentials.mjs";
import { operatorRefused as refuse, parseOperatorArgs, readOperatorPacket, assertOperatorSource,
  parseOperatorCredentialIdentity, operatorAccount, openOperatorDatabase } from "./public-release-operator-io.mjs";

export function parseDevInactiveBootstrapPacket(value, inspect = false) {
  p.exact(value, ["schemaVersion", "kind", "environment", "projectId", "operationId", "operatorCommitSha", "credentialIdentity", "request",
    ...(Object.hasOwn(value ?? {}, "retainedAccess") ? ["retainedAccess"] : [])]);
  if (value.schemaVersion !== 1 || value.kind !== "dev-inactive-bootstrap-operator" || value.environment !== "development" ||
      value.projectId !== "njpbs-site-dev" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.operationId ?? "") ||
      !/^[a-f0-9]{40}$/.test(value.operatorCommitSha ?? "")) refuse();
  parseOperatorCredentialIdentity(value.credentialIdentity, "development");
  if (value.credentialIdentity.clientEmail !== deploymentEmail("CMS_DEV_SDK_CLIENT_EMAIL")) refuse();
  if (inspect) { if (value.request !== null) refuse(); }
  else {
    owner.parseRequest(value.request);
    if (value.request.operationId !== value.operationId || value.request.retainedAccessDigest !==
        (value.retainedAccess == null ? undefined : p.publicReleaseDigest(value.retainedAccess))) refuse();
  }
  return value;
}
export async function runDevInactiveBootstrapOperator(args, stage = () => {}) {
  stage("packet-parse");
  const options = parseOperatorArgs(args, ["--inspect", "--dry-run", "--apply", "--readback"]);
  const packet = parseDevInactiveBootstrapPacket(await readOperatorPacket(options), options.mode === "inspect");
  stage("source-check");
  assertOperatorSource(packet.operatorCommitSha);
  stage("environment-check");
  assertDevelopmentRehearsalEnvironment();
  if (packet.retainedAccess != null) { stage("retained-access-parse"); parseRetainedPrivateAccess(packet.retainedAccess); }
  const base = { schemaVersion: 1, kind: "dev-inactive-bootstrap-result", mode: options.mode, packetDigest: options.packetDigest,
    providerWrites: 0, slots: owner.SLOTS };
  if (options.mode === "plan") return { ...base, request: packet.request,
    requestDigest: p.publicReleaseDigest(packet.request), authorityReads: 0, authorityWrites: 0 };
  stage("credential-open");
  const credential = developmentInstallCredential(3, raw => operatorAccount(raw, packet.credentialIdentity));
  let connection, failed = false;
  try {
    stage("credential-read");
    const account = await credential.read();
    stage("database-open");
    connection = await openOperatorDatabase(account);
    const firestore = connection.firestore;
    stage(options.mode);
    if (options.mode === "inspect") {
      const request = await owner.inspectDevInactiveBootstrap({ firestore, operationId: packet.operationId, retainedAccess: packet.retainedAccess ?? null, stage });
      return { ...base, request, requestDigest: p.publicReleaseDigest(request), authorityWrites: 0 };
    }
    const result = options.mode === "readback" ? await owner.readDevInactiveBootstrap({ firestore, request: packet.request, retainedAccess: packet.retainedAccess ?? null })
      : await owner.retireDevInactiveBootstrap({ firestore, request: packet.request, retainedAccess: packet.retainedAccess ?? null, dryRun: options.mode === "dry-run" });
    return { ...base, ...result, ...(options.mode === "dry-run" || options.mode === "readback" ? { authorityWrites: 0 } : {}) };
  } catch (error) { failed = true; throw error; }
  finally {
    // Attempt both cleanups, preserving the original error object and stage.
    let cleanupError, cleanupFailed = false;
    if (!failed) stage("credential-close");
    try { credential.close(); }
    catch (error) { if (!failed) { failed = true; cleanupFailed = true; cleanupError = error; } }
    if (!failed) stage("database-close");
    try { await connection?.close(); }
    catch (error) { if (!failed) { failed = true; cleanupFailed = true; cleanupError = error; } }
    if (cleanupFailed) throw cleanupError;
  }
}
