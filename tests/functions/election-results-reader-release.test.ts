import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { electionResultsError } from "../../packages/content-core/src/election-results";
import { blockContentError } from "../../packages/content-core/src/block-content-validation";
import { renderElectionResults } from "../../packages/content-core/src/election-results-render";
import { parseBlocks } from "../../packages/content-core/src/content-model";
import { privatePairReaderCapabilities } from "../../packages/content-core/src/private-pair-http.mjs";
import { parseReaderSeals, supportedReaderFeatures } from "../../site/scripts/public-release-pair-reader-contract";
import { parsePreviewRuntimeControl } from "../../site/scripts/cms-preview-cloud-control";
import { pair as previewPair } from "../helpers/cms-preview-pairs.js";
import { sealedPair } from "../helpers/sealed-public-release-pair";
import { electionBlock, electionRace } from "../fixtures/election-results";

const require = createRequire(import.meta.url);
const post = require("../../functions/lib/no-build-post-state.js");
const page = require("../../functions/lib/no-build-page-ownership.js");
const server = require("../../functions/lib/election-results.js");
const serverBlocks = require("../../functions/lib/content-blocks.js");
const projection = require("../../functions/lib/public-content-projection.js");
const approvals = require("../../functions/lib/election-results-approval.js");
const compatibility = require("../../functions/lib/election-results-compatibility.js");
const preview = require("../../functions/lib/cms-preview-pair-candidate.js");
const sha = "a".repeat(40);

