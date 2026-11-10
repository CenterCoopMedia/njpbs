import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useBlocker } from "react-router";
import type { BannerText, ProductionSession } from "../../../packages/content-core/src/live-production";
import { Button, buttonClassName, InlineMessage, Panel, Select, TextInput } from "../components/ui/Primitives";
import { ControlSizingProvider } from "../context/ControlSizingContext";
import { LiveProductionContext, LiveProductionProvider } from "../context/LiveProductionContext";
import { LoadingIndicator } from "../components/ui/LoadingIndicator";
import { ActionControl } from "../components/ui/ActionControl";
import { Icon } from "../components/ui/Icon";
import { canUseLiveProduction } from "../lib/live-production-access";
import {
  bannerLines, clearBlockReason, commandRequest, createLiveProductionClient, liveBlockReason, observedState,
  bannerEditDirty, parseOrderNumber, requestedState, sameText, setupLabel, templateLabel, updateLiveCandidate, liveActionLabel,
  type LiveProductionClient, type LiveRequest, type OrderedBanner,
} from "../lib/live-production-workspace";
import { csvRequestFits, previewBannerCsv } from "../lib/live-production-csv";
import { DEFAULT_CONTENT_QUERY, encodeContentQuery } from "../lib/content-query";
import { liveProductionPath, liveProductionStudioPath } from "../lib/routes";
import { BannerFields, CreateSessionForm, CsvImportForm, NewBannerForm, newBannerDraft, preparationDirty, validBannerText, type PreparationDraft } from "./LiveProductionPreparation";
import { useShell } from "./ShellContext";
import { RequireCapability } from "./RequireCapability";
import { ExitGuardProvider, useExitGuard, useRegisterExitGuard } from "./ExitGuard";
import { LeaveGuardDialog } from "./LeaveGuardDialog";
import styles from "./LiveProductionRoute.css?inline";
import { LiveProductionStudioSetup } from "./LiveProductionStudioSetup";
import { ConnectedLiveProductionDevices } from "../components/LiveProductionDevices";
import { ConnectedStudioConnectorDownload } from "../components/StudioConnectorDownload";
import { initialLiveWorkspaceState, liveWorkspaceReducer, type LiveWorkspaceAction } from "../lib/live-production-state";
import { RundownIntake } from "../components/live-production/RundownIntake";
import { createRundownClient, type RundownClient } from "../lib/rundown-intake";

function errorMessage(error: unknown, commandRefusal = false): string {
  if (error && typeof error === "object" && "status" in error && error.status === 409) {
    if (commandRefusal && error instanceof Error && error.message.trim()) return error.message;
    return "The saved version or studio state changed. Your edit is still here. Refresh, compare the saved text, then try again deliberately.";
  }
  return error instanceof Error ? error.message : "The request could not complete.";
}
function BannerCopy({ text }: { text: BannerText }) {
  return <div className="live-copy">{bannerLines(text).map((line, index) => <p key={index}>{line || "(empty title)"}</p>)}</div>;
}
// Saved or observed text drawn the way a lower third reads on program output.
function LowerThird({ text }: { text: BannerText }) {
  return <div className={`live-lower-third live-lower-third--${text.templateId}`}>
    {bannerLines(text).map((line, index) => <span key={index} className="live-lower-third-line">{line || "(empty title)"}</span>)}
  </div>;
}
function stateLabel(state: ReturnType<typeof observedState>): string {
  return { on_air: "On air", clear: "Clear", stale: "Stale", unknown: "Unknown" }[state];
}
// Tally glance label. Red is program (on air), amber is standby or uncertain, neutral is
// clear. The word carries the meaning; color and the dot only repeat it.
function AirState({ state, compact = false }: { state: ReturnType<typeof observedState>; compact?: boolean }) {
  const label = compact && (state === "stale" || state === "unknown") ? "Uncertain" : stateLabel(state);
  return <strong className={`live-air live-air--${state}`}><span className="live-air-dot" aria-hidden="true" />{label}</strong>;
}
type PreparationRequest = Extract<LiveRequest, { action: "save_banner" | "archive_banner" | "import_csv" | "create_session" }>
  | Extract<LiveRequest, { action: "set_session_state" }> & { state: "ended" };
type PreparationConfirmation = { body: PreparationRequest; title: string; description: string; label: string };
type WorkspaceVariant = "boardwalk" | "studio";
type WorkspaceMode = "show" | "prepare";

function preparationSubject(request: PreparationRequest, sessions: ProductionSession[]): string {
  if (request.action === "create_session") return `Session creation for ${request.title}`;
  const label = { import_csv: "CSV import", save_banner: "banner save", archive_banner: "banner archive", set_session_state: "permanent session end" }[request.action];
  return `A ${label} for ${sessions.find(session => session.id === request.sessionId)?.title ?? request.sessionId}`;
}

// Injectable interface keeps native control and server-owned records outside the view.
export function LiveProductionWorkspace({ client, variant = "boardwalk", deviceSetup, connectorDownload, rundownClient }: { client: LiveProductionClient; variant?: WorkspaceVariant; deviceSetup?: ReactNode; connectorDownload?: ReactNode; rundownClient?: RundownClient }) {
  const retained = useContext(LiveProductionContext);
  // Standalone specimens also get a provider. App keeps its provider above both hosts.
  return retained ? <Workspace client={client} variant={variant} deviceSetup={deviceSetup} connectorDownload={connectorDownload} rundownClient={rundownClient} />
    : <LiveProductionProvider><Workspace client={client} variant={variant} deviceSetup={deviceSetup} connectorDownload={connectorDownload} rundownClient={rundownClient} /></LiveProductionProvider>;
}

