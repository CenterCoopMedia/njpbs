import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { guideVideoAsset } from "../lib/guide-video-assets";
import { useShell } from "./ShellContext";

export type GuidePlayback = "direct" | "blob";

const GuidePlaybackContext = createContext<GuidePlayback>("blob");

export function GuidePlaybackProvider({
  mode,
  children,
}: {
  mode: GuidePlayback;
  children: ReactNode;
}) {
  return <GuidePlaybackContext.Provider value={mode}>{children}</GuidePlaybackContext.Provider>;
}

async function privateVideoBlob(path: string, token: string, signal?: AbortSignal): Promise<string> {
  if (!guideVideoAsset(path)) throw new Error("The guide video path is invalid.");
  const response = await fetch(path, {
    cache: "no-store",
    headers: { authorization: `Bearer ${token}` },
    signal,
  });
  if (!response.ok) throw new Error(`The guide video request failed (${response.status}).`);
  return URL.createObjectURL(await response.blob());
}

export function GuideVideo({ label, src }: { label?: string; src?: string }) {
  const mode = useContext(GuidePlaybackContext);
  const { getIdToken } = useShell();
  const asset = src ? guideVideoAsset(src) : null;
  const playable = asset?.extension === "mp4" ? src : undefined;
  const poster = playable?.replace(/\.mp4$/, ".jpg");
  const chapters = playable?.replace(/\.mp4$/, ".vtt");
  const frameRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [near, setNear] = useState(false);
  const owned = useRef<string[]>([]);
  const alive = useRef(true);
  const playAbort = useRef<AbortController | null>(null);
  const [blobSrc, setBlobSrc] = useState<string>();
  const [posterSrc, setPosterSrc] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [unplayable, setUnplayable] = useState(false);
  const [streamFailed, setStreamFailed] = useState(false);

  useEffect(() => {
    alive.current = true;
    return () => {
    alive.current = false;
    playAbort.current?.abort();
    for (const url of owned.current) URL.revokeObjectURL(url);
    owned.current = [];
    };
  }, []);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setNear(true);
      observer.disconnect();
    }, { rootMargin: "300px 0px" });
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!near || mode !== "blob" || !poster || !getIdToken) return undefined;
    const controller = new AbortController();
    void (async () => {
      try {
        const url = await privateVideoBlob(poster, await getIdToken(), controller.signal);
        if (controller.signal.aborted) {
          URL.revokeObjectURL(url);
          return;
        }
        owned.current.push(url);
        setPosterSrc(url);
      } catch {
        if (!controller.signal.aborted) setPosterSrc(undefined);
      }
    })();
    return () => controller.abort();
  }, [getIdToken, mode, near, poster]);

  if (!playable || !label) {
    return <p className="admin-guide-video-error">This video is unavailable. Read the transcript below.</p>;
  }

  const videoPath = playable;
  const streaming = mode === "direct" && !streamFailed;
  const source = streaming ? videoPath : blobSrc;

  async function playFromButton() {
    if (!getIdToken || source || busy) return;
    playAbort.current?.abort();
    const controller = new AbortController();
    playAbort.current = controller;
    setBusy(true);
    setFailed(false);
    try {
      const url = await privateVideoBlob(videoPath, await getIdToken(), controller.signal);
      if (!alive.current || controller.signal.aborted) {
        URL.revokeObjectURL(url);
        return;
      }
      owned.current.push(url);
      setBlobSrc(url);
      const video = videoRef.current;
      if (video) {
        video.src = url;
        try {
          if (typeof video.play === "function") await video.play();
        } catch (error) {
          const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
          if (name === "NotAllowedError" || name === "AbortError" || !alive.current) return;
          setUnplayable(true);
        }
      }
    } catch {
      if (!alive.current || controller.signal.aborted) return;
      setFailed(true);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <div className="admin-guide-video-frame" ref={frameRef}>
      <video
        aria-label={label}
        controls={Boolean(source)}
        key={streaming ? "stream" : "download"}
        height={720}
        playsInline
        onError={() => {
          if (streaming) setStreamFailed(true);
        }}
        poster={near ? (streaming ? poster : posterSrc) : undefined}
        preload="none"
        ref={videoRef}
        src={near ? source : undefined}
        width={1280}
      >
        {streaming && chapters ? (
          <track default kind="chapters" label="Chapters" src={chapters} srcLang="en" />
        ) : null}
      </video>
      {!source ? (
        <button
          className="admin-guide-video-play"
          disabled={busy}
          onClick={() => void playFromButton()}
          type="button"
        >
          {busy ? "Loading video" : `Play ${label}`}
        </button>
      ) : null}
      {streamFailed && !source ? (
        <p role="alert">The video could not stream. Use Play to download it instead.</p>
      ) : null}
      {unplayable ? (
        <p role="alert">This video loaded, but the browser could not play it. Try the player controls or read the transcript.</p>
      ) : null}
      {failed ? (
        <p role="alert">This video could not be loaded. Read the transcript below.</p>
      ) : null}
    </div>
  );
}
