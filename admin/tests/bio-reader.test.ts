import { afterEach, describe, expect, it } from "vitest";
import { renderBioCard } from "../../packages/content-core/src/bio-render";
import { renderBlock } from "../../packages/content-core/src/content-render";
import { renderRichText, type RichTextDoc } from "../../packages/content-core/src/content-model";
import type { BioCardData } from "../../packages/content-core/src/bio-profiles";

const card: BioCardData = {
  profileId: "example-person", kind: "person", name: "Example Person", role: "State official",
  party: "Democratic", area: "Statewide", summary: "A short, verified biography.",
  sourceUrl: "https://example.org/bio", sourceLabel: "Official biography", asOf: "2026-10-03",
};
afterEach(() => { document.body.innerHTML = ""; });

describe("public bio card rendering", () => {
  it("keeps card publication opt-in to article renderers", () => {
    const block = { id: "bio-1", type: "bio_card" as const, order: 0, visible: true, data: card };
    expect(renderBlock(block)).toBe("");
    expect(renderBlock(block, { allowBios: true })).toContain('<details class="bio-card bio-card--person">');
  });

  it("uses a native disclosure with compact context and no scripted controls", () => {
    document.body.innerHTML = renderBioCard(card);
    const details = document.querySelector<HTMLDetailsElement>("details.bio-card")!;
    expect(details.open).toBe(false);
    const summary = details.querySelector("summary.bio-card__summary")!;
    expect(summary.textContent).toContain("Example Person");
    expect(summary.textContent).toContain("State official");
    expect(summary.textContent).toContain("Democratic");
    expect(summary.textContent).toContain("Statewide");
    expect(details.querySelector(".bio-card__body")?.textContent).toContain(card.summary);
    expect(details.querySelector("script, button, [data-inline-bio]")).toBeNull();
    expect(summary.querySelector(".bio-card__sr")?.textContent).toBe("Party: ");
  });

  it("renders an old inline bio mark as ordinary formatted text without its extra identity", () => {
    const doc: RichTextDoc = { type: "doc", content: [{ type: "paragraph", content: [{
      type: "text", text: "Example Person", marks: [
        { type: "bold" },
        { type: "bio", attrs: { profileId: card.profileId, kind: card.kind, name: card.name,
          role: card.role, party: card.party, area: card.area } },
      ],
    }] }] };
    expect(renderRichText(doc)).toBe("<p><strong>Example Person</strong></p>");
  });

  it("rejects unfinished or contaminated cards and escapes public text", () => {
    expect(renderBioCard({ ...card, summary: "" })).toBe("");
    expect(renderBioCard({ ...card, privateNotes: "secret" } as BioCardData)).toBe("");
    const html = renderBioCard({ ...card, name: '<img src=x onerror="alert(1)">', summary: "<script>bad()</script>" });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<img src=x");
  });

  it("uses organization headquarters language and omits absent party information", () => {
    document.body.innerHTML = renderBioCard({ ...card, kind: "organization", area: "Trenton", party: undefined });
    expect(document.querySelector(".bio-card--organization")).not.toBeNull();
    expect(document.querySelector(".bio-fact")?.textContent).toBe("Based in Trenton");
    expect(document.body.textContent).not.toContain("Party:");
  });

  it("keeps the source and checked date in the expandable biography", () => {
    document.body.innerHTML = renderBioCard(card);
    const body = document.querySelector(".bio-card__body")!;
    expect(body.querySelector("a")?.getAttribute("href")).toBe(card.sourceUrl);
    expect(body.querySelector("a")?.textContent).toBe(card.sourceLabel);
    expect(body.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-03");
    expect(document.querySelector("summary a")).toBeNull();
  });

  it("omits empty photo space and renders only a resolved image with its public credit", () => {
    const data = { ...card, image: { assetId: "portrait", alt: "Example Person", caption: "Photo <credit>" } };
    const block = { id: "bio-photo", type: "bio_card" as const, order: 0, visible: true, data };
    const withoutImage = renderBlock(block, { allowBios: true });
    expect(withoutImage).not.toContain('class="bio-card__photo"');
    expect(withoutImage).not.toContain('class="bio-card__credit"');
    document.body.innerHTML = renderBlock(block, {
      allowBios: true,
      resolveAsset: (assetId, placement) => {
        expect([assetId, placement]).toEqual(["portrait", "grid"]);
        return { url: "/media/portrait.webp", width: 640, height: 800 };
      },
    });
    expect(document.querySelector(".bio-card__photo img")?.getAttribute("alt")).toBe("Example Person");
    expect(document.querySelector(".bio-card__credit")?.textContent).toBe("Photo <credit>");
    expect(document.querySelector("credit")).toBeNull();
  });
});
