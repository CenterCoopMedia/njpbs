import { contentLinkError } from "./content-link.ts";
// Author-facing field validation for the editor UI. The core (editor-admin.ts) owns block
// placement and save-time structural validity; this owns required-field completeness and
// the shared renderer's URL policy, which forms surface inline before a save. Pure, so the
// record forms and the block editor share it and it is unit-tested without React.

import type { EditorField } from "./editor-admin";
import {
  isRichTextDoc,
  isSafeHref,
  type RichTextDoc,
  type RichTextNode,
} from "./content-model";
import { isCalendarDay } from "./editorial-dates";
import {
  instantToStationLocal,
  stationLocalToInstant,
} from "./station-time";
import { richTextIsEmpty } from "./content-model";
import { readFieldValue } from "./field-path";
import { isExactHttpsUrl } from "./exact-https-url.ts";

// Whether a field carries a real value for its kind. A toggle is always answered; a
// rich-text body must hold visible text, not just an empty paragraph; a list must have at
// least one item; a scheduling instant must be one the control can show; everything else
// must be a non-blank string.
export function isFieldFilled(field: EditorField, value: unknown): boolean {
  switch (field.kind) {
    // Read a datetime through the same projection the control uses, so a value the
    // control renders as blank is not simultaneously reported as filled. A legacy
    // event holds "2026-08-01" in startsAt, which is a non-blank string and would
    // otherwise satisfy required while the editor stares at an empty field with no
    // message next to it (#509).
    case "datetime":
      return instantToStationLocal(value) !== "";
    case "toggle":
      return true;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "richText":
      return isRichTextDoc(value) && !richTextIsEmpty(value as RichTextDoc);
    case "list":
    // A byline is filled when it holds at least one credit (#1040). It is an
    // optional field today, so this only decides whether a "no byline yet" state
    // counts as answered, never whether a post can be saved.
    case "storyCredits":
      return Array.isArray(value) && value.length > 0;
    // A select whose options are declared is filled only by one of them. A select with NO
    // declared option list has its choices supplied by the surface that renders it (the
    // dynamic-shelf pin pickers, filtered to the block's chosen source), so completeness
    // falls back to "holds something", the same reading every other field gets.
    case "select":
      return field.options
        ? field.options.some((option) => Object.is(option.value, value))
        : typeof value === "string" && value.trim().length > 0;
    default:
      return typeof value === "string" && value.trim().length > 0;
  }
}

// Whether a field holds anything at all, counting whitespace a `isFieldFilled` check would
// discard. Only the released-field rule needs this stricter reading; completeness keeps the
// forgiving one, because "   " is not a description.
function fieldHasAnyValue(field: EditorField, value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  return isFieldFilled(field, value);
}

// Whether a descriptor's `required` flag still applies given the rest of the record. A
// `requiredWhen` field applies only once the sibling it names holds a value. A
// `requiredUnless` field is released while the sibling toggle it names is on, which is how
// an image marked decorative keeps the empty alt text WCAG 1.1.1 asks for.
export function fieldIsRequired(
  field: EditorField,
  siblings: Record<string, unknown>,
): boolean {
  if (!field.required) return false;
  return conditionApplies(field, siblings);
}

// Whether a `recommended` field applies given the rest of the record. It shares the
// required gates, so a lead image's alt text is asked for only once an image is chosen
// and never while the image is marked decorative.
export function fieldIsRecommended(
  field: EditorField,
  siblings: Record<string, unknown>,
): boolean {
  if (!field.recommended) return false;
  return conditionApplies(field, siblings);
}

function conditionApplies(
  field: EditorField,
  siblings: Record<string, unknown>,
): boolean {
  if (
    field.requiredWhen &&
    isBlank(readFieldValue(siblings, { ...field, key: field.requiredWhen }))
  ) {
    return false;
  }
  return !releaseIsOn(field, siblings);
}

// Whether the sibling toggle a `requiredUnless` names is on. Read through the field's own
// path, not off the top of the record, because a descriptor in a metadata group (the SEO
// fields carry `path: ["seo"]`) has its siblings one level down. A flat read there would
// find nothing, silently keep the field required, and look like the escape simply failed.
function releaseIsOn(field: EditorField, siblings: Record<string, unknown>): boolean {
  if (!field.requiredUnless) return false;
  return readFieldValue(siblings, { ...field, key: field.requiredUnless }) === true;
}

