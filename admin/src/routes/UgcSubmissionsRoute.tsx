import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useAuth } from "../context/AuthContext";
import { canReviewUgcSubmissions } from "../lib/access";
import { mediaPermalink } from "../lib/media-permalink";
import { mediaImagesPath, mediaVideosPath } from "../lib/routes";
import { useMediaCategories } from "../lib/use-media-categories";
import { getUgcSubmissionPreview, importUgcSubmission, listUgcSubmissions,
  rejectUgcSubmission, type UgcPage, type UgcStatus, type UgcSubmission } from "../lib/ugc-submissions";
import { Button, EmptyState, InlineMessage, Select } from "../components/ui/Primitives";
import { LoadingIndicator } from "../components/ui/LoadingIndicator";
import { useShell } from "./ShellContext";
import { RequireCapability } from "./RequireCapability";
import "./UgcSubmissionsRoute.css";

function dateLabel(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "Time unavailable";
}

function assetPath(asset: NonNullable<UgcSubmission["importedAsset"]>): string {
  return mediaPermalink(asset.kind === "image" ? mediaImagesPath()
    : mediaVideosPath(asset.sourceId ?? "video-library"), asset.id);
}

function Preview({ item, getIdToken }: { item: UgcSubmission; getIdToken: () => Promise<string> }) {
  const [state, setState] = useState<{ url: string; type: string } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setState(null);
    void (async () => {
      try {
        const preview = await getUgcSubmissionPreview(await getIdToken(), item.id);
        if (!active) return;
        setState({ url: preview.url, type: preview.mimeType });
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Preview unavailable");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [getIdToken, item.id]);
  if (loading) return <LoadingIndicator label="Loading private preview" />;
  if (error || !state) return <InlineMessage tone="error" title="Preview unavailable">{error}</InlineMessage>;
  return state.type.startsWith("video/")
    ? <video className="ugc-preview" controls preload="metadata" src={state.url} aria-label={`Preview of ${item.file.name}`} />
    : <img className="ugc-preview" src={state.url} alt={`Private preview of ${item.file.name}`} />;
}

export function UgcSubmissionsRoute() {
  const { principal } = useShell();
  const { getIdToken } = useAuth();
  const allowed = canReviewUgcSubmissions(principal);
  const { state: categoryState } = useMediaCategories(allowed);
  const [filter, setFilter] = useState<UgcStatus | "all">("pending");
  const [page, setPage] = useState<UgcPage | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [category, setCategory] = useState("");
  const [loading, setLoading] = useState(true);
  const [moreLoading, setMoreLoading] = useState(false);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [rejectError, setRejectError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [lastImport, setLastImport] = useState<NonNullable<UgcSubmission["importedAsset"]> | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const rejectErrorElement = useRef<HTMLDivElement>(null);
  const categorySelectionId = useRef<string | null>(null);
  const availableCategories = categoryState.status === "ready"
    ? categoryState.categories.filter((item) => item.active && item.id !== "staff-profile" &&
      (item.canUpload || item.canManage)) : [];
  const selected = page?.records.find((item) => item.id === selectedId) ?? null;
  const canDecide = selected?.status === "pending" || selected?.staleDecision === true;
  const importCategory = selected?.staleDecision ? category : selected?.decisionCategory ?? category;

  useEffect(() => {
    if (rejectError) rejectErrorElement.current?.focus();
  }, [rejectError]);

  useEffect(() => {
    if (!allowed) return;
    let active = true;
    setLoading(true);
    setError("");
    setPage(null);
    setSelectedId(null);
    void (async () => {
      try {
        const result = await listUgcSubmissions(await getIdToken(), filter);
        if (active) {
          setPage(result);
          setSelectedId(result.records[0]?.id ?? null);
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Submissions could not be loaded");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [allowed, filter, getIdToken, revision]);

  useEffect(() => {
    if (!selected) categorySelectionId.current = null;
    if (selected && availableCategories.length > 0 && categorySelectionId.current !== selected.id) {
      categorySelectionId.current = selected.id;
      const recorded = selected.status === "importing" && selected.staleDecision
        ? selected.decisionCategory : null;
      if (recorded && availableCategories.some((item) => item.id === recorded)) {
        setCategory(recorded);
        return;
      }
    }
    if (!availableCategories.some((item) => item.id === category)) {
      setCategory(availableCategories[0]?.id ?? "");
    }
  }, [availableCategories, category, selected]);

  async function loadMore() {
    if (!page?.nextCursor || moreLoading) return;
    setMoreLoading(true);
    setError("");
    try {
      const next = await listUgcSubmissions(await getIdToken(), filter, page.nextCursor);
      setPage({ ...next, records: [...page.records, ...next.records] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "More submissions could not be loaded");
    } finally {
      setMoreLoading(false);
    }
  }

  async function decide(decision: "reject" | "import") {
    if (!selected || busy) return;
    setBusy(true);
    setActionError("");
    setRejectError("");
    try {
      const token = await getIdToken();
      if (decision === "reject") {
        await rejectUgcSubmission(token, selected.id);
        dialog.current?.close();
      } else {
        const result = await importUgcSubmission(token, selected.id, importCategory);
        setLastImport(result.asset);
      }
      setRevision((value) => value + 1);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The decision could not be saved";
      if (decision === "reject") setRejectError(message);
      else setActionError(message);
    } finally {
      setBusy(false);
    }
  }

  return <RequireCapability allowed={canReviewUgcSubmissions} notice="Submission review is not available for your account.">
    <section className="ugc-queue" aria-label="Public submissions">
      <header className="ugc-queue-header">
        <h1>Public submissions</h1>
        <p>Review user-generated content from the public. Check the release and file before adding it to the media library.</p>
        <div className="ugc-queue-toolbar" role="group" aria-label="Submission controls">
          <label>Status
            <Select value={filter} onChange={(event) => setFilter(event.target.value as UgcStatus | "all")}>
              <option value="pending">Pending</option><option value="all">All</option>
              <option value="imported">Imported</option><option value="rejected">Rejected</option>
            </Select>
          </label>
          <Button onClick={() => setRevision((value) => value + 1)}>Refresh submissions</Button>
        </div>
      </header>
      {lastImport ? <InlineMessage tone="success" title="Submission imported">
        <Link to={assetPath(lastImport)}>Open the library asset</Link>
      </InlineMessage> : null}
      {error ? <InlineMessage tone="error" title="Submissions unavailable">{error} <Button onClick={() => setRevision(value => value + 1)}>Try again</Button></InlineMessage> : null}
      {loading ? <LoadingIndicator label="Loading submissions" /> : null}
      {!loading && page && page.records.length === 0 ? <EmptyState title="No submissions" description={`No ${filter === "all" ? "" : `${filter} `}submissions are in this queue.`} /> : null}
      {!loading && page && page.records.length > 0 ? <div className="ugc-queue-layout">
        <div className="ugc-queue-list" aria-label="Submissions">
          {page.records.map((item) => <Button key={item.id}
            className="ugc-queue-item" aria-pressed={selectedId === item.id}
            onClick={() => { setSelectedId(item.id); setActionError(""); }}>
            <strong>{item.name ?? "Name removed"}</strong>
            <span>{item.file.name} · {(item.file.size / (1024 * 1024)).toFixed(1)} MiB</span>
            <span>{item.status} · {dateLabel(item.createdAt)}</span>
          </Button>)}
          {page.nextCursor ? <Button disabled={moreLoading} onClick={() => void loadMore()}>
            {moreLoading ? "Loading more" : "Load more"}</Button> : null}
        </div>
        {selected ? <article className="ugc-queue-detail" aria-label={`Submission from ${selected.name ?? "unknown"}`}>
          <h2>{selected.file.name}</h2>
          <dl>
            <div><dt>Status</dt><dd>{selected.status}</dd></div>
            <div><dt>Submitted</dt><dd>{dateLabel(selected.createdAt)}</dd></div>
            <div><dt>Name</dt><dd>{selected.name ?? "Removed"}</dd></div>
            {selected.status === "pending" ? <div><dt>Email</dt><dd>{selected.email}</dd></div> : null}
            <div><dt>File</dt><dd>{selected.file.type} · {(selected.file.size / (1024 * 1024)).toFixed(1)} MiB</dd></div>
            <div><dt>Consent</dt><dd>{selected.consentVersion} · {dateLabel(selected.consentedAt)}</dd></div>
            <div><dt>Scopes</dt><dd>{Object.entries(selected.scopes).filter(([, value]) => value).map(([key]) => key).join(", ")}</dd></div>
          </dl>
          {selected.message ? <section><h3>Message</h3><p className="ugc-queue-message">{selected.message}</p></section> : null}
          {["pending", "importing", "rejecting"].includes(selected.status) ? <>
            {selected.status === "pending" ? <Preview key={selected.id} item={selected} getIdToken={getIdToken} /> :
              <InlineMessage tone="warning" title="Decision in progress">Retry this decision after 10 minutes if it has not finished.</InlineMessage>}
            {categoryState.status === "loading" ? <LoadingIndicator label="Loading media categories" /> : null}
            {categoryState.status === "error" ? <InlineMessage tone="error" title="Categories unavailable">Categories could not be loaded.</InlineMessage> : null}
            {(selected.status !== "rejecting" || selected.staleDecision) && availableCategories.length > 0 ? <label className="ugc-queue-category">Import category
              <Select value={importCategory} disabled={!canDecide}
                onChange={(event) => setCategory(event.target.value)}>
                {availableCategories.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
              </Select>
            </label> : null}
            {actionError ? <InlineMessage tone="error" title="Decision unavailable">{actionError}</InlineMessage> : null}
            <div className="ugc-queue-actions">
              {selected.status !== "rejecting" || selected.staleDecision ? <Button variant="primary" disabled={busy || !canDecide || !importCategory}
                onClick={() => void decide("import")}>{busy ? "Saving decision" : selected.status === "importing" ? "Resume import" : "Import"}</Button> : null}
              {selected.status !== "importing" || selected.staleDecision ? <Button variant="danger-quiet" disabled={busy || !canDecide}
                onClick={() => { setRejectError(""); dialog.current?.showModal(); }}>{selected.status === "rejecting" ? "Resume rejection" : "Reject"}</Button> : null}
            </div>
          </> : selected.importedAsset ? <Link to={assetPath(selected.importedAsset)}>Open the library asset</Link> : null}
        </article> : null}
      </div> : null}
      <dialog ref={dialog} className="ugc-reject-dialog" aria-labelledby="ugc-reject-title"
        onCancel={(event) => { if (busy) event.preventDefault(); }}>
        <h2 id="ugc-reject-title">Reject submission?</h2>
        <p>The file and contact details will be removed. The decision and consent version stay in the audit record.</p>
        {rejectError ? <div ref={rejectErrorElement} tabIndex={-1}>
          <InlineMessage tone="error" title="Rejection unavailable">{rejectError}</InlineMessage>
        </div> : null}
        <div className="ugc-queue-actions">
          <Button disabled={busy} onClick={() => dialog.current?.close()}>Cancel</Button>
          <Button variant="danger" disabled={busy} onClick={() => void decide("reject")}>{busy ? "Rejecting" : "Reject submission"}</Button>
        </div>
      </dialog>
    </section>
  </RequireCapability>;
}
