import { useEffect, useId, useRef, useState } from "react";
import type { BioCardData } from "../../../packages/content-core/src/bio-profiles";
import { publicBioCard } from "../lib/bio-catalog";
import { useBioCatalog } from "./BioCatalogContext";
import { Button, Select, TextInput } from "./ui/Primitives";
import "./BioCardEditor.css";

export function BioPickerDialog({ open, onClose, onChoose }: {
  open: boolean; onClose: () => void; onChoose: (profile: BioCardData) => void;
}) {
  const source = useBioCatalog();
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);
  const load = source?.load;
  useEffect(() => { if (open) load?.(); }, [open, load]);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element.showModal(); element.querySelector("input")?.focus();
    } else if (!open && element.open) {
      element.close(); opener.current?.focus();
    }
    if (!open) setSelected(null);
  }, [open]);
  const profiles = source?.catalog?.profiles ?? [];
  const terms = query.trim().toLocaleLowerCase("en-US").split(/\s+/).filter(Boolean);
  const results = profiles.filter(profile => (kind === "all" || profile.kind === kind) &&
    terms.every(term => [profile.name, profile.role, profile.party, profile.area].join(" ").toLocaleLowerCase("en-US").includes(term)));
  const choice = results.find(profile => profile.profileId === selected);
  return <dialog className="bio-picker-dialog" ref={dialog} aria-label="Choose a bio" onCancel={onClose} onClose={onClose}>
    <div className="bio-picker-header"><h2>Choose a bio</h2><Button onClick={onClose}>Close</Button></div>
    <p>Choose a sourced public bio. The full staff research stays private.</p>
    <div className="bio-picker-filters"><label htmlFor={searchId}>Search name, role or area</label>
      <TextInput id={searchId} value={query} onChange={event => setQuery(event.target.value)} />
      <label htmlFor={`${searchId}-kind`}>Profile type</label><Select id={`${searchId}-kind`} value={kind} onChange={event => setKind(event.target.value)}>
        <option value="all">People and organizations</option><option value="person">People</option><option value="organization">Organizations</option>
      </Select></div>
    {!source ? <p role="alert">Bios are available in article body blocks.</p> : source.busy ? <p role="status">Loading bios…</p> : source.error ?
      <div role="alert"><p>{source.error}</p><Button onClick={source.load}>Try again</Button></div> : source.catalog ? <>
        <p role="status">{results.length} {results.length === 1 ? "bio" : "bios"} found</p>
        <ul className="bio-picker-results">{results.map(profile => <li key={profile.profileId}>
          <Button aria-label={[profile.name, profile.role, profile.party, profile.area].filter(Boolean).join(", ")}
            aria-pressed={selected === profile.profileId} onClick={() => setSelected(profile.profileId)}>
            <strong>{profile.name}</strong><span>{profile.role}</span><small>{[profile.party, profile.area].filter(Boolean).join(" · ")}</small>
          </Button></li>)}</ul>
      </> : null}
    {choice ? <section className="bio-picker-preview" aria-label="Selected bio preview">
      <h3>{choice.name}</h3><p>{choice.role}</p><p>{[choice.party, choice.area].filter(Boolean).join(" · ")}</p>
      <p>{choice.summary}</p>
      <p className="bio-editor-note">Checked {choice.asOf} · <a href={choice.sourceUrl} target="_blank" rel="noopener noreferrer">{choice.sourceLabel}<span className="sr-only"> (opens in new tab)</span></a></p>
      {choice.sources?.length ? <details className="bio-picker-evidence"><summary>Review supporting sources</summary>
        <ul>{choice.sources.map((source, index) => <li key={`${source.url}-${index}`}>
          <a href={source.url} target="_blank" rel="noopener noreferrer">{new URL(source.url).hostname}<span className="sr-only"> (opens in new tab)</span></a>
          <p>{source.supports.join("; ")} · Checked {source.checkedAt}</p>
        </li>)}</ul>
      </details> : null}
      <p className="bio-editor-note">Review these facts for this article. Later catalog changes will not change saved articles.</p>
      <Button variant="primary" onClick={() => { onChoose(publicBioCard(choice)); onClose(); }}>Use this bio</Button>
    </section> : null}
  </dialog>;
}
