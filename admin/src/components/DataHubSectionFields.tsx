import { editorFieldsForBlock } from "../../../packages/content-core/src/editor-admin";
import type { DataHubSectionData } from "../../../packages/content-core/src/data-hub-composition";
import { HUB_ELECTRICITY_SERIES, HUB_ELECTRICITY_US_SERIES } from "../../../packages/content-core/src/data-hub-electricity";
import type { AdminBlock } from "../lib/block-factory";
import { dataHubSectionSource } from "../lib/data-hub-section-source";
import { FieldRenderer } from "./FieldRenderer";

/** Use the Page field controls; compiled source data has no editing field.
 * An approved electricity dataset on this Page replaces that record in public. */
export function DataHubSectionFields({ block, usedSections, onChange }: {
  block: AdminBlock; usedSections: readonly string[];
  onChange: (data: Record<string, unknown>, discrete?: boolean) => void;
}) {
  const source = dataHubSectionSource(block.data.sectionId as DataHubSectionData["sectionId"]);
  return <>{block.data.sectionId === "electricity" ? <p className="block-preview-note">To change the public price, add a Data figure block to this Page, choose the electricity dataset (Source series {HUB_ELECTRICITY_SERIES}; U.S. comparisons {HUB_ELECTRICITY_US_SERIES}) and select Latest approved release. Approving a new release then updates the Data Hub and its embeds. The price shown here is the built-in one.</p> : null}{editorFieldsForBlock("data_hub_section").map(field => {
    const available = field.key === "sectionId" ? { ...field, options: field.options?.filter(option =>
      option.value === block.data.sectionId || !usedSections.includes(String(option.value))) } : field;
    const inherited = field.key === "heading" || field.key === "introduction";
    const defaultValue = inherited ? source[field.key as "heading" | "introduction"] : "";
    return <FieldRenderer key={field.key} field={available} value={block.data[field.key] ?? ""} placeholder={inherited ? defaultValue : undefined}
      valueStatus={inherited ? String(block.data[field.key] ?? "").trim() ? "Custom text" : "Using compiled default" : undefined}
      resetLabel="Reset to default" onReset={inherited && block.data[field.key] ? () => onChange({ ...block.data, [field.key]: "" }, true) : undefined}
      fieldId={`block-${block.id}-field-${field.key}`} onChange={value => onChange({ ...block.data, [field.key]: value }, field.key === "sectionId")} />;
  })}</>;
}
