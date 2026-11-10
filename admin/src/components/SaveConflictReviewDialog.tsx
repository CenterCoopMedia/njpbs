import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { Button, Toolbar } from "./ui/Primitives";
import { editorFieldGroupsFor, type EditorDocumentKind } from "../../../packages/content-core/src/editor-admin";
import { fieldPathKey, readFieldValue } from "../lib/field-path";
import "./content-picker.css";

// Some saved values have their own editor instead of a field descriptor. Name
// these roots too; metadata groups can also carry saved children outside the form.
const additionalFieldLabels: Record<string, string> = {
  blocks: "Content planks, text and media",
  liveBlog: "Live updates and coverage state",
  leadMedia: "Lead media",
  dataHubReporting: "Data Hub reporting settings",
  keyArt: "Program artwork URL",
  pageTheme: "Page theme",
  homeHero: "Home hero",
  homeHeroTitle: "Home hero title",
  homeHeroSubtitle: "Home hero summary",
  template: "Page layout",
  childDirected: "Children's content classification",
  homeCompositionVersion: "Home layout",
  serviceCompositionVersion: "Service page layout",
  dataHubCompositionVersion: "Data Hub layout",
  status: "Editorial status",
  publishAt: "Publication time",
  type: "Content type",
  seo: "Search settings",
  social: "Social sharing settings",
};

export function SaveConflictReviewDialog({ title, version, document: savedDocument, proposed, kind, pageId, onConfirm, onCancel }: {
  title: string;
  version: number;
  document: Record<string, unknown>;
  proposed: Record<string, unknown>;
  kind: EditorDocumentKind;
  pageId?: string;
  onConfirm(): void;
  onCancel(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const description = useId();
  const different = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);
  const changedFields = editorFieldGroupsFor(kind, pageId).flatMap(group => group.fields)
    // Saves replace each submitted root value, so a submitted metadata group also
    // removes saved children absent from that group. An omitted root stays stored.
    .filter(field => {
      const root = field.path?.[0] ?? field.key;
      return Object.hasOwn(proposed, root) && proposed[root] !== undefined && different(readFieldValue(savedDocument, field), readFieldValue(proposed, field));
    })
    .map(field => ({ key: fieldPathKey(field), label: field.label }));
  for (const [key, label] of Object.entries(additionalFieldLabels)) {
    if (Object.hasOwn(proposed, key) && proposed[key] !== undefined && different(savedDocument[key], proposed[key]) && !changedFields.some(field => field.key === key)) {
      changedFields.push({ key, label });
    }
  }
  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current;
    element?.showModal();
    element?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { element?.close(); trigger?.focus(); };
  }, []);
  return createPortal(<dialog ref={dialog} className="content-picker-dialog" aria-labelledby={heading} aria-describedby={description}
    onCancel={event => { event.preventDefault(); onCancel(); }}>
    <header className="content-picker-head"><h2 id={heading}>This content changed while you were editing</h2></header>
    <div className="content-picker-body" id={description}>
      <p>The latest saved version is {version}: <strong>{title}</strong>.</p>
      <p>Your edits are still here. Saving sends your complete draft for this editor, including values you did not change. Those submitted values replace the latest saved values.</p>
      {changedFields.length ? <><p>Your draft differs from the latest saved version in:</p><ul>{changedFields.map(field => <li key={field.key}>{field.label}</li>)}</ul></> : <p>No editable field differences were found.</p>}
      <p>If someone saves again, you will review the newer version before saving.</p>
    </div>
    <footer className="content-picker-footer"><Toolbar>
      <Button onClick={onCancel}>Keep editing</Button>
      <Button variant="primary" onClick={onConfirm}>Save my changes over this version</Button>
    </Toolbar></footer>
  </dialog>, document.body);
}
