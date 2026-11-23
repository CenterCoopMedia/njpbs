import { useCallback, useEffect, useRef, useState } from "react";
import { HttpError, postFunction } from "./functions";
import { BULK_SAVE_INTERVAL_MS, type MetadataPatch } from "./source-media-bulk";
import { invalidateVideoSearchCorpus } from "./video-search-session-cache";

export type VideoBatchEntry<P = MetadataPatch> = { assetId: string; expectedVersion: number; changes: P };
type VideoBatchItem = {
  assetId: string;
  name?: string;
  originalName?: string;
  status: "pending" | "saved" | "unchanged" | "stale" | "unavailable" | "canceled";
};
export type VideoMetadataBatch = {
  operationKey: number;
  status: "active" | "completed" | "canceled";
  items: VideoBatchItem[];
};
type BatchRequest =
  | { action: "inspect" }
  | { action: "start"; operationKey: number; entries: VideoBatchEntry[] }
  | { action: "advance"; operationKey: number; assetId: string }
  | { action: "cancel"; operationKey: number };
type Command =
  | Exclude<BatchRequest, { action: "advance" | "start" }>
  | { action: "resume"; operationKey: number }
  | (Extract<BatchRequest, { action: "start" }> & { onStarted: (batch: VideoMetadataBatch) => void });

type Activity = "checking" | "saving" | "canceling";
type BatchView = { scope: string; batch?: VideoMetadataBatch | null; activity?: Activity; error?: string; pausing?: boolean };
type Session = { scope: string; controller: AbortController; busy?: boolean; stop?: () => void; refreshNeeded?: boolean };

export function useVideoMetadataBatch(userId: string, sourceId: string, canEdit: boolean, getIdToken: () => Promise<string>) {
  const scope = JSON.stringify([userId, sourceId, canEdit]);
  const session = useRef<Session>();
  const getToken = useRef(getIdToken);
  getToken.current = getIdToken;
  const [view, setView] = useState<BatchView>();

  const run = useCallback(async (command: Command) => {
    const owner = session.current;
    if (!owner || owner.scope !== scope || owner.busy) return;
    owner.busy = true;
    const { signal } = owner.controller;
    const activity = command.action === "inspect" ? "checking" : command.action === "cancel" ? "canceling" : "saving";
    let paused = false;
    let wake: (() => void) | undefined;
    function stop() {
      paused = true;
      wake?.();
    }
    owner.stop = stop;
    signal.addEventListener("abort", stop, { once: true });
    const update = (patch: Partial<BatchView>) => {
      if (!signal.aborted) setView(previous => ({ ...(previous?.scope === scope ? previous : { scope }), ...patch }));
    };
    update({ activity, error: undefined, pausing: false });
    let advanced = false;
    try {
      const token = await getToken.current();
      const send = async (request: BatchRequest) => {
        signal.throwIfAborted();
        const { batch } = await postFunction<{ batch: VideoMetadataBatch | null }>(
          "cmsSourceMediaMetadataBatch", token, { sourceId, ...request }, {}, { appCheck: true, signal },
        );
        signal.throwIfAborted();
        update({ batch });
        return batch;
      };
      if (paused) return;
      if (command.action === "inspect" || command.action === "cancel") {
        await send(command);
        return;
      }

      const { operationKey } = command;
      let batch = command.action === "start"
        ? await send({ action: "start", operationKey, entries: command.entries })
        : await send({ action: "inspect" });
      if (!batch || batch.operationKey !== operationKey) {
        update({ error: "The latest video batch changed. Check its results before continuing." });
        return;
      }
      if (command.action === "start") {
        if (batch.items.some(item => item.status === "stale" || item.status === "unavailable")) owner.refreshNeeded = true;
        command.onStarted(batch);
      }
      for (const { assetId } of batch.items) {
        if (paused || batch.status !== "active") break;
        if (!batch.items.some(item => item.assetId === assetId && item.status === "pending")) continue;
        if (advanced) {
          await new Promise<void>(resolve => {
            const timer = window.setTimeout(() => { wake = undefined; resolve(); }, BULK_SAVE_INTERVAL_MS);
            wake = () => { window.clearTimeout(timer); wake = undefined; resolve(); };
          });
        }
        if (paused) break;
        advanced = true;
        owner.refreshNeeded = true;
        batch = await send({ action: "advance", operationKey, assetId });
        if (!batch || batch.operationKey !== operationKey) {
          throw new Error("Video batch advance returned a different operation");
        }
      }
    } catch (error) {
      const message = error instanceof HttpError && error.status === 429
        ? "The request limit was reached. Wait, then check the batch status."
        : "The batch status could not be confirmed. Check the latest results before continuing.";
      update({ error: message });
    } finally {
      if (advanced) invalidateVideoSearchCorpus(sourceId);
      signal.removeEventListener("abort", stop);
      owner.busy = false;
      owner.stop = undefined;
      update({ activity: undefined, pausing: false });
    }
  }, [scope, sourceId]);

  useEffect(() => {
    if (!userId || !canEdit) return;
    const owner = { scope, controller: new AbortController() };
    session.current = owner;
    // Clear the last receipt when access changes, including a change away and back.
    setView({ scope });
    void run({ action: "inspect" });
    return () => { owner.controller.abort(); session.current = undefined; };
  }, [canEdit, run, scope, userId]);

  const current = view?.scope === scope ? view : undefined;
  return {
    ...current,
    run,
    takeRefresh() {
      const owner = session.current;
      if (owner?.scope !== scope || !owner.refreshNeeded) return false;
      owner.refreshNeeded = false;
      return true;
    },
    pause() {
      session.current?.stop?.();
      setView(previous => previous?.scope === scope ? { ...previous, pausing: true } : previous);
    },
  };
}
