import { useSettingsDirty, useSettingsSectionActive } from "./SettingsWorkspace";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { HttpError, postFunction } from "../lib/functions";
import { Button, InlineMessage, Panel, StatusBadge, TextInput, type StatusTone } from "./ui/Primitives";
import "./LiveProductionDevices.css";

type Device = { id: string; name: string; active: boolean; state: string; sessionId: string | null };
type Result = { devices?: Device[]; nextCursor?: string | null; pairingCode?: string; deviceId?: string; expiresAtMs?: number; expiresInMs?: number };
export type DeviceTransport = (request: object) => Promise<Result>;

function deviceStatus(device: Device): { label: string; tone: StatusTone } {
  if (device.active) return { label: "Enrolled", tone: "success" };
  switch (device.state) {
    case "pending": return { label: "Pairing pending", tone: "neutral" };
    case "enrolling": return { label: "Pairing in progress", tone: "neutral" };
    case "expired": return { label: "Pairing expired", tone: "unknown" };
    case "failed": return { label: "Pairing failed", tone: "failed" };
    default: return { label: "Revoked", tone: "neutral" };
  }
}

export function LiveProductionDevices({ send }: { send: DeviceTransport }) {
  const sectionActive = useSettingsSectionActive();
  const [devices, setDevices] = useState<Device[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [pairing, setPairing] = useState<Result | null>(null);
  const [revoke, setRevoke] = useState<Device | null>(null);
  const [deleting, setDeleting] = useState<Device | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [notice, setNotice] = useState("");
  const enrollmentForm = useRef<HTMLFormElement>(null);
  const pairingRegion = useRef<HTMLDivElement>(null);
  const confirmation = useRef<HTMLDivElement>(null);
  const revokeTrigger = useRef<HTMLButtonElement | null>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const selected = revoke ?? deleting;
  useSettingsDirty(Boolean(name.trim()), busy);
  const focusedConfirmation = useRef("");
  const focusedNotice = useRef("");
  useEffect(() => {
    const key = selected ? `${deleting ? "delete" : "revoke"}:${selected.id}` : "";
    if (!key) focusedConfirmation.current = "";
    else if (sectionActive && focusedConfirmation.current !== key) { confirmation.current?.focus(); focusedConfirmation.current = key; }
  }, [selected, deleting, sectionActive]);
  useEffect(() => {
    if (!notice) focusedNotice.current = "";
    else if (sectionActive && !busy && focusedNotice.current !== notice) { refreshButton.current?.focus(); focusedNotice.current = notice; }
  }, [notice, busy, sectionActive]);
  function hidePairing() {
    if (pairingRegion.current?.contains(document.activeElement)) enrollmentForm.current?.querySelector("input")?.focus();
    setPairing(null); setCopyState("idle");
  }
  const load = useCallback(async (after?: string) => {
    const result = await send({ action: "list_devices", ...(after ? { cursor: after } : {}) });
    setDevices(previous => after ? [...previous, ...(result.devices ?? [])] : result.devices ?? []);
    setCursor(result.nextCursor ?? null); setLoaded(true);
  }, [send]);
  useEffect(() => {
    let current = true;
    send({ action: "list_devices" }).then(result => {
      if (!current) return;
      setDevices(result.devices ?? []); setCursor(result.nextCursor ?? null); setLoaded(true);
    }).catch(() => { if (current) setError("Device settings could not be updated. Refresh the list before trying again."); });
    return () => { current = false; };
  }, [send]);
  useEffect(() => {
    if (!pairing) return;
    // Display lifetime only; the server checks actual expiry during redemption.
    const started = performance.now();
    const budget = Math.max(0, pairing.expiresInMs ?? 0);
    const tick = () => setRemainingSeconds(Math.max(0, Math.ceil((budget - (performance.now() - started)) / 1000)));
    tick();
    const timer = window.setTimeout(hidePairing, budget);
    const countdown = window.setInterval(tick, 1000);
    return () => { window.clearTimeout(timer); window.clearInterval(countdown); };
  }, [pairing]);
  async function act(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { await operation(); } catch (failure) {
      const code = failure instanceof HttpError && failure.status === 409 ? failure.data.code : null;
      setError(code === "device_referenced"
        ? "This device is used by a studio session or saved mapping and cannot be deleted. Keep its history."
        : code === "device_not_deletable" ? "Revoke the device, refresh the list, then try deleting it again."
          : "Device settings could not be updated. Refresh the list before trying again.");
    }
    finally { setBusy(false); }
  }
  return (
    <Panel className="admin-settings-panel live-production-devices" aria-label="Live production devices">
      <div className="panel-heading"><div><h2>Live production devices</h2>
        <p>Pair the studio PC's Studio connector, revoke its access, or delete an unused revoked or failed device. This small program uses fixed rules and no AI. Pairing does not send a vMix command.</p></div></div>
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
      {busy && <p role="status">Updating device settings…</p>}
      {notice && <InlineMessage tone="success">{notice}</InlineMessage>}
      <form ref={enrollmentForm} className="admin-settings-form" aria-busy={busy} onSubmit={event => {
        event.preventDefault();
        void act(async () => {
          setPairing(null); setCopyState("idle");
          const started = performance.now();
          const result = await send({ action: "create_pairing", name: name.trim() });
          setPairing({ ...result, expiresInMs: Math.max(0, (result.expiresInMs ?? 0) - (performance.now() - started)) }); setName(""); await load();
        });
      }}>
        <label>Studio PC name<TextInput value={name} maxLength={80} required disabled={busy}
          onChange={event => setName(event.target.value)} autoComplete="off" /></label>
        <div className="media-category-actions">
          <Button type="submit" variant="primary" disabled={busy || !loaded || !name.trim()}>Create pairing code</Button>
        </div>
      </form>
      {pairing?.pairingCode && <div ref={pairingRegion} role="group" aria-label="Studio PC pairing" className="admin-settings-form">
        <p role="status">Pairing code ready. Enter it on the studio PC. It can be used once.</p>
        <code className="live-production-pairing-code">{pairing.pairingCode}</code>
        <p>Expires in <span role="timer" aria-live="off">{Math.floor(remainingSeconds / 60)}:{String(remainingSeconds % 60).padStart(2, "0")}</span></p>
        <p className="muted">Device ID: <code>{pairing.deviceId}</code></p>
        <div className="media-category-actions">
          <Button variant="secondary" onClick={async () => {
            try { await navigator.clipboard.writeText(pairing.pairingCode!); setCopyState("copied"); }
            catch { setCopyState("error"); }
          }}>Copy code</Button>
          <Button variant="secondary" onClick={hidePairing}>Hide pairing code</Button>
        </div>
        {copyState === "copied" && <p role="status">Code copied.</p>}
        {copyState === "error" && <p role="alert">Copy is unavailable. Enter the displayed code on the PC.</p>}
      </div>}
      {!loaded && !error && <p role="status">Loading devices…</p>}
      {loaded && !devices.length && <p>No studio devices are enrolled.</p>}
      <ul className="media-category-list" aria-label="Studio devices">{devices.map(device => {
        const status = deviceStatus(device);
        return <li key={device.id}>
        <div className="media-category-summary">
          <div>
            <div className="media-category-title"><strong>{device.name}</strong>
              <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
            </div>
            <p className="muted">Device ID: <code>{device.id}</code>{device.sessionId && <> · Session: <code>{device.sessionId}</code></>}</p>
            {(device.state === "expired" || device.state === "failed") && <p>Revoke this device, then create a new pairing code to pair again.</p>}
          </div>
          <div className="media-category-actions">
            {device.state !== "revoked" && <Button variant="secondary" disabled={busy} aria-label={`Revoke ${device.name}`}
              onClick={event => { revokeTrigger.current = event.currentTarget; setPairing(null); setDeleting(null); setRevoke(device); }}>Revoke</Button>}
            {["revoked", "failed"].includes(device.state) && <Button variant="secondary" disabled={busy} aria-label={`Delete ${device.name}`}
              onClick={event => { revokeTrigger.current = event.currentTarget; setPairing(null); setRevoke(null); setDeleting(device); }}>Delete</Button>}
          </div>
        </div>
      </li>; })}</ul>
      {revoke && <div ref={confirmation} tabIndex={-1} role="group" aria-label={`Confirm revocation for ${revoke.name}`}>
        <p>Revoke {revoke.name}? Its next Studio connector call will be refused. Native vMix control remains available.</p>
        <div className="media-category-actions">
          <Button variant="danger" disabled={busy} onClick={() => void act(async () => {
            await send({ action: "revoke_device", deviceId: revoke.id });
            setRevoke(null); setNotice("Device access revoked."); await load();
          })}>Confirm revocation</Button>
          <Button variant="secondary" disabled={busy} onClick={() => { setRevoke(null); revokeTrigger.current?.focus(); }}>Cancel</Button>
        </div>
      </div>}
      {deleting && <div ref={confirmation} tabIndex={-1} role="group" aria-label={`Confirm deletion for ${deleting.name}`}>
        <p>Delete {deleting.name} and its pairing records? This cannot be undone. A device used by any studio session or saved mapping cannot be deleted. This does not remove files from the PC.</p>
        <div className="media-category-actions">
          <Button variant="danger" disabled={busy} onClick={() => void act(async () => {
            await send({ action: "delete_device", deviceId: deleting.id });
            setDeleting(null); setNotice("Device deleted."); await load();
          })}>Confirm deletion</Button>
          <Button variant="secondary" disabled={busy} onClick={() => { setDeleting(null); revokeTrigger.current?.focus(); }}>Cancel</Button>
        </div>
      </div>}
      <div className="media-category-actions">
        <Button ref={refreshButton} variant="secondary" disabled={busy} onClick={() => void act(() => load())}>Refresh devices</Button>
        {cursor && <Button variant="secondary" disabled={busy} onClick={() => void act(() => load(cursor))}>Load more devices</Button>}
      </div>
    </Panel>
  );
}

export function ConnectedLiveProductionDevices() {
  const { getIdToken } = useAuth();
  const send = useCallback<DeviceTransport>(async request =>
    postFunction<Result>("cmsLiveProductionDevices", await getIdToken(), request), [getIdToken]);
  return <LiveProductionDevices send={send} />;
}
