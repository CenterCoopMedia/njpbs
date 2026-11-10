import { createHash } from "node:crypto";
import type { HistoricalPublicReleaseState } from "../../functions/lib/public-release-historical-state";
import protocol from "../../functions/lib/public-release-pair.js";
import { freezePublicReleaseSourceDependencies } from "./public-release-pair-frozen-sources";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const canonical = (value: unknown): string => require("../../functions/lib/public-release-source-body.js").publicReleaseSnapshotJson(value, Infinity);
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const PAIR_SEARCH_INPUTS_FILE = "search-inputs.json";
export class PairSearchInputsError extends Error {
  constructor(readonly code: "search-input-code-missing" | "search-input-evidence-mismatch") { super(code); this.name = "PairSearchInputsError"; }
}
/** Boundary v1 intentionally includes every public input and exact render time.
 * Every entry therefore needs a fresh namespace until a narrower boundary is
 * justified by adapter tests. This digest contains no target-pair identity. */
export function derivePublicReleasePairSearchInputs(state: HistoricalPublicReleaseState,
  dependencies: Awaited<ReturnType<typeof freezePublicReleaseSourceDependencies>>) {
  const codeBytes = dependencies.files.get("code-source.json");
  if (!codeBytes || !dependencies.qualifiedCode) throw new PairSearchInputsError("search-input-code-missing");
  const code = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(codeBytes));
  if (code.sha256 !== hash(JSON.stringify(dependencies.qualifiedCode)) ||
      protocol.publicReleaseDigest(code.reference) !== protocol.publicReleaseDigest(dependencies.qualifiedCode.reference))
    throw new PairSearchInputsError("search-input-evidence-mismatch");
  const providerBytes = dependencies.files.get("provider-inputs.json");
  const provider = providerBytes ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(providerBytes)) : null;
  const projection = { schemaVersion: 1, documents: [...state.sourceMembers].sort(([a], [b]) => a < b ? -1 : 1)
    .map(([path, contentDigest]) => ({ path, contentDigest })), codeSource: { sha256: code.sha256, reference: code.reference },
    providerInputs: { externalInputs: provider?.externalInputs ?? null, retainedHome: provider?.retainedHome ?? null,
      files: (provider?.files ?? []).map(({ name, digest, bytes, contentType }: { name: string; digest: string; bytes: number; contentType: string }) =>
        ({ name, digest, bytes, contentType })).sort((a: { name: string }, b: { name: string }) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) },
    renderedAt: state.renderedAt };
  return { schemaVersion: 1, kind: "pair-search-inputs", logBaselineDigest: state.logBaselineDigest, cursor: state.cursor,
    entryDigest: state.event?.entry.entryDigest ?? null, searchInputDigest: hash(canonical(projection)), projection };
}
export type PairSearchInputs = ReturnType<typeof derivePublicReleasePairSearchInputs>;
/** Reopen evidence from H without mutable source or CODE. The root seals the
 * complete projection; its digest is shared by every target pair at this entry. */
export function parsePublicReleasePairSearchInputs(value: unknown, expected: {
  cursor: HistoricalPublicReleaseState["cursor"]; logBaselineDigest: string; entryDigest: string | null;
}): PairSearchInputs {
  try {
    require("../../functions/lib/public-release-pair.js").exact(value, ["schemaVersion", "kind", "logBaselineDigest", "cursor", "entryDigest", "searchInputDigest", "projection"]);
    const evidence = value as PairSearchInputs;
    require("../../functions/lib/public-release-pair.js").exact(evidence.projection, ["schemaVersion", "documents", "codeSource", "providerInputs", "renderedAt"]);
    if (evidence.schemaVersion !== 1 || evidence.kind !== "pair-search-inputs" || evidence.projection.schemaVersion !== 1 ||
        evidence.logBaselineDigest !== expected.logBaselineDigest || evidence.entryDigest !== expected.entryDigest ||
        protocol.publicReleaseDigest(evidence.cursor) !== protocol.publicReleaseDigest(expected.cursor) ||
        evidence.searchInputDigest !== hash(canonical(evidence.projection))) throw new Error();
    return evidence;
  } catch { throw new PairSearchInputsError("search-input-evidence-mismatch"); }
}
/** Small create-only descriptor on the accepted entry's evidence, linked to H
 * by its input receipt/outbox. The full census projection stays in bounded H. */
export function publicReleasePairSearchInputDescriptor(value: PairSearchInputs) {
  return { schemaVersion: 1, logBaselineDigest: value.logBaselineDigest, cursor: value.cursor, entryDigest: value.entryDigest,
    searchInputDigest: value.searchInputDigest, renderedAt: value.projection.renderedAt };
}
