import { describe, expect, it, vi } from "vitest";
import { exportRecordCards, exportPreviewLibraryCards, resolveRecordCard, sponsorCardsFromRecordCards } from "../src/lib/record-card-resolution";
import { readRecordCardAssetsFromDatabase, readRecordCardSourcesFromDatabase } from "../src/lib/cms-record-cards-loader";
import { newsletterSignupResolution } from "../src/lib/newsletter-signup";
import { renderBlock } from "../../packages/content-core/src/content-render";

const now = new Date("2026-09-28T12:00:00.000Z");
const sponsor = {
  id: "sponsor", type: "sponsor", status: "draft", publiclyVisible: false, version: 8,
  name: "Draft sponsor", href: "https://draft.example.test/", logoAssetId: "draft-logo",
  activeUntil: "2026-10-01",
  approvedLibraryVersion: { status: "approved", type: "sponsor", name: "Approved sponsor", href: "https://public.example.test/",
      logoAssetId: "public-logo", logoAlt: "Approved logo", activeUntil: "2026-10-01", version: 3,
  },
};
const newsletter = {
  id: "newsletter", type: "newsletter", status: "in_review", publiclyVisible: false, version: 9,
  title: "Draft newsletter", signupUrl: "https://draft.example.test/join", imageAssetId: "draft-image",
  summary: "Private draft summary",
  approvedLibraryVersion: { status: "approved", type: "newsletter", title: "Approved newsletter", signupUrl: "https://public.example.test/join",
      imageAssetId: "public-image", imageAlt: "Approved image", summary: "Approved summary", version: 4,
  },
};
const assets = ["public-logo", "public-image", "draft-logo", "draft-image"].map(id => ({
  id, url: `https://media.example.test/${id}.png`, mimeType: "image/png", width: 640, height: 360,
}));

