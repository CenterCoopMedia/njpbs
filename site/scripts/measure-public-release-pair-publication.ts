import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import protocol from "../../functions/lib/public-release-pair.js";
import { MAX_REHEARSAL_TIMING_CASES, isRehearsalTimingOperationId } from "../../scripts/lib/rehearsal-timing-cases.mjs";
import { openPublicationTimingCensus, publicationTimingMissingBindings, runPublicationTimingSession,
  openInstalledPublicationTimingTransport, parsePublicationTimingCase, PublicationTimingRefusal,
  type InstalledPublicationTimingSetup, type PublicationTimingCase } from "./public-release-pair-publication-timing";

/** Resource lifetime belongs to the existing rehearsal setup. Tests can supply
 * this process boundary; no packet field can select an adapter or return proof. */
export type PublicationTimingSetupOpener = (input: {
  plan: unknown; pair: PublicReleasePair; cases: readonly PublicationTimingCase[]; authorized: true; signal?: AbortSignal;
}) => Promise<{ setup: InstalledPublicationTimingSetup; close(): Promise<void> }>;

const openOwnerSetup: PublicationTimingSetupOpener = async input => {
  const adapter = await import("../../scripts/lib/public-release-rehearsal-adapter.mjs");
  const open = Reflect.get(adapter, "openInstalledPublicationTimingSetup") as PublicationTimingSetupOpener | undefined;
  if (typeof open !== "function") throw new PublicationTimingRefusal("installed-publication-timing-bindings-missing");
  return open(input);
};

/** Explicit development mode only. Validate identities and cases before the
 * resource owner may consume its inherited credential streams. */
export async function runInstalledPublicationTimingPacket({ packet, outputDirectory, openSetup = openOwnerSetup, signal }: {
  packet: unknown; outputDirectory: string; openSetup?: PublicationTimingSetupOpener; signal?: AbortSignal;
}) {
  const value = packet as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 2 ||
      Object.keys(value).sort().join(",") !== "cases,distDirectory,pair,preparedArtifact,schemaVersion,setup" ||
      typeof value.distDirectory !== "string" || !value.distDirectory || !outputDirectory ||
      !Array.isArray(value.cases) || !value.cases.length || value.cases.length > MAX_REHEARSAL_TIMING_CASES) throw new PublicationTimingRefusal("installed-timing-packet-invalid");
  const pair = protocol.parsePublicReleasePair(value.pair);
  if (pair.environment !== "development") throw new PublicationTimingRefusal("non-production-target-required");
  const cases = Object.freeze(value.cases.map(parsePublicationTimingCase));
  if (cases.some(input => !isRehearsalTimingOperationId(input.operationId))) throw new PublicationTimingRefusal("case-invalid");
  if (new Set(cases.map(input => input.operationId)).size !== cases.length) throw new PublicationTimingRefusal("sample-operation-repeated");
  signal?.throwIfAborted();
  const census = await openPublicationTimingCensus({ distDirectory: value.distDirectory, preparedArtifact: value.preparedArtifact });
  signal?.throwIfAborted();
  const installed = await openSetup({ plan: value.setup, pair, cases, authorized: true, signal });
  try {
    const transport = await openInstalledPublicationTimingTransport({ enabled: true, setup: installed.setup });
    return await runPublicationTimingSession({ pair, census, cases, outputDirectory, transport });
  } finally {
    try { await installed.close(); }
    catch {
      process.stderr.write("Publication timing cleanup failed\n");
      process.exitCode = 1;
    }
  }
}

async function publicationTimingCommand(args = process.argv.slice(2)) {
  try {
    const [mode, packetPath, outputDirectory, ...extra] = args;
    if (mode === "plan" && !packetPath) {
      process.stdout.write(JSON.stringify({ schemaVersion: 1, productionAdoption: false,
        missingBindings: publicationTimingMissingBindings, metric: "Original source dispatch to exact canonical body proof",
        includes: ["capture", "remote Firestore and R2", "compiled full-census rendering", "staging", "activation", "fresh canonical bytes"],
        terminalSettlementRequired: true, minimumCompleteSamples: 20, gateMs: 10_000,
        failedOrInterruptedSamplesBlockGate: true }, null, 2) + "\n");
    } else if ((mode === "run" || mode === "run-development") && packetPath && outputDirectory && !extra.length) {
      const packet = JSON.parse(await readFile(packetPath, "utf8"));
      let report;
      if (mode === "run-development") report = await runInstalledPublicationTimingPacket({ packet, outputDirectory });
      else {
        const census = await openPublicationTimingCensus({ distDirectory: packet.distDirectory, preparedArtifact: packet.preparedArtifact });
        report = await runPublicationTimingSession({ pair: packet.pair, census, cases: packet.cases, outputDirectory });
      }
      process.stdout.write(JSON.stringify(report.summary) + "\n");
      if (!report.summary.gatePassed) process.exitCode = 1;
    } else throw new PublicationTimingRefusal("invocation-invalid");
  } catch (error) {
    // No raw provider, request, body, path or credential errors enter stdout/logs.
    process.stderr.write(`Publication timing refused: ${error instanceof PublicationTimingRefusal ? error.code : "input-or-evidence-invalid"}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await publicationTimingCommand();
