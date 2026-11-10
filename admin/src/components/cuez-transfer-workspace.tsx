import { useCallback, useEffect, useId, useLayoutEffect, useReducer, useRef, useState } from "react";
import { Link } from "react-router";
import { renderRichText } from "../../../packages/content-core/src/content-model";
import type { CuezApi, CuezChoice, CuezKind, CuezOperation, CuezPreview, CuezStory } from "../lib/cuez-transfers";
import { initialOperationPages, operationPages } from "../lib/cuez-operation-pages";
import { editRecordPath, guidePath } from "../lib/routes";
import { ActionControl } from "./ui/ActionControl";
import { Button, TextInput, Select, StatusBadge, Tabs } from "./ui/Primitives";
import { LoadingIndicator } from "./ui/LoadingIndicator";
import "./cuez-transfers.css";

type View = "send" | "import" | "transfers";
const stateLabels = { queued: "Queued", transferring: "Sending", complete: "Done", conflict: "Conflict", reconciliation: "Needs review", failed: "Failed" } as const;
const kindLabels: Record<CuezKind, string> = { video: "Video", clip: "Clip", image: "Image", transcript: "Transcript", post: "Post" };

function isOff(error: unknown): boolean {
  return typeof error === "object" && error !== null && "data" in error &&
    (error as { data?: { enabled?: boolean } }).data?.enabled === false;
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "The request could not finish. Try again.";
}

