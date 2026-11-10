import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "../ui/Primitives";
import type { MediaCommentPerson } from "../../lib/media-feedback";
import { mentionMatches, mentionQuery } from "../../lib/media-comment-threads";

export interface MentionStaff {
  list: MediaCommentPerson[] | null;
  loading: boolean;
  error: string;
}

/**
 * A comment field with a staff picker. Typing @ and part of a name opens a list of active staff.
 * Up and Down move through the list, Enter inserts the name, and Escape closes the list.
 *
 * The field stays a textarea with the textbox role, because HTML does not allow the combobox role
 * on a textarea. It uses the combobox pattern's listbox, options, aria-autocomplete, aria-controls,
 * and aria-activedescendant so that focus never leaves the field.
 */
export function MentionTextarea({
  id,
  label,
  value,
  onChange,
  onPick,
  staff,
  onNeedStaff,
  disabled,
  rows = 4,
}: {
  id?: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onPick: (person: MediaCommentPerson) => void;
  staff: MentionStaff;
  onNeedStaff: () => void;
  disabled?: boolean;
  rows?: number;
}) {
  const ownId = useId();
  const fieldId = id ?? `${ownId}-field`;
  const listId = `${ownId}-staff`;
  const hintId = `${ownId}-hint`;
  const field = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(-1);
  // The query the reader closed with Escape stays closed while its @ and typed text remain. It
  // opens again once that text is gone, for example after a send clears the field.
  const [dismissed, setDismissed] = useState<{ start: number; text: string } | null>(null);
  const stillDismissed = dismissed !== null && value.startsWith(dismissed.text, dismissed.start);
  const query = mentionQuery(value, caret);
  const open = Boolean(query) && !(stillDismissed && query!.start === dismissed!.start) && !disabled;
  const matches = open && staff.list ? mentionMatches(staff.list, query!.query) : [];
  const listed = open && matches.length > 0;

  useEffect(() => {
    if (open && !staff.list && !staff.loading && !staff.error) onNeedStaff();
  }, [open, staff.list, staff.loading, staff.error, onNeedStaff]);
  useEffect(() => { setActive(-1); }, [query?.start, query?.query]);
  useEffect(() => { if (dismissed && !stillDismissed) setDismissed(null); }, [dismissed, stillDismissed]);

  function track() {
    const element = field.current;
    if (element) setCaret(element.selectionStart ?? element.value.length);
  }

  function pick(person: MediaCommentPerson) {
    if (!query) return;
    const inserted = `@${person.name} `;
    const end = query.start + 1 + query.query.length;
    const next = value.slice(0, query.start) + inserted + value.slice(end);
    const position = query.start + inserted.length;
    onPick(person);
    onChange(next);
    setCaret(position);
    setActive(-1);
    requestAnimationFrame(() => {
      field.current?.focus();
      field.current?.setSelectionRange(position, position);
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!open) return;
    if (event.key === "Escape") {
      setDismissed({ start: query!.start, text: `@${query!.query}` });
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!listed) return;
    if (event.key === "ArrowDown") setActive(index => (index + 1) % matches.length);
    else if (event.key === "ArrowUp") setActive(index => (index <= 0 ? matches.length : index) - 1);
    else if (event.key === "Enter" && active >= 0) pick(matches[active]);
    else return;
    event.preventDefault();
  }

  const optionId = (index: number) => `${listId}-${index}`;
  const announcement = !open
    ? ""
    : staff.loading
      ? "Loading staff."
      : listed
        ? `${matches.length} staff ${matches.length === 1 ? "match" : "matches"}. Use the up and down arrows to choose, then press Enter.`
        : staff.list
          ? "No staff match."
          : "";

  return <div className="media-mention">
    <label className="media-feedback-field" htmlFor={fieldId}>{label}</label>
    <textarea ref={field} id={fieldId} className="field-control" maxLength={2000} rows={rows} value={value}
      disabled={disabled} aria-describedby={hintId} aria-autocomplete="list"
      aria-controls={listed ? listId : undefined}
      aria-activedescendant={listed && active >= 0 ? optionId(active) : undefined}
      onChange={event => { onChange(event.target.value); setCaret(event.target.selectionStart ?? event.target.value.length); }}
      onSelect={track} onKeyUp={track} onClick={track} onKeyDown={onKeyDown}
      onBlur={() => setActive(-1)} />
    <p id={hintId} className="media-feedback-help">Type @ and a name to mention a staff member.</p>
    {open ? <div className="media-mention-popup">
      {listed ? <ul role="listbox" id={listId} aria-label="Staff to mention" className="media-mention-list">
        {matches.map((person, index) => <li key={person.uid} id={optionId(index)} role="option"
          aria-selected={index === active} className="media-mention-option"
          // Mouse down keeps focus in the field; the click then inserts the name.
          onMouseDown={event => event.preventDefault()} onClick={() => pick(person)}>{person.name}</li>)}
      </ul> : staff.error ? <div className="media-feedback-actions">
        <p className="media-feedback-status">{staff.error}</p>
        <Button onMouseDown={event => event.preventDefault()} onClick={onNeedStaff}>Load staff again</Button>
      </div> : <p className="media-feedback-status">{staff.loading || !staff.list ? "Loading staff" : "No staff match."}</p>}
    </div> : null}
    <p className="sr-only" role="status">{announcement}</p>
  </div>;
}