describe("election reader bridge", () => {
  it.each([1, 2, 3, 0, "2", null])("validates Page/Post capabilities and candidates at version %s", version => {
    const common = { rendererSha: sha, electionResultsVersion: version };
    const capability = { ...common, servingEnabled: true, generation: 1 };
    const candidate = { ...common, enabled: true, authoritative: true };
    for (const [parse, value] of [
      [post.validateCapability, { ...capability, schemaVersion: 2 }],
      [page.validateNoBuildPageCapability, { ...capability, schemaVersion: 1 }],
      [post.candidateNoBuildContract, { ...candidate, schemaVersion: 2, families: ["posts"] }],
      [page.candidateNoBuildPageContract, { ...candidate, schemaVersion: 1 }],
    ]) {
      if (version === 1 || version === 2) expect(parse(value)).toEqual(value);
      else expect(() => parse(value)).toThrow();
    }
    const runtime = { schemaVersion: 1, phase: "ready", rendererSha: sha, serializerId: "cloud-preview-primary", electionResultsVersion: version };
    for (const parse of [parsePreviewRuntimeControl, preview.previewRuntimeIdentity]) {
      if (version === 1 || version === 2) expect(parse(runtime)).toEqual(runtime);
      else expect(() => parse(runtime)).toThrow();
    }
  });

  it.each([1, 2, 3, "2", null])("validates retained preview pair version %s", version => {
    const pair = previewPair("reader");
    pair.capabilities.electionResultsVersion = version as number;
    const parse = require("../../functions/lib/cms-preview-pair.js").parsePair;
    if (version === 1 || version === 2) expect(parse(pair)).toEqual(pair);
    else expect(() => parse(pair)).toThrow();
  });

  it.each([1, 2] as const)("reads exact private reader seals at version %s and advertises writer version 2", version => {
    const { pair, seals } = sealedPair();
    const capabilities = { ...seals.capabilities,
      post: { ...seals.capabilities.post, electionResultsVersion: version },
      page: { ...seals.capabilities.page, electionResultsVersion: version } };
    const parsed = parseReaderSeals({ ...seals, capabilities }, { ...pair, capabilityDigest: require("../../functions/lib/public-release-pair.js").publicReleaseDigest(capabilities) });
    expect(supportedReaderFeatures(parsed).has("electionResultsVersion:1")).toBe(true);
    expect(supportedReaderFeatures(parsed).has("electionResultsVersion:2")).toBe(version === 2);
    const emitted = privatePairReaderCapabilities(sha);
    expect(emitted.post.electionResultsVersion).toBe(2);
    expect(emitted.page.electionResultsVersion).toBe(2);
    const invalid = { ...capabilities, page: { ...capabilities.page, electionResultsVersion: 3 } };
    expect(() => parseReaderSeals({ ...seals, capabilities: invalid }, { ...pair,
      capabilityDigest: require("../../functions/lib/public-release-pair.js").publicReleaseDigest(invalid) })).toThrow();
  });

  it.each([0, 0.85, 1])("reads expected vote fraction %s through editorial approval and public capture", expectedVoteShare => {
    const block = electionBlock(electionRace({ expectedVoteShare }));
    expect(electionResultsError(block.data, true)).toBeNull();
    expect(server.electionResultsError(block.data, true)).toBeNull();
    expect(parseBlocks([block]).ok).toBe(true);
    expect(serverBlocks.parseBlocks([block]).ok).toBe(true);
    expect(projection.selectedBlock(block).data).toEqual(block.data);
    expect(approvals.approvedElectionBlocks({ blocks: [block] }, { preview: true })).toEqual([block]);
    for (const visible of [true, false]) {
      expect(blockContentError([{ ...block, visible }], { complete: false })).toBeNull();
    }
    const document = { blocks: [block], electionResultsApprovals: [] };
    document.electionResultsApprovals = approvals.approveElectionResults(document, { uid: "editor", displayName: "Editor" }, "2026-11-04T03:00:00Z");
    expect(approvals.approvedElectionBlocks(document)).toEqual([block]);
    expect(compatibility.candidateSupportsOwnedElectionResults({ visible: true }, { blocks: [block] }, { electionResultsVersion: 1 })).toBe(false);
    expect(compatibility.candidateSupportsOwnedElectionResults({ visible: true }, { blocks: [block] }, { electionResultsVersion: 2 })).toBe(true);
  });

  it.each([-0.01, 1.01, NaN, Infinity, null, "0.85", undefined])("refuses malformed expected vote fraction %s", value => {
    const block = electionBlock(electionRace({ expectedVoteShare: value as number }));
    expect(electionResultsError(block.data, true)).not.toBeNull();
    expect(serverBlocks.parseBlocks([block]).ok).toBe(false);
    expect(parseBlocks([block]).ok).toBe(false);
    expect(() => projection.selectedBlock(block)).toThrow();
    expect(compatibility.candidateSupportsOwnedElectionResults({ visible: true }, { blocks: [block] }, { electionResultsVersion: 2 })).toBe(false);
  });

  it.each([1, 2])("activates an accepted version %s candidate with its exact marker", version => {
    const candidate = { commitSha: sha, generation: 2 };
    for (const family of ["Page", "Post"]) {
      const writes: { path: string; value: Record<string, unknown> }[] = [];
      const transaction = { set: (ref: { path: string }, value: Record<string, unknown>) => writes.push({ path: ref.path, value }) };
      const firestore = { doc: (path: string) => ({ path }) };
      const contract = { schemaVersion: family === "Post" ? 2 : 1, rendererSha: sha, enabled: true, authoritative: true,
        electionResultsVersion: version, ...(family === "Post" ? { families: ["posts"] } : {}) };
      if (family === "Page") require("../../functions/lib/no-build-page-candidate.js").writeNoBuildPageCandidateActivation(transaction, firestore, { contract }, candidate);
      else require("../../functions/lib/no-build-post-publication.js").writeNoBuildCandidateActivation(transaction, firestore, { contract }, candidate);
      expect(writes).toHaveLength(1);
      expect(writes[0].value.electionResultsVersion).toBe(version);
      const validate = family === "Page" ? page.validateNoBuildPageCapability : post.validateCapability;
      expect(validate(writes[0].value).electionResultsVersion).toBe(version);
    }
  });

  it("keeps legacy output and labels, including unknown reporting", () => {
    const block = electionBlock();
    expect(electionResultsError(block.data, true)).toBeNull();
    expect(blockContentError([block])).toBeNull();
    const html = renderElectionResults(block.id, block.data);
    expect(html).toContain("75.5% reporting");
    expect(html).not.toContain("expected vote counted");
    expect(renderElectionResults(block.id, { races: [electionRace({ reportingShare: null })] })).toContain("Reporting share unavailable");
    expect(compatibility.candidateSupportsOwnedElectionResults({ visible: true }, { blocks: [block] }, { electionResultsVersion: 2 })).toBe(true);
    expect(compatibility.candidateSupportsOwnedElectionResults({ visible: true }, { blocks: [block] }, { electionResultsVersion: 3 })).toBe(false);
  });
});
