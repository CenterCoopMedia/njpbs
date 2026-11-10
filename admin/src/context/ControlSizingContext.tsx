import { createContext, useContext, type ReactNode } from "react";

export type ControlSize = "legacy" | "compact" | "standard" | "comfortable";
const Context = createContext<ControlSize | null>(null);

/** A deliberate consumer boundary; unconverted screens retain their legacy sizes. */
export function ControlSizingProvider({ size, children }: { size: ControlSize; children: ReactNode }) {
  return <Context.Provider value={size}>{children}</Context.Provider>;
}

export function useControlSize(): ControlSize | null {
  return useContext(Context);
}
