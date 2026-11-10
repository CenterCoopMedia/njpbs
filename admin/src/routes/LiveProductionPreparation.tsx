import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { parseBannerText, type BannerText } from "../../../packages/content-core/src/live-production";
import { LeaveGuardDialog } from "./LeaveGuardDialog";
import { Button, InlineMessage, Select, Textarea, TextInput } from "../components/ui/Primitives";
import { csvRequestFits, LIVE_CSV_MAX_BYTES, previewBannerCsv } from "../lib/live-production-csv";
import { bannerLines, orderNumber, parseOrderNumber, templateLabel, type LiveProductionClient, type OrderedBanner } from "../lib/live-production-workspace";

export type PreparationDraft =
  | { kind: "banner"; text: BannerText; order: string; initialOrder: string }
  | { kind: "csv"; csv: string; archiveExisting: boolean; fileError: string | null }
  | { kind: "session"; programId: string; title: string; suggestedTitle: string };

export function preparationDirty(draft: PreparationDraft | null): boolean {
  if (!draft) return false;
  if (draft.kind === "csv") return Boolean(draft.csv || draft.archiveExisting);
  if (draft.kind === "session") return Boolean(draft.programId || draft.title);
  return draft.order !== draft.initialOrder || draft.text.templateId !== "headline" || Boolean(draft.text.headline);
}
export function newBannerDraft(rows: OrderedBanner[]): Extract<PreparationDraft, { kind: "banner" }> {
  const last = Math.max(-1, ...rows.map(row => row.order));
  const order = last < Number.MAX_SAFE_INTEGER ? orderNumber(last + 1) : "";
  return { kind: "banner", text: { templateId: "headline", headline: "" }, order, initialOrder: order };
}
export function validBannerText(text: BannerText): boolean {
  try { parseBannerText(text); return true; } catch { return false; }
}
export function BannerFields({ text, disabled, onChange }: {
  text: BannerText; disabled: boolean; onChange: (text: BannerText) => void;
}) {
  return text.templateId === "headline" ? <label>Headline<Textarea rows={4} value={text.headline} disabled={disabled}
    onChange={event => onChange({ templateId: "headline", headline: event.target.value })} /></label> : <div className="live-name-fields">
    <label>Name<Textarea rows={2} value={text.name} disabled={disabled} onChange={event => onChange({ ...text, name: event.target.value })} /></label>
    <label>Title<Textarea rows={3} value={text.title} disabled={disabled} onChange={event => onChange({ ...text, title: event.target.value })} /></label>
  </div>;
}
type FormProps<T extends PreparationDraft> = {
  draft: T; disabled: boolean; onChange: (draft: T) => void; onSubmit: () => void; onCancel: () => void; cancelDisabled?: boolean;
  /** Hold the submit only, for example while offline; entered text stays editable. */
  submitDisabled?: boolean;
};
function submit(event: FormEvent, callback: () => void) { event.preventDefault(); callback(); }
export function NewBannerForm({ draft, disabled, onChange, onSubmit, onCancel, cancelDisabled = disabled, submitDisabled = false, onTemplateChange }: FormProps<Extract<PreparationDraft, { kind: "banner" }>> & {
  onTemplateChange: (template: BannerText["templateId"]) => void;
}) {
  const valid = validBannerText(draft.text) && parseOrderNumber(draft.order) !== null;
  return <form className="live-preparation-form" onSubmit={event => submit(event, onSubmit)}>
    <h2 tabIndex={-1}>New banner</h2>
    <label>Banner template<Select value={draft.text.templateId} disabled={disabled} onChange={event => onTemplateChange(event.target.value as BannerText["templateId"])}>
      <option value="headline">Headline</option><option value="name_title">Name and title</option>
    </Select></label>
    <BannerFields text={draft.text} disabled={disabled} onChange={text => onChange({ ...draft, text })} />
    <label>Order number<TextInput inputMode="numeric" value={draft.order} disabled={disabled} onChange={event => onChange({ ...draft, order: event.target.value })} /></label>
    <p className="live-caption">Use lower numbers for earlier banners. Adding a banner does not change output.</p>
    {parseOrderNumber(draft.order) === null && <InlineMessage tone="error">Enter a whole order number of 1 or more.</InlineMessage>}
    <div className="live-actions"><Button type="submit" variant="primary" disabled={disabled || submitDisabled || !valid}>Add banner</Button>
      <Button type="button" disabled={cancelDisabled} onClick={onCancel}>Cancel new banner</Button></div>
  </form>;
}

