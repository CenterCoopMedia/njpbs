import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { releasePair } from "../helpers/private-public-release-pair.js";
import protocol from "../../functions/lib/public-release-pair.js";
import { publishedPageRead, fallbackPageRead, now } from "../../site/tests/fixtures/published-pages/fixtures";
import { projectPublishedRecordRead } from "../../site/src/lib/published-record-render";
import { projectPublicReleasePairReplay, parsePublicReleasePairReplayProvenance, parsePublicReleasePairReplayTargetReceipt } from "../../site/scripts/public-release-pair-replay";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const old = releasePair("b", "b".repeat(40)), pair = releasePair("a", "a".repeat(40));
function fixture(renderer: "post" | "page" | "context" | "record" = "post") {
  const source = JSON.parse(readFileSync(new URL("../../site/tests/fixtures/shadow-posts/post.json", import.meta.url), "utf8"));
  const read = renderer === "post" ? { kind: source.kind, document: { id: source.document.id, status: "published",
    publishAt: source.document.published.publishedAt, publiclyVisible: true, published: source.document.published }, assets: [] }
    : renderer === "page" ? publishedPageRead("about", old.commitSha) : fallbackPageRead("give", old.commitSha);
  const request = { schemaVersion: 1, read, homeSourcesFile: null, resources: [] };
  const provenance = { schemaVersion: 1, pair: old, rendererSha: old.commitSha,
    readerContractDigest: old.readerContractDigest, readerReceiptDigest: old.readerReceiptDigest };
  const inputDigest = sha(JSON.stringify(request)), provenanceDigest = sha(JSON.stringify(provenance));
  const path = renderer === "post" ? "/posts/shadow-fixture/" : renderer === "page" ? "/about/" : "/give/";
  return { pair, identity: { schemaVersion: 2 as const, pair: protocol.publicReleasePairReference(pair), kind: "qualification" as const,
    sourceOperationId: "replay-operation", sourceVersion: 7, snapshotDigest: "c".repeat(64), contextSequence: 12, inputManifestDigest: "d".repeat(64) },
  route: { path, method: "GET" as const, renderer, inputFile: "read.json", dependencies: [
    { name: "read.json", digest: inputDigest }, { name: "reader-provenance.json", digest: provenanceDigest },
  ] }, request, provenance, inputDigest, provenanceDigest, renderedAt: now.toISOString() };
}
it("derives a distinct NEW Post target while preserving full original pair and frozen raw input provenance", async () => {
  const value = fixture(), before = JSON.stringify(value.request);
  const result = await projectPublicReleasePairReplay(value);
  expect(JSON.stringify(value.request)).toBe(before);
  expect(result.content.target).toEqual({ documentId: "shadow-fixture", sourceVersion: 7, rendererSha: pair.commitSha,
    pagePath: "/posts/shadow-fixture/" });
  expect(result.receipt.source.pair).toEqual(protocol.publicReleasePairReference(old));
  expect(result.receipt.source.pairDigest).toBe(protocol.publicReleaseDigest(old));
  expect(result.receipt.source.inputDigest).toBe(value.inputDigest);
  expect(result.receipt.source.provenanceDigest).toBe(value.provenanceDigest);
  expect(result.receipt.target.pair).toEqual(protocol.publicReleasePairReference(pair));
  expect(result.receipt.target.rendererSha).toBe(pair.commitSha);
  const expected = `{"kind":"public-post-shadow","target":{"documentId":"shadow-fixture","pagePath":"/posts/shadow-fixture/","rendererSha":"${pair.commitSha}","sourceVersion":7}}`;
  expect(result.receipt.target.targetDigest).toBe(sha(expected));
  expect(Object.isFrozen(result.receipt.source)).toBe(true);
});
it.each(["page", "context"] as const)("projects %s with NEW code without relabeling the original sourceSeal", async renderer => {
  const value = fixture(renderer), before = JSON.stringify(value.request.read);
  const result = await projectPublicReleasePairReplay(value);
  expect(JSON.stringify(value.request.read)).toBe(before);
  expect((value.request.read as any).sourceSeal.rendererSha).toBe(old.commitSha);
  expect(result.content.target.rendererSha).toBe(pair.commitSha);
  expect(result.receipt.source.sourceSealDigest).toBe(protocol.publicReleaseDigest((value.request.read as any).sourceSeal));
});
it.each(["unknown", "renderer", "contract", "receipt", "pair"])("refuses %s provenance instead of trusting labels", mode => {
  const value = fixture().provenance;
  if (mode === "unknown") Object.assign(value, { latest: true });
  if (mode === "renderer") value.rendererSha = pair.commitSha;
  if (mode === "contract") value.readerContractDigest = "f".repeat(64);
  if (mode === "receipt") value.readerReceiptDigest = "f".repeat(64);
  if (mode === "pair") Object.assign(value, { pair: null });
  expect(() => parsePublicReleasePairReplayProvenance(value)).toThrow();
});
it.each(["wrong-input", "missing-provenance", "wrong-provenance", "wrong-seal", "cross-environment"])("refuses %s", async mode => {
  const value = fixture("page");
  if (mode === "wrong-input") value.inputDigest = "f".repeat(64);
  if (mode === "missing-provenance") value.route.dependencies.pop();
  if (mode === "wrong-provenance") value.provenanceDigest = "f".repeat(64);
  if (mode === "wrong-seal") (value.request.read as any).sourceSeal.rendererSha = pair.commitSha;
  if (mode === "cross-environment") value.provenance.pair = { ...old, environment: "production" };
  await expect(projectPublicReleasePairReplay(value)).rejects.toThrow();
});
it.each(["schedule", "live"])("names missing frozen cross-source %s packets without rewriting the read", async pageId => {
  const value = fixture("page"), read = publishedPageRead(pageId, old.commitSha);
  value.request.read = read; value.route.path = `/${pageId}/`;
  value.inputDigest = sha(JSON.stringify(value.request)); value.route.dependencies[0].digest = value.inputDigest;
  const before = JSON.stringify(read);
  await expect(projectPublicReleasePairReplay(value)).rejects.toMatchObject({ code: "replay-frozen-schedule-missing" });
  expect(JSON.stringify(read)).toBe(before);
});
it("replays a frozen empty OLD Program catalog without relabelling its source identity", async () => {
  const value = fixture("record");
  const read = { kind: "published-record-family", family: "programs", complete: true, documents: [], assets: [],
    sourceSeal: { rendererSha: old.commitSha, contextRevision: 4, contextDigest: sha("njpbs-public-context-v1:4") },
    programImageDescriptors: { schemaVersion: 1, buildBatchId: "old-image-pack", generation: 5,
      rendererSha: old.commitSha, mediaManifestDigest: "e".repeat(64), programs: [], files: [] } };
  expect(await projectPublishedRecordRead(read, "/programs/", old.commitSha, now)).not.toBeNull();
  Object.assign(value.request, { read }); value.route.path = "/programs/";
  value.inputDigest = sha(JSON.stringify(value.request)); value.route.dependencies[0].digest = value.inputDigest;
  const before = JSON.stringify(read);
  const result = await projectPublicReleasePairReplay(value);
  expect((result.content as any).programImageDescriptors).toEqual(read.programImageDescriptors);
  expect(result.content.target.rendererSha).toBe(pair.commitSha);
  expect(parsePublicReleasePairReplayTargetReceipt(result.receipt, value)).toEqual(result.receipt);
  expect(JSON.stringify(read)).toBe(before);
});

