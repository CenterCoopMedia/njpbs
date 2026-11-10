import { describe, expect, it } from "vitest";
import snapshotPkg from "../../functions/lib/publish-snapshot.js";
import contractPkg from "../../functions/lib/content-document-contract.js";
const { createPublishedSnapshot } = snapshotPkg;
const { validateContentFieldValues } = contractPkg;
const description = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Join us." }] }] };
const event = { type: "event", title: "Screening", slug: "screening", previousSlugs: [], locale: "en", startsAt: "2026-10-01T22:00:00.000Z", description, version: 2, imageAssetId: "asset-1", imageAlt: "Audience", imageDecorative: false, registrationUrl: "https://example.org/register" };

describe("event publication", () => {
  it("freezes route, time, image and registration fields without blocks", () => {
    const snapshot = createPublishedSnapshot({ collection: "cmsPosts", document: event, publishedAt: "2026-09-28T12:00:00.000Z", publishedBy: "editor" });
    expect(snapshot.blocks).toEqual([]);
    expect(snapshot.metadata).toMatchObject({ startsAt: event.startsAt, imageAssetId: "asset-1", registrationUrl: event.registrationUrl });
  });
  it("enforces event URL and image rules at the server contract", () => {
    expect(validateContentFieldValues("cmsPosts", "event", event, { complete: true })).toBeNull();
    expect(validateContentFieldValues("cmsPosts", "event", { ...event, registrationUrl: "http://example.org" })).toMatch(/HTTPS/);
    for (const field of ["registrationUrl", "onlineUrl"]) {
      const credentialed = { ...event, [field]: "https://user:pass@example.org/register" };
      expect(validateContentFieldValues("cmsPosts", "event", credentialed)).toMatch(/credentials/);
      expect(() => createPublishedSnapshot({ collection: "cmsPosts", document: credentialed,
        publishedAt: "2026-09-28T12:00:00.000Z", publishedBy: "editor" })).toThrow(/HTTPS/);
    }
    expect(validateContentFieldValues("cmsPosts", "event", { ...event, imageDecorative: true, imageAlt: "Audience" })).toMatch(/imageAlt/);
    expect(validateContentFieldValues("cmsPosts", "event", { ...event, endsAt: "2026-09-01T00:00:00.000Z" })).toMatch(/after startsAt/);
  });
});
