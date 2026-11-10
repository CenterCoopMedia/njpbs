import { useEffect, useId, useRef, useState } from "react";
import type { createMeaningSearch, MeaningDocument } from "../../../packages/browser-search";
import { disposeSessionMeaningSearch, sessionMeaningSearch } from "../lib/meaning-search-session";
import { HttpError, type MediaAssetSummary, type MediaListQuery, type ListMediaResponse, type MediaCorpusRequest, type MediaCorpusResponse } from "../lib/functions";
import { Icon } from "./ui/Icon";
import { Button } from "./ui/Primitives";
import { InfoTooltip } from "./ui/InfoTooltip";

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const RECORD_LIMIT = 5000;
const PAGE_LIMIT = 10;
const TEXT_LIMIT = 5800;
// Matches functions/lib/media-corpus.js: at most ten batches of 500 raw records.
const MEANING_SCAN_PAGE_SIZE = 500;
const IDLE_STATUS = "Type a search to find related media. Keyword search still works.";

type ScanFilters = Pick<MediaListQuery, "categories" | "kinds">;

type MediaMeaningScan = {
  records: Map<string, MediaAssetSummary>;
  documents: MeaningDocument[];
  capped: boolean;
  failed: boolean;
  settled: boolean;
  cancelled: boolean;
  listeners: Set<() => void>;
  promise: Promise<void>;
};

const sessionScans = new Map<string, MediaMeaningScan>();

export function clearMediaMeaningSession() {
  for (const scan of sessionScans.values()) scan.cancelled = true;
  sessionScans.clear();
  disposeSessionMeaningSearch("media");
}

function assignedCategories(asset: MediaAssetSummary) {
  return asset.categories.length > 0 ? asset.categories : [asset.category];
}

// Same category and kind rules as selectMediaLibrary. The session scan is
// unfiltered so a later filter does not read Firestore again.
function assetMatchesMediaFilters(asset: MediaAssetSummary, filters: ScanFilters) {
  // Audio lists only on the Audio tab, as in selectMediaLibrary.
  if (asset.kind === "audio") return false;
  if (filters.kinds.length > 0 && !filters.kinds.includes(asset.kind)) return false;
  if (filters.categories.length === 0) return true;
  return assignedCategories(asset).some(category => filters.categories.includes(category));
}

function notify(scan: MediaMeaningScan) {
  if (scan.cancelled) return;
  for (const listener of [...scan.listeners]) listener();
}

function rememberAsset(scan: MediaMeaningScan, asset: MediaAssetSummary) {
  if (scan.records.has(asset.id) || scan.records.size >= RECORD_LIMIT) {
    if (scan.records.size >= RECORD_LIMIT) scan.capped = true;
    return;
  }
  const text = [asset.name, asset.description, asset.altText, asset.tags.join(" "), asset.credit].filter(Boolean).join("\n");
  if (text.length > TEXT_LIMIT) scan.capped = true;
  scan.records.set(asset.id, asset);
  scan.documents.push({ id: asset.id, text: text.slice(0, TEXT_LIMIT) });
}

function forgetOtherSessionScans(keepKey: string) {
  for (const [otherKey, other] of sessionScans) {
    if (otherKey === keepKey) continue;
    other.cancelled = true;
    sessionScans.delete(otherKey);
  }
}

function startMediaMeaningScan(
  key: string,
  loadCorpus: (request: MediaCorpusRequest) => Promise<MediaCorpusResponse>,
) {
  const existing = sessionScans.get(key);
  if (existing && !existing.failed) return existing;
  if (existing) {
    existing.cancelled = true;
    sessionScans.delete(key);
  }
  forgetOtherSessionScans(key);
  const scan: MediaMeaningScan = {
    records: new Map(),
    documents: [],
    capped: false,
    failed: false,
    settled: false,
    cancelled: false,
    listeners: new Set(),
    promise: Promise.resolve(),
  };
  scan.promise = (async () => {
    let pages = 0;
    let cursor: string | null = null;
    const cursors = new Set<string>();
    do {
      if (scan.cancelled) return;
      const response = await loadCorpus({ limit: MEANING_SCAN_PAGE_SIZE, ...(cursor ? { cursor } : {}) });
      if (scan.cancelled) return;
      if (response.records.length > MEANING_SCAN_PAGE_SIZE ||
          (response.nextCursor !== null && (typeof response.nextCursor !== "string" || !response.nextCursor))) {
        throw new Error("Invalid media corpus page");
      }
      for (const asset of response.records) rememberAsset(scan, asset);
      cursor = response.nextCursor;
      pages += 1;
      if (cursor !== null) {
        if (pages >= PAGE_LIMIT || cursors.has(cursor)) throw new Error("Media corpus scan limit reached");
        cursors.add(cursor);
      }
      notify(scan);
      if (cursor !== null) await wait(600);
    } while (cursor !== null);
    if (scan.cancelled) return;
    scan.settled = true;
    notify(scan);
  })().catch(() => {
    if (scan.cancelled) return;
    scan.failed = true;
    scan.settled = true;
    scan.records.clear();
    scan.documents.length = 0;
    if (sessionScans.get(key) === scan) sessionScans.delete(key);
    notify(scan);
  });
  sessionScans.set(key, scan);
  return scan;
}