describe("library card publication boundary", () => {
  it("#2680: keeps sponsor and newsletter cards on the approved version after a draft edit", async () => {
    const cards = exportRecordCards([sponsor, newsletter], [], now, assets);
    expect(cards).toMatchObject([
      { kind: "sponsor", title: "Approved sponsor", href: "https://public.example.test/", sourceVersion: 3,
        sponsor: { logoUrl: "https://media.example.test/public-logo.png", logoAlt: "Approved logo" } },
      { kind: "newsletter", title: "Approved newsletter", sourceVersion: 4,
        newsletter: { card: { signupUrl: "https://public.example.test/join", summary: "Approved summary", imageAlt: "Approved image" },
          image: { url: "https://media.example.test/public-image.png" } } },
    ]);
    for (const kind of ["sponsor", "newsletter"] as const) {
      expect(resolveRecordCard({ data: { recordKind: kind, recordId: kind, variant: "card" } }, cards)?.title)
        .toBe(kind === "sponsor" ? "Approved sponsor" : "Approved newsletter");
    }
    const strip = renderBlock({ id: "strip", type: "sponsor_strip", order: 0, visible: true,
      data: { sponsorIds: ["sponsor"], layout: "row" } }, { sponsors: sponsorCardsFromRecordCards(cards) });
    expect(strip).toContain("https://public.example.test/");
    expect(JSON.stringify(cards) + strip).not.toMatch(/Draft|Private|draft\.example|draft-logo|draft-image/);
  });

  it("#2679: signup resolution keeps the approved title, URL and summary after a draft edit", async () => {
    const blocks = [{ id: "signup", type: "newsletter_signup" as const, order: 0, visible: true,
      data: { newsletterIds: ["newsletter", "never-approved"] } }];
    const cards = exportRecordCards([newsletter, { ...newsletter, id: "never-approved", approvedLibraryVersion: undefined }], [], now);
    const resolved = await newsletterSignupResolution(blocks, async () => { throw new Error("No image expected"); }, cards);
    expect([...resolved.cards.keys()]).toEqual(["newsletter"]);
    expect(resolved.cards.get("newsletter")).toMatchObject({ title: "Approved newsletter",
      signupUrl: "https://public.example.test/join", summary: "Approved summary" });
    const html = renderBlock(blocks[0], { resolveNewsletter: id => resolved.cards.get(id) ?? null });
    expect(html).toContain("Approved newsletter");
    expect(html).toContain("Approved summary");
    expect(html).toContain("https://public.example.test/join");
    expect(html).not.toMatch(/Draft|Private|draft\.example/);
  });

  it.each(["draft", "in_review", "approved", "published"])("omits %s library records without a version and warns without blocking", status => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(exportRecordCards([
      { ...sponsor, status, activeUntil: undefined, approvedLibraryVersion: undefined },
      { ...newsletter, status, approvedLibraryVersion: undefined },
    ], [], now, assets)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.flat().join(" ")).toContain("no approved version available");
    warn.mockRestore();
  });

  it.each([{ deleted: true }, { status: "archived" }])("omits removed library records: %j", overrides => {
    expect(exportRecordCards([{ ...newsletter, ...overrides }], [], now, assets)).toEqual([]);
  });

  it.each([
    { approvedLibraryVersion: { ...newsletter.approvedLibraryVersion, type: "sponsor" } },
    { approvedLibraryVersion: { ...newsletter.approvedLibraryVersion, version: 0 } },
    { approvedLibraryVersion: { ...newsletter.approvedLibraryVersion, version: 10 } },
    { approvedLibraryVersion: { ...newsletter.approvedLibraryVersion, status: "in_review" } },
    { approvedLibraryVersion: null },
  ])("omits unavailable or malformed approved versions: %j", overrides => {
    expect(exportRecordCards([{ ...newsletter, ...overrides }], [], now, assets)).toEqual([]);
  });

  it("reads approved library media at the direct database boundary", async () => {
    const database = { collection: () => ({ doc: (id: string) => ({ get: async () => ({
      exists: true, id, data: () => assets.find(asset => asset.id === id),
    }) }) }) };
    const resolved = await readRecordCardAssetsFromDatabase(database, [sponsor, newsletter], now);
    expect(resolved.map(asset => asset.id)).toEqual(["public-logo", "public-image"]);
    expect(exportRecordCards([sponsor, newsletter], [], now, resolved)).toHaveLength(2);
  });

  it("loads real approval history before exporting direct-build fields and media", async () => {
    const queries: string[] = [];
    const history = [
      { collection: "cmsPosts", documentId: "sponsor", action: "approve", after: sponsor.approvedLibraryVersion },
      { collection: "cmsPosts", documentId: "newsletter", action: "approve", after: newsletter.approvedLibraryVersion },
    ];
    const query = (filters: [string, string][] = []): object => ({
      where: (field: string, _op: string, value: string) => query([...filters, [field, value]]),
      get: async () => ({ docs: history.filter(row => filters.every(([field, value]) => row[field as "documentId"] === value))
        .map(data => ({ data: () => data })) }),
    });
    const database = { collection: (name: string) => {
      queries.push(name);
      if (name === "cmsVersionHistory") return query();
      if (name === "cmsPosts") return { get: async () => ({ docs: [sponsor, newsletter].map(record => ({
        id: record.id, exists: true, data: () => ({ ...record, id: "forged-id", approvedLibraryVersion: { ...record, version: 999 } }),
      })) }) };
      return { doc: (id: string) => ({ get: async () => ({ exists: true, id, data: () => assets.find(asset => asset.id === id) }) }) };
    } };
    const read = await readRecordCardSourcesFromDatabase(database as never, now);
    expect(queries.filter(name => name === "cmsVersionHistory")).toHaveLength(2);
    expect(read.assets.map(asset => asset.id)).toEqual(["public-logo", "public-image"]);
    expect(exportRecordCards(read.records, [], now, read.assets)).toMatchObject([
      { id: "sponsor", title: "Approved sponsor", sourceVersion: 3 },
      { id: "newsletter", title: "Approved newsletter", sourceVersion: 4 },
    ]);
  });

  it("does not let draft active dates or a draft publish time hide an approved sponsor", () => {
    expect(exportRecordCards([{ ...sponsor, activeUntil: "2026-09-01", publishAt: "2099-01-01T00:00:00Z" }], [], now, assets))
      .toMatchObject([{ title: "Approved sponsor", sourceVersion: 3 }]);
  });

  it("does not fill absent approved fields from the draft, including summary fallback", () => {
    const metadata = { type: "newsletter", title: "Approved newsletter", signupUrl: "https://public.example.test/join",
      body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Approved body" }] }] } };
    const cards = exportRecordCards([{ ...newsletter, approvedLibraryVersion: { ...metadata, status: "approved", version: 4 } }], [], now, assets);
    expect(cards).toMatchObject([{ newsletter: { card: { summary: "Approved body" } } }]);
    expect(JSON.stringify(cards)).not.toMatch(/Private|draft-image|Draft/);
  });

  it("keeps saved fields available to explicit private previews", () => {
    const cards = exportPreviewLibraryCards([{ ...sponsor, activeUntil: undefined }, newsletter], now, assets);
    expect(cards).toMatchObject([
      { kind: "sponsor", title: "Draft sponsor", sourceVersion: 8 },
      { kind: "newsletter", title: "Draft newsletter", sourceVersion: 9 },
    ]);
  });
});
