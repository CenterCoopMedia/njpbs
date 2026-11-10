import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { parseBlocks } from "../../packages/content-core/src/content-model";
import { homeCompositionError } from "../../packages/content-core/src/home-composition-contract";
import { createHomeDonorBlock, renderHomeDonor } from "../../packages/content-core/src/home-donor-section";
import { applyEditorOp, canPlaceAnotherBlock, validateSection } from "../../packages/content-core/src/editor-admin";
import v1 from "./fixtures/home-composition-v1.json";

const require = createRequire(import.meta.url);
const server = require("../../functions/lib/home-composition-contract.js");
const sections = require("../../functions/lib/editor-section-contract.js");
const donor = () => createHomeDonorBlock("saved-giving");
const blocks = (giving = donor()) => [...structuredClone(v1.blocks), giving].map((block, order) => ({ ...block, order }));

describe("saved Home giving contract", () => {
  it("escapes editable copy, preserves the fixed destination and omits withdrawn output", () => {
    const value = donor();
    value.data.cards[0].title = '<img src=x onerror="alert(1)">';
    value.data.cards[0].label = '<script>alert(1)</script>';
    const html = renderHomeDonor(value);
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('href="/support/"');
    expect(html).not.toContain('<script>');
    expect(renderHomeDonor({ ...value, visible: false })).toBe("");
    value.data.cards[0].href = "/donate/";
    expect(() => renderHomeDonor(value)).toThrow(/support/);
  });

  it("keeps blank draft copy recoverable while enforcing its structure and destination", () => {
    const value = donor(); value.data.cards[0].title = ""; value.data.cards[0].label = "";
    const parsed = parseBlocks(blocks(value), { complete: false });
    if (!parsed.ok) throw new Error(parsed.error);
    for (const reader of [{ homeCompositionError }, server]) {
      expect(reader.homeCompositionError("home", 2, parsed.blocks, { complete: false })).toBeNull();
      expect(reader.homeCompositionError("home", 2, parsed.blocks)).toBeTruthy();
      expect(reader.homeCompositionError("home", 1, parsed.blocks, { complete: false })).toBeTruthy();
      expect(reader.homeCompositionError("support", undefined, parsed.blocks, { complete: false })).toBeTruthy();
    }
    expect(renderHomeDonor(value, { complete: false })).toBe("");
    expect(() => renderHomeDonor(value)).toThrow();
    value.data.cards[0].href = "/donate/";
    expect(() => renderHomeDonor(value, { complete: false })).toThrow(/support/);
  });

  it("keeps the ordinary card-set slot available before and after giving is withdrawn", () => {
    const ordinary = { ...donor(), id: "ordinary-cards", section: undefined };
    const original = structuredClone(v1.blocks);
    for (const visible of [true, false]) {
      const giving = { ...donor(), visible };
      for (const values of [[...original, giving], [...original, ordinary]]) {
        const parsed = parseBlocks(values, { complete: false });
        if (!parsed.ok) throw new Error(parsed.error);
        if (values.at(-1)!.section === "home-donor") expect(canPlaceAnotherBlock("home", parsed.blocks, "card_grid")).toBe(true);
        const insert = values.at(-1)!.section === "home-donor" ? ordinary : giving;
        const result = applyEditorOp("home", parsed.blocks, { kind: "insert", block: insert, index: parsed.blocks.length });
        if ("error" in result) throw new Error(result.error.reason);
        expect(validateSection("home", result.blocks)).toBeNull();
        expect(sections.validateSection("home", result.blocks)).toBeNull();
        expect(homeCompositionError("home", 2, result.blocks)).toBeNull();
        expect(canPlaceAnotherBlock("home", result.blocks, "card_grid")).toBe(false);
      }
    }
  });

  it.each([
    ["destination", (value: ReturnType<typeof donor>) => { value.data.cards[0].href = "https://evil.example.test/"; }],
    ["unknown field", (value: ReturnType<typeof donor>) => { Object.assign(value.data.cards[0], { privateNote: "extra" }); }],
    ["artwork", (value: ReturnType<typeof donor>) => { value.data.cards[0].imageAssetId = "extra-art"; }],
    ["heading length", (value: ReturnType<typeof donor>) => { value.data.cards[0].title = "x".repeat(121); }],
    ["label length", (value: ReturnType<typeof donor>) => { value.data.cards[0].label = "x".repeat(121); }],
    ["control character", (value: ReturnType<typeof donor>) => { value.data.cards[0].title = "Giving\u0000"; }],
    ["formatted summary", (value: ReturnType<typeof donor>) => { value.data.cards[0].body!.content[0].content![0].marks = [{ type: "bold" }]; }],
    ["multiple actions", (value: ReturnType<typeof donor>) => { value.data.cards.push({ ...value.data.cards[0] }); }],
  ] as const)("rejects %s on both contracts, including hidden incomplete drafts", (_name, change) => {
    const value = donor(); change(value); value.visible = false;
    const parsed = parseBlocks(blocks(value), { complete: false });
    if (!parsed.ok) return; // Generic parsing may reject first; it never admits this value.
    for (const reader of [{ homeCompositionError }, server]) expect(reader.homeCompositionError("home", 2, parsed.blocks, { complete: false })).toBeTruthy();
  });
});
