import { createContext, useRef, useState, type Dispatch, type MutableRefObject, type ReactNode, type SetStateAction } from "react";
import type { LiveWorkspaceState } from "../lib/live-production-state";

// Plain in-memory state only. The live route owns the reducer, transport and polling.
export const LiveProductionContext = createContext<{
  state: [LiveWorkspaceState | null, Dispatch<SetStateAction<LiveWorkspaceState | null>>];
  intentNumber: MutableRefObject<number>;
} | null>(null);

export function LiveProductionProvider({ children }: { children: ReactNode }) {
  const state = useState<LiveWorkspaceState | null>(null);
  const intentNumber = useRef(0);
  return <LiveProductionContext.Provider value={{ state, intentNumber }}>{children}</LiveProductionContext.Provider>;
}
