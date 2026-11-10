import { useEffect, useRef, useState } from "react";
import type { MediaAssetSummary } from "../../lib/functions";
import { cmsGetVoiceoverAudioResponse } from "../../lib/functions";
import { Button, InlineMessage } from "../ui/Primitives";
import { LoadingIndicator } from "../ui/LoadingIndicator";
import { formatMediaDuration, formatMediaUpdated } from "../../lib/media-format";

export type AudioToken = () => Promise<string>;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

async function privateAudio(asset: MediaAssetSummary, getIdToken: AudioToken, signal: AbortSignal) {
  const response = await cmsGetVoiceoverAudioResponse(await getIdToken(), { schemaVersion: 1, assetId: asset.id }, signal);
  const size = Number(response.headers.get("content-length"));
  if (response.headers.get("content-type")?.split(";")[0] !== "audio/wav" ||
      !Number.isSafeInteger(size) || size < 1 || size > MAX_AUDIO_BYTES) {
    void response.body?.cancel();
    throw new Error("The audio response is invalid.");
  }
  const blob = await response.blob();
  if (blob.size !== size) throw new Error("The audio response is incomplete.");
  return blob;
}

function useAudioFile(asset: MediaAssetSummary, getIdToken?: AudioToken) {
  const [state, setState] = useState<{ id: string; url?: string; loading?: boolean; error?: string }>({ id: asset.id });
  const controller = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | null>(null);
  useEffect(() => {
    setState({ id: asset.id });
    return () => {
      controller.current?.abort();
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    };
  }, [asset.id]);
  async function load() {
    if (asset.source !== "voiceover") return asset.url;
    if (state.id === asset.id && state.url) return state.url;
    if (!getIdToken || state.loading) return null;
    const request = new AbortController();
    controller.current = request;
    setState({ id: asset.id, loading: true });
    try {
      const blob = await privateAudio(asset, getIdToken, request.signal);
      if (request.signal.aborted) return null;
      const url = URL.createObjectURL(blob);
      objectUrl.current = url;
      setState({ id: asset.id, url });
      return url;
    } catch (error) {
      if (!request.signal.aborted) setState({ id: asset.id, error: error instanceof Error ? error.message : "Audio could not be loaded." });
      return null;
    }
  }
  return { ...state, load };
}

export function audioTakeFacts(asset: MediaAssetSummary): string[] {
  const take = asset.voiceover;
  const created = formatMediaUpdated(asset.createdAt);
  return [
    take?.performer_name ? `Voice: ${take.performer_name}` : null,
    take?.style ? `Style: ${take.style}` : null,
    typeof take?.take === "number" && Number.isFinite(take.take) ? `Take ${take.take}` : null,
    typeof take?.duration_seconds === "number" && Number.isFinite(take.duration_seconds) && take.duration_seconds > 0
      ? `Duration ${formatMediaDuration(take.duration_seconds)}` : null,
    created ? `Created ${created}` : null,
  ].filter((fact): fact is string => Boolean(fact));
}

export function AudioPlayback({ asset, getIdToken }: { asset: MediaAssetSummary; getIdToken?: AudioToken }) {
  const file = useAudioFile(asset, getIdToken);
  const player = useRef<HTMLAudioElement>(null);
  const privateFile = asset.source === "voiceover";
  const url = privateFile ? file.id === asset.id ? file.url : undefined : asset.url;
  return <div className="media-audio-preview">
    {privateFile && !url ? <Button aria-label={`Listen to ${asset.name}`} disabled={file.loading || !getIdToken} onClick={async () => {
      if (await file.load()) requestAnimationFrame(() => void player.current?.play().catch(() => {}));
    }}>Listen</Button> : null}
    {file.loading ? <LoadingIndicator label="Loading private audio" /> : null}
    {file.error ? <InlineMessage tone="error" title="Audio could not be loaded">{file.error}</InlineMessage> : null}
    {url ? <audio ref={player} aria-label={`Play ${asset.name}`} controls preload="none" src={url}
      style={{ width: "100%", maxWidth: "100%" }} onPlay={event => {
        for (const other of document.querySelectorAll("audio")) if (other !== event.currentTarget) other.pause();
      }} /> : null}
    <p>{privateFile ? "Private voiceover recording. Audio loads when you choose Listen." : "Staff-uploaded WAV audio."}</p>
  </div>;
}

/** A small play control for cards; the inspector keeps native seek controls. */
export function AudioCardPlayback({ asset, getIdToken, tabIndex }: {
  asset: MediaAssetSummary; getIdToken?: AudioToken; tabIndex?: number;
}) {
  const file = useAudioFile(asset, getIdToken);
  const player = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [playbackError, setPlaybackError] = useState(false);
  const playbackRequest = useRef(0);
  useEffect(() => {
    setPlaying(false);
    setPlaybackError(false);
    return () => { playbackRequest.current += 1; };
  }, [asset.id]);
  function playbackFailed() {
    setPlaying(false);
    setPlaybackError(true);
  }
  const privateFile = asset.source === "voiceover";
  const url = privateFile ? file.id === asset.id ? file.url : undefined : asset.url;
  const action = playing ? "Pause" : "Listen";
  return <div className="media-audio-card-playback">
    <Button aria-label={playing ? `Pause ${asset.name}` : `Listen to ${asset.name}`}
      disabled={file.loading || (privateFile && !getIdToken)}
      tabIndex={tabIndex} onClick={async () => {
        if (playing) { player.current?.pause(); return; }
        const request = ++playbackRequest.current;
        setPlaybackError(false);
        if (!await file.load() || request !== playbackRequest.current) return;
        requestAnimationFrame(async () => {
          const audio = player.current;
          if (!audio || request !== playbackRequest.current) return;
          try {
            if (playbackError) audio.load();
            await audio.play();
          } catch {
            if (request === playbackRequest.current) playbackFailed();
          }
        });
      }}>{file.loading ? "Loading audio" : action}</Button>
    {url ? <audio key={asset.id} aria-hidden="true" className="media-audio-card-player" ref={player} preload="none" src={url}
      onPlay={event => {
        setPlaying(true);
        for (const other of document.querySelectorAll("audio")) if (other !== event.currentTarget) other.pause();
      }} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={playbackFailed} /> : null}
    {playbackError ? <InlineMessage tone="error" title="Audio could not be played">Choose Listen to try again.</InlineMessage> : null}
    {file.error ? <InlineMessage tone="error" title="Audio could not be loaded">{file.error}</InlineMessage> : null}
  </div>;
}

export function AudioDownload({ asset, getIdToken }: { asset: MediaAssetSummary; getIdToken?: AudioToken }) {
  const file = useAudioFile(asset, getIdToken);
  return <div><Button disabled={file.loading || !getIdToken} onClick={async () => {
    const url = await file.load();
    if (!url) return;
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = asset.originalName; anchor.click();
  }}>{file.loading ? "Loading WAV" : "Download WAV"}</Button>
    {file.error ? <InlineMessage tone="error" title="WAV could not be downloaded">{file.error}</InlineMessage> : null}
  </div>;
}
