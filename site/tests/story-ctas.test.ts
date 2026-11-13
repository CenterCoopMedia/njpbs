import { describe, expect, it } from "vitest";
import server from "../../functions/lib/cms-settings-contract.js";
import { CMS_SETTINGS_SCHEMAS, STORY_CTAS_SETTINGS_ID, cloneSettingsValues, currentCmsSettingsSchemaFor,
  validateCmsSettingsValues, cmsSettingsSchemaFor } from "../../packages/content-core/src/cms-settings";
import { insertStoryCtas, type StoryCtaRule } from "../../packages/content-core/src/story-cta-rules";
import { isStoryCtasBuildData, projectStoryCtas } from "../../packages/content-core/src/story-ctas";
import { parseBlocks, type PageBlock } from "../../packages/content-core/src/content-model";
import { storyCtaComposition } from "../src/lib/story-ctas";
import { projectChrome } from "../src/lib/published-post-shadow";
import { postChapters } from "../src/lib/post-chapters";
import type { RichTextNode } from "../../packages/content-core/src/content-model";

const rule = (patch: Partial<StoryCtaRule> = {}): StoryCtaRule => ({ id: "donate", label: "Support our reporting", enabled: true,
  target: { contentTypes: ["post"] }, position: { kind: "end" }, content: { type: "support_appeal", data: {
    heading: "Support local reporting", copy: "Your gift supports public media.", buttonLabel: "Donate", href: "https://example.org/donate?station_id=station&campaign=reporting", style: "blue",
  } }, ...patch });
const paragraph: PageBlock = { id: "body", type: "prose", order: 0, visible: true, data: { content: {
  type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Story text." }] }],
} } };
const schema = currentCmsSettingsSchemaFor(STORY_CTAS_SETTINGS_ID)!;
const published = (rules = [rule()]) => ({ schemaVersion: 1, sourceVersion: 3, publishedAt: "2026-11-13T12:00:00.000Z", values: { rules } });

describe("story CTA settings boundary", () => {
  it("uses the same closed schema in the editor and server", () => {
    expect(server.CMS_SETTINGS_SCHEMAS).toEqual(CMS_SETTINGS_SCHEMAS);
    expect(schema.schemaVersion).toBe(2);
    expect(schema.fields).toEqual({ rules: { kind: "storyCtaRules", required: true, version: 2 } });
  });
  it.each([
    { rules: [] }, { rules: [rule()] }, { rules: [rule({ enabled: false })] },
  ])("admits safe reusable block settings: %j", values => {
    expect(validateCmsSettingsValues(schema, values)).toBeNull();
    expect(server.validateCmsSettingsValues(schema, values)).toBeNull();
  });
  it.each([
    { rules: [rule(), rule()] }, { rules: Array.from({ length: 21 }, (_, i) => rule({ id: `rule-${i}` })) },
    { rules: [{ ...rule(), enabled: "yes" }] }, { rules: [{ ...rule(), target: { contentTypes: ["page"] } }] },
    { rules: [{ ...rule(), target: { contentTypes: ["post"], tags: ["politics"] } }] },
    { rules: [{ ...rule(), content: { type: "html", data: { html: "<script>alert(1)</script>" } } }] },
    { rules: [{ ...rule(), content: { ...rule().content, data: { ...rule().content.data, href: "javascript:alert(1)" } } }] },
    { rules: [{ ...rule(), content: { ...rule().content, data: { ...rule().content.data, backgroundImageAssetId: "private-image" } } }] },
    { rules: [{ ...rule(), position: { kind: "after-paragraph", count: 0 } }] }, { rules: null }, { rules: [null] },
  ])("rejects unsafe or unsupported settings on both boundaries: %j", values => {
    const error = validateCmsSettingsValues(schema, values);
    expect(error).toBeTypeOf("string");
    expect(server.validateCmsSettingsValues(schema, values)).toBe(error);
  });
  it("detaches nested working settings from saved and published values", () => {
    const values = { rules: [rule()] };
    const cloned = cloneSettingsValues(schema, values) as unknown as typeof values;
    values.rules[0].content.data.heading = "Changed later";
    expect(cloned.rules[0].content.data.heading).toBe("Support local reporting");
  });
  it("keeps version 1's end-only support appeal contract while version 2 admits new positions", () => {
    const start = { rules: [rule({ position: { kind: "start" } })] };
    const v1 = cmsSettingsSchemaFor(STORY_CTAS_SETTINGS_ID, 1)!;
    expect(v1.fields).toEqual({ rules: { kind: "storyCtaRules", required: true } });
    expect(validateCmsSettingsValues(v1, start)).toBeTypeOf("string");
    expect(server.validateCmsSettingsValues(v1, start)).toBeTypeOf("string");
    expect(validateCmsSettingsValues(schema, start)).toBeNull();
    expect(server.validateCmsSettingsValues(schema, start)).toBeNull();
  });
  it("reads only the published snapshot, including compiled public chrome", () => {
    const document = { id: STORY_CTAS_SETTINGS_ID, version: 4, values: { rules: [rule({ enabled: false })] }, published: published() };
    const projected = projectStoryCtas(document)!;
    expect(projected.data.rules[0].enabled).toBe(true);
    expect(projected.data.sourceVersion).toBe(3);
    expect(projectChrome({ settings: [document] }).settings).toEqual([projected.data]);
    expect(isStoryCtasBuildData(projected.data)).toBe(true);
    expect(storyCtaComposition([paragraph], [projected.data]).body.map(block => block.type)).toEqual(["prose", "support_appeal"]);
    expect(projectStoryCtas({ version: 4, values: document.values })).toBeNull();
    expect(projectStoryCtas({ version: 4, published: { ...published(), values: { rules: [null] } } })).toBeNull();
  });
});

