import { expect, it } from "vitest";
import { sealedPair } from "../helpers/sealed-public-release-pair";
import protocol from "../../functions/lib/public-release-pair.js";
import { qualificationEvidencePrefix, QUALIFICATION_EVIDENCE_ROOT_BYTES_LIMIT } from "../../site/scripts/public-release-pair-qualification-evidence";
import { parseQualificationReceipt, qualificationReceiptPath } from "../../site/scripts/public-release-pair-qualification-receipt";
const { pair } = sealedPair();
function receipt() {
  const qualificationId = "qualification-one", evidenceDigest = "d".repeat(64);
  return { schemaVersion: 2, kind: "private-pair-qualification", qualificationId, pairDigest: protocol.publicReleaseDigest(pair),
    readerContractDigest: pair.readerContractDigest, readerReceiptDigest: pair.readerReceiptDigest,
    capabilityDigest: pair.capabilityDigest, codeAssetManifestDigest: pair.codeAssetManifestDigest,
    witnessDigest: "1".repeat(64), contentViewDigest: "2".repeat(64), codePackOverlayDigest: "3".repeat(64),
    authorityDigest: "4".repeat(64), sealsDigest: "5".repeat(64), byteProofDigest: "6".repeat(64), sourceCensusDigest: "8".repeat(64), headViewDigest: "7".repeat(64),
    sourceValidation: { mode: "full", outsideReadCount: 12, validatorCount: 10, transactionReadCount: 20 }, catalogProofDigest: "9".repeat(64), compositeProofDigest: "a".repeat(64), namespaceProofDigest: "8".repeat(64),
    selectedViewsDigest: "7".repeat(64), selectedViewCount: 3, qualifiedAt: 1_700_000_000_000,
    coverage: { baseline: 8, content: 4, overlay: 2, absence: 0 },
    evidence: { evidenceDigest, evidenceKey: `${qualificationEvidencePrefix(pair, qualificationId)}roots/${evidenceDigest}.json`,
      evidenceBytes: 2048, outputCount: 14, outputBytes: 4096 } };
}
it("binds the private receipt to the exact pair, reader, capabilities and retained evidence root", () => {
  const value = parseQualificationReceipt(receipt(), pair);
  expect(value.kind).toBe("private-pair-qualification"); expect(value.coverage).toEqual({ baseline: 8, content: 4, overlay: 2, absence: 0 });
  expect(Object.isFrozen(value)).toBe(true); expect(Object.isFrozen(value.evidence)).toBe(true);
  expect(qualificationReceiptPath(pair, value.qualificationId)).toMatch(/\/qualifications\/[a-f0-9]{64}$/);
});
it.each(["pairDigest", "readerContractDigest", "readerReceiptDigest", "capabilityDigest", "codeAssetManifestDigest"])(
  "refuses a changed %s seal", field => {
    expect(() => parseQualificationReceipt({ ...receipt(), [field]: "f".repeat(64) }, pair)).toThrow();
  });
it.each(["witnessDigest", "contentViewDigest", "codePackOverlayDigest", "authorityDigest", "sealsDigest", "byteProofDigest", "namespaceProofDigest", "catalogProofDigest", "compositeProofDigest", "sourceCensusDigest", "headViewDigest", "selectedViewsDigest"])(
  "refuses missing %s evidence", field => {
    expect(() => parseQualificationReceipt({ ...receipt(), [field]: null }, pair)).toThrow();
  });
it.each(["foreign-root", "missing-baseline", "incomplete-count", "oversized-root", "bad-id", "public-grant", "incomplete-refs"])("refuses %s", mode => {
  const value = receipt();
  if (mode === "foreign-root") value.evidence.evidenceKey = value.evidence.evidenceKey.replace("roots/", "other/");
  if (mode === "missing-baseline") value.coverage = { baseline: 0, content: 12, overlay: 2, absence: 0 };
  if (mode === "incomplete-count") value.evidence.outputCount = 13;
  if (mode === "oversized-root") value.evidence.evidenceBytes = QUALIFICATION_EVIDENCE_ROOT_BYTES_LIMIT + 1;
  if (mode === "incomplete-refs") value.selectedViewCount = 15;
  if (mode === "bad-id") value.qualificationId = "../other-pair";
  expect(() => parseQualificationReceipt(mode === "public-grant" ? { ...value, grantsPublication: true } : value, pair)).toThrow();
});
it("accepts a bounded descriptor root beyond 256 KiB for a large qualification", () => {
  const value = receipt();
  value.coverage = { baseline: 100_000, content: 100_000, overlay: 0, absence: 0 };
  value.evidence.outputCount = 200_000;
  value.evidence.evidenceBytes = 3 * 1024 * 1024;
  expect(parseQualificationReceipt(value, pair).evidence.evidenceBytes).toBe(value.evidence.evidenceBytes);
});
