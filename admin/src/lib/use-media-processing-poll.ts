import { useEffect, useRef } from "react";
import { listSourceMedia, type SourceMediaStatusPage } from "./source-media";

/** One batch for the visible page; a slow request never overlaps the next tick. */
export function useMediaProcessingPoll(
  scope: string,
  sourceId: string,
  pendingIds: string[],
  getIdToken: () => Promise<string | null>,
  onResult: (page: SourceMediaStatusPage) => void,
  onComplete: () => void,
  paused = false,
) {
  const idsKey = JSON.stringify([...new Set(pendingIds)].sort());
  const callbacks = useRef({ onResult, onComplete });
  callbacks.current = { onResult, onComplete };
  const inFlight = useRef(false);
  const polls = useRef({ scope, count: 0 });
  useEffect(() => {
    if (polls.current.scope !== scope) polls.current = { scope, count: 0 };
    const ids: string[] = JSON.parse(idsKey);
    if (!ids.length) { if (!paused) polls.current.count = 0; return; }
    if (paused) return;
    let current = true;
    let timer: number | undefined;
    const available = () => document.visibilityState !== "hidden" && navigator.onLine !== false;
    const schedule = () => {
      window.clearTimeout(timer);
      if (current && available()) timer = window.setTimeout(poll, polls.current.count < 60 ? 10_000 : 60_000);
    };
    async function poll() {
      if (!current || !available()) return;
      if (inFlight.current) { schedule(); return; }
      inFlight.current = true;
      try {
        const token = await getIdToken();
        if (!current || !available()) return;
        polls.current.count += 1;
        const result = await listSourceMedia(token, { sourceId, pendingIds: ids });
        if (!current || !available()) return;
        callbacks.current.onResult(result);
        if (ids.some(id => result.records.find(record => record.id === id)?.viewingCopy?.state !== "processing")) {
          callbacks.current.onComplete();
        }
      } catch { /* A later bounded tick retries a transient read failure. */ }
      finally { inFlight.current = false; schedule(); }
    }
    document.addEventListener("visibilitychange", schedule);
    window.addEventListener("online", schedule);
    window.addEventListener("offline", schedule);
    schedule();
    return () => {
      current = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", schedule);
      window.removeEventListener("online", schedule);
      window.removeEventListener("offline", schedule);
    };
  }, [scope, sourceId, idsKey, getIdToken, paused]);
}
