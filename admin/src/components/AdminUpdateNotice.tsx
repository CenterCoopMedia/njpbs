import { useEffect, useState } from "react";
import { fetchAdminBuildRevision } from "../lib/admin-status";
import { adminPerf } from "../lib/perf-receipts";
import { useExitGuard } from "../routes/ExitGuard";
import { Button, InlineMessage } from "./ui/Primitives";
import "./AdminUpdateNotice.css";

const CHECK_INTERVAL_MS = 5 * 60_000;

export function AdminUpdateNotice() {
  const [available, setAvailable] = useState(false);
  const requestExit = useExitGuard();

  useEffect(() => {
    // This is the identity reported by cms:browser's loadedBuild, including its short SHA.
    const loadedBuild = adminPerf.receipt().build;
    if (!loadedBuild || !/^[a-f0-9]{7,40}$/.test(loadedBuild)) return;
    let disposed = false;
    let found = false;
    let pending: AbortController | null = null;

    async function check() {
      if (disposed || found || pending || document.visibilityState === "hidden" || !navigator.onLine) return;
      const controller = new AbortController();
      pending = controller;
      const timeout = window.setTimeout(() => controller.abort(), 8_000);
      try {
        const revision = await fetchAdminBuildRevision(controller.signal);
        if (!disposed && revision && !revision.startsWith(loadedBuild!)) {
          found = true;
          setAvailable(true);
        }
      } catch {
        // Offline, unavailable and malformed checks never interrupt staff work.
      } finally {
        window.clearTimeout(timeout);
        pending = null;
      }
    }

    // Leave startup unchanged; the first background check is five minutes after mounting.
    const timer = window.setInterval(() => void check(), CHECK_INTERVAL_MS);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      pending?.abort();
    };
  }, []);

  if (!available) return null;
  return (
    <InlineMessage className="admin-update-notice" tone="info" role="status" title="A Boardwalk update is ready">
      <p>Save your work, then reload to use the latest version.</p>
      <div className="button-row">
        <Button size="comfortable" onClick={() => requestExit(() => window.location.reload())}>Reload Boardwalk</Button>
        <a className="admin-update-notes-link" href="/guide?whats-new=1" target="_blank" rel="noopener noreferrer" aria-label="What's new (opens in a new tab)">What's new</a>
      </div>
    </InlineMessage>
  );
}
