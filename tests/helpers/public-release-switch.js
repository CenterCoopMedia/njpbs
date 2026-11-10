import pairs from "../../functions/lib/public-release-pair.js";
import switches from "../../functions/lib/public-release-switch.js";
import work from "../../functions/lib/public-release-pair-work.js";
import baseline from "../../functions/lib/public-release-change-baseline.js";
import { publicReleaseBaselineCodeFixture } from "./public-release-baseline-code.ts";
import historicalCode from "../../functions/lib/public-release-historical-code.js";
import { releasePair, releaseSelector, pairReference } from "./private-public-release-pair.js";
import { sealedPair } from "./sealed-public-release-pair.ts";
import { readerSealPath } from "../../site/scripts/public-release-pair-private-reader.ts";
import { publicReleaseSwitchQualificationReadOwner } from "../../site/scripts/public-release-switch-qualification.ts";
const h = pairs.publicReleaseDigest;
export function capabilities(sha) {
  const reader = sealedPair(undefined, releasePair("a", sha));
  return structuredClone(switches.publicationControlsForReaderSeals(reader.seals, reader.pair));
}
export async function seedSwitch(db, { selector: given, old: givenOld, next: givenNext, operationId = "switch-two", oldCapabilities, nextCapabilities, admittedContract, extraMediaReferences = [] } = {}) {
  const old = givenOld ?? sealedPair().pair;
  const next = givenNext ?? sealedPair(undefined, releasePair("b", "b".repeat(40))).pair;
  const selector = given ?? { ...releaseSelector(), selectedPair: pairReference(old), recoveryPair: pairReference(next) };
  if (admittedContract) selector.admittedContractDigest = h(admittedContract);
  const logEpoch = `epoch-${h(operationId)}`;
  const cursor = given ? (await db.doc("system/publicReleaseChanges").get()).data()
    : { schemaVersion: 2, sequence: 0, baselineDigest: "1".repeat(64), lastDigest: "1".repeat(64) };
  await db.doc(switches.ROOT).set(selector);
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: old.commitSha,
    serializerId: "cloudflare-dev-publisher", cloud: { phase: "ready", commitSha: old.commitSha, serializerId: "cloudflare-dev-publisher" } });
  for (const [family, path] of Object.entries(switches.CAPABILITY_PATHS)) await db.doc(path).set({ ...(oldCapabilities ?? capabilities(old.commitSha))[family], generation: selector.activeGeneration });
  const states = { "system/publicDeployment/contexts/public": { schemaVersion: 1, revision: 12 },
    "system/publicReleaseChanges": cursor,
    "system/publicReleaseChangeLog": { schemaVersion: 2, enabled: true, pair: pairReference(old), logEpoch, head: cursor },
    "system/noBuildPostAdmission": { schemaVersion: 2, enabled: true, revision: 1, families: { posts: { mode: "all" } }, backgroundBucket: "njpbs-dev-public-background" },
    "system/publicDeployment/noBuildRecordFamilies/current": { schemaVersion: 1, families: ["programs", "events"] },
    [switches.MEDIA]: { schemaVersion: 2, epoch: selector.epoch, activeGeneration: selector.activeGeneration,
      lastReservedGeneration: selector.activeGeneration, newestEligibleGeneration: selector.activeGeneration,
      references: [...[old, next].map(pair => ({ pairId: pair.pairId, manifestDigest: "f".repeat(64) })), ...extraMediaReferences] },
    [switches.ADMISSIONS]: { schemaVersion: 2, sequence: 0, pendingCount: 0, pendingDigest: "0".repeat(64) },
    "system/billing": { disabled: false } };
  for (const [path, state] of Object.entries(states)) await db.doc(path).set(state);
  const code = publicReleaseBaselineCodeFixture(db, old.commitSha);
  await baseline.capturePublicReleaseChangeBaseline({ firestore: code.firestore, currentCodeRequest: code.request, logEpoch });
  const validators = Object.entries(states).map(([path, data]) => ({ path, digest: h(data) }));
  const qualifications = [old, next].map((pair, index) => ({ schemaVersion: 2, pairDigest: h(pair),
    contentHead: { pairId: pair.pairId, viewId: `view-${operationId.slice(0, 100)}`, manifestDigest: "e".repeat(64), contextSequence: cursor.sequence },
    cursor, validatorDigest: h(validators), capabilities: (index ? nextCapabilities : oldCapabilities) ?? capabilities(pair.commitSha), coverageDigest: "d".repeat(64),
    controlsDigest: h((index ? nextCapabilities : oldCapabilities) ?? capabilities(pair.commitSha)),
    acceptedWorkDigest: h(states[switches.ADMISSIONS]), admittedContractDigest: selector.admittedContractDigest,
    readerReceiptDigest: pair.readerReceiptDigest, providerReadbackDigest: "c".repeat(64) }));
  for (const [index, pair] of [old, next].entries()) {
    const base = work.publicReleasePairPath(pair.pairId);
    await db.doc(base).set(pair);
    await db.doc(readerSealPath(pair)).set(sealedPair(undefined, pair).seals);
    await db.doc(`${base}/controls/runtime`).set({ schemaVersion: 2, pairId: pair.pairId, status: index ? "candidate" : "retained" });
    await db.doc(`${base}/rollouts/publisher`).set({ schemaVersion: 2, pairId: pair.pairId, pairDigest: h(pair), state: "verified", readbackDigest: "c".repeat(64) });
    // Historical completed pack fixture; the code-publication tests exercise
    // real H capture and the actual retained publication bytes separately.
    const pack = { schemaVersion: 1, kind: "pair-code-pack-baseline", pairDigest: h(pair), commitSha: pair.commitSha,
      codeAssetManifestDigest: pair.codeAssetManifestDigest, codePackManifestDigest: "9".repeat(64) };
    await db.doc(`${base}/codePacks/baseline`).set(pack);
    const retained = historicalCode.prepareRetainedPublicReleaseCode(publicReleaseBaselineCodeFixture(db, pair.commitSha).qualified);
    for (const chunk of retained.chunks) await db.doc(`${historicalCode.CHUNKS}/${chunk.digest}`).set(chunk.value);
    await db.doc(`${base}/codePacks/publication`).set({ schemaVersion: 2, kind: "pair-code-publication", pairDigest: h(pair),
      baselineDigest: h(pack), codePackManifestDigest: pack.codePackManifestDigest, historicalCode: retained.descriptor,
      reference: { schemaVersion: 2, kind: "pair", side: pairReference(pair), commitSha: pair.commitSha,
        codeAssetManifestDigest: pair.codeAssetManifestDigest, publicationDigest: "8".repeat(64) } });
    await db.doc(`${base}/switchQualifications/${h(qualifications[index])}`).set(qualifications[index]);
  }
  const witness = { schemaVersion: 2, oldPairDigest: h(old), newPairDigest: h(next), oldQualificationDigest: h(qualifications[0]),
    newQualificationDigest: h(qualifications[1]), cursor, validators, admittedContractDigest: selector.admittedContractDigest,
    acceptedWorkDigest: h(states[switches.ADMISSIONS]) };
  const attempt = { schemaVersion: 2, operationId, expectedSelectorDigest: h(selector), oldPair: old, newPair: next, witnessDigest: h(witness) };
  await db.doc(`${switches.WITNESSES}/${h(witness)}`).set(witness);
  return { old, next, selector, witness, attempt, qualifications };
}
// Synthetic late guard models the required dependency; live adapters must use
// actual qualification's opaque prepared census and its transaction guard.
export const fixtureGuard = async () => {};
export const fixtureReadOwner = publicReleaseSwitchQualificationReadOwner;
