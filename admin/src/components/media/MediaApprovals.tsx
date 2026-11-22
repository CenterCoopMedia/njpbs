import { useEffect, useRef, useState } from "react";
import { HttpError } from "../../lib/functions";
import { listMediaApprovals, saveMediaApproval, type MediaApprovalPage, type MediaApprovalPurpose } from "../../lib/media-feedback";
import type { MediaAssetRef } from "../../lib/media-identity";
import type { MediaApprovalRendition, MediaApprovalVersions } from "../../lib/source-media";
import { Button, Select } from "../ui/Primitives";

const RENDITIONS = { original: "Original video", viewingCopy: "Web copy" };
const PURPOSES = { editorial: "Editorial review", technical: "Technical review" };

const approvalDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function MediaApprovals({ sourceId, assetId, versions, getIdToken, locked }: {
  sourceId: string;
  assetId: string;
  versions: MediaApprovalVersions;
  getIdToken: () => Promise<string>;
  locked: boolean;
}) {
  const [rendition, setRendition] = useState<MediaApprovalRendition>(versions.original ? "original" : "viewingCopy");
  const [purpose, setPurpose] = useState<MediaApprovalPurpose>("editorial");
  const [page, setPage] = useState<MediaApprovalPage>();
  const [pending, setPending] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [changed, setChanged] = useState(false);
  const controller = useRef<AbortController>();
  const ref: MediaAssetRef = { backend: "s3", sourceId, id: assetId };

  async function load(cursor?: string) {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setPending(true);
    setSaving(false);
    setError("");
    try {
      const next = await listMediaApprovals(await getIdToken(), ref, cursor, request.signal);
      if (!request.signal.aborted) {
        setPage(previous => cursor && previous ? { ...next, history: [...previous.history,
          ...next.history.filter(row => !previous.history.some(existing => existing.id === row.id))] } : next);
      }
    } catch (cause) {
      if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : "Approval history could not be loaded.");
    } finally {
      if (!request.signal.aborted) setPending(false);
    }
  }

  useEffect(() => {
    void load();
    return () => controller.current?.abort();
  }, [sourceId, assetId, getIdToken]);

  const version = versions[rendition];
  const matching = page?.current.find(approval => approval.rendition === rendition &&
    approval.purpose === purpose && approval.version === version);
  const stale = changed || Boolean(page && version !== page.versions[rendition]);

  async function approve() {
    if (!version || !page || matching || stale || pending || saving || locked) return;
    const request = new AbortController();
    controller.current = request;
    setSaving(true);
    setError("");
    try {
      const { approval } = await saveMediaApproval(await getIdToken(), ref, { rendition, purpose, version }, request.signal);
      if (!request.signal.aborted) {
        setPage(previous => previous && { ...previous, current: [...previous.current, approval],
          history: [approval, ...previous.history.filter(row => row.id !== approval.id)]
            .sort((a, b) => b.approvedAt.localeCompare(a.approvedAt) || b.id.localeCompare(a.id)) });
      }
    } catch (cause) {
      if (request.signal.aborted) return;
      if (cause instanceof HttpError && cause.data.code === "media_approval_version_changed") setChanged(true);
      else setError(cause instanceof Error ? cause.message : "Approval could not be recorded.");
    } finally {
      if (!request.signal.aborted) setSaving(false);
    }
  }

  return <>
    <p className="media-feedback-help">Choose the file you reviewed. Use the Download menu to open a specific file.</p>
    <label className="media-feedback-field">File reviewed
      <Select value={rendition} disabled={saving} onChange={event => setRendition(event.target.value as MediaApprovalRendition)}>
        {!versions.original && !versions.viewingCopy ? <option value="viewingCopy">No versioned file available</option> : null}
        {versions.original ? <option value="original">{RENDITIONS.original}</option> : null}
        {versions.viewingCopy ? <option value="viewingCopy">{RENDITIONS.viewingCopy}</option> : null}
      </Select>
    </label>
    <label className="media-feedback-field">Review purpose
      <Select value={purpose} disabled={saving} onChange={event => setPurpose(event.target.value as MediaApprovalPurpose)}>
        <option value="editorial">{PURPOSES.editorial}</option>
        <option value="technical">{PURPOSES.technical}</option>
      </Select>
    </label>
    <p className="media-feedback-status" role="status">{stale ? "The video file changed. Reopen it before recording approval."
      : pending && !page ? "Loading approvals."
      : saving ? "Recording approval."
      : matching ? `Approved by ${matching.approvedByName} for ${PURPOSES[purpose].toLowerCase()}.`
      : page && version ? `This file needs approval for ${PURPOSES[purpose].toLowerCase()}.` : null}</p>
    {error ? <p className="media-feedback-status" role="alert">{error}</p> : null}
    {!page && error ? <Button onClick={() => void load()}>Retry loading approvals</Button> : null}
    {page && version ? <Button variant="primary" aria-disabled={Boolean(matching) || stale || pending || saving || locked}
      onClick={() => void approve()}>Approve selected file</Button> : null}
    {page ? <>
      <h4>Approval history</h4>
      {page.history.length === 0 ? <p className="media-feedback-empty">No approvals recorded.</p> : <ul className="media-feedback-comments">
        {page.history.map(approval => <li key={approval.id} className="media-feedback-comment">
          <strong>{PURPOSES[approval.purpose]} · {RENDITIONS[approval.rendition]}</strong>
          <p className="media-feedback-comment-text">{approval.originalName} · {page.versions[approval.rendition] === approval.version ? "Current version" : "Earlier version"}
            {` (${approval.version.slice(0, 8)})`}</p>
          <p className="media-feedback-comment-meta">{approval.approvedByName} · <time dateTime={approval.approvedAt}>{approvalDate.format(new Date(approval.approvedAt))}</time></p>
        </li>)}
      </ul>}
      {page.nextCursor ? <Button disabled={pending || saving} onClick={() => void load(page.nextCursor ?? undefined)}>
        {pending ? "Loading more approvals" : "Load more approvals"}
      </Button> : null}
    </> : null}
  </>;
}
