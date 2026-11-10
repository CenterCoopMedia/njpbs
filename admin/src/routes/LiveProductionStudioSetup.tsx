import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ProductionSession } from "../../../packages/content-core/src/live-production";
import { Button, InlineMessage, Select, TextInput } from "../components/ui/Primitives";
import { connectorSetup, parseStudioInputs, STUDIO_INPUT_FILE_LIMIT, studioInputFields } from "../lib/live-production-setup";
import type { LiveProductionClient, LiveRequest, SessionStateRequest, StudioDevice, StudioInputs, TimedSessionView } from "../lib/live-production-workspace";

type MappingRequest = Extract<LiveRequest, { action: "set_mapping" }>;
type SetupRequest = MappingRequest | SessionStateRequest;
const stateOrder = { draft: 0, ready: 1, active: 2, ended: 3 };
type Draft = { deviceId: string; details: StudioInputs | null; confirmed: boolean; baseMappingVersion: number };

export function LiveProductionStudioSetup({ client, view, connected, disabled, observedLabel, deviceSetup, onDirtyChange, onBusyChange, onUpdated, onRefresh }: {
  client: LiveProductionClient; view: TimedSessionView; connected: boolean; disabled: boolean; observedLabel: string; deviceSetup?: ReactNode;
  onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void;
  onUpdated: (session: ProductionSession) => void; onRefresh: () => void;
}) {
  const [devices, setDevices] = useState<StudioDevice[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [devicesLoaded, setDevicesLoaded] = useState(false), [devicesBusy, setDevicesBusy] = useState(false);
  const [deviceError, setDeviceError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState<SetupRequest | null>(null), [busy, setBusy] = useState(false);
  const [settling, setSettling] = useState<ProductionSession | null>(null);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [exclusiveOverlay, setExclusiveOverlay] = useState(false), [reading, setReading] = useState(false);
  const outcome = useRef<HTMLDivElement>(null), operation = useRef(false), fileRead = useRef(0), moveFocus = useRef(false);
  const { session, mapping } = view;
  const paired = devices.filter(device => device.active && (!device.sessionId || device.sessionId === session.id));
  const deviceId = draft?.deviceId ?? session.deviceId ?? "";
  const selectedDevice = paired.find(device => device.id === deviceId);
  const changed = Boolean(draft), unknown = Boolean(pending && !busy);
  const stale = Boolean(draft && draft.baseMappingVersion !== mapping.version);
  const held = disabled || !connected || busy || unknown || Boolean(settling) || reading;
  const mappingLocked = held || session.state !== "draft";
  const details = draft?.details ?? mapping;
  const verified = mapping.state === "commissioned" && Boolean(session.deviceId);

  useEffect(() => { setExclusiveOverlay(false); }, [mapping.version, session.deviceId]);
  useEffect(() => { onDirtyChange(changed || Boolean(pending)); }, [changed, pending, onDirtyChange]);
  useEffect(() => { onBusyChange(busy || reading); }, [busy, reading, onBusyChange]);
  useEffect(() => () => { fileRead.current++; onDirtyChange(false); onBusyChange(false); }, [onDirtyChange, onBusyChange]);
  useEffect(() => {
    if (!settling) return;
    const newerGeneration = session.generation > settling.generation;
    const reachedState = session.generation === settling.generation && session.mappingVersion >= settling.mappingVersion &&
      stateOrder[session.state] >= stateOrder[settling.state];
    if (newerGeneration || reachedState) setSettling(null);
  }, [session, settling]);
  useEffect(() => {
    if (!busy && (error || (notice && moveFocus.current))) { outcome.current?.focus(); moveFocus.current = false; }
  }, [notice, error, busy]);

  async function loadDevices(after?: string) {
    if (devicesBusy || !connected) return;
    setDevicesBusy(true); setDeviceError("");
    try {
      const result = await client.devices(after);
      setDevices(previous => after ? [...previous.filter(device => !result.devices.some(next => next.id === device.id)), ...result.devices] : result.devices);
      setCursor(result.nextCursor); setDevicesLoaded(true);
    } catch { setDeviceError("The paired PC list could not load. Refresh devices to try again."); }
    finally { setDevicesBusy(false); }
  }
  useEffect(() => {
    if (!connected) return;
    const controller = new AbortController();
    setDevicesBusy(true);
    void client.devices(undefined, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setDevices(result.devices); setCursor(result.nextCursor); setDevicesLoaded(true); setDeviceError("");
    }).catch(() => { if (!controller.signal.aborted) setDeviceError("The paired PC list could not load. Refresh devices to try again."); })
      .finally(() => { if (!controller.signal.aborted) setDevicesBusy(false); });
    return () => controller.abort();
  }, [client, connected]);

  function edit(values: Partial<Draft>) {
    setError(""); setNotice(""); setExclusiveOverlay(false);
    setDraft(current => ({ deviceId: session.deviceId ?? "", details: null, confirmed: false,
      baseMappingVersion: mapping.version, ...current, ...values }));
  }
  async function readFile(file: File) {
    const read = ++fileRead.current;
    edit({ details: null, confirmed: false });
    setReading(true); setError(""); setNotice("");
    try {
      if (file.size > STUDIO_INPUT_FILE_LIMIT) throw new Error("Studio input details must fit 16 KiB.");
      const details = parseStudioInputs(await file.text());
      if (read === fileRead.current) edit({ details, confirmed: false });
    } catch (cause) { if (read === fileRead.current) setError(cause instanceof Error ? cause.message : "The studio input file could not be read."); }
    finally { if (read === fileRead.current) setReading(false); }
  }
  async function execute(request: SetupRequest) {
    if (operation.current || disabled || !connected) return;
    operation.current = true; moveFocus.current = true; setBusy(true); setPending(request); setError(""); setNotice("");
    try {
      const result = request.action === "set_mapping" ? (await client.setMapping(request)).session : await client.setSessionState(request);
      setPending(null); setDraft(null); setExclusiveOverlay(false); setSettling(result); onUpdated(result);
      setNotice(request.action === "set_mapping" ? "Studio connection saved. Copy connector setup and run its verification before marking this session ready."
        : request.state === "ready" ? "Session is ready. Make it active when the studio is prepared for the off-air test."
        : "Session is active. Check a fresh studio observation before using Take.");
    } catch (cause) {
      const refused = Boolean(cause && typeof cause === "object" && "status" in cause && typeof cause.status === "number" && cause.status >= 400 && cause.status < 500);
      if (refused) setPending(null);
      const message = cause instanceof Error ? cause.message : "The request could not complete.";
      setError(refused ? `The studio refused this change. ${message} Your input details are still here. Refresh studio setup before trying again.`
        : "The result is unknown. Refresh studio setup and check the saved state, or retry the same studio request. No request will be sent automatically.");
      onRefresh();
    } finally { operation.current = false; setBusy(false); }
  }
  async function copy(value: string, label: string) {
    moveFocus.current = false;
    try { await navigator.clipboard.writeText(value); setError(""); setNotice(`${label} copied.`); }
    catch { setNotice(""); setError("Copy is unavailable. Use Boardwalk in a secure browser window and try again."); }
  }

  return <section className="live-connection" aria-label="Studio connection">
    <div className="live-session-id"><p>Session ID: <code>{session.id}</code></p>
      <Button onClick={() => void copy(session.id, "Session ID")}>Copy session ID</Button></div>
    <p>Current state: <strong>{session.state.charAt(0).toUpperCase() + session.state.slice(1)}</strong></p>
    {deviceSetup}
    <h3>Connect the studio PC</h3>
    <p>Keep recording and streaming off. Pair the PC in Live production devices above, then select Refresh devices below after pairing finishes. Load the configured preset in vMix. Run Set up Studio connector.cmd on the PC to make studio-inputs.json, then choose that file here.</p>
    {!connected && <InlineMessage tone="warning">Reconnect before changing studio setup. Your input details stay here.</InlineMessage>}
    <div ref={outcome} tabIndex={-1}>
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
      {notice && <InlineMessage tone="success">{notice}</InlineMessage>}
    </div>
    {busy && <p role="status">Updating studio setup…</p>}
    {settling && <p role="status">Waiting for refreshed studio status.</p>}
    {unknown && <Button disabled={!connected || disabled} onClick={() => void execute(pending!)}>Retry same studio request</Button>}
    {deviceError && <InlineMessage tone="error">{deviceError}</InlineMessage>}
    <form onSubmit={event => {
      event.preventDefault();
      if (!draft?.details || !draft.confirmed || !selectedDevice || mappingLocked || stale) return;
      void execute({ action: "set_mapping", sessionId: session.id, requestId: crypto.randomUUID(), baseMappingVersion: draft.baseMappingVersion,
        deviceId, ...draft.details, titleFilesConfirmed: true });
    }}>
      <label>Paired studio PC<Select value={deviceId} disabled={mappingLocked || !devicesLoaded} onChange={event => edit({ deviceId: event.target.value, details: null, confirmed: false })}>
        <option value="">Choose a paired PC</option>
        {deviceId && !paired.some(device => device.id === deviceId) && <option value={deviceId}>{deviceId} · Unavailable</option>}
        {paired.map(device => <option key={device.id} value={device.id}>{device.name} · {device.id}</option>)}
      </Select></label>
      {devicesBusy && <p role="status">Loading paired PCs…</p>}
      {devicesLoaded && !paired.length && <p>No paired PC is available for this session. Pair a PC or release its other session first.</p>}
      <div className="live-actions"><Button disabled={held || devicesBusy} onClick={() => void loadDevices()}>Refresh devices</Button>
        {cursor && <Button disabled={held || devicesBusy} onClick={() => void loadDevices(cursor)}>Load more devices</Button>}</div>
      <label>Load studio input details<TextInput type="file" accept=".json,application/json" disabled={mappingLocked} onChange={event => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (file) void readFile(file);
      }} /></label>
      <p className="live-caption">Choose studio-inputs.json (up to 16 KiB). Review the exact loaded names and keys below. The four preset numbers alone do not verify the inputs.</p>
      {reading && <p role="status">Reading studio input details…</p>}
      {draft?.details && <p role="status">Studio input details loaded. Review the four inputs below.</p>}
      <div className="live-input-preview">{studioInputFields.map(({ group, template, number, label }) => {
        const input = details[group]?.[template];
        return <div className="live-input-identity" key={label}><label>{label}<TextInput type="number" value={input?.number ?? number ?? ""} readOnly /></label>
          <p>{input ? <><strong>{input.title}</strong><br />Key: <code>{input.key}</code></> : "Load studio input details to show its exact name and key."}</p></div>;
      })}</div>
      <p>Each banner target must contain its configured background and text inputs as direct layers.</p>
      <label className="live-setup-check"><input type="checkbox" checked={draft?.confirmed ?? false} disabled={mappingLocked || !draft?.details}
        onChange={event => edit({ confirmed: event.target.checked })} />I confirmed both GT title files with the studio operator</label>
      <p className="live-caption">Confirm both GT source files listed in the private studio configuration, with TextBlock1.Text and TextBlock2.Text where required. This check records your confirmation; the connector must still verify vMix.</p>
      {stale && <InlineMessage tone="warning">A newer studio connection is saved. Your input details are still here. Use the saved studio connection, then load and review your file again.</InlineMessage>}
      <div className="live-actions"><Button type="submit" variant="primary" disabled={mappingLocked || stale || !draft?.details || !draft.confirmed || !selectedDevice}>Save studio connection</Button>
        {changed && <Button disabled={busy || reading || unknown} onClick={() => { setDraft(null); setError(""); setNotice(""); setExclusiveOverlay(false); }}>Use saved studio connection</Button>}</div>
    </form>
    {session.state !== "draft" && <p>The connection can be saved only while this session is a draft. Keep the existing setup for later shows.</p>}
    <p>Saved mapping version: {mapping.version}. Last verification: {mapping.verifiedAtMs === null || mapping.verifiedAtMs < Date.UTC(2026, 0, 1)
      ? verified ? "Verification time unavailable" : "Not verified yet"
      : new Date(mapping.verifiedAtMs).toLocaleString("en-US", { timeZone: "America/New_York", timeZoneName: "short" })}.</p>
    <p>Observed studio state: {observedLabel}. {view.observed.report ? `vMix ${view.observed.report.vmix}.` : "Waiting for a studio observation."}</p>
    <label className="live-setup-check"><input type="checkbox" checked={exclusiveOverlay} disabled={held || changed || session.state === "ended" || !session.deviceId || !mapping.overlayInputs}
      onChange={event => setExclusiveOverlay(event.target.checked)} />I checked that Overlay 1 is reserved for Boardwalk</label>
    <p className="live-caption">The studio operator must check every native output route. Copying setup does not start the connector or change studio output. The connector saves the verified mapping. Refresh studio setup before Mark ready.</p>
    <Button disabled={held || changed || !exclusiveOverlay || session.state === "ended"} onClick={() => {
      try { void copy(connectorSetup(view), "Connector setup"); } catch (cause) { setError((cause as Error).message); }
    }}>Copy connector setup</Button>
    <div className="live-actions">
      <Button disabled={held || changed || session.state !== "draft" || !verified} onClick={() => void execute({ action: "set_session_state", sessionId: session.id,
        requestId: crypto.randomUUID(), baseGeneration: session.generation, state: "ready" })}>Mark ready</Button>
      <Button variant="primary" disabled={held || changed || session.state !== "ready" || !verified} onClick={() => void execute({ action: "set_session_state", sessionId: session.id,
        requestId: crypto.randomUUID(), baseGeneration: session.generation, state: "active" })}>Make active</Button>
      <Button disabled={busy || reading || !connected} onClick={onRefresh}>Refresh studio setup</Button>
    </div>
    <p className="live-caption">Order: Save the connection, verify it on the PC, refresh studio setup, mark ready, then make active. Ready and Active send no Take or Clear.</p>
  </section>;
}
