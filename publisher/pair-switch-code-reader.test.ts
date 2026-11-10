import { expect, it, vi } from "vitest";
vi.mock("./pending-work", async original => ({ ...await original<object>(), accessToken: async () => "fixture-only" }));
import { privatePairReader } from "./pair-work-reader";
import { wakePublicReleasePair } from "./release-pair-wake";
import { releasePair, releaseSelector } from "../tests/helpers/private-public-release-pair.js";
import work from "../functions/lib/public-release-pair-work.js";
const pair = releasePair(), base = work.publicReleasePairPath(pair.pairId);
function fields(value: Record<string, any>): Record<string, any> {
  return Object.fromEntries(Object.entries(value).map(([key, value]) => [key,
    value === null ? { nullValue: null } : typeof value === "string" ? { stringValue: value } : typeof value === "number" ? { integerValue: String(value) }
      : typeof value === "boolean" ? { booleanValue: value } : { mapValue: { fields: fields(value) } }]));
}
it.each([undefined, false, true])("preserves original recovery hints with CODE opt-in %s", async switchCodeRecoveryEnabled => {
  const reads: string[] = [], root = { ...releaseSelector(), epoch: 2 };
  const records: Record<string, any> = { [base]: pair, [`${base}/controls/runtime`]: { schemaVersion: 2, pairId: pair.pairId, status: "retained" },
    "system/publicDeployment": root, "system/billing": { disabled: false },
    [`${base}/journals/${pair.publisher.journalNamespace}`]: { schemaVersion: 2, pairId: pair.pairId, journalNamespace: pair.publisher.journalNamespace, job: null },
    "system/publicReleaseAdmissions/controls/adoption": { schemaVersion: 2, enabled: true } };
  const request = vi.fn(async (input: any) => {
    const url = new URL(String(input)), path = decodeURIComponent(url.pathname.split("/documents/")[1] ?? "");
    reads.push(path);
    if (url.pathname.endsWith(":runQuery")) return Response.json([]);
    const value = records[path];
    return value ? Response.json({ name: `projects/njpbs-site-dev/databases/(default)/documents/${path}`, fields: fields(value) }) : new Response(null, { status: 404 });
  });
  const reader = await privatePairReader({ account: "fixture-only", identity: { pairId: pair.pairId, commitSha: pair.commitSha,
    environment: pair.environment, journalNamespace: pair.publisher.journalNamespace }, workerVersionId: pair.publisher.workerVersionId,
    originalRecoveryEnabled: true, ...(switchCodeRecoveryEnabled === undefined ? {} : { switchCodeRecoveryEnabled }), request });
  const hint = await reader.due(1234);
  expect(hint.publicationPending).toBe(switchCodeRecoveryEnabled === true);
  const codeReads = reads.filter(path => /switchCode(Activations|Pending)/.test(path));
  expect(codeReads.length).toBe(switchCodeRecoveryEnabled === true ? 2 : 0);
  const start = vi.fn();
  expect(await wakePublicReleasePair({ pair, identity: { pairId: pair.pairId, commitSha: pair.commitSha,
    environment: pair.environment, journalNamespace: pair.publisher.journalNamespace }, readWork: async () => hint, start })).toBe(switchCodeRecoveryEnabled === true);
  expect(start).toHaveBeenCalledTimes(switchCodeRecoveryEnabled === true ? 1 : 0);
});