// The message for a released field the editor filled in anyway. Marking an image decorative
// and describing it are opposite claims, and the model parser refuses the pair, so this is
// reported against the field rather than left to surface later as a page-wide format error.
// Reported rather than resolved, because dropping either claim would hide the mistake.
//
// Untrimmed on purpose. `isFieldFilled` reads "   " as empty, but the parser wants a
// released text field to hold exactly "", so a trimming check here would pass a page the
// save boundary then refuses with a generic error naming no field.
export function releasedFieldContradiction(
  field: EditorField,
  value: unknown,
  context: FieldValidationContext = {},
): string | null {
  if (!field.requiredUnless) return null;
  if (!releaseIsOn(field, context.siblings ?? {})) return null;
  if (!fieldHasAnyValue(field, value)) return null;
  const release = context.fields?.find((other) => other.key === field.requiredUnless);
  return `${field.label} must be empty while ${release ? release.label : field.requiredUnless} is on.`;
}

// The required fields an editor has left empty, in descriptor order, so a form can mark
// each one and refuse the save. An optional or released field is never reported.
export function missingRequiredFields(
  fields: readonly EditorField[],
  values: Record<string, unknown>,
): EditorField[] {
  return fields.filter(
    (field) => fieldIsRequired(field, values) && !isFieldFilled(field, readFieldValue(values, field)),
  );
}

const SAFE_URL_MESSAGE = "must use http, https, mailto, tel, or a relative link.";

// A saved/imported TipTap document can predate the editor's safe-link tool. Walk every
// node because link marks live on inline text at arbitrary depth, and reject exactly what
// renderRichText would later strip. Structurally invalid rich text remains the model
// parser's concern; this helper answers only the renderer-policy question.
export function richTextHasUnsafeLink(value: unknown): boolean {
  if (!isRichTextDoc(value)) return false;
  const nodeHasUnsafeLink = (node: RichTextNode): boolean =>
    Boolean(
      node.marks?.some(
        (mark) => mark.type === "link" && !isSafeHref(mark.attrs?.href),
      ) ||
      node.content?.some(nodeHasUnsafeLink),
    );
  return nodeHasUnsafeLink(value);
}

export interface FieldValidationContext {
  // Draft saves may preserve incomplete authoring work. This relaxes only completeness;
  // malformed values and unsafe content still fail at the same boundary.
  allowIncomplete?: boolean;
  // The record or block data the field lives in, so a `requiredUnless` escape can read the
  // sibling toggle it names. Omitted, a field with an escape stays plainly required, which
  // is the safe reading for a caller that has no record to consult.
  siblings?: Record<string, unknown>;
  // The sibling descriptors, used only to name the releasing toggle in a message.
  fields?: readonly EditorField[];
}

// Whether a value is an omission rather than an answer. A select and a URL both treat an
// absent value as a deliberate skip, and the datetime check below has to tell "not set" apart
// from "set to something unreadable", so all three read blankness the same way.
function isBlank(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim().length === 0)
  );
}

// How much of an unreadable stored value is worth quoting back. A legacy bare day is ten
// characters; anything much longer is a value that arrived from somewhere else entirely, and
// a message is still a sentence an editor has to read.
const STORED_VALUE_QUOTE_LIMIT = 40;

/**
 * What a datetime field is holding when the control cannot show it, said in the editor's own
 * terms and quoting the stored text.
 *
 * The control renders blank for these values, so without this the record and the widget
 * disagree in silence: an event stored with a bare "2026-08-01" looks like an event with no
 * end time, and the next save replaces it without anyone deciding to (#850). Quoting the raw
 * text is the part that makes the state legible — "cannot be read" alone leaves an editor
 * unable to tell an unreadable value from an empty field.
 *
 * Null for a blank field, a readable instant, and any field that is not a datetime.
 */
export function unreadableDatetimeMessage(
  field: EditorField,
  value: unknown,
): string | null {
  if (field.kind !== "datetime") return null;
  if (isBlank(value) || instantToStationLocal(value) !== "") return null;
  const tail = "which is not a date and time this control can show. Clear it or set a new one.";
  if (typeof value !== "string") {
    // A Firestore Timestamp that reached the form unnormalized, or anything else with no text
    // to quote. Printing it would give the editor "[object Object]" to puzzle over.
    return `${field.label} holds a value that is not a date and time this control can show. Clear it or set a new one.`;
  }
  const stored =
    value.length > STORED_VALUE_QUOTE_LIMIT
      ? `${value.slice(0, STORED_VALUE_QUOTE_LIMIT)}…`
      : value;
  return `${field.label} holds "${stored}", ${tail}`;
}

