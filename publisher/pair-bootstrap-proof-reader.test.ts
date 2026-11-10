import { expect, it, vi } from "vitest";
vi.mock("./pending-work", async original => ({ ...await original<object>(), accessToken: async () => "fixture-only" }));
import { decodeBootstrapReceiptFields, privateBootstrapProofReader } from "./pair-bootstrap-proof-reader";
import { decodePairEvidenceFields } from "./pair-work-reader";
import { releasePair } from "../tests/helpers/private-public-release-pair.js";
import work from "../functions/lib/public-release-pair-work.js";

function wire(value: any): any {
  if (value === null) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return { integerValue: String(value) };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(wire) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, wire(item)])) } };
}
const graph = { version: 2, globalFingerprint: "a".repeat(64), exports: Object.fromEntries(Array.from({ length: 161 }, (_, index) =>
  [`cmsBootstrapInstalledPublicReleaseConsumerExport${String(index).padStart(3, "0")}`, { fingerprint: "b".repeat(64), preview: false }])) };
const receipt = { schemaVersion: 1, component: "functions", state: "complete", mutation: { sourceSha: "c".repeat(40), functionGraph: graph },
  lastComplete: { sourceSha: "c".repeat(40), functionGraph: graph } };
it("decodes both original 161-export graphs while preserving the ordinary reader bounds", () => {
  const fields = wire(receipt).mapValue.fields;
  expect(() => decodePairEvidenceFields(fields)).toThrow("exceeds bounds");
  expect(decodeBootstrapReceiptFields(fields)).toEqual(receipt);
  expect(() => decodeBootstrapReceiptFields(wire(Object.fromEntries(Array.from({ length: 513 }, (_, index) => [String(index), 1]))).mapValue.fields)).toThrow("exceeds bounds");
});
it("reads a realistic full receipt over the fixed own-project REST transport without truncation", async () => {
  const pair = releasePair(), prefix = "projects/njpbs-site-dev/databases/(default)/documents/", calls: string[] = [];
  const request: typeof fetch = async (url, init) => {
    const source = new URL(String(url)); calls.push(source.pathname);
    expect(source.origin).toBe("https://firestore.googleapis.com"); expect(init?.redirect).toBe("error"); expect(init?.method).toBeUndefined();
    const path = source.pathname.slice(`/v1/${prefix}`.length);
    const data = path === work.publicReleasePairPath(pair.pairId) ? pair : receipt;
    const document = { name: `${prefix}${path}`, fields: wire(data).mapValue.fields };
    if (path === "cmsDeploymentReceipts/functions") expect(JSON.stringify(document).length).toBeGreaterThan(64 * 1024);
    return Response.json(document);
  };
  const authority = await privateBootstrapProofReader({ account: "fixture-only", workerVersionId: pair.publisher.workerVersionId,
    identity: { pairId: pair.pairId, commitSha: pair.commitSha, environment: pair.environment, journalNamespace: pair.publisher.journalNamespace }, request });
  expect(authority.pair).toEqual(pair);
  expect(await authority.read("cmsDeploymentReceipts/functions")).toEqual(receipt);
  expect(await authority.read("cmsReaderCompatibilityReceipts/functions")).toEqual(receipt);
  await expect(authority.read("system/ordinary-control")).rejects.toThrow();
  expect(calls).toHaveLength(4);
});
it.each(["foreign", "oversized", "missing"])("refuses %s receipt responses at the provider boundary", async fault => {
  const pair = releasePair(), prefix = "projects/njpbs-site-dev/databases/(default)/documents/";
  const request: typeof fetch = async url => {
    const path = new URL(String(url)).pathname.slice(`/v1/${prefix}`.length);
    if (path === work.publicReleasePairPath(pair.pairId)) return Response.json({ name: `${prefix}${path}`, fields: wire(pair).mapValue.fields });
    if (fault === "missing") return new Response(null, { status: 404 });
    if (fault === "oversized") return new Response(" ".repeat(2 * 1024 * 1024 + 1));
    return Response.json({ name: `projects/foreign/databases/(default)/documents/${path}`, fields: wire(receipt).mapValue.fields });
  };
  const authority = await privateBootstrapProofReader({ account: "fixture-only", workerVersionId: pair.publisher.workerVersionId, request,
    identity: { pairId: pair.pairId, commitSha: pair.commitSha, environment: pair.environment, journalNamespace: pair.publisher.journalNamespace } });
  if (fault === "missing") expect(await authority.read("cmsDeploymentReceipts/functions")).toBe(null);
  else await expect(authority.read("cmsDeploymentReceipts/functions")).rejects.toThrow();
});
