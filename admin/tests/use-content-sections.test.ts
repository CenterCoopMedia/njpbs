// The live section registry the create form and the grant picker read (#845).
//
// The registry's meaning is document existence: the server accepts a section name only if
// the `sections` collection holds a document keyed by it. A picker that trusts a payload
// `id` field instead can offer a desk nobody is registered for, and the person choosing it
// gets a refused save with nothing on screen explaining why.

import { describe, expect, it } from "vitest";
import { parseContentSectionSnapshot } from "../src/lib/use-content-sections";

const doc = (id: string, data: unknown) => ({ id, data: () => data });

const wellFormed = (label: string, order: number) => ({
  label,
  description: `Pages in the ${label.toLowerCase()} desk.`,
  order,
});

describe("parseContentSectionSnapshot", () => {
  it("keys every desk by its document id", () => {
    expect(
      parseContentSectionSnapshot([doc("watch", wellFormed("Watch", 1))]),
    ).toEqual([
      { id: "watch", label: "Watch", description: "Pages in the watch desk.", order: 1 },
    ]);
  });

  it("ignores a payload id that disagrees with the document id", () => {
    // The document id is what the server registered. A payload id winning here would offer
    // "everything" as a choosable desk while only "watch" is registered.
    const [entry] = parseContentSectionSnapshot([
      doc("watch", { ...wellFormed("Watch", 1), id: "everything" }),
    ]);
    expect(entry.id).toBe("watch");
  });

  it("keeps a payload id that agrees with the document id", () => {
    // The seed writes both, so the ordinary row must not become a casualty of the check.
    const [entry] = parseContentSectionSnapshot([
      doc("support", { ...wellFormed("Support", 2), id: "support" }),
    ]);
    expect(entry).toEqual({
      id: "support",
      label: "Support",
      description: "Pages in the support desk.",
      order: 2,
    });
  });

  it("drops a row the parser rejects rather than offering it unlabelled", () => {
    expect(
      parseContentSectionSnapshot([
        doc("watch", wellFormed("Watch", 1)),
        doc("broken", { label: "", order: 2 }),
        doc("also-broken", "not an object"),
      ]).map((entry) => entry.id),
    ).toEqual(["watch"]);
  });

  it("returns the desks in registry display order", () => {
    expect(
      parseContentSectionSnapshot([
        doc("station", wellFormed("Station", 3)),
        doc("watch", wellFormed("Watch", 1)),
        doc("support", wellFormed("Support", 2)),
      ]).map((entry) => entry.id),
    ).toEqual(["watch", "support", "station"]);
  });
});
