import { useEffect, useRef } from "react";
import type { AdminBlock } from "../lib/block-factory";
import { FieldRenderer } from "./FieldRenderer";
import { editorFieldsForBlock } from "../../../packages/content-core/src/editor-admin";
import { COUNTY_COMPARISON_DEFAULTS, type CountyComparisonData } from "../../../packages/content-core/src/county-comparison";
import { renderCountyComparison } from "../../../packages/content-core/src/county-comparison-render";
import { installCountyComparisonControls } from "../../../packages/content-core/src/county-comparison-controls";
import "../../../packages/content-core/src/county-comparison.css";

export function CountyComparisonEditor({ block, onChange, readOnly = false, generatedHeadingLevel = 2 }: {
  block: AdminBlock;
  onChange: (data: Record<string, unknown>, discrete?: boolean) => void;
  readOnly?: boolean;
  generatedHeadingLevel?: number;
}) {
  const preview = useRef<HTMLDivElement>(null);
  const data = { ...COUNTY_COMPARISON_DEFAULTS, ...block.data } as CountyComparisonData;
  const html = renderCountyComparison(`preview-${block.id}`, data, generatedHeadingLevel);
  useEffect(() => preview.current ? installCountyComparisonControls(preview.current) : undefined, [html]);
  return <section aria-label="County comparison details">
    <p>Compare 2020 and 2024 U.S. Senate results, combined House votes and turnout for all 21 counties. The reviewed values stay fixed.</p>
    <fieldset className="editor-readonly-boundary" disabled={readOnly}>
      <legend className="sr-only">County comparison text</legend>
      {editorFieldsForBlock("county_comparison").map(field => <FieldRenderer key={field.key}
        field={field} fieldId={`${block.id}-${field.key}`} value={block.data[field.key] ?? ""}
        onChange={value => { if (!readOnly) onChange({ ...block.data, [field.key]: value }); }} />)}
    </fieldset>
    <details><summary>Preview county comparison</summary><div ref={preview} dangerouslySetInnerHTML={{ __html: html }} /></details>
  </section>;
}
