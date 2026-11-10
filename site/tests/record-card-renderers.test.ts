import { approvedLibraryRecord } from "./fixtures/approved-library-record";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseBlocks } from "../../packages/content-core/src/content-model";
import { renderBlock } from "../../packages/content-core/src/content-render";
import { renderContentGroups } from "../../packages/content-core/src/content-row-render";
import { exportRecordCards, resolveRecordCard } from "../src/lib/record-card-resolution";
import type { CmsProgramBuildData } from "../src/lib/cms-programs-loader";
import type { CmsEventBuildData } from "../src/lib/cms-events-loader";

const now = new Date("2026-09-28T12:00:00.000Z");
const image = { assetId: "card-art", url: "https://media.njpbs.org/cms-media/card.png", mimeType: "image/png" as const, width: 640, height: 360 };
const program = {
  programId: "program-one", path: "/programs/program-one/", title: "Program one",
  description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "A program." }] }] },
  keyArt: image, keyArtAlt: "Program art", keyArtDecorative: false, genre: "Arts",
} as unknown as CmsProgramBuildData;
const event = {
  eventId: "event-one", path: "/events/event-one/", title: "Event one",
  startsAt: "2026-10-01T18:00:00.000Z", endsAt: null, location: "Newark",
  image, imageAlt: "Event art", imageDecorative: false, registrationUrl: null, registrationLabel: "Register",
} as CmsEventBuildData;
const records = [
  { id: "sponsor-one", type: "sponsor", status: "draft", name: "Sponsor one", href: "https://example.org/", logoAssetId: "card-art", logoAlt: "Sponsor logo", version: 4 },
  { id: "newsletter-one", type: "newsletter", status: "draft", title: "Newsletter one", signupUrl: "https://example.org/join", imageAssetId: "card-art", imageAlt: "Newsletter art", version: 5 },
];
const cards = exportRecordCards(records.map(approvedLibraryRecord), [program], now, [{ ...image, id: image.assetId }], [event]);

const component = (kind: string) => readFileSync(path.join(process.cwd(), `src/components/record-cards/${kind}Card.astro`), "utf8");

describe("record card renderers", () => {
  it("renders compact cards with a title link and without secondary content", () => {
    for (const kind of ["Program", "Event", "Sponsor", "Newsletter"]) {
      const source = component(kind);
      expect(source).toContain('card.variant === "compact"');
      expect(source).toContain("--compact");
      expect(source).toMatch(/!compact && .*\b(?:art|image|logoUrl)/);
    }
    expect(component("Program")).toContain("!compact && program.summary");
    expect(component("Event")).toContain("!compact ? <p>");
    expect(component("Sponsor")).toContain("!compact && sponsor.description");
    expect(component("Newsletter")).toContain("compact ? <Heading><a href={data.signupUrl}");
  });
  it("uses the generated outline level for Program, Event and Newsletter cards", () => {
    const leaf = readFileSync(path.join(process.cwd(), "src/components/CmsBlockLeaf.astro"), "utf8");
    const registry = readFileSync(path.join(process.cwd(), "src/components/RecordCard.astro"), "utf8");
    expect(leaf).toContain("headingLevel={group.generatedHeadingLevel ?? 2}");
    expect(registry).toContain("headingLevel={headingLevel}");
    for (const kind of ["Program", "Event", "Newsletter"]) {
      expect(component(kind)).toContain("<Heading>");
      expect(component(kind)).not.toContain("<h3>");
    }
  });

  it("supplies published Program art and the canonical /programs/ link", () => {
    expect(cards.find(card => card.kind === "program")).toMatchObject({ href: "/programs/program-one/", program: { art: image, alt: "Program art", genre: "Arts" } });
    expect(component("Program")).toMatch(/<img[^>]*src=\{program\.art\.url\}/);
    expect(component("Program")).toContain('href={program.url}');
  });
  it("supplies published Event art, alt text, date and the canonical /events/ link", () => {
    expect(cards.find(card => card.kind === "event")).toMatchObject({ href: "/events/event-one/", event: { image, imageAlt: "Event art", startsAt: event.startsAt } });
    expect(component("Event")).toMatch(/<img[^>]*src=\{event\.image\.url\}/);
    expect(component("Event")).toContain('href={event.url}');
  });
  it("supplies saved Sponsor fields and its media-library logo", () => {
    expect(cards.find(card => card.kind === "sponsor")).toMatchObject({ sponsor: { logoUrl: image.url, logoAlt: "Sponsor logo" }, sourceVersion: 4 });
    expect(component("Sponsor")).toContain('rel="sponsored noopener"');
    expect(component("Sponsor")).toContain('src={sponsor.logoUrl}');
  });
  it("supplies saved Newsletter fields, its image and a secure signup link", () => {
    expect(cards.find(card => card.kind === "newsletter")).toMatchObject({ newsletter: { card: { signupUrl: "https://example.org/join", imageAlt: "Newsletter art" }, image: { url: image.url } }, sourceVersion: 5 });
    expect(component("Newsletter")).toContain('src={image.url}');
    expect(component("Newsletter")).toContain('href={data.signupUrl}');
  });
  it("resolves a Page containing one card of each kind through the shared registry", () => {
    const blocks = [
      { id: "program", type: "record_card", order: 0, visible: true, data: { recordKind: "program", recordId: "program-one" } },
      { id: "event", type: "record_card", order: 1, visible: true, data: { recordKind: "event", recordId: "event-one" } },
      { id: "sponsor", type: "record_card", order: 2, visible: true, data: { recordKind: "sponsor", recordId: "sponsor-one" } },
      { id: "newsletter", type: "record_card", order: 3, visible: true, data: { recordKind: "newsletter", recordId: "newsletter-one" } },
    ];
    const parsed = parseBlocks(blocks);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const groups = renderContentGroups(parsed.blocks, block => ({ html: renderBlock(block) }));
    expect(groups.map(group => group.block.type)).toEqual(Array(4).fill("record_card"));
    expect(groups.map(group => group.block.type === "record_card" ? resolveRecordCard(group.block, cards)?.kind : null))
      .toEqual(["program", "event", "sponsor", "newsletter"]);
    const registry = readFileSync(path.join(process.cwd(), "src/components/RecordCard.astro"), "utf8");
    for (const kind of ["program", "event", "sponsor", "newsletter"]) expect(registry).toContain(`${kind}: ${kind[0].toUpperCase()}${kind.slice(1)}Card`);
  });
});
