import { useEffect, useRef, useState } from "react";
import type { PublicationRecheckResult } from "../lib/functions";
import { AsyncActionButton } from "./ui/Primitives";
import { ControlPresentationProvider } from "../context/ControlPresentationContext";
import "./PublicationRecheckAction.css";

export function PublicationRecheckAction({ onCheck, available = true, recordedResult }: {
  onCheck: () => Promise<PublicationRecheckResult>;
  available?: boolean;
  recordedResult?: { message: string; failed: boolean };
}) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ message: string; failed: boolean } | null>(null);
  const resultElement = useRef<HTMLSpanElement>(null);
  const started = useRef(false);
  const visibleResult = checking ? null : result ?? recordedResult;
  useEffect(() => {
    if (!available && !checking && visibleResult && started.current) {
      resultElement.current?.focus();
      started.current = false;
    }
  }, [available, checking, visibleResult]);
  return <span className="publication-recheck-action">
    {available ? <ControlPresentationProvider value="text"><AsyncActionButton size="comfortable"
      label="Check again" icon="refresh" pending={checking} pendingLabel="Checking…"
      pendingAnnouncement="Checking the public publication. Your edits are unchanged."
      onClick={() => {
        started.current = true;
        setChecking(true);
        setResult(null);
        void onCheck().then(response => setResult({ message: response.message, failed: response.outcome === "failed" }))
          .catch((error: unknown) => setResult({ message: error instanceof Error ? error.message : "Publication could not be checked. Try again.", failed: true }))
          .finally(() => setChecking(false));
      }} /></ControlPresentationProvider> : null}
    {visibleResult ? <span ref={resultElement} tabIndex={-1}
      role={visibleResult.failed ? "alert" : "status"}>{visibleResult.message}</span> : null}
  </span>;
}
