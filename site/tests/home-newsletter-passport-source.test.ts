// @vitest-environment node
import { describe, expect, it } from "vitest";
import publicCopy from "./fixtures/home-sources/newsletter-public-copy.json";
import { exportRecordCards } from "../src/lib/record-card-resolution";
import { adaptHomeNewsletter, adaptHomePassport } from "../../packages/content-core/src/home-newsletter-source";
import { HOME_PASSPORT_CONTENT } from "../../packages/content-core/src/home-section-render";
import { createHomeNewsletterBlock, renderHomeNewsletter } from "../../packages/content-core/src/home-newsletter-section";
import { createHomeNewsletterSnapshot } from "../../packages/content-core/src/home-service-sources";
import fixture from "./fixtures/home-v2-selections.json";
import { readHomeEditorialCatalog } from "../../packages/content-core/src/home-source-catalog";

const cutoffAt = "2026-10-11T14:44:00Z";
// A schema fixture with recorded public copy; ID/version are test identities, not production receipts.
const record = { id: "public-copy-fixture", type: "newsletter", status: "draft", version: 2,
  title: "Private working edit", signupUrl: "https://private.example.test/",
  approvedLibraryVersion: { type: "newsletter", status: "approved", version: 1,
    title: publicCopy.title, summary: publicCopy.summary, signupUrl: publicCopy.signupUrl,
    body: { type: "doc", content: [] } } };
const exported = exportRecordCards([record], [], new Date(cutoffAt));