function Workspace({ client, variant, deviceSetup, connectorDownload, rundownClient }: { client: LiveProductionClient; variant: WorkspaceVariant; deviceSetup?: ReactNode; connectorDownload?: ReactNode; rundownClient?: RundownClient }) {
  const [sessions, setSessions] = useState<ProductionSession[]>([]);
  const [sessionCursor, setSessionCursor] = useState<string | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [sessionListKey, setSessionListKey] = useState(0);
  const loadedSessionClient = useRef<LiveProductionClient | null>(null);
  const { state: [retained, setRetained], intentNumber } = useContext(LiveProductionContext)!;
  const workspace = retained ?? initialLiveWorkspaceState;
  const restoringSelection = useRef(retained?.selectedId ?? "");
  const dispatch = useCallback((action: LiveWorkspaceAction) => {
    setRetained(current => liveWorkspaceReducer(current ?? initialLiveWorkspaceState, action));
  }, [setRetained]);
  const { sessionId, rows, selectedId, edit: editing, view, requested, failure: unknownAttempt, error, statusError } = workspace;
  const { save: saving, take: sendingTake, update_text: updating, clear: clearing } = workspace.busy;
  const taking = sendingTake || updating;
  const uncertain = Boolean(unknownAttempt && !unknownAttempt.refused);
  const [bannerCursor, setBannerCursor] = useState<string | null>(null);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [notice, setNotice] = useState<string | null>(null);
  // Show keeps the loop to rundown, next banner, observed output, Take and Clear.
  // Prepare adds text, order, archive, import and Studio setup. View state only.
  const [mode, setMode] = useState<WorkspaceMode>("show");
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupResetKey, setSetupResetKey] = useState(0);
  const [setupDirty, setSetupDirty] = useState(false), [setupBusy, setSetupBusy] = useState(false);
  const [rundownDirty, setRundownDirty] = useState(false), [rundownBusy, setRundownBusy] = useState(false);
  const [draftRevision, setDraftRevision] = useState(0);
  const [rundownRefreshing, setRundownRefreshing] = useState(false);
  const rundownState = useCallback((dirty: boolean, busy: boolean) => { setRundownDirty(dirty); setRundownBusy(busy); }, []);
  const [preparation, setPreparation] = useState<PreparationDraft | null>(null);
  const [pendingPreparation, setPendingPreparation] = useState<PreparationRequest | null>(null);
  const [preparationUnknown, setPreparationUnknown] = useState(false);
  const pendingPreparationSession = useRef("");
  const [preparationConfirmation, setPreparationConfirmation] = useState<PreparationConfirmation | null>(null);
  const [connected, setConnected] = useState(() => navigator.onLine && document.visibilityState !== "hidden");
  const [now, setNow] = useState(() => performance.now());
  const [refreshKey, setRefreshKey] = useState(0);
  const [listKey, setListKey] = useState(0);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const locks = useRef({ save: false, take: false, update_text: false, clear: false });
  const editorHeading = useRef<HTMLHeadingElement>(null);
  const sessionToolbar = useRef<HTMLDivElement>(null);
  const studioSetupSummary = useRef<HTMLElement>(null);
  const rundownHeading = useRef<HTMLHeadingElement>(null);
  const statusScroller = useRef<HTMLDivElement>(null);
  const bannerPageController = useRef<AbortController | null>(null);
  const rundownReadEpoch = useRef(0);
  const firstPageSaves = useRef<OrderedBanner[] | null>(null);
  const preserveSelectionOnReset = useRef(false);
  const row = rows.find(item => item.record.id === selectedId) ?? workspace.detachedSelection ?? undefined;
  const selectedBannerRef = useRef(row);
  selectedBannerRef.current = row;
  const selectionUnavailable = workspace.detachedSelection !== null || rundownRefreshing;
  const selectedRequested = requested ?? row?.record.acceptedCommand ?? null;
  const selectedRequestRef = useRef(selectedRequested);
  selectedRequestRef.current = selectedRequested;
  const pending = useRef(false);
  pending.current = taking || clearing || requestedState(selectedRequested, view, now) === "Awaiting observation";
  const liveWriteBusy = (saving && !preparationUnknown) || setupBusy || rundownBusy;
  const bannerDirty = bannerEditDirty(editing);
  const dirty = bannerDirty || preparationDirty(preparation) || Boolean(pendingPreparation) || setupDirty || rundownDirty;
  const takeDirty = bannerDirty || setupDirty || (!pendingPreparation && preparationDirty(preparation));
  const preparationHoldsTake = Boolean(pendingPreparation && pendingPreparation.action !== "create_session" &&
    pendingPreparation.sessionId === sessionId && (pendingPreparation.action === "save_banner" || pendingPreparation.action === "archive_banner") &&
    pendingPreparation.bannerId === selectedId);
  const conflict = Boolean(bannerDirty && editing && row && editing.baseVersion !== row.record.draft.version);
  const requestExit = useExitGuard();
  const hasUnsavedWork = useCallback(() => dirty, [dirty]);
  useRegisterExitGuard({ saving: liveWriteBusy || taking || clearing, hasUnsavedWork });
  const blocker = useBlocker(dirty || saving || taking || clearing || rundownBusy);
  const revealFocusedField = useCallback(() => {
    const field = document.activeElement;
    if (!statusScroller.current?.contains(field) || !(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)) return;
    field.closest("label")?.scrollIntoView?.({ block: "nearest" });
  }, []);

  useLayoutEffect(() => {
    if (statusScroller.current) statusScroller.current.scrollTop = 0;
  }, [mode]);
  useLayoutEffect(revealFocusedField, [mode, dirty, uncertain, revealFocusedField]);
  useLayoutEffect(() => {
    const scroller = statusScroller.current;
    if (!scroller || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(revealFocusedField);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [mode, sessionId, revealFocusedField]);

  useEffect(() => {
    if (!connected) { setSessionsLoading(false); return; }
    // Resume retries an unsuccessful first load; it must not discard paged-in sessions.
    if (loadedSessionClient.current === client) return;
    const controller = new AbortController();
    setSessionsLoading(true); setSessionsError(null);
    void client.sessions(undefined, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      loadedSessionClient.current = client;
      setSessions(result.sessions); setSessionCursor(result.nextCursor);
    }).catch(e => { if (!controller.signal.aborted) setSessionsError(errorMessage(e)); })
      .finally(() => { if (!controller.signal.aborted) setSessionsLoading(false); });
    return () => controller.abort();
  }, [client, connected, sessionListKey]);

  useEffect(() => { dispatch({ type: "invalidate" }); }, [client, sessionId, connected, refreshKey]);

  // One small status request per selected visible session. No per-banner polling.
  useEffect(() => {
    if (!sessionId || !connected) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const requestStartedAt = performance.now();
      let fast = pending.current;
      try {
        const result = await client.session(sessionId, controller.signal);
        if (controller.signal.aborted) return;
        const next = { ...result, requestStartedAt }, receivedAt = performance.now();
        dispatch({ type: "status", view: next }); setNow(receivedAt);
        fast = locks.current.take || locks.current.update_text || locks.current.clear || requestedState(selectedRequestRef.current, next, receivedAt) === "Awaiting observation";
      } catch (e) {
        if (controller.signal.aborted) return;
        dispatch({ type: "status_error", message: errorMessage(e) });
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, fast ? 2_000 : 12_000);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [client, sessionId, connected, refreshKey, selectedRequested?.id]);

  useEffect(() => {
    if (!sessionId) { setRowsLoading(false); return; }
    const controller = new AbortController();
    const epoch = ++rundownReadEpoch.current;
    const savedDuringRead: OrderedBanner[] = [];
    // Keep the current banner after an order reset without reading every page.
    const preserveSelection = preserveSelectionOnReset.current;
    preserveSelectionOnReset.current = false;
    firstPageSaves.current = savedDuringRead;
    bannerPageController.current = controller;
    setRowsLoading(true);
    void (async () => {
      let result = await client.banners(sessionId, undefined, controller.signal);
      const rows = [...result.banners], cursors = new Set<string>();
      // Restore a paged selection from fresh rows, so archived banners do not return.
      while (restoringSelection.current && result.nextCursor && !rows.some(row => row.record.id === restoringSelection.current)) {
        if (controller.signal.aborted) return;
        if (cursors.has(result.nextCursor)) throw new Error("The banner list repeated a page. Refresh the studio.");
        cursors.add(result.nextCursor);
        result = await client.banners(sessionId, result.nextCursor, controller.signal);
        rows.push(...result.banners);
      }
      if (controller.signal.aborted || epoch !== rundownReadEpoch.current) return;
      restoringSelection.current = "";
      const resetSelection = preserveSelection ? selectedBannerRef.current : undefined;
      if (resetSelection && !rows.some(item => item.record.id === resetSelection.record.id)) rows.push(resetSelection);
      dispatch({ type: "banners", rows: [...rows, ...savedDuringRead], replace: true });
      setRundownRefreshing(false);
      setBannerCursor(result.nextCursor);
    })().catch(e => { if (!controller.signal.aborted && epoch === rundownReadEpoch.current) dispatch({ type: "error", message: errorMessage(e) }); })
      .finally(() => {
        if (firstPageSaves.current === savedDuringRead) firstPageSaves.current = null;
        if (!controller.signal.aborted && epoch === rundownReadEpoch.current) setRowsLoading(false);
      });
    return () => {
      if (firstPageSaves.current === savedDuringRead) firstPageSaves.current = null;
      controller.abort(); bannerPageController.current?.abort();
    };
  }, [client, sessionId, listKey]);

  useEffect(() => {
    const timer = setInterval(() => setNow(performance.now()), 1_000);
    function reconcile() {
      dispatch({ type: "invalidate" });
      setConnected(navigator.onLine && document.visibilityState !== "hidden");
      setRefreshKey(key => key + 1);
      setSessionListKey(key => key + 1);
    }
    window.addEventListener("online", reconcile); window.addEventListener("offline", reconcile);
    window.addEventListener("pageshow", reconcile); document.addEventListener("visibilitychange", reconcile);
    return () => {
      clearInterval(timer); window.removeEventListener("online", reconcile); window.removeEventListener("offline", reconcile);
      window.removeEventListener("pageshow", reconcile); document.removeEventListener("visibilitychange", reconcile);
    };
  }, []);
  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) {
      if (dirty || saving || taking || clearing || rundownBusy) { event.preventDefault(); event.returnValue = ""; }
    }
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty, saving, taking, clearing, rundownBusy]);

  function changeSelection(proceed: () => void, leavesSource = false) {
    // Source work and unresolved preparation receipts survive local banner/form
    // changes. Only a session change leaves the mounted source owner.
    const discardedWork = bannerDirty || setupDirty || preparationDirty(preparation) || (leavesSource && rundownDirty);
    if (discardedWork) requestExit(proceed); else proceed();
  }
  function selectSession(id: string) {
    if (liveWriteBusy || taking || clearing || id === sessionId) return;
    changeSelection(() => {
      restoringSelection.current = "";
      dispatch({ type: "session", id }); setPreparation(null); setNotice(null); setBannerCursor(null); setRundownRefreshing(false);
    }, true);
  }
  function selectBanner(item: OrderedBanner) {
    if (liveWriteBusy || taking || (item.record.id === selectedId && !preparation)) return;
    changeSelection(() => {
      if (setupDirty) setSetupResetKey(key => key + 1);
      dispatch({ type: "select", row: item }); setPreparation(null); setNotice(null);
      // Reveal the editor in the phone page flow or reset the tablet pane.
      if (mode === "prepare" && window.matchMedia?.("(max-width: 56.249rem), (orientation: portrait)").matches) requestAnimationFrame(() => {
        const heading = editorHeading.current;
        const pane = heading?.closest(".live-side");
        if (pane) {
          pane.scrollTop = 0;
          const body = pane.querySelector(".live-side-scroll");
          if (body) body.scrollTop = 0;
        }
        heading?.focus({ preventScroll: !window.matchMedia("(max-width: 43.999rem)").matches });
      });
    });
  }
  function save() {
    if (!row || selectionUnavailable || !editing || !bannerDirty || conflict || parseOrderNumber(editing.orderInput) === null || locks.current.save || pendingPreparation) return;
    void runPreparation({ action: "save_banner", sessionId, requestId: crypto.randomUUID(),
      bannerId: row.record.id, baseVersion: editing.baseVersion, text: editing.text, order: parseOrderNumber(editing.orderInput)! });
  }
  function changePreparation(next: PreparationDraft) {
    if (pendingPreparation || saving) return;
    setPreparationConfirmation(null); setPreparation(next);
  }
  function beginPreparation(next: PreparationDraft) {
    if (saving || taking || clearing || pendingPreparation) return;
    changeSelection(() => {
      if (row) dispatch({ type: "select", row });
      setPreparation(next); setNotice(null); dispatch({ type: "error", message: null });
      requestAnimationFrame(() => {
        const form = document.querySelector<HTMLFormElement>(".live-preparation-form");
        // A late entry focus must not interrupt staff already using the form.
        if (form && !form.contains(document.activeElement)) form.querySelector<HTMLElement>("h2, h3")?.focus();
      });
    });
  }
  function cancelPreparation() {
    if (liveWriteBusy) return;
    const closeForm = () => {
      const returnToSetup = preparation?.kind === "session";
      setPreparation(null);
      requestAnimationFrame(() => (returnToSetup ? studioSetupSummary.current : rundownHeading.current)?.focus());
    };
    // Explicit Cancel can discard a form while its request remains unresolved.
    if (pendingPreparation && !bannerDirty) closeForm(); else changeSelection(closeForm);
  }
  async function runPreparation(body: PreparationRequest) {
    if (locks.current.save || !connected || (pendingPreparation && pendingPreparation !== body)) return;
    if (!pendingPreparation) { pendingPreparationSession.current = sessionId; setPreparationUnknown(false); }
    const savedSession = body.action === "create_session" ? pendingPreparationSession.current : body.sessionId;
    const orderChanged = body.action === "save_banner" && Boolean(body.bannerId) &&
      body.order !== rows.find(item => item.record.id === body.bannerId)?.order;
    locks.current.save = true; dispatch({ type: "busy", kind: "save", value: true });
    dispatch({ type: "error", message: null }); setNotice(null); setPendingPreparation(body);
    // Archive does not advance a banner's draft version. Stop older page replies
    // before they can reinsert a row after an archive or archive-first import.
    if (savedSession === sessionRef.current && body.action !== "save_banner") { rundownReadEpoch.current++; bannerPageController.current?.abort(); setRowsLoading(false); }
    try {
      if (body.action === "create_session") {
        const created = await client.createSession(body);
        setSessions(current => [created, ...current.filter(item => item.id !== created.id)]
          .sort((a, b) => b.createdAtMs - a.createdAtMs || a.id.localeCompare(b.id)));
        if (savedSession === sessionRef.current) { dispatch({ type: "session", id: created.id }); setBannerCursor(null); }
        setNotice("Studio session created as a draft. A technician must bind and verify it using the runbook before Take.");
        if (savedSession === sessionRef.current || sessionRef.current === created.id) requestAnimationFrame(() => sessionToolbar.current?.querySelector<HTMLSelectElement>("select")?.focus());
      } else if (body.action === "save_banner") {
        const added = await client.save(body);
        if (savedSession === sessionRef.current) {
          // Preserve saves committed after an already-running first-page read began.
          firstPageSaves.current?.push(added);
          dispatch({ type: body.bannerId ? "saved" : "added", row: added });
          setNotice(body.bannerId ? "Draft saved. Output has not changed." : "Banner added. Output has not changed. Take is a separate action.");
          if (!body.bannerId) requestAnimationFrame(() => editorHeading.current?.focus());
        }
      } else if (body.action === "archive_banner") {
        const archived = await client.archive(body);
        if (savedSession === sessionRef.current) {
          dispatch({ type: "archived", row: archived });
          setNotice("Banner archived. An on-air graphic stays on air; Overlay 1 was not cleared.");
          requestAnimationFrame(() => rundownHeading.current?.focus());
        }
      } else if (body.action === "import_csv") {
        const imported = await client.importCsv(body);
        if (savedSession === sessionRef.current) {
          dispatch({ type: "imported", rows: imported, replace: body.archiveExisting === true });
          if (body.archiveExisting) setBannerCursor(null);
          setNotice(`${imported.length} banners imported${body.archiveExisting ? "; previous banners archived" : ""}. Output has not changed.`);
          requestAnimationFrame(() => rundownHeading.current?.focus());
        }
      } else {
        const ended = await client.endSession(body);
        setSessions(current => current.map(item => item.id === ended.id ? ended : item));
        if (savedSession === sessionRef.current) {
          dispatch({ type: "session_ended", session: ended });
          setNotice("Studio session ended permanently. Overlay 1 was not cleared; use native studio controls for any graphic still on air.");
          requestAnimationFrame(() => studioSetupSummary.current?.focus());
          setRefreshKey(key => key + 1);
        }
      }
      if (savedSession === sessionRef.current && ["save_banner", "archive_banner", "import_csv"].includes(body.action)) setDraftRevision(value => value + 1);
      if (body.action !== "save_banner" || !body.bannerId) setPreparation(null);
      setPendingPreparation(null); setPreparationUnknown(false);
    } catch (e) {
      const refused = Boolean(e && typeof e === "object" && "status" in e && [400, 401, 403, 404, 409, 413].includes(Number(e.status)));
      if (refused) setPendingPreparation(null);
      setPreparationUnknown(!refused);
      dispatch({ type: "error", message: refused ? `Preparation change refused. ${errorMessage(e, preparationUnknown || body.action !== "save_banner" || !body.bannerId)}`
        : `Preparation outcome unknown. ${errorMessage(e)} Retry the same request to confirm its result before another preparation change.` });
    } finally {
      locks.current.save = false; dispatch({ type: "busy", kind: "save", value: false });
      if (savedSession === sessionRef.current && (body.action !== "save_banner" || orderChanged)) {
        // A cursor resolves its row's current order, including an uncertain save.
        // Discard old page replies and restart before continuing past a moved row.
        rundownReadEpoch.current++; bannerPageController.current?.abort(); setRowsLoading(false);
        preserveSelectionOnReset.current = orderChanged;
        setBannerCursor(null); setListKey(key => key + 1);
      }
    }
  }
  function submitPreparation() {
    if (!preparation || saving || pendingPreparation) return;
    const requestId = crypto.randomUUID();
    if (preparation.kind === "banner") {
      const order = parseOrderNumber(preparation.order);
      if (order === null || !validBannerText(preparation.text) || !view || view.session.state === "ended") return;
      void runPreparation({ action: "save_banner", sessionId, requestId, baseVersion: 0, text: preparation.text, order });
    } else if (preparation.kind === "session") {
      if (!preparation.programId || !preparation.title.trim()) return;
      void runPreparation({ action: "create_session", requestId, title: preparation.title,
        productionProgramId: preparation.programId, publicProgramId: preparation.programId });
    } else {
      const preview = previewBannerCsv(preparation.csv);
      if (preparation.fileError || !preview.banners.length || preview.errors.length || !csvRequestFits(preparation.csv, sessionId, preparation.archiveExisting) || !view || view.session.state === "ended") return;
      const body: PreparationRequest = { action: "import_csv", sessionId, requestId, csv: preparation.csv,
        ...(preparation.archiveExisting ? { archiveExisting: true } : {}) };
      if (preparation.archiveExisting) setPreparationConfirmation({ body, title: "Archive current banners and import?",
        description: `This archives every current banner in ${view.session.title}, including banners beyond loaded pages, and imports ${preview.banners.length} new banners together. If it fails, nothing in the rundown changes. An on-air graphic stays on air. Overlay 1 will not be cleared.`, label: "Archive current and import" });
      else void runPreparation(body);
    }
  }
  function confirmArchive() {
    if (!row || selectionUnavailable || !view || saving || taking || preparation || pendingPreparation || view.session.state === "ended") return;
    changeSelection(() => {
      dispatch({ type: "select", row });
      setPreparationConfirmation({ body: { action: "archive_banner", sessionId, requestId: crypto.randomUUID(), bannerId: row.record.id, baseVersion: row.record.draft.version },
        title: "Archive this banner?", description: "This removes the banner from the active rundown. An on-air graphic stays on air. Overlay 1 will not be cleared.", label: "Archive banner" });
    });
  }
  async function send(action: "take" | "update_text" | "clear") {
    if (!view || (action !== "clear" ? liveBlockReason(view, performance.now(), connected) : clearBlockReason(view, connected)) || (action !== "clear" &&
        (!row || selectionUnavailable || preparationHoldsTake || takeDirty || liveWriteBusy || taking || clearing || uncertain || locks.current.take || locks.current.update_text))) return;
    if (action === "update_text" && (!updateLiveCandidate(view, row) ||
      (selectedRequested && requestedState(selectedRequested, view, performance.now()) === "Awaiting observation"))) return;
    if (action === "clear" && locks.current.clear) return;
    const body = commandRequest(view, action, row);
    const intent = ++intentNumber.current;
    const savedSession = sessionId;
    locks.current[action] = true;
    dispatch({ type: "busy", kind: action, value: true });
    setNotice(null);
    try {
      const accepted = await client.command(body);
      if (sessionRef.current !== savedSession) return;
      dispatch({ type: "accepted", command: accepted, intent });
      if (intent === intentNumber.current) setNotice(`${liveActionLabel(action)} requested. Waiting for the Studio connector's observed output.`);
    } catch (e) {
      if (sessionRef.current !== savedSession) return;
      const refused = Boolean(e && typeof e === "object" && "status" in e && [400, 401, 403, 404, 409, 413].includes(Number(e.status)));
      const failure = { action, sequence: body.expectedObservationSequence,
        text: action !== "clear" ? row!.record.draft.text : null, refused, intent,
        message: refused ? `Request refused. ${errorMessage(e, true)}` : `Request outcome unknown. ${errorMessage(e, true)} Check observed output; this workspace will not retry the action.` };
      dispatch({ type: "failed", failure });
    } finally {
      locks.current[action] = false;
      dispatch({ type: "busy", kind: action, value: false });
      setRefreshKey(key => key + 1);
    }
  }
  async function moreBanners() {
    if (!bannerCursor || rowsLoading) return;
    const savedSession = sessionId;
    const epoch = rundownReadEpoch.current;
    const controller = new AbortController();
    bannerPageController.current = controller;
    setRowsLoading(true);
    try {
      const result = await client.banners(sessionId, bannerCursor, controller.signal);
      if (controller.signal.aborted || savedSession !== sessionRef.current || epoch !== rundownReadEpoch.current) return;
      dispatch({ type: "banners", rows: result.banners }); setBannerCursor(result.nextCursor);
    } catch (e) { if (!controller.signal.aborted && savedSession === sessionRef.current && epoch === rundownReadEpoch.current) dispatch({ type: "error", message: errorMessage(e) }); }
    finally { if (!controller.signal.aborted && savedSession === sessionRef.current && epoch === rundownReadEpoch.current) setRowsLoading(false); }
  }
  const state = observedState(view, now);
  const block = liveBlockReason(view, now, connected);
  const report = view?.observed.report;
  const ordered = [...rows].sort((a, b) => a.order - b.order || (a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0));
  const requestStatus = requestedState(selectedRequested, view, now);
  const requestLabel = taking || clearing ? "Sending" : uncertain ? "Outcome unknown" : unknownAttempt?.refused ? "Refused" : requestStatus;
  // Amber standby until the agent observes the request; never red for a request.
  const requestPending = taking || clearing || uncertain || requestStatus === "Awaiting observation" || requestStatus === "Unconfirmed";
  const hasRequest = Boolean(taking || clearing || unknownAttempt || selectedRequested);
  const studio = variant === "studio";
  const preparing = mode === "prepare";
  // Search and the template filter remain Prepare tools. Show keeps every loaded row.
  const visible = preparing ? ordered.filter(item => (filter === "all" || item.record.draft.text.templateId === filter) &&
      bannerLines(item.record.draft.text).join("\n").toLocaleLowerCase().includes(search.toLocaleLowerCase())) : ordered;
  const selectedPosition = visible.findIndex(item => item.record.id === selectedId) + 1;
  const selectedPositionLabel = selectedPosition ? String(selectedPosition) : preparing ? "Outside current filters" : "Outside rundown";
  const preparationBlocked = !connected || !view || view.session.state === "ended" || liveWriteBusy || taking || clearing || Boolean(pendingPreparation) || setupDirty;
  const fieldsDisabled = liveWriteBusy || taking || Boolean(pendingPreparation) || view?.session.state === "ended";
  // A rundown row carries program tally only when the agent's fresh on-air text equals its saved text.
  const onAirText = state === "on_air" && report?.text ? report.text : null;
  const takeDisabled = !row || selectionUnavailable || preparationHoldsTake || Boolean(block) || takeDirty || liveWriteBusy || taking || clearing || uncertain;
  let primaryAction: "take" | "update_text" = "take";
  if (updating || (uncertain && unknownAttempt?.action === "update_text")) primaryAction = "update_text";
  else if (!sendingTake && updateLiveCandidate(view, row)) primaryAction = "update_text";
  const updatePending = Boolean(selectedRequested) && requestStatus === "Awaiting observation";
  const savedStatus = bannerDirty ? "Unsaved changes" : row ? `Saved v${row.record.draft.version}` : "No selection";
  const rundownRefreshHint = rowsLoading ? "Loading the accepted draft before another live action."
    : "Use Refresh studio to load the accepted draft before another live action.";
  const takeHint = !row ? "Select the next banner in the rundown."
    : rundownRefreshing ? rundownRefreshHint
    : selectionUnavailable ? "The selected banner is missing from the refreshed rundown."
    : uncertain ? "Outcome unknown. Check output."
    : bannerDirty ? "Save or discard the draft first."
    : takeDirty ? "Finish or cancel the open form first."
    : preparationHoldsTake ? "A preparation change for this banner is unresolved."
    : block ? `${liveActionLabel(primaryAction)} unavailable: ${block}`
    : primaryAction === "update_text" ? updatePending ? "Update live requested. Wait for observation." : `Update on-air text · Saved v${row.record.draft.version}`
    : `${selectedPositionLabel} · Saved v${row.record.draft.version}`;
  const takeHintIsSelection = Boolean(row) && !selectionUnavailable && !uncertain && !bannerDirty && !takeDirty && !preparationHoldsTake && !block;
  const expandedSide = hasRequest || takeDirty || selectionUnavailable || preparationHoldsTake;
  let pinnedReason = takeHint;
  if (takeHintIsSelection) pinnedReason = taking || clearing ? "Request in progress. Wait for observation." : `Requested action: ${requestLabel}`;

  const studioSetup = (preparing || preparation?.kind === "session" || setupOpen) && <details className="live-studio-setup" hidden={!preparing} onToggle={event => { if (event.currentTarget.open) setSetupOpen(true); }}><summary ref={studioSetupSummary}>Studio setup</summary>
      <p>Reuse the program’s existing session each show. Follow the guided setup to connect the PC and verify its two title inputs once.</p>
      {setupOpen && connectorDownload}
      {preparation?.kind === "session" ? <CreateSessionForm client={client} draft={preparation} disabled={saving || Boolean(pendingPreparation)} submitDisabled={!connected} onChange={changePreparation}
        onSubmit={submitPreparation} onCancel={cancelPreparation} cancelDisabled={liveWriteBusy} /> : <Button disabled={!connected || liveWriteBusy || taking || clearing || setupDirty || Boolean(pendingPreparation)}
        onClick={() => beginPreparation({ kind: "session", programId: "", title: "", suggestedTitle: "" })}>Create studio session</Button>}
      {setupOpen && view && <LiveProductionStudioSetup key={`${view.session.id}:${setupResetKey}`} client={client} view={view} connected={connected} deviceSetup={deviceSetup}
        disabled={saving || taking || clearing || Boolean(pendingPreparation) || Boolean(preparation) || bannerDirty || Boolean(statusError)}
        observedLabel={stateLabel(state)} onDirtyChange={setSetupDirty} onBusyChange={setSetupBusy}
        onRefresh={() => { dispatch({ type: "invalidate" }); setRefreshKey(key => key + 1); }}
        onUpdated={session => { setSessions(current => current.map(item => item.id === session.id ? session : item));
          dispatch({ type: "invalidate" }); setRefreshKey(key => key + 1); }} />}
      {view && <div className="live-end-session"><p>End this session only when retiring the studio setup permanently. It cannot be reopened. Ending does not clear Overlay 1; clear any on-air graphic first if needed.</p>
        <Button variant="danger-quiet" className="live-end-action" disabled={!connected || view.session.state === "ended" || liveWriteBusy || taking || setupDirty || Boolean(preparation) || Boolean(pendingPreparation)} onClick={() => requestExit(() => {
          if (row) dispatch({ type: "select", row });
          setPreparationConfirmation({ body: { action: "set_session_state", sessionId, requestId: crypto.randomUUID(), baseGeneration: view.session.generation, state: "ended" },
            title: "End this studio session permanently?", description: `${view.session.title} cannot be reopened. This is not an end-of-show action. Overlay 1 will not be cleared; any on-air graphic stays on air.`, label: "End studio session permanently" });
        })}>End studio session</Button></div>}
    </details>;

  return <ControlSizingProvider size="comfortable"><div className={`live-workspace live-workspace--${variant} live-workspace--${mode}`}>
    <style>{styles}</style>
    <div ref={sessionToolbar} className="live-top">
      {studio && <Link className={buttonClassName("ghost", "comfortable", "live-exit")} to={liveProductionPath()}><Icon name="chevron-left" />Boardwalk</Link>}
      <label className="live-session"><span className="live-session-label">Production session</span><Select aria-label="Production session" value={sessionId}
        disabled={sessionsLoading || liveWriteBusy || taking || clearing} onChange={event => selectSession(event.target.value)}>
        <option value="">Choose a production session</option>
        {view && !sessions.some(session => session.id === sessionId) && <option value={sessionId}>{view.session.title}{view.session.state === "active" ? "" : ` · ${view.session.state}`}</option>}
        {sessions.map(session => <option key={session.id} value={session.id}>{session.title}{session.state === "active" ? "" : ` · ${session.state}`}</option>)}
      </Select></label>
      {sessionCursor && <Button disabled={sessionsLoading} onClick={async () => {
        setSessionsLoading(true);
        try { const result = await client.sessions(sessionCursor); setSessions(current => [...current,
          ...result.sessions.filter(session => !current.some(prior => prior.id === session.id))]); setSessionCursor(result.nextCursor); }
        catch (e) { setSessionsError(errorMessage(e)); } finally { setSessionsLoading(false); }
      }}>More sessions</Button>}
      <Button className="live-refresh" aria-label="Refresh studio" title="Refresh studio" disabled={rowsLoading || sessionsLoading} onClick={() => {
        dispatch({ type: "error", message: null }); setRefreshKey(key => key + 1); setListKey(key => key + 1); setSessionListKey(key => key + 1);
      }}><Icon name="refresh" /><span>Refresh</span></Button>
      <div className="live-mode" role="group" aria-label="Workspace mode">
        <Button variant="ghost" aria-pressed={!preparing} onClick={() => setMode("show")}>Show</Button>
        <Button variant="ghost" aria-pressed={preparing} onClick={() => setMode("prepare")}>Prepare</Button>
      </div>
      {!studio && <Link className={buttonClassName("ghost", "comfortable", "live-studio-link")} to={liveProductionStudioPath()}><Icon name="maximize" />Studio mode</Link>}
    </div>
    {sessionsLoading && <LoadingIndicator label="Loading production sessions" />}
    {Object.entries(workspace.uncertainSessions).map(([id, failure]) => <InlineMessage key={id} tone="warning">
      Unresolved {liveActionLabel(failure.action)} outcome in {sessions.find(session => session.id === id)?.title ?? id}. Return to that session to reconcile observed output.
    </InlineMessage>)}
    {[error, sessionsError, statusError].filter(Boolean).map((message, index) =>
      <InlineMessage key={index} tone="error" title="Live production needs attention">{message}</InlineMessage>)}
    {notice && <div role="status"><InlineMessage tone="info">{notice}</InlineMessage></div>}
    {pendingPreparation && preparationUnknown && <InlineMessage tone="warning" title="Unresolved preparation change">
      {preparationSubject(pendingPreparation, sessions)} may already be saved.
      Other preparation changes are held. You can cancel the form, select sessions or banners, and Take an unrelated saved banner. Clear Overlay 1 stays available.
      Retry uses the same request and cannot create a second import or session.
      <Button disabled={!connected || saving} onClick={() => void runPreparation(pendingPreparation)}>Retry same preparation request</Button>
    </InlineMessage>}
    {!connected && <InlineMessage tone="warning" title="Offline">Preparation changes are paused until the connection returns.</InlineMessage>}
    {block && sessionId && <InlineMessage tone="warning">Take unavailable: {block}</InlineMessage>}
    {!sessionId ? <Panel className="live-empty"><h2>Choose the show you’re producing</h2><p>Open a session to see the studio’s observed output and its ordered banners.</p>
      {!sessionsLoading && sessions.length === 0 && <p>No production sessions are available yet. Use Prepare to open Studio setup.</p>}</Panel> : <div className="live-main">
      <Panel className="live-rundown">
        <div className="live-panel-heading"><h2 ref={rundownHeading} tabIndex={-1}>Rundown</h2><span className="live-count">{rows.length}{bannerCursor ? "+" : ""} banners</span></div>
        {!preparing && <p className="live-screen-reader" id="live-rundown-help">Select a banner, then use Take saved banner to send it to Overlay 1. Selection alone does not change output.</p>}
        {preparing && <div className="live-rundown-tools"><ActionControl action="add-item" presentation="text" variant="secondary" accessibleName="Add banner" label="Add banner"
          disabled={preparationBlocked} onClick={() => beginPreparation(newBannerDraft(rows))} />
          <Button disabled={preparationBlocked} onClick={() => beginPreparation({ kind: "csv", csv: "", archiveExisting: false, fileError: null })}>Import CSV</Button></div>}
        {preparing && <div className="live-filters"><label>Search<TextInput type="search" value={search} onChange={event => setSearch(event.target.value)} /></label>
          <label>Template<Select aria-label="Template" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All</option><option value="headline">Headline</option><option value="name_title">Name and title</option></Select></label></div>}
        <ol className="live-banner-list" aria-label="Ordered banners" aria-describedby={preparing ? undefined : "live-rundown-help"}>{visible.map((item, index) => {
          const live = Boolean(onAirText && sameText(onAirText, item.record.draft.text));
          const next = selectedId === item.record.id;
          return <li key={item.record.id}>
            <button type="button" className={`live-banner${live ? " live-banner--air" : ""}`} aria-pressed={next} disabled={liveWriteBusy || taking} onClick={() => selectBanner(item)}>
              <span className="live-banner-number">{index + 1}</span>
              <span className="live-banner-body"><span className="live-caption live-row-meta">{templateLabel(item.record.draft.text)} · v{item.record.draft.version}</span><BannerCopy text={item.record.draft.text} /></span>
              {(live || next) && <span className="live-banner-flags">{live && <span className="live-flag live-flag--air">On air</span>}{next && <span className="live-flag live-flag--next">Next</span>}</span>}
            </button></li>;
        })}</ol>
        {rowsLoading && <LoadingIndicator label="Loading banners" />}
        {!rowsLoading && visible.length === 0 && <p>{rows.length ? "No banners match these filters." : "This session has no banners yet."}</p>}
        {bannerCursor && <Button disabled={rowsLoading} onClick={() => void moreBanners()}>Load more banners</Button>}
      </Panel>
      <div className={`live-side${hasRequest ? " live-side--request" : ""}${expandedSide ? " live-side--expanded" : ""}`}>
        {(expandedSide || preparing) && <div className="live-pinned-status">
          <div className="live-pinned-output"><AirState state={state} compact /><span>Overlay 1</span>
            {report?.text ? <BannerCopy text={report.text} /> : <span>{state === "clear" ? "No graphic is visible." : "Current output cannot be confirmed."}</span>}</div>
          {expandedSide && <p className={`live-pinned-reason${unknownAttempt?.refused ? " live-pinned-reason--error" : ""}`}>{pinnedReason}</p>}
        </div>}
        <div className="live-side-scroll" ref={statusScroller} onFocusCapture={revealFocusedField}>
        <div className="live-monitors">
        <Panel className={`live-observed live-observed--${state}`}>
          <div className="live-panel-heading"><h2>Observed output</h2><AirState state={state} /></div>
          <p className="live-monitor-label">Overlay 1 · {report?.source === "manual" ? "Native studio control" : report?.source === "boardwalk" ? "Boardwalk" : "Unattributed"}</p>
          {report?.text && <LowerThird text={report.text} />}
          {state === "clear" && <p className="live-monitor-empty">No graphic is visible on Overlay 1.</p>}
          {(state === "stale" || state === "unknown") && <p className="live-monitor-warning">Current output cannot be confirmed.{report?.text ? " Last reported text is shown above." : ""}</p>}
          <p className="live-monitor-foot">{report ? "Reported by the Studio connector" : "Waiting for a studio observation"}</p>
        </Panel>
        {!preparing && <Panel className="live-next">
          <div className="live-panel-heading"><h2 ref={editorHeading} tabIndex={-1}>Next banner</h2>{row && <span className="live-flag live-flag--next">Selected</span>}</div>
          {row ? <>
            <p className="live-monitor-label">{selectedPositionLabel} · {templateLabel(row.record.draft.text)} · Saved v{row.record.draft.version}</p>
            <LowerThird text={row.record.draft.text} />
            {bannerDirty && <InlineMessage tone="warning">The draft differs from this saved text. Take is unavailable until you save or discard the draft in Prepare.</InlineMessage>}
            {rundownRefreshing ? <InlineMessage tone="warning">{rundownRefreshHint}</InlineMessage>
              : selectionUnavailable && <InlineMessage tone="warning">This banner is outside the refreshed rundown. Your edits are still here in Prepare.</InlineMessage>}
            <div className="live-next-bottom"><p className="live-monitor-foot">Selected for {liveActionLabel(primaryAction)} · Saved text</p><Button className="live-next-edit" onClick={() => setMode("prepare")}><Icon name="pencil" />Edit banner</Button></div>
          </> : <p className="live-monitor-empty">Select the next banner in the rundown.</p>}
        </Panel>}
        </div>
        <div className={`live-status${hasRequest ? " live-status--active" : " live-status--idle"}`}>
        {view && <p className="live-device"><Icon name="monitor" /><span><span className="live-device-prefix">Device: </span>{view.session.deviceId ?? "Not assigned"} · {setupLabel(view)}</span></p>}
        <Panel className={`live-requested${hasRequest ? " live-requested--active" : " live-requested--idle"}`}>
          <div className="live-panel-heading"><h2>Requested action</h2><strong className={requestPending ? "live-request live-request--pending" : "live-request"}>{requestLabel}</strong></div>
          {unknownAttempt?.message && <InlineMessage tone="error" title="Live production needs attention">{unknownAttempt.message}</InlineMessage>}
          {unknownAttempt ? <><p>{liveActionLabel(unknownAttempt.action)} {unknownAttempt.refused ? "refused" : "requested; receipt unavailable"}</p>
            {unknownAttempt.text && <BannerCopy text={unknownAttempt.text} />}</> : selectedRequested ? <><p>{selectedRequested.action === "clear" ? "Clear Overlay 1" : `${liveActionLabel(selectedRequested.action)} · saved version ${selectedRequested.snapshot.version}`}</p>
            {selectedRequested.action !== "clear" && <BannerCopy text={selectedRequested.snapshot.text} />}</> : <p className="live-request-idle">Selection does not change output.</p>}
          {unknownAttempt?.refused && requested && <p className="live-caption">Earlier accepted action: {liveActionLabel(requested.action)} · {requestedState(requested, view, now)}</p>}
          {uncertain && <div className="live-uncertain"><p>Check the studio’s observed output before another live action. Clear Overlay 1 remains available for an active, connected studio, even when output cannot be confirmed.</p>
            <Button disabled={Boolean(block) || !unknownAttempt || !report || report.sequence <= unknownAttempt.sequence} onClick={() => {
              dispatch({ type: "acknowledge", now: performance.now(), connected }); setNotice("Fresh observed output acknowledged. No action was retried.");
            }}>Use fresh observed state</Button></div>}
        </Panel>
        </div>
        {(preparing || preparation?.kind === "csv") && (preparation?.kind === "csv" ? <Panel className="live-editor" hidden={!preparing}><CsvImportForm sessionId={sessionId} draft={preparation} disabled={saving || Boolean(pendingPreparation)} submitDisabled={!connected} onChange={changePreparation}
          onSubmit={submitPreparation} onCancel={cancelPreparation} cancelDisabled={liveWriteBusy} /></Panel> : <Panel className="live-editor">
          {preparation?.kind === "banner" ? <NewBannerForm draft={preparation} disabled={saving || Boolean(pendingPreparation)} submitDisabled={!connected} onChange={changePreparation}
            onSubmit={submitPreparation} onCancel={cancelPreparation} cancelDisabled={liveWriteBusy} onTemplateChange={templateId => changeSelection(() => changePreparation({ ...preparation,
              text: templateId === "headline" ? { templateId, headline: "" } : { templateId, name: "", title: "" } }))} /> : <>
          <div className="live-panel-heading"><h2 ref={editorHeading} tabIndex={-1}>Prepare banner</h2><span>{savedStatus}</span></div>
          {row && editing ? <>
            <div className="live-editor-meta"><p className="live-caption">{templateLabel(editing.text)} · Save draft does not change output. Use Take or Update live deliberately.</p>
              <label>Order number<TextInput inputMode="numeric" value={editing.orderInput} disabled={fieldsDisabled}
                onChange={event => dispatch({ type: "edit", edit: { ...editing, orderInput: event.target.value } })} /></label></div>
            <BannerFields text={editing.text} disabled={fieldsDisabled} onChange={text => dispatch({ type: "edit", edit: { ...editing, text } })} />
            {editing.text.templateId === "name_title" && <p className="live-caption">Update live writes name and title separately. A mixed pair can appear.</p>}
            {parseOrderNumber(editing.orderInput) === null && <InlineMessage tone="error">Enter a whole order number of 1 or more.</InlineMessage>}
            {rundownRefreshing ? <InlineMessage tone="warning">{rundownRefreshHint}</InlineMessage>
              : selectionUnavailable && <InlineMessage tone="warning">This banner is outside the refreshed rundown. Your edits are still here. Copy them before selecting another banner, or load more banners to find it.</InlineMessage>}
            {conflict && <InlineMessage tone="warning">A newer draft is saved. Compare it below. Copy your edits before choosing to use the saved version.</InlineMessage>}
            <div className="live-actions"><Button variant="primary" disabled={!connected || selectionUnavailable || !bannerDirty || conflict || saving || taking || Boolean(pendingPreparation) || parseOrderNumber(editing.orderInput) === null || view?.session.state === "ended"} onClick={() => void save()}>{saving ? "Saving draft…" : "Save draft"}</Button>
              <Button variant="danger-quiet" className="live-archive-action" disabled={!connected || selectionUnavailable || saving || taking || Boolean(preparation) || Boolean(pendingPreparation) || view?.session.state === "ended"} onClick={confirmArchive}>Archive banner</Button></div>
            {bannerDirty && <p className="live-caption">Save your draft before Take. Saving alone never changes output.</p>}
            {bannerDirty && <div className="live-saved"><h3>Saved text · v{row.record.draft.version}</h3><LowerThird text={row.record.draft.text} />
              <Button onClick={() => requestExit(() => dispatch({ type: "select", row }))}>Use saved text</Button></div>}
          </> : <p>Select a banner from the rundown to edit its text or order.</p>}
          </>}
        </Panel>)}
        {studioSetup}
        {rundownClient && <RundownIntake key={sessionId} client={rundownClient} sessionId={sessionId} active={view?.session.state === "active"}
          ended={view?.session.state === "ended"} connected={connected} hidden={!preparing} disabled={saving || taking || clearing || setupBusy || Boolean(pendingPreparation)}
          draftRevision={draftRevision} onStateChange={rundownState} onDraftChanged={() => {
            // Acceptance may move the selected banner beyond the first page. Read
            // through to its saved revision before allowing another live action.
            restoringSelection.current = selectedId;
            preserveSelectionOnReset.current = false;
            rundownReadEpoch.current++; bannerPageController.current?.abort();
            setRundownRefreshing(true); setBannerCursor(null); setListKey(key => key + 1);
          }} />}
        {!preparing && expandedSide && <details className="live-observed-details">
          <summary>Full observed output</summary>
          <AirState state={state} />
          <p>Overlay 1 · {report?.source === "manual" ? "Native studio control" : report?.source === "boardwalk" ? "Boardwalk" : "Unattributed"}</p>
          {report?.text && <BannerCopy text={report.text} />}
          {(state === "stale" || state === "unknown") && <p>Current output cannot be confirmed.{report?.text ? " Last reported text is shown above." : ""}</p>}
          <p>{report ? "Reported by the Studio connector" : "Waiting for a studio observation"}</p>
        </details>}
        </div>
      </div>
    </div>}
    {!sessionId && studioSetup}
    {sessionId && <div className={`live-bar${takeHintIsSelection ? "" : " live-bar--message"}`} role="group" aria-label="Show controls">
      <div className="live-clear-group"><Button variant="danger" className="live-clear" aria-describedby="live-clear-scope" disabled={Boolean(clearBlockReason(view, connected)) || clearing} onClick={() => void send("clear")}>Clear Overlay 1</Button>
        <span id="live-clear-scope" className="live-control-note">Includes studio-selected graphics</span></div>
      <div className="live-bar-status"><span className="live-bar-hint">{takeHintIsSelection && <span className="live-selected-prefix">Selected: </span>}{takeHint}</span></div>
      <div className="live-take-group"><Button variant="primary" className="live-take" disabled={takeDisabled || (primaryAction === "update_text" && updatePending)} onClick={() => void send(primaryAction)}>{updating ? "Requesting update…" : sendingTake ? "Requesting Take…" : primaryAction === "update_text" ? "Update live" : "Take saved banner"}</Button>
        </div>
    </div>}
    {preparationConfirmation && <LeaveGuardDialog title={preparationConfirmation.title} description={preparationConfirmation.description} confirmLabel={preparationConfirmation.label}
      cancelLabel="Cancel" onCancel={() => setPreparationConfirmation(null)} onConfirm={() => {
        const body = preparationConfirmation.body; setPreparationConfirmation(null); void runPreparation(body);
      }} />}
    {blocker.state === "blocked" && <LeaveGuardDialog onConfirm={() => {
      if (row) dispatch({ type: "select", row });
      blocker.proceed();
    }} onCancel={() => blocker.reset()} />}
  </div></ControlSizingProvider>;
}

