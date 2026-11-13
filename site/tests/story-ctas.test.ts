import { describe, expect, it } from "vitest";
import server from "../../functions/lib/cms-settings-contract.js";
import { CMS_SETTINGS_SCHEMAS, STORY_CTAS_SETTINGS_ID, cloneSettingsValues, currentCmsSettingsSchemaFor,
  validateCmsSettingsValues } from "../../packages/content-core/src/cms-settings";
import { insertStoryCtas, type StoryCtaRule } from "../../packages/content-core/src/story-cta-rules";
import { isStoryCtasBuildData, projectStoryCtas } from "../../packages/content-core/src/story-ctas";
import { parseBlocks, type PageBlock } from "../../packages/content-core/src/content-model";
import { storyCtaComposition } from "../src/lib/story-ctas";
import { projectChrome } from "../src/lib/published-post-shadow";

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
    expect(schema.schemaVersion).toBe(1);
    expect(schema.fields).toEqual({ rules: { kind: "storyCtaRules", required: true } });
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
    { rules: [{ ...rule(), position: { kind: "start" } }] }, { rules: null }, { rules: [null] },
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
  it("places live-blog end CTAs after the update stream, leaving the intro intact", () => {
    const registry = projectStoryCtas({ version: 4, published: published() })!.data;
    const input = [{ ...paragraph, id: "story-cta-donate" }];
    const output = storyCtaComposition(input, [registry], true);
    expect(output.body).toEqual(input);
    expect(output.afterUpdates.map(block => block.type)).toEqual(["support_appeal"]);
    expect(output.afterUpdates[0].id).toBe("story-cta-donate-cta");
    expect(storyCtaComposition([], [registry], true).afterUpdates.map(block => block.type)).toEqual(["support_appeal"]);
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
    expect(insertStoryCtas([paragraph], [rule()], "page")).toEqual([paragraph]);
  });
  it("keeps list order and avoids collisions with authored ids", () => {
    const output = insertStoryCtas([{ ...paragraph, id: "story-cta-donate" }], [rule(), rule({ id: "second" })]);
    expect(output.map(block => block.id)).toEqual(["story-cta-donate", "story-cta-donate-cta", "story-cta-second"]);
    expect(output.map(block => block.order)).toEqual([0, 1, 2]);
  });
});
