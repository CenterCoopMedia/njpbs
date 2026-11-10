import { createHash } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import protocol from "../../functions/lib/public-release-pair.js";
import input from "../../functions/lib/public-release-pair-input.js";
import work from "../../functions/lib/public-release-pair-work.js";
import { releasePair } from "./private-public-release-pair.js";
import { persistPublicReleasePairCodePackBaseline } from "../../site/scripts/public-release-pair-code-pack-storage";
import {
  executePublicReleasePairCodePack,
  stagePublicReleasePairCodePack,
} from "../../site/scripts/public-release-pair-code-pack-executor";
import {
  publicReleasePairCodePackChunkCount,
  publicReleasePairCodePackChunkName,
  encodePublicReleasePairCodePackChunk,
  PAIR_CODE_PACK_CHUNK_BYTES,
} from "../../site/scripts/public-release-pair-code-pack";
import {
  openPublicReleasePairInput,
  capturePublicReleasePairInput,
} from "../../site/scripts/public-release-pair-input-storage";
import { writePublicReleasePairView, type PairViewStore } from "../../site/scripts/public-release-pair-view-storage";
import { stagePublicReleasePairView } from "../../site/scripts/public-release-pair-view-staging";
import { publicReleasePairSearchAuthorityBytes } from "../../site/scripts/public-release-pair-search-authority";
import { publicReleasePairContentFeedAuthorityBytes } from "../../site/scripts/public-release-pair-content-feed-authority";

