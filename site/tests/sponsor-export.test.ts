import { approvedLibraryRecord } from "./fixtures/approved-library-record";
import { describe, expect, it } from "vitest";
import { sponsorCardData } from "../src/lib/sponsor-export";
import { exportRecordCards, sponsorCardsFromRecordCards } from "../src/lib/record-card-resolution";
import { renderBlock } from "../../packages/content-core/src/content-render";
import { readRecordCardAssetsFromDatabase } from "../src/lib/cms-record-cards-loader";
import type { SponsorStripBlock } from "../../packages/content-core/src/content-model";

const now = new Date("2026-09-28T15:00:00.000Z");
const sponsor = { id: "s1", type: "sponsor", name: "NJ Foundation", href: "https://example.org/", logoAssetId: "logo-1", logoAlt: "NJ Foundation logo", status: "draft" };
const assets = [{ id: "logo-1", url: "https://media.njpbs.org/cms-media/logo.png", mimeType: "image/png" }];
const exportedSponsors = (records: Array<Record<string, unknown> & { id: string }>) =>
  sponsorCardsFromRecordCards(exportRecordCards(records.map(approvedLibraryRecord), [], now, assets));

describe("sponsor library export", () => {
  it("projects only approved, non-archived sponsors and needed fields", () => {
    const records = [sponsor,
      { ...sponsor, id: "s2", activeFrom: "2026-09-29" },
      { ...sponsor, id: "s3", activeUntil: "2026-09-27" },
      { ...sponsor, id: "s4", status: "archived" },
      { ...sponsor, id: "s5", deleted: true },
      { ...sponsor, id: "s6", type: "event" },
    ];
    expect(exportedSponsors(records)).toEqual([{
      sponsorId: "s1", name: "NJ Foundation", href: "https://example.org/",
      logoUrl: assets[0]!.url, logoAlt: "NJ Foundation logo", logoDecorative: false,
    }]);
    expect(exportedSponsors([{ ...sponsor, activeFrom: "2026-09-28", activeUntil: "2026-09-28" }])).toHaveLength(1);
  });

  it("keeps decorative logos silent and refuses unsafe websites", () => {
    expect(sponsorCardData({ ...sponsor, logoDecorative: true, logoAlt: "" })?.logoAlt).toBe("");
    for (const href of ["www.acme.org", "mailto:hello@example.org", "tel:+15551234567", "/support/", "https://user:pass@example.org", "javascript:alert(1)"]) {
      expect(sponsorCardData({ ...sponsor, href })?.href).toBeNull();
      expect(exportRecordCards([approvedLibraryRecord({ ...sponsor, href })], [], now, assets)[0]?.href).toBeNull();
    }
    expect(sponsorCardData({ ...sponsor, activeUntil: "2026-09-27" }, new Map(), now)).toBeNull();
  });

  it("canonicalizes mixed-case website schemes before artifact validation", () => {
    const card = exportRecordCards([approvedLibraryRecord({ ...sponsor, href: "HTTPS://example.org/support" })], [], now, assets)[0]!;
    expect(card.href).toBe("https://example.org/support");
    expect(card.kind === "sponsor" && card.sponsor?.href).toBe("https://example.org/support");
  });

  it("reads exact public media assets for direct Firestore cards", async () => {
    const get = async () => ({ exists: true, id: "logo-1", data: () => assets[0] });
    const database = { collection: () => ({ doc: () => ({ get }) }) };
    const resolved = await readRecordCardAssetsFromDatabase(database, [approvedLibraryRecord(sponsor)], now);
    expect(resolved).toEqual(assets);
    expect(sponsorCardsFromRecordCards(exportRecordCards([approvedLibraryRecord(sponsor)], [], now, resolved))[0]?.logoUrl).toBe(assets[0]?.url);
  });

  it("uses the New York calendar day for activation", () => {
    const beforeMidnight = new Date("2026-09-29T03:30:00.000Z");
    expect(sponsorCardData({ ...sponsor, activeUntil: "2026-09-28" }, new Map(), beforeMidnight)).not.toBeNull();
    expect(sponsorCardData({ ...sponsor, activeFrom: "2026-09-29" }, new Map(), beforeMidnight)).toBeNull();
  });

  it("renders selected logos in order with sponsored links, omitting missing records", () => {
    const block: SponsorStripBlock = { id: "b", type: "sponsor_strip", order: 0, visible: true,
      data: { heading: "With thanks", sponsorIds: ["missing", "s1"], layout: "grid" } };
    const html = renderBlock(block, { sponsors: exportedSponsors([sponsor]) });
    expect(html).toContain('class="sponsor-strip sponsor-strip--grid"');
    expect(html).toContain('rel="sponsored noopener"');
    expect(html).toContain('alt="NJ Foundation logo"');
    expect(html).not.toContain("missing");
    const unnamedLogo = renderBlock(block, { sponsors: exportedSponsors([{ ...sponsor, logoAlt: "" }]) });
    expect(unnamedLogo).toContain("<span>NJ Foundation</span>");
    const oldHref = renderBlock(block, { sponsors: exportedSponsors([{ ...sponsor, href: "mailto:hello@example.org" }]) });
    expect(oldHref).toContain("NJ Foundation");
    expect(oldHref).not.toContain("href=");
    expect(renderBlock(block, { sponsors: [] })).toBe("");
  });
});
