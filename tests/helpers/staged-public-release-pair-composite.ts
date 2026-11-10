import { createHash } from "node:crypto";
import type { publicReleasePairCompositeFixture } from "./public-release-pair-composite";
import work from "../../functions/lib/public-release-pair-work.js";
import protocol from "../../functions/lib/public-release-pair.js";
import view from "../../functions/lib/public-release-pair-view.js";
import codec from "../../functions/lib/public-release-pair-composite-view.js";
import { openPublicReleasePairCompositeAuthority, stagePublicReleasePairComposite } from "../../site/scripts/public-release-pair-composite-storage";
import { openFrozenPublicReleasePairCatalogImages } from "../../site/scripts/public-release-pair-catalog-image-storage";
import { writePublicReleasePairView } from "../../site/scripts/public-release-pair-view-storage";
import { projectPublicReleasePairReplay, isPublicReleasePairProjection } from "../../site/scripts/public-release-pair-replay";
import { writePublicReleasePairReplayProof } from "../../site/scripts/public-release-pair-replay-storage";
import { openPublicReleasePairSourceDocuments } from "../../site/scripts/public-release-pair-source-documents";
import { derivePublicReleasePairContentFeeds } from "../../site/scripts/public-release-pair-aggregate-outputs";
import { derivePublicReleasePairPublicReceipts } from "../../site/scripts/public-release-pair-public-receipts";
type Fixture = Awaited<ReturnType<typeof publicReleasePairCompositeFixture>>;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
/** Real H/G ownership, full closed roster, and actual local R2 readback. Route
 * and Pagefind bodies are fixtures; this helper never claims SSR byte proof. */
export async function stagedPublicReleasePairCompositeFixture(fixture: Fixture, store: Parameters<typeof writePublicReleasePairView>[0]["store"], settleOnly = false) {
  const { firestore, pair, taskId } = fixture;
  const claim = await work.claimPublicReleasePairWork({ firestore, pair, taskId });
  if (!claim) throw new Error("Composite fixture claim unavailable");
  const owner = { firestore, store, pair, identity: claim.identity, claimDigest: protocol.publicReleaseDigest(claim.token) };
  const source = await openPublicReleasePairCompositeAuthority(owner), catalog = await openFrozenPublicReleasePairCatalogImages(owner);
  const outputs: Array<{ path: string; status: number; headers: Record<string, string>; bytes: Uint8Array; role: string; kind: string }> = [];
  const targets = [];
  const add = (path: string, mime: string, bytes: Uint8Array, role: string, kind: string, status = 200, location?: string) => {
    outputs.push({ path, status, bytes, role, kind, headers: { "content-type": mime, "x-njpbs-renderer-sha": pair.commitSha,
      "cache-control": "no-store", ...(location ? { location } : {}), ...(mime.startsWith("text/html") && status === 200 ? { "x-njpbs-html-sha256": hash(bytes) } : {}) } });
  };
  for (let index = 0; index < source.plan.routes.length; index++) {
    const route = source.plan.routes[index], expected = source.plan.expectedOutputs[index];
    const body = expected.status === 200 ? new TextEncoder().encode(`<main>Frozen ${route.path}</main>`) : new Uint8Array();
    let location: string | undefined;
    if (isPublicReleasePairProjection(route.renderer)) {
      const projected = await projectPublicReleasePairReplay(await source.context(route));
      targets.push({ receipt: projected.receipt, bodyDigest: hash(body), status: expected.status });
      if (expected.status === 308) location = "/programs/one/";
    } else if (expected.status === 308) {
      const request = JSON.parse(new TextDecoder().decode(await source.frozen.readFile(route.inputFile)));
      location = request.read.location;
    }
    add(route.path, expected.contentType, body, "route", route.renderer, expected.status, location);
  }
  const { documents } = await openPublicReleasePairSourceDocuments(source.frozen.root, source.frozen.readFile);
  const files = derivePublicReleasePairContentFeeds(documents, new Date(source.plan.renderedAt),
    pair.environment === 'production' ? 'https://njpbs.org' : 'https://dev-public.example.org');
  files.push(...await derivePublicReleasePairPublicReceipts({ pair, documents, targets, ownedPaths: new Set(source.plan.routes.map(route => route.path)),
    baselinePublication: await source.baseline.readMember("/_publication.json"), baselineStatus: await source.baseline.readMember("/_content-status.json") }));
  for (const file of files) add(file.path, file.mime, file.bytes, file.path.startsWith("/api/v1/content/") ? "content-feed" : "auxiliary",
    file.path.startsWith("/api/v1/content/") ? "content-feed-page" : codec.publicReleasePairCompositeAuxiliaryKind(file.path)!);
  for (const member of source.baseline.manifest.members) {
    if (!member.dynamic || member.path.startsWith("/pagefind/") || member.path.startsWith("/api/v1/content/") || outputs.some(row => row.path === member.path)) continue;
    const kind = codec.publicReleasePairCompositeAuxiliaryKind(member.path);
    if (!kind) throw new Error(`Unexplained fixture auxiliary ${member.path}`);
    add(member.path, member.mime, await source.baseline.readMember(member.path), "auxiliary", kind);
  }
  add("/pagefind/pagefind-entry.json", "application/json; charset=utf-8", encode({ version: "fixture" }), "search", "pagefind");
  add("/pagefind/pagefind.js", "application/javascript; charset=utf-8", new TextEncoder().encode("export{}"), "search", "pagefind");
  for (const member of catalog.manifest.members) add(member.path, member.mime, await catalog.readMember(member.path), "catalog", "catalog-image");
  outputs.sort((a, b) => view.comparePrivatePairArtifactPaths(a.path, b.path));
  const manifest = codec.parsePublicReleasePairCompositeManifest({ schemaVersion: 1, kind: "pair-composite-manifest", pairDigest: protocol.publicReleaseDigest(pair),
    inputManifestDigest: claim.identity.inputManifestDigest, cursor: source.frozen.root.cursor, authority: source.authority,
    members: outputs.map(row => ({ path: row.path, role: row.role, kind: row.kind, status: row.status, mime: row.headers["content-type"], size: row.bytes.length,
      sha256: hash(row.bytes), sourceDependencyDigest: source.authority.sourceDependencyDigest })) }, pair, claim.identity);
  async function* rows() { yield* outputs; }
  const rendered = await writePublicReleasePairView({ ...owner, cursor: source.frozen.root.cursor, outputs: rows(), deriveNamespaces: true,
    catalogImages: catalog.manifest, compositeManifest: manifest });
  async function* receipts() { yield* targets; }
  await writePublicReleasePairReplayProof({ ...owner, viewManifestDigest: rendered.manifestDigest, targets: receipts() });
  await work.settlePublicReleasePairWork({ firestore, pair, taskId, token: claim.token, manifestDigest: rendered.manifestDigest });
  const bound = { ...owner, viewManifestDigest: rendered.manifestDigest };
  if (!settleOnly) await stagePublicReleasePairComposite(bound);
  return { owner: bound, outputs, rendered, targets, claim };
}
