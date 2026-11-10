import { memo, useCallback, useContext, useId, useRef, useState } from "react";
import { BLOCK_LABELS } from "../../../packages/content-core/src/editor-admin";
import type { AdminBlock } from "../lib/block-factory";
import { contentPlacementReason, type ContentDestination } from "../lib/content-row-editing";
import { Button, Select } from "./ui/Primitives";
import { ActionControl } from "./ui/ActionControl";
import { CustomHtmlEditing } from "./InlineBlockSurface";
import "./content-picker.css";

const MoveTrigger = memo(ActionControl);

export function MoveContentDialog({ block, blocks, pageLevelIds, onMove }: { block: AdminBlock; blocks: AdminBlock[]; pageLevelIds: string[]; onMove: (id: string, destination: ContentDestination) => void }) {
  const canEditCustomHtml = useContext(CustomHtmlEditing);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const currentBlock = useRef(block);
  currentBlock.current = block;
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [beforeId, setBeforeId] = useState("");
  const id = useId();
  const openMove = useCallback(() => {
    setTarget(currentBlock.current.layout ? JSON.stringify(currentBlock.current.layout) : "");
    setBeforeId("");
    setOpen(true);
    dialog.current?.showModal?.();
  }, []);
  const layout = target ? JSON.parse(target) as NonNullable<ContentDestination["layout"]> : undefined;
  const rows = blocks.filter(candidate => candidate.type === "row" && candidate.id !== block.id);
  const choices = layout ? blocks.filter(candidate => candidate.layout?.rowId === layout.rowId && candidate.layout?.column === layout.column) : pageLevelIds.map(id => blocks.find(candidate => candidate.id === id)!).filter(Boolean);
  const sourceRow = rows.find(row => row.id === block.layout?.rowId);
  const destinationRow = rows.find(row => row.id === layout?.rowId);
  const revealsCustomHtml = !canEditCustomHtml && block.type === "html" && block.visible &&
    sourceRow?.visible === false && destinationRow?.visible !== false;
  const invalid = revealsCustomHtml
    ? "Only editors, managers and site owners can show hidden custom HTML."
    : contentPlacementReason(blocks, block.type, { layout });
  const unchangedLegacyPlacement = layout?.rowId === block.layout?.rowId && layout?.column === block.layout?.column;
  const position = block.type === "row"
    ? blocks.filter(candidate => candidate.type === "row").findIndex(candidate => candidate.id === block.id) + 1
    : blocks.indexOf(block) + 1;
  function close() { dialog.current?.close?.(); setOpen(false); trigger.current?.focus({ preventScroll: true }); }
  return <>
    <MoveTrigger action="move-content" variant="ghost" ref={trigger} contextLabel={`${BLOCK_LABELS[block.type]} ${position}`} aria-haspopup="dialog" onClick={openMove} />
    <dialog ref={dialog} open={open} className="content-picker-dialog content-move-dialog" aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); close(); }}>
      {open ? <>
        <header className="content-picker-head">
          <h2 id={`${id}-title`}>Move {BLOCK_LABELS[block.type]}</h2>
        </header>
        <div className="content-picker-body">
          <label>Destination<Select value={target} onChange={event => { setTarget(event.target.value); setBeforeId(""); }}>
            <option value="">Page level</option>
            {block.type !== "row" && block.section === undefined ? rows.flatMap(row => (row.data.columns as number[]).map((_width, column) => {
              const value = JSON.stringify({ rowId: row.id, column });
              return <option key={value} value={value} disabled={Boolean(contentPlacementReason(blocks, block.type, { layout: { rowId: row.id, column } })) && value !== JSON.stringify(block.layout)}>Row {blocks.filter(block => block.type === "row").indexOf(row) + 1}, column {column + 1}</option>;
            })) : null}
          </Select></label>
          <label>Position<Select value={beforeId} onChange={event => setBeforeId(event.target.value)}>
            <option value="">At end</option>
            {choices.filter(candidate => candidate.id !== block.id).map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.section === "home-start" ? "Before newsletter signup" : `Before ${BLOCK_LABELS[candidate.type]} ${blocks.indexOf(candidate) + 1}`}</option>)}
          </Select></label>
          {invalid ? <p>{invalid}</p> : null}
        </div>
        <footer className="content-picker-footer button-row"><Button onClick={close}>Cancel</Button><Button variant="primary" disabled={Boolean(invalid && !unchangedLegacyPlacement)} onClick={() => { if (invalid && !unchangedLegacyPlacement) return; onMove(block.id, { layout, ...(beforeId ? { beforeId } : {}) }); close(); }}>Move content</Button></footer>
      </> : null}
    </dialog>
  </>;
}
