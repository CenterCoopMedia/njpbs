import { createContext, useContext, type ReactNode } from "react";
import {
  DEFAULT_CONTROL_PRESENTATION,
  type ControlPresentation,
} from "../lib/control-presentation";

const ControlPresentationContext = createContext<ControlPresentation>(
  DEFAULT_CONTROL_PRESENTATION,
);

export function ControlPresentationProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: ControlPresentation;
}) {
  return (
    <ControlPresentationContext.Provider value={value}>
      {children}
    </ControlPresentationContext.Provider>
  );
}

export function useControlPresentation(): ControlPresentation {
  return useContext(ControlPresentationContext);
}
