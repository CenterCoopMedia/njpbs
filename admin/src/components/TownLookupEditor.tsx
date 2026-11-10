import { editorFieldsForBlock } from "../../../packages/content-core/src/editor-admin";
import type { AdminBlock } from "../lib/block-factory";
import { FieldRenderer } from "./FieldRenderer";

export function TownLookupEditor({ block, onChange, readOnly = false }: {
  block: AdminBlock;
  onChange: (data: Record<string, unknown>, discrete?: boolean) => void;
  readOnly?: boolean;
}) {
  return <fieldset className="editor-readonly-boundary" disabled={readOnly}>
    <legend>Town election lookup</legend>
    {editorFieldsForBlock("town_lookup").map(field => <FieldRenderer key={field.key}
      field={field} fieldId={`town-lookup-${block.id}-${field.key}`} value={block.data[field.key]}
      onChange={value => { if (!readOnly) onChange({ ...block.data, [field.key]: value }); }} />)}
    <p>Includes all 564 municipalities, historical presidential and 2024 federal results, and 2024 turnout. The reviewed figures and map stay with the site; the source links appear with every election.</p>
  </fieldset>;
}
