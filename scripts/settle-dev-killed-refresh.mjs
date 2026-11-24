#!/usr/bin/env node
// Operator settle for a development refresh run that ended before its fail step (#595).
// Plan reads nothing. --readback reads the row. --apply proves the run from the
// live Actions API, then ends the row through the fail step's settle.
// The packet request is { runId, commitSha }: the batch's commitSha and the run
// whose id gives its queue id, sha256("dev-code-refresh:<runId>")[0:20]. To find it:
//   gh run list --repo "$CANONICAL_GITHUB_REPOSITORY" --workflow cms-dev-publish.yml --status completed --limit 100 \
//     --json databaseId --jq '.[].databaseId' | while read id; do
//     [ "$(printf 'dev-code-refresh:%s' "$id" | sha256sum | cut -c1-20)" = "<queueId>" ] && echo "$id"; done
// Fd 3 carries the development SDK credential and fd 4 a GitHub token, as for
// settle-dev-preupload-failure.mjs. Production and active runs refuse.
import { pathToFileURL } from "node:url";
import { parseOperatorArgs, readOperatorPacket, assertOperatorSource, operatorRefused } from "./lib/public-release-operator-io.mjs";
import { parseDevelopmentInstallSdkPacket, openDevelopmentInstallSdk } from "./lib/development-install-sdk.mjs";
import { developmentInstallCredential, developmentInstallToken } from "./lib/development-install-credentials.mjs";
import { devSettlementGithub } from "./lib/dev-preupload-provenance.mjs";
import { repositoryIdentity } from "./lib/repository-identity.mjs";
import protocol from "../functions/lib/public-release-pair.js";
import { createHash } from "node:crypto";

const WORKFLOW = ".github/workflows/cms-dev-publish.yml";
const UPLOAD = "Upload only to dev, verify receipts, and settle dev queue";

export function parseKilledRefreshPacket(packet) {
  protocol.exact(packet, ["schemaVersion", "kind", "operatorCommitSha", "credentialIdentity", "request"]);
  protocol.exact(packet.request, ["runId", "commitSha"]);
  const { runId, commitSha } = packet.request;
  if (packet.schemaVersion !== 1 || packet.kind !== "dev-killed-refresh-settlement" ||
      !/^[1-9][0-9]{0,19}$/.test(runId ?? "") || !/^[a-f0-9]{40}$/.test(commitSha ?? "")) operatorRefused();
  const queueId = createHash("sha256").update(`dev-code-refresh:${runId}`).digest("hex").slice(0, 20);
  const sdk = parseDevelopmentInstallSdkPacket({ schemaVersion: 1, kind: "development-install-sdk",
    operatorCommitSha: packet.operatorCommitSha, credentialIdentity: packet.credentialIdentity });
  return { packet, sdk, identity: { queueId, buildBatchId: `cms-${queueId}`, commitSha } };
}

// Actions API proof: the run is a completed development refresh run, and the
// upload step never started in any attempt (absent or skipped). A failed or
// cancelled upload may have reached the provider; that run keeps its row for
// retained reconciliation. The Firestore owner then requires the batch to be
// reserved and never leased.
export async function verifyKilledDevRefresh(runId, github) {
  const { repository: repo } = repositoryIdentity();
  const run = await github(`actions/runs/${runId}`);
  const attempt = run?.run_attempt;
  if (String(run?.id) !== runId || run.status !== "completed" || run.path !== WORKFLOW ||
      run.repository?.full_name !== repo || run.head_repository?.full_name !== repo ||
      !Number.isSafeInteger(attempt) || attempt < 1 || attempt > 10) operatorRefused();
  for (let n = 1; n <= attempt; n++) {
    const jobs = await github(`actions/runs/${runId}/attempts/${n}/jobs?per_page=100`);
    if (!Array.isArray(jobs?.jobs) || jobs.total_count !== jobs.jobs.length ||
        jobs.jobs.some(job => String(job.run_id) !== runId || job.status !== "completed" || !Array.isArray(job.steps) ||
          job.steps.some(step => step.name === UPLOAD && step.conclusion !== "skipped"))) operatorRefused();
  }
  // A rerun started during these reads invalidates the proof.
  const latest = await github(`actions/runs/${runId}`);
  if (latest?.run_attempt !== attempt || latest.status !== "completed") operatorRefused();
}

export async function runKilledRefreshSettlement(args, { openSdk = openDevelopmentInstallSdk, github } = {}) {
  const options = parseOperatorArgs(args);
  const { packet, sdk, identity } = parseKilledRefreshPacket(await readOperatorPacket(options));
  assertOperatorSource(packet.operatorCommitSha);
  if (options.mode === "plan") return { mode: "plan", packetDigest: options.packetDigest, identity, authorityReads: 0, authorityWrites: 0 };
  if (options.mode === "apply") {
    let pipe;
    try {
      if (!github) pipe = developmentInstallCredential(4, developmentInstallToken);
      await verifyKilledDevRefresh(packet.request.runId, github ?? devSettlementGithub(await pipe.read()));
    } finally { pipe?.close(); }
  }
  const connection = await openSdk(sdk, 3);
  try {
    const { default: dev } = await import("./lib/dev-publication.cjs");
    const outcome = await dev.settleKilledDevRefresh(connection.firestore, identity, { readOnly: options.mode === "readback" });
    return { mode: options.mode, packetDigest: options.packetDigest, identity, outcome };
  } finally { await connection.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runKilledRefreshSettlement(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + "\n"))
    .catch(() => { process.stderr.write('{"status":"refused","code":"dev-killed-refresh-settlement-refused"}\n'); process.exitCode = 1; });
}
