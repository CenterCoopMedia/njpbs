import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { isPublicPageId } from "../../../packages/content-core/src/public-pages";
import { HttpError } from "../lib/functions";
import { setMediaSourceCount } from "../lib/media-session-cache";
import { editPagePath, editRecordPath } from "../lib/routes";
import { listBinnedVideos, listBinnedVideoUsage, restoreBinnedVideo, type BinnedVideo, type BinnedVideoPage, type BinnedVideoUsagePage } from "../lib/source-media";
import { invalidateVideoSearchCorpus } from "../lib/video-search-session-cache";
import { Button, EmptyState, InlineMessage } from "./ui/Primitives";
import { LoadingIndicator } from "./ui/LoadingIndicator";
import "./MediaRecycleBin.css";

interface VideoBinSource {
  sourceId: string;
  getIdToken: () => Promise<string>;
}

function VideoUsage({ sourceId, getIdToken, assetId }: VideoBinSource & { assetId: string }) {
  const [items, setItems] = useState<BinnedVideoUsagePage["items"]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [request, setRequest] = useState<{ cursor?: string }>({});
  const [loading, setLoading] = useState(true);
  const [incomplete, setIncomplete] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setError("");
      try {
        const token = await getIdToken();
        if (controller.signal.aborted) return;
        const page = await listBinnedVideoUsage(token, sourceId, assetId, request.cursor, controller.signal);
        if (controller.signal.aborted) return;
        setItems(previous => {
          const rows = request.cursor ? [...previous, ...page.items] : page.items;
          return [...new Map(rows.map(item => [`${item.collection}/${item.documentId}`, item])).values()];
        });
        setNextCursor(page.nextCursor);
        setIncomplete(previous => previous || page.incomplete);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Try again to load video usage.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [assetId, getIdToken, request, sourceId]);

  return <>
    <p>Usage in working and published posts and pages</p>
    {items.length ? <ul aria-label="Video references">{items.map(item => {
      const path = item.collection === "cmsPosts" ? editRecordPath("post", item.documentId)
        : isPublicPageId(item.documentId) ? editPagePath(item.documentId) : undefined;
      return <li key={`${item.collection}/${item.documentId}`}>
        {path ? <Link to={path}>{item.title}</Link> : item.title}
        {" ("}{item.working && item.published ? "Working and published" : item.working ? "Working" : "Published"}{")"}
      </li>;
    })}</ul> : !loading && !error ? <p role="status">{nextCursor || incomplete ? "No references found so far." : "No references found."}</p> : null}
    {incomplete ? <p role="status">Some content is outside the usage search limit.</p> : null}
    {error ? <InlineMessage tone="error" title="Usage could not be loaded">{error}</InlineMessage> : null}
    {loading ? <LoadingIndicator label="Checking video usage" /> : error || nextCursor ? <Button
      onClick={() => setRequest(error ? { ...request } : { cursor: nextCursor ?? undefined })}>
      {error ? "Retry usage" : "Continue checking"}
    </Button> : null}
  </>;
}