it("parses the actual NEW target identity alongside its OLD seals and rejects a substituted source, target or route", async () => {
  const value = fixture("page"), result = await projectPublicReleasePairReplay(value);
  expect(parsePublicReleasePairReplayTargetReceipt(result.receipt, value)).toEqual(result.receipt);
  for (const mutate of [
    (receipt: any) => { receipt.source.rendererSha = pair.commitSha; },
    (receipt: any) => { receipt.target.projection.target.rendererSha = old.commitSha; },
    (receipt: any) => { receipt.path = "/other/"; },
    (receipt: any) => { receipt.target.targetDigest = "f".repeat(64); },
    (receipt: any) => { receipt.target.projection.target.documentId = "other-page"; },
  ]) {
    const changed = structuredClone(result.receipt); mutate(changed);
    expect(() => parsePublicReleasePairReplayTargetReceipt(changed, value)).toThrow();
  }
});

it.each(["/programs/alpha/", "/shows/former-alpha/", "/programs/", "/events/meet-up/"])("checks the frozen record owner/version for %s even if a substituted target digest is internally consistent", async path => {
  const value = fixture("record"), family = path.startsWith("/events/") ? "events" : "programs";
  const document = (id: string, version: number, slug: string) => ({ id, version, status: "published", publiclyVisible: true,
    publishAt: "2026-10-12T10:00:00.000Z", published: { sourceVersion: version, publishedAt: "2026-10-12T10:00:00.000Z", blocks: [],
      metadata: { type: family === "programs" ? "program" : "event", title: id, slug, previousSlugs: id === "alpha" ? ["former-alpha"] : [], locale: "en",
        ...(family === "events" ? { startsAt: "2026-10-13T12:00:00.000Z", isFree: true } : {}),
        description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Published record synopsis" }] }] } } } });
  const read = { kind: "published-record-family", family, complete: true, assets: [],
    documents: family === "programs" ? [document("alpha", 7, "alpha"), document("beta", 8, "beta")] : [document("meet-up", 5, "meet-up")],
    sourceSeal: { rendererSha: old.commitSha, contextRevision: 4, contextDigest: sha("njpbs-public-context-v1:4") } };
  Object.assign(value.request, { read }); value.route.path = path;
  value.inputDigest = sha(JSON.stringify(value.request)); value.route.dependencies[0].digest = value.inputDigest;
  const projected = await projectPublicReleasePairReplay(value);
  expect(parsePublicReleasePairReplayTargetReceipt(projected.receipt, value)).toEqual(projected.receipt);
  expect(projected.receipt.target.projection.target.documentId).toBe(path === "/programs/" ? null : family === "programs" ? "alpha" : "meet-up");
  for (const wrong of [{ documentId: "beta", sourceVersion: 8 }, { documentId: null, sourceVersion: null }, { sourceVersion: 42 }]) {
    const substituted = structuredClone(projected.receipt);
    Object.assign(substituted.target.projection.target, wrong);
    if (protocol.publicReleaseDigest(substituted.target.projection.target) === protocol.publicReleaseDigest(projected.receipt.target.projection.target)) continue;
    substituted.target.targetDigest = protocol.publicReleaseDigest(substituted.target.projection);
    expect(() => parsePublicReleasePairReplayTargetReceipt(substituted, value)).toThrow();
  }
});
