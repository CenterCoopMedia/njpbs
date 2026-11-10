import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { derivePublicReleasePairSearchInputs, parsePublicReleasePairSearchInputs } from "../../site/scripts/public-release-pair-search-inputs";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const qualifiedCode = { reference: { publication: { commitSha: "a".repeat(40) } }, publication: { commitSha: "a".repeat(40) } };
  const state = { logBaselineDigest: "b".repeat(64), cursor: { baselineDigest: "c".repeat(64), sequence: 1, lastDigest: "d".repeat(64) },
    event: { entry: { entryDigest: "d".repeat(64) } }, renderedAt: "2026-10-28T07:00:00.000Z",
    sourceMembers: new Map([["cmsPosts/b", "e".repeat(64)], ["cmsPosts/a", "f".repeat(64)]]) } as any;
  const provider = { externalInputs: { operationId: "provider-one" }, retainedHome: { contentDigest: "a".repeat(64) },
    files: [{ name: "schedule-packet/pdf", digest: "b".repeat(64), bytes: 64, contentType: "application/pdf", key: "private/object", chunkFiles: [] }] };
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const dependencies = { qualifiedCode, files: new Map([
    ["code-source.json", encode({ reference: qualifiedCode.reference, sha256: hash(JSON.stringify(qualifiedCode)) })],
    ["provider-inputs.json", encode(provider)],
  ]) } as any;
  return { state, dependencies, provider, encode };
}
it("seals the full sorted source, CODE, provider file and render-time boundary v1", () => {
  const { state, dependencies } = fixture(), result = derivePublicReleasePairSearchInputs(state, dependencies);
  expect(result.projection.documents.map(row => row.path)).toEqual(["cmsPosts/a", "cmsPosts/b"]);
  expect(parsePublicReleasePairSearchInputs(result, { ...state, entryDigest: state.event.entry.entryDigest })).toEqual(result);
  for (const change of [
    (s: any, _d: any) => s.sourceMembers.set("cmsPosts/a", "a".repeat(64)),
    (s: any, _d: any) => s.sourceMembers.delete("cmsPosts/b"),
    (s: any, _d: any) => s.renderedAt = "2026-10-28T07:00:01.000Z",
    (_s: any, d: any) => { const value = JSON.parse(new TextDecoder().decode(d.files.get("provider-inputs.json"))); value.files[0].digest = "c".repeat(64);
      d.files.set("provider-inputs.json", new TextEncoder().encode(JSON.stringify(value))); },
    (_s: any, d: any) => { d.qualifiedCode.reference.publication.commitSha = "e".repeat(40);
      d.files.set("code-source.json", new TextEncoder().encode(JSON.stringify({ reference: d.qualifiedCode.reference, sha256: hash(JSON.stringify(d.qualifiedCode)) }))); },
  ]) {
    const fresh = fixture(); change(fresh.state, fresh.dependencies);
    expect(derivePublicReleasePairSearchInputs(fresh.state, fresh.dependencies).searchInputDigest).not.toBe(result.searchInputDigest);
  }
  // The transport key/chunk placement does not relabel the retained content.
  const fresh = fixture(); fresh.provider.files[0].key = "private/another";
  fresh.dependencies.files.set("provider-inputs.json", fresh.encode(fresh.provider));
  expect(derivePublicReleasePairSearchInputs(fresh.state, fresh.dependencies).searchInputDigest).toBe(result.searchInputDigest);
});
it("refuses missing qualified CODE and tampered evidence or entry identity", () => {
  const { state, dependencies } = fixture(), result = derivePublicReleasePairSearchInputs(state, dependencies);
  expect(() => parsePublicReleasePairSearchInputs({ ...result, searchInputDigest: "0".repeat(64) }, { ...state, entryDigest: result.entryDigest })).toThrow("search-input-evidence-mismatch");
  expect(() => parsePublicReleasePairSearchInputs(result, { ...state, entryDigest: "0".repeat(64) })).toThrow("search-input-evidence-mismatch");
  dependencies.files.delete("code-source.json");
  expect(() => derivePublicReleasePairSearchInputs(state, dependencies)).toThrow("search-input-code-missing");
});
