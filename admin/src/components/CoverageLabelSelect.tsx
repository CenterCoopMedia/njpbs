import { postCoverageLabelId, resolveCoverageLabel } from "../../../packages/content-core/src/coverage-labels";
import { renderPostBranding } from "../../../packages/content-core/src/post-branding";
import { useCoverageLabels } from "../context/CoverageLabelsContext";
import { Button, Select } from "./ui/Primitives";
import "../../../packages/content-core/src/post-branding.css";
import "./CoverageLabelSelect.css";

export function CoverageLabelSelect({ record, id, disabled, onChange }: {
  record: { coverageLabelId?: unknown; liveBlog?: unknown }; id: string; disabled?: boolean; onChange: (id?: string) => void;
}) {
  const { status, registry, request } = useCoverageLabels();
  const value = postCoverageLabelId(record);
  const selected = resolveCoverageLabel(value, registry);
  const labels = registry?.labels.filter(label => !label.retired || label.id === value) ?? [];
  const blog = record.liveBlog && typeof record.liveBlog === "object" ? record.liveBlog as { branding?: unknown } : undefined;
  const mismatchedArtwork = blog && Object.prototype.hasOwnProperty.call(record, "coverageLabelId") &&
    (value === "nj-decides-2026") !== (blog.branding === "nj-decides-2026");
  return <div className="editor-field coverage-label-selection">
    <label className="editor-field-label" htmlFor={id}>Coverage label</label>
    <Select id={id} value={value ?? ""} disabled={disabled || status !== "ready"} aria-describedby={`${id}-help`}
      onChange={event => onChange(event.target.value || undefined)}>
      <option value="">None</option>
      {value && !selected ? <option value={value}>Unavailable coverage label</option> : null}
      {labels.map(label => <option key={label.id} value={label.id}>{label.name}{label.retired ? " (retired)" : ""}</option>)}
    </Select>
    <p id={`${id}-help`} className="coverage-label-selection__help" role={status === "error" ? "status" : undefined}>{status === "loading" || status === "idle" ? "Loading coverage labels…"
      : status === "ready" ? !registry ? "An admin needs to publish coverage labels before you can choose one." : record.liveBlog != null
        ? "NJ Decides 2026 shows the election logo and artwork. Another label or None removes that artwork. Save and publish this Post to apply a change."
        : "Choose a saved series or special coverage. Save and publish this Post to apply a change."
      : "Coverage labels are unavailable. Your draft is unchanged."}</p>
    {status === "error" ? <Button disabled={disabled} onClick={() => request(true)}>Retry coverage labels</Button> : null}
    {selected ? <div aria-label="Coverage label preview" dangerouslySetInnerHTML={{ __html: renderPostBranding(false, "card", selected, false) }} /> : null}
    {selected?.retired ? <p className="coverage-label-selection__help">This retired label stays on this Post until you change its coverage label.</p> : null}
    {mismatchedArtwork ? <p className="coverage-label-selection__help">This Post’s saved coverage label and live-blog artwork differ. Changing the coverage label aligns them.</p> : null}
  </div>;
}
