/** Opt-in fixture. No staff session, live API, production data or credentials. */
import { createRoot } from "react-dom/client";
import { useCallback, useMemo, useState } from "react";
import { BlockEditor } from "../components/BlockEditor";
import { ElectionResultsHistory } from "../components/ElectionResultsHistory";
import { renderBlock } from "../../../packages/content-core/src/content-render";
import { electionBlock, electionRace } from "../../../tests/fixtures/election-results";
import type { ElectionRaceApproval } from "../../../packages/content-core/src/election-results";
import type { ElectionSourceApi, ElectionSourceConnection } from "../lib/election-sources";
import type { ElectionRoster } from "../../../packages/content-core/src/election-result-sources";
import type { ElectionResultsData } from "../../../packages/content-core/src/election-results";
import sourceRoster from "../../../tests/fixtures/election-sources/roster.json";
import sourceGolden from "../../../tests/fixtures/election-sources/golden.json";
import type { AdminBlock } from "../lib/block-factory";
import "../styles.css";
import "../cms-workspace.css";
import "../../../packages/content-core/src/component-blocks.css";
import "../../../packages/content-core/src/election-results.css";

const params = new URLSearchParams(location.search);
const first = electionRace();
first.candidates = first.candidates.map((candidate, index) => ({ ...candidate, party: index === 0 ? "Democratic" : "Republican",
  photo: { assetId: `portrait-${candidate.id}`, alt: `Synthetic portrait for ${candidate.name}`, caption: "Illustrative portrait" } }));
const called = electionRace({ id: "district-2", district: "District 2", status: "called", sourceKind: "ap",
  sourceLabel: "The Associated Press (fixture)", sourceUrl: "https://apnews.com/example", calledCandidateId: "ellis", apCallUrl: "https://apnews.com/example",
  candidates: [ { ...first.candidates[0], party: "Democratic", votes: 520, share: 52 },
    { ...first.candidates[1], party: "Republican", votes: 380, share: 38 },
    { id: "chen", name: "Casey Chen", party: "Independent", votes: 100, share: 10 } ] });
const certified = electionRace({ id: "local", office: "Town council", district: "Example borough", status: "certified", reportingShare: 100 });
const races = [first, called, certified];
const mediaAssets = first.candidates.map(candidate => ({ id: candidate.photo!.assetId, name: candidate.name,
  originalName: `${candidate.id}.svg`, category: "news", categories: ["news"], tags: [], description: null,
  altText: candidate.photo!.alt, license: "Synthetic fixture", credit: "Illustrative portrait", mimeType: "image/svg+xml", kind: "image" as const,
  sizeBytes: 500, width: 600, height: 450, url: `https://media.example.test/${candidate.photo!.assetId}.svg`, lifecycle: "active" as const,
  version: 1, etag: candidate.id, createdAt: null, createdBy: null, updatedAt: null, updatedBy: null }));
const approval: ElectionRaceApproval = { blockId: "results-block", raceId: first.id, race: first,
  digest: "a".repeat(64), revision: 2, status: "counting", approvedAt: "2026-11-04T02:16:00Z", approvedBy: { uid: "fixture-editor", displayName: "Example editor" },
  statusHistory: [ { revision: 1, status: "awaiting", approvedAt: "2026-11-04T00:55:00Z", approvedBy: { uid: "fixture-editor", displayName: "Example editor" } },
    { revision: 2, status: "counting", approvedAt: "2026-11-04T02:16:00Z", approvedBy: { uid: "fixture-editor", displayName: "Example editor" } } ] };

