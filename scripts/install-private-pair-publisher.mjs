#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { PrivatePairProviderError } from "./lib/private-pair-publisher-provider.mjs";
import { runPrivatePublisherOperator } from "./lib/private-pair-publisher-operator.mjs";

const safeCodes = new Set(["operator-packet-refused", "source-check-failed", "invalid-executor-ready-mode", "executor-ready-mode-unavailable",
  "credential-unavailable", "secret-unavailable", "operation-readback-pending", "preflight-request-uncertain", "preflight-attempt-uncertain",
  "preflight-receipt-expired", "private-preflight-not-ready", "preflight-target-unavailable", "preflight-target-changed", "provider-response-conflict",
  "version-bytes", "prepared-plan-mismatch", "install-cancelled", "install-not-authorized", "provider-name-collision"]);

export function privatePublisherOperatorFailure(error) {
  return error instanceof PrivatePairProviderError && safeCodes.has(error.code)
    ? `Private publisher refused: ${error.code}; uncertain=${error.uncertain === true}. Preserve the packet and inspect its original attempt if present\n`
    : "Private publisher operation was not confirmed; preserve the packet and reconcile its original attempt\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPrivatePublisherOperator(process.argv.slice(2)).then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch(error => {
    process.stderr.write(privatePublisherOperatorFailure(error));
    process.exitCode = 1;
  });
}