function cancelMediaMeaningScan(key: string) {
  const scan = sessionScans.get(key);
  if (!scan) return;
  scan.cancelled = true;
  scan.records.clear();
  scan.documents.length = 0;
  sessionScans.delete(key);
}

export function MediaMeaningResults({ identity, query, loadMedia, loadCorpus, onSelect, disabled = false, refreshRevision = 0 }: {
  identity: string; query: MediaListQuery; loadMedia: (query: MediaListQuery) => Promise<ListMediaResponse>;
  loadCorpus: (request: MediaCorpusRequest) => Promise<MediaCorpusResponse>;
  onSelect: (asset: MediaAssetSummary) => void; disabled?: boolean; refreshRevision?: number;
}) {
  const filters = JSON.stringify({ categories: query.categories, kinds: query.kinds });
  const hasQuery = query.q.trim().length > 0;
  const context = `${identity}:${filters}:${refreshRevision}`;
  const sessionKey = `${identity}:${refreshRevision}`;
  const [status, setStatus] = useState(IDLE_STATUS);
  const [result, setResult] = useState<{ context: string; assets: MediaAssetSummary[] }>({ context, assets: [] });
  const [generation, setGeneration] = useState(0);
  const [opening, setOpening] = useState<string>();
  const [error, setError] = useState("");
  const [failedRetry, setFailedRetry] = useState(0);
  // Related results starts closed so matches never push the grid down; opening it only shows
  // what the scan already found.
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const statusId = useId();
  const engine = useRef<ReturnType<typeof createMeaningSearch>>();
  const records = useRef(new Map<string, MediaAssetSummary>());
  const mounted = useRef(true);
  const invalidate = useRef(() => {});
  const failedQuery = useRef<string | null>(null);
  // The search text on screen now. A failed read records this, not the text its scan
  // started with, so an edit made while the read was pending still counts as a change.
  const latestQuery = useRef(query.q);
  latestQuery.current = query.q;
  const hadQuery = useRef(hasQuery);
  const current = useRef({ context, disabled, onSelect });
  current.current = { context, disabled, onSelect };

  // A failed library read stays failed until the search text changes. Clearing the
  // field already restarts the effect, so this only covers a new query.
  useEffect(() => {
    const previous = hadQuery.current;
    hadQuery.current = hasQuery;
    if (!hasQuery || !previous || failedQuery.current === null || query.q === failedQuery.current) return;
    failedQuery.current = null;
    setFailedRetry(value => value + 1);
  }, [hasQuery, query.q]);

  useEffect(() => {
    // refreshRevision returns to zero when the route remounts, so drop every other
    // cached scan now, including while the search field is empty.
    forgetOtherSessionScans(sessionKey);
    if (!hasQuery) {
      mounted.current = false;
      setStatus(IDLE_STATUS);
      setResult({ context, assets: [] });
      setGeneration(0);
      setError("");
      return;
    }
    let active = true;
    mounted.current = true;
    failedQuery.current = null;
    let allowed = true;
    invalidate.current = () => {
      allowed = false;
      cancelMediaMeaningScan(sessionKey);
    };
    let modelAvailable = true;
    let prepared = 0;
    let preparing = false;
    const selected = JSON.parse(filters) as ScanFilters;
    // Keyed by account only: vectors are reused by exact text, so refreshed scans stay correct.
    const client = sessionMeaningSearch("media", identity);
    engine.current = client;
    const scan = startMediaMeaningScan(sessionKey, loadCorpus);
    records.current = scan.records;
    setGeneration(0);
    setResult({ context, assets: [] });
    setOpening(undefined);
    setError("");
    setStatus("Loading media details and local meaning search.");
    const filteredDocuments = () => scan.documents.filter(document => {
      const asset = scan.records.get(document.id);
      return asset ? assetMatchesMediaFilters(asset, selected) : false;
    });
    const updateStatus = () => {
      if (!active || !allowed) return;
      const visibleCount = filteredDocuments().length;
      setStatus(`${scan.settled ? "Media scan finished." : "Loading media details."} ${prepared} of ${visibleCount} loaded media items indexed.${scan.capped ? " Search coverage is partial." : ""}${modelAvailable ? "" : " Meaning search is unavailable; keyword search still works."}`);
    };
    const started = client.start().catch(() => { modelAvailable = false; updateStatus(); });
    async function prepare() {
      if (preparing) return;
      preparing = true;
      try {
        await started;
        while (active && allowed && modelAvailable) {
          const documents = filteredDocuments();
          if (prepared >= documents.length) break;
          const batch = documents.slice(0, prepared + 50);
          const { encoded } = await client.prepare(batch);
          prepared = batch.length;
          if (active) { setGeneration(value => value + 1); updateStatus(); }
          // Pause only after new encoding work; reused vectors return at once.
          if (encoded) await wait(500);
        }
      } catch { modelAvailable = false; updateStatus(); }
      finally { preparing = false; }
    }
    const onScan = () => {
      if (!active || !allowed) return;
      if (scan.failed) {
        failedQuery.current = latestQuery.current;
        allowed = false;
        disposeSessionMeaningSearch("media");
        setResult({ context, assets: [] });
        setStatus("Media meaning search is unavailable. Keyword search still works.");
        return;
      }
      updateStatus();
      void prepare();
    };
    scan.listeners.add(onScan);
    onScan();
    void scan.promise.then(() => { if (active) onScan(); });
    return () => {
      // Stop encoding in the background; the vectors already made stay for the next search.
      // A failed scan or denied access already disposed the index.
      if (allowed) void client.prepare([]).catch(() => {});
      active = false;
      mounted.current = false;
      allowed = false;
      scan.listeners.delete(onScan);
      engine.current = undefined;
    };
  }, [context, failedRetry, filters, hasQuery, loadCorpus, sessionKey]);

  useEffect(() => {
    let active = true;
    setResult({ context, assets: [] });
    if (!query.q.trim() || !engine.current || !generation) return;
    const client = engine.current;
    const timer = setTimeout(() => {
      void client.search(query.q, { limit: 8, minScore: 0.55 }).then(hits => {
        if (active && current.current.context === context) setResult({ context, assets: hits.flatMap(hit => {
          const asset = records.current.get(hit.id);
          return asset && assetMatchesMediaFilters(asset, query) ? [asset] : [];
        }) });
      }).catch(error => {
        if (active && error?.name !== "AbortError") {
          setGeneration(0);
          setStatus("Meaning search is unavailable. Keyword search still works.");
        }
      });
    }, 180);
    return () => { active = false; clearTimeout(timer); };
  }, [query.q, generation, context]);

  async function select(asset: MediaAssetSummary) {
    if (current.current.disabled || opening) return;
    const selectionContext = context;
    setOpening(asset.id); setError("");
    try {
      const fresh = await loadMedia({ ...query, q: "", page: 1, assetIds: [asset.id] });
      if (!mounted.current || current.current.context !== selectionContext || current.current.disabled) return;
      const verified = fresh.records.find(record => record.id === asset.id);
      if (!verified) throw new Error("Media unavailable");
      current.current.onSelect(verified);
    } catch (error) {
      if (!mounted.current || current.current.context !== selectionContext) return;
      if (error instanceof HttpError && [401, 403].includes(error.status)) {
        invalidate.current(); records.current.clear(); disposeSessionMeaningSearch("media"); setGeneration(0);
        setResult({ context, assets: [] });
      } else {
        records.current.delete(asset.id);
        setResult(previous => ({ ...previous, assets: previous.assets.filter(record => record.id !== asset.id) }));
      }
      setError("This media item changed or is no longer available. Reload the library to refresh search.");
    } finally { if (mounted.current && current.current.context === selectionContext) setOpening(undefined); }
  }
  const matches = result.context === context ? result.assets : [];
  return <section aria-label="Media meaning search" className="media-meaning-results" data-open={open || undefined}>
    <div className="media-meaning-summary">
      <button
        aria-controls={bodyId}
        aria-describedby={statusId}
        aria-expanded={open}
        aria-label={matches.length ? `Related results, ${matches.length} found` : undefined}
        className="media-meaning-toggle"
        onClick={() => setOpen(value => !value)}
        type="button"
      >
        <Icon name="chevron-down" />
        <span>Related results</span>
        {matches.length ? <span aria-hidden="true" className="media-meaning-count">{matches.length}</span> : null}
      </button>
      <InfoTooltip label="meaning search" content="Searches saved names, descriptions, alt text and tags on this device. The model downloads automatically and is cached. Media search data stays in memory for this session." />
      <p id={statusId} role="status">{status}</p>
    </div>
    <div className="media-meaning-body" hidden={!open} id={bodyId}>
      {disabled && matches.length ? <p>Save or discard your changes before opening another media item.</p> : null}
      {matches.length ? <><h3>Related media</h3><ul>{matches.map(asset => <li key={asset.id}>
        <Button variant="ghost" disabled={disabled || !!opening} onClick={() => void select(asset)}>{asset.name}</Button>
        {asset.description ? <p>{asset.description.slice(0, 180)}</p> : null}
      </li>)}</ul></> : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  </section>;
}
