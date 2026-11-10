import { useCallback, useEffect, useRef, useState } from "react";
import { isConflictError, type GetSettingsResponse, type MutateSettingsResponse, type SettingsPublicationReceipt } from "../lib/functions";

// Poll only the addressed settings operation. Status reads never adopt working
// values, so a late response cannot overwrite the editor's unsaved draft.
export function useSettingsPublication(load: () => Promise<GetSettingsResponse<unknown>>,
  publishAccepted: (sourceVersion: number) => Promise<MutateSettingsResponse<unknown>>) {
  const [publication, setPublication] = useState<SettingsPublicationReceipt | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const observation = useRef(0);
  const observe = useCallback((receipt?: SettingsPublicationReceipt) => {
    observation.current += 1;
    setNeedsRefresh(false);
    setPublication(receipt ?? null);
  }, []);
  const refresh = async () => {
    if (!publication || retrying) return;
    const observed = observation.current;
    setRetrying(true);
    try {
      const response = await load();
      if (observed !== observation.current) return;
      observe(response.found ? response.publication : undefined);
    } catch {
      if (observed === observation.current) setPublication({ ...publication,
        warning: "The site update could not be checked. Refresh the site update to try again." });
    } finally { setRetrying(false); }
  };
  const retry = async () => {
    if (!publication || retrying || needsRefresh) return;
    const observed = observation.current;
    setRetrying(true);
    try {
      const response = await publishAccepted(publication.sourceVersion);
      if (observed !== observation.current) return;
      if (!response.publication) throw new Error("The settings publication receipt is missing.");
      observe(response.publication);
    } catch (error) {
      if (observed !== observation.current) return;
      if (isConflictError(error)) {
        // A 409 can also be a release or billing gate. Read only the receipt to
        // distinguish replacement; retain the server's actionable refusal.
        let changed = true;
        try {
          const current = await load();
          changed = !current.found || !current.publication ||
            current.publication.originalOperationId !== publication.originalOperationId;
        } catch { /* A failed read leaves explicit refresh available. */ }
        if (observed !== observation.current) return;
        setNeedsRefresh(changed);
        setPublication({ ...publication, warning: error instanceof Error ? error.message
          : "The site update was refused. Refresh the site update to check its status." });
      } else {
        setPublication({ ...publication, warning: "The site update could not be retried. Try again." });
      }
    } finally { setRetrying(false); }
  };
  useEffect(() => {
    if (!publication || publication.status !== "pending" || publication.warning) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const response = await load();
        if (cancelled) return;
        if (!response.found || !response.publication ||
            response.publication.originalOperationId !== publication.originalOperationId) {
          setNeedsRefresh(true);
          setPublication({ ...publication, warning: "This publication changed. Refresh the site update to check its status. Your draft will stay as it is." });
          return;
        }
        setPublication(response.publication);
      } catch {
        if (!cancelled) setPublication({ ...publication, warning: "The site update could not be checked. Retry publication." });
      }
    }, 2_000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [load, publication]);
  return { publication, observe, retry, retrying, refresh, needsRefresh };
}
