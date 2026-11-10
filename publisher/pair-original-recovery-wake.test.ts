import { expect, it, vi } from "vitest";
import { pairFirestoreReader } from "./pair-work-reader";
import { wakePublicReleasePair } from "./release-pair-wake";
import { releasePair } from "../tests/helpers/private-public-release-pair.js";
import work from "../functions/lib/public-release-pair-work.js";

const pair = releasePair(), base = work.publicReleasePairPath(pair.pairId);
const resource = "projects/demo-original-wake/databases/(default)/documents";
const document = () => ({ name: `${resource}/${base}/publicationPending/original`, fields: {
  schemaVersion: { integerValue: "2" }, operationId: { stringValue: "original" }, admissionDigest: { stringValue: "a".repeat(64) } } });

it("queries only the own pair's bounded due original-publication hints", async () => {
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe(`https://firestore.googleapis.com/v1/${resource}/${base.split("/").map(encodeURIComponent).join("/")}:runQuery`);
    expect(JSON.parse(String(init?.body))).toEqual({ structuredQuery: {
      from: [{ collectionId: "publicationPending" }],
      select: { fields: ["schemaVersion", "operationId", "admissionDigest"].map(fieldPath => ({ fieldPath })) },
      where: { fieldFilter: { field: { fieldPath: "nextAttemptAt" }, op: "LESS_THAN_OR_EQUAL", value: { integerValue: "1234" } } }, limit: 1 } });
    return Response.json([{ document: document() }]);
  });
  const reader = pairFirestoreReader({ projectId: "demo-original-wake", token: "fixture-only", request });
  expect(await reader.hasPendingPublication(pair.pairId, 1234)).toBe(true);
  expect(request).toHaveBeenCalledTimes(1);
});

it.each(["other pair", "other operation", "bad digest", "bad schema", "extra rows", "not an array"])("refuses %s wake evidence", async mode => {
  const row = document();
  if (mode === "other pair") row.name = `${resource}/${work.publicReleasePairPath(releasePair("b", "b".repeat(40)).pairId)}/publicationPending/original`;
  if (mode === "other operation") row.fields.operationId.stringValue = "elsewhere";
  if (mode === "bad digest") row.fields.admissionDigest.stringValue = "yes";
  if (mode === "bad schema") row.fields.schemaVersion.integerValue = "1";
  const result = mode === "not an array" ? {} : mode === "extra rows" ? [{ document: row }, { document: row }] : [{ document: row }];
  const reader = pairFirestoreReader({ projectId: "demo-original-wake", token: "fixture-only", request: async () => Response.json(result) });
  await expect(reader.hasPendingPublication(pair.pairId, 1234)).rejects.toThrow();
});

it.each([undefined, false, "true", true])("only the actual due-publication bit wakes an otherwise idle pair (%s)", async publicationPending => {
  const start = vi.fn();
  expect(await wakePublicReleasePair({ pair, identity: { pairId: pair.pairId, commitSha: pair.commitSha,
    environment: pair.environment, journalNamespace: pair.publisher.journalNamespace },
    readWork: async () => ({ taskIds: [], publicationPending: publicationPending as boolean }), start })).toBe(publicationPending === true);
  expect(start).toHaveBeenCalledTimes(publicationPending === true ? 1 : 0);
});
