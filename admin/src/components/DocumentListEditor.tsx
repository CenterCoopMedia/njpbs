import { useEffect, useId, useRef, useState } from "react";
import { DOCUMENT_LIST_MAX, newestNoticeDocuments, noticeAddedDate, type NoticeDocument } from "../../../packages/content-core/src/document-list";
import type { AdminBlock } from "../lib/block-factory";
import { useRemovalNotice, useRemovalNoticeAvailable } from "../context/RemovalNoticeContext";
import { listItemName } from "../lib/destructive-actions";
import { mintCollectionItemId } from "../lib/collection-item-keys";
import type { MediaAssetSummary, MediaCategoryDefinition } from "../lib/functions";
import { MediaPickerDialog, type MediaPickerLoader } from "./MediaPickerDialog";
import type { MediaUploader } from "./MediaUploadForm";
import { Button, TextInput, Select } from "./ui/Primitives";
import { ActionControl } from "./ui/ActionControl";
import "./DocumentListEditor.css";

export function DocumentListEditor({ block, readOnly = false, loadMedia, uploadMedia,
  mediaCategories, defaultUploadCategory, canUploadCategory, onMediaPickerDirtyChange, onChange }: {
  block: AdminBlock; readOnly?: boolean; loadMedia?: MediaPickerLoader; uploadMedia?: MediaUploader;
  mediaCategories?: readonly MediaCategoryDefinition[]; defaultUploadCategory?: string;
  canUploadCategory?: (category: string) => boolean; onMediaPickerDirtyChange?: (dirty: boolean) => void;
  onChange: (data: Record<string, unknown>, discrete?: boolean) => void;
}) {
  const labelId = useId();
  const noticeRemoval = useRemovalNotice();
  const hasRemovalNotice = useRemovalNoticeAvailable();
  const [target, setTarget] = useState<string | null | undefined>(undefined);
  const [message, setMessage] = useState("");
  const documents = (Array.isArray(block.data.documents) ? block.data.documents : []) as NoticeDocument[];
  const removeRefs = useRef(new Map<string, HTMLButtonElement>());
  const headingRef = useRef<HTMLElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (pendingFocus.current === undefined) return;
    const nextId = pendingFocus.current;
    pendingFocus.current = undefined;
    if (hasRemovalNotice) return;
    const next = nextId ? removeRefs.current.get(nextId) : undefined;
    (next ?? (addRef.current?.disabled ? headingRef.current : addRef.current))?.focus();
  }, [documents.length, hasRemovalNotice]);
  const update = (next: NoticeDocument[], discrete = false) => onChange({ ...block.data, documents: next }, discrete);
  const change = (id: string, patch: Partial<NoticeDocument>) => update(documents.map(item => item.itemId === id ? { ...item, ...patch } : item));
  function choose(asset: MediaAssetSummary) {
    if (readOnly) return;
    if (asset.mimeType !== "application/pdf") { setMessage("Choose a PDF file."); return; }
    if (target) {
      update(documents.map(item => item.itemId === target ? { ...item, assetId: asset.id } : item), true);
      setMessage("PDF replaced. Its original date added is retained.");
    } else {
      update([...documents, { itemId: mintCollectionItemId(), assetId: asset.id,
        title: asset.name.replace(/\.pdf$/i, ""), publisher: "njpba" }], true);
      setMessage(`Added ${asset.name}. Save the draft to record its date added.`);
    }
    setTarget(undefined);
  }
  return <section className="inline-block-surface document-list-editor" aria-labelledby={labelId}>
    <strong id={labelId} ref={headingRef} tabIndex={-1}>PDF notices</strong>
    <p>Newest additions appear first. Editing a title or replacing a PDF keeps its original date added.</p>
    <p>Use tagged, searchable PDFs so readers can use assistive technology.</p>
    {documents.length === 0 ? <p>Add the first meeting notice.</p> :
      <ul className="document-list-editor__items" role="list">{newestNoticeDocuments(documents).map((item, index) => (
        <li key={item.itemId} className="document-list-editor__item">
          <label>Notice title <span className="sr-only">{index + 1}</span>
            <TextInput required maxLength={300} disabled={readOnly} value={item.title}
              onChange={event => change(item.itemId, { title: event.target.value })} />
          </label>
          <label>Organization <span className="sr-only">for {item.title || `notice ${index + 1}`}</span>
            <Select disabled={readOnly} value={item.publisher ?? ""} onChange={event => change(item.itemId,
              { publisher: event.target.value === "njpba" || event.target.value === "njpbs" ? event.target.value : undefined })}>
              <option value="njpba">NJPBA</option><option value="njpbs">NJ PBS</option><option value="">No label</option>
            </Select>
          </label>
          <p>{item.addedAt ? `Added ${noticeAddedDate(item.addedAt)}` : "Date added will be recorded when you save this draft."}</p>
          <div className="button-row">
            <Button disabled={readOnly || !loadMedia} onClick={() => setTarget(item.itemId)} aria-label={`Change PDF for ${item.title || `notice ${index + 1}`}`}>Change PDF</Button>
            <ActionControl action="remove-item" label="Remove" variant="ghost" disabled={readOnly}
              ref={(node) => { if (node) removeRefs.current.set(item.itemId, node); else removeRefs.current.delete(item.itemId); }}
              onClick={() => {
              const next = documents.filter(candidate => candidate.itemId !== item.itemId);
              pendingFocus.current = newestNoticeDocuments(next)[Math.min(index, next.length - 1)]?.itemId ?? null;
              update(next, true);
              setMessage("");
              noticeRemoval(listItemName("notice", item, index + 1));
            }} accessibleName={`Remove ${item.title || `notice ${index + 1}`} from notices`} />
          </div>
        </li>
      ))}</ul>}
    <ActionControl action="add-item" label="Add PDF notice" ref={addRef}
      disabled={readOnly || !loadMedia || documents.length >= DOCUMENT_LIST_MAX} onClick={() => setTarget(null)} />
    {!loadMedia ? <p>The media library is unavailable. Try reopening this page.</p> : null}
    {documents.length >= DOCUMENT_LIST_MAX ? <p>This list has reached its {DOCUMENT_LIST_MAX}-notice limit.</p> : null}
    <p role="status" aria-live="polite">{message}</p>
    {target !== undefined && loadMedia && !readOnly ? <MediaPickerDialog kind="document" destination="meeting notices"
      currentAssetId={documents.find(item => item.itemId === target)?.assetId ?? ""} loadMedia={loadMedia}
      uploadMedia={uploadMedia} categories={mediaCategories} defaultUploadCategory={defaultUploadCategory}
      canUploadCategory={canUploadCategory} onDirtyChange={onMediaPickerDirtyChange}
      onClose={() => setTarget(undefined)} onSelect={choose} /> : null}
  </section>;
}
