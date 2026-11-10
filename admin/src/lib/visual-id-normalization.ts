// Deterministic ids for a visual capture.
//
// React's useId mints ids of the form `:r7:`, and the counter is per React root and per
// mount order. Two runs of the same specimen usually agree, but a gallery page that mounts
// under StrictMode, or a specimen whose subtree suspends, can shift the counter -- and any
// id that reaches visible text, a CSS id selector, or a captured DOM snapshot then shifts
// with it. This rewrites every generated id, and every attribute that points at one, to a
// stable sequence in document order before the screenshot is taken.
//
// It runs against a captured specimen only. Nothing in the admin build calls it, and it
// changes attribute values rather than layout, so a normalized tree renders identically.

/** Attributes whose value is one id, or a space-separated id list. */
const ID_REFERENCE_ATTRIBUTES = [
  "aria-activedescendant",
  "aria-controls",
  "aria-describedby",
  "aria-details",
  "aria-errormessage",
  "aria-flowto",
  "aria-labelledby",
  "aria-owns",
  "for",
  "form",
  "headers",
  "list",
  "popovertarget",
] as const;

/** React's generated-id shape, both the useId form and the older `:rN:` variants. */
const GENERATED_ID = /^:[a-zA-Z0-9]*:$|^«[a-zA-Z0-9]+»$/;

export function isGeneratedId(value: string): boolean {
  return GENERATED_ID.test(value);
}

export interface NormalizeGeneratedIdsResult {
  /** How many distinct generated ids were rewritten. */
  replaced: number;
  /** The mapping applied, original id to stable id, in document order. */
  mapping: Record<string, string>;
}

/**
 * Rewrite every React-generated id under `root` to `vr-id-0`, `vr-id-1`, ... in document
 * order, updating the aria and form attributes that reference them. Ids the application
 * authored itself are left alone: they are already stable and a finding should be able to
 * cite them.
 */
export function normalizeGeneratedIds(
  root: ParentNode,
): NormalizeGeneratedIdsResult {
  const mapping: Record<string, string> = {};
  let next = 0;

  const stableId = (original: string): string => {
    const existing = mapping[original];
    if (existing) return existing;
    const replacement = `vr-id-${next}`;
    next += 1;
    mapping[original] = replacement;
    return replacement;
  };

  // Document order, so the numbering does not depend on which attribute happened to be
  // visited first.
  for (const element of Array.from(root.querySelectorAll<HTMLElement>("[id]"))) {
    const id = element.getAttribute("id");
    if (id && isGeneratedId(id)) element.setAttribute("id", stableId(id));
  }

  for (const element of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
    for (const attribute of ID_REFERENCE_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      const tokens = value.split(/\s+/).filter(Boolean);
      if (!tokens.some(isGeneratedId)) continue;
      const rewritten = tokens
        .map((token) => (isGeneratedId(token) ? stableId(token) : token))
        .join(" ");
      element.setAttribute(attribute, rewritten);
    }
  }

  return { replaced: next, mapping };
}
