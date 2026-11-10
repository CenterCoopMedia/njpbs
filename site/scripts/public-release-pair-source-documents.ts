import type { PairInputRoot } from "../../functions/lib/public-release-pair-input";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
function refuse(): never { throw new work.PairExecutionError("input-unavailable"); }
const exact = (value: any, keys: string[]) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys.sort().join()) refuse();
};
/** The current roster selects one document from each retained raw body. Never
 * apply all documents in a bundled body: another member may have changed later.
 * H's file digest and the source owner's canonical contentDigest are distinct. */
export async function openPublicReleasePairSourceDocuments(root: PairInputRoot, read: (name: string) => Promise<Uint8Array>) {
  const json = async (name: string) => { try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await read(name))); } catch { return refuse(); } };
  const census = await json("source-census.json");
  exact(census, ["schemaVersion", "kind", "baseline", "cursor", "documents", "changes"]);
  exact(census.baseline, ["logBaselineDigest", "receipt", "sourceMembers"]);
  if (census.schemaVersion !== 1 || census.kind !== "pair-public-source-census" ||
      protocol.publicReleaseDigest(census.cursor) !== protocol.publicReleaseDigest(root.cursor) ||
      census.baseline.logBaselineDigest !== protocol.publicReleaseDigest(census.baseline.receipt) ||
      !Array.isArray(census.documents) || !census.documents.length || census.documents.length > 20_000 || !Array.isArray(census.changes)) refuse();
  const documents = new Map<string, any>(), bodies = new Map<string, any>(); let previous = "", total = 0;
  for (const member of census.documents) {
    exact(member, ["path", "contentDigest", "bodyFile"]);
    if (typeof member.path !== "string" || member.path <= previous || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.:-]+)+$/.test(member.path) ||
        member.path.split("/").length % 2 || !/^[a-f0-9]{64}$/.test(member.contentDigest) || member.bodyFile !== `sources/${member.contentDigest}.json`) refuse();
    previous = member.path;
    let body = bodies.get(member.contentDigest);
    if (!body) {
      body = await json(member.bodyFile);
      total += Buffer.byteLength(JSON.stringify(body)); if (total > 256 * 1024 * 1024) refuse();
      exact(body, ["schemaVersion", "kind", "id", "action", "sourceVersion", "snapshot", "documents"]);
      if (body.schemaVersion !== 2 || !Array.isArray(body.documents) || body.documents.length > 100 || protocol.publicReleaseDigest(body) !== member.contentDigest) refuse();
      const paths = new Set();
      for (const document of body.documents) { exact(document, ["path", "data"]); if (paths.has(document.path)) refuse(); paths.add(document.path); }
      bodies.set(member.contentDigest, body);
    }
    const record = body.documents.find((document: any) => document.path === member.path);
    if (!record?.data || typeof record.data !== "object" || Array.isArray(record.data)) refuse();
    documents.set(member.path, record.data);
  }
  return { census, documents };
}
