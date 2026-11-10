import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { fuseRanks, type createMeaningSearch, type MeaningDocument } from "../../../packages/browser-search";
import { disposeSessionMeaningSearch, sessionMeaningSearch } from "../lib/meaning-search-session";
import { HttpError, postFunction } from "../lib/functions";
import { listSourceMedia, type SourceMediaAssetSummary } from "../lib/source-media";
import { getVideoTranscript, videoTime } from "../lib/video-production";
import { cacheVideoSearchCorpus, cachedVideoSearchCorpus, invalidateVideoSearchCorpus, videoSearchCacheRevision, type VideoSearchChunk as Chunk, type VideoSearchCoverage as Coverage, type VideoSearchEntry as Entry } from "../lib/video-search-session-cache";
import { loadVideoSearchShards, checkVideoSearchLease, SEARCH_FRESHNESS_MS, type SearchLease } from "../lib/video-search-shards";
import { forgetVideoSearchShards, forgetVideoSearchShard } from "../lib/video-search-shard-cache";
import { Icon } from "./ui/Icon";
import { groupVideoSearchResults, videoPassageContext, videoSearchHighlight } from "../lib/video-search-results";
import "./media/MediaRow.css";
import "./VideoMeaningSearch.css";
import { InfoTooltip } from "./ui/InfoTooltip";

