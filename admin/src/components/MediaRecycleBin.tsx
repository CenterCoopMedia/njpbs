import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { cmsListBinnedMedia, cmsRestoreMedia, HttpError, type BinnedMediaAsset, type ListBinnedMediaResponse, type MediaCategoryDefinition } from "../lib/functions";
import { mediaDisplayUrl } from "../lib/media-image";
import { mediaImagesPath } from "../lib/routes";
import { Button, EmptyState, InlineMessage } from "./ui/Primitives";
import { LoadingIndicator } from "./ui/LoadingIndicator";
import "./MediaRecycleBin.css";

export function removalCountdown(purgeAfter: string, now: number): string {
  const days = Math.max(0, Math.ceil((Date.parse(purgeAfter) - now) / 86_400_000));
  if (!Number.isFinite(days)) return "Removal date unavailable";
  return days === 0 ? "Due for removal" : `Removed in ${days} ${days === 1 ? "day" : "days"}`;
}

export function MediaRecycleBin({ getIdToken, categories, targetId = null }: {
  getIdToken: () => Promise<string>;
  categories: readonly MediaCategoryDefinition[];
  targetId?: string | null;
}) {
  const [searchParams] = useSearchParams();
  const returnParams = new URLSearchParams(searchParams);
  returnParams.delete("bin");
  returnParams.delete("binAsset");
  const [result, setResult] = useState<ListBinnedMediaResponse | null>(null);
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [restoreError, setRestoreError] = useState("");
  const [success, setSuccess] = useState("");
  const [restoring, setRestoring] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const [missingTarget, setMissingTarget] = useState(false);
  const searchedTarget = useRef<string | null>(null);
  const focusTargetOnLoad = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const target = useRef<HTMLLIElement>(null);

  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => { setSuccess(""); }, [getIdToken, targetId]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    async function load() {
      try {
        const token = await getIdToken();
        if (controller.signal.aborted) return;
        const findTarget = targetId && searchedTarget.current !== targetId;
        const firstPage = await cmsListBinnedMedia(token, { page: findTarget ? 1 : page }, controller.signal);
        let response = firstPage;
        // Upload conflicts disclose an id, but the bin endpoint has no id filter.
        // Search bounded pages only after the user follows that explicit pointer.
        while (findTarget && !response.records.some(asset => asset.id === targetId) && response.page < response.pageCount) {
          if (controller.signal.aborted) return;
          response = await cmsListBinnedMedia(token, { page: response.page + 1 }, controller.signal);
        }
        if (controller.signal.aborted) return;
        if (findTarget) {
          searchedTarget.current = targetId;
          const found = response.records.some(asset => asset.id === targetId);
          setMissingTarget(!found);
          focusTargetOnLoad.current = found;
          if (!found) response = firstPage;
        }
        setResult(response);
        setNow(Date.now());
        setLoading(false);
      } catch (failure) {
        if (controller.signal.aborted) return;
        setError(failure instanceof Error ? failure.message : "The recycle bin could not be loaded.");
        setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [getIdToken, page, revision, targetId]);

  useEffect(() => {
    if (loading) return;
    if (focusTargetOnLoad.current) target.current?.focus();
    else heading.current?.focus();
    focusTargetOnLoad.current = false;
  }, [loading]);

  function refresh(nextPage = result?.page ?? page) {
    setSuccess("");
    setRestoreError("");
    setPage(nextPage);
    setRevision(value => value + 1);
  }

  async function restore(asset: BinnedMediaAsset) {
    if (restoring) return;
    setRestoring(asset.id);
    setRestoreError("");
    setSuccess("");
    try {
      await cmsRestoreMedia(await getIdToken(), asset);
      setSuccess(`Restored “${asset.name}” to the image library.`);
      setPage(result?.page ?? 1);
      setRevision(value => value + 1);
      heading.current?.focus();
    } catch (failure) {
      const message = failure instanceof HttpError && failure.status === 412
        ? "This image changed since the bin was loaded."
        : failure instanceof Error ? failure.message : "The image could not be restored. Try again.";
      setRestoreError(`${asset.name}: ${message}`);
    } finally {
      setRestoring(null);
    }
  }

  const records = [...(result?.records ?? [])].sort((a, b) => a.purgeAfter.localeCompare(b.purgeAfter) || a.id.localeCompare(b.id));
  return <section aria-labelledby="recycle-bin-heading">
    <h2 id="recycle-bin-heading" tabIndex={-1} ref={heading}>Recycle bin</h2>
    <p>Deleted images stay in the bin for 30 days. Restore an image to use it again.</p>
    <div className="media-bin-actions">
      <Link to={{ pathname: mediaImagesPath(), search: returnParams.toString() }}>Back to Images</Link>
      <Button disabled={loading || restoring !== null} onClick={() => refresh()}>Refresh bin</Button>
    </div>
    {success ? <InlineMessage tone="success">{success}</InlineMessage> : null}
    {restoreError ? <InlineMessage tone="error" title="Image was not restored">{restoreError} Use Refresh bin to check the image's current status.</InlineMessage> : null}
    {loading ? <LoadingIndicator label="Loading recycle bin" /> : error ? <InlineMessage tone="error" title="Recycle bin could not be loaded">{error}</InlineMessage> : <>
      {missingTarget ? <InlineMessage tone="warning">The matching image is no longer in this bin, or you do not have permission to manage media.</InlineMessage> : null}
      {records.length === 0 ? <EmptyState title="The recycle bin is empty" description="Deleted images you can manage will appear here." /> : <ul className="media-bin-list" aria-label="Binned images">
        {records.map(asset => <li key={asset.id} tabIndex={asset.id === targetId ? -1 : undefined} ref={asset.id === targetId ? target : undefined} aria-label={asset.name}>
          <img src={mediaDisplayUrl(asset, 96)} alt="" width={96} height={72} loading="lazy" />
          <div className="media-bin-details">
            <h3>{asset.name}</h3>
            <dl>
              <div><dt>Category</dt><dd>{categories.find(category => category.id === asset.category)?.label ?? asset.category}</dd></div>
              <div><dt>Deleted by</dt><dd>{asset.tombstonedByName?.trim() || "A staff member"}</dd></div>
              <div><dt>Deleted on</dt><dd>{asset.tombstonedAt ? <time dateTime={asset.tombstonedAt}>{new Date(asset.tombstonedAt).toLocaleString()}</time> : "Unknown"}</dd></div>
            </dl>
            <p>{asset.lifecycle === "purging" ? "Being removed" : removalCountdown(asset.purgeAfter, now)}</p>
          </div>
          {asset.lifecycle === "tombstoned" ? <Button disabled={restoring !== null} aria-label={`${restoring === asset.id ? "Restoring" : "Restore"} ${asset.name}`} onClick={() => void restore(asset)}>{restoring === asset.id ? "Restoring…" : "Restore"}</Button> : null}
        </li>)}
      </ul>}
      {result && result.pageCount > 1 ? <nav aria-label="Recycle bin pages" className="media-bin-actions">
        <Button disabled={result.page <= 1 || restoring !== null} onClick={() => refresh(result.page - 1)}>Previous bin page</Button>
        <span>Page {result.page} of {result.pageCount}</span>
        <Button disabled={result.page >= result.pageCount || restoring !== null} onClick={() => refresh(result.page + 1)}>Next bin page</Button>
      </nav> : null}
    </>}
  </section>;
}
