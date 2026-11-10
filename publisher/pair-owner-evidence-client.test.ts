import { expect, it, vi } from "vitest";
import { pairOwnerEvidenceClient } from "./pair-owner-evidence-client";
import { decodePairEvidenceFields } from "./pair-work-reader";
import { releasePair } from "../tests/helpers/private-public-release-pair.js";
import protocol from "../functions/lib/public-release-pair.js";
import work from "../functions/lib/public-release-pair-work.js";
import { ownerReplayPageEvidencePath } from "./pair-owner-page-evidence";

const pair = releasePair(), prefix = work.publicReleasePairPath(pair.pairId);
const resource = "projects/demo-owner-evidence/databases/(default)/documents";
function fixture() {
  const rows = new Map<string, any>();
  let commits = 0, lost = false;
  const request = vi.fn(async (input: any, init: any) => {
    const url = new URL(String(input)), body = JSON.parse(init.body);
    expect(url.origin).toBe("https://firestore.googleapis.com");
    expect(init.method).toBe("POST"); expect(init.redirect).toBe("error");
    if (url.pathname === `/v1/${resource}:batchGet`) return Response.json(body.documents.map((name: string) => rows.has(name)
      ? { found: { name, fields: rows.get(name) } } : { missing: name }));
    expect(url.pathname).toBe(`/v1/${resource}:commit`);
    expect(body.writes).toHaveLength(1);
    const write = body.writes[0]; expect(write.currentDocument).toEqual({ exists: false });
    if (rows.has(write.update.name)) return new Response(null, { status: 409 });
    commits++; rows.set(write.update.name, write.update.fields);
    if (!lost) { lost = true; return new Response(null, { status: 503 }); }
    return Response.json({ writeResults: [{}], commitTime: "2026-10-28T23:00:00Z" });
  });
  const client = pairOwnerEvidenceClient({ projectId: "demo-owner-evidence", token: "unit-only", pair,
    decode: decodePairEvidenceFields, request });
  return { rows, request, client, commits: () => commits };
}
it("reconciles an uncertain create by exact readback and never overwrites a conflicting page receipt", async () => {
  const f = fixture(), receipt = { schemaVersion: 2 as const, kind: "owner-replay-page" as const,
    pairDigest: protocol.publicReleaseDigest(pair), pageDigest: "a".repeat(64),
    cursor: { baselineDigest: "b".repeat(64), sequence: 1, lastDigest: "c".repeat(64) },
    index: 0, count: 1, firstPath: "/", lastPath: "/", evidenceDigest: "d".repeat(64) };
  await f.client.createPageEvidence(receipt);
  await f.client.createPageEvidence(receipt);
  expect(f.commits()).toBe(1);
  await expect(f.client.createPageEvidence({ ...receipt, evidenceDigest: "e".repeat(64) })).rejects.toThrow("retry differs");
  const [stored] = await f.client.readMany([ownerReplayPageEvidencePath(pair, receipt.pageDigest)]);
  expect(stored).toEqual(receipt); expect(f.commits()).toBe(1);
});
it("bounds and chunks batches, preserving found/missing correlation and exact own-pair scope", async () => {
  const f = fixture(), paths = Array.from({ length: 129 }, (_, index) => `${prefix}/views/${protocol.publicReleaseDigest({ index })}`);
  f.rows.set(`${resource}/${paths[64]}`, { schemaVersion: { integerValue: "2" } });
  const result = await f.client.readMany(paths);
  expect(result.length).toBe(129); expect(result[64]).toEqual({ schemaVersion: 2 });
  expect(result.filter(Boolean)).toHaveLength(1); expect(f.request).toHaveBeenCalledTimes(3);
  const before = f.request.mock.calls.length;
  for (const invalid of [[], [paths[0], paths[0]], ["system/publicDeployment"],
    [paths[0].replace(prefix, work.publicReleasePairPath(releasePair("b", "b".repeat(40)).pairId))], Array(769).fill(paths[0])])
    await expect(f.client.readMany(invalid)).rejects.toThrow();
  expect(f.request).toHaveBeenCalledTimes(before);
});
it.each(["duplicate", "foreign", "missing"])("refuses an uncorrelated %s batch response", async fault => {
  const paths = ["a", "b"].map(value => `${prefix}/receipts/${value.repeat(64)}`);
  const request = vi.fn(async () => Response.json(fault === "missing" ? [] : fault === "duplicate"
    ? [{ missing: `${resource}/${paths[0]}` }, { missing: `${resource}/${paths[0]}` }]
    : [{ missing: `${resource}/${paths[0]}` }, { missing: `projects/other-project/databases/(default)/documents/${paths[1]}` }]));
  const client = pairOwnerEvidenceClient({ pair, projectId: "demo-owner-evidence", token: "unit-only", decode: decodePairEvidenceFields, request });
  await expect(client.readMany(paths)).rejects.toThrow();
});
