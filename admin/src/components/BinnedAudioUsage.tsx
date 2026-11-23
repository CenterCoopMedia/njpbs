import { useEffect, useId, useState } from "react";
import { Link } from "react-router";
import { isPublicPageId } from "../../../packages/content-core/src/public-pages";
import { cmsListBinnedAudioUsage } from "../lib/functions";
import type { BinnedMediaAsset, MediaUsageItem, MediaUsagePage, MediaUsageState } from "../lib/functions-media-types";
import { adminSettingsPath, editPagePath, editRecordPath, postTemplatesPath } from "../lib/routes";
import { Button, InlineMessage, Select } from "./ui/Primitives";
import { LoadingIndicator } from "./ui/LoadingIndicator";

function usagePath({ collection, documentId }: MediaUsageItem): string | undefined {
  if (collection === "cmsPosts") return editRecordPath("post", documentId);
  if (collection === "cmsPages" && isPublicPageId(documentId)) return editPagePath(documentId);
  if (collection === "cmsPostTemplates") return postTemplatesPath(documentId);
  if (collection === "cmsSettings") return adminSettingsPath();
  return undefined;
}

export function BinnedAudioUsage({ asset, getIdToken }: {
  asset: BinnedMediaAsset;
  getIdToken: () => Promise<string>;
}) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<MediaUsageState>("working");
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<MediaUsagePage | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setResult(null);
    setError("");
    async function load() {
      try {
        const token = await getIdToken();
        if (controller.signal.aborted) return;
        const usage = await cmsListBinnedAudioUsage(token, asset.id, state, page, controller.signal);
        if (!controller.signal.aborted) setResult(usage);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Try again to load audio usage.");
      }
    }
    void load();
    return () => controller.abort();
  }, [asset.id, getIdToken, open, page, retry, state]);

  return <>
    <div className="media-bin-actions">
      <Button aria-expanded={open} aria-controls={panelId} aria-label={`View usage for ${asset.name}`}
        onClick={() => setOpen(value => !value)}>View usage</Button>
    </div>
    <div id={panelId} hidden={!open}>
      {open ? <>
        <label>Usage state <Select value={state} onChange={event => {
            setState(event.currentTarget.value as MediaUsageState);
            setPage(1);
          }}>
            <option value="working">Working</option>
            <option value="published">Published</option>
            <option value="deployed">Deployed</option>
          </Select></label>
        {error ? <InlineMessage tone="error" title="Usage could not be loaded">
          <p>{error}</p><Button onClick={() => setRetry(value => value + 1)}>Retry usage</Button>
        </InlineMessage> : !result ? <LoadingIndicator label="Loading audio usage" />
          : result.items.length ? <ul aria-label="Indexed usage">{result.items.map(row => {
            const path = usagePath(row);
            return <li key={`${row.collection}/${row.documentId}`}>{path ? <Link to={path}>{row.title}</Link> : row.title}</li>;
          })}</ul> : <p role="status">No indexed references on this page.</p>}
        {page > 1 || (result?.pageCount ?? 0) > 1 ? <div className="media-bin-actions">
          <Button disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Previous usage page</Button>
          <span>Page {page}</span>
          <Button disabled={!result || page >= result.pageCount} onClick={() => setPage(value => value + 1)}>Next usage page</Button>
        </div> : null}
      </> : null}
    </div>
  </>;
}
