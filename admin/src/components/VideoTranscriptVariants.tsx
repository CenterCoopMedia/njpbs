import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button, InlineMessage, Select } from "./ui/Primitives";
import { getTranscriptionOptions, listVideoTranscripts, requestByokVideoTranscript, type TranscriptionOptions } from "../lib/transcription-options";
import { requestVideoTranscript, estimateAwsTranscriptionCharge, transcriptionChargeLabel, type TranscriptRequestPolicy, type TranscriptResponse, type TranscriptSettings, type VideoIdentity, type VideoTranscript } from "../lib/video-production";
import type { TranscriptionCredentialScope } from "../lib/transcription-credentials";

const providerNames: Record<string, string> = { "local-whisper": "Local worker Whisper", "amazon-transcribe": "Amazon Transcribe", elevenlabs: "ElevenLabs Scribe v2" };
function variantLabel(value: VideoTranscript) {
  const provider = providerNames[value.processing?.provider ?? ""] ?? "Provider not recorded";
  const language = value.languageCode === "en-US" ? "English" : value.languageCode === "es-US" ? "Spanish" : "Language not recorded";
  return `${provider} · ${language} · ${value.state === "queued" ? "Queued" : value.state.replaceAll("_", " ")} · ${value.id?.slice(0, 8)}`;
}

