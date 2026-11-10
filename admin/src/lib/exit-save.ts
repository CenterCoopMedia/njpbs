// What a save asked for during an exit actually settled as.
//
// A boolean was not enough. The workspace deliberately keeps a draft per surface so moving
// between editors inside /content/** preserves work (#579), but only the surface that is
// currently mounted has an editor to save through. So a save during an exit has three real
// outcomes, not two: it landed and nothing is outstanding; it did not land; or it landed for
// this surface while other work from the same session is still only in the browser. Collapsing
// the third into "saved" is how a person who clicked SAVE loses a draft (#1032).
export type ExitSaveOutcome =
  | { status: "saved" }
  | { status: "failed" }
  | { status: "unsaved-elsewhere"; items: string[] };

// Past this many, a list stops informing and starts being a wall of names.
const MAX_NAMED_ITEMS = 4;

const WHAT_TO_DO = "or discard it and leave.";

/**
 * The sentence shown when a save landed but other work from this session did not. It names the
 * outstanding items so the person can go and save them, rather than reporting a count they
 * cannot act on. Absent names (a surface with no label to give) still produces a true sentence.
 */
export function describeUnsavedElsewhere(items: readonly string[]): string {
  if (items.length === 0) {
    return `Some of this session's work is still unsaved. Open it to save that work, ${WHAT_TO_DO}`;
  }
  if (items.length > MAX_NAMED_ITEMS) {
    return `${items.length} other items still have unsaved changes. Open each one to save that work, ${WHAT_TO_DO}`;
  }
  if (items.length === 1) {
    return `${items[0]} still has unsaved changes. Open it to save that work, ${WHAT_TO_DO}`;
  }
  const named =
    items.length === 2
      ? `${items[0]} and ${items[1]}`
      : `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
  return `${named} still have unsaved changes. Open each one to save that work, ${WHAT_TO_DO}`;
}
