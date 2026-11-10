// Whether two records hold the same content.
//
// The draft contract (#579) asks whether a form holds unsaved work, and `setField` replaces the
// record object on every edit, so identity cannot answer it: a field typed and typed back leaves a
// new object holding the old content. Identity calls that unsaved work, and stashing it hands the
// next mount a record that already carries its server id, so the save after that updates the saved
// document instead of creating a new one.
//
// The domain is the editor's own JSON: primitives from text, number, and choice fields, and stored
// TipTap documents from rich text. Nothing else reaches a record's fields.
//
// This is deliberately not `audit-diff.core.ts`'s comparison. That one lives in the site app and
// compares Firestore snapshots, whose values include the Date that normalized Timestamps produce;
// this one compares a form's live record inside the admin. They agree in approach and answer
// different questions over different value sets.
export function recordsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return canonical(a) === canonical(b);
}

// Only a plain object is walked as a map. Sorting the keys of anything else would compare its
// enumerable own properties and nothing else -- every Date would canonicalize to `{}`, so two
// different instants would read as equal. That is the direction that loses work: a false "equal"
// reports the form clean and drops the draft. Anything exotic falls through to JSON.stringify,
// which asks the value how it serializes (a Date answers with its instant).
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

// A stable string for a value: same content in, same string out. Keys are sorted so two records
// holding the same fields compare equal whatever order they were written in.
function canonical(value: unknown): string {
  // A field that is absent and one that is present holding undefined are the same field to an
  // editor, and JSON.stringify drops both, so they have to share an encoding. The sentinel cannot
  // be forged by a string value: JSON.stringify quotes strings, so the field value "?" encodes as
  // `"?"` with its quotes and never collides with the bare sentinel.
  if (value === undefined) return "?";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isPlainObject(value)) {
    // Skip keys holding undefined rather than encoding them with the sentinel. The sentinel
    // above only fires where the walk reaches a value, which needs the key to be in
    // Object.keys; an absent key is never walked, so on its own it cannot make the two forms
    // agree. Dropping the key is what actually lets `{}` and `{ caption: undefined }` share an
    // encoding, which is the promise this function makes: an optional field a person never
    // filled in and one written back as undefined are the same field to an editor. Without
    // this, an edit to an absent optional field (image.caption, embed.caption, headline.level)
    // that is then undone leaves a draft that no longer matches the content it was loaded
    // from, so the workspace keeps the reverted draft and skips the re-read that would show
    // newer server content.
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  // A numeric field kind would need handling before this line: JSON.stringify(NaN) is "null", so
  // a NaN would encode equal to an explicit null and report a changed field clean. No kind on
  // EditorField produces a number today.
  return JSON.stringify(value) ?? "null";
}