describe("end-of-story CTA insertion", () => {
  it("leaves authored CTA blocks intact when the story opts out of every automatic position", () => {
    const manual: PageBlock = { ...rule().content, id: "manual-appeal", order: 1, visible: true };
    const body = [paragraph, manual];
    const rules = [rule(), after(1), rule({ id: "start", position: { kind: "start" } })];
    expect(insertStoryCtas(body, rules, { optOut: true })).toEqual(body);
    const registry = projectStoryCtas({ version: 4, published: { ...published(), schemaVersion: 2, values: { rules } } })!.data;
    expect(storyCtaComposition(body, [registry], { optOut: true })).toEqual({ body, afterUpdates: [] });
    expect(storyCtaComposition(body, [registry], { liveBlog: true, optOut: true })).toEqual({ body, afterUpdates: [] });
  });
  it("places live-blog end CTAs after the update stream, leaving the intro intact", () => {
    const registry = projectStoryCtas({ version: 4, published: published() })!.data;
    const input = [{ ...paragraph, id: "story-cta-donate" }];
    const output = storyCtaComposition(input, [registry], { liveBlog: true });
    expect(output.body).toEqual(input);
    expect(output.afterUpdates.map(block => block.type)).toEqual(["support_appeal"]);
    expect(output.afterUpdates[0].id).toBe("story-cta-donate-cta");
    expect(storyCtaComposition([], [registry], { liveBlog: true }).afterUpdates.map(block => block.type)).toEqual(["support_appeal"]);
  });
  it("inserts after the body without editing its saved blocks", () => {
    const input = structuredClone([paragraph]);
    const output = insertStoryCtas(input, [rule()]);
    expect(output.map(block => block.type)).toEqual(["prose", "support_appeal"]);
    expect(input).toEqual([paragraph]);
    expect(parseBlocks(output).ok).toBe(true);
  });
  it("places an end CTA on an empty body", () => {
    expect(insertStoryCtas([], [rule()]).map(block => block.type)).toEqual(["support_appeal"]);
  });
  it("leaves disabled rules and pages unchanged", () => {
    expect(insertStoryCtas([paragraph], [rule({ enabled: false })])).toEqual([paragraph]);
    expect(insertStoryCtas([paragraph], [rule()], { contentType: "page" })).toEqual([paragraph]);
  });
  it("keeps list order and avoids collisions with authored ids", () => {
    const output = insertStoryCtas([{ ...paragraph, id: "story-cta-donate" }], [rule(), rule({ id: "second" })]);
    expect(output.map(block => block.id)).toEqual(["story-cta-donate", "story-cta-donate-cta", "story-cta-second"]);
    expect(output.map(block => block.order)).toEqual([0, 1, 2]);
  });
});

const textNode = (type: string, text: string): RichTextNode => ({ type, content: [{ type: "text", text }] });
const prose = (id: string, nodes: RichTextNode[]): PageBlock => ({ ...paragraph, id, data: { content: { type: "doc", content: nodes } } });
const p = (text: string) => textNode("paragraph", text);
const after = (count: number, id = "middle") => rule({ id, position: { kind: "after-paragraph", count } });
const labels = (blocks: readonly PageBlock[]) => blocks.flatMap(block => block.type === "prose"
  ? block.data.content.content.map(node => node.content?.map(part => part.text ?? "").join("") || node.type)
  : [block.type]);