function Specimen() {
  const [message, setMessage] = useState("");
  const [sourceBusy, setSourceBusy] = useState(false);
  const sourceState = params.get("source");
  const onSourceBusyChange = useCallback((_id: string, active: boolean) => setSourceBusy(active), []);
  const sourceApi = useMemo<ElectionSourceApi>(() => {
    const data = structuredClone(sourceGolden) as ElectionResultsData;
    const pending = structuredClone(data);
    pending.races[0] = { ...pending.races[0], status: "called", sourceKind: "ap", sourceLabel: "The Associated Press (synthetic)", sourceUrl: "https://apnews.com/", calledCandidateId: pending.races[0].candidates[0].id, apCallUrl: "https://apnews.com/hub/election-2026" };
    let connection: ElectionSourceConnection | null = sourceState === "connect" ? null : {
      config: { source: { kind: "repo" }, raceIds: data.races.map(race => race.id), mode: sourceState === "pending" ? "counts-auto" : "automatic", maxAgeSeconds: 300 },
      version: 1, configRevision: 1, authorizedConfigRevision: 1, paused: sourceState === "paused", lastCheckAt: "2026-11-04T03:00:00Z", lastSourceSuccessAt: "2026-11-04T02:59:00Z", lastGoodAt: "2026-11-04T02:59:00Z", lastGoodData: data, lastGoodDigest: "a".repeat(64), pendingData: pending,
      pendingStatuses: sourceState === "pending" ? [pending.races[0].id] : [], pendingDigest: sourceState === "pending" ? "d".repeat(64) : null,
      lastHoldReason: sourceState === "hold" ? { code: "stale", message: "The Sheet source is older than five minutes. Check the source timestamp before resuming updates.", at: "2026-11-04T03:00:00Z" } : sourceState === "ap-disabled" ? { code: "ap-disabled", message: "AP is not configured. An administrator must provision its key and quota.", at: "2026-11-04T03:00:00Z" } : null,
    };
    if (connection && sourceState === "ap-disabled") connection.config.source = { kind: "ap", mapping: {} };
    return {
      get: async (_target, includeRoster) => ({ connection, canManage: sourceState !== "reader", canConnect: true, ...(includeRoster ? { roster: sourceRoster as ElectionRoster } : {}) }),
      mutate: async (_target, request) => {
        await new Promise(resolve => setTimeout(resolve, 250));
        connection = { ...(connection ?? { version: 0, configRevision: 0, authorizedConfigRevision: null, paused: false, lastCheckAt: null, lastSourceSuccessAt: null, lastGoodAt: null, lastGoodData: null, lastGoodDigest: null, lastHoldReason: null, pendingStatuses: [], pendingDigest: null, pendingData: null }), config: request.action === "connect" ? request.config : connection!.config, version: (connection?.version ?? 0) + 1 };
        if (request.action === "connect") { connection.configRevision++; connection.authorizedConfigRevision = connection.config.mode === "approve-once" ? null : connection.configRevision; }
        if (request.action === "pause") connection.paused = true;
        if (request.action === "resume") connection.paused = false;
        if (request.action === "approve") connection.authorizedConfigRevision = connection.configRevision;
        // Status approval authorizes the pending tuple; the next server poll
        // updates public values and clears pending fields. Keep them here too.
        return { connection };
      },
    };
  }, [sourceState]);
  const block = electionBlock(first);
  if (params.get("state") === "empty") block.data.races = [];
  if (params.get("state") === "error") block.data.races[0].candidates[0].votes = -1;
  const html = renderBlock({ ...block, data: { races } }, {
    resolveAsset: assetId => ({ url: `https://media.example.test/${assetId}.svg`, width: 600, height: 450 }),
  });
  return <main className="results-specimen">
    <style>{`.results-specimen{max-width:1160px;margin:0 auto;padding:clamp(16px,3vw,48px);color:#172033;background:#fff;min-height:100vh}.results-specimen>header{border-bottom:1px solid #cbd1da;margin-bottom:28px;padding-bottom:24px}.results-specimen>header h1{font-size:clamp(28px,4vw,48px);line-height:1.1;margin:10px 0;font-weight:850}.results-specimen>header p{margin:8px 0}.results-specimen .block-editor{max-width:100%}.results-specimen .block-editor:focus{outline:none}`}</style>
    <header><p>NJ Decides 2026</p><h1>Election night results</h1><p>Synthetic fixture. These are not election returns.</p></header>
    {params.get("view") === "editor" ? <>
      <BlockEditor section="genericPage" initialBlocks={[block] as unknown as AdminBlock[]} commandsInline allowIncomplete
        electionSourceHost={sourceState ? { api: sourceApi, collection: "cmsPages", documentId: "synthetic-election", version: 7, canPublish: sourceState !== "reader", locked: sourceBusy, hasUnsavedWork: () => false, onBusyChange: onSourceBusyChange } : undefined}
        electionResultsApprovals={[approval]} readOnlyNotice={sourceState ? { title: "Manual fields locked", message: "Connection controls remain available to this synthetic publisher." } : undefined} readOnly={params.get("state") === "readonly"} onSave={() => setMessage("Saved to this local fixture only.")}
        loadMedia={async () => ({ success: true, records: mediaAssets, page: 1, total: 2, allCount: 2, pageCount: 1, categoryCounts: {}, kindCounts: {} })} />
      {params.get("state") === "readonly" ? <ElectionResultsHistory approvals={[approval]} /> : null}
      <p role="status">{message}</p>
    </> : <div className="cms-page__blocks"><div className="cms-block cms-block--election_results" dangerouslySetInnerHTML={{ __html: html }} /></div>}
  </main>;
}
createRoot(document.getElementById("election-results-root")!).render(<Specimen />);