function ConnectedWorkspace({ variant }: { variant: WorkspaceVariant }) {
  const { getIdToken } = useShell();
  const rundownClient = useMemo(() => createRundownClient(async (endpoint, request, signal) => {
    if (!getIdToken) throw new Error("Sign in again to read the rundown.");
    const { postFunction } = await import("../lib/functions");
    return postFunction(endpoint, await getIdToken(), request, {}, { signal,
      operation: "action" in request && ["accept", "ignore", "set_source"].includes(String(request.action)) ? "content-write" : "content-read" });
  }), [getIdToken]);
  const client = useMemo(() => createLiveProductionClient(async (request, signal) => {
    if (!getIdToken) throw new Error("Sign in again to use live production.");
    const { postFunction } = await import("../lib/functions");
    return postFunction("cmsLiveProduction", await getIdToken(), request, {}, { signal,
      operation: ["list_sessions", "get_session", "list_banners"].includes(request.action) ? "content-read" : "content-write" });
  }, async (page, signal) => {
    if (!getIdToken) throw new Error("Sign in again to load programs.");
    const { postFunction } = await import("../lib/functions");
    const data = await postFunction<{ records: { id: string; title: string; kind: string }[]; pageCount: number }>("cmsListContent", await getIdToken(), {
      query: encodeContentQuery({ ...DEFAULT_CONTENT_QUERY, types: ["program"], sortField: "title", sortDirection: "asc", sortExplicit: true, page }),
    }, {}, { signal, operation: "content-read" });
    if (!Array.isArray(data.records) || data.records.some(record => record.kind !== "program") || !Number.isSafeInteger(data.pageCount) || data.pageCount < 0) throw new Error("Invalid program list.");
    return { programs: data.records.map(({ id, title }) => ({ id, title })), nextPage: page < data.pageCount ? page + 1 : null };
  }, async (cursor, signal) => {
    if (!getIdToken) throw new Error("Sign in again to load paired PCs.");
    const { postFunction } = await import("../lib/functions");
    return postFunction("cmsLiveProductionDevices", await getIdToken(), { action: "list_devices", ...(cursor ? { cursor } : {}) }, {}, { signal, operation: "content-read" });
  }), [getIdToken]);
  return <LiveProductionWorkspace client={client} variant={variant} deviceSetup={<ConnectedLiveProductionDevices />} connectorDownload={<ConnectedStudioConnectorDownload />} rundownClient={rundownClient} />;
}
export function LiveProductionRoute() {
  return <RequireCapability allowed={canUseLiveProduction} notice="Live production is unavailable for this account."><ConnectedWorkspace variant="boardwalk" /></RequireCapability>;
}

