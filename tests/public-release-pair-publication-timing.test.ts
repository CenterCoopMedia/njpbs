import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { releasePair, releaseSelector } from "./helpers/private-public-release-pair.js";
import protocol from "../functions/lib/public-release-pair.js";
import { openInstalledPublicationTimingTransport, publicationTimingSummary, runPublicationTimingSession,
  timePublicReleasePairPublication, type PublicationTimingObservation, type PublicationTimingSample,
  type PublicationTimingTransport } from "../site/scripts/public-release-pair-publication-timing";

// External dispatch/private proof boundary fixture. This is not a deployed
// publisher, full-census execution or an end-to-end timing receipt.
const pair = releasePair(), selector = releaseSelector();
const input = { operationId: "publish-one", sourceVersion: 5, snapshotDigest: "f".repeat(64), path: "/story/", status: 200 as const };
const htmlPaths = ["/", "/story/"];
const census = { artifactDigest: "a".repeat(64), publicationReceiptDigest: "b".repeat(64), htmlPaths,
  htmlPathsDigest: protocol.publicReleaseDigest(htmlPaths) };
const body = "Original accepted story bytes", bodyDigest = createHash("sha256").update(body).digest("hex");
function observation(): PublicationTimingObservation {
  return { selector, original: input, admissionDigest: "1".repeat(64), activationReceiptDigest: "2".repeat(64),
    terminalReceiptDigest: "3".repeat(64), censusDigest: census.htmlPathsDigest, bodyDigest,
    contentType: "text/html; charset=utf-8", response: new Response(body, { headers: {
      "content-type": "text/html; charset=utf-8", "x-njpbs-publication-origin": "template-dev-public",
      "x-njpbs-release-epoch": "1", "x-njpbs-release-pair": pair.pairId,
      "x-njpbs-content-head-sha256": selector.contentHead.manifestDigest,
      "x-njpbs-selector-sha256": protocol.publicReleaseDigest(selector),
      "x-njpbs-publication-operation": input.operationId, "x-njpbs-source-version": "5",
      "x-njpbs-snapshot-sha256": input.snapshotDigest, "x-njpbs-renderer-sha": pair.commitSha,
      "x-njpbs-html-sha256": bodyDigest } }), readSelector: async () => selector };
}
const transport = (read = observation): PublicationTimingTransport => ({ preflight: async () => {}, publish: async () => {}, observe: async () => read() });
const scratch: string[] = [];
afterEach(async () => { await Promise.all(scratch.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

it("starts before original dispatch and ends after full response and fresh authority, using one client clock", async () => {
  let clock = 100;
  const external = transport(() => { const row = observation(); clock = 4_100;
    row.readSelector = async () => { clock = 9_100; return selector; }; return row; });
  external.publish = async () => { clock = 2_100; };
  const sample = await timePublicReleasePairPublication({ pair, census, input, transport: external, now: () => clock });
  expect(sample).toMatchObject({ status: "complete", elapsedMs: 9_000, canonicalElapsedMs: 9_000, withinGate: true, bodyDigest });
});

it.each([308, 410] as const)("consumes a private %i proof with an empty body and no content type", async status => {
  const original = { ...input, status }, emptyDigest = createHash("sha256").update("").digest("hex");
  const external = transport(() => {
    const row = observation(), headers = new Headers(row.response.headers);
    headers.delete("content-type");
    headers.set("x-njpbs-html-sha256", emptyDigest);
    return { ...row, original, bodyDigest: emptyDigest, contentType: null, response: new Response(null, { status, headers }) };
  });
  expect(await timePublicReleasePairPublication({ pair, census, input: original, transport: external })).toMatchObject({
    status: "complete", bodyDigest: emptyDigest });
});

it.each(["body", "operation", "selector", "census", "fallback", "snapshot"])("refuses an invalid %s proof instead of retrying it into success", async fault => {
  const external = transport(() => {
    const row = observation();
    if (fault === "body") row.response = new Response("stale", { headers: row.response.headers });
    if (fault === "operation") row.response.headers.set("x-njpbs-publication-operation", "another-operation");
    if (fault === "snapshot") row.response.headers.set("x-njpbs-snapshot-sha256", "0".repeat(64));
    if (fault === "selector") row.readSelector = async () => ({ ...selector, epoch: 2 });
    if (fault === "census") row.censusDigest = "0".repeat(64);
    if (fault === "fallback") row.response.headers.set("publication-refresh", "pending");
    return row;
  });
  expect(await timePublicReleasePairPublication({ pair, census, input, transport: external })).toMatchObject({ status: "refused", withinGate: false });
});

it("refuses production before original dispatch and missing installations cannot create a transport", async () => {
  await expect(timePublicReleasePairPublication({ pair: { ...pair, environment: "production" }, census, input,
    transport: transport() })).rejects.toThrow("non-production-target-required");
  await expect(openInstalledPublicationTimingTransport()).rejects.toThrow("installed-publication-timing-bindings-missing");
});

it("keeps a slow sample visible even when p95 passes and rejects insufficient or incomplete sample sets", () => {
  const samples = Array.from({ length: 20 }, (_, index) => ({ operationId: `sample-${index}`, status: "complete",
    elapsedMs: index === 19 ? 11_000 : 1_000, canonicalElapsedMs: index === 19 ? 11_000 : 1_000,
    withinGate: index !== 19, reason: null, admissionDigest: "1".repeat(64), activationReceiptDigest: "2".repeat(64),
    terminalReceiptDigest: "3".repeat(64), selectorDigest: "4".repeat(64), bodyDigest })) as PublicationTimingSample[];
  expect(publicationTimingSummary(samples)).toMatchObject({ p50Ms: 1_000, p95Ms: 1_000, maxMs: 11_000, gatePassed: false });
  expect(publicationTimingSummary(samples.slice(0, 19)).gatePassed).toBe(false);
  expect(publicationTimingSummary(samples.map(sample => ({ ...sample, elapsedMs: 10_000, canonicalElapsedMs: 10_000, withinGate: true }))).gatePassed).toBe(true);
  expect(publicationTimingSummary([...samples.slice(0, 19), { ...samples[19], status: "interrupted", elapsedMs: null,
    canonicalElapsedMs: null }])).toMatchObject({ completedCount: 19, failedCount: 1, gatePassed: false });
});

it("retains a lost client clock without repeating the original publication on resume", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pair-timing-contract-")); scratch.push(directory);
  const packet = { schemaVersion: 1, pair, census, cases: [input] };
  await writeFile(path.join(directory, "packet.json"), JSON.stringify(packet));
  const key = protocol.publicReleaseDigest(input);
  await writeFile(path.join(directory, `${key}.started.json`), JSON.stringify({ packetDigest: protocol.publicReleaseDigest(packet), inputDigest: key }));
  const external = transport(); external.publish = async () => { throw new Error("An accepted operation was repeated"); };
  const report = await runPublicationTimingSession({ pair, census, cases: [input], outputDirectory: directory, transport: external });
  expect(report.samples).toMatchObject([{ status: "interrupted", elapsedMs: null, reason: "prior-client-clock-lost" }]);
  const resumed = await runPublicationTimingSession({ pair, census, cases: [input], outputDirectory: directory, transport: external });
  expect(resumed.samples).toEqual(report.samples);
  expect(JSON.parse(await readFile(path.join(directory, `${key}.sample.json`), "utf8"))).toEqual(report.samples[0]);
  expect((await readdir(directory)).filter(name => name.endsWith(".started.json"))).toHaveLength(1);
});
