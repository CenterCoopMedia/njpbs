import { useEffect, useRef, useState } from "react";

type AutosaveState = "idle" | "saving" | "saved" | "error";

export function useDraftAutosave({
  identity,
  enabled,
  saving,
  savedVersion,
  draftKey,
  save,
  intervalMs = 60_000,
}: {
  identity: string;
  enabled: boolean;
  saving: boolean;
  savedVersion?: number;
  // Read the live draft once per interval. Null means there is no edit to save.
  draftKey(): string | null;
  save(): Promise<boolean>;
  intervalMs?: number;
}): AutosaveState {
  const current = useRef({ enabled, saving, savedVersion, draftKey, save });
  current.current = { enabled, saving, savedVersion, draftKey, save };
  const [state, setState] = useState<AutosaveState>("idle");

  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    let online = navigator.onLine !== false;
    let connection = 0;
    let attempted: { key: string; version?: number; connection: number; failed: boolean } | null = null;
    const offline = () => { online = false; };
    const reconnected = () => {
      if (navigator.onLine === false || online) return;
      online = true;
      connection += 1;
    };
    window.addEventListener("offline", offline);
    window.addEventListener("online", reconnected);
    setState("idle");
    const timer = setInterval(() => {
      const editor = current.current;
      if (stopped || inFlight || !online || navigator.onLine === false || !editor.enabled || editor.saving) return;
      const key = editor.draftKey();
      if (key === null) { attempted = null; return; }
      if (key === attempted?.key && editor.savedVersion === attempted.version &&
        (!attempted.failed || attempted.connection === connection)) return;
      // A failure can retry once after a real reconnect, on the ordinary timer.
      // Otherwise unchanged invalid drafts still wait for an edit or manual save.
      const attempt = { key, version: editor.savedVersion, connection, failed: false };
      attempted = attempt;
      inFlight = true;
      setState("saving");
      void (async () => {
        try {
          const saved = await editor.save();
          attempt.failed = !saved;
          if (!stopped) setState(saved ? "saved" : "error");
        } catch {
          attempt.failed = true;
          if (!stopped) setState("error");
        } finally { inFlight = false; }
      })();
    }, intervalMs);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", reconnected);
    };
  }, [identity, intervalMs]);

  return state;
}