function headTag(tag: "meta" | "link", attributes: Record<string, string>): HTMLElement {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}
// The full-screen studio: no Boardwalk rail or header. Home-screen install metadata is
// attached only while this route is mounted, so adding Boardwalk itself to a home screen
// keeps Safari's normal behavior. Sign-in, the capability check and the client are unchanged.
export function StudioFrame({ children }: { children: ReactNode }) {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = "Studio · Boardwalk";
    document.documentElement.setAttribute("data-live-studio", "");
    const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const previousViewport = viewport?.getAttribute("content") ?? null;
    if (viewport && previousViewport && !previousViewport.includes("viewport-fit")) viewport.setAttribute("content", `${previousViewport}, viewport-fit=cover`);
    const added = [
      headTag("link", { rel: "manifest", href: "/studio.webmanifest" }),
      headTag("link", { rel: "apple-touch-icon", href: "/favicon.png" }),
      headTag("meta", { name: "apple-mobile-web-app-capable", content: "yes" }),
      headTag("meta", { name: "mobile-web-app-capable", content: "yes" }),
      headTag("meta", { name: "apple-mobile-web-app-title", content: "Studio" }),
      headTag("meta", { name: "apple-mobile-web-app-status-bar-style", content: "default" }),
    ];
    for (const element of added) document.head.append(element);
    return () => {
      document.title = previousTitle;
      document.documentElement.removeAttribute("data-live-studio");
      if (viewport && previousViewport !== null) viewport.setAttribute("content", previousViewport);
      for (const element of added) element.remove();
    };
  }, []);
  return <main className="live-studio" id="main-content" tabIndex={-1} aria-label="Live production studio">{children}</main>;
}
export function LiveProductionStudioRoute() {
  return <RequireCapability allowed={canUseLiveProduction} notice="Live production is unavailable for this account.">
    <ExitGuardProvider><StudioFrame><ConnectedWorkspace variant="studio" /></StudioFrame></ExitGuardProvider>
  </RequireCapability>;
}
