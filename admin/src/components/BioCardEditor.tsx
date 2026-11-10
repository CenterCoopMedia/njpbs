import { useState } from "react";
import { editorFieldsForBlock, type EditorField } from "../../../packages/content-core/src/editor-admin";
import type { ImageData } from "../../../packages/content-core/src/content-model";
import { editorFieldValidationMessage } from "../lib/field-validation";
import type { AdminBlock } from "../lib/block-factory";
import type { MediaCategoryDefinition } from "../lib/functions";
import { BioPickerDialog } from "./BioPickerDialog";
import { FieldRenderer } from "./FieldRenderer";
import type { MediaPickerLoader } from "./MediaPickerDialog";
import type { MediaUploader } from "./MediaUploadForm";
import { Button } from "./ui/Primitives";
import "./BioCardEditor.css";

const photoField: EditorField = { key: "assetId", label: "Profile image", kind: "asset", required: false,
  help: "Choose a cleared photo or organization image from the media library. The card also works without an image." };
const altField: EditorField = { key: "alt", label: "Image description", kind: "text", required: true,
  help: "Describe the person or organization shown. Keep a photo description useful and brief.", maxLength: 300 };
const captionField: EditorField = { key: "caption", label: "Caption and credit", kind: "text", required: false,
  help: "Include any credit required by the image license.", maxLength: 300 };

export function BioCardEditor({ block, readOnly = false, hasError = false, onChange, ...media }: {
  block: AdminBlock; readOnly?: boolean; hasError?: boolean; onChange: (value: Record<string, unknown>) => void;
  loadMedia?: MediaPickerLoader; mediaPickerUnavailable?: boolean; uploadMedia?: MediaUploader;
  mediaCategories?: readonly MediaCategoryDefinition[]; defaultUploadCategory?: string;
  canUploadCategory?: (category: string) => boolean; onMediaPickerDirtyChange?: (dirty: boolean) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const fields = editorFieldsForBlock("bio_card").filter(field => !["profileId", "kind", "image"].includes(field.key))
    .map(field => field.key === "area" && block.data.kind === "organization" ? { ...field, label: "Location",
      help: "A verified base city or town, when useful. Leave blank if unknown or unnecessary; do not use a generic New Jersey label." } : field);
  const selected = typeof block.data.profileId === "string" && block.data.profileId.length > 0;
  const image = block.data.image as ImageData | undefined;
  const patchImage = (next: ImageData | undefined) => {
    const { image: _previous, ...rest } = block.data;
    onChange(next ? { ...rest, image: next } : rest);
  };
  return <section className="inline-block-surface bio-card-editor" aria-label="Bio card editor">
    <div className="bio-editor-actions"><Button disabled={readOnly} onClick={() => setPickerOpen(true)}>{selected ? "Choose a different bio" : "Choose a bio"}</Button>
      {selected ? <span>{block.data.kind === "organization" ? "Organization" : "Person"}</span> : null}</div>
    <p className="bio-editor-note">Readers see a compact card and can expand its short biography. Edit only sourced facts that help explain this article.</p>
    {selected ? <>
      <fieldset disabled={readOnly} className="bio-editor-fields"><legend className="sr-only">Public bio fields</legend>
        {fields.map(field => <div key={field.key} data-field-name={field.key}><FieldRenderer field={field}
          fieldId={`bio-${block.id}-${field.key}`} value={block.data[field.key] ?? ""}
          error={hasError ? editorFieldValidationMessage(field, block.data[field.key], { siblings: block.data, fields }) ?? undefined : undefined}
          onChange={value => {
            const next = { ...block.data, [field.key]: value };
            if ((field.key === "party" || field.key === "area") && value === "") delete next[field.key];
            onChange(next);
          }} /></div>)}
      </fieldset>
      <details className="bio-editor-image"><summary>{image ? "Profile image" : "Add an image (optional)"}</summary>
        <fieldset disabled={readOnly}><legend className="sr-only">Profile image</legend>
          <FieldRenderer field={photoField} fieldId={`bio-${block.id}-photo`} value={image?.assetId ?? ""} {...media}
            onChange={value => patchImage(value ? { assetId: String(value), alt: "" } : undefined)}
            onAssetSelect={asset => patchImage(asset ? { assetId: asset.id, alt: "", ...(asset.credit ? { caption: asset.credit } : {}) } : undefined)} />
          {image ? <>
            <FieldRenderer field={altField} fieldId={`bio-${block.id}-alt`} value={image.alt}
              onChange={value => patchImage({ ...image, alt: String(value), altDecorative: false })}
              error={hasError && !image.alt.trim() && !image.altDecorative ? "Describe the profile image." : undefined} />
            <FieldRenderer field={captionField} fieldId={`bio-${block.id}-caption`} value={image.caption ?? ""}
              onChange={value => patchImage({ ...image, caption: String(value) })} />
          </> : null}
        </fieldset>
      </details>
      <p className="bio-editor-note">This is a saved copy for this article. Confirm the role, area or location, and source date before publication. Leave optional facts blank when unknown or unnecessary.</p>
    </> : hasError ? <p role="alert">Choose a bio to complete this card.</p> : null}
    <BioPickerDialog open={pickerOpen} onClose={() => setPickerOpen(false)} onChoose={profile => {
      if (!readOnly) onChange(profile as unknown as Record<string, unknown>);
    }} />
  </section>;
}
