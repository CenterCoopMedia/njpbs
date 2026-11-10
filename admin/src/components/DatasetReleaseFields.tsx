import { cloneElement, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { DATASET_ADJUSTMENTS, DATASET_GEOGRAPHIES, DATASET_RIGHTS, DATASET_UNITS,
  type DatasetComparator, type DatasetGeography, type DatasetPeriod, type DatasetRelease, type DatasetSource } from "../../../packages/content-core/src/datasets";
import { TextInput, Textarea, Select } from "./ui/Primitives";
import { ActionControl } from "./ui/ActionControl";
import "./DatasetEditor.css";

const UNIT_LABELS: Record<string, string> = { usd: "US dollars", usd_month: "US dollars per month", usd_hour: "US dollars per hour", usd_billion: "Billions of US dollars", cents_kwh: "Cents per kilowatt-hour", fahrenheit: "Degrees Fahrenheit" };
const label = (value: string) => { const words = value.replaceAll("_", " "); return UNIT_LABELS[value] ?? words.charAt(0).toUpperCase() + words.slice(1); };
const FIELD_PATHS: Record<string, string> = {
  "Measure label": "label", Unit: "unit", Value: "value", Adjustment: "adjustment",
  "Period start": "period.start", "Period end": "period.end", "Period label": "period.label",
  "Geography level": "geography.level", "Geography code": "geography.code", "Geography name": "geography.label",
  "Source publisher": "source.publisher", "Source title": "source.title", "Source HTTPS address": "source.url", "Source series (optional)": "source.seriesId",
  "Released on": "releasedOn", "Verified on": "verifiedOn", "Next review (optional)": "nextReviewOn",
  "Chart text": "chartText", Method: "methodNote", "Display rights": "reuse.display", "Export rights": "reuse.exports",
  "Private permission evidence": "reuse.evidence", "Public credit or reuse note": "reuse.note", "Change note": "changeNote",
};
function Field({ name, children, path }: { name: string; children: ReactNode; path?: string }) {
  const id = useId();
  return <div className="dataset-field" data-dataset-path={path ?? FIELD_PATHS[name]}><label htmlFor={id}>{name}</label>{cloneElement(children as ReactElement<{ id?: string }>, { id })}</div>;
}
function TextField({ name, value, onChange, type = "text", maxLength = 300, path }: { name: string; value: string; onChange: (value: string) => void; type?: string; maxLength?: number; path?: string }) {
  return <Field name={name} path={path}><TextInput type={type} maxLength={maxLength} value={value} onChange={event => onChange(event.target.value)} /></Field>;
}
function Options({ name, value, options, onChange, path }: { name: string; value: string; options: readonly string[]; onChange: (value: string) => void; path?: string }) {
  return <Field name={name} path={path}><Select value={value} onChange={event => onChange(event.target.value)}>{options.map(option => <option key={option} value={option}>{label(option)}</option>)}</Select></Field>;
}
function PeriodFields({ value, onChange, path = "period" }: { value: DatasetPeriod; onChange: (value: DatasetPeriod) => void; path?: string }) {
  return <div className="dataset-field-grid">
    <TextField name="Period start" path={`${path}.start`} type="date" value={value.start} onChange={start => onChange({ ...value, start })} />
    <TextField name="Period end" path={`${path}.end`} type="date" value={value.end} onChange={end => onChange({ ...value, end })} />
    <TextField name="Period label" path={`${path}.label`} maxLength={120} value={value.label} onChange={label => onChange({ ...value, label })} />
  </div>;
}
function GeographyFields({ value, onChange, path = "geography" }: { value: DatasetGeography; onChange: (value: DatasetGeography) => void; path?: string }) {
  return <div className="dataset-field-grid">
    <Options name="Geography level" path={`${path}.level`} value={value.level} options={DATASET_GEOGRAPHIES} onChange={level => onChange({ ...value, level: level as DatasetGeography["level"] })} />
    <TextField name="Geography code" path={`${path}.code`} maxLength={32} value={value.code} onChange={code => onChange({ ...value, code })} />
    <TextField name="Geography name" path={`${path}.label`} maxLength={240} value={value.label} onChange={label => onChange({ ...value, label })} />
  </div>;
}
function SourceFields({ value, onChange, path = "source" }: { value: DatasetSource; onChange: (value: DatasetSource) => void; path?: string }) {
  return <div className="dataset-field-grid">
    <TextField name="Source publisher" path={`${path}.publisher`} value={value.publisher} onChange={publisher => onChange({ ...value, publisher })} />
    <TextField name="Source title" path={`${path}.title`} value={value.title} onChange={title => onChange({ ...value, title })} />
    <TextField name="Source HTTPS address" path={`${path}.url`} type="url" maxLength={2000} value={value.url} onChange={url => onChange({ ...value, url })} />
    <TextField name="Source series (optional)" path={`${path}.seriesId`} maxLength={120} value={value.seriesId ?? ""} onChange={seriesId => onChange({ ...value, seriesId })} />
  </div>;
}
function NumberField({ name, value, onChange, path }: { name: string; value: number; onChange: (value: number) => void; path?: string }) {
  return <Field name={name} path={path}><TextInput type="number" step="any" value={Number.isFinite(value) ? value : ""} onChange={event => onChange(event.target.value === "" ? NaN : Number(event.target.value))} /></Field>;
}
export function DatasetReleaseFields({ value, onChange }: { value: DatasetRelease; onChange: (value: DatasetRelease) => void }) {
  const tableScroll = useRef<HTMLDivElement>(null);
  const observationRemove = useRef<Array<HTMLButtonElement | null>>([]);
  const comparisonRemove = useRef<Array<HTMLButtonElement | null>>([]);
  const addObservation = useRef<HTMLButtonElement>(null);
  const addComparison = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<{ collection: "observations" | "comparisons"; index: number | null } | null>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const element = tableScroll.current;
    if (!element) return;
    const measure = () => setOverflows(element.scrollWidth > element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [value.points.length]);
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    pendingFocus.current = null;
    const rows = pending.collection === "observations" ? observationRemove.current : comparisonRemove.current;
    const add = pending.collection === "observations" ? addObservation.current : addComparison.current;
    const target = pending.index === null ? add : rows[pending.index];
    target?.focus();
  }, [value.comparators.length, value.points.length]);
  function change<K extends keyof DatasetRelease>(key: K, next: DatasetRelease[K]) { onChange({ ...value, [key]: next }); }
  function comparator(index: number, next: DatasetComparator) { change("comparators", value.comparators.map((item, i) => i === index ? next : item)); }
  function focusAfterRemoval(collection: "observations" | "comparisons", index: number, length: number) {
    const remaining = length - 1;
    pendingFocus.current = { collection, index: remaining ? Math.min(index, remaining - 1) : null };
  }
  return <div className="dataset-fields">
    <fieldset><legend>Measure and reporting period</legend>
      <div className="dataset-field-grid">
        <TextField name="Measure label" value={value.label} onChange={next => change("label", next)} />
        <Options name="Unit" value={value.unit} options={DATASET_UNITS} onChange={next => change("unit", next as DatasetRelease["unit"])} />
        <NumberField name="Value" value={value.value} onChange={next => change("value", next)} />
        <Options name="Adjustment" value={value.adjustment} options={DATASET_ADJUSTMENTS} onChange={next => change("adjustment", next as DatasetRelease["adjustment"])} />
      </div>
      <PeriodFields value={value.period} onChange={next => change("period", next)} />
      <GeographyFields value={value.geography} onChange={next => change("geography", next)} />
    </fieldset>
    <fieldset><legend>Source and dates</legend>
      <SourceFields value={value.source} onChange={next => change("source", next)} />
      <div className="dataset-field-grid">
        <TextField name="Released on" type="date" value={value.releasedOn} onChange={next => change("releasedOn", next)} />
        <TextField name="Verified on" type="date" value={value.verifiedOn} onChange={next => change("verifiedOn", next)} />
        <TextField name="Next review (optional)" type="date" value={value.nextReviewOn ?? ""} onChange={next => change("nextReviewOn", next)} />
      </div>
    </fieldset>
    <fieldset><legend>Source values</legend>
      <p>Up to 240 observations, in date order. A missing observation needs a reason.</p>
      <div ref={tableScroll} className="dataset-table-scroll" data-dataset-path="points" role="region" aria-label="Edit source values" tabIndex={overflows ? 0 : undefined}>
        <table><caption className="sr-only">Source observations</caption><thead><tr><th scope="col">Period</th><th scope="col">Status</th><th scope="col">Value or reason</th><th scope="col">Remove</th></tr></thead><tbody>
          {value.points.map((point, index) => <tr key={index} data-dataset-path={`points.${index}`}>
            <td><TextInput data-dataset-path={`points.${index}.period`} type="date" aria-label={`Observation ${index + 1} period`} value={point.period} onChange={event => change("points", value.points.map((item, i) => i === index ? { ...item, period: event.target.value } : item))} /></td>
            <td><Select aria-label={`Observation ${index + 1} status`} value={point.value === null ? "missing" : "reported"} onChange={event => change("points", value.points.map((item, i) => i !== index ? item : event.target.value === "missing" ? { period: item.period, value: null, missingReason: "" } : { period: item.period, value: 0 }))}><option value="reported">Reported</option><option value="missing">Missing</option></Select></td>
            <td>{point.value === null ? <TextInput data-dataset-path={`points.${index}.missingReason`} aria-label={`Observation ${index + 1} missing-data reason`} maxLength={500} value={point.missingReason ?? ""} onChange={event => change("points", value.points.map((item, i) => i === index ? { ...item, missingReason: event.target.value } : item))} /> :
              <TextInput data-dataset-path={`points.${index}.value`} type="number" step="any" aria-label={`Observation ${index + 1} value`} value={Number.isFinite(point.value) ? point.value : ""} onChange={event => change("points", value.points.map((item, i) => i === index ? { ...item, value: event.target.value === "" ? NaN : Number(event.target.value) } : item))} />}</td>
            <td><ActionControl ref={element => { observationRemove.current[index] = element; }} action="remove-item" label={`Remove observation ${index + 1}`} onClick={() => {
              focusAfterRemoval("observations", index, value.points.length);
              change("points", value.points.filter((_, i) => i !== index));
            }} /></td>
          </tr>)}
        </tbody></table>
      </div>
      <ActionControl ref={addObservation} action="add-item" label="Add observation" disabled={value.points.length >= 240} onClick={() => change("points", [...value.points, { period: "", value: 0 }])} />
      <Field name="Chart text"><Textarea rows={3} maxLength={2000} value={value.chartText} onChange={event => change("chartText", event.target.value)} /></Field>
      <Field name="Method"><Textarea rows={3} maxLength={4000} value={value.methodNote} onChange={event => change("methodNote", event.target.value)} /></Field>
    </fieldset>
    <details><summary>Reviewed comparisons ({value.comparators.length} of 3)</summary>
      {value.comparators.map((item, index) => <fieldset key={index} data-dataset-path={`comparators.${index}`}><legend>Comparison {index + 1}</legend>
        <TextField name="Comparison label" path={`comparators.${index}.label`} value={item.label} onChange={label => comparator(index, { ...item, label })} />
        <NumberField name="Comparison value" path={`comparators.${index}.value`} value={item.value} onChange={value => comparator(index, { ...item, value })} />
        <Options name="Comparison unit" path={`comparators.${index}.unit`} value={item.unit} options={DATASET_UNITS} onChange={unit => comparator(index, { ...item, unit: unit as DatasetRelease["unit"] })} />
        <Options name="Comparison adjustment" path={`comparators.${index}.adjustment`} value={item.adjustment} options={DATASET_ADJUSTMENTS} onChange={adjustment => comparator(index, { ...item, adjustment: adjustment as DatasetRelease["adjustment"] })} />
        <PeriodFields path={`comparators.${index}.period`} value={item.period} onChange={period => comparator(index, { ...item, period })} />
        <GeographyFields path={`comparators.${index}.geography`} value={item.geography} onChange={geography => comparator(index, { ...item, geography })} />
        <SourceFields path={`comparators.${index}.source`} value={item.source} onChange={source => comparator(index, { ...item, source })} />
        <Field name="Comparison differences" path={`comparators.${index}.comparisonNote`}><Textarea maxLength={2000} value={item.comparisonNote} onChange={event => comparator(index, { ...item, comparisonNote: event.target.value })} /></Field>
        <ActionControl ref={element => { comparisonRemove.current[index] = element; }} action="remove-item" label={`Remove comparison ${index + 1}`} onClick={() => {
          focusAfterRemoval("comparisons", index, value.comparators.length);
          change("comparators", value.comparators.filter((_, i) => i !== index));
        }} />
      </fieldset>)}
      <ActionControl ref={addComparison} action="add-item" label="Add reviewed comparison" disabled={value.comparators.length >= 3} onClick={() => change("comparators", [...value.comparators, { label: "", unit: value.unit, value: 0, period: { ...value.period }, geography: { ...value.geography }, adjustment: value.adjustment, source: { ...value.source }, comparisonNote: "" }])} />
    </details>
    <fieldset><legend>Reuse permission</legend>
      <div className="dataset-field-grid">
        <Options name="Display rights" value={value.reuse.display} options={DATASET_RIGHTS} onChange={display => change("reuse", { ...value.reuse, display: display as DatasetRelease["reuse"]["display"] })} />
        <Options name="Export rights" value={value.reuse.exports} options={DATASET_RIGHTS} onChange={exports => change("reuse", { ...value.reuse, exports: exports as DatasetRelease["reuse"]["exports"] })} />
      </div>
      <Field name="Private permission evidence"><Textarea rows={2} maxLength={2000} value={value.reuse.evidence} onChange={event => change("reuse", { ...value.reuse, evidence: event.target.value })} /></Field>
      <Field name="Public credit or reuse note"><Textarea rows={2} maxLength={2000} value={value.reuse.note} onChange={event => change("reuse", { ...value.reuse, note: event.target.value })} /></Field>
    </fieldset>
    <Field name="Change note"><Textarea rows={2} maxLength={2000} value={value.changeNote} onChange={event => change("changeNote", event.target.value)} /></Field>
  </div>;
}