describe("paragraph positions from issue 72", () => {
  it("counts paragraphs across mixed blocks and within one prose block", () => {
    const body: PageBlock[] = [prose("first", [p("One")]),
      { id: "photo", type: "image", order: 1, visible: true, data: { assetId: "image", alt: "A river" } },
      prose("last", [p("Two"), p("Three"), p("Four")])];
    const original = structuredClone(body);
    const composed = insertStoryCtas(body, [after(3)]);
    expect(labels(composed)).toEqual(["One", "image", "Two", "Three", "support_appeal", "Four"]);
    expect(body).toEqual(original);
    expect(parseBlocks(composed).ok).toBe(true);
  });
  it("does not count headings, lists, quotes, hidden prose or CTA copy", () => {
    const nested = { type: "bulletList", content: [{ type: "listItem", content: [p("List paragraph")] }] };
    const quote = { type: "blockquote", content: [p("Quote paragraph")] };
    const body = [{ ...prose("hidden", [p("Hidden")]), visible: false },
      prose("main", [textNode("heading", "Heading"), p("One"), nested, quote, p("Two"), p("Three")])];
    const composed = insertStoryCtas(body, [after(2), rule({ id: "start", position: { kind: "start" } })]);
    expect(labels(composed)).toEqual(["support_appeal", "Hidden", "Heading", "One", "bulletList", "blockquote", "Two", "support_appeal", "Three"]);
  });
  it("omits an after-N rule when the body has fewer than N paragraphs", () => {
    const body = [prose("short", [p("One")]), { id: "divider", type: "divider" as const, order: 1, visible: true, data: {} }];
    expect(insertStoryCtas(body, [after(3)])).toEqual(body);
    expect(insertStoryCtas([], [after(1)])).toEqual([]);
  });
  it("puts start and end around an empty body and keeps same-position rule order", () => {
    expect(insertStoryCtas([], [rule({ id: "last" }), after(1), rule({ id: "first", position: { kind: "start" } })])
      .map(block => block.id)).toEqual(["story-cta-first", "story-cta-last"]);
    expect(insertStoryCtas([prose("text", [p("One"), p("Two")])], [after(1, "a"), after(1, "b")])
      .map(block => block.id)).toEqual(["text", "story-cta-a", "story-cta-b", "text-cta-part-2"]);
  });
  it("keeps row membership and ignores hidden row paragraphs", () => {
    const body: PageBlock[] = [
      { id: "row", type: "row", order: 0, visible: true, data: { columns: [12] } },
      { ...prose("row-text", [p("One"), p("Two")]), order: 1, layout: { rowId: "row", column: 0 } },
      { id: "hidden-row", type: "row", order: 2, visible: false, data: { columns: [12] } },
      { ...prose("hidden-text", [p("Hidden")]), order: 3, layout: { rowId: "hidden-row", column: 0 } },
    ];
    const result = insertStoryCtas(body, [after(1), after(3, "missing")]);
    const ctas = result.filter(block => block.type === "support_appeal");
    expect(ctas).toHaveLength(1);
    expect(ctas[0].layout).toEqual({ rowId: "row", column: 0 });
    expect(parseBlocks(result).ok).toBe(true);
  });
  it("preserves chapter anchors when prose is split around a CTA", () => {
    const heading = (title: string): RichTextNode => ({ ...textNode("heading", title), attrs: { level: 2 } });
    const body = [prose("report", [heading("First"), p("One"), heading("Second"), p("Two")])];
    expect(postChapters(insertStoryCtas(body, [after(1)])).map(chapter => [chapter.id, chapter.label]))
      .toEqual([["report-first", "First"], ["report-second", "Second"]]);
  });
  it("admits newsletter blocks with bounded newsletter references on both boundaries", () => {
    const newsletter: StoryCtaRule = { ...after(2), content: { type: "newsletter_signup", data: { heading: "Stay informed", newsletterIds: ["weekly"] } } };
    expect(validateCmsSettingsValues(schema, { rules: [newsletter] })).toBeNull();
    expect(server.validateCmsSettingsValues(schema, { rules: [newsletter] })).toBeNull();
    expect(validateCmsSettingsValues(cmsSettingsSchemaFor(STORY_CTAS_SETTINGS_ID, 1)!, { rules: [newsletter] })).toBeTypeOf("string");
    expect(labels(insertStoryCtas([prose("body", [p("One"), p("Two"), p("Three")])], [newsletter])))
      .toEqual(["One", "Two", "newsletter_signup", "Three"]);
  });
  it.each([-1, 0, 1.5, 10001, Infinity, "2"])("rejects invalid paragraph count %s in both contracts", count => {
    const values = { rules: [{ ...rule(), position: { kind: "after-paragraph", count } }] };
    const error = validateCmsSettingsValues(schema, values);
    expect(error).toBeTypeOf("string"); expect(server.validateCmsSettingsValues(schema, values)).toBe(error);
  });
  it("keeps start and paragraph CTAs in live-blog intros and end CTAs below updates", () => {
    const rules = [rule({ id: "last" }), after(1), rule({ id: "first", position: { kind: "start" } })];
    const registry = projectStoryCtas({ version: 4, published: { ...published(), schemaVersion: 2, values: { rules } } })!.data;
    const result = storyCtaComposition([prose("intro", [p("One"), p("Two")])], [registry], { liveBlog: true });
    expect(labels(result.body)).toEqual(["support_appeal", "One", "support_appeal", "Two"]);
    expect(result.afterUpdates.map(block => block.id)).toEqual(["story-cta-last"]);
  });
});