export function CsvImportForm({ draft, disabled, onChange, onSubmit, onCancel, cancelDisabled = disabled, submitDisabled = false, sessionId }: FormProps<Extract<PreparationDraft, { kind: "csv" }>> & {
  sessionId: string;
}) {
  const preview = useMemo(() => draft.csv ? previewBannerCsv(draft.csv) : null, [draft.csv]);
  const [reading, setReading] = useState(false);
  const [replacementCsv, setReplacementCsv] = useState<string | null>(null);
  const fitsRequest = csvRequestFits(draft.csv, sessionId, draft.archiveExisting);
  const fileEpoch = useRef(0);
  useEffect(() => () => { fileEpoch.current++; }, []);
  async function readFile(file: File | undefined) {
    const epoch = ++fileEpoch.current;
    if (!file) return;
    if (file.size > LIVE_CSV_MAX_BYTES + 3) { onChange({ ...draft, fileError: "CSV must be 240 KiB or smaller." }); return; }
    setReading(true);
    try {
      const csv = await file.text();
      if (epoch !== fileEpoch.current) return;
      if (preparationDirty(draft)) setReplacementCsv(csv);
      else onChange({ ...draft, csv, fileError: null });
    } catch { if (epoch === fileEpoch.current) onChange({ ...draft, fileError: "This file could not be read. Choose it again or paste the CSV." }); }
    finally { if (epoch === fileEpoch.current) setReading(false); }
  }
  return <form className="live-preparation-form" onSubmit={event => submit(event, onSubmit)}>
    <h2 tabIndex={-1}>Import banner CSV</h2>
    <p>Preview up to 100 banners before saving. The header is <code>templateId,headline,name,title</code>.</p>
    <p className="live-caption">Use <code>headline</code> or <code>name_title</code>. Leave unused cells empty. Quotes, line breaks and all text stay literal.</p>
    <label>CSV file<input type="file" accept=".csv,text/csv" disabled={disabled || reading} onChange={event => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      void readFile(file);
    }} /></label>
    <label>CSV text<Textarea rows={5} value={draft.csv} disabled={disabled || reading} onChange={event => {
      fileEpoch.current++; onChange({ ...draft, csv: event.target.value, fileError: null });
    }} /></label>
    {reading && <p role="status">Reading CSV…</p>}
    {draft.fileError && <InlineMessage tone="error">{draft.fileError}</InlineMessage>}
    {!fitsRequest && <InlineMessage tone="error">This CSV is too large to send after encoding its quotes and line breaks. Split it into smaller files.</InlineMessage>}
    {preview && <>
      <p role="status">{preview.banners.length} valid banner rows{preview.errors.length ? ` · ${preview.errors.length} errors to correct` : " · Ready to import"}</p>
      {preview.errors.length > 0 && <InlineMessage tone="error" title="Correct the CSV before importing"><ul>{preview.errors.map((error, index) =>
        <li key={index}>{error.row === null ? "File" : `CSV row ${error.row}`}: {error.message}</li>)}</ul></InlineMessage>}
      {preview.banners.length > 0 && <div className="live-csv-preview"><table><caption>Banner preview · nothing saved yet</caption>
        <thead><tr><th>Row</th><th>Template</th><th>Text</th></tr></thead><tbody>{preview.banners.map(row => <tr key={row.row}>
          <td>{row.row}</td><td>{templateLabel(row.text)}</td><td className="live-copy">{bannerLines(row.text).map((line, index) => <p key={index}>{line || "(empty title)"}</p>)}</td>
        </tr>)}</tbody></table></div>}
    </>}
    <label className="live-check"><input type="checkbox" checked={draft.archiveExisting} disabled={disabled || reading}
      onChange={event => onChange({ ...draft, archiveExisting: event.target.checked })} />Archive current banners first</label>
    <p className="live-caption">{draft.archiveExisting ? "All current banners in this session will be archived, including banners beyond the loaded pages. " : "New banners will be added after the current rundown. "}
      An archived on-air graphic stays on air. Import never clears Overlay 1.</p>
    <div className="live-actions"><Button type="submit" variant="primary" disabled={disabled || submitDisabled || reading || !fitsRequest || Boolean(draft.fileError) || !preview || !preview.banners.length || preview.errors.length > 0}>
      {draft.archiveExisting ? "Review archive and import" : "Import banners"}</Button>
      <Button type="button" disabled={cancelDisabled || reading} onClick={onCancel}>Cancel import</Button></div>
    {replacementCsv !== null && <LeaveGuardDialog title="Replace the current CSV?"
      description="This replaces the CSV text and preview in this form. No banners have been saved."
      confirmLabel="Replace CSV" cancelLabel="Keep current CSV" onCancel={() => setReplacementCsv(null)} onConfirm={() => {
        onChange({ ...draft, csv: replacementCsv, fileError: null }); setReplacementCsv(null);
      }} />}
  </form>;
}

