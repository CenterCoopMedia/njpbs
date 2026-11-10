import { createContext, useContext, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { Editor } from "@tiptap/react";
import { ActionControl } from "../components/ui/ActionControl";

type Owner = Editor | HTMLInputElement | HTMLTextAreaElement;
interface Snapshot { owner: Owner | null; undo: boolean; redo: boolean }
function createTextHistory() {
  let state: Snapshot = { owner: null, undo: false, redo: false };
  const listeners = new Set<() => void>();
  const store = {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => state,
    set(owner: Owner | null) {
      const rich = owner && !(owner instanceof HTMLElement) ? owner : null;
      const next = { owner, undo: rich ? rich.can().undo() : owner ? Boolean(document.queryCommandEnabled?.("undo")) : false,
        redo: rich ? rich.can().redo() : owner ? Boolean(document.queryCommandEnabled?.("redo")) : false };
      if (next.owner === state.owner && next.undo === state.undo && next.redo === state.redo) return;
      state = next; listeners.forEach(listener => listener());
    },
    update(editor: Editor) { if (state.owner === editor) store.set(editor); },
    release(editor: Editor) { if (state.owner === editor) store.set(null); },
    run(command: "undo" | "redo") {
      const owner = state.owner;
      if (!owner) return;
      if (owner instanceof HTMLElement) { if (!owner.isConnected || owner.matches(":disabled") || owner.readOnly) return; owner.focus({ preventScroll: true }); document.execCommand(command); store.set(owner); }
      else if (!owner.isDestroyed && owner.isEditable) { owner.chain().focus()[command]().run(); store.set(owner); }
    },
  };
  return store;
}
const Context = createContext<ReturnType<typeof createTextHistory> | null>(null);
/** Transaction updates notify only the two history controls, never the document tree. */
export function EditorTextHistoryProvider({ children }: { children: ReactNode }) {
  const store = useRef<ReturnType<typeof createTextHistory>>();
  store.current ??= createTextHistory();
  useEffect(() => {
    const current = store.current!;
    const nativeOwner = () => {
      const element = document.activeElement;
      if ((element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement && ["text", "search", "url", "email", "tel"].includes(element.type)) && element.closest(".app-shell[data-editor-kind]")) current.set(element);
    };
    const focus = (event: FocusEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest(".workspace-editing-bar")) return;
      if (!target.closest("[contenteditable='true']")) current.set(null);
      nativeOwner();
    };
    document.addEventListener("focusin", focus);
    document.addEventListener("input", nativeOwner);
    document.addEventListener("selectionchange", nativeOwner);
    return () => { document.removeEventListener("focusin", focus); document.removeEventListener("input", nativeOwner); document.removeEventListener("selectionchange", nativeOwner); };
  }, []);
  return <Context.Provider value={store.current}>{children}</Context.Provider>;
}
export function useEditorTextHistory() { return useContext(Context); }
const empty = { owner: null, undo: false, redo: false } as Snapshot;
const noSubscribe = () => () => {};
export function EditorHistoryControls({ arranging, readOnly, canUndo, canRedo, undo, redo }: { arranging: boolean; readOnly: boolean; canUndo: boolean; canRedo: boolean; undo: () => void; redo: () => void }) {
  const store = useEditorTextHistory();
  const snapshot = useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.snapshot ?? (() => empty));
  useEffect(() => { if (arranging) store?.set(null); }, [arranging, store]);
  const text = snapshot.owner;
  return <>{(["undo", "redo"] as const).map(command => <ActionControl key={command} action={command} size="compact"
    disabled={readOnly || !(text ? snapshot[command] : command === "undo" ? canUndo : canRedo)}
    onMouseDown={event => event.preventDefault()}
    onClick={() => { if (readOnly) return; if (text) store?.run(command); else (command === "undo" ? undo : redo)(); }} />)}</>;
}
