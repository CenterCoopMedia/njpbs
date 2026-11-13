import { useContext, useEffect, useId, useRef, useState } from "react";
import { ContentShelfSources } from "./ContentShelfPicker";
import { DEFAULT_CONTENT_QUERY } from "../lib/content-query";
import type { ContentRecordSummary } from "../lib/content-records";
import type { LibrarySelection } from "../lib/content-library";
import { Button, TextInput } from "./ui/Primitives";

export function NewsletterSignupEditor({ data, onChange, readOnly = false }: {
  data: Record<string, unknown>;
  onChange: (data: Record<string, unknown>, discrete?: boolean) => void;
  readOnly?: boolean;
}) {
  const sources = useContext(ContentShelfSources);
  const id = useId();
  const ids = Array.isArray(data.newsletterIds) ? data.newsletterIds.filter((value): value is string => typeof value === "string") : [];
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<LibrarySelection | null>(null);
  const [chosen, setChosen] = useState<Record<string, ContentRecordSummary>>({});
  const [warnings, setWarnings] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const selectedKey = ids.join("\u0000");
  useEffect(() => {
    if (!sources.loadRecord || ids.length === 0) return;
    let current = true;
    void Promise.all(ids.map(async recordId => {
      try {
        const loaded = await sources.loadRecord!("newsletter", recordId);
        if (!current) return;
        if (loaded.status !== "ready") {
          setWarnings(previous => ({ ...previous, [recordId]: "This newsletter is unavailable and will not appear publicly." }));
          return;
        }
        const record = loaded.record;
        setChosen(previous => ({ ...previous, [recordId]: {
          id: recordId, kind: "newsletter", title: String(record.title ?? recordId), status: String(record.status ?? "draft"),
        } }));
        const usable = typeof record.signupUrl === "string" && /^https:\/\//i.test(record.signupUrl.trim());
        if (record.status === "archived" || record.deleted === true || !usable) {
          setWarnings(previous => ({ ...previous, [recordId]: "This newsletter needs an active record and a secure signup link to appear publicly." }));
        } else {
          setWarnings(previous => { const next = { ...previous }; delete next[recordId]; return next; });
        }
      } catch {
        if (current) setWarnings(previous => ({ ...previous, [recordId]: "This newsletter could not be checked. Try reopening the editor." }));
      }
    }));
    return () => { current = false; };
  }, [selectedKey, sources.loadRecord]);
  async function search(page = 1) {
    if (!sources.loadLibrarySelection) return;
    const current = ++request.current;
    setBusy(true); setError("");
    try {
      const next = await sources.loadLibrarySelection({ ...DEFAULT_CONTENT_QUERY, types: ["newsletter"], statuses: [], q: query.trim(), page });
      if (current !== request.current) return;
      setResult(next);
      setChosen(previous => ({ ...previous, ...Object.fromEntries(next.records.map(record => [record.id, record])) }));
    } catch { if (current === request.current) setError("Newsletters could not be loaded. Try again."); }
    finally { if (current === request.current) setBusy(false); }
  }
  const update = (newsletterIds: string[]) => onChange({ ...data, newsletterIds }, true);
  return <div className="newsletter-signup-editor">
    <label htmlFor={`${id}-heading`}>Heading</label>
    <TextInput id={`${id}-heading`} value={String(data.heading ?? "")} disabled={readOnly} onChange={event => onChange({ ...data, heading: event.target.value })} />
    <label htmlFor={`${id}-intro`}>Introduction</label>
    <TextInput id={`${id}-intro`} value={String(data.intro ?? "")} disabled={readOnly} onChange={event => onChange({ ...data, intro: event.target.value })} />
    <p>Choose one to four newsletters. Each needs a secure signup link to appear on the public page.</p>
    <ul>{ids.map(recordId => <li key={recordId}>{chosen[recordId]?.title ?? `Newsletter ${recordId}`}{chosen[recordId] ? ` · ${chosen[recordId].status}` : ""}{" "}<Button disabled={readOnly} onClick={() => update(ids.filter(id => id !== recordId))}>Remove</Button>{warnings[recordId] ? <p role="status">{warnings[recordId]}</p> : null}</li>)}</ul>
    <label htmlFor={`${id}-search`}>Find newsletters</label>
    <TextInput id={`${id}-search`} value={query} disabled={readOnly} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
      if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
      event.preventDefault();
      if (!readOnly && !busy) void search();
    }} />
    <Button disabled={readOnly || busy || !sources.loadLibrarySelection} onClick={() => void search()}>Search newsletters</Button>
    {error ? <p role="alert">{error}</p> : null}
    {busy ? <p role="status">Loading newsletters…</p> : null}
    {result ? <><ul>{result.records.map(record => <li key={record.id}>
      <Button disabled={readOnly || ids.length >= 4 || ids.includes(record.id) || record.status === "archived"} onClick={() => update([...ids, record.id])}>Add {record.title}</Button>
      <span> {record.status}</span>
    </li>)}</ul>
      <p>Page {result.page} of {result.pageCount}</p>
      <Button disabled={readOnly || busy || result.page <= 1} onClick={() => void search(result.page - 1)}>Previous</Button>
      <Button disabled={readOnly || busy || result.page >= result.pageCount} onClick={() => void search(result.page + 1)}>Next</Button>
    </> : null}
  </div>;
}
