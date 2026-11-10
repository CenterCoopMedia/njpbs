import { describe, it, expect } from "vitest";
import { blocksEqual } from "../src/lib/block-equality";
import { createBlock } from "../src/lib/block-factory";
import type { AdminBlock } from "../src/lib/block-factory";

describe("blocksEqual", () => {
  it("treats a list as equal to itself", () => {
    const list = [createBlock("headline", "h1"), createBlock("divider", "d1", 1)];
    expect(blocksEqual(list, list)).toBe(true);
  });

  it("treats two distinct arrays with the same content as equal (#595)", () => {
    // The page reducer replaces the array on every op, so a block added and then undone leaves a
    // new array holding the loaded content. That is not unsaved work.
    const loaded = [createBlock("headline", "h1")];
    const reverted = [createBlock("headline", "h1")];
    expect(loaded).not.toBe(reverted);
    expect(blocksEqual(loaded, reverted)).toBe(true);
  });

  it("distinguishes a real data edit", () => {
    const a = [createBlock("headline", "h1")];
    const b: AdminBlock[] = [{ ...createBlock("headline", "h1"), data: { text: "Tonight" } }];
    expect(blocksEqual(a, b)).toBe(false);
  });

  it("distinguishes a visibility change", () => {
    const a = [createBlock("headline", "h1")];
    const b: AdminBlock[] = [{ ...createBlock("headline", "h1"), visible: false }];
    expect(blocksEqual(a, b)).toBe(false);
  });

  it("distinguishes a different length", () => {
    const a = [createBlock("headline", "h1")];
    const b = [createBlock("headline", "h1"), createBlock("divider", "d1", 1)];
    expect(blocksEqual(a, b)).toBe(false);
  });

  it("treats a reorder as a change, since order is content", () => {
    const a = [createBlock("headline", "h1", 0), createBlock("divider", "d1", 1)];
    const b = [createBlock("divider", "d1", 0), createBlock("headline", "h1", 1)];
    expect(blocksEqual(a, b)).toBe(false);
  });

  it("compares stored rich-text payloads by content, not identity", () => {
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }] };
    const a: AdminBlock[] = [{ ...createBlock("prose", "p1"), data: { content: structuredClone(doc) } }];
    const b: AdminBlock[] = [{ ...createBlock("prose", "p1"), data: { content: structuredClone(doc) } }];
    expect(blocksEqual(a, b)).toBe(true);
  });
});
