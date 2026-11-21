#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import protocol from "../functions/lib/public-release-pair.js";
import history from "./lib/superseded-publication-history.cjs";
import { operatorRefused, parseOperatorArgs, readOperatorPacket, assertOperatorSource,
  parseOperatorCredentialIdentity, operatorCredentialStream, operatorAccount,
  openOperatorDatabase } from "./lib/public-release-operator-io.mjs";

export async function runSupersededHistoryOperator(args, {
  readServiceAccount = operatorCredentialStream(3), openDatabase = openOperatorDatabase,
} = {}) {
  const options = parseOperatorArgs(args, ["--apply"]);
  const packet = await readOperatorPacket(options);
  protocol.exact(packet, ["schemaVersion", "credentialIdentity", "request", "approved"]);
  if (packet.schemaVersion !== 1) operatorRefused();
  history.parseRequest(packet.request);
  const apply = options.mode === "apply";
  if (apply) history.parseListing(packet.request, packet.approved);
  else if (packet.approved !== null) operatorRefused();
  assertOperatorSource(packet.request.operatorCommitSha);
  parseOperatorCredentialIdentity(packet.credentialIdentity, packet.request.target.environment);
  const account = operatorAccount(await readServiceAccount(), packet.credentialIdentity);
  const { firestore, close } = await openDatabase(account);
  try {
    const input = { firestore, request: packet.request, approved: packet.approved };
    return apply ? await history.retireSupersededPublicationHistory(input) : await history.listSupersededPublicationHistory(input);
  } finally { await close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runSupersededHistoryOperator(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write("Superseded history command refused. Preserve the original packet and listing.\n");
    process.exitCode = 1;
  }
}
