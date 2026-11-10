import { describe, expect, it } from "vitest";
import { eventJsonLd, jsonLdHtml } from "../src/lib/structured-data";

describe("Event structured data", () => {
  it("uses the canonical URL, instants, address-only venue and registration action", () => {
    const event = eventJsonLd({
      title: "Community screening", startsAt: "2026-10-01T22:00:00.000Z",
      endsAt: "2026-10-02T00:00:00.000Z", canonicalPath: "/events/community-screening/",
      location: null, venueAddress: "1 Normal Ave., Montclair, NJ", onlineUrl: null,
      image: { url: "https://media.njpbs.org/cms-media/screening.webp" },
      registrationUrl: "https://example.org/register", isFree: true, priceText: null,
      site: "https://njpbs.org/",
    });
    expect(event).toMatchObject({
      "@type": "Event", url: "https://njpbs.org/events/community-screening/",
      startDate: "2026-10-01T22:00:00.000Z", endDate: "2026-10-02T00:00:00.000Z",
      location: { "@type": "Place", address: "1 Normal Ave., Montclair, NJ" },
      offers: { "@type": "Offer", url: "https://example.org/register", price: "0" },
    });
    expect(jsonLdHtml(event)).not.toContain("</script>");
  });
});
