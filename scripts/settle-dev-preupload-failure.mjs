#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { parseOperatorArgs, readOperatorPacket, assertOperatorSource, operatorRefused } from "./lib/public-release-operator-io.mjs";
import { parseDevelopmentInstallSdkPacket, openDevelopmentInstallSdk } from "./lib/development-install-sdk.mjs";
import { developmentInstallCredential, developmentInstallToken } from "./lib/development-install-credentials.mjs";
import { verifyDevPreuploadFailure, devSettlementGithub } from "./lib/dev-preupload-provenance.mjs";
import contract from "../functions/lib/dev-publication-preupload.js";
import protocol from "../functions/lib/public-release-pair.js";

export function parseDevPreuploadPacket(packet) {
  protocol.exact(packet, ["schemaVersion", "kind", "operatorCommitSha", "credentialIdentity", "request"]);
  if (packet.schemaVersion !== 1 || packet.kind !== "dev-preupload-settlement") operatorRefused();
  contract.parseDevPreuploadSettlement(packet.request);
  const sdk = parseDevelopmentInstallSdkPacket({ schemaVersion: 1, kind: "development-install-sdk",
    operatorCommitSha: packet.operatorCommitSha, credentialIdentity: packet.credentialIdentity });
  return { packet, sdk };
}

export async function runDevPreuploadSettlement(args, { openSdk = openDevelopmentInstallSdk, github, readSourceBlob } = {}) {
  const options = parseOperatorArgs(args);
  const { packet, sdk } = parseDevPreuploadPacket(await readOperatorPacket(options));
  assertOperatorSource(packet.operatorCommitSha);
  if (options.mode === "plan") return { mode: "plan", packetDigest: options.packetDigest,
    requestDigest: protocol.publicReleaseDigest(packet.request), authorityReads: 0, authorityWrites: 0 };
  // Read the existing GitHub identity on fd4 only at use; fd3 is the #4537 SDK pipe.
  if (options.mode === "apply") {
    let pipe;
    try {
      if (!github) pipe = developmentInstallCredential(4, developmentInstallToken);
      await verifyDevPreuploadFailure(packet.request, github ?? devSettlementGithub(await pipe.read()), readSourceBlob);
    } finally { pipe?.close(); }
  }
  const connection = await openSdk(sdk, 3);
  try {
    const { default: dev } = await import("./lib/dev-publication.cjs");
    const receipt = await dev.settleDevPreuploadFailure(connection.firestore, packet.request, { readOnly: options.mode === "readback" });
    return { mode: options.mode, packetDigest: options.packetDigest, receipt };
  } finally { await connection.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDevPreuploadSettlement(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + "\n"))
    .catch(() => { process.stderr.write('{"status":"refused","code":"dev-preupload-settlement-refused"}\n'); process.exitCode = 1; });
}
