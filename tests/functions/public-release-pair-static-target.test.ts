import { expect, it } from "vitest";
import { releasePair, pairReference } from "../helpers/private-public-release-pair";
import protocol from "../../functions/lib/public-release-pair.js";
import views from "../../functions/lib/public-release-pair-view.js";
import composite from "../../functions/lib/public-release-pair-composite-view.js";
import target from "../../functions/lib/public-release-pair-static-target.js";
const pair = releasePair(), claim = "a".repeat(64), manifestDigest = "b".repeat(64), targetDigest = "c".repeat(64), readback = "d".repeat(64);
const identity = { schemaVersion: 2 as const, pair: pairReference(pair), kind: "qualification" as const, sourceOperationId: "static-one",
  sourceVersion: 7, snapshotDigest: "e".repeat(64), inputManifestDigest: "f".repeat(64), contextSequence: 1 };
const descriptor = { digest: targetDigest, key: views.publicReleasePairViewObjectKey(pair, identity, claim, targetDigest), bytes: 10 };
const proof = { schemaVersion: 1, kind: "pair-static-target-proof", status: "staged", pairDigest: protocol.publicReleaseDigest(pair),
  taskId: protocol.publicReleaseDigest(identity), identity, claimDigest: claim, viewManifestDigest: manifestDigest, viewReadbackDigest: readback,
  inputManifestDigest: identity.inputManifestDigest, descriptor, sourcePublicationDigest: "1".repeat(64), sourceStatusDigest: "2".repeat(64),
  targetPublicationDigest: "3".repeat(64), targetStatusDigest: "4".repeat(64) };
it("binds both original and NEW static receipt hashes to the original completed view and claim", () => {
  expect(target.parsePublicReleasePairStaticTargetProof(proof, pair, identity, claim, manifestDigest, targetDigest, readback)).toEqual(proof);
});
it.each(["claim", "view", "target", "readback", "input"])("refuses a different %s owner when opening a static target proof", mode => {
  expect(() => target.parsePublicReleasePairStaticTargetProof(proof, pair,
    mode === "input" ? { ...identity, inputManifestDigest: "0".repeat(64) } : identity,
    mode === "claim" ? "0".repeat(64) : claim, mode === "view" ? "0".repeat(64) : manifestDigest,
    mode === "target" ? "0".repeat(64) : targetDigest, mode === "readback" ? "0".repeat(64) : readback)).toThrow();
});
it("preserves the seven-field dynamic authority and admits only an explicit valid static target digest", () => {
  const authority = { baselineInputManifestDigest: "1".repeat(64), baselineCodePackManifestDigest: "2".repeat(64), baselineViewManifestDigest: "3".repeat(64),
    codeAssetManifestDigest: pair.codeAssetManifestDigest, sourceDependencyDigest: "4".repeat(64), sourceCensusDigest: "5".repeat(64), searchInputDigest: "6".repeat(64) };
  const manifest = { schemaVersion: 1, kind: "pair-composite-manifest", pairDigest: protocol.publicReleaseDigest(pair), inputManifestDigest: identity.inputManifestDigest,
    cursor: { baselineDigest: "7".repeat(64), sequence: 1, lastDigest: "8".repeat(64) }, authority,
    members: [{ path: "/_publication.json", role: "auxiliary", kind: "publication", status: 200, mime: "application/json; charset=utf-8", size: 1,
      sha256: "9".repeat(64), sourceDependencyDigest: authority.sourceDependencyDigest }] };
  const legacy = composite.parsePublicReleasePairCompositeManifest(manifest, pair, identity);
  expect(Object.keys(legacy.authority)).toEqual(["baselineInputManifestDigest", "baselineCodePackManifestDigest", "baselineViewManifestDigest", "codeAssetManifestDigest",
    "sourceDependencyDigest", "sourceCensusDigest", "searchInputDigest"]);
  expect(legacy.authority).toEqual(authority);
  expect(composite.parsePublicReleasePairCompositeManifest({ ...manifest, authority: { ...authority, staticTargetDigest: targetDigest } }, pair, identity).authority.staticTargetDigest).toBe(targetDigest);
  expect(() => composite.parsePublicReleasePairCompositeManifest({ ...manifest, authority: { ...authority, staticTargetDigest: undefined } }, pair, identity)).toThrow();
});
