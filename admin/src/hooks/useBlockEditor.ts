import { useCallback, useRef, useState } from "react";
import {
  blockEditorReducer,
  initialBlockEditorState,
  type BlockEditorAction,
  type BlockEditorState,
  type HomeTextField,
} from "../lib/block-editor-state";
import { createBlock, type AdminBlock } from "../lib/block-factory";
import type { BlockType } from "../../../packages/content-core/src/content-model";
import type { SectionId } from "../../../packages/content-core/src/editor-admin";
import type { ContentDestination, ContentRowEdit } from "../lib/content-row-editing";

function defaultNewId(): string {
  return crypto.randomUUID();
}

export interface UseBlockEditorOptions {
  // A block id generator. Defaults to crypto.randomUUID in the browser; tests inject a
  // deterministic counter so ids are stable and no secure-context global is needed.
  newId?: () => string;
}

// The block editor's state plus the actions the UI dispatches, with id generation and
// index defaulting handled here so the component never touches the reducer's op shape.
export interface BlockEditorApi {
  blocks: AdminBlock[];
  error: string | null;
  canUndo: boolean;
  canRedo: boolean;
  // How many entries the undo stack holds. The editor watches this to tell whether the removal its
  // undo notice offers to take back is still the top of the stack: once anything else is recorded,
  // an "Undo removal" button would reverse a different action, so the notice is withdrawn (#1035).
  undoDepth: number;
  insertBlock: (type: BlockType, index?: number, data?: Record<string, unknown>) => void;
  insertContent: (type: BlockType, destination: ContentDestination) => string | null;
  editRows: (edit: ContentRowEdit) => BlockEditorState;
  duplicateContent: (id: string, column?: number) => void;
  removeBlock: (id: string) => void;
  moveBlock: (id: string, toIndex: number) => void;
  setBlockData: (id: string, data: Record<string, unknown>, discrete?: boolean) => void;
  replaceBlock: (id: string, type: BlockType, data: Record<string, unknown>) => void;
  setHomeText: (id: string, field: HomeTextField, value: string) => void;
  setLiveBlogSidebar: (id: string, sidebar: boolean) => void;
  setBlockVisible: (id: string, visible: boolean, homeSection?: boolean) => void;
  undo: () => void;
  redo: () => void;
  clearError: () => void;
  // Reconcile the server's canonical ids onto the live list after a save (#515), given a map
  // from each sent block's id to its server-minted one. Live blocks in the map take the
  // canonical id and keep their data; blocks added during the save keep their temporary ids.
  // Called on a successful save, never on a user edit; it resets undo because a persist is a
  // commit point.
  reconcileSavedIds: (idMap: Record<string, string>, savedBlocks?: readonly AdminBlock[]) => void;
}

// Bind the pure block-editor reducer to React state for one section. The reducer is
// curried with the section (fixed for an editor instance); the returned methods mint block
// ids and default an append index, so the component dispatches intent, not op structure.
export function useBlockEditor(
  section: SectionId,
  initialBlocks: AdminBlock[] = [],
  options: UseBlockEditorOptions = {},
): BlockEditorApi {
  const newId = options.newId ?? defaultNewId;
  const [state, setState] = useState(() => initialBlockEditorState(initialBlocks));
  const stateRef = useRef(state);
  const dispatch = useCallback(
    (action: BlockEditorAction) => {
      const next = blockEditorReducer(section, stateRef.current, action);
      stateRef.current = next;
      setState(next);
      return next;
    },
    [section],
  );

  const insertBlock = useCallback(
    (type: BlockType, index?: number, data?: Record<string, unknown>) => {
      // The reducer resolves a missing index to the end of its fresh state, so this does
      // not close over state.blocks.length -- N inserts in one tick still append in order.
      const block = createBlock(type, newId());
      if (data) block.data = { ...block.data, ...data };
      dispatch({ kind: "insertBlock", block, index });
    },
    [dispatch, newId],
  );

  const removeBlock = useCallback((id: string) => {
    dispatch({ kind: "apply", op: { kind: "remove", id } });
  }, [dispatch]);

  const editRows = useCallback((edit: ContentRowEdit) => dispatch({ kind: "editRows", edit }), [dispatch]);
  const duplicateContent = useCallback((id: string, column?: number) => {
    const newIds: Record<string, string> = {};
    for (const block of stateRef.current.blocks) {
      if (block.id === id || block.layout?.rowId === id) newIds[block.id] = newId();
    }
    dispatch({ kind: "editRows", edit: { kind: "duplicate", id, column, newIds } });
  }, [dispatch, newId]);
  const insertContent = useCallback((type: BlockType, destination: ContentDestination) => {
    const block = createBlock(type, newId());
    const next = dispatch({ kind: "editRows", edit: { kind: "insert", block, destination } });
    return !next.error && next.blocks.some(candidate => candidate.id === block.id) ? block.id : null;
  }, [dispatch, newId]);

  const moveBlock = useCallback((id: string, toIndex: number) => {
    dispatch({ kind: "apply", op: { kind: "move", id, toIndex } });
  }, [dispatch]);

  const setBlockData = useCallback((id: string, data: Record<string, unknown>, discrete = false) => {
    dispatch({ kind: "setData", id, data, discrete });
  }, [dispatch]);
  const replaceBlock = useCallback((id: string, type: BlockType, data: Record<string, unknown>) => {
    dispatch({ kind: "replaceBlock", id, type, data });
  }, [dispatch]);
  const setHomeText = useCallback((id: string, field: HomeTextField, value: string) => {
    dispatch({ kind: "setHomeText", id, field, value });
  }, [dispatch]);

  const setLiveBlogSidebar = useCallback((id: string, sidebar: boolean) => {
    dispatch({ kind: "setLiveBlogSidebar", id, sidebar });
  }, [dispatch]);
  const setBlockVisible = useCallback((id: string, visible: boolean, homeSection = false) => {
    dispatch({ kind: "setVisible", id, visible, homeSection });
  }, [dispatch]);

  const undo = useCallback(() => dispatch({ kind: "undo" }), [dispatch]);
  const redo = useCallback(() => dispatch({ kind: "redo" }), [dispatch]);
  const clearError = useCallback(() => dispatch({ kind: "clearError" }), [dispatch]);
  const reconcileSavedIds = useCallback(
    (idMap: Record<string, string>, savedBlocks?: readonly AdminBlock[]) => dispatch({ kind: "reconcileIds", idMap, savedBlocks }),
    [dispatch],
  );

  return {
    blocks: state.blocks,
    error: state.error,
    canUndo: state.undo.length > 0,
    canRedo: state.redo.length > 0,
    undoDepth: state.undo.length,
    insertBlock,
    insertContent,
    editRows,
    duplicateContent,
    removeBlock,
    moveBlock,
    setBlockData,
    replaceBlock,
    setHomeText,
    setBlockVisible,
    setLiveBlogSidebar,
    undo,
    redo,
    clearError,
    reconcileSavedIds,
  };
}


