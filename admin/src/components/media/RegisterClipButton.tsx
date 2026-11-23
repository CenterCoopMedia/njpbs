import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { setMediaSourceCount } from "../../lib/media-session-cache";
import { mediaVideosPath } from "../../lib/routes";
import { registerVideoClip, type VideoIdentity } from "../../lib/video-production";
import { invalidateVideoSearchCorpus } from "../../lib/video-search-session-cache";
import { Button, InlineMessage } from "../ui/Primitives";

export function RegisterClipButton({ identity, clipId, attemptId, getIdToken, disabled, onRegistered }: {
  identity: VideoIdentity;
  clipId: string;
  attemptId: string;
  getIdToken: () => Promise<string>;
  disabled: boolean;
  onRegistered?: () => void;
}) {
  const request = useRef<AbortController>();
  const [pending, setPending] = useState(false);
  const [asset, setAsset] = useState<{ id: string; name: string }>();
  const [error, setError] = useState("");
  useEffect(() => () => request.current?.abort(), []);

  async function register() {
    if (disabled || request.current || asset) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError("");
    try {
      const token = await getIdToken();
      if (controller.signal.aborted) return;
      const result = await registerVideoClip(token, identity, clipId, attemptId, controller.signal);
      if (controller.signal.aborted) return;
      setAsset(result.asset);
      invalidateVideoSearchCorpus(identity.sourceId);
      setMediaSourceCount(identity.sourceId, null);
      onRegistered?.();
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "The clip could not be saved. Try again.");
    } finally {
      request.current = undefined;
      if (!controller.signal.aborted) setPending(false);
    }
  }

  return <>
    <Button aria-disabled={disabled || pending || Boolean(asset) || undefined} aria-busy={pending || undefined}
      onClick={() => void register()}>{pending ? "Saving clip" : asset ? "Saved to video library" : "Save clip to video library"}</Button>
    {asset ? <p role="status">Saved <Link to={`${mediaVideosPath(identity.sourceId)}?${new URLSearchParams({ asset: asset.id })}`}>{asset.name}</Link> to the video library.</p> : null}
    {error ? <InlineMessage tone="error" title="Clip could not be saved">{error}</InlineMessage> : null}
  </>;
}
