import { describe, expect, it } from "vitest";
import { newsletterCardData } from "../../packages/content-core/src/newsletter-card-data";
import { renderBlock } from "../../packages/content-core/src/content-render";
import { parseBlocks, type NewsletterRecord } from "../../packages/content-core/src/content-model";
import { newsletterSignupResolution } from "../src/lib/newsletter-signup";
import { exportRecordCards } from "../src/lib/record-card-resolution";

const record = (fields: Partial<NewsletterRecord>) => ({
  type: "newsletter", title: "The Weekly", signupUrl: "https://example.org/subscribe",
  ...fields,
}) as NewsletterRecord;

describe("newsletter signup", () => {
  it("keeps records without a secure destination out of signup cards", () => {
    expect(newsletterCardData(record({ signupUrl: "" }))).toBeNull();
    expect(exportRecordCards([{ ...record({ signupUrl: "" }), id: "weekly" }], [], new Date("2026-09-28T12:00:00Z"))).toEqual([]);
    expect(newsletterCardData(record({ signupUrl: "http://example.org/subscribe" }))?.signupUrl).toBeUndefined();
    expect(newsletterCardData(record({ signupUrl: "https://user:pass@example.org/subscribe" }))?.signupUrl).toBeUndefined();
    expect(newsletterCardData(record({ signupUrl: "" }))?.signupUrl).toBeUndefined();
    expect(newsletterCardData(record({ frequency: " Weekly ", imageDecorative: true, imageAlt: "wrong" }))).toMatchObject({ frequency: "Weekly" });
    expect(newsletterCardData(record({ body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Legacy description" }] }] } }))?.summary).toBe("Legacy description");
  });

  it("renders only resolved links, escaped copy, and no form or provider script", () => {
    const parsed = parseBlocks([{ id: "signup", type: "newsletter_signup", order: 0, visible: true,
      data: { newsletterIds: ["one", "missing"], heading: "Get updates", intro: "Sent by the provider" } }]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const html = renderBlock(parsed.blocks[0], { resolveNewsletter: id => id === "one"
      ? newsletterCardData(record({ title: "Weekly <News>", summary: "Stories & more" })) : null });
    expect(html).toContain("href=\"https://example.org/subscribe\"");
    expect(html).toContain("Weekly &lt;News&gt;");
    expect(html).toContain("Stories &amp; more");
    expect(html).not.toMatch(/<form|<script|missing/);
  });

  it("limits the selected records to four distinct IDs", () => {
    const block = (ids: string[]) => [{ id: "signup", type: "newsletter_signup", order: 0, visible: true, data: { newsletterIds: ids } }];
    expect(parseBlocks(block(["one", "two", "three", "four"])).ok).toBe(true);
    expect(parseBlocks(block(["one", "one"])).ok).toBe(false);
    expect(parseBlocks(block(["one", "two", "three", "four", "five"])).ok).toBe(false);
    expect(parseBlocks(block([])).ok).toBe(false);
    expect(parseBlocks(block([]), { complete: false }).ok).toBe(true);
  });

  it("resolves selected records from the fixed-cutoff card export", async () => {
    const parsed = parseBlocks([{ id: "signup", type: "newsletter_signup", order: 0, visible: true,
      data: { newsletterIds: ["one", "missing"] } }]);
    if (!parsed.ok) throw new Error(parsed.error);
    const records = [{ kind: "newsletter" as const, id: "one", title: "Weekly", href: null,
      newsletter: { card: { title: "Weekly", signupUrl: "https://example.org/join" } } }];
    const resolved = await newsletterSignupResolution(parsed.blocks, async () => { throw new Error("No image expected"); }, records);
    expect(resolved.cards.get("one")?.title).toBe("Weekly");
    expect(resolved.cards.has("missing")).toBe(false);
  });
});
