import { createContext, useContext } from "react";

export const EditorOverlayOwner = createContext<HTMLElement | null>(null);

/** Nested editor controls must stay inside the native modal top layer. */
export function useOverlayOwner(): HTMLElement | null {
  return useContext(EditorOverlayOwner);
}
