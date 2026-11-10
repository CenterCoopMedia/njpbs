import { useEffect, useMemo, useRef, useState } from "react";
import { Select } from "./ui/Primitives";
import { ActionControl } from "./ui/ActionControl";
import type { EditorField } from "../../../packages/content-core/src/editor-admin";
import {
  STORY_CREDITS_MAX,
  moveStoryCredit,
  normalizeCustomCreditName,
  normalizeStoryCredits,
  storyCreditKey,
  type StoryCredit,
} from "../../../packages/content-core/src/story-credits";
import type { BylineAuthorOption } from "../lib/functions";

// The ordered byline control (#1040). It replaces the single free-text name a
// post used to carry, and it is a purpose-built control rather than a generic
// repeatable list because the two kinds of credit are different things: a
// registered credit is a PERSON, chosen from the CMS author identities and stored
// as their stable id, while a custom credit is TEXT ("NJ PBS staff", a wire
// service, a guest contributor) that creates no account and is never matched
// against anybody.
//
// Three things the editor can see and the tests assert:
//
//  - Order is meaning. Every row has move-up and move-down controls whose
//    accessible names say which credit they move, and the ends are disabled.
//  - A registered credit shows the person's CURRENT name, read from the picker
//    feed, because the record stores the id and not the spelling. Once published
//    the snapshot freezes the name; here it stays live.
//  - A registered credit whose author is no longer listed still shows the byline
//    as it was frozen, or says plainly that the author is no longer listed. It is
//    never rendered as a raw id and never silently dropped from the editor.

export interface StoryCreditsFieldProps {
  field: EditorField;
  value: unknown;
  onChange: (value: unknown) => void;
  fieldId: string;
  labelId: string;
  invalid: boolean;
  describedBy: string | undefined;
  /** The people this editor may credit. Empty until the feed loads. */
  authors?: readonly BylineAuthorOption[];
  /** Set when the picker feed could not be read, so the UI says so rather than looking empty. */
  authorsUnavailable?: boolean;
}

// The credits to render. Deliberately NOT `normalizeStoryCredits`: that is the
// save-boundary reading, and it drops the frozen `displayName` a published
// snapshot carries because a client may not assert one. Here that name is the
// only thing standing between an editor and a row that reads `au_…`, so it is
// kept for display while everything else is validated the same way.
function readCredits(value: unknown): StoryCredit[] {
  if (!Array.isArray(value)) return [];
  const validated = normalizeStoryCredits(value).credits;
  const frozenNames = new Map<string, string>();
  for (const raw of value) {
    if (
      typeof raw === "object" &&
      raw !== null &&
      (raw as { kind?: unknown }).kind === "registered" &&
      typeof (raw as { authorId?: unknown }).authorId === "string" &&
      typeof (raw as { displayName?: unknown }).displayName === "string"
    ) {
      const entry = raw as { authorId: string; displayName: string };
      frozenNames.set(entry.authorId, entry.displayName);
    }
  }
  return validated.map((credit) => {
    if (credit.kind !== "registered") return credit;
    const displayName = frozenNames.get(credit.authorId);
    return displayName === undefined ? credit : { ...credit, displayName };
  });
}