/**
 * What a datetime control is showing when the text in it has not become an instant.
 *
 * A browser reports a `datetime-local` value only once every segment is filled, so
 * "0202-08-01T13:00" is a complete value the control emits while an editor is still typing
 * the year. It converts to nothing, the control keeps showing it on purpose, and the record
 * keeps its previous instant. Without this the form validates the old value and reports
 * Saved while the editor is looking at different text (#850).
 *
 * Null for an empty draft (clearing is a real intent) and for one that converts.
 */
export function unfinishedDatetimeDraftMessage(
  field: EditorField,
  draft: string,
): string | null {
  if (draft === "" || stationLocalToInstant(draft) !== null) return null;
  return `${field.label} is not a complete date and time yet. Finish it or clear it before saving.`;
}

// One plain-language refusal for a descriptor value. Required-field completeness stays
// first so an empty required field says what the editor needs to do ("is required").
// Plain URL fields and link marks inside rich text then reuse the renderer's canonical href
// policy, so the authoring surface and public output cannot disagree about which links
// survive. An optional blank URL remains a deliberate omission.
export function editorFieldValidationMessage(
  field: EditorField,
  value: unknown,
  context: FieldValidationContext = {},
): string | null {
  const siblings = context.siblings ?? {};
  if (field.key === "contentLinkUrl") return contentLinkError(siblings);
  const contradiction = releasedFieldContradiction(field, value, context);
  if (contradiction) return contradiction;
  if (
    field.kind === "select" &&
    field.options !== undefined &&
    !isBlank(value) &&
    !field.options.some((option) => Object.is(option.value, value))
  ) {
    return `${field.label} must use one of the available choices.`;
  }
  // A capped list, named in the editor's own terms. Without this the seventh pin on a
  // dynamic shelf reached the parser, which refuses the whole block with a message that
  // names no limit and no field (#1046).
  if (
    !context.allowIncomplete &&
    field.kind === "list" &&
    typeof field.minItems === "number" &&
    Array.isArray(value) &&
    value.length < field.minItems
  ) {
    return `${field.label} must contain at least ${field.minItems}. Add ${field.minItems - value.length} to save.`;
  }
  if (
    field.kind === "list" &&
    typeof field.maxItems === "number" &&
    Array.isArray(value) &&
    value.length > field.maxItems
  ) {
    return `${field.label} can hold at most ${field.maxItems}. Remove ${value.length - field.maxItems} to save.`;
  }
  // A datetime the control cannot read, before the required check, because "is required"
  // is the wrong thing to tell an editor here. The record holds a value; it just is not an
  // instant, so the control shows nothing and a save replaces it. Read as "never set", the
  // message gives no reason to expect anything is being overwritten. Optional fields need
  // this most: `endsAt` is not required, so nothing else in this function ever looks at it,
  // and a legacy bare "2026-08-01" would otherwise survive an unrelated edit unmentioned.
  const unreadableDatetime = unreadableDatetimeMessage(field, value);
  if (unreadableDatetime) return unreadableDatetime;
  if (field.kind === "number" && !isBlank(value)) {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return `${field.label} must be a whole number.`;
    }
    if (typeof field.min === "number" && value < field.min) {
      return `${field.label} must be at least ${field.min}.`;
    }
    if (typeof field.max === "number" && value > field.max) {
      return `${field.label} can be at most ${field.max}.`;
    }
    const pairedValue = field.aspectRatioWith
      ? siblings[field.aspectRatioWith]
      : undefined;
    if (
      typeof pairedValue === "number"
      && typeof field.minAspectRatio === "number"
      && typeof field.maxAspectRatio === "number"
      && (value / pairedValue < field.minAspectRatio || value / pairedValue > field.maxAspectRatio)
    ) {
      const pairedLabel = context.fields?.find(candidate => candidate.key === field.aspectRatioWith)?.label
        ?? field.aspectRatioWith;
      return `${field.label} and ${pairedLabel} must use a video ratio from 9:16 through 21:9.`;
    }
  }
  if (
    !context.allowIncomplete &&
    fieldIsRequired(field, siblings) &&
    !isFieldFilled(field, value)
  ) {
    return `${field.label} is required.`;
  }
  if (field.kind === "richText" && richTextHasUnsafeLink(value)) {
    return `${field.label} contains a link that ${SAFE_URL_MESSAGE}`;
  }
  if (field.kind === "date" && !isBlank(value) && !isCalendarDay(value)) {
    return `${field.label} must be a real calendar day.`;
  }
  if (
    typeof field.maxLength === "number" &&
    typeof value === "string" &&
    value.length > field.maxLength
  ) {
    return `${field.label} can be at most ${field.maxLength} characters. Shorten it to save.`;
  }
  if (field.kind !== "url") return null;

  if (field.requireHttps && value !== "" && !isExactHttpsUrl(value, field.maxLength)) {
    return `${field.label} must be a secure HTTPS link.`;
  }

  if (field.key === "signupUrl" && !isBlank(value)) {
    try {
      const url = new URL(String(value));
      if (url.protocol !== "https:" || !url.hostname || url.username || url.password || /[\u0000-\u001F\u007F]/.test(String(value))) {
        return `${field.label} must be a secure HTTPS link.`;
      }
    } catch { return `${field.label} must be a secure HTTPS link.`; }
  }

  if (!isBlank(value) && !isSafeHref(value)) {
    return `${field.label} ${SAFE_URL_MESSAGE}`;
  }
  if (
    !context.allowIncomplete &&
    field.namedBy &&
    !isBlank(value) &&
    field.namedBy.every((key) => isBlank(readFieldValue(siblings, { ...field, key })))
  ) {
    const names = field.namedBy.map(
      (key) => context.fields?.find((other) => other.key === key)?.label.toLowerCase() ?? key,
    );
    return `${field.label} needs ${names.join(" or ")} to name it for screen readers.`;
  }
  return null;
}

