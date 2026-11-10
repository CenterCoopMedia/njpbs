import { createContext } from "react";

/** Canonical prose keeps its editor; only its formatting controls move to chrome. */
export const EditorInlineWriting = createContext({ inline: false, readOnly: false });