function StorySearch({ api, importing, busy, setBusy, onSelect, onError }: {
  api: CuezApi; importing: boolean; busy: boolean; setBusy: (value: boolean) => void;
  onSelect: (story: CuezStory) => void; onError: (error: unknown) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CuezStory[] | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [searched, setSearched] = useState("");
  async function search(nextPage = 1) {
    setBusy(true);
    try {
      const value = await api.stories(nextPage === 1 ? query : searched, nextPage, importing);
      setResults(value.stories); setPage(value.page); setTotalPages(value.totalPages);
      if (nextPage === 1) setSearched(query);
    } catch (error) { onError(error); }
    finally { setBusy(false); }
  }
  return <div className="cuez-story-search">
    <form onSubmit={event => { event.preventDefault(); void search(); }} className="cuez-search-form">
      <label htmlFor={id}>Search StoryDesk stories</label>
      <div className="cuez-search-controls"><TextInput id={id} value={query} onChange={event => setQuery(event.target.value)} disabled={busy} />
        <Button type="submit" disabled={busy}>Search</Button></div>
    </form>
    {results === null ? <p className="cuez-help">Search by title or description, or search with an empty field to browse.</p> : results.length === 0 ?
      <p role="status" className="cuez-empty">No stories found. Try another search.</p> : <ul className="cuez-choices" aria-label="StoryDesk stories">
        {results.map(story => <li key={story.id}><div><strong>{story.title}</strong><p>{story.descriptionTooLong
          ? "This description is longer than Boardwalk's 10,000-character import limit. Shorten it in StoryDesk before importing."
          : story.description.replace(/\n\[boardwalk-transfer:[a-f0-9]{64}\]$/, "")}</p></div>
          <Button disabled={busy || (importing && story.descriptionTooLong)} onClick={() => onSelect(story)}>{importing ? "Preview import" : "Select story"}<span className="sr-only">: {story.title}</span></Button></li>)}
      </ul>}
    {totalPages > 1 ? <nav className="cuez-paging" aria-label="Story search pages">
      <ActionControl action="previous-page" accessibleName="Previous story search page" disabled={busy || page === 1} onClick={() => void search(page - 1)} />
      <span>Page {page} of {totalPages}</span>
      <ActionControl action="next-page" accessibleName="Next story search page" disabled={busy || page >= totalPages} onClick={() => void search(page + 1)} />
    </nav> : null}
  </div>;
}

export function CuezTransferWorkspace({ api }: { api: CuezApi }) {
  const id = useId();
  const [view, setView] = useState<View>("send");
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [canImport, setCanImport] = useState(false);
  const [requestBusy, setBusy] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const busy = preparing ? "Checking the selected version" : requestBusy;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [kind, setKind] = useState<CuezKind>("video");
  const [items, setItems] = useState<CuezChoice[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [choice, setChoice] = useState<CuezChoice | null>(null);
  const [jobs, setJobs] = useState<CuezChoice[]>([]);
  const [jobCursor, setJobCursor] = useState<string | null>(null);
  const [jobId, setJobId] = useState("");
  const [destination, setDestination] = useState<"new" | "existing">("new");
  const [story, setStory] = useState<CuezStory | null>(null);
  const [prepared, setPrepared] = useState<CuezOperation | null>(null);
  const [preview, setPreview] = useState<CuezPreview | null>(null);
  const [omissionsAccepted, setOmissionsAccepted] = useState(false);
  const [paging, updatePaging] = useReducer(operationPages, initialOperationPages);
  const operations = paging.operations;
  const operationCursor = paging.scans[0]?.cursor;
  const [review, setReview] = useState<CuezOperation | null>(null);
  const statusHeading = useRef<HTMLHeadingElement>(null);
  const focusTransferStatus = useRef(false);
  const itemList = useRef<HTMLUListElement>(null);
  const storySearch = useRef<HTMLDivElement>(null);
  const reviewTrigger = useRef<HTMLButtonElement>(null);
  const outcomeTrigger = useRef<HTMLButtonElement | null>(null);
  const outcomeHeading = useRef<HTMLHeadingElement>(null);
  const operationsPending = useRef(false);
  const [operationsLoading, setOperationsLoading] = useState(false);
  const resourceRequest = useRef(0);
  const resourcePending = useRef(false);
  const outputRequest = useRef(0);
  const preparationRequest = useRef(0);
  const preparationPending = useRef(false);
  const failed = useCallback((failure: unknown) => {
    if (isOff(failure)) { setEnabled(false); setPrepared(null); setPreview(null); }
    else setError(errorText(failure));
  }, []);

  const checkStatus = useCallback(async () => {
    setBusy("Checking StoryDesk status"); setError(null);
    try {
      const status = await api.status(); setEnabled(status.enabled); setCanImport(status.canImport);
      if (!status.canImport) { setDestination("new"); setStory(null); setPrepared(null); setPreview(null); setView(current => current === "import" ? "send" : current); }
    }
    catch (failure) { failed(failure); }
    finally { setBusy(null); }
  }, [api, failed]);
  useEffect(() => { void checkStatus(); }, [checkStatus]);
  useEffect(() => {
    preparationRequest.current++;
    setPrepared(null);
  }, [api, kind, choice, jobId, destination, story, view]);

  const loadResources = useCallback(async (cursor?: string) => {
    const requestId = ++resourceRequest.current;
    resourcePending.current = true;
    setBusy("Loading Boardwalk items"); setError(null);
    try {
      const page = await api.resources(["clip", "transcript"].includes(kind) ? "video" : kind, undefined, cursor);
      if (requestId === resourceRequest.current) { setItems(page.items); setNextCursor(page.nextCursor); }
    } catch (failure) { if (requestId === resourceRequest.current) failed(failure); }
    finally { if (requestId === resourceRequest.current) { resourcePending.current = false; setBusy(null); } }
  }, [api, kind, failed]);
  useEffect(() => {
    if (enabled && view === "send") void loadResources();
    return () => { resourceRequest.current++; if (resourcePending.current) { resourcePending.current = false; setBusy(null); } };
  }, [enabled, view, loadResources]);

  const loadOperations = useCallback(async (cursor?: string, manual = false) => {
    if (operationsPending.current) return;
    operationsPending.current = true;
    setOperationsLoading(true);
    if (cursor || manual) { updatePaging({ type: "loading" }); setError(null); }
    if (cursor) setBusy("Loading older transfers");
    try {
      const page = await api.operations(cursor);
      updatePaging({ type: "page", page, cursor });
    }
    catch (failure) { failed(failure); }
    finally { operationsPending.current = false; setOperationsLoading(false); if (cursor) setBusy(current => current === "Loading older transfers" ? null : current); }
  }, [api, failed]);
  useEffect(() => { if (enabled && view === "transfers") void loadOperations(); }, [enabled, view, loadOperations]);
  useEffect(() => {
    if (!enabled || view !== "transfers" || !operations.some(operation => operation.state === "transferring")) return;
    const timer = window.setTimeout(() => { void loadOperations(); }, 3000);
    return () => window.clearTimeout(timer);
  }, [enabled, view, operations, loadOperations]);
  useEffect(() => {
    if (review) { outcomeHeading.current?.focus(); outcomeHeading.current?.scrollIntoView?.({ block: "nearest" }); }
  }, [review]);
  useLayoutEffect(() => {
    if (paging.focusStatus) updatePaging({ type: "focused" });
    if (view === "transfers" && (focusTransferStatus.current || paging.focusStatus)) {
      focusTransferStatus.current = false;
      statusHeading.current?.focus();
    }
  }, [view, operations, paging.focusStatus]);

  async function choose(item: CuezChoice) {
    outputRequest.current++;
    setChoice(item); setJobId(""); setJobs([]); setJobCursor(null); setPrepared(null);
    if (!["clip", "transcript"].includes(kind)) return;
    await loadOutputs(item);
  }
  async function loadOutputs(item: CuezChoice, cursor?: string) {
    const request = ++outputRequest.current;
    setBusy("Loading prepared outputs"); setError(null);
    try {
      const page = await api.resources(kind, item.resource.id, cursor);
      if (request !== outputRequest.current) return;
      setJobs(current => cursor ? [...current, ...page.items] : page.items);
      setJobCursor(page.nextCursor);
    }
    catch (failure) { if (request === outputRequest.current) failed(failure); }
    finally { if (request === outputRequest.current) setBusy(current => current === "Loading prepared outputs" ? null : current); }
  }
  const selected = choice ? { kind, id: choice.resource.id, ...(["clip", "transcript"].includes(kind) ? { jobId } : {}) } : null;
  const readyToPrepare = !!selected && (!["clip", "transcript"].includes(kind) || !!jobId) && (destination === "new" || !!story);
  async function prepare() {
    if (!selected || !readyToPrepare || preparationPending.current) return;
    const request = ++preparationRequest.current;
    preparationPending.current = true;
    setPreparing(true); setError(null);
    try {
      const result = await api.prepare(selected, destination === "new" ? { kind: "new-story" }
        : { kind: kind === "transcript" ? "dossier" : "story-asset", storyId: story!.id });
      if (request === preparationRequest.current) setPrepared(result.operation);
    }
    catch (failure) { if (request === preparationRequest.current) failed(failure); }
    finally { preparationPending.current = false; setPreparing(false); }
  }
  async function showPreview(selectedStory: CuezStory) {
    setBusy("Reading the story and its documents"); setError(null); setPreview(null); setOmissionsAccepted(false);
    try { setPreview(await api.preview(selectedStory.id)); }
    catch (failure) { failed(failure); }
    finally { setBusy(null); }
  }
  async function transfer(action: "send" | "confirm" | "retry" | "reconcile", operationId: string, closePartial = false) {
    setBusy(action === "confirm" ? "Saving a private draft" : action === "reconcile" ? "Checking the transfer outcome" : action === "retry" ? "Retrying the transfer" : "Sending to StoryDesk");
    setError(null); setNotice(null);
    try {
      const result = (await (action === "reconcile" ? api.reconcile(operationId, closePartial) : api[action](operationId))).operation;
      focusTransferStatus.current = true;
      updatePaging({ type: "result", operation: result });
      setPrepared(null); setPreview(null); setReview(null); setView("transfers");
      setNotice(result.partialAcknowledged ? "Marked as done with what was sent. Later revised exports will reuse the confirmed story."
        : action === "reconcile" && result.state === "reconciliation" ? "Your review is recorded. The result still needs review."
        : result.state === "complete" ? result.direction === "import" ? "The private draft is ready to review." : "The transfer is done." : result.message ?? "Transfer status updated.");
    } catch (failure) { failed(failure); }
    finally { setBusy(null); }
  }

  const panels = [{ value: "send", label: "Send", panelId: `${id}-send` }, { value: "import", label: "Import", panelId: `${id}-import`, disabled: !canImport },
    { value: "transfers", label: "Transfers", panelId: `${id}-transfers` }] as const;
  return <section className="cuez-workspace" aria-label="StoryDesk transfers" aria-busy={!!busy}>
    <div className="cuez-intro"><p>Choose what to send to StoryDesk, or bring a story into Boardwalk as a private draft.</p>
      <div className="cuez-actions"><Link className="cuez-draft-link" to={guidePath("storydesk-transfers")}>Transfer guide</Link>
        <ActionControl action="refresh" accessibleName="Refresh StoryDesk availability" disabled={!!busy} onClick={() => void checkStatus()} /></div></div>
    {error || paging.error ? <div role="alert" className="cuez-alert">{error || paging.error}</div> : null}
    {busy ? <div className="cuez-progress"><LoadingIndicator label={busy} /></div> : null}
    {enabled === false ? <div className="cuez-disabled"><h2>Transfers are turned off</h2><p>An administrator can enable StoryDesk transfers. Refresh availability after they do.</p></div> : null}
    {enabled ? <>
      <Tabs id={id} label="StoryDesk workflow" value={view} options={panels} onChange={next => { setView(next); setError(null); setNotice(null); }} />
      {notice ? <p className="cuez-notice" role="status">{notice}</p> : null}
      <div id={`${id}-send`} role="tabpanel" aria-labelledby={`${id}-tab-send`} hidden={view !== "send"}>
        <div className="cuez-toolbar"><label htmlFor={`${id}-kind`}>Send a</label>
          <Select id={`${id}-kind`} value={kind} disabled={!!busy} onChange={event => {
            outputRequest.current++; setJobCursor(null);
            setKind(event.target.value as CuezKind); setChoice(null); setJobs([]); setJobId(""); setPrepared(null); setItems([]); setDestination("new");
          }}>{Object.entries(kindLabels).map(([value, label]) => <option value={value} key={value}>{label.toLowerCase()}</option>)}</Select>
          <span className="cuez-help">{kind === "clip" ? "Choose a video, then a ready web clip." : kind === "transcript" ? "Choose a video, then a cached transcript." : kind === "post" ? "Send the title, summary, credit, and any published link." : "Media uses web or viewing versions."}</span>
        </div>
        <div className="cuez-columns">
          <section className="cuez-pane"><h2>Choose a Boardwalk item</h2>
            {items.length ? <ul ref={itemList} className="cuez-choices" aria-label="Boardwalk items">{items.map(item => <li key={item.resource.id}>
              <label className="cuez-item-choice"><input type="radio" name={`${id}-item`} checked={choice?.resource.id === item.resource.id} disabled={!!busy}
                onChange={() => void choose(item)} /><span><strong>{item.label}</strong>{item.detail ? <small>{item.detail}</small> : null}</span></label>
            </li>)}</ul> : !busy ? <p className="cuez-empty">No accessible items on this page.</p> : null}
            <div className="cuez-paging"><ActionControl action="refresh" accessibleName="Reload Boardwalk items from the beginning" disabled={!!busy} onClick={() => void loadResources()} />
              {nextCursor ? <Button disabled={!!busy} onClick={() => void loadResources(nextCursor)}>More items</Button> : null}</div>
          </section>
          <section className="cuez-pane"><h2>Destination and review</h2>
            {choice ? <div className="cuez-selection"><strong>{choice.label}</strong><ActionControl action="remove-item" accessibleName="Clear the selected Boardwalk item" disabled={!!busy} onClick={() => {
              outputRequest.current++;
              const input = itemList.current?.querySelector<HTMLInputElement>("input:checked"); setChoice(null); setPrepared(null); input?.focus();
            }} /></div>
              : <p className="cuez-help">Select an item to prepare its transfer.</p>}
            {choice && ["clip", "transcript"].includes(kind) ? <div className="cuez-field"><label htmlFor={`${id}-output`}>{kind === "clip" ? "Ready clip" : "Cached transcript"}</label>
              <Select id={`${id}-output`} value={jobId} disabled={!!busy} onChange={event => { setJobId(event.target.value); setPrepared(null); }}><option value="">Choose an output</option>
                {jobs.map(job => <option key={job.resource.jobId} value={job.resource.jobId}>{job.label} — {job.detail}</option>)}</Select>
              {jobCursor ? <Button disabled={!!busy} onClick={() => void loadOutputs(choice, jobCursor)}>More outputs</Button> : null}
              {!jobs.length && !jobCursor && !busy ? <span className="cuez-help">No ready outputs. Prepare one in the media library, then return here.</span> : null}
            </div> : null}
            <fieldset className="cuez-destination" disabled={!!busy}><legend>StoryDesk destination</legend>
              <label><input type="radio" name={`${id}-destination`} checked={destination === "new"} onChange={() => { setDestination("new"); setPrepared(null); }} />Create or update a story</label>
              {kind !== "post" ? <label><input type="radio" name={`${id}-destination`} checked={destination === "existing"} disabled={!canImport} onChange={() => { setDestination("existing"); setPrepared(null); }} />Existing story</label> : null}
            </fieldset>
            {!canImport ? <p className="cuez-help">Searching existing stories requires permission to create a Post.</p> : null}
            {destination === "existing" && canImport ? <div ref={storySearch}>{story ? <div className="cuez-selection"><a href={story.link} target="_blank" rel="noopener noreferrer">{story.title}</a>
              <ActionControl action="remove-item" accessibleName="Clear the selected StoryDesk story" disabled={!!busy} onClick={() => { setStory(null); setPrepared(null); storySearch.current?.querySelector("input")?.focus(); }} /></div> : null}
              <StorySearch api={api} importing={false} busy={!!busy} setBusy={value => setBusy(value ? "Searching stories" : null)} onSelect={value => { setStory(value); setPrepared(null); }} onError={failed} /></div> : null}
            <p className="cuez-help">A repeat transfer updates the story or dossier sent before. Media assets are added. A transcript becomes a dossier.</p>
            {prepared ? <div className="cuez-review"><h3>Review transfer</h3><p>Send {choice?.label} to {destination === "existing" ? story?.title : "a new or previously linked StoryDesk story"}?</p>
              <div className="cuez-actions"><Button variant="primary" disabled={!!busy} onClick={() => void transfer("send", prepared.operationId)}>Send to StoryDesk</Button>
                <Button disabled={!!busy} onClick={() => { setPrepared(null); window.requestAnimationFrame(() => reviewTrigger.current?.focus()); }}>Back</Button></div></div>
              : <Button ref={reviewTrigger} variant="primary" disabled={!!busy || !readyToPrepare} onClick={() => void prepare()}>Review transfer</Button>}
          </section>
        </div>
      </div>
      <div id={`${id}-import`} role="tabpanel" aria-labelledby={`${id}-tab-import`} hidden={view !== "import"}>
        <div className="cuez-columns"><section className="cuez-pane"><h2>Choose a StoryDesk story</h2>
          <StorySearch api={api} importing busy={!!busy} setBusy={value => setBusy(value ? "Searching stories" : null)} onSelect={value => void showPreview(value)} onError={failed} />
        </section><section className="cuez-pane"><h2>Preview the private draft</h2>
          {preview ? <><h3 className="cuez-story-title">{preview.story.title}</h3><p>{preview.story.description}</p>
            <a href={preview.story.link} target="_blank" rel="noopener noreferrer">View the original StoryDesk story</a>
            <div className="cuez-preview-doc"><h3>Brief</h3><div dangerouslySetInnerHTML={{ __html: renderRichText(preview.brief, { headingLevelOffset: 2, minimumHeadingLevel: 3 }) }} />
              {preview.dossiers.map(dossier => <section key={dossier.id}><h3>{dossier.title}</h3><div dangerouslySetInnerHTML={{ __html: renderRichText(dossier.document, { headingLevelOffset: 2, minimumHeadingLevel: 3 }) }} /></section>)}
            </div>
            <div className="cuez-warning"><h3>Review what is omitted</h3><ul>{preview.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></div>
            <label className="cuez-check"><input type="checkbox" checked={omissionsAccepted} disabled={!!busy} onChange={event => setOmissionsAccepted(event.target.checked)} />I reviewed these omissions.</label>
            <p className="cuez-help">This saves a private draft. If it was imported before, Boardwalk updates the same draft only while it is unchanged.</p>
            <Button variant="primary" disabled={!!busy || !omissionsAccepted} onClick={() => void transfer("confirm", preview.operation.operationId)}>Confirm private draft import</Button>
          </> : <p className="cuez-empty">Preview a story to review its Brief, dossiers, source link, and omissions before importing.</p>}
        </section></div>
      </div>
      <div id={`${id}-transfers`} role="tabpanel" aria-labelledby={`${id}-tab-transfers`} hidden={view !== "transfers"}>
        <div className="cuez-transfer-heading"><h2 ref={statusHeading} tabIndex={-1}>Your transfers</h2><ActionControl action="refresh" accessibleName="Refresh transfer status"
          disabled={operationsLoading ? false : !!busy} aria-disabled={operationsLoading || undefined} aria-busy={operationsLoading || undefined}
          onClick={() => { if (!operationsLoading) void loadOperations(undefined, true); }} /></div>
        <p className="cuez-help">Queued transfers await confirmation. Conflicts preserve both versions. Transfers that need review require a StoryDesk check before further action.</p>
        {operations.length ? <ul className="cuez-operation-list">{operations.map(operation => <li key={operation.operationId}>
          <div><strong>{operation.label ?? (operation.direction === "import" ? "Story import" : `${kindLabels[operation.kind as CuezKind] ?? "Item"} export`)}</strong>
            <small>{operation.direction === "import" ? "Story import" : `${kindLabels[operation.kind as CuezKind] ?? "Item"} export`} · Transfer {operation.operationId.slice(0, 10)}{operation.updatedAt ? ` · ${new Date(operation.updatedAt).toLocaleString()}` : ""}</small>
            {operation.message ? <p>{operation.message}</p> : null}
            {operation.partialAcknowledged ? <p>Marked as done with what was sent. The confirmed story is kept for later revised exports.</p> : null}</div>
          <StatusBadge tone={operation.state === "complete" ? "success" : operation.state === "failed" || operation.state === "conflict" ? "failed" : "pending"} presentation="inline">{stateLabels[operation.state]}</StatusBadge>
          <div className="cuez-actions">{operation.draftId ? <Link className="cuez-draft-link" to={editRecordPath("post", operation.draftId)}>Open private draft</Link> : null}
            {operation.canRetry ? <Button disabled={!!busy} onClick={() => void transfer("retry", operation.operationId)}>Retry transfer</Button> : null}
            {operation.canClosePartial ? <Button disabled={!!busy} onClick={event => { outcomeTrigger.current = event.currentTarget; setReview(operation); }}>Mark as done with what was sent</Button> : null}
            {["reconciliation", "transferring"].includes(operation.state) ? <Button disabled={!!busy} onClick={event => { outcomeTrigger.current = event.currentTarget; setReview(operation); }}>Review outcome</Button> : null}</div>
          {review?.operationId === operation.operationId ? <div className="cuez-review cuez-outcome-review"><h3 ref={outcomeHeading} tabIndex={-1}>{operation.canClosePartial ? "Review the partial transfer" : "Check the outcome in StoryDesk"}</h3>
            <p>{operation.canClosePartial ? "The confirmed story and any completed dossier will stay linked. Close this attempt and use a new selection to send later revisions. The original status and error remain visible."
              : "Review this item in StoryDesk, then acknowledge your review. Boardwalk checks for a confirmed result. An uncertain media import stays in Needs review."}</p>
            <div className="cuez-actions"><Button variant="primary" disabled={!!busy} onClick={() => void transfer("reconcile", operation.operationId, !!operation.canClosePartial)}>{operation.canClosePartial ? "Keep what was sent" : "I checked StoryDesk"}</Button>
              <Button disabled={!!busy} onClick={() => { setReview(null); window.requestAnimationFrame(() => outcomeTrigger.current?.focus()); }}>Cancel</Button></div></div> : null}
        </li>)}</ul> : <p className="cuez-empty">{operationCursor ? "No transfers are available on this page." : "No transfers yet. Send a selected item or preview a story to start."}</p>}
        {operationCursor ? <Button disabled={operationsLoading ? false : !!busy} aria-disabled={operationsLoading || undefined} aria-busy={operationsLoading || undefined}
          onClick={() => { if (!operationsLoading) void loadOperations(operationCursor); }}>More transfers</Button> : null}
      </div>
    </> : null}
    {enabled === null && !busy && error ? <Button onClick={() => void checkStatus()}>Try status again</Button> : null}
  </section>;
}