export function VideoTranscriptVariants({ identity, getIdToken, open, disabled, canRequest, settings, currentTranscript, requestPolicy, duration, sizeBytes, refresh, onSelect, onRequested, onBusyChange, actionTarget }: {
  actionTarget?: HTMLElement | null;
  identity: VideoIdentity;
  getIdToken: () => Promise<string>;
  open: boolean;
  disabled: boolean;
  canRequest: boolean;
  settings: TranscriptSettings;
  currentTranscript?: VideoTranscript;
  requestPolicy?: TranscriptRequestPolicy;
  duration: number;
  sizeBytes?: number;
  refresh: number;
  onSelect: (transcript?: VideoTranscript) => void;
  onRequested: (response: TranscriptResponse) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [variants, setVariants] = useState<VideoTranscript[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [listError, setListError] = useState("");
  const [listBusy, setListBusy] = useState(false);
  const [options, setOptions] = useState<TranscriptionOptions>();
  const [optionsError, setOptionsError] = useState("");
  const [optionsBusy, setOptionsBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [scope, setScope] = useState<TranscriptionCredentialScope | "">("");
  const [languageCode, setLanguageCode] = useState<TranscriptSettings["languageCode"]>(settings.languageCode);
  const [maxSpeakers, setMaxSpeakers] = useState(settings.maxSpeakers);
  const [paidOpen, setPaidOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [requestBusy, setRequestBusy] = useState(false);
  const [requestError, setRequestError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [provider, setProvider] = useState<"local" | "amazon-transcribe" | "elevenlabs">("local");
  const terminal = !!currentTranscript?.id && ["failed", "needs_reconciliation", "ready", "cancelled", "stale"].includes(currentTranscript.state);
  const retryProvider = terminal ? provider : "elevenlabs";
  const elevenlabs = retryProvider === "elevenlabs";
  const paid = retryProvider !== "local";
  const activeRequest = currentTranscript?.state === "queued" || currentTranscript?.state === "processing";
  const generation = useRef(0);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onBusyChange(requestBusy); return () => onBusyChange(false); }, [requestBusy, onBusyChange]);
  useEffect(() => { setConfirmed(false); }, [scope, maxSpeakers, languageCode, options, duration, retryProvider, currentTranscript?.id]);
  useEffect(() => {
    const priorLanguage = currentTranscript?.languageCode;
    setLanguageCode(priorLanguage === "es-US" ? "es-US" : priorLanguage === "en-US" ? "en-US" : settings.languageCode);
    const priorSpeakers = currentTranscript?.maxSpeakers;
    setMaxSpeakers(Number.isInteger(priorSpeakers) && priorSpeakers! >= 2 && priorSpeakers! <= 10 ? priorSpeakers! : settings.maxSpeakers);
  }, [currentTranscript?.id]);
  useEffect(() => {
    if (!currentTranscript?.id) {
      setLanguageCode(settings.languageCode);
      setMaxSpeakers(settings.maxSpeakers);
    }
  }, [currentTranscript?.id, settings.languageCode, settings.maxSpeakers]);
  useEffect(() => {
    if (currentTranscript?.id && ["failed", "needs_reconciliation"].includes(currentTranscript.state)) setPaidOpen(true);
  }, [currentTranscript?.id, currentTranscript?.state]);

  useEffect(() => {
    if (!open) return;
    const current = ++generation.current;
    let active = true;
    setListBusy(true); setListError("");
    void (async () => {
      try {
        const response = await listVideoTranscripts(await getIdToken(), identity);
        if (!active) return;
        setVariants(response.transcripts); setCursor(response.nextCursor);
      } catch { if (active) setListError("Saved transcript choices could not be loaded. Reload the list to check for an existing result."); }
      finally { if (active) setListBusy(false); }
    })();
    if (canRequest) {
      setOptions(undefined); setOptionsBusy(true); setOptionsError("");
      void (async () => {
        try {
          const response = await getTranscriptionOptions(await getIdToken(), identity);
          if (active) setOptions(response);
        } catch { if (active) setOptionsError("Paid transcription availability could not be checked. Reload before making a request."); }
        finally { if (active) setOptionsBusy(false); }
      })();
    }
    return () => { active = false; if (generation.current === current) generation.current++; };
  }, [identity.sourceId, identity.assetId, getIdToken, open, canRequest, reload, refresh]);

  async function loadMore() {
    if (!cursor || listBusy || disabled || requestBusy) return;
    const current = generation.current;
    setListBusy(true); setListError("");
    try {
      const response = await listVideoTranscripts(await getIdToken(), identity, cursor);
      if (!mounted.current || generation.current !== current) return;
      setVariants(previous => [...new Map([...previous, ...response.transcripts].map(value => [value.id, value])).values()]);
      setCursor(response.nextCursor);
    } catch { if (mounted.current && generation.current === current) setListError("More saved transcripts could not be loaded."); }
    finally { if (mounted.current && generation.current === current) setListBusy(false); }
  }
  const credential = options?.credentials.find(value => value.scope === scope && value.provider === "elevenlabs" && value.configured);
  const knownProvider = options?.provider?.id === "elevenlabs" && options.provider.model === "scribe_v2" && options.provider.wordTimings === true;
  const eligible = !!options && knownProvider && Number.isFinite(options.provider.minDurationSeconds) && options.provider.minDurationSeconds >= 0.1
    && Number.isFinite(duration) && duration >= options.provider.minDurationSeconds && duration <= options.provider.maxDurationSeconds
    && Number.isFinite(sizeBytes) && sizeBytes! <= options.provider.maxInputBytes && options.provider.languageCodes.includes(languageCode)
    && maxSpeakers >= options.provider.maxSpeakers.min && maxSpeakers <= options.provider.maxSpeakers.max;
  const seconds = Math.ceil(duration);
  const budget = options?.budget;
  const budgetAvailable = !!budget && !!options && budget.requester.remainingSubmissions >= 1 && budget.global.remainingSubmissions >= 1
    && budget.requester.remainingAudioSeconds >= seconds && budget.global.remainingAudioSeconds >= seconds
    && (budget.requester.outstanding ?? Infinity) < options.limits.requester.outstanding;
  const localAvailable = requestPolicy?.localEnabled ?? requestPolicy?.provider === "local-whisper";
  useEffect(() => {
    if (terminal && !localAvailable && provider === "local") setProvider(requestPolicy?.fallbackEnabled ? "amazon-transcribe" : "elevenlabs");
  }, [terminal, localAvailable, provider, requestPolicy?.fallbackEnabled]);
  const inputEligible = Number.isFinite(duration) && duration > 0 && duration <= 7200 &&
    Number.isFinite(sizeBytes) && sizeBytes! > 0 && sizeBytes! <= 2_000_000_000;
  const directAvailable = !!requestPolicy?.enabled && inputEligible && (retryProvider === "local" ? localAvailable : requestPolicy.fallbackEnabled && duration <= 3600);
  const blocked = disabled || requestBusy || activeRequest || listBusy || !!listError || uncertain ||
    (elevenlabs ? optionsBusy || !options?.enabled || !eligible || !credential || !budgetAvailable || !confirmed
      : !directAvailable || (paid && (!confirmed || (!!budget && !budgetAvailable))));
  async function request() {
    if (blocked || busyRef.current || (elevenlabs && (!credential || !scope))) return;
    busyRef.current = true; setRequestBusy(true); setRequestError("");
    const current = generation.current;
    try {
      const token = await getIdToken();
      if (!mounted.current || current !== generation.current) return;
      const selectedSettings = { languageCode, maxSpeakers };
      // Keep one key across transport retries; another staff action gets a fresh attempt.
      const attempt = terminal ? { newAttemptOf: currentTranscript!.id!, attemptKey: crypto.randomUUID() } : undefined;
      const response = elevenlabs
        ? await requestByokVideoTranscript(token, identity, selectedSettings, scope as TranscriptionCredentialScope, credential!.revision, attempt)
        : await requestVideoTranscript(token, identity, selectedSettings, { provider: retryProvider, ...attempt! });
      if (!mounted.current || current !== generation.current) return;
      if (!response.transcript?.id) throw new Error("Paid result identity is unavailable");
      setConfirmed(false); setPaidOpen(false); onRequested(response); setReload(value => value + 1);
    } catch (error) {
      if (!mounted.current || current !== generation.current) return;
      const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
      if (status === 401) setRequestError("Your session could not be verified. Sign in again, then reload transcription options.");
      else if (status === 409) setRequestError(error instanceof Error && error.message === "Another transcript request is processing for this video. Check saved transcripts" ? error.message
        : elevenlabs ? "The key or viewing copy changed. Reload options and reopen the video before another request."
        : "The viewing copy or earlier request changed. Reload options and reopen the video before another request.");
      else if (status === 429) {
        const detail = error instanceof Error ? error.message : "";
        setRequestError(detail === "A free transcript retry is already active for this earlier request" ? "A free retry from this earlier transcript is already active. Check saved transcripts."
          : detail === "You already have an active free transcript retry" ? "Your active free transcript retry must finish before another one. Check saved transcripts."
          : detail === "You have reached five free transcript retries today" ? "You have used five free transcript retries today. This limit resets at midnight UTC."
          : detail === "An earlier Amazon request for this video is not confirmed yet. Choose that request in the saved transcript list to try again." ? detail
          : detail === "One transcription request is already outstanding" ? "An existing transcription request must finish first. Check the saved transcript list."
          : detail === "Daily transcription budget is reserved or used" ? "The daily transcription allowance is reserved or used. Reload the remaining limits; daily limits reset at midnight UTC."
          : "The request limit was reached. Check saved requests and reload the remaining limits before trying again.");
      }
      else if (status === 403) setRequestError(paid ? "This paid request is not available for your account. Ask a CMS administrator for help."
        : "This transcript request is not available for your account. Ask a CMS administrator for help.");
      else if (status === 503) setRequestError(paid ? "Paid transcription is unavailable. Check the saved list before making another request."
        : "Local transcription is unavailable. Check the saved list before making another request.");
      else { setUncertain(true); setRequestError(paid ? "The request could not be confirmed. Check the saved transcript list and ask an administrator to check before another paid request."
        : "The request could not be confirmed. Close and reopen the video, then check the saved transcript list before trying again."); }
      setOptions(undefined); setConfirmed(false);
    } finally { busyRef.current = false; if (mounted.current) setRequestBusy(false); }
  }
  const actionLabel = elevenlabs ? "Request ElevenLabs transcript" : retryProvider === "local" ? "Request free transcript" : "Request Amazon transcript";
  const requestAction = <Button variant={terminal ? "primary" : "secondary"} disabled={blocked} onClick={() => void request()}>{requestBusy ? "Sending transcript request" : actionLabel}{actionTarget && elevenlabs && scope ? ` (${scope === "personal" ? "my key" : "station key"})` : ""}</Button>;
  return <section aria-label="Transcription choices">
    <label>Saved transcript<Select value={settings.transcriptId ?? ""} disabled={disabled || requestBusy || listBusy} onChange={event => {
      if (disabled || requestBusy) return;
      if (!event.target.value) onSelect();
      else { const selected = variants.find(value => value.id === event.target.value); if (selected) onSelect(selected); }
    }}>
      <option value="">Default transcription for this language</option>
      {settings.transcriptId && !variants.some(value => value.id === settings.transcriptId) ? <option value={settings.transcriptId}>Selected transcript · {settings.transcriptId.slice(0, 8)}</option> : null}
      {variants.filter(value => value.id).map(value => <option key={value.id} value={value.id}>{variantLabel(value)}</option>)}
    </Select></label>
    <p>Choose an existing result to read, correct or download it. This does not start transcription.</p>
    {listBusy ? <p role="status">Checking saved transcript choices.</p> : null}
    {listError ? <InlineMessage tone="error">{listError}</InlineMessage> : null}
    <Button disabled={disabled || requestBusy || listBusy || optionsBusy} onClick={() => setReload(value => value + 1)}>Reload transcription options</Button>
    {cursor ? <Button disabled={disabled || requestBusy || listBusy} onClick={() => void loadMore()}>Load more saved transcripts</Button> : null}
    {canRequest ? <details open={paidOpen} onToggle={event => { if (requestBusy && !event.currentTarget.open) { event.currentTarget.open = true; return; } setPaidOpen(event.currentTarget.open); }}>
      <summary onClick={event => { if (requestBusy) event.preventDefault(); }}>New transcript</summary>
      {terminal ? <>
        <p>Request another transcript. The earlier request and any saved result stay in the history.</p>
        <label>Transcript provider<Select value={provider} disabled={disabled || requestBusy} onChange={event => setProvider(event.target.value as typeof provider)}>
          <option value="local" disabled={!localAvailable}>Local worker Whisper (free)</option>
          <option value="amazon-transcribe" disabled={!requestPolicy?.fallbackEnabled}>Amazon Transcribe (paid)</option>
          <option value="elevenlabs">ElevenLabs (paid)</option>
        </Select></label>
        {!localAvailable ? <p>Free local transcription is currently unavailable.</p> : null}
        {!requestPolicy?.fallbackEnabled ? <p>Amazon transcription is currently unavailable.</p> : null}
      </> : null}
      {elevenlabs ? <>
      <p>For a paid transcript, choose an ElevenLabs account below. ElevenLabs Scribe v2 can create a separate transcript with speaker labels and word timings. Default requests try the station ElevenLabs key before Amazon Transcribe when paid processing is used.</p>
      <p>This sends the private web copy to ElevenLabs and can charge the selected account. The resulting transcript is shared with library staff, including when you use a personal key. Saving a key does not verify its validity or billing access.</p>
      <p>Published base price: $0.22 per audio hour. {Number.isFinite(duration) && duration > 0 ? <>This video's base estimate is {transcriptionChargeLabel(duration / 3600 * 0.22)}. </> : null}Account pricing, taxes and other charges can differ. <a href="https://elevenlabs.io/pricing/api" target="_blank" rel="noreferrer">Check ElevenLabs pricing</a>.</p>
      {optionsBusy ? <p role="status">Checking paid transcription availability.</p> : null}
      {optionsError ? <InlineMessage tone="error">{optionsError}</InlineMessage> : null}
      {options && !options.enabled ? <p>New paid requests are currently unavailable.</p> : null}
      {options && !eligible ? <p>This viewing copy or language is not eligible for the configured provider.</p> : null}
      <label>Account to charge<Select value={scope} disabled={disabled || requestBusy || optionsBusy || !options?.enabled} onChange={event => setScope(event.target.value as TranscriptionCredentialScope | "")}>
        <option value="">Choose a configured key</option>
        <option value="personal" disabled={!options?.credentials.some(value => value.scope === "personal" && value.configured)}>My ElevenLabs key</option>
        <option value="organization" disabled={!options?.credentials.some(value => value.scope === "organization" && value.configured)}>Station ElevenLabs key</option>
      </Select></label>
      {!credential ? <p>Choose a configured key. Use Transcription key settings to save or replace your key.</p> : <p>Selected key: configured, unverified. Revision {credential.revision}.</p>}
      </> : retryProvider === "local" ? <p>This request is free and runs on our own machine. It stays on this provider and does not start paid backup.</p>
        : <p>This sends the private viewing copy to Amazon Transcribe and can charge the station account. Recognition estimate: {transcriptionChargeLabel(estimateAwsTranscriptionCharge(duration) ?? 0)}. Other charges can apply. Paid daily limits apply; videos must be one hour or less.</p>}
      {terminal ? <label>New transcript language<Select value={languageCode} disabled={disabled || requestBusy} onChange={event => setLanguageCode(event.target.value as TranscriptSettings["languageCode"])}><option value="en-US">English</option><option value="es-US">Spanish</option></Select></label> : null}
      <label>Maximum speakers<Select value={maxSpeakers} disabled={disabled || requestBusy} onChange={event => setMaxSpeakers(Number(event.target.value))}>{Array.from({ length: 9 }, (_, index) => index + 2).map(value => <option key={value} value={value}>{value}</option>)}</Select></label>
      <p>Language: {languageCode === "es-US" ? "Spanish" : "English"}. The speaker limit is a maximum, not a verified count.</p>
      {paid && budget ? <><p>Paid daily limits for {budget.day} (UTC): you have {budget.requester.remainingSubmissions} requests and {Math.floor(budget.requester.remainingAudioSeconds / 60)} audio minutes remaining; the library has {budget.global.remainingSubmissions} requests and {Math.floor(budget.global.remainingAudioSeconds / 60)} minutes remaining.</p>
        <p>Your outstanding paid requests: {budget.requester.outstanding ?? "Not recorded"}. Reserved work is included in these limits; it is not a charge receipt.</p>
        {!budgetAvailable ? <p>This request exceeds the remaining daily allowance or an active request must finish first.</p> : null}</> : null}
      {paid ? <label className="video-paid-consent"><input type="checkbox" checked={confirmed} disabled={disabled || requestBusy || (elevenlabs && !credential)} onChange={event => setConfirmed(event.target.checked)} />{elevenlabs ? "I authorize this paid request with the selected key." : "I authorize this paid request with the station Amazon account."}</label> : null}
      {terminal ? requestAction : actionTarget ? (open && paidOpen ? createPortal(requestAction, actionTarget) : null) : requestAction}
      {requestError ? <InlineMessage tone="error" title="Transcript request needs attention">{requestError}</InlineMessage> : null}
    </details> : null}
  </section>;
}