export function StoryCreditsField({
  field,
  value,
  onChange,
  fieldId,
  labelId,
  invalid,
  describedBy,
  authors = [],
  authorsUnavailable = false,
}: StoryCreditsFieldProps) {
  const credits = readCredits(value);
  const [customDraft, setCustomDraft] = useState("");
  const [pickedAuthorId, setPickedAuthorId] = useState("");
  const [notice, setNotice] = useState("");
  const customInputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const pendingFocusIndex = useRef<number | null>(null);

  const namesById = useMemo(
    () => new Map(authors.map((author) => [author.authorId, author.displayName])),
    [authors],
  );
  const creditedIds = new Set(
    credits
      .filter((credit) => credit.kind === "registered")
      .map((credit) => (credit as { authorId: string }).authorId),
  );
  // Someone already credited is not offered again: a byline cannot name the same
  // person twice, and the save boundary would collapse it anyway.
  const selectable = authors.filter((author) => !creditedIds.has(author.authorId));
  const full = credits.length >= STORY_CREDITS_MAX;

  useEffect(() => {
    const index = pendingFocusIndex.current;
    if (index === null) return;
    pendingFocusIndex.current = null;
    if (index >= 0) rowRefs.current[index]?.focus();
    else customInputRef.current?.focus();
  }, [credits.length]);

  function labelFor(credit: StoryCredit): string {
    if (credit.kind === "custom") return credit.name;
    return (
      namesById.get(credit.authorId) ??
      credit.displayName ??
      "Author no longer listed"
    );
  }

  function commit(next: StoryCredit[], message: string) {
    onChange(next);
    setNotice(message);
  }

  function addRegistered() {
    const author = authors.find((option) => option.authorId === pickedAuthorId);
    if (!author) {
      setNotice("Choose a staff member first.");
      return;
    }
    if (full) {
      setNotice(`A byline can hold up to ${STORY_CREDITS_MAX} credits.`);
      return;
    }
    setPickedAuthorId("");
    commit(
      [...credits, { kind: "registered", authorId: author.authorId }],
      `${author.displayName} added to the byline.`,
    );
  }

  function addCustom() {
    const name = normalizeCustomCreditName(customDraft);
    if (name === "") {
      setNotice("Enter a credit first.");
      customInputRef.current?.focus();
      return;
    }
    if (full) {
      setNotice(`A byline can hold up to ${STORY_CREDITS_MAX} credits.`);
      return;
    }
    setCustomDraft("");
    commit([...credits, { kind: "custom", name }], `${name} added to the byline.`);
    customInputRef.current?.focus();
  }

  function removeAt(index: number) {
    const removed = labelFor(credits[index]);
    const next = credits.filter((_unused, position) => position !== index);
    pendingFocusIndex.current = next.length === 0 ? -1 : Math.min(index, next.length - 1);
    commit(next, `${removed} removed from the byline.`);
  }

  function move(index: number, offset: number) {
    const moved = labelFor(credits[index]);
    commit(
      moveStoryCredit(credits, index, offset),
      `${moved} moved to position ${index + offset + 1}.`,
    );
  }

  return (
    <div
      className="editor-list story-credits"
      role="group"
      aria-labelledby={labelId}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      tabIndex={invalid ? -1 : undefined}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
        if (normalizeCustomCreditName(customDraft) !== "") addCustom();
      }}
    >
      {credits.length === 0 ? (
        <p className="editor-field-help muted">No byline yet.</p>
      ) : (
        <ol className="story-credit-rows" aria-label="Byline, in order">
          {credits.map((credit, index) => (
            <li className="story-credit-row" key={`${storyCreditKey(credit)}-${index}`}>
              <span className="story-credit-name">{labelFor(credit)}</span>
              <span className="story-credit-kind muted">
                {credit.kind === "registered" ? "Staff" : "Custom credit"}
              </span>
              <span className="story-credit-controls">
                <ActionControl
                  action="move-up"
                  contextLabel={labelFor(credit)}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                />
                <ActionControl
                  action="move-down"
                  contextLabel={labelFor(credit)}
                  disabled={index === credits.length - 1}
                  onClick={() => move(index, 1)}
                />
                <ActionControl
                  action="remove-item"
                  label="Remove"
                  ref={(node) => {
                    rowRefs.current[index] = node;
                  }}
                  variant="ghost"
                  accessibleName={`Remove ${labelFor(credit)} from the byline`}
                  onClick={() => removeAt(index)}
                />
              </span>
            </li>
          ))}
        </ol>
      )}

      <div className="story-credit-entry">
        <Select
          id={`${fieldId}-staff`}
          aria-label="Add a staff byline"
          value={pickedAuthorId}
          disabled={full || selectable.length === 0}
          onChange={(event) => {
            setPickedAuthorId(event.target.value);
            if (notice) setNotice("");
          }}
        >
          <option value="">
            {authorsUnavailable
              ? "Staff list unavailable"
              : selectable.length === 0
                ? "No staff to add"
                : "Choose a staff member"}
          </option>
          {selectable.map((author) => (
            <option key={author.authorId} value={author.authorId}>
              {author.jobTitle
                ? `${author.displayName} — ${author.jobTitle}`
                : author.displayName}
            </option>
          ))}
        </Select>
        <ActionControl action="add-item" label="Add staff byline"
          disabled={full || pickedAuthorId === ""} onClick={addRegistered} />
      </div>

      <div className="story-credit-entry">
        {/* A raw input rather than the TextInput primitive: this control needs a
            ref to return focus after an add, and the primitive does not forward
            one. Same class, same appearance. */}
        <input
          ref={customInputRef}
          className="field-control"
          id={`${fieldId}-custom`}
          aria-label="Add a custom credit"
          placeholder="NJ PBS staff"
          autoComplete="off"
          value={customDraft}
          disabled={full}
          onChange={(event) => {
            setCustomDraft(event.target.value);
            if (notice) setNotice("");
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            addCustom();
          }}
        />
        <ActionControl action="add-item" label="Add custom credit" disabled={full} onClick={addCustom} />
      </div>

      {authorsUnavailable ? (
        <p className="editor-field-help muted">
          The staff list could not be loaded. You can still add custom credits.
        </p>
      ) : null}
      {full ? (
        <p className="editor-field-help muted">
          This byline is full at {STORY_CREDITS_MAX} credits.
        </p>
      ) : null}
      {notice ? (
        <p className="editor-field-help" role="status" aria-live="polite">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
