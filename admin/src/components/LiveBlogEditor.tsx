import { useId, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { renderRichText } from "../../../packages/content-core/src/content-model";
import { LIVE_BLOG_BRANDING, LIVE_BLOG_MAX_UPDATES, resolveLiveBlogPresentation, type LiveBlogData } from "../../../packages/content-core/src/live-blog";
import { liveBlogFollowUpsEqual, type LiveBlogDraft, type LiveBlogDraftUpdate } from "../../../packages/content-core/src/live-blog-draft";
import type { StoryCredit } from "../../../packages/content-core/src/story-credits";
import type { BylineAuthorOption } from "../lib/functions";
import type { LiveBlogPublicationIssue } from "../lib/live-blog";
import { ControlSizingProvider } from "../context/ControlSizingContext";
import { FieldRenderer } from "./FieldRenderer";
import { LiveBlogCreditWarnings } from "./LiveBlogCreditWarnings";
import { PostLeadMediaEditor } from "./PostLeadMediaEditor";
import { PostLeadMediaReview } from "./PostLeadMediaReview";
import { RichTextEditor } from "./RichTextEditor";
import { ActionControl } from "./ui/ActionControl";
import { Checkbox } from "./ui/Checkbox";
import { Button, Select, TextInput, Textarea } from "./ui/Primitives";
import { LiveBlogFollowUpsEditor } from "./LiveBlogFollowUpsEditor";
import "./LiveBlogEditor.css";

type EntryMediaProps = Pick<ComponentProps<typeof PostLeadMediaEditor>, "loadMedia" | "mediaPickerUnavailable" | "uploadMedia" | "mediaCategories" | "defaultUploadCategory" | "canUploadCategory" | "onMediaPickerDirtyChange">;

export function LiveBlogEditor({ coverageControl, value, published, saved, followUpBaselineKnown = true, onChange, onRemove, focusOnMount = false, readOnly = false, defaultCredits = [], authors, authorsUnavailable, authorsLoading, selfAuthorId, canManageAuthorProfiles, showPublicationWarnings = true, error, publicationIssue, controlId, entryKeys = {}, media = {} }: {
  coverageControl?: ReactNode;
  value: LiveBlogDraft; published?: LiveBlogData; saved?: LiveBlogDraft; followUpBaselineKnown?: boolean; onChange: (value: LiveBlogDraft) => void;
  onRemove?: () => void;
  focusOnMount?: boolean;
  readOnly?: boolean; defaultCredits?: StoryCredit[]; authors?: readonly BylineAuthorOption[];
  selfAuthorId?: string | null; canManageAuthorProfiles?: boolean; showPublicationWarnings?: boolean;
  authorsUnavailable?: boolean; authorsLoading?: boolean; error?: string; controlId: string;
  publicationIssue?: LiveBlogPublicationIssue | null;
  entryKeys?: Readonly<Record<string, string>>;
  media?: EntryMediaProps;
}) {
  const prefix = useId();
  const presentation = resolveLiveBlogPresentation(value);
  const firstId = value.updates[0]?.id;
  const [activeId, setActiveId] = useState<string | null>(firstId ? entryKeys[firstId] ?? firstId : null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [confirmRemoveBlog, setConfirmRemoveBlog] = useState(false);
  const removeBlogRef = useRef<HTMLButtonElement>(null);
  const cancelRemoveBlogRef = useRef<HTMLButtonElement>(null);
  const returnToRemoveBlog = useRef(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const headingRefs = useRef(new Map<string, HTMLLabelElement>());
  const summaryRefs = useRef(new Map<string, HTMLElement>());
  const removeRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<{ id?: string; field?: "headline" | "withdrawal" | "remove" } | null>(focusOnMount ? {} : null);
  const publicationIssueKey = publicationIssue ? entryKeys[publicationIssue.entryId] ?? publicationIssue.entryId : null;
  useLayoutEffect(() => {
    if (publicationIssueKey !== null) setActiveId(publicationIssueKey);
  }, [publicationIssue, publicationIssueKey]);
  useLayoutEffect(() => {
    if (!publicationIssue || activeId !== publicationIssueKey) return;
    const summary = summaryRefs.current.get(publicationIssue.entryId);
    summary?.scrollIntoView({ block: "center" });
    const target = publicationIssue.field === "headline"
      ? headingRefs.current.get(publicationIssue.entryId)?.querySelector("input") : summary;
    target?.focus();
  }, [publicationIssue, activeId, publicationIssueKey]);
  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    const { id, field } = pendingFocus.current;
    pendingFocus.current = null;
    const target = !id ? addRef.current : field === "headline" ? headingRefs.current.get(id)?.querySelector("input")
      : field === "withdrawal" ? document.getElementById(`${prefix}-${entryKeys[id] ?? id}-withdrawal`)
      : field === "remove" ? removeRefs.current.get(id) : summaryRefs.current.get(id);
    (target ?? addRef.current)?.focus();
  }, [value, removing, prefix, entryKeys]);
  useLayoutEffect(() => { if (removing) cancelRef.current?.focus(); }, [removing]);
  useLayoutEffect(() => {
    if (confirmRemoveBlog) cancelRemoveBlogRef.current?.focus();
    else if (returnToRemoveBlog.current) { returnToRemoveBlog.current = false; removeBlogRef.current?.focus(); }
  }, [confirmRemoveBlog]);
  const change = (id: string, patch: Partial<LiveBlogDraftUpdate>) => {
    if (!readOnly) onChange({ ...value, updates: value.updates.map(entry => entry.id === id ? { ...entry, ...patch } : entry) });
  };
  function explanation(id: string, field: "correction" | "withdrawal", text: string | undefined) {
    if (readOnly) return;
    onChange({ ...value, updates: value.updates.map(entry => {
      if (entry.id !== id) return entry;
      const next = { ...entry };
      if (text === undefined || (field === "correction" && text === "")) delete next[field];
      else next[field] = text;
      return next;
    }) });
  }
  function add() {
    if (readOnly || value.updates.length >= LIVE_BLOG_MAX_UPDATES) return;
    const id = `tmp-${crypto.randomUUID()}`;
    setActiveId(id); pendingFocus.current = { id, field: "headline" };
    onChange({ ...value, updates: [{ id, headline: "", body: { type: "doc", content: [] },
      credits: structuredClone(defaultCredits), keyUpdate: false }, ...value.updates] });
    setMessage("Draft update added.");
  }
  function remove(id: string) {
    if (readOnly || published?.updates.some(entry => entry.id === id)) return;
    const index = value.updates.findIndex(entry => entry.id === id);
    const next = value.updates.filter(entry => entry.id !== id);
    const nextId = next[Math.min(index, next.length - 1)]?.id;
    setActiveId(nextId ? entryKeys[nextId] ?? nextId : null); setRemoving(null); pendingFocus.current = { id: nextId };
    onChange({ ...value, updates: next }); setMessage("Draft update removed.");
  }
  return <ControlSizingProvider size="comfortable"><div className="live-blog-editor" id={controlId} tabIndex={-1} aria-describedby={error ? `${prefix}-error` : undefined}>
    <p>Save updates with this Post. Changes follow the Post’s normal review, approval and publication, unless an editor publishes live updates directly.</p>
    {error ? <p id={`${prefix}-error`} className="error-text" role="alert">{error}</p> : null}
    {coverageControl ?? <div className="editor-field"><label htmlFor={`${prefix}-branding`}>Coverage branding</label>
      <Select id={`${prefix}-branding`} disabled={readOnly} value={value.branding ?? ""} onChange={event => { if (!readOnly) onChange({ ...value, branding: event.target.value === LIVE_BLOG_BRANDING ? LIVE_BLOG_BRANDING : undefined }); }}>
        <option value="">General coverage</option><option value={LIVE_BLOG_BRANDING}>NJ Decides 2026</option>
      </Select>
    </div>
    }
    <div className="editor-field"><label htmlFor={`${prefix}-coverage-state`}>Coverage status</label>
      <Select id={`${prefix}-coverage-state`} disabled={readOnly} value={value.coverageState} onChange={event => { if (!readOnly) onChange({ ...value, coverageState: event.target.value as LiveBlogDraft["coverageState"] }); }}>
        <option value="ongoing">Ongoing</option><option value="paused">Paused</option><option value="ended">Ended</option>
      </Select>
    </div>
    <p className="editor-field-help">Ending coverage keeps its published archive. New updates appear first; corrections keep their original position and link.</p>
    <fieldset className="editor-field" disabled={readOnly}>
      <legend>Live blog appearance</legend>
      {([
        ["reporterPhotos", "Show reporter photos", "Show a photo circle beside each update, or initials when a photo is unavailable."],
        ["reporterCards", "Show reporter cards", "Readers can open reporter details from the photo."],
        ["playful", "Playful style", "Add extra feed-style touches to this live blog."],
      ] as const).map(([key, label, help]) => <div key={key}>
        <Checkbox label={label} checked={presentation[key]} disabled={readOnly} aria-describedby={`${prefix}-${key}-help`}
          onChange={event => { if (!readOnly) onChange({ ...value, presentation: { ...value.presentation, [key]: event.target.checked } }); }} />
        <p className="editor-field-help" id={`${prefix}-${key}-help`}>{help}</p>
      </div>)}
    </fieldset>
    {showPublicationWarnings ? <LiveBlogCreditWarnings credits={value.updates.filter(entry => entry.withdrawal === undefined).flatMap(entry => [...entry.credits, ...(entry.followUps ?? []).filter(item => item.withdrawal === undefined).flatMap(item => item.credits)])}
      authors={authors} authorsLoading={authorsLoading} selfAuthorId={selfAuthorId} canManageAuthorProfiles={canManageAuthorProfiles} label="Reporter profiles before publishing" /> : null}
    {value.updates.length === 0 ? <p>No updates yet. Add the first update to this draft.</p> : <ol className="live-blog-editor__entries" aria-label="Live updates" role="list">
      {value.updates.map((entry, index) => {
        const key = entryKeys[entry.id] ?? entry.id;
        const previous = published?.updates.find(item => item.id === entry.id);
        const withdrawn = previous?.withdrawal !== undefined;
        const withdrawing = entry.withdrawal !== undefined;
        const savedEntry = saved?.updates.find(item => item.id === entry.id) ?? previous;
        const unsavedFollowUps = !followUpBaselineKnown || entry.followUps?.some(item => !item.id || item.id.startsWith("tmp-"))
          || !liveBlogFollowUpsEqual(entry.followUps, savedEntry?.followUps);
        const label = entry.headline.trim() || `Untitled update ${index + 1}`;
        const id = `${prefix}-${key}`;
        return <li key={key}><details className="live-blog-editor__entry" open={activeId === key}>
          <summary id={`${controlId}-entry-${key}`} ref={node => { if (node) summaryRefs.current.set(entry.id, node); else summaryRefs.current.delete(entry.id); }}
            onClick={event => { event.preventDefault(); setActiveId(activeId === key ? null : key); }}>
            <strong>{withdrawn ? "Withdrawn update" : label}</strong>
            <span className="muted">{withdrawn ? "Withdrawn" : withdrawing ? "Withdrawal in draft" : previous ? "Published update" : "Draft update"}</span>
          </summary>
          {activeId === key ? <fieldset className="live-blog-editor__fields" disabled={readOnly}>
            <legend className="sr-only">{label}</legend>
            {withdrawing ? <>
              <label className="editor-field" htmlFor={`${id}-withdrawal`}>Withdrawal explanation
                <Textarea id={`${id}-withdrawal`} required maxLength={1000} value={entry.withdrawal ?? ""}
                  onChange={event => explanation(entry.id, "withdrawal", event.target.value)} />
              </label>
              <p>The published update will keep its link and show this explanation in place of its reporting.</p>
              {!withdrawn ? <Button disabled={readOnly} onClick={() => { pendingFocus.current = { id: entry.id, field: "headline" }; explanation(entry.id, "withdrawal", undefined); }}>Cancel withdrawal</Button> : null}
            </> : <>
              <label className="editor-field" htmlFor={`${controlId}-entry-${key}-headline`} ref={node => { if (node) headingRefs.current.set(entry.id, node); else headingRefs.current.delete(entry.id); }}>Update headline
                <TextInput id={`${controlId}-entry-${key}-headline`}
                  maxLength={240} value={entry.headline} onChange={event => change(entry.id, { headline: event.target.value })} />
              </label>
              {readOnly ? <div className="live-blog-editor__read-body" dangerouslySetInnerHTML={{ __html: renderRichText(entry.body, { minimumHeadingLevel: 4 }) }} />
                : <RichTextEditor value={entry.body} ariaLabel={`Body for ${label}`} minimumHeadingLevel={4} onChange={body => change(entry.id, { body })} />}
              {readOnly ? <PostLeadMediaReview context="entry" record={{ leadMedia: entry.media ?? null }} loadMedia={media.loadMedia} onMediaPickerDirtyChange={media.onMediaPickerDirtyChange} />
                : <PostLeadMediaEditor {...media} context="entry" record={{ leadMedia: entry.media ?? null }} fieldId={`${id}-media`}
                  onChange={next => change(entry.id, { media: next == null ? undefined : next as LiveBlogDraftUpdate["media"] })} />}
              <FieldRenderer field={{ key: "credits", label: "Update byline", help: "Credit the people who reported this update.", kind: "storyCredits", required: false }}
                fieldId={`${id}-credits`} value={entry.credits} onChange={credits => change(entry.id, { credits: credits as StoryCredit[] })}
                bylineAuthors={authors} bylineAuthorsUnavailable={authorsUnavailable} />
              <LiveBlogCreditWarnings credits={entry.credits} authors={authors} authorsLoading={authorsLoading} selfAuthorId={selfAuthorId} canManageAuthorProfiles={canManageAuthorProfiles} label={`Reporter profiles for ${label}`} />
              <Checkbox label={`Key update: ${label}`} checked={entry.keyUpdate} onChange={event => change(entry.id, { keyUpdate: event.target.checked })} />
              {previous ? <>
                <label className="editor-field" htmlFor={`${id}-correction`}>Correction explanation
                  <Textarea id={`${id}-correction`} maxLength={1000} value={entry.correction ?? ""}
                    onChange={event => explanation(entry.id, "correction", event.target.value)} />
                </label>
                <p className="editor-field-help">Changes to a published update need a new visible correction explanation before the Post can be published again.</p>
                {unsavedFollowUps ? <p id={`${id}-follow-up-save`} className="editor-field-help">Save this Post before withdrawing the update.</p> : null}
                <Button disabled={readOnly || unsavedFollowUps} aria-describedby={unsavedFollowUps ? `${id}-follow-up-save` : undefined} onClick={() => { pendingFocus.current = { id: entry.id, field: "withdrawal" }; explanation(entry.id, "withdrawal", ""); }}>Withdraw update in this draft</Button>
              </> : removing === key ? <div role="group" aria-label={`Remove ${label}?`}>
                <p>Remove this draft update and its reporting?</p><div className="button-row">
                  <Button ref={cancelRef} onClick={() => { pendingFocus.current = { id: entry.id, field: "remove" }; setRemoving(null); }}>Keep update</Button>
                  <Button onClick={() => remove(entry.id)}>Remove draft update</Button>
                </div>
              </div> : <ActionControl action="remove-item" accessibleName={`Remove draft update: ${label}`} disabled={readOnly}
                ref={node => { if (node) removeRefs.current.set(entry.id, node); else removeRefs.current.delete(entry.id); }} onClick={() => setRemoving(key)} />}
            </>}
            <LiveBlogFollowUpsEditor entry={entry} published={previous} readOnly={readOnly} defaultCredits={defaultCredits}
              authors={authors} authorsUnavailable={authorsUnavailable} authorsLoading={authorsLoading} selfAuthorId={selfAuthorId} canManageAuthorProfiles={canManageAuthorProfiles} entryKeys={entryKeys} onChange={followUps => change(entry.id, { followUps })} />
          </fieldset> : null}
        </details></li>;
      })}
    </ol>}
    <div className="button-row"><ActionControl action="add-item" label="Add update" accessibleName="Add live update" ref={addRef}
      disabled={readOnly || value.updates.length >= LIVE_BLOG_MAX_UPDATES} onClick={add} />
      <span className="muted">{value.updates.length} of {LIVE_BLOG_MAX_UPDATES} updates</span></div>
    <p className="sr-only" role="status">{message}</p>
    {onRemove && !published?.updates.length ? confirmRemoveBlog ? <div role="group" aria-label="Remove live blog">
      <p>Remove the live blog from this Post? Draft updates are deleted.</p>
      <div className="button-row">
        <Button ref={cancelRemoveBlogRef} disabled={readOnly} onClick={() => { returnToRemoveBlog.current = true; setConfirmRemoveBlog(false); }}>Cancel</Button>
        <Button disabled={readOnly} onClick={() => { if (!readOnly) onRemove(); }}>Remove live blog</Button>
      </div>
    </div> : <Button ref={removeBlogRef} disabled={readOnly} onClick={() => setConfirmRemoveBlog(true)}>Remove live blog</Button> : null}
  </div></ControlSizingProvider>;
}
