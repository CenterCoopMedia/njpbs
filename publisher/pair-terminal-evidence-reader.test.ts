import { expect, it, vi } from "vitest";
import { terminalEvidenceReader, TERMINAL_EVIDENCE_WIRE_BYTES } from "./pair-terminal-evidence-reader";
import { pairOwnerEvidenceClient } from "./pair-owner-evidence-client";
import { pairFirestoreReader, decodePairEvidenceFields } from "./pair-work-reader";
import { releasePair } from "../tests/helpers/private-public-release-pair";
const projectId = "demo-terminal-evidence", token = "fixture-only";
const resource = `projects/${projectId}/databases/(default)/documents`;
const path = `system/publicReleaseAdmissions/canonicalProofs/${"a".repeat(64)}`;
function field(value: any): any {
  if (value === null) return { nullValue: "NULL_VALUE" };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return { integerValue: String(value) };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(field) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, value]) => [key, field(value)])) } };
}
const document = (value: unknown) => ({ name: `${resource}/${path}`, fields: field(value).mapValue.fields });
function client(value: unknown) {
  const request = vi.fn(async () => Response.json(document(value)));
  return { request, read: terminalEvidenceReader({ projectId, token, request: request as any }) };
}
it("reads a typed REST document above 64 KiB and 100 array entries through the private owner binding", async () => {
  const value = { schemaVersion: 2, operationId: "I".repeat(20),
    proofs: Array.from({ length: 120 }, (_, index) => ({ path: `/route-${index}/`, digest: "b".repeat(64), bytes: 10, detail: "x".repeat(800) })) };
  expect(new TextEncoder().encode(JSON.stringify(document(value))).length).toBeGreaterThan(64 * 1024);
  const { request } = client(value);
  const bound = pairOwnerEvidenceClient({ projectId, token, pair: releasePair(), decode: decodePairEvidenceFields, request: request as any });
  expect(await bound.readTerminalEvidence(path)).toEqual(value);
  await expect(pairFirestoreReader({ projectId, token, request: request as any }).read(path)).rejects.toThrow("size limit");
});
it("retains the observer's 100-element bound while accepting a bounded FACT warning array", async () => {
  const value = { warnings: Array.from({ length: 101 }, (_, index) => `warning-${index}`), enabled: true, count: 101, absent: null };
  const { read, request } = client(value);
  expect(await read(path)).toEqual(value);
  await expect(pairFirestoreReader({ projectId, token, request: request as any }).read(path)).rejects.toThrow("Invalid private pair array");
});
it.each(["system/billing", "system/publicDeployment", "cmsPosts/story", "cmsPublishQueue/../other",
  "system/publicReleaseAdmissions/canonicalProofs/not-a-digest", "system/publicReleasePairs/entries/other"])("refuses non-FACT path %s before a request", async invalid => {
  const { read, request } = client({});
  await expect(read(invalid)).rejects.toThrow("Invalid private terminal evidence");
  expect(request).not.toHaveBeenCalled();
});
it("refuses a different returned project/document", async () => {
  const request = vi.fn(async () => Response.json({ ...document({}), name: `${resource}/cmsPublishQueue/other` }));
  await expect(terminalEvidenceReader({ projectId, token, request: request as any })(path)).rejects.toThrow("Invalid private terminal evidence");
});
it("returns a missing FACT document without accepting its body", async () => {
  const request = vi.fn(async () => new Response(null, { status: 404 }));
  expect(await terminalEvidenceReader({ projectId, token, request: request as any })(path)).toBeNull();
});
it.each([
  { stringValue: "ambiguous", booleanValue: true }, { integerValue: "9007199254740992" },
  { arrayValue: { values: {} } }, { bytesValue: "unsupported" },
])("refuses malformed or unsupported typed values", async value => {
  const request = vi.fn(async () => Response.json({ name: `${resource}/${path}`, fields: { value } }));
  await expect(terminalEvidenceReader({ projectId, token, request: request as any })(path)).rejects.toThrow("Invalid private terminal evidence");
});
it("refuses an overlarge typed array", async () => {
  const { read } = client({ values: Array(100_001).fill(0) });
  await expect(read(path)).rejects.toThrow("Invalid private terminal evidence");
});
it("refuses deep maps and too many fields", async () => {
  let nested: any = "leaf";
  for (let index = 0; index < 18; index++) nested = { child: nested };
  await expect(client({ nested }).read(path)).rejects.toThrow("Invalid private terminal evidence");
  await expect(client(Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`field${index}`, 0]))).read(path))
    .rejects.toThrow("Invalid private terminal evidence");
});
it("bounds actual streamed wire bytes independently of the claimed length and cancels overflow", async () => {
  let canceled = false, sent = 0;
  const chunk = new Uint8Array(512 * 1024);
  const request = vi.fn(async () => new Response(new ReadableStream({ pull(controller) {
    controller.enqueue(chunk); sent += chunk.length;
    if (sent > TERMINAL_EVIDENCE_WIRE_BYTES + 2 * chunk.length) controller.close();
  }, cancel() { canceled = true; } }), { headers: { "content-length": "1" } }));
  await expect(terminalEvidenceReader({ projectId, token, request: request as any })(path)).rejects.toThrow("size limit");
  expect(canceled).toBe(true);
});
