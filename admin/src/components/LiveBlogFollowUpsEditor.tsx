import { useId, useLayoutEffect, useRef, useState } from "react";
import type { LiveBlogDraftFollowUp, LiveBlogDraftUpdate } from "../../../packages/content-core/src/live-blog-draft";
import { LIVE_BLOG_MAX_FOLLOW_UPS, type LiveBlogUpdate } from "../../../packages/content-core/src/live-blog";
import { renderRichText } from "../../../packages/content-core/src/content-model";
import type { StoryCredit } from "../../../packages/content-core/src/story-credits";
import type { BylineAuthorOption } from "../lib/functions";
import { RichTextEditor } from "./RichTextEditor";
import { FieldRenderer } from "./FieldRenderer";
import { LiveBlogCreditWarnings } from "./LiveBlogCreditWarnings";
import { ActionControl } from "./ui/ActionControl";
import { Button, Textarea } from "./ui/Primitives";

export function LiveBlogFollowUpsEditor({ entry, published, readOnly, defaultCredits, authors, authorsUnavailable, authorsLoading, selfAuthorId, canManageAuthorProfiles, entryKeys, onChange }: {
  entry: LiveBlogDraftUpdate; published?: LiveBlogUpdate; readOnly: boolean; defaultCredits: StoryCredit[];
  authors?: readonly BylineAuthorOption[]; authorsUnavailable?: boolean; authorsLoading?: boolean;
  selfAuthorId?: string | null; canManageAuthorProfiles?: boolean;
  entryKeys: Readonly<Record<string, string>>;
  onChange: (value: LiveBlogDraftFollowUp[]) => void;
}) {
  const prefix = useId();
  const section = useRef<HTMLElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const pendingRemoveFocus = useRef<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const items = entry.followUps ?? [];
  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    const id = pendingFocus.current; pendingFocus.current = null;
    (section.current?.querySelector<HTMLElement>(`[data-follow-up-key="${id}"] [role="textbox"], [data-follow-up-key="${id}"] textarea`) ?? addButton.current)?.focus();
  }, [items]);
  useLayoutEffect(() => {
    if (removing === null && pendingRemoveFocus.current) {
      removeButtons.current.get(pendingRemoveFocus.current)?.focus(); pendingRemoveFocus.current = null;
    }
  }, [removing]);
  const patch = (id: string, value: Partial<LiveBlogDraftFollowUp>) => {
    if (readOnly) return;
    onChange(items.map(item => {
      if (item.id !== id) return item;
      const next = { ...item, ...value };
      if (!next.correction) delete next.correction;
      if (value.withdrawal === undefined && Object.hasOwn(value, "withdrawal")) delete next.withdrawal;
      return next;
    }));
  };
  if (entry.withdrawal !== undefined || published?.withdrawal !== undefined) return <section aria-labelledby={`${prefix}-heading`}>
    <h4 id={`${prefix}-heading`}>Follow-ups</h4><p>Follow-ups are hidden with this withdrawn update.</p>
    <Button disabled>Add follow-up</Button>
  </section>;
  return <section ref={section} aria-labelledby={`${prefix}-heading`}>
    <h4 id={`${prefix}-heading`}>Follow-ups</h4>
    <p className="editor-field-help">Add a short follow-up under this update. Use up to 1,000 characters in paragraphs, with links, bold or italic.</p>
    <ol aria-label="Follow-ups" role="list">{items.map((item, index) => {
      const before = published?.followUps?.find(old => old.id === item.id);
      const withdrawn = before?.withdrawal !== undefined;
      const key = entryKeys[`${entry.id}/${item.id}`] ?? item.id;
      const id = `${prefix}-${key}`;
      return <li key={key} data-follow-up-key={item.id}><fieldset disabled={readOnly}>
        <legend>Follow-up {index + 1}</legend>
        {item.withdrawal !== undefined ? <>
          <label htmlFor={`${id}-withdrawal`}>Withdrawal explanation</label>
          <Textarea id={`${id}-withdrawal`} maxLength={1000} required value={item.withdrawal} onChange={event => patch(item.id, { withdrawal: event.target.value })} />
          <p>The follow-up keeps its link and shows this explanation in place of its reporting.</p>
          {!withdrawn ? <Button onClick={() => { pendingFocus.current = item.id; patch(item.id, { withdrawal: undefined }); }}>Cancel follow-up withdrawal</Button> : null}
        </> : <>
          {readOnly ? <div dangerouslySetInnerHTML={{ __html: renderRichText(item.body) }} /> : <RichTextEditor shortTextOnly value={item.body}
            ariaLabel={`Body for follow-up ${index + 1}`} onChange={body => patch(item.id, { body })} />}
          <FieldRenderer field={{ key: "credits", label: "Follow-up byline", help: "Credit the people who reported this follow-up.", kind: "storyCredits", required: false }} fieldId={`${id}-credits`}
            value={item.credits} onChange={credits => patch(item.id, { credits: credits as StoryCredit[] })} bylineAuthors={authors} bylineAuthorsUnavailable={authorsUnavailable} />
          <LiveBlogCreditWarnings credits={item.credits} authors={authors} authorsLoading={authorsLoading} selfAuthorId={selfAuthorId}
            canManageAuthorProfiles={canManageAuthorProfiles} label={`Reporter profiles for follow-up ${index + 1}`} />
          {before ? <>
            <label htmlFor={`${id}-correction`}>Follow-up correction explanation</label>
            <Textarea id={`${id}-correction`} maxLength={1000} value={item.correction ?? ""} onChange={event => patch(item.id, { correction: event.target.value })} />
            <p className="editor-field-help">Editing a published follow-up needs a new correction explanation.</p>
            <Button onClick={() => { pendingFocus.current = item.id; patch(item.id, { withdrawal: "" }); }}>Withdraw follow-up in this draft</Button>
          </> : removing === item.id ? <div role="group" aria-label={`Remove follow-up ${index + 1}?`}>
            <p>Remove this draft follow-up and its reporting?</p>
            <Button autoFocus onClick={() => { pendingRemoveFocus.current = item.id; setRemoving(null); }}>Keep follow-up</Button>
            <Button onClick={() => { if (!readOnly) { onChange(items.filter(old => old.id !== item.id)); setRemoving(null); addButton.current?.focus(); } }}>Remove draft follow-up</Button>
          </div> : <ActionControl action="remove-item" accessibleName={`Remove draft follow-up ${index + 1}`} ref={node => { if (node) removeButtons.current.set(item.id, node); else removeButtons.current.delete(item.id); }} onClick={() => setRemoving(item.id)} />}
        </>}
      </fieldset></li>;
    })}</ol>
    <Button ref={addButton} disabled={readOnly || items.length >= LIVE_BLOG_MAX_FOLLOW_UPS} onClick={() => {
      if (readOnly || items.length >= LIVE_BLOG_MAX_FOLLOW_UPS) return;
      const id = `tmp-${crypto.randomUUID()}`; pendingFocus.current = id;
      onChange([...items, { id, body: { type: "doc", content: [] }, credits: structuredClone(defaultCredits) }]);
      setMessage("Draft follow-up added.");
    }}>Add follow-up</Button>
    <p role="status" className="sr-only">{message}</p>
  </section>;
}
