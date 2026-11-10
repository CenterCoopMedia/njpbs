import { useEffect, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { useAuth } from "../context/AuthContext";
import { Button, InlineMessage, Panel, TextInput } from "../components/ui/Primitives";
import { postFunction } from "../lib/functions";
import { emulatorMode } from "../lib/firebase";
import { parsePremiereConnectionCode } from "../lib/premiere-connection-code";

interface Pairing {
  deviceName: string;
  hostVersion: string;
  expiresAt: string;
  status: string;
}

export function PremiereConnectRoute() {
  const { getIdToken } = useAuth();
  return <PremiereConnectPanel getIdToken={getIdToken} localTestMode={emulatorMode} />;
}

// The route body takes its token source as a prop so the dev gallery can render the real
// panel with a local fixture transport for the staff guide screenshots.
export function PremiereConnectPanel({ getIdToken, localTestMode }: {
  getIdToken: () => Promise<string>;
  localTestMode: boolean;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const [code, setCode] = useState(() => parsePremiereConnectionCode(location.search));
  const [reviewedCode, setReviewedCode] = useState("");
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (!params.has("code")) return;
    params.delete("code");
    const search = params.toString();
    void navigate({ pathname: location.pathname, search: search ? `?${search}` : "", hash: location.hash },
      { replace: true, state: location.state });
  }, [location, navigate]);

  async function act(action: "lookup" | "approve" | "deny") {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    const userCode = action === "lookup" ? code.trim().toUpperCase() : reviewedCode;
    try {
      const result = await postFunction<{ success: true; pairing: Pairing }>(
        "cmsApprovePremierePairing", await getIdToken(), { action, userCode }, {},
        { appCheck: true, operation: "account" },
      );
      if (action === "lookup") {
        setPairing(result.pairing);
        setReviewedCode(userCode);
      } else {
        setPairing(null);
        setCode("");
        setReviewedCode("");
        setMessage(action === "approve"
          ? "Connection approved. Return to Premiere to open your library."
          : "Connection denied. This computer has not been connected.");
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not connect Premiere. Try again.");
    } finally { setBusy(false); }
  }

  function find(event: FormEvent) {
    event.preventDefault();
    void act("lookup");
  }

  return <Panel>
    <h2>Connect Premiere to Boardwalk</h2>
    {localTestMode && <InlineMessage tone="info">
      Local test mode. This connects Premiere to the test library on this computer.
    </InlineMessage>}
    <p>Review the code from Premiere, then confirm it matches before you approve this computer.</p>
    {error && <InlineMessage tone="error">{error}</InlineMessage>}
    {message && <InlineMessage tone="success">{message}</InlineMessage>}
    {!pairing ? <form onSubmit={find}>
      <label htmlFor="premiere-code">Connection code</label>
      <TextInput id="premiere-code" value={code} maxLength={16} autoComplete="off" aria-describedby="premiere-code-hint"
        spellCheck={false} disabled={busy} required
        onChange={event => setCode(event.target.value)} />
      <p id="premiere-code-hint">If the field is empty, paste or enter the code from the panel. The hyphen is optional.</p>
      <Button type="submit" disabled={busy || !code.trim()}>Review connection</Button>
    </form> : <div>
      <h3>{pairing.deviceName}</h3>
      <p>Premiere version: {pairing.hostVersion}</p>
      <p>Code: <strong>{reviewedCode}</strong></p>
      <p>This connection lets Premiere browse Videos, download media,
        request exports, edit media metadata, and upload new videos with your current permissions.
        It stays signed in for 30 days, unless you sign out or your access is revoked.</p>
      <p>The panel also sends problem reports and automatic failure alerts to Boardwalk administrators.
        Diagnostics include plugin and Premiere versions and operation results, without video names,
        file paths, signed download links, or account credentials. Repeated alerts are grouped for 15 minutes.</p>
      <p>Approve only if you started this connection and this code matches the one in Premiere.</p>
      <Button type="button" disabled={busy || pairing.status !== "pending"} onClick={() => void act("approve")}>Approve this computer</Button>
      <Button type="button" variant="secondary" disabled={busy} onClick={() => void act("deny")}>Deny connection</Button>
      <Button type="button" variant="secondary" disabled={busy} onClick={() => {
        setPairing(null); setReviewedCode(""); setError(null);
      }}>Use a different code</Button>
    </div>}
  </Panel>;
}
