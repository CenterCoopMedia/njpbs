import { releasePair as basePair, releaseSelector as baseSelector, pairReference as baseReference } from "./public-release-pair.js";
export function pairReference(pair = releasePair()) { return baseReference(pair); }

export function releasePair(slot = "a", commitSha = "a".repeat(40)) {
  const pair = basePair(slot, commitSha);
  const incarnation = pair.publicWorker.incarnation;
  const service = `njpbs-pair-slot-${incarnation}`;
  return { ...pair, pairId: `${service}:${incarnation}`,
    publisher: { ...pair.publisher, application: `njpbs-pair-publisher-${incarnation}`, journalNamespace: `pair-${incarnation}` },
    publicWorker: { ...pair.publicWorker, service } };
}
export function releaseSelector() {
  const value = baseSelector(), selectedPair = pairReference(), recoveryPair = pairReference(releasePair("b", "b".repeat(40)));
  return { ...value, selectedPair, recoveryPair, contentHead: { ...value.contentHead, pairId: selectedPair.pairId } };
}
