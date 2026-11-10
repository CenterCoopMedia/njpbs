import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createPostPreviewSnapshot } = require("../../functions/lib/preview-snapshot.js");
const { createPublishedSnapshot } = require("../../functions/lib/publish-snapshot.js");
const { validateContentFieldValues } = require("../../functions/lib/content-document-contract.js");
import { assertEventRouteUniqueness, eventCardData, projectCmsEvent } from "../src/lib/cms-events-loader";

const now = new Date("2026-09-28T12:00:00.000Z");
const description = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Join us for a screening." }] }] };
const metadata = { type: "event", title: "Screening", slug: "screening", previousSlugs: ["old-screening"], locale: "en", startsAt: "2026-10-01T22:00:00.000Z", endsAt: "2026-10-02T00:00:00.000Z", location: "Montclair", description, imageAssetId: "asset-1", imageAlt: "Audience at a screening", imageDecorative: false, registrationUrl: "https://example.org/register" };
const assets = new Map([["asset-1", { id: "asset-1", url: "https://media.njpbs.org/cms-media/asset-1.webp", mimeType: "image/webp", width: 1200, height: 800 }]]);
const record = (overrides: Record<string, unknown> = {}, fields: Record<string, unknown> = {}) => ({ id: "event-1", status: "published", publishAt: "2026-09-27T12:00:00.000Z", published: { metadata: { ...metadata, ...fields }, blocks: [], sourceVersion: 3, publishedAt: "2026-09-27T12:00:00.000Z" }, ...overrides });
const project = (overrides: Record<string, unknown> = {}, fields: Record<string, unknown> = {}) => projectCmsEvent(record(overrides, fields), { now, assets });

describe("public events", () => {
  it.each(["2026-10-01", "2026-02-30T12:00:00.000Z"])("rejects invalid stored Event instant %s", startsAt => {
    const document = { ...metadata, startsAt, endsAt: undefined, version: 1 };
    expect(validateContentFieldValues("cmsPosts", "event", document, { complete: true })).toMatch(/startsAt/);
    expect(() => createPublishedSnapshot({ collection: "cmsPosts", document,
      publishedAt: now.toISOString(), publishedBy: "editor" })).toThrow(/start/);
  });
  it("projects an incomplete saved Event into a private preview route", () => {
    const preview = createPostPreviewSnapshot("event-draft", { type: "event", version: 1 }, now.getTime());
    const projected = projectCmsEvent({ id: preview.id, status: "published", publishAt: preview.published.publishedAt, published: preview.published },
      { now, assets: new Map() });
    expect(projected?.path).toMatch(/^\/events\/draft-/);
    expect(projected?.description).toEqual(preview.published.metadata.description);
  });

  it("uses the frozen snapshot and resolves its image and registration action", () => {
    const event = project({ title: "Unpublished edit", startsAt: "2027-01-01T00:00:00.000Z" })!;
    expect(event.path).toBe("/events/screening/");
    expect(event.previousSlugs).toEqual(["old-screening"]);
    expect(event.title).toBe("Screening");
    expect(event.image?.width).toBe(1200);
    expect(eventCardData(event)).toMatchObject({ title: "Screening", url: "/events/screening/", registrationUrl: "https://example.org/register" });
  });
  it("drops drafts, withdrawals, and future schedules", () => {
    expect(project({ status: "draft" })).toBeNull();
    expect(project({ publiclyVisible: false })).toBeNull();
    expect(project({ status: "scheduled", publishAt: "2026-12-01T00:00:00.000Z" })).toBeNull();
  });
  it("rejects malformed dates, unsafe registration, inaccessible art, and missing media", () => {
    expect(() => project({}, { endsAt: "2026-09-01T00:00:00.000Z" })).toThrow(/end time/);
    expect(() => project({}, { registrationUrl: "http://example.org" })).toThrow(/HTTPS/);
    expect(() => project({}, { imageDecorative: true })).toThrow(/alt text/);
    expect(() => project({}, { imageAssetId: "missing" })).toThrow(/missing media/);
  });
  it("detects canonical and retired route collisions", () => {
    const first = project()!;
    const second = { ...first, eventId: "event-2", slug: "old-screening", path: "/events/old-screening/", previousSlugs: [] };
    expect(() => assertEventRouteUniqueness([first, second])).toThrow(/claimed/);
  });
});
