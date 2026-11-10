import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { can, type Principal } from "../../../packages/content-core/src/rbac";
import { disconnectTranscriptionCredential, listTranscriptionCredentials, saveTranscriptionCredential, transcriptionCredentialError, type TranscriptionCredential, type TranscriptionCredentialScope } from "../lib/transcription-credentials";
import { Button, InlineMessage, StatusBadge, TextInput } from "./ui/Primitives";
import "./TranscriptionCredentials.css";

type Activity = { dirty: boolean; busy: boolean };
interface Props {
  principal: Principal;
  getIdToken: () => Promise<string>;
  disabled?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
}

export function TranscriptionCredentials({ principal, getIdToken, disabled = false, onDirtyChange, onBusyChange }: Props) {
  const [activity, setActivity] = useState<Record<string, Activity>>({});
  const onActivity = useCallback((scope: TranscriptionCredentialScope, dirty: boolean, busy: boolean) => {
    setActivity(previous => ({ ...previous, [scope]: { dirty, busy } }));
  }, []);
  const dirty = Object.values(activity).some(value => value.dirty);
  const busy = Object.values(activity).some(value => value.busy);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  if (!principal.id) return <p>Sign in to manage transcription keys.</p>;
  return <section className="transcription-credentials" aria-label="Transcription keys">
    <h3>Transcription keys</h3>
    <p>Store an ElevenLabs key for transcription. Saving a key does not verify it or start a provider request. A configured key can still be invalid or lack billing access.</p>
    <p>Saving a key does not start transcription. Use New transcript to choose a configured key and authorize a request when the service is enabled. Transcripts created with personal or station keys belong to the station video library.</p>
    <p>Keys are not returned to this screen. Enter a replacement to change a saved key.</p>
    <CredentialForm key={`${principal.id}:personal`} scope="personal" getIdToken={getIdToken} disabled={disabled} onActivity={onActivity} />
    {can(principal, "settings.manage", {}) ? <CredentialForm key={`${principal.id}:organization`} scope="organization" getIdToken={getIdToken} disabled={disabled} onActivity={onActivity} /> : null}
  </section>;
}

function CredentialForm({ scope, getIdToken, disabled, onActivity }: {
  scope: TranscriptionCredentialScope;
  getIdToken: Props["getIdToken"];
  disabled: boolean;
  onActivity: (scope: TranscriptionCredentialScope, dirty: boolean, busy: boolean) => void;
}) {
  const [credential, setCredential] = useState<TranscriptionCredential | null>(null);
  const [key, setKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  const mounted = useRef(true);
  const pendingRef = useRef(false);
  const helpId = useId();
  const title = scope === "personal" ? "Your private key" : "Station default key";
  const blocked = disabled || loading || pending || needsReload;
  const validKey = /^[\x21-\x7e]{16,4096}$/.test(key);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // Key text stays in this component's state only. Unmount releases the state;
  // submission clears the input before waiting for authentication or the network.
  useEffect(() => { onActivity(scope, key.length > 0, pending); return () => onActivity(scope, false, false); }, [scope, key.length, pending, onActivity]);
  useEffect(() => {
    let current = true;
    setLoading(true); setError("");
    void (async () => {
      try {
        const result = await listTranscriptionCredentials(await getIdToken(), scope);
        if (!current) return;
        setCredential(result.credentials.find(value => value.scope === scope && value.provider === "elevenlabs") ?? null);
        setNeedsReload(false);
      } catch (error) {
        if (current) { setNeedsReload(true); setError(transcriptionCredentialError(error, false)); }
      } finally { if (current) setLoading(false); }
    })();
    return () => { current = false; };
  }, [scope, getIdToken, refresh]);

  async function mutate(operation: "save" | "disconnect") {
    if (blocked || pendingRef.current || (operation === "save" ? !validKey : !credential?.configured || !confirmDisconnect)) return;
    pendingRef.current = true;
    const submittedKey = key;
    setKey(""); setPending(true); setError(""); setNotice(""); setConfirmDisconnect(false);
    try {
      const token = await getIdToken();
      if (!mounted.current) return;
      const result = operation === "save"
        ? await saveTranscriptionCredential(token, scope, submittedKey, credential?.revision ?? 0)
        : await disconnectTranscriptionCredential(token, scope, credential!.revision);
      if (!mounted.current) return;
      setCredential(result.credential);
      setNotice(operation === "save" ? "Key saved. It has not been verified." : "Key disconnected.");
    } catch (error) {
      if (mounted.current) { setNeedsReload(true); setError(transcriptionCredentialError(error, true)); }
    } finally { pendingRef.current = false; if (mounted.current) setPending(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); void mutate("save"); }
  return <form className="transcription-credential-form" aria-label={title} onSubmit={submit}>
    <h4>{title}</h4>
    <p>{scope === "personal" ? "Only your account can manage this key." : "Administrators with global settings access can manage the station default."}</p>
    {loading ? <p role="status">Loading key status.</p> : <p><StatusBadge>{credential?.configured ? "Configured · unverified" : "Not configured"}</StatusBadge></p>}
    {credential?.updatedAt && Number.isFinite(Date.parse(credential.updatedAt)) ? <p>Last changed {new Date(credential.updatedAt).toLocaleString("en-US", { timeZone: "America/New_York" })} ET.</p> : null}
    <label>ElevenLabs API key<TextInput type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} value={key} minLength={16} maxLength={4096} disabled={blocked || confirmDisconnect} aria-describedby={helpId} onChange={event => setKey(event.target.value)} /></label>
    <p id={helpId}>Enter 16 to 4096 printable characters without spaces. The entry clears when you submit it.</p>
    <div className="transcription-credential-buttons"><Button type="submit" variant="primary" disabled={blocked || !validKey || confirmDisconnect}>{pending ? "Saving change" : credential?.configured ? "Replace key" : "Save key"}</Button>
      {key ? <Button disabled={pending} onClick={() => setKey("")}>Clear key entry</Button> : null}
      {credential?.configured && !confirmDisconnect ? <Button disabled={blocked || key.length > 0} onClick={() => setConfirmDisconnect(true)}>Disconnect key</Button> : null}
      {needsReload ? <Button disabled={disabled || pending || loading} onClick={() => { setKey(""); setNotice(""); setRefresh(value => value + 1); }}>Reload key status</Button> : null}</div>
    {confirmDisconnect ? <div><p>Disconnect this {scope === "personal" ? "private" : "station default"} key? Saved transcripts remain available.</p><div className="transcription-credential-buttons"><Button variant="danger" disabled={blocked} onClick={() => void mutate("disconnect")}>Confirm disconnect</Button><Button disabled={pending} onClick={() => setConfirmDisconnect(false)}>Cancel disconnect</Button></div></div> : null}
    {pending ? <p role="status">Saving key configuration.</p> : notice ? <p role="status">{notice}</p> : null}
    {error ? <InlineMessage tone="error" title="Key configuration needs attention">{error}</InlineMessage> : null}
  </form>;
}