const sha = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");
// Independent protocol census, with one member of each mandatory family and
// both required Schedule outputs. This is fixture data, not a build result.
type SourceInputs = {
  schemaVersion: 1;
  logBaselineDigest: string;
  sourceMemberCensusDigest: string;
  baselineCursor: { baselineDigest: string; sequence: number; lastDigest: string };
};
export function replayCodePackFixture(sourceInputs?: SourceInputs, emptyFeed = false) {
  const allRows = [
    ["/_pair-compiled/pair-source-inputs.json", "application/json; charset=utf-8", "compiledGraph", "compiled", false],
    [
      "/_pair-compiled/pair-search-namespace.json",
      "application/json; charset=utf-8",
      "compiledGraph",
      "compiled",
      false,
    ],
    [
      "/_pair-compiled/pair-content-feed-namespace.json",
      "application/json; charset=utf-8",
      "compiledGraph",
      "compiled",
      false,
    ],
    ["/_pair-compiled/server/entry.mjs", "application/javascript; charset=utf-8", "compiledGraph", "compiled", false],
    ["/_astro/site.js", "application/javascript; charset=utf-8", "clientAsset", "compiled", false],
    ["/robots.txt", "text/plain; charset=utf-8", "static", "static", false],
    ["/index.html", "text/html; charset=utf-8", "fallbackAsset", "static", false],
    ["/pagefind/pagefind.js", "application/javascript; charset=utf-8", "searchIndex", "aggregate", true],
    ["/pagefind/pagefind-entry.json", "application/json; charset=utf-8", "searchIndex", "aggregate", true],
    ["/search/index.json", "application/json; charset=utf-8", "search", "aggregate", true],
    ["/api/v1/content.json", "application/json; charset=utf-8", "feed", "aggregate", true],
    ["/api/v1/content/1.json", "application/json; charset=utf-8", "contentFeedPages", "aggregate", true],
    ["/feeds/news.xml", "application/xml; charset=utf-8", "feed", "aggregate", true],
    ["/wiki/index.html", "text/html; charset=utf-8", "wiki", "aggregate", false],
    ["/schedule/downloads/nj-pbs-schedule.pdf", "application/pdf", "schedule", "aggregate", true],
    ["/_schedule-sources.json", "application/json; charset=utf-8", "schedule", "aggregate", true],
    ["/sitemap.xml", "application/xml; charset=utf-8", "sitemap", "aggregate", true],
    ["/rss.xml", "application/xml; charset=utf-8", "feed", "aggregate", true],
    ["/_home-sources.json", "application/json; charset=utf-8", "aggregate", "aggregate", true],
  ] as const;
  const rows = emptyFeed ? allRows.filter(([path]) => !path.startsWith("/api/v1/content/")) : allRows;
  const bodies = new Map(
    rows.map(([path]) => [path as string, new TextEncoder().encode(`Frozen fixture bytes for ${path}`)]),
  );
  bodies.set(
    "/_pair-compiled/pair-source-inputs.json",
    new TextEncoder().encode(
      JSON.stringify(
        sourceInputs ?? {
          schemaVersion: 1,
          logBaselineDigest: "c".repeat(64),
          sourceMemberCensusDigest: "d".repeat(64),
          baselineCursor: { baselineDigest: "b".repeat(64), sequence: 0, lastDigest: "b".repeat(64) },
        },
      ) + "\n",
    ),
  );
  bodies.set("/pagefind/pagefind-entry.json", new TextEncoder().encode("{}"));
  bodies.set("/_pair-compiled/pair-search-namespace.json", publicReleasePairSearchAuthorityBytes("b".repeat(40)));
  bodies.set(
    "/_pair-compiled/pair-content-feed-namespace.json",
    publicReleasePairContentFeedAuthorityBytes("b".repeat(40)),
  );
  const homeUrl = "https://www.njpbs.org/",
    feedUrl = homeUrl + "api/v1/content.json",
    pageUrl = homeUrl + "api/v1/content/1.json";
  bodies.set(
    "/api/v1/content.json",
    new TextEncoder().encode(
      JSON.stringify({
        apiVersion: 1,
        title: "NJ PBS released content",
        homeUrl,
        feedUrl,
        rssUrl: homeUrl + "feeds/news.xml",
        pageSize: 20,
        totalItems: emptyFeed ? 0 : 1,
        pages: emptyFeed ? [] : [{ page: 1, url: pageUrl, itemCount: 1 }],
      }),
    ),
  );
  bodies.set(
    "/api/v1/content/1.json",
    new TextEncoder().encode(
      JSON.stringify({
        apiVersion: 1,
        title: "NJ PBS released content",
        indexUrl: feedUrl,
        selfUrl: pageUrl,
        previousUrl: null,
        nextUrl: null,
        page: 1,
        pageSize: 20,
        totalItems: 1,
        totalPages: 1,
        items: [{ title: "Frozen story", url: homeUrl + "posts/story/" }],
      }),
    ),
  );
  if (emptyFeed) bodies.delete("/api/v1/content/1.json");
  bodies.set("/pagefind/pagefind-entry.json", new TextEncoder().encode("{}"));
  const members = rows
    .map(([path, mime, family, source, dynamic]) => ({
      path,
      mime,
      size: bodies.get(path)!.byteLength,
      sha256: sha(bodies.get(path)!),
      family,
      source,
      dynamic,
    }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const codeAssetManifestDigest = sha(new TextEncoder().encode(JSON.stringify(members)));
  const pair = { ...releasePair("b", "b".repeat(40)), codeAssetManifestDigest };
  return {
    pair,
    bodies,
    manifest: { schemaVersion: 1, inventoryVersion: 1, commitSha: pair.commitSha, codeAssetManifestDigest, members },
  };
}

export async function stageReplayCodePackFixture(
  firestore: Firestore,
  store: PairViewStore,
  cursor: { baselineDigest: string; sequence: number; lastDigest: string },
  omittedPath?: string,
  sourceInputs?: SourceInputs,
  emptyFeed = false,
  baselineFrame?: {
    receipt: import("../../functions/lib/public-release-change-baseline").PublicReleaseChangeBaseline;
    logBaselineDigest: string;
    sourceMembers: import("../../functions/lib/public-release-change-baseline").PublicReleaseSourceMember[];
  },
) {
  const fixture = replayCodePackFixture(sourceInputs, emptyFeed),
    { pair, manifest, bodies } = fixture;
  await work.registerPublicReleasePair({ firestore, pair });
  const snapshot = new TextEncoder().encode(JSON.stringify(manifest.members));
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const files: Array<{ name: string; bytes: Uint8Array; dependencies: string[] }> = [
    { name: "code-pack.json", bytes: manifestBytes, dependencies: [] },
    { name: "snapshot.json", bytes: snapshot, dependencies: ["code-pack.json"] },
  ];
  if (baselineFrame) {
    const chunkNames = new Set<string>();
    for (const member of manifest.members)
      for (let index = 0; index < publicReleasePairCodePackChunkCount(member.size); index++) {
        const name = publicReleasePairCodePackChunkName(member, index);
        if (chunkNames.has(name)) continue;
        chunkNames.add(name);
        const bytes = encodePublicReleasePairCodePackChunk(
          bodies
            .get(member.path)!
            .subarray(index * PAIR_CODE_PACK_CHUNK_BYTES, (index + 1) * PAIR_CODE_PACK_CHUNK_BYTES),
        );
        files.push({ name, bytes, dependencies: [] });
      }
    files[0].dependencies = [...chunkNames].sort();
    files.push({
      name: "baseline.json",
      bytes: new TextEncoder().encode(JSON.stringify(baselineFrame)),
      dependencies: [],
    });
    files[1].dependencies = ["baseline.json", "code-pack.json"];
    files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  const scope = {
    kind: "qualification" as const,
    sourceOperationId: `baseline-codepack-${baselineFrame?.logBaselineDigest ?? pair.codeAssetManifestDigest}`,
    sourceVersion: 1,
    snapshotDigest: sha(snapshot),
    contextSequence: cursor.sequence,
  };
  const root = input.parsePublicReleasePairInputRoot(
    {
      schemaVersion: 2,
      kind: "pair-render-input",
      pairDigest: protocol.publicReleaseDigest(pair),
      source: { kind: "inventory", id: scope.sourceOperationId },
      scope,
      cursor,
      snapshotFile: "snapshot.json",
      entryFiles: ["code-pack.json", "snapshot.json"],
      files: files.map((file) => ({
        name: file.name,
        digest: sha(file.bytes),
        bytes: file.bytes.byteLength,
        objectKey: input.publicReleasePairInputObjectKey(pair, sha(file.bytes)),
        dependencies: file.dependencies,
      })),
    },
    pair,
  );
  async function* sources() {
    for (const file of files) yield { name: file.name, bytes: file.bytes };
  }
  const captured = await capturePublicReleasePairInput({
    firestore,
    store,
    pair,
    plan: root,
    expectedSource: root.source,
    expectedCursor: cursor,
    files: sources(),
  });
  if (baselineFrame) await persistPublicReleasePairCodePackBaseline({ firestore, store, pair, captured });
  const { taskId } = await firestore.runTransaction((transaction) =>
    work.enqueuePublicReleasePairWorkInTransaction({
      firestore,
      transaction,
      pair,
      input: { ...scope, inputManifestDigest: captured.receipt.inputManifestDigest },
    }),
  );
  const claim = await work.claimPublicReleasePairWork({ firestore, pair, taskId, now: Date.now() });
  const claimDigest = protocol.publicReleaseDigest(claim!.token);
  async function* outputs() {
    for (const member of manifest.members) {
      if (member.path === omittedPath) continue;
      yield {
        path: member.path,
        status: 200 as const,
        headers: { "content-type": member.mime, "cache-control": "no-store", "x-njpbs-renderer-sha": pair.commitSha },
        bytes: bodies.get(member.path)!,
      };
    }
  }
  const written = baselineFrame
    ? await executePublicReleasePairCodePack({
        firestore,
        store,
        pair,
        identity: claim!.identity,
        claimDigest,
        frozen: await openPublicReleasePairInput({
          firestore,
          store,
          pair,
          identity: claim!.identity,
          expectedSource: root.source,
          expectedCursor: cursor,
        }),
        renew: () => work.renewPublicReleasePairWork({ firestore, pair, taskId, token: claim!.token }),
      })
    : await writePublicReleasePairView({
        store,
        pair,
        identity: claim!.identity,
        claimDigest,
        cursor,
        outputs: outputs(),
      });
  await work.settlePublicReleasePairWork({
    firestore,
    pair,
    taskId,
    token: claim!.token,
    manifestDigest: written.manifestDigest,
    now: Date.now(),
  });
  await stagePublicReleasePairView({
    firestore,
    store,
    pair,
    identity: claim!.identity,
    claimDigest,
    manifestDigest: written.manifestDigest,
  });
  if (baselineFrame)
    await stagePublicReleasePairCodePack({
      firestore,
      store,
      pair,
      identity: claim!.identity,
      claimDigest,
      viewManifestDigest: written.manifestDigest,
    });
  return {
    ...fixture,
    reference: {
      identity: claim!.identity,
      claimDigest,
      manifestDigest: written.manifestDigest,
      manifestBytes: written.manifestBytes,
    },
  };
}
