import { createRequire } from "node:module";
import { beforeEach, expect, it, vi } from "vitest";
vi.mock("./pending-work", async original => ({ ...await original<typeof import("./pending-work")>(), accessToken: vi.fn(async () => "synthetic-access") }));
import { readPrivatePreviewPairAuthority } from "./pair-authority";
import { pair, candidate, selector } from "../tests/helpers/cms-preview-pairs.js";
import { releasePair, pairReference } from "../tests/helpers/private-public-release-pair.js";
const require = createRequire(import.meta.url), pairs = require("../functions/lib/cms-preview-pair.js"), api = require("../functions/lib/cms-preview-pair-candidate.js");
const next = pair("new", "b"), old = pair("old"), legacy = { schemaVersion: 1, phase: "ready", rendererSha: old.rendererSha, serializerId: "cloudflare-preview" };
const env = { PREVIEW_SERIALIZER_ID: next.pairId, PREVIEW_RENDERER_SHA: next.rendererSha, PREVIEW_WORKER_VERSION: { id: next.workerVersion }, FIREBASE_SERVICE_ACCOUNT: "synthetic" } as Env;
let rows: Map<string, unknown>;
const encode = (value: any): any => value === null ? { nullValue: null } : typeof value === "string" ? { stringValue: value }
  : typeof value === "number" ? { integerValue: String(value) } : typeof value === "boolean" ? { booleanValue: value }
    : { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, child]) => [key, encode(child)])) } };
beforeEach(() => {
  const verified = candidate(next); Object.assign(verified.mutation.providerIdentities, { applicationId: "application-new", workerDeploymentId: "deployment-new" });
  rows = new Map([[`${pairs.PAIRS}/${next.pairId}`, next], [pairs.SELECTOR_PATH, legacy], ["cmsDeploymentCandidates/renderer-100-1", verified],
    [`${api.POINTERS}/${next.pairId}`, { schemaVersion: 1, pairId: next.pairId, pairDigest: pairs.digest(next), candidateReceiptId: "renderer-100-1",
      candidateDigest: pairs.digest(verified), runtimeDigest: pairs.digest(legacy), bootstrapPublicPair: pairReference(releasePair()) }]]);
});
const transport = () => vi.fn<typeof fetch>(async (url, init) => {
  const path = String(url).split("/documents/")[1]?.split("?")[0];
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-access"); expect(init?.redirect).toBe("error");
  if (!rows.has(path)) return new Response(null, { status: 404 });
  return Response.json({ fields: encode(rows.get(path)).mapValue.fields });
});
it("verifies full immutable registry, candidate and pointer twice without any writes", async () => {
  const request = transport(); expect((await readPrivatePreviewPairAuthority(env, request)).mode).toBe("candidate");
  expect(request).toHaveBeenCalledTimes(10);
  for (const [, init] of request.mock.calls) expect(init?.method).toBeUndefined();
});
it("retained schema two does not require or refresh an expired candidate receipt", async () => {
  rows.set(pairs.SELECTOR_PATH, selector(old, next)); rows.delete("cmsDeploymentCandidates/renderer-100-1");
  expect((await readPrivatePreviewPairAuthority(env, transport())).mode).toBe("retained");
});
it.each(["candidate", "retained", "work"])("accepts reordered Firestore fields across both %s authority observations", async mode => {
  if (mode !== "candidate") rows.set(pairs.SELECTOR_PATH, selector(old, next));
  const reverseFields = (value: any): any => value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseFields(child)])) : value;
  const reordered = reverseFields(next);
  expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(next));
  expect(pairs.digest(reordered)).toBe(pairs.digest(next));
  const original = transport(), reads = new Map<string, number>();
  const request = vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url).split("/documents/")[1]?.split("?")[0];
    const count = (reads.get(path) ?? 0) + 1; reads.set(path, count);
    if (count === 2 && rows.has(path)) rows.set(path, reverseFields(rows.get(path)));
    return original(url, init);
  });
  expect((await readPrivatePreviewPairAuthority(env, request, { work: mode === "work" })).mode)
    .toBe(mode === "candidate" ? "candidate" : "retained");
  expect(reads.get(`${pairs.PAIRS}/${next.pairId}`)).toBe(2);
});
it.each([false, true])("refuses a changed pair value across retained authority observations (work=%s)", async work => {
  rows.set(pairs.SELECTOR_PATH, selector(old, next));
  const original = transport(); let registryReads = 0;
  const request = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith(`/documents/${pairs.PAIRS}/${next.pairId}`) && ++registryReads === 2) {
      rows.set(`${pairs.PAIRS}/${next.pairId}`, { ...next, imageDigest: `sha256:${"c".repeat(64)}` });
    }
    return original(url, init);
  });
  await expect(readPrivatePreviewPairAuthority(env, request, { work })).rejects.toThrow("Private preview authority changed");
});
it("work ticks do not need a registry or candidate pointer before retention, while health refuses", async () => {
  rows.delete(`${pairs.PAIRS}/${next.pairId}`); rows.delete(`${api.POINTERS}/${next.pairId}`);
  const request = transport(); expect((await readPrivatePreviewPairAuthority(env, request, { work: true })).mode).toBe("unretained");
  expect(request.mock.calls.every(([url]) => !String(url).includes("CandidatePointers") && !String(url).includes("cmsPreviewPairs/"))).toBe(true);
  await expect(readPrivatePreviewPairAuthority(env, transport())).rejects.toThrow();
});
it("retained work verifies registration and reports real registry or HTTP failures", async () => {
  rows.set(pairs.SELECTOR_PATH, selector(old, next)); rows.delete("cmsDeploymentCandidates/renderer-100-1");
  expect((await readPrivatePreviewPairAuthority(env, transport(), { work: true })).mode).toBe("retained");
  rows.delete(`${pairs.PAIRS}/${next.pairId}`);
  await expect(readPrivatePreviewPairAuthority(env, transport(), { work: true })).rejects.toThrow();
});
it.each(["billing", "version", "candidate"])("refuses %s drift before Container health", async field => {
  if (field === "billing") rows.set("system/billing", { disabled: true });
  if (field === "version") rows.set(`${pairs.PAIRS}/${next.pairId}`, { ...next, workerVersion: old.workerVersion });
  if (field === "candidate") rows.delete("cmsDeploymentCandidates/renderer-100-1");
  await expect(readPrivatePreviewPairAuthority(env, transport())).rejects.toThrow();
});
it("refuses a coherent cohort change across the two REST observations", async () => {
  const original = transport(); let calls = 0;
  const request = vi.fn<typeof fetch>(async (url, init) => {
    if (++calls === 6) rows.set(pairs.SELECTOR_PATH, selector(old, next));
    return original(url, init);
  });
  await expect(readPrivatePreviewPairAuthority(env, request)).rejects.toThrow("authority changed");
});
it.each([302, 503])("refuses HTTP %s without exposing provider text", async status => {
  const request = vi.fn<typeof fetch>(async () => new Response("synthetic-private-text", { status }));
  await expect(readPrivatePreviewPairAuthority(env, request)).rejects.toThrow("work check failed");
});
