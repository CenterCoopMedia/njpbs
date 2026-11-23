import { editorFieldsForBlock } from "../../../packages/content-core/src/editor-admin";
import { fieldIsRequired, editorFieldValidationMessage } from "../../../packages/content-core/src/field-validation";
import { isDataFigureData } from "../../../packages/content-core/src/data-figure";
import { isVideoBlockData } from "../../../packages/content-core/src/video-block";
import { defaultBlockData, type AdminBlock } from "../lib/block-factory";
import { FieldRenderer } from "./FieldRenderer";
import { InlineDataFigure } from "./InlineDataFigure";
import type { MediaPickerLoader } from "./MediaPickerDialog";
import { VideoBlockEditor } from "./VideoBlockEditor";
import { Select } from "./ui/Primitives";

export function ScrollStoryEditor({ block, onChange, errorId, hasError, readOnly, loadMedia,
  mediaPickerUnavailable, onMediaPickerDirtyChange, generatedHeadingLevel }: {
  block: AdminBlock;
  onChange: (data: Record<string, unknown>) => void;
  errorId?: string;
  hasError: boolean;
  readOnly: boolean;
  loadMedia?: MediaPickerLoader;
  mediaPickerUnavailable?: boolean;
  onMediaPickerDirtyChange?: (dirty: boolean) => void;
  generatedHeadingLevel: number;
}) {
  const [steps] = editorFieldsForBlock("scroll_story");
  const [textField, ...imageFields] = steps.itemFields ?? [];
  const fieldId = `block-${block.id}-field-steps`;
  return <fieldset className="inline-block-surface" disabled={readOnly}
    aria-invalid={hasError || undefined} aria-describedby={hasError ? errorId : undefined}>
    <legend className="sr-only">Scroll story</legend>
    <FieldRenderer field={steps} fieldId={fieldId} value={block.data.steps}
      error={hasError ? editorFieldValidationMessage(steps, block.data.steps) ?? undefined : undefined}
      onChange={value => onChange({ ...block.data, steps: value })}
      renderListItem={({ item, id, index, update }) => {
        const kind = item.video ? "video" : item.figure ? "figure" : "image";
        const fields = kind === "image" ? [textField, ...imageFields] : [textField];
        const renderField = (field: typeof textField) => <FieldRenderer key={field.key}
          field={{ ...field, required: fieldIsRequired(field, item) }} value={item[field.key]}
          fieldId={`${id}-${field.key}`} loadMedia={loadMedia} mediaPickerUnavailable={mediaPickerUnavailable}
          onMediaPickerDirtyChange={onMediaPickerDirtyChange}
          error={hasError ? editorFieldValidationMessage(field, item[field.key], { siblings: item, fields }) ?? undefined : undefined}
          onChange={value => update(current => ({ ...current, [field.key]: value }))} />;

        return <>
          {renderField(textField)}
          <div className="editor-field">
            <label className="editor-field-label" htmlFor={`${id}-media`}>Step {index + 1} media</label>
            <Select id={`${id}-media`} value={kind} onChange={event => {
              const nextKind = event.currentTarget.value;
              update(current => ({ text: current.text, assetId: "", alt: "", caption: "",
                ...(nextKind === "video" ? { video: defaultBlockData("video") } : {}),
                ...(nextKind === "figure" ? { figure: defaultBlockData("data_figure") } : {}),
              }));
            }}>
              <option value="image">Image or text only</option>
              <option value="video">Library video</option>
              <option value="figure">Data figure</option>
            </Select>
          </div>
          {kind === "image" ? imageFields.map(renderField) : null}
          {isVideoBlockData(item.video, false) ? <VideoBlockEditor
            block={{ ...block, id, type: "video", data: { ...item.video } }}
            readOnly={readOnly} hasError={hasError && !isVideoBlockData(item.video, true)}
            onMediaPickerDirtyChange={onMediaPickerDirtyChange}
            onChange={video => update(current => current.video ? { ...current, video } : current)} /> : null}
          {isDataFigureData(item.figure) ? <InlineDataFigure
            block={{ ...block, id, type: "data_figure", data: { ...item.figure } }}
            readOnly={readOnly} generatedHeadingLevel={generatedHeadingLevel}
            onChange={figure => update(current => current.figure ? { ...current, figure } : current)} /> : null}
        </>;
      }} />
  </fieldset>;
}