describe("Newsletter and Passport source adapters", () => {
  it("uses the real approval/export boundary and the recorded public signup destination", () => {
    const output = adaptHomeNewsletter({ newsletterIds: [record.id], actionLabel: "Subscribe" },
      { status: "ready", checkedAt: cutoffAt, records: exported }, cutoffAt);
    expect(output.cards).toEqual([{
      id: "public-copy-fixture", sourceVersion: 1, title: "Get the NJ PBS email newsletter",
      summary: "Station news and programming updates, delivered to your inbox.",
      signupHref: "https://centerforcooperativemedia.us5.list-manage.com/subscribe?u=7f46611cb324e9e193acda7cc&id=598fdbd3b7",
      actionLabel: "Subscribe",
    }]);
    expect(output.emptyReason).toBeNull();
    expect(JSON.stringify(output)).not.toContain("Private");
  });

  it("retains configured copy and reports missing/withdrawn records without a hardcoded fallback", () => {
    const settings = { newsletterIds: [record.id], heading: "Station updates", intro: "Reviewed introduction", actionLabel: "Join" };
    expect(adaptHomeNewsletter(settings, { status: "ready", checkedAt: cutoffAt, records: [] }, cutoffAt)).toMatchObject({
      heading: "Station updates", intro: "Reviewed introduction", cards: [], missingIds: [record.id], emptyReason: "selection_unavailable",
    });
    expect(adaptHomeNewsletter(settings, { status: "error" }, cutoffAt)).toMatchObject({ checkedAt: null, emptyReason: "source_error" });
    expect(() => adaptHomeNewsletter({ ...settings, href: "https://evil.example.test/" } as never,
      { status: "ready", checkedAt: cutoffAt, records: exported }, cutoffAt)).toThrow();
    for (const signupUrl of ["javascript:alert(1)", "http://example.test/", "https://user:pass@example.test/"]) {
      const records = [{ ...exported[0], newsletter: { card: { title: publicCopy.title, signupUrl } } }];
      expect(adaptHomeNewsletter(settings, { status: "ready", checkedAt: cutoffAt, records } as never, cutoffAt).cards).toEqual([]);
    }
  });

  it("uses approved artwork and its alt text without reading the working image", () => {
    const approved = { ...record, imageAssetId: "working-art", imageAlt: "Private working art",
      approvedLibraryVersion: { ...record.approvedLibraryVersion, imageAssetId: "approved-art", imageAlt: 'Station "newsletter" art' } };
    const records = exportRecordCards([approved], [], new Date(cutoffAt), [
      { id: "approved-art", url: "https://media.njpbs.org/cms-media/newsletter.webp", mimeType: "image/webp", width: 1280, height: 720 },
      { id: "working-art", url: "https://media.njpbs.org/cms-media/private.webp", mimeType: "image/webp", width: 1280, height: 720 },
    ]);
    const settings = { newsletterIds: [record.id], actionLabel: "Subscribe" };
    const output = adaptHomeNewsletter(settings, { status: "ready", checkedAt: cutoffAt, records }, cutoffAt);
    expect(output.cards[0].image).toEqual({ url: "https://media.njpbs.org/cms-media/newsletter.webp", alt: 'Station "newsletter" art' });
    expect(JSON.stringify(output)).not.toContain("Private");
    expect(JSON.stringify(output)).not.toContain("private.webp");
    const decorativeRecords = exportRecordCards([{ ...approved,
      approvedLibraryVersion: { ...approved.approvedLibraryVersion, imageDecorative: true } }], [], new Date(cutoffAt), [
      { id: "approved-art", url: "https://media.njpbs.org/cms-media/newsletter.webp", mimeType: "image/webp", width: 1280, height: 720 },
    ]);
    expect(adaptHomeNewsletter(settings, { status: "ready", checkedAt: cutoffAt, records: decorativeRecords }, cutoffAt).cards[0].image?.alt).toBe("");
    const bar = { ...createHomeNewsletterBlock("alt-proof"), data: { ...settings, selectionReceipt: fixture.editorial.receipt } };
    const catalog = (cards: typeof records) => readHomeEditorialCatalog({ ...fixture.editorial.catalog,
      services: { newsletters: createHomeNewsletterSnapshot(cards, cutoffAt, cutoffAt) } });
    expect(renderHomeNewsletter(bar, catalog(records))).toContain('alt="Station &quot;newsletter&quot; art"');
    expect(renderHomeNewsletter(bar, catalog(decorativeRecords))).toContain('alt=""');
  });

  it("omits unsupported artwork while retaining the approved signup card", () => {
    const settings = { newsletterIds: [record.id], actionLabel: "Subscribe" };
    const approvedCard = exported[0].kind === "newsletter" ? exported[0].newsletter!.card : null;
    for (const image of [
      { url: "https://untrusted.example.test/newsletter.webp", alt: "Artwork" },
      { url: "https://media.njpbs.org/cms-media/newsletter.webp?token=temporary", alt: "Artwork" },
      { url: "https://image.pbs.org/newsletter.webp#fragment", alt: "Artwork" },
      { url: "/brand/../private.webp", alt: "Artwork" },
    ]) {
      const records = [{ ...exported[0], newsletter: { card: { ...approvedCard, imageAlt: image.alt }, image } }];
      const output = adaptHomeNewsletter(settings, { status: "ready", checkedAt: cutoffAt, records } as never, cutoffAt);
      expect(output.cards).toHaveLength(1);
      expect(output.cards[0].image).toBeUndefined();
      expect(output.cards[0].signupHref).toBe(publicCopy.signupUrl);
    }
  });

  it("keeps the approved Passport content and action together, detached from saved input", () => {
    const content = structuredClone(HOME_PASSPORT_CONTENT);
    const output = adaptHomePassport(content);
    expect(output.actionHref).toBe("https://watch.njpbs.org/passport/learn-more/");
    expect(output.content).toEqual({ heading: "Stream more with PBS Passport", actionLabel: "Explore Passport",
      bodyHtml: "<p>Members unlock a library of PBS and NJ PBS programs on demand. Learn how the Passport member benefit works through PBS.</p>" });
    content.body.content.length = 0;
    expect(output.content!.bodyHtml).toContain("Members unlock");
    expect(adaptHomePassport(null)).toMatchObject({ content: null, emptyReason: "missing" });
    expect(() => adaptHomePassport(HOME_PASSPORT_CONTENT, "/account/")).toThrow();
    expect(() => adaptHomePassport({ ...HOME_PASSPORT_CONTENT, body: { type: "doc", content: [null] } })).toThrow();
  });

  it("rejects unsupported receipt states and text-free required Passport copy", () => {
    const settings = { newsletterIds: [record.id], actionLabel: "Join" };
    for (const status of ["stale", "withdrawn", undefined]) {
      expect(() => adaptHomeNewsletter(settings, { status, checkedAt: cutoffAt, records: exported } as never, cutoffAt)).toThrow();
    }
    for (const node of [{ type: "horizontalRule" }, { type: "hardBreak" },
      { type: "paragraph", content: [{ type: "text", text: " " }] }]) {
      expect(() => adaptHomePassport({ ...HOME_PASSPORT_CONTENT, body: { type: "doc", content: [node] } })).toThrow();
    }
  });
});
