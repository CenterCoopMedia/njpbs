import type { EditorDocumentKind, EditorField, EditorFieldGroup } from "../../../packages/content-core/src/editor-admin";
import { POST_PRESENTATIONS } from "../../../packages/content-core/src/post-formats";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { useEditorWorkspaceView } from "../context/EditorWorkspaceView";
import { fieldPathKey, readFieldValue } from "../lib/field-path";
import type { BylineAuthorOption } from "../lib/functions";
import { ROUTE_PATHS } from "../lib/routes";
import { FieldRenderer } from "./FieldRenderer";
import { Icon } from "./ui/Icon";
import { InfoTooltip } from "./ui/InfoTooltip";
import { Button } from "./ui/Primitives";

interface RecordFieldGroupOptions {
  group: EditorFieldGroup;
  groupFields: readonly EditorField[];
  headless: boolean;
  kind: EditorDocumentKind;
  record: Record<string, unknown>;
  canManageSettings: boolean;
  editorView: ReturnType<typeof useEditorWorkspaceView>;
  interactionLocked: boolean;
  toggleReadonlyBoundary: (element: HTMLFieldSetElement | null) => void;
  renderEditorField: (field: EditorField) => ReactNode;
  bylineAuthors?: readonly BylineAuthorOption[];
  formId: string;
  presentation: string;
}

export function renderRecordFieldGroup({
  group,
  groupFields,
  headless,
  kind,
  record,
  canManageSettings,
  editorView,
  interactionLocked,
  toggleReadonlyBoundary,
  renderEditorField,
  bylineAuthors,
  formId,
  presentation,
}: RecordFieldGroupOptions): ReactNode {
  if (groupFields.length === 0) return null;
  if (kind === "page" && record.pageTheme === "nj-decides" && group.id === "hero-image") {
    return <fieldset className="record-field-group" aria-label="Heading and artwork" key={group.id}>
      <legend>Heading and artwork</legend>
      <div>
        <p className="editor-image-role-note">This Page uses the NJ Decides 2026 theme. Its heading, logo, colors and artwork come from the shared NJ Decides brand, not from this Page.</p>
        <p className="editor-image-role-note">{canManageSettings
          ? <Link to={`${ROUTE_PATHS.adminSettings}#nj-decides-settings-heading`}>Edit the NJ Decides brand</Link>
          : "An admin can change it in Admin settings, NJ Decides brand."}</p>
      </div>
    </fieldset>;
  }
  // Image role summaries remain inspectable while each role's fieldset owns
  // the edit lock. An inert group would also hide its native disclosures.
  if (headless && kind === "post" && group.id === "hero-image") return (
    <div className="record-field-group" data-field-group={group.id} role="group" aria-label={group.label} key={group.id}>
      <div className="record-field-group-fields">{groupFields.map(field => !editorView?.kind && field.key.startsWith("heroBackground")
        ? <fieldset key={fieldPathKey(field)} className="editor-readonly-boundary" disabled={interactionLocked} ref={toggleReadonlyBoundary}>{renderEditorField(field)}</fieldset>
        : renderEditorField(field))}</div>
    </div>
  );
  return (
    <fieldset
      className={headless ? "editor-readonly-boundary record-field-group" : "record-field-group"}
      data-field-group={group.id}
      aria-label={group.label}
      disabled={headless ? interactionLocked : undefined}
      key={group.id}
      ref={headless ? toggleReadonlyBoundary : undefined}
    >
      <legend className={headless ? "sr-only" : undefined}>
        {group.label}
        {!headless && group.help ? <InfoTooltip label={group.label} content={group.help} /> : null}
      </legend>
      <div className="record-field-group-fields">
        {editorView?.kind === "post" && group.id === "basics" ? <>
          {groupFields.filter(field => field.key === "credits" && !field.path).map(field => <details key="credits" className="editor-byline-details"><summary><span>Byline</span><strong>{Array.isArray(record.credits) ? record.credits.map(credit => {
          if (!credit || typeof credit !== "object") return "Credit needs review";
          const value = credit as Record<string, unknown>;
          return value.kind === "custom" ? String(value.name ?? "") : value.kind === "registered" ? bylineAuthors?.find(author => author.authorId === value.authorId)?.displayName ?? (typeof value.displayName === "string" ? value.displayName : "Author no longer listed") : "Credit needs review";
        }).join(", ") || "Add a byline" : "Add a byline"}</strong><Icon name="pencil" /></summary><div>{renderEditorField(field)}</div></details>)}
          <Button variant="ghost" size="compact" className="editor-inspector-summary-row" disabled={interactionLocked}
            onClick={() => {
              const focusPresentation = () => { const control = document.getElementById(`${formId}-presentation`); control?.scrollIntoView({ block: "center" }); control?.focus(); };
              if (editorView.phone) { editorView.closePane("details", false); requestAnimationFrame(focusPresentation); }
              else focusPresentation();
            }}>
            <span>Presentation</span><strong>{POST_PRESENTATIONS.find(choice => choice.value === presentation)?.label ?? "Saved presentation needs review"}</strong><Icon name="pencil" />
          </Button>
          {groupFields.filter(field => field.key !== "credits" || field.path).map(renderEditorField)}
        </> : groupFields.map(renderEditorField)}
      </div>
    </fieldset>
  );
}

interface RecordSectionFieldsetOptions {
  sectionField: EditorField | null;
  sectionIsEditable: boolean;
  headless: boolean;
  interactionLocked: boolean;
  toggleReadonlyBoundary: (element: HTMLFieldSetElement | null) => void;
  record: Record<string, unknown>;
  changeField: (field: EditorField, value: unknown) => void;
  kind: EditorDocumentKind;
  errors: Record<string, string>;
}

// The desk control. A create or explicitly unassigned Post draft gets the finite picker,
// required and marked like any other required field. An assigned stored record gets a plain
// reading: the desk is immutable, so a disabled select would still look editable.
export function renderRecordSectionFieldset({
  sectionField,
  sectionIsEditable,
  headless,
  interactionLocked,
  toggleReadonlyBoundary,
  record,
  changeField,
  kind,
  errors,
}: RecordSectionFieldsetOptions): ReactNode {
  const sectionHelp = sectionIsEditable
    ? "Choose the area this content belongs to. Existing area grants can limit access to it."
    : "This is the record's saved area. Existing area grants can limit access to it.";
  return sectionField ? (
    <fieldset
      className={headless ? "editor-readonly-boundary record-field-group" : "record-field-group"}
      disabled={headless ? interactionLocked : undefined}
      key="section"
      aria-label="Content area"
      ref={headless ? toggleReadonlyBoundary : undefined}
    >
      <legend className={headless ? "sr-only" : undefined}>
        Content area
        {!headless ? <InfoTooltip label="Content area" content={sectionHelp} /> : null}
      </legend>
      <div className="record-field-group-fields">
        {sectionIsEditable ? (
          <FieldRenderer
            field={sectionField}
            value={readFieldValue(record, sectionField)}
            onChange={(value) => changeField(sectionField, value)}
            fieldId={`record-${kind}-section`}
            error={errors[fieldPathKey(sectionField)]}
          />
        ) : (
          <FieldRenderer
            field={{ ...sectionField, required: false }}
            value={readFieldValue(record, sectionField)}
            onChange={() => {}}
            fieldId={`record-${kind}-section`}
            control={
              <p className="editor-field-static" data-testid="record-section-display">
                {sectionField.options?.find(
                  (option) => option.value === record[sectionField.key],
                )?.label ?? "No area"}
              </p>
            }
          />
        )}
      </div>
    </fieldset>
  ) : null;
}
