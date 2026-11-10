import { createHash } from "node:crypto";
import type { PairCodePack } from "./public-release-pair-code-pack";
export const PAIR_SEARCH_NAMESPACE = "/pagefind/";
export const PAIR_SEARCH_AUTHORITY_FILE = "pair-search-namespace.json";
export const PAIR_SEARCH_AUTHORITY_PACK_PATH = "/_pair-compiled/pair-search-namespace.json";
export const PAIR_SEARCH_REQUIRED_ENTRIES = ["/pagefind/pagefind-entry.json", "/pagefind/pagefind.js"] as const;
export type PairSearchNamespaceAuthority = Readonly<{ schemaVersion: 1; kind: "pair-search-namespace-authority";
  namespace: "/pagefind/"; family: "searchIndex"; commitSha: string; requiredEntries: readonly string[] }>;
export class PairSearchAuthorityError extends Error {
  constructor(readonly code: "search-namespace-authority-missing" | "search-namespace-authority-mismatch" | "search-namespace-incomplete") {
    super(code); this.name = "PairSearchAuthorityError";
  }
}
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export function publicReleasePairSearchAuthorityBytes(commitSha: string) {
  if (!/^[a-f0-9]{40}$/.test(commitSha)) throw new PairSearchAuthorityError("search-namespace-authority-mismatch");
  return new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, kind: "pair-search-namespace-authority", namespace: PAIR_SEARCH_NAMESPACE,
    family: "searchIndex", commitSha, requiredEntries: [...PAIR_SEARCH_REQUIRED_ENTRIES] }) + "\n");
}
/** Authority comes from a private compiled graph member sealed into the pair's
 * code-asset digest. A root metadata flag or caller namespace is insufficient. */
export function assertPublicReleasePairSearchAuthority(manifest: PairCodePack, expected: { commitSha: string; codeAssetManifestDigest?: string }): PairSearchNamespaceAuthority {
  const bytes = publicReleasePairSearchAuthorityBytes(expected.commitSha);
  const member = manifest.members.find(member => member.path === PAIR_SEARCH_AUTHORITY_PACK_PATH);
  if (!member) throw new PairSearchAuthorityError("search-namespace-authority-missing");
  if (manifest.commitSha !== expected.commitSha || expected.codeAssetManifestDigest !== undefined && manifest.codeAssetManifestDigest !== expected.codeAssetManifestDigest ||
      member.family !== "compiledGraph" || member.source !== "compiled" || member.dynamic || member.size !== bytes.length || member.sha256 !== hash(bytes))
    throw new PairSearchAuthorityError("search-namespace-authority-mismatch");
  // Preserve the baseline member seal's explicit canonical key order.
  const sealed = [...manifest.members].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))).map(member => ({
    path: member.path, mime: member.mime, size: member.size, sha256: member.sha256, family: member.family, source: member.source, dynamic: member.dynamic }));
  if (hash(JSON.stringify(sealed)) !== manifest.codeAssetManifestDigest) throw new PairSearchAuthorityError("search-namespace-authority-mismatch");
  const selected = manifest.members.filter(member => member.path.startsWith(PAIR_SEARCH_NAMESPACE));
  if (selected.some(member => member.family !== "searchIndex" || member.source !== "aggregate" || !member.dynamic) ||
      PAIR_SEARCH_REQUIRED_ENTRIES.some(path => !selected.some(member => member.path === path))) throw new PairSearchAuthorityError("search-namespace-incomplete");
  return Object.freeze({ schemaVersion: 1, kind: "pair-search-namespace-authority", namespace: PAIR_SEARCH_NAMESPACE,
    family: "searchIndex", commitSha: expected.commitSha, requiredEntries: Object.freeze([...PAIR_SEARCH_REQUIRED_ENTRIES]) });
}
