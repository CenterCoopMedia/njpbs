import { describe, expect, it } from "vitest";
import { type AuditDiff, diffStates, type FieldChange, type Json } from "../src/lib/audit-diff.core";

// Helper: the set of paths a diff touches, sorted (the diff already sorts, but assert it).
function paths(d: AuditDiff): string[] {
  return d.changes.map((c) => c.path);
}
function byPath(d: AuditDiff, path: string): FieldChange | undefined {
  return d.changes.find((c) => c.path === path);
}

describe("audit diff core", () => {
  it("a create (before null) records every field as added (AC: create is logged with a diff)", () => {
    const d = diffStates(null, { title: "Newark at dusk", status: "draft" });
    expect(paths(d)).toEqual(["status", "title"]); // sorted by path
    expect(byPath(d, "title")).toEqual({ path: "title", kind: "added", after: "Newark at dusk" });
  });

  it("a delete (after null) records every field as removed (AC: delete is logged with a diff)", () => {
    const d = diffStates({ title: "Newark at dusk", status: "published" }, null);
    expect(paths(d)).toEqual(["status", "title"]);
    expect(byPath(d, "status")).toEqual({ path: "status", kind: "removed", before: "published" });
  });

  it("an edit reports only the changed field, not the unchanged ones (AC: edit diff)", () => {
    const d = diffStates(
      { title: "Newark at dusk", status: "draft" },
      { title: "Newark at dusk", status: "published" },
    );
    expect(paths(d)).toEqual(["status"]);
    expect(byPath(d, "status")).toEqual({ path: "status", kind: "changed", before: "draft", after: "published" });
  });

  it("recurses into nested objects and reports the leaf that changed with a dotted path", () => {
    const d = diffStates(
      { seo: { description: "old", title: "t" } },
      { seo: { description: "new", title: "t" } },
    );
    expect(paths(d)).toEqual(["seo.description"]);
    expect(byPath(d, "seo.description")).toEqual({
      path: "seo.description",
      kind: "changed",
      before: "old",
      after: "new",
    });
  });

  it("reports a whole added subtree as one change, not one per leaf (minimal discriminating shape)", () => {
    const d = diffStates({}, { seo: { description: "d", title: "t" } });
    expect(paths(d)).toEqual(["seo"]);
    expect(byPath(d, "seo")).toEqual({ path: "seo", kind: "added", after: { description: "d", title: "t" } });
  });

  it("treats a type change (object to scalar) as a single leaf change, not a recurse", () => {
    const d = diffStates({ seo: { description: "d" } }, { seo: "none" });
    expect(paths(d)).toEqual(["seo"]);
    expect(byPath(d, "seo")).toEqual({ path: "seo", kind: "changed", before: { description: "d" }, after: "none" });
  });

  it("is invariant to object key order (no spurious change from a re-serialized document)", () => {
    const d = diffStates({ a: 1, b: 2 }, { b: 2, a: 1 });
    expect(d.changes).toEqual([]);
  });

  it("compares arrays as opaque values, reporting a differing array as one changed field", () => {
    const d = diffStates({ tags: ["city", "hero"] }, { tags: ["city", "night"] });
    expect(paths(d)).toEqual(["tags"]);
    expect(byPath(d, "tags")).toEqual({
      path: "tags",
      kind: "changed",
      before: ["city", "hero"],
      after: ["city", "night"],
    });
  });

  it("records a permission grant change as a changed field (AC: permission change is logged)", () => {
    // #193 stores grants as a list of {role, sections?} tuples, not a flat role array.
    const d = diffStates({ grants: [{ role: "editor" }] }, { grants: [{ role: "editor" }, { role: "publisher" }] });
    expect(byPath(d, "grants")).toEqual({
      path: "grants",
      kind: "changed",
      before: [{ role: "editor" }],
      after: [{ role: "editor" }, { role: "publisher" }],
    });
  });

  it("a grant reorder is a false change unless the caller normalizes the grant list (permission-change guidance)", () => {
    // #193 grants are {role, sections?} tuples; the list and each sections array are both sets.
    const grant = (role: string, sections?: string[]): Json => (sections ? { role, sections } : { role });
    const before: Json = { grants: [grant("editor", ["news", "arts"]), grant("viewer")] };
    const reordered: Json = { grants: [grant("viewer"), grant("editor", ["arts", "news"])] };
    // The core compares arrays by position, so a bare reorder of the same grants shows as changed...
    expect(diffStates(before, reordered).changes).toHaveLength(1);
    // ...which is why the permission-change path normalizes: sort each grant's sections, then the list.
    const normalizeGrants = (state: Json): Json => {
      const grants = (state as { grants: Json[] }).grants;
      // Sort each grant's sections, then order the grants by a key-order-insensitive canonical
      // key, so two grant lists that differ only in object key order or list order canonicalize
      // the same. A plain JSON.stringify sort key is insertion-order sensitive, so a re-keyed
      // {sections, role} would sort differently from {role, sections} and read as a false change.
      // Production should share the core's `canonical` here rather than re-derive it; this inline
      // key sorts object keys to stand in for it.
      const canonicalKey = (g: Json): string => {
        const rec = g as Record<string, Json>;
        return Object.keys(rec)
          .sort()
          .map((k) => `${k}=${JSON.stringify(rec[k])}`)
          .join("&");
      };
      const normed = grants
        .map((g) => {
          const rec = g as Record<string, Json>;
          const sections = rec.sections;
          return Array.isArray(sections) ? { ...rec, sections: [...sections].sort() } : rec;
        })
        .sort((a, b) => canonicalKey(a).localeCompare(canonicalKey(b)));
      return { grants: normed };
    };
    expect(diffStates(normalizeGrants(before), normalizeGrants(reordered)).changes).toEqual([]);
  });

  it("yields an empty diff for an event with no content state, such as a login (both null)", () => {
    expect(diffStates(null, null).changes).toEqual([]);
  });

  it("sorts a multi-field diff by path so the recorded diff is deterministic", () => {
    const d = diffStates(
      { alpha: 1, zeta: 1, mid: 1 },
      { alpha: 2, zeta: 2, mid: 2, added: 9 },
    );
    expect(paths(d)).toEqual(["added", "alpha", "mid", "zeta"]);
  });

  it("rejects a non-object, non-null document state rather than guessing", () => {
    expect(() => diffStates(42 as unknown as null, {})).toThrow();
  });

  it("compares Date fields by instant, so a timestamp change is recorded and a re-read is not", () => {
    // #196 normalizes Firestore Timestamps to Date and feeds this core the same snapshots, so a
    // Date must be a leaf compared by its instant, not walked as an empty object. Date is part of
    // the Json snapshot type, so these need no cast.
    const t1 = new Date("2026-07-08T14:00:00.000Z");
    const t2 = new Date("2026-07-08T15:30:00.000Z");
    expect(diffStates({ publishAt: t1 }, { publishAt: t2 }).changes).toHaveLength(1);
    const sameInstant = new Date("2026-07-08T14:00:00.000Z");
    expect(diffStates({ publishAt: t1 }, { publishAt: sameInstant }).changes).toEqual([]);
  });

  it("keeps non-finite numbers distinct from null and from each other (no dropped change)", () => {
    // JSON.stringify(NaN) is "null", so an unguarded canonical form would hide null -> NaN.
    expect(diffStates({ n: null }, { n: NaN as unknown as Json }).changes).toHaveLength(1);
    expect(
      diffStates({ n: Infinity as unknown as Json }, { n: -Infinity as unknown as Json }).changes,
    ).toHaveLength(1);
    expect(diffStates({ n: NaN as unknown as Json }, { n: NaN as unknown as Json }).changes).toEqual([]);
  });
});
