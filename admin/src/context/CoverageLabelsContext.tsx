import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { CoverageLabelsBuildData } from "../../../packages/content-core/src/coverage-labels";

export type CoverageLabelsLoader = (signal: AbortSignal) => Promise<CoverageLabelsBuildData | undefined>;
type State = { status: "unavailable" | "idle" | "loading" | "ready" | "error"; registry?: CoverageLabelsBuildData; source?: CoverageLabelsLoader };
const Context = createContext<State & { request: (retry?: boolean) => void }>({ status: "unavailable", request() {} });

/** One lazy published read per editor, shared by its selector and all previews. */
export function CoverageLabelsProvider({ load, children }: { load?: CoverageLabelsLoader; children: ReactNode }) {
  const [state, setState] = useState<State>({ status: "idle" });
  const latest = useRef(state); latest.current = state;
  const loader = useRef(load); loader.current = load;
  const pending = useRef<{ source: CoverageLabelsLoader; controller: AbortController }>();
  const generation = useRef(0);
  const request = useCallback((retry = false) => {
    if (!load || pending.current?.source === load || (!retry && latest.current.source === load && latest.current.status === "ready")) return;
    pending.current?.controller.abort();
    const current = ++generation.current, controller = new AbortController();
    pending.current = { source: load, controller };
    setState({ source: load, status: "loading" });
    void load(controller.signal).then(registry => {
      if (generation.current === current && loader.current === load) setState({ source: load, status: "ready", registry });
    }).catch((error: unknown) => {
      if (generation.current === current && loader.current === load && !controller.signal.aborted) {
        // Only an absent endpoint permits the old live-blog branding control.
        const unsupported = typeof error === "object" && error !== null && "status" in error && error.status === 404;
        setState({ source: load, status: unsupported ? "unavailable" : "error" });
      }
    }).finally(() => { if (generation.current === current) pending.current = undefined; });
  }, [load]);
  useEffect(() => () => { generation.current++; pending.current?.controller.abort(); pending.current = undefined; }, []);
  const current = !load ? { status: "unavailable" as const } : state.source === load ? state : { status: "idle" as const };
  return <Context.Provider value={{ ...current, request }}>{children}</Context.Provider>;
}

export function useCoverageLabels(enabled = true) {
  const value = useContext(Context);
  useEffect(() => { if (enabled) value.request(); }, [enabled, value.request]);
  return value;
}
