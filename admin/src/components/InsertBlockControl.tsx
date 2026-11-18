import type { BlockType } from "../../../packages/content-core/src/content-model";
import { BLOCK_LABELS } from "../../../packages/content-core/src/editor-admin";
import { memo, useCallback, useId, useRef, useState } from "react";
import { useDismissibleOverlay } from "../hooks/useDismissibleOverlay";
import { BLOCK_DESCRIPTIONS } from "../lib/block-descriptions";
import { ActionControl } from "./ui/ActionControl";
import { Button } from "./ui/Primitives";

// The gap between two blocks, memoized for the same reason: a page at the cap carries 41 of these,
// none of which changes when a block's content does. Its palette prop is held by identity by the
// editor above (#511).
export const InsertBlockControl = memo(function InsertBlockControl({
  index,
  palette,
  onInsert,
}: {
  index: number;
  palette: readonly BlockType[];
  onInsert: (type: BlockType, index?: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const position = index + 1;
  const optionsId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  // The palette is a temporary panel like the library's create menu: Escape puts it away and
  // returns focus to the trigger, and a pointer anywhere else closes it. Without this a long
  // page could be left with several palettes standing open at once.
  useDismissibleOverlay({ open, root: rootRef, trigger: triggerRef, onClose: close });
  return (
    <div className="block-insert-control" ref={rootRef}>
      <ActionControl
        action="add-block"
        className="block-insert-trigger"
        contextLabel={`position ${position}`}
        aria-controls={optionsId}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        ref={triggerRef}
      />
      <div
        className="block-insert-options"
        id={optionsId}
        role="group"
        aria-label={`Blocks to insert at position ${position}`}
        hidden={!open}
      >
        {palette.map((type) => {
          const descriptionId = `${optionsId}-${type}`;
          return (
            <div className="block-palette-option" key={type}>
              <Button
                aria-describedby={descriptionId}
                className="block-palette-button"
                onClick={() => {
                  onInsert(type, index);
                  setOpen(false);
                }}
              >
                {BLOCK_LABELS[type]}
              </Button>
              {/* Four of these are shelves and the names alone do not tell them apart; the
                  one-line description beside each is how a person chooses without trying
                  each and undoing. */}
              <span className="block-palette-description" id={descriptionId}>
                {BLOCK_DESCRIPTIONS[type]}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
});