export function CreateSessionForm({ client, draft, disabled, onChange, onSubmit, onCancel, cancelDisabled = disabled, submitDisabled = false }: FormProps<Extract<PreparationDraft, { kind: "session" }>> & { client: LiveProductionClient }) {
  const [programs, setPrograms] = useState<{ id: string; title: string }[]>([]);
  const [nextPage, setNextPage] = useState<number | null>(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  async function load(page: number) {
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    setLoading(true); setError(null);
    try {
      const result = await client.programs(page, request.signal);
      if (request.signal.aborted) return;
      setPrograms(prior => [...prior, ...result.programs.filter(item => !prior.some(old => old.id === item.id))]); setNextPage(result.nextPage);
    } catch (e) { if (!request.signal.aborted) setError(e instanceof Error ? e.message : "The program list could not load."); }
    finally { if (!request.signal.aborted) setLoading(false); }
  }
  useEffect(() => { void load(1); return () => controller.current?.abort(); }, [client]);
  return <form className="live-preparation-form" onSubmit={event => submit(event, onSubmit)}>
    <h3 tabIndex={-1}>Create a studio session</h3>
    <p>A technician creates one long-lived session per program and binds it using the studio runbook. Producers reuse it each show.</p>
    <label>Program<Select value={draft.programId} disabled={disabled || loading} onChange={event => {
      const program = programs.find(item => item.id === event.target.value);
      const suggestedTitle = program ? `${program.title} - ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date())}` : "";
      onChange({ ...draft, programId: event.target.value, suggestedTitle, title: draft.title === draft.suggestedTitle ? suggestedTitle : draft.title });
    }}><option value="">Choose a program</option>{programs.map(program => <option key={program.id} value={program.id}>{program.title}</option>)}</Select></label>
    {loading && <p role="status">Loading programs…</p>}
    {error && <InlineMessage tone="error">{error}</InlineMessage>}
    {nextPage !== null && <Button type="button" disabled={disabled || loading} onClick={() => void load(nextPage)}>{error ? "Retry programs" : "More programs"}</Button>}
    {!loading && !error && !programs.length && <p>No programs are available for this account.</p>}
    <label>Session name<TextInput value={draft.title} disabled={disabled} onChange={event => onChange({ ...draft, title: event.target.value })} /></label>
    <p className="live-caption">The suggested date is editable text. A new draft cannot Take until its device binding and two title inputs are verified.</p>
    <div className="live-actions"><Button type="submit" variant="primary" disabled={disabled || submitDisabled || loading || !draft.title.trim() || !programs.some(program => program.id === draft.programId)}>Create studio session</Button>
      <Button type="button" disabled={cancelDisabled} onClick={onCancel}>Cancel session creation</Button></div>
  </form>;
}
