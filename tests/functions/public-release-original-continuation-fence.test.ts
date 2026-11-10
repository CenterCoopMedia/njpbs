import { afterEach, expect, it, vi } from "vitest";
import protocol from "../../functions/lib/public-release-pair.js";
import admission from "../../functions/lib/public-release-admission.js";
import work from "../../functions/lib/public-release-pair-work.js";
import activation from "../../functions/lib/public-release-content-activation.js";
import { releasePair } from "../helpers/private-public-release-pair";
import { createOriginalPublicReleaseContinuation } from "../../site/scripts/public-release-original-continuation";
import { recoverOriginalPublicReleaseWork } from "../../site/scripts/public-release-original-work-recovery";
vi.mock("../../site/scripts/public-release-original-work-recovery", () => ({
  recoverOriginalPublicReleaseWork: vi.fn(), recoverDueOriginalPublicReleaseWork: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

it.each([false, true])("only unactivated originals defer at a held writer fence (receipt %s)", async hasReceipt => {
  const pair = releasePair(), operationId = "fence-original", now = 10_000;
  const identity = { schemaVersion: 2 as const, pair: protocol.publicReleasePairReference(pair), kind: "accepted" as const,
    sourceOperationId: operationId, sourceVersion: 1, snapshotDigest: "a".repeat(64), contextSequence: 1,
    inputManifestDigest: "b".repeat(64) };
  const accepted = { operationId, pair: identity.pair, pairDigest: protocol.publicReleaseDigest(pair),
    source: { sourceVersion: 1, snapshotDigest: identity.snapshotDigest }, changeSequence: 1 };
  const admissionDigest = protocol.publicReleaseDigest(accepted);
  const rows = new Map<string, any>([
    ["system/publicDeployment", { schemaVersion: 2 }],
    [`${admission.ADMISSIONS}/controls/adoption`, { schemaVersion: 2, enabled: true }],
    [`${admission.ADMISSIONS}/operations/${operationId}`, accepted],
    [`${admission.ADMISSIONS}/pending/${operationId}`, { admissionDigest }],
    [admission.publicationPendingPath(pair.pairId, operationId), { schemaVersion: 2, operationId, admissionDigest, nextAttemptAt: 0 }],
    [admission.ownerPath(accepted.source), { operationId }],
    ["system/publicDeployment/releaseWriter/fence", { schemaVersion: 2 }],
  ]);
  if (hasReceipt) rows.set(activation.activationPath(pair, operationId), { immutableReceipt: true });
  const snapshot = (path: string) => ({ exists: rows.has(path), data: () => rows.get(path) });
  const doc = (path: string) => ({ path, get: async () => snapshot(path) });
  const getAll = async (...refs: { path: string }[]) => refs.map(ref => snapshot(ref.path));
  const update = vi.fn((ref, patch) => rows.set(ref.path, { ...rows.get(ref.path), ...patch }));
  const firestore = { doc, getAll, runTransaction: async (fn: any) => fn({ getAll, update }) };
  vi.spyOn(protocol, "parseStoredPublicReleaseSelector").mockImplementation(value => value as any);
  vi.spyOn(admission, "parseAdmission").mockReturnValue(accepted as any);
  vi.spyOn(work, "readPublicReleasePairWork").mockResolvedValue(undefined as any);
  vi.spyOn(work, "assertPublicReleasePairCompletedReceiptInTransaction").mockResolvedValue({ identity } as any);
  vi.mocked(recoverOriginalPublicReleaseWork).mockClear().mockRejectedValue(new Error("Recovery boundary reached"));
  const continuation = createOriginalPublicReleaseContinuation({ enabled: true, firestore: firestore as any,
    pair, clock: () => now, store: {} as any, ingress: {} as any, capture: {} as any, fieldValues: {} as any });
  await continuation.completed!({ identity, claimDigest: "c".repeat(64), manifestDigest: "d".repeat(64) });
  expect(recoverOriginalPublicReleaseWork).toHaveBeenCalledTimes(hasReceipt ? 1 : 0);
  expect(rows.get(admission.publicationPendingPath(pair.pairId, operationId))).toMatchObject({
    recoveryFailure: hasReceipt ? "original-continuation-pending" : "activation-pending",
    continuationFailures: 0, nextAttemptAt: now + 1_000,
  });
});
