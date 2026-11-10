import type { SourceMediaAssetSummary } from "../../lib/source-media";
import { Select, TextInput } from "../ui/Primitives";
import "./VideoDetailsInspector.css";

export interface VideoRightsValues {
  rightsStatus: SourceMediaAssetSummary["rightsStatus"];
  credit: string;
  license: string;
}

/** The same rights fields in the library and the in-editor review. */
export function VideoRightsFields({ values, disabled = false, onChange }: {
  values: VideoRightsValues; disabled?: boolean; onChange?: (values: VideoRightsValues) => void;
}) {
  if (!onChange) return <>{[
    ["Rights review", values.rightsStatus === "complete" ? "Recorded" : "Needs review"],
    ["Credit", values.credit], ["License", values.license],
  ].map(([label, value]) => <div className="video-inspector-readonly-field" key={label}>
    <span>{label}</span><p>{value || "Not recorded"}</p>
  </div>)}</>;
  return <>
    <label className="video-inspector-field">Rights review<Select value={values.rightsStatus} disabled={disabled}
      onChange={event => onChange({ ...values, rightsStatus: event.target.value as VideoRightsValues["rightsStatus"] })}>
      <option value="pending">Needs review</option><option value="complete">Recorded</option>
    </Select></label>
    <label className="video-inspector-field">Credit<TextInput maxLength={500} value={values.credit} disabled={disabled}
      onChange={event => onChange({ ...values, credit: event.target.value })} /></label>
    <label className="video-inspector-field">License<TextInput maxLength={500} value={values.license} disabled={disabled}
      onChange={event => onChange({ ...values, license: event.target.value })} /></label>
  </>;
}