export interface EditorFieldValidationError {
  field: EditorField;
  message: string;
}

// Every invalid top-level descriptor in catalog order. The record form uses the field
// identity to attach each message to its control; keeping the message beside it avoids
// rebuilding validation wording in the component.
export function invalidEditorFields(
  fields: readonly EditorField[],
  values: Record<string, unknown>,
  context: FieldValidationContext = {},
): EditorFieldValidationError[] {
  const errors: EditorFieldValidationError[] = [];
  for (const field of fields) {
    const message = editorFieldValidationMessage(field, readFieldValue(values, field), {
      ...context,
      siblings: values,
      fields,
    });
    if (message) errors.push({ field, message });
  }
  return errors;
}

// Editor-facing messages for everything a block leaves incomplete or invalid: its own
// descriptor fields, plus the sub-fields of every item already added to a list (a gallery
// image with no alt text, a button with an unsafe link). The core's `validateSection`
// guards a page's structure -- placement, caps, ids -- but not whether a placed block is
// ready to publish, so the block save boundary uses this to refuse a misleading "saved"
// result. Empty, in order, means the block is ready to save.
export function missingBlockContent(
  fields: readonly EditorField[],
  data: Record<string, unknown>,
  context: FieldValidationContext = {},
): string[] {
  return walkBlockFields(fields, data, editorFieldValidationMessage, context);
}

// The subset of the above that still applies to a hidden block. Completeness does not: a
// hidden block publishes nothing, so an empty required field gates nothing either. A
// contradiction does, because it is a shape `parseBlocks` refuses, and exempting it turns a
// fixable field error into a page-wide format refusal that names no block -- pointing at
// the one card the editor is least likely to reopen.
// The warning for an empty recommended field. It never refuses a save or publish.
export function recommendedFieldWarning(
  field: EditorField,
  value: unknown,
  context: FieldValidationContext = {},
): string | null {
  if (!fieldIsRecommended(field, context.siblings ?? {})) return null;
  if (isFieldFilled(field, value)) return null;
  return `${field.label} is empty. You can save and publish, but describe the image or mark it decorative when you can.`;
}

export function missingRecommendedContent(
  fields: readonly EditorField[],
  data: Record<string, unknown>,
): string[] {
  return walkBlockFields(fields, data, recommendedFieldWarning);
}

export function contradictedBlockContent(
  fields: readonly EditorField[],
  data: Record<string, unknown>,
): string[] {
  return walkBlockFields(fields, data, releasedFieldContradiction);
}

function walkBlockFields(
  fields: readonly EditorField[],
  data: Record<string, unknown>,
  messageFor: (
    field: EditorField,
    value: unknown,
    context: FieldValidationContext,
  ) => string | null,
  context: FieldValidationContext = {},
): string[] {
  const messages: string[] = [];
  for (const field of fields) {
    const message = messageFor(field, readFieldValue(data, field), {
      ...context,
      siblings: data,
      fields,
    });
    if (message) messages.push(message);
  }
  for (const field of fields) {
    if (field.kind !== "list" || !field.itemFields) continue;
    const items = Array.isArray(data[field.key]) ? (data[field.key] as unknown[]) : [];
    items.forEach((item, index) => {
      const itemData = (item ?? {}) as Record<string, unknown>;
      for (const sub of field.itemFields!) {
        const message = messageFor(sub, readFieldValue(itemData, sub), {
          ...context,
          siblings: itemData,
          fields: field.itemFields,
        });
        if (message) messages.push(`${field.label} ${index + 1}: ${message}`);
      }
    });
  }
  return messages;
}
