import { useEffect, useRef, useState } from "react";
import type { HomeSelectionReceipt } from "../../../packages/content-core/src/home-source-selection";
import type { HomeSourceSnapshot } from "../../../packages/content-core/src/home-rail-render";
import { loadHomeSourceSnapshot } from "../lib/home-source-snapshot";
import { Button } from "./ui/Primitives";

interface HomePostSectionOptions {
  exists: boolean; hidden: boolean; disabled: boolean; loadSources?: (signal: AbortSignal) => Promise<HomeSourceSnapshot>;
  onAdd: (receipt: HomeSelectionReceipt) => void; onRestore: () => void;
}

export function useHomePostSectionControl({ exists, disabled, loadSources = loadHomeSourceSnapshot, onAdd, onRestore }: HomePostSectionOptions) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController>();
  const allowed = useRef(!disabled && !exists);
  allowed.current = !disabled && !exists;
  useEffect(() => () => request.current?.abort(), []);
  async function add() {
    if (disabled || busy) return;
    if (exists) { onRestore(); return; }
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError("");
    const timer = window.setTimeout(() => { controller.abort(); setBusy(false); setError("Published Posts took too long to load. Try adding the section again."); }, 10_000);
    try {
      const sources = await loadSources(controller.signal);
      if (!sources.editorial) throw new Error("No published catalog");
      if (!controller.signal.aborted && allowed.current) onAdd(sources.editorial.receipt);
    } catch { if (!controller.signal.aborted) setError("Published Posts could not be loaded. Try adding the section again."); }
    finally { window.clearTimeout(timer); if (!controller.signal.aborted) setBusy(false); }
  }
  return { add, busy, error };
}

export function HomePostSectionControl(props: HomePostSectionOptions) {
  const { add, busy, error } = useHomePostSectionControl(props);
  return <div>{!props.exists || props.hidden ? <Button disabled={props.disabled || busy} onClick={() => void add()}>{busy ? "Loading published Posts…" : props.hidden ? "Restore NJ PBS Post section" : "Add NJ PBS Post section"}</Button> : null}
    {error ? <p role="alert">{error}</p> : null}</div>;
}
