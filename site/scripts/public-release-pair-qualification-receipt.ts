import type { QualificationSourceAudit } from "./public-release-pair-qualification-source";
import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import { exact } from "./public-release-pair-reader-contract";
import { qualificationEvidencePrefix, QUALIFICATION_EVIDENCE_ROOT_BYTES_LIMIT } from "./public-release-pair-qualification-evidence";
import { PairQualificationError } from "./public-release-pair-qualification-authority";
export type QualificationReceipt = Readonly<{ schemaVersion: 2; kind: "private-pair-qualification"; qualificationId: string;
  pairDigest: string; readerContractDigest: string; readerReceiptDigest: string; capabilityDigest: string; codeAssetManifestDigest: string;
  witnessDigest: string; contentViewDigest: string; codePackOverlayDigest: string; authorityDigest: string; sealsDigest: string;
  byteProofDigest: string; namespaceProofDigest: string; catalogProofDigest: string; compositeProofDigest: string; sourceCensusDigest: string; headViewDigest: string; sourceValidation: QualificationSourceAudit; selectedViewsDigest: string; selectedViewCount: number;
  qualifiedAt: number; coverage: Readonly<{ baseline: number; content: number; overlay: number; absence: number }>;
  evidence: Readonly<{ evidenceDigest: string; evidenceKey: string; evidenceBytes: number; outputCount: number; outputBytes: number }> }>;
function refuse(): never { throw new PairQualificationError("stale-qualification"); }
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function qualificationReceiptPath(pair: PublicReleasePair, qualificationId: string) {
  work.assertPrivatePairResources(pair);
  qualificationEvidencePrefix(pair, qualificationId);
  return `${work.publicReleasePairPath(pair.pairId)}/qualifications/${protocol.publicReleaseDigest({ qualificationId })}`;
}
/** Strict receipt parsing grants nothing. Its writer is the complete verifier;
 * no standalone API accepts caller-supplied success or mutable latest aliases. */
export function parseQualificationReceipt(raw: unknown, pair: PublicReleasePair): QualificationReceipt {
  pair = protocol.parsePublicReleasePair(pair);
  const immutable = ["pairDigest", "readerContractDigest", "readerReceiptDigest", "capabilityDigest", "codeAssetManifestDigest"] as const;
  const proofFields = ["witnessDigest", "contentViewDigest", "codePackOverlayDigest", "authorityDigest", "sealsDigest", "byteProofDigest", "namespaceProofDigest", "catalogProofDigest", "compositeProofDigest", "sourceCensusDigest", "headViewDigest", "selectedViewsDigest"] as const;
  const value = exact(raw, ["schemaVersion", "kind", "qualificationId", ...immutable, ...proofFields, "qualifiedAt", "selectedViewCount", "coverage", "evidence", "sourceValidation"]);
  if (value.schemaVersion !== 2 || value.kind !== "private-pair-qualification" || typeof value.qualificationId !== "string" ||
      immutable.some(field => value[field] !== (field === "pairDigest" ? protocol.publicReleaseDigest(pair) : pair[field])) ||
      proofFields.some(field => !digest(value[field])) || !Number.isSafeInteger(value.qualifiedAt) || (value.qualifiedAt as number) < 1) refuse();
  const prefix = qualificationEvidencePrefix(pair, value.qualificationId);
  const evidence = exact(value.evidence, ["evidenceDigest", "evidenceKey", "evidenceBytes", "outputCount", "outputBytes"]);
  const coverage = exact(value.coverage, ["baseline", "content", "overlay", "absence"]);
  const sourceValidation = exact(value.sourceValidation, ["mode", "outsideReadCount", "validatorCount", "transactionReadCount"]);
  if (!["full", "split"].includes(sourceValidation.mode as string) ||
      [sourceValidation.outsideReadCount, sourceValidation.validatorCount, sourceValidation.transactionReadCount]
        .some(count => !Number.isSafeInteger(count) || (count as number) < 1) ||
      (sourceValidation.outsideReadCount as number) > 20_000 || (sourceValidation.validatorCount as number) > 10_000 ||
      (sourceValidation.transactionReadCount as number) > 500) refuse();
  if (!digest(evidence.evidenceDigest) || evidence.evidenceKey !== `${prefix}roots/${evidence.evidenceDigest}.json` ||
      !Number.isSafeInteger(evidence.evidenceBytes) || (evidence.evidenceBytes as number) < 1 || (evidence.evidenceBytes as number) > QUALIFICATION_EVIDENCE_ROOT_BYTES_LIMIT ||
      !Number.isSafeInteger(evidence.outputCount) || (evidence.outputCount as number) < 1 || (evidence.outputCount as number) > 200_000 ||
      !Number.isSafeInteger(evidence.outputBytes) || (evidence.outputBytes as number) < 0 || (evidence.outputBytes as number) > 200 * 1024 ** 3 ||
      Object.values(coverage).some(count => !Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > 100_000) ||
      !Number.isSafeInteger(value.selectedViewCount) || (value.selectedViewCount as number) < 1 ||
      (value.selectedViewCount as number) > (evidence.outputCount as number) ||
      (coverage.baseline as number) < 1 || Object.values(coverage).reduce<number>((sum, count) => sum + (count as number), 0) !== evidence.outputCount) refuse();
  return Object.freeze({ ...value, evidence: Object.freeze({ ...evidence }), coverage: Object.freeze({ ...coverage }), sourceValidation: Object.freeze({ ...sourceValidation }) }) as QualificationReceipt;
}
export async function readQualificationReceiptInTransaction({ firestore, transaction, pair, qualificationId }: {
  firestore: Firestore; transaction: Transaction; pair: PublicReleasePair; qualificationId: string;
}) {
  const row = await transaction.get(firestore.doc(qualificationReceiptPath(pair, qualificationId)));
  if (!row.exists) return null;
  const receipt = parseQualificationReceipt(row.data(), pair);
  if (receipt.qualificationId !== qualificationId) refuse();
  return Object.freeze({ receipt, digest: protocol.publicReleaseDigest(receipt) });
}
