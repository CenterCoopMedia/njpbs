import { useRef, useState } from "react";
import type { SiteUpdateRetryResult } from "../lib/site-update-retry";
import { ControlPresentationProvider } from "../context/ControlPresentationContext";
import { AsyncActionButton } from "./ui/Primitives";

export function SiteUpdateRetryAction({ onRetry, available }: { onRetry: (control: HTMLButtonElement) => Promise<SiteUpdateRetryResult>; available: boolean }) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ message: string; failed: boolean } | null>(null);
  const busy = useRef(false);
  return <span className="publication-recheck-action">
    <ControlPresentationProvider value="text"><AsyncActionButton size="comfortable" label="Retry site update"
      icon="refresh" pending={pending} disabled={!available || result?.failed === false} pendingLabel="Retrying…"
      pendingAnnouncement="Retrying the accepted site update. Your drafts stay as they are."
      onClick={event => {
        if (busy.current) return;
        busy.current = true;
        setPending(true);
        setResult(null);
        void onRetry(event.currentTarget).then(response => setResult({ message: response.message, failed: false }))
          .catch((error: unknown) => setResult({ message: error instanceof Error ? error.message : "The site update could not be retried. Refresh Publish activity.", failed: true }))
          .finally(() => { busy.current = false; setPending(false); });
      }} /></ControlPresentationProvider>
    {result ? <span role={result.failed ? "alert" : "status"}>{result.message}</span> : null}
  </span>;
}