// An unavailable video is an item with no asset, so its coverage still counts in order.
type CorpusItem = { asset: SourceMediaAssetSummary | null; chunks: Chunk[]; revision: { reviewed: boolean; languageCode: string } | null; coverage: Coverage };
type CorpusPage = { items: CorpusItem[]; nextCursor: string | null; coverage: Coverage };
// The one-video page an older Function returns when it does not accept `limit`.
type SingleCorpusPage = Omit<CorpusItem, "asset"> & { asset: SourceMediaAssetSummary | null; nextCursor: string | null };
// Videos per corpus request. The Function reads them in parallel and caps the response bytes.
const CORPUS_BATCH = 8;
const emptyCoverage = (): Coverage => ({ assetsScanned: 0, assetsIndexed: 0, assetsWithoutTranscript: 0, assetsUnavailable: 0, truncatedAssets: 0 });
const MAX_ENTRIES = 10000;
const MAX_TEXT = 10 * 1024 * 1024;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function VideoMeaningSearch({ userId, sourceId, query, getIdToken, filters, disabled, onOpen, renderPoster }: {
  userId: string; sourceId: string; query: string; getIdToken: () => Promise<string>;
  filters: { tag?: string; createdBy?: string; rightsStatus?: string }; disabled: boolean;
  renderPoster?: (asset: SourceMediaAssetSummary) => ReactNode;
  onOpen: (asset: SourceMediaAssetSummary, seconds: number) => void;
}) {
  const passageContextId = useId();
  const entries = useRef(new Map<string, Entry>());
  const engine = useRef<ReturnType<typeof createMeaningSearch>>();
  const [refresh, setRefresh] = useState(0);
  const [version, setVersion] = useState(0);
  const [coverage, setCoverage] = useState(emptyCoverage);
  const [status, setStatus] = useState("Loading video search.");
  const [preparedCount, setPreparedCount] = useState(0);
  const [semanticReady, setSemanticReady] = useState(false);
  const [matches, setMatches] = useState<string[]>([]);
  const [opening, setOpening] = useState<string>();
  const [error, setError] = useState("");
  const [retryAvailable, setRetryAvailable] = useState(false);
  const mounted = useRef(true);
  const abort = useRef<AbortController>();
  const conflictAttempts = useRef(0);
  const hasLocalCorpus = useRef(false);
  const localIdentity = useRef(`${userId}:${sourceId}`);
  const hasQuery = query.trim().length > 0;
  const latestQuery = useRef(query);
  latestQuery.current = query;
  const pausedSearch = useRef<{ query: string; controller: AbortController }>();

  useEffect(() => {
    if (pausedSearch.current && pausedSearch.current.query !== query) {
      pausedSearch.current.controller.abort();
      pausedSearch.current = undefined;
      setRefresh(value => value + 1);
    }
  }, [query]);

  useEffect(() => {
    if (!hasQuery || document.hidden) {
      hasLocalCorpus.current = false;
      entries.current.clear();
      engine.current = undefined;
      setCoverage(emptyCoverage());
      setPreparedCount(0);
      setSemanticReady(false);
      setMatches([]);
      if (hasQuery) {
        const resume = () => { if (!document.hidden) setRefresh(value => value + 1); };
        document.addEventListener("visibilitychange", resume);
        return () => document.removeEventListener("visibilitychange", resume);
      }
      return;
    }
    mounted.current = true;
    hasLocalCorpus.current = true;
    localIdentity.current = `${userId}:${sourceId}`;
    let active = true;
    const controller = new AbortController();
    abort.current = controller;
    const documents: MeaningDocument[] = [];
    const snapshot = cachedVideoSearchCorpus(userId, sourceId);
    let bytes = 0;
    let prepared = 0;
    let meaningAvailable = true;
    const totals = emptyCoverage();
    const requestRevision = videoSearchCacheRevision();
    entries.current.clear();
    setCoverage(emptyCoverage()); setMatches([]); setPreparedCount(0); setSemanticReady(false);
    setStatus("Loading video search.");
    setRetryAvailable(false);
    let local: ReturnType<typeof createMeaningSearch> | undefined;
    let started = Promise.resolve();
    const initializeSearch = (realm: string) => {
      if (local) return;
      local = sessionMeaningSearch("video", `${userId}:${sourceId}:${realm}`);
      engine.current = local;
      started = local.start().catch(() => {
        meaningAvailable = false;
        if (active) setStatus("Meaning search is unavailable; saved text matching remains available.");
      });
    };
    let preparing = false;
    const prepare = async () => {
      if (preparing || !local) return;
      const client = local;
      preparing = true;
      try {
        await started;
        while (active && !controller.signal.aborted && meaningAvailable && documents.length > prepared) {
          const batch = documents.slice(0, prepared + 50);
          const { encoded } = await client.prepare(batch);
          prepared = batch.length;
          if (active) { setSemanticReady(true); setPreparedCount(prepared); setVersion(value => value + 1); }
          // Pause only after new encoding work; reused vectors return at once.
          if (encoded) await wait(500);
        }
      } catch {
        meaningAvailable = false;
        if (active) { setSemanticReady(false); setStatus("Meaning search is unavailable; saved text matching remains available."); }
      } finally { preparing = false; }
    };
    const add = (entry: Entry) => {
      if (entries.current.size >= MAX_ENTRIES || bytes + entry.text.length * 2 > MAX_TEXT) return false;
      bytes += entry.text.length * 2;
      entries.current.set(entry.id, entry);
      documents.push({ id: entry.id, text: entry.text });
      return true;
    };
    async function load(startCursor?: string) {
      let cursor = startCursor;
      let capped = false;
      // Admin can deploy before Functions. An older Function rejects `limit` with 400; the scan
      // then reads one video per request with the earlier pause, as it did before batching.
      let single = false;
      try {
        do {
          if (!active || controller.signal.aborted) return;
          let page: CorpusPage | undefined;
          for (let retry = 0; retry < 4; retry++) {
            if (!active || controller.signal.aborted) return;
            try {
              const token = await getIdToken();
              if (!active || controller.signal.aborted) return;
              if (single) {
                const { nextCursor, ...item } = await postFunction<SingleCorpusPage>("cmsGetVideoSearchCorpus", token, { sourceId, ...(cursor ? { cursor } : {}) }, {}, { appCheck: "unless-automation", signal: controller.signal });
                page = { items: [item], nextCursor, coverage: item.coverage };
              } else {
                page = await postFunction<CorpusPage>("cmsGetVideoSearchCorpus", token, { sourceId, limit: CORPUS_BATCH, ...(cursor ? { cursor } : {}) }, {}, { appCheck: "unless-automation", signal: controller.signal });
              }
              break;
            } catch (error) {
              if (!active) return;
              if (!single && error instanceof HttpError && error.status === 400) {
                single = true;
                retry--;
                continue;
              }
              if (!(error instanceof HttpError) || error.status !== 429 || retry === 3) throw error;
              await wait(2000 * (retry + 1));
            }
          }
          if (!active || controller.signal.aborted || !page) return;
          const counted: Coverage[] = [];
          for (const item of page.items) {
            if (capped) break;
            counted.push(item.coverage);
            if (!item.asset) continue;
            capped = !add({ id: `asset/${item.asset.id}`, text: [item.asset.name, item.asset.description, ...item.asset.tags].filter(Boolean).join(" "), asset: item.asset });
            for (const chunk of item.chunks) {
              if (capped) break;
              capped = !add({ id: chunk.id, text: chunk.text, asset: item.asset, chunk, reviewed: item.revision?.reviewed, languageCode: item.revision?.languageCode });
            }
          }
          // At the browser cap, count only the videos this scan reached, as a one-video page did.
          for (const coverage of capped ? counted : [page.coverage]) {
            for (const key of Object.keys(totals) as (keyof Coverage)[]) totals[key] += coverage[key];
          }
          setCoverage({ ...totals });
          setVersion(value => value + 1);
          cursor = page.nextCursor ?? undefined;
          const complete = !cursor || capped;
          const corpusStatus = complete ? capped ? "Browser search limit reached; coverage is partial." : "Library scan finished." : "Loading video search.";
          cacheVideoSearchCorpus(userId, sourceId, { entries: [...entries.current.values()], coverage: { ...totals },
            status: corpusStatus,
            nextCursor: cursor, complete }, requestRevision);
          // Small additions keep the worker responsive and reuse already indexed vectors.
          void prepare();
          if (!active) return;
          if (single && cursor && !capped) await wait(600);
        } while (cursor && !capped);
        if (active) {
          const status = `${capped ? "Browser search limit reached; coverage is partial." : "Library scan finished."} ${meaningAvailable ? "" : "Meaning search is unavailable; saved text matching remains available."}`;
          setStatus(status);
        }
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        if (error instanceof HttpError && [401, 403].includes(error.status)) {
          invalidateVideoSearchCorpus(sourceId);
          entries.current.clear(); disposeSessionMeaningSearch("video"); setSemanticReady(false); setPreparedCount(0); setMatches([]); setVersion(value => value + 1);
          setStatus("Video search access is unavailable.");
        } else setStatus("Library scan stopped; results cover only the text already loaded.");
      }
    }
    let renewal: ReturnType<typeof setTimeout> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let realm = "legacy";
    let validUntil = 0;
    let legacy = false;
    const clear = (forget = false) => {
      clearTimeout(renewal); clearTimeout(expiry);
      controller.abort(); entries.current.clear(); invalidateVideoSearchCorpus(sourceId);
      if (forget) { disposeSessionMeaningSearch("video"); void forgetVideoSearchShards(userId); }
      setMatches([]); setSemanticReady(false); setPreparedCount(0);
      setCoverage(emptyCoverage()); setVersion(value => value + 1);
    };
    const armLease = (lease: SearchLease) => {
      clearTimeout(renewal); clearTimeout(expiry);
      validUntil = lease.checkedAt + SEARCH_FRESHNESS_MS;
      const remaining = validUntil - Date.now();
      expiry = setTimeout(() => {
        if (active) { clear(); setStatus("Video search needs a fresh access check. Reopen search to try again."); }
      }, Math.max(0, remaining));
      renewal = setTimeout(() => {
        if (!active || controller.signal.aborted) return;
        void checkVideoSearchLease(lease, sourceId, getIdToken, controller.signal).then(result => {
          if (!active || controller.signal.aborted) return;
          if (result.unchanged) armLease({ ...lease, checkedAt: result.checkedAt });
          else { clear(result.identityChanged); setRefresh(value => value + 1); }
        }).catch(error => {
          if (!active || controller.signal.aborted) return;
          clear(error instanceof HttpError && [401, 403, 404].includes(error.status));
          setStatus(error instanceof HttpError && [401, 403, 404].includes(error.status) ?
            "Video search access is unavailable." : "Video search could not be refreshed. Reopen search to try again.");
        });
      }, Math.max(0, remaining - 15_000));
    };
    async function sync() {
      try {
        const result = await loadVideoSearchShards({ userId, sourceId, getIdToken, signal: controller.signal,
          isUsable: () => !validUntil || Date.now() < validUntil,
          onValidated: lease => { pausedSearch.current = undefined; realm = `${lease.identity}:${lease.usersView}`; armLease(lease); },
          onPaused: seconds => {
            if (!active) return;
            pausedSearch.current = { query: latestQuery.current, controller };
            setStatus(`Video search is paused. Retrying in ${seconds} seconds.`);
          },
          onItem: item => {
            if (!active || controller.signal.aborted) return false;
            initializeSearch(realm);
            let capped = !add({ id: `asset/${item.asset.id}`, text: [item.asset.name, item.asset.description, ...item.asset.tags].filter(Boolean).join(" "), asset: item.asset });
            for (const chunk of item.chunks) {
              if (capped) break;
              capped = !add({ id: chunk.id, text: chunk.text, asset: item.asset, chunk,
                reviewed: item.revision?.reviewed, languageCode: item.revision?.languageCode });
            }
            for (const key of Object.keys(totals) as (keyof Coverage)[]) totals[key] += item.coverage[key];
            setCoverage({ ...totals }); setVersion(value => value + 1); void prepare();
            return !capped;
          },
        });
        if (!active || controller.signal.aborted) return;
        pausedSearch.current = undefined;
        if (result.supported) {
          conflictAttempts.current = 0;
          setStatus(result.capped ? "Browser search limit reached; coverage is partial." : result.pending ?
            "Search is updating; changed transcripts are unavailable until ready." : "Library scan finished.");
          return;
        }
        // Persisted shards are never shown without fresh manifest validation.
        legacy = true;
        initializeSearch("legacy");
        if (snapshot && !result.warming) {
          // An old Function rejects manifest mode before checking the source.
          // Reauthorize the source before reusing any page-session text.
          const token = await getIdToken();
          await listSourceMedia(token, { sourceId, limit: 1 });
          if (!active || controller.signal.aborted) return;
          for (const entry of snapshot.entries) { entries.current.set(entry.id, entry); documents.push({ id: entry.id, text: entry.text }); }
          bytes = snapshot.entries.reduce((sum, entry) => sum + entry.text.length * 2, 0);
          Object.assign(totals, snapshot.coverage);
          setCoverage(snapshot.coverage); setStatus(snapshot.status); setVersion(value => value + 1); void prepare();
          if (!snapshot.complete) void load(snapshot.nextCursor);
        } else void load();
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        if (error instanceof HttpError && error.status === 409 && conflictAttempts.current < 2) {
          conflictAttempts.current++;
          clear(); setRefresh(value => value + 1);
          return;
        }
        clear(error instanceof HttpError && [401, 403, 404].includes(error.status));
        if (error instanceof HttpError && error.status === 429) {
          pausedSearch.current = { query: latestQuery.current, controller };
          setRetryAvailable(true);
          setStatus("Video search is paused. Select Retry to check again.");
          return;
        }
        setStatus(error instanceof HttpError && [401, 403].includes(error.status) ?
          "Video search access is unavailable." : "Video search could not be refreshed. Reopen search to try again.");
      }
    }
    const visibility = () => {
      if (legacy) return; // The legacy path keeps its existing page-session policy.
      if (document.hidden) clear();
      setRefresh(value => value + 1);
    };
    document.addEventListener("visibilitychange", visibility);
    void sync();
    return () => {
      active = false; mounted.current = false; clearTimeout(expiry); clearTimeout(renewal); document.removeEventListener("visibilitychange", visibility);
      controller.abort(); entries.current.clear();
      if (pausedSearch.current?.controller === controller) pausedSearch.current = undefined;
      // Stop encoding in the background; the vectors already made stay for the next search.
      void local?.prepare([]).catch(() => {});
    };
  }, [userId, sourceId, getIdToken, hasQuery, refresh]);

  useEffect(() => {
    let active = true;
    setMatches([]);
    const needle = query.trim();
    if (!needle || !semanticReady) return;
    const timer = setTimeout(() => {
      void engine.current?.search(needle, { limit: 100, minScore: 0.55 }).then(result => {
        if (active) setMatches(result.map(hit => hit.id));
      }).catch(error => {
        if (!active) return;
        setMatches([]);
        if (error?.name !== "AbortError") {
          setSemanticReady(false);
          setStatus("Meaning search is unavailable; saved text matching remains available.");
        }
      });
    }, 180);
    return () => { active = false; clearTimeout(timer); };
  }, [query, version, semanticReady]);

  const needle = query.trim().toLocaleLowerCase("en-US");
  const allowed = (entry: Entry) => (!filters.tag || entry.asset.tags.includes(filters.tag)) &&
    (!filters.createdBy || entry.asset.uploadedBy?.uid === filters.createdBy) &&
    (!filters.rightsStatus || entry.asset.rightsStatus === filters.rightsStatus);
  const showLocal = hasLocalCorpus.current && localIdentity.current === `${userId}:${sourceId}`;
  const visibleEntries = showLocal ? entries.current : new Map<string, Entry>();
  const visibleCoverage = coverage;
  const visibleStatus = status;
  const literal = needle ? [...visibleEntries.values()].filter(entry => allowed(entry) && entry.text.toLocaleLowerCase("en-US").includes(needle)).map(entry => entry.id) : [];
  const meaning = matches.filter(id => { const entry = visibleEntries.get(id); return entry && allowed(entry); });
  const results = fuseRanks(literal, meaning, visibleEntries.size).map(id => visibleEntries.get(id)!).filter(Boolean);

  const groups = groupVideoSearchResults(results);
  const corpus = [...visibleEntries.values()];

  async function open(entry: Entry) {
    if (disabled || opening) return;
    setOpening(entry.id); setError("");
    try {
      const token = await getIdToken();
      // Both endpoints check current access. Neither request depends on the other's result.
      const [current, refreshed] = await Promise.all([
        entry.chunk ? getVideoTranscript(token, { sourceId, assetId: entry.asset.id },
          { transcriptId: entry.chunk.transcriptId, languageCode: "en-US", maxSpeakers: 10 }) : Promise.resolve(null),
        listSourceMedia(token, { sourceId, assetId: entry.asset.id }),
      ]);
      if (entry.chunk && (current?.transcript.state !== "ready" || current.transcript.editRevision !== entry.chunk.editRevision)) throw new Error("stale");
      const asset = refreshed.records.find(item => item.id === entry.asset.id && item.sourceId === sourceId);
      if (!asset || !allowed({ ...entry, asset })) throw new Error("stale");
      // The player signs once after mounting; a discarded preflight URL delayed every open.
      if (mounted.current) onOpen(asset, entry.chunk?.startSeconds ?? 0);
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof HttpError && [401, 403].includes(error.status)) void forgetVideoSearchShards(userId);
      else if (error instanceof HttpError && [404, 410].includes(error.status)) void forgetVideoSearchShard(userId, sourceId, entry.asset.id);
      invalidateVideoSearchCorpus(sourceId);
      if (error instanceof HttpError && [401, 403].includes(error.status)) {
        abort.current?.abort(); entries.current.clear(); disposeSessionMeaningSearch("video"); setMatches([]); setSemanticReady(false); setPreparedCount(0);
        setStatus("Video search access is unavailable.");
      } else {
        for (const [id, row] of entries.current) if (row.asset.id === entry.asset.id) entries.current.delete(id);
      }
      setVersion(value => value + 1);
      setError("This result changed or is no longer available. Reload the library to refresh search.");
    } finally { if (mounted.current) setOpening(undefined); }
  }

  return hasQuery ? <section aria-label="Video text search" className="media-meaning-results">
    <p role="status">{visibleStatus} {visibleCoverage.assetsScanned} {visibleCoverage.assetsScanned === 1 ? "video" : "videos"} checked · {visibleCoverage.assetsIndexed} {visibleCoverage.assetsIndexed === 1 ? "transcript" : "transcripts"} · {preparedCount} {preparedCount === 1 ? "passage" : "passages"} ready.
      <InfoTooltip label="video text search" content={`Search runs on this device with an English model. Exact text matching also supports Spanish transcripts. ${visibleCoverage.assetsWithoutTranscript} videos have no current transcript; ${visibleCoverage.assetsUnavailable} could not be indexed; ${visibleCoverage.truncatedAssets} have partial transcript coverage. Check transcript wording against the recording.`} />
    </p>
    {retryAvailable ? <button type="button" disabled={disabled} onClick={() => setRefresh(value => value + 1)}>Retry</button> : null}
    {needle ? <>
      <h3>Matching videos and transcript passages</h3>
      {groups.length ? <ol className="video-search-groups">{groups.map(group => <li key={`${group.entry.asset.sourceId}/${group.entry.asset.id}`}>
        <div className="media-row" data-surface="video">
          <div className="media-row-track video-search-heading">
            <span className="media-row-thumb" aria-hidden="true">{renderPoster?.(group.entry.asset) ?? <Icon name="video" />}</span>
            <div className="media-row-main">
              <button type="button" className="media-row-open" disabled={disabled || !!opening} onClick={() => void open(group.entry)} aria-label={`Open ${group.entry.asset.name} at the start`}>{group.entry.asset.name}</button>
              <span className="media-row-cell">{group.passages.length ? `${group.passages.length < group.passageCount ? `${group.passages.length} of ${group.passageCount}` : group.passageCount} ${group.passageCount === 1 ? "match" : "matches"}` : "Name or details match · opens at the start"}</span>
            </div>
          </div>
        </div>
        {group.passages.length ? <ol className="video-search-passages">{group.passages.map((entry, index) => {
          const context = videoPassageContext(entry, corpus, query);
          const contextId = `${passageContextId}-${group.entry.id}-${index}`;
          return <li key={entry.id}><button type="button" className="video-search-passage" disabled={disabled || !!opening}
            aria-busy={opening === entry.id || undefined} aria-label={`${entry.asset.name} at ${videoTime(entry.chunk!.startSeconds)}`} aria-describedby={contextId}
            onClick={() => void open(entry)}>
            <time>{videoTime(entry.chunk!.startSeconds)}</time>
            <span id={contextId}>{videoSearchHighlight(context, query).map((part, index) => part.match ? <mark key={index}>{part.text}</mark> : part.text)}</span>
          </button></li>;
        })}</ol> : null}
      </li>)}</ol> : <p>No matches in the text indexed so far.</p>}
    </> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section> : null;
}
