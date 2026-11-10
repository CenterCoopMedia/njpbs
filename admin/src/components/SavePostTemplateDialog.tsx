import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import type { CapturePostTemplateRequest, PostTemplateReceipt, PostTemplateMode } from "../lib/functions";
import { postTemplatesPath } from "../lib/routes";
import { AsyncActionButton, Button, InlineMessage, Select, TextInput, Textarea, Toolbar } from "./ui/Primitives";
import "./PostTemplates.css";

export type TemplateCaptureFields = Omit<CapturePostTemplateRequest, "sourceId" | "sourceVersion">;

export function SavePostTemplateDialog({ sourceVersion, needsSave, canSave, onCapture, onClose }: {
  sourceVersion: number;
  needsSave: boolean;
  canSave: boolean;
  onCapture: (fields: TemplateCaptureFields) => Promise<PostTemplateReceipt>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<PostTemplateMode>("layout");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<PostTemplateReceipt | null>(null);
  const requestKey = useRef<string | null>(null);

  useEffect(() => {
    const element = dialog.current;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    element?.querySelector<HTMLInputElement>("input")?.focus();
    return () => { element?.close(); trigger?.focus(); };
  }, []);

  async function capture() {
    if (pending || !name.trim()) return;
    setPending(true);
    setError(null);
    requestKey.current ??= crypto.randomUUID();
    try {
      setReceipt(await onCapture({ name: name.trim(), description: description.trim(), mode, idempotencyKey: requestKey.current }));
    } catch (error) {
      setError(error instanceof Error ? error.message : "The template could not be saved. Your Post is still here.");
    } finally { setPending(false); }
  }

  return createPortal(
    <dialog ref={dialog} className="post-template-dialog" aria-labelledby={titleId} onCancel={event => {
      event.preventDefault();
      if (!pending) onClose();
    }}>
      <h2 id={titleId}>{receipt ? "Template saved" : "Save as template"}</h2>
      {receipt ? <>
        <p role="status">“{receipt.template.name}” was saved from Post version {receipt.template.sourceVersion}.</p>
        <Toolbar>
          <Link className="button button-secondary" to={postTemplatesPath()}>Open post templates</Link>
          <Button variant="primary" onClick={onClose}>Done</Button>
        </Toolbar>
      </> : <form onSubmit={event => { event.preventDefault(); event.stopPropagation(); void capture(); }}>
        <p>{needsSave
          ? "This Post has unsaved changes. Save those changes and capture the saved version, or cancel to keep editing."
          : `Capture saved Post version ${sourceVersion}. The Post's public state will stay the same.`}</p>
        {needsSave && !canSave ? <InlineMessage tone="warning" title="Save the Post first">This Post cannot be saved in its current state. Cancel and resolve its save or workflow message.</InlineMessage> : null}
        <fieldset disabled={pending} className="post-template-fields">
          <label>Template name<TextInput value={name} onChange={event => setName(event.target.value)} maxLength={120} required /></label>
          <label>Description <span className="muted">(optional)</span><Textarea value={description} onChange={event => setDescription(event.target.value)} maxLength={500} rows={3} /></label>
          <label>Include<Select value={mode} onChange={event => setMode(event.target.value as PostTemplateMode)}>
            <option value="layout">Layout only</option>
            <option value="content">Layout and content</option>
          </Select></label>
          <p className="muted">{mode === "layout"
            ? "Keep rows, columns, block types and presentation settings. Story text, media and links become empty slots. Topic-shelf query settings remain."
            : "Keep layout, starter text and media references. Review reused story content before publication."}</p>
          <p className="muted">New Posts get their own title, URL, byline, topics and draft workflow.</p>
        </fieldset>
        {error ? <InlineMessage tone="error" role="alert" title="Template was not confirmed">{error}</InlineMessage> : null}
        <Toolbar>
          <Button disabled={pending} onClick={onClose}>Cancel</Button>
          <AsyncActionButton type="submit" variant="primary" label={needsSave ? "Save Post and capture" : "Save template"} pending={pending} pendingLabel="Saving template…" disabled={!name.trim() || (needsSave && !canSave)} />
        </Toolbar>
      </form>}
    </dialog>, document.body,
  );
}
