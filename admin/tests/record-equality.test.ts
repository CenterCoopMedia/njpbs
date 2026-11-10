import { describe, expect, it } from "vitest";
import { recordsEqual } from "../src/lib/record-equality";

// The draft contract asks whether a form holds unsaved work (#579). Identity cannot answer it,
// because every edit replaces the record object; these are the cases where identity and content
// disagree, and the ones where a sloppy content compare would answer wrongly.
describe("recordsEqual", () => {
  it("reads a rebuilt record with the same content as equal", () => {
    const saved = { name: "Acme", website: "https://acme.org" };
    expect(recordsEqual(saved, { ...saved })).toBe(true);
  });

  it("reads a changed field as different", () => {
    expect(recordsEqual({ name: "Acme" }, { name: "Acme Inc" })).toBe(false);
  });

  it("ignores the order the fields were written in", () => {
    // `seedRecord` spreads `initial` and then appends the defaults a record omits, so a restored
    // draft and a freshly seeded record can hold the same fields in a different order.
    expect(recordsEqual({ name: "Acme", role: "Sponsor" }, { role: "Sponsor", name: "Acme" })).toBe(true);
  });

  it("compares stored rich text by content", () => {
    const body = () => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] });
    expect(recordsEqual({ bio: body() }, { bio: body() })).toBe(true);
    const edited = body();
    edited.content[0]!.content![0]!.text = "ho";
    expect(recordsEqual({ bio: body() }, { bio: edited })).toBe(false);
  });

  it("separates an absent field from one holding a different value", () => {
    expect(recordsEqual({ name: "Acme" }, { name: "Acme", role: "Sponsor" })).toBe(false);
  });

  it("reads a field holding the sentinel's own text as a plain string", () => {
    // The undefined sentinel is bare; a string value serializes with its quotes, so an editor who
    // types the sentinel into a field cannot make a filled field read as an empty one.
    expect(recordsEqual({ name: "?" }, { name: undefined })).toBe(false);
  });

  it("reads an absent field and one written back as undefined as the same field", () => {
    // An optional field a person never filled in (image.caption, embed.caption,
    // headline.level) is absent on the loaded block. Typing into it and undoing writes the
    // prior value back, and the prior value is undefined. If that own key changed the
    // encoding, the reverted draft would no longer match the content it was loaded from, so
    // the workspace would keep the draft and skip the re-read that shows newer server
    // content -- a revert that silently costs someone else's change.
    expect(recordsEqual({ alt: "a" }, { alt: "a", caption: undefined })).toBe(true);
    expect(recordsEqual({ alt: "a", caption: undefined }, { alt: "a" })).toBe(true);
    // Nested, since block data holds lists of item records.
    expect(
      recordsEqual({ items: [{ title: "t" }] }, { items: [{ title: "t", body: undefined }] }),
    ).toBe(true);
    // A field that actually holds a value still differs from an absent one.
    expect(recordsEqual({ alt: "a" }, { alt: "a", caption: "" })).toBe(false);
  });

  it("tells two instants apart", () => {
    // Sorting the keys of a Date would compare its enumerable own properties, of which it has
    // none, so every Date would canonicalize to the same empty map and two instants would read as
    // equal. That is the direction that loses work: a false "equal" reports the form clean and
    // drops the draft.
    const a = { at: new Date("2026-07-01T00:00:00.000Z") };
    const b = { at: new Date("2027-04-26T00:00:00.000Z") };
    expect(recordsEqual(a, b)).toBe(false);
    expect(recordsEqual(a, { at: new Date("2026-07-01T00:00:00.000Z") })).toBe(true);
  });
});
