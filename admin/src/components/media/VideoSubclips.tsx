import { useCallback, useEffect, useRef, useState } from "react";
import { postFunction } from "../../lib/functions";
import { videoTime } from "../../lib/video-production";
import { MediaCollectionPicker } from "../MediaCollectionPicker";
import { Button, InlineMessage, TextInput } from "../ui/Primitives";

interface Range { inMs: number; outMs: number }
interface Subclip extends Range {
  id: string;
  name: string;
  fileVersion: string;
  state: "current" | "replaced" | "unavailable";
}
type Action = { action: "list" }
  | ({ action: "save"; name: string; fileVersion: string } & Range)
  | { action: "open"; id: string; fileVersion: string }
  | { action: "remove"; id: string };

export function VideoSubclips({ userId, assetId, fileVersion, durationMs, range, getIdToken, disabled, onOpen }: {
  userId: string;
  assetId: string;
  fileVersion: string;
  durationMs: number;
  range?: Range;
  getIdToken: () => Promise<string>;
  disabled: boolean;
  onOpen: (range: Range) => void;
}) {
  const [name, setName] = useState("");
  const [subclips, setSubclips] = useState<Subclip[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [collectionTarget, setCollectionTarget] = useState<{ clip: Subclip; opener: HTMLButtonElement }>();
  const active = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  const update = useCallback(async (action: Action, signal: AbortSignal) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await postFunction<{ success: true; subclips: Subclip[] }>(
        "cmsManageVideoSubclips", await getIdToken(), { sourceId: "video-library", assetId, ...action },
        {}, { appCheck: true, signal });
      if (!signal.aborted) {
        setSubclips(result.subclips);
        return result.subclips;
      }
    } catch (error) {
      if (!signal.aborted) setError(error instanceof Error ? error.message : "The saved subclip request failed. Try again.");
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }, [assetId, getIdToken]);

  useEffect(() => {
    const controller = new AbortController();
    active.current = controller;
    void update({ action: "list" }, controller.signal);
    return () => controller.abort();
  }, [update]);

  async function act(action: Action) {
    const signal = active.current?.signal;
    if (!signal || busy) return;
    const result = await update(action, signal);
    if (!result || signal.aborted) return;
    if (action.action === "save") {
      setName("");
      setNotice("Subclip saved.");
    } else if (action.action === "open") {
      const clip = result.find(item => item.id === action.id);
      if (clip?.state === "current" && clip.fileVersion === fileVersion) {
        onOpen(clip);
        setNotice("Saved in and out times opened.");
      }
    } else if (action.action === "remove") {
      heading.current?.focus();
      setNotice("Subclip removed.");
    }
  }

  return <section aria-label="Saved subclips">
    <h4 ref={heading} tabIndex={-1}>Saved subclips</h4>
    <p>Save this range to your account for reuse with the same video file.</p>
    <label>Subclip name<TextInput value={name} maxLength={120} disabled={disabled || busy}
      onChange={event => setName(event.target.value)} /></label>
    <Button disabled={disabled || busy || !range || !name.trim()} onClick={() => {
      if (range) void act({ action: "save", name, fileVersion, ...range });
    }}>Save subclip</Button>
    <div role="status">{notice}</div>
    {busy && !subclips ? <p role="status">Loading saved subclips…</p> : null}
    {error ? <InlineMessage tone="error" title="Saved subclips need attention">
      <p>{error}</p>
      <Button disabled={busy} onClick={() => void act({ action: "list" })}>Reload saved subclips</Button>
    </InlineMessage> : null}
    {subclips?.length ? <ul className="video-recent-clips">{subclips.map(clip => {
      const replaced = clip.state === "replaced" || clip.fileVersion !== fileVersion;
      const unavailable = clip.state === "unavailable" || clip.outMs > durationMs;
      return <li key={clip.id}>
        <p><strong>{clip.name}</strong><br />{videoTime(clip.inMs / 1000)} to {videoTime(clip.outMs / 1000)}</p>
        {replaced ? <p>This subclip belongs to a previous video file.</p>
          : unavailable ? <p>This range is unavailable in the current viewing copy.</p> : null}
        <div className="video-production-buttons">
          <Button disabled={disabled || busy || replaced || unavailable} aria-label={`Open range for ${clip.name}`}
            onClick={() => void act({ action: "open", id: clip.id, fileVersion })}>Open range</Button>
          <Button disabled={disabled || busy || replaced || unavailable} aria-label={`Add ${clip.name} to collection`}
            onClick={event => setCollectionTarget({ clip, opener: event.currentTarget })}>Add to collection</Button>
          <Button disabled={disabled || busy} aria-label={`Remove subclip ${clip.name}`}
            onClick={() => void act({ action: "remove", id: clip.id })}>Remove</Button>
        </div>
      </li>;
    })}</ul> : null}
    {collectionTarget ? <MediaCollectionPicker open userId={userId} getIdToken={getIdToken}
      refs={[{ backend: "subclip", id: collectionTarget.clip.id }]} subclipAssetId={assetId}
      focusOpener={collectionTarget.opener} onClose={() => setCollectionTarget(undefined)}
      onAdded={collection => {
        setNotice(`Subclip is in ${collection.name}.`);
        setCollectionTarget(undefined);
      }} /> : null}
  </section>;
}