function VideoBinRow({ asset, restoring, busy, onRestore, ...source }: VideoBinSource & {
  asset: BinnedVideo;
  restoring: boolean;
  busy: boolean;
  onRestore: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  return <li>
    <div className="media-bin-details">
      <h3>{asset.name}</h3>
      <dl><div><dt>Deleted on</dt><dd><time dateTime={asset.deletedAt}>{new Date(asset.deletedAt).toLocaleString()}</time></dd></div></dl>
      <div className="media-bin-actions">
        <Button aria-expanded={expanded} aria-controls={panelId} aria-label={`View usage for ${asset.name}`}
          onClick={() => setExpanded(value => !value)}>View usage</Button>
      </div>
      <div id={panelId} hidden={!expanded}>{expanded ? <VideoUsage {...source} assetId={asset.id} /> : null}</div>
    </div>
    <div className="media-bin-row-actions">
      <Button aria-disabled={busy} aria-label={`Restore ${asset.name}`} onClick={onRestore}>{restoring ? "Restoring…" : "Restore"}</Button>
    </div>
  </li>;
}

export function VideoRecycleBin({ backSearch, ...source }: VideoBinSource & { backSearch: string }) {
  const { getIdToken, sourceId } = source;
  const heading = useRef<HTMLHeadingElement>(null);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursors.at(-1);
  const [page, setPage] = useState<BinnedVideoPage>();
  const [revision, setRevision] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [restoreError, setRestoreError] = useState("");
  const [success, setSuccess] = useState("");
  const [restoring, setRestoring] = useState<string>();

  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setPage(undefined);
      setLoadError("");
      try {
        const token = await getIdToken();
        if (controller.signal.aborted) return;
        const result = await listBinnedVideos(token, sourceId, cursor, controller.signal);
        if (!controller.signal.aborted) setPage(result);
      } catch (failure) {
        if (!controller.signal.aborted) setLoadError(failure instanceof Error ? failure.message : "Try again to load the recycle bin.");
      }
    }
    void load();
    return () => controller.abort();
  }, [cursor, getIdToken, revision, sourceId]);

  function refreshAfterRestore() {
    invalidateVideoSearchCorpus(sourceId);
    setMediaSourceCount(sourceId, null);
    heading.current?.focus();
    setRevision(value => value + 1);
  }

  async function restore(asset: BinnedVideo) {
    if (restoring) return;
    setRestoring(asset.id);
    setRestoreError("");
    setSuccess("");
    try {
      const { originalState, viewingCopyUnavailable } = await restoreBinnedVideo(await getIdToken(), sourceId, asset);
      const originalNotice = originalState === "archived" ? " The original is archived. You can request it from the video details."
        : originalState === "restoring" ? " The archived original is still being retrieved." : "";
      const viewingCopyNotice = viewingCopyUnavailable ? " The viewing copy is unavailable because processing stopped." : "";
      setSuccess(`${asset.name} was restored to the video library.${originalNotice}${viewingCopyNotice}`);
      refreshAfterRestore();
    } catch (failure) {
      setRestoreError(failure instanceof Error ? failure.message : "Try again to restore this video.");
      // A response can be lost after the server commits. Recheck the bin before
      // offering another restore of the same version.
      if (!(failure instanceof HttpError) || failure.status >= 500) {
        refreshAfterRestore();
      }
    } finally {
      setRestoring(undefined);
    }
  }

  return <section aria-labelledby="video-bin-heading">
    <h2 id="video-bin-heading" tabIndex={-1} ref={heading}>Video recycle bin</h2>
    <div className="media-bin-actions">
      <Link to={{ search: backSearch }} state={{ fromVideoBin: true }}>Back to videos</Link>
      <Button disabled={Boolean(restoring)} onClick={() => {
        setRestoreError("");
        setCursors([undefined]);
        setRevision(value => value + 1);
      }}>Refresh bin</Button>
    </div>
    {success ? <InlineMessage tone="success">{success}</InlineMessage> : null}
    {restoreError ? <InlineMessage tone="error" title="Restore could not be confirmed">{restoreError} Use Refresh bin to check the video's current status.</InlineMessage> : null}
    {loadError ? <InlineMessage tone="error" title="Recycle bin could not be loaded">{loadError}</InlineMessage>
      : !page ? <LoadingIndicator label="Loading video recycle bin" />
      : <>
        {page.records.length ? <ul className="media-bin-list" aria-label="Binned videos">
          {page.records.map(asset => <VideoBinRow key={asset.id} {...source} asset={asset}
            restoring={restoring === asset.id} busy={Boolean(restoring)} onRestore={() => void restore(asset)} />)}
        </ul> : <EmptyState title={cursors.length === 1 && !page.nextCursor ? "The video recycle bin is empty" : "No videos on this page"} />}
        {cursors.length > 1 || page.nextCursor ? <nav aria-label="Video recycle bin pages" className="media-bin-actions">
          <Button disabled={Boolean(restoring) || cursors.length === 1} onClick={() => {
            heading.current?.focus();
            setCursors(value => value.slice(0, -1));
          }}>Previous bin page</Button>
          <Button disabled={Boolean(restoring) || !page.nextCursor} onClick={() => {
            heading.current?.focus();
            setCursors(value => [...value, page.nextCursor ?? undefined]);
          }}>Next bin page</Button>
        </nav> : null}
      </>}
  </section>;
}
