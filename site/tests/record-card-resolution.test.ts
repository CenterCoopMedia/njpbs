import { approvedLibraryRecord } from "./fixtures/approved-library-record";
import { describe, expect, it } from "vitest";
import { exportRecordCards, resolveRecordCard } from "../src/lib/record-card-resolution";
import type { CmsProgramBuildData } from "../src/lib/cms-programs-loader";
import type { CmsEventBuildData } from "../src/lib/cms-events-loader";

const now = new Date("2026-09-28T12:00:00.000Z");
const program = {
  programId: "program_1", title: "On the record", path: "/programs/on-the-record/",
  description: { type: "doc", content: [] }, keyArt: null, keyArtDecorative: false, keyArtAlt: "", genre: null,
} as unknown as CmsProgramBuildData;
const block = (recordKind: "program" | "event" | "sponsor" | "newsletter", recordId: string) =>
  ({ data: { recordKind, recordId, variant: "compact" as const } });

describe("record card resolution", () => {
  it("uses public snapshots for routed and library kinds", () => {
    const records = [
      { id: "event_1", type: "event", title: "Unsaved edit", status: "published",
        publiclyVisible: true, publishAt: "2026-09-27T12:00:00.000Z",
        published: { metadata: { type: "event", title: "Fall event", slug: "fall-event" } } },
      approvedLibraryRecord({ id: "sponsor_1", type: "sponsor", name: "Station supporter", href: "https://example.org", status: "draft" }),
      approvedLibraryRecord({ id: "newsletter_1", type: "newsletter", title: "Weekly dispatch", signupUrl: "https://example.org/join", status: "draft" }),
    ];
    const events = [{ eventId: "event_1", title: "Fall event", path: "/events/fall-event/", startsAt: "2026-10-01T18:00:00.000Z", endsAt: null, location: null, image: null, imageAlt: "", imageDecorative: false, registrationUrl: null, registrationLabel: "Register" }] as CmsEventBuildData[];
    const cards = exportRecordCards(records, [program], now, [], events);
    expect(resolveRecordCard(block("program", "program_1"), cards)).toMatchObject({
      title: "On the record", href: "/programs/on-the-record/", variant: "compact",
    });
    expect(resolveRecordCard(block("event", "event_1"), cards)).toMatchObject({
      title: "Fall event", href: "/events/fall-event/",
    });
    expect(resolveRecordCard(block("sponsor", "sponsor_1"), cards)).toMatchObject({
      title: "Station supporter", href: "https://example.org/",
    });
    expect(resolveRecordCard(block("newsletter", "newsletter_1"), cards)).toMatchObject({
      title: "Weekly dispatch", href: null,
    });
  });

  it("resolves missing, unpublished and archived records to nothing", () => {
    const records = [
      { id: "event_draft", type: "event", status: "draft", published: {
        metadata: { type: "event", title: "Draft event", slug: "draft-event" },
      } },
      { id: "sponsor_archived", type: "sponsor", name: "Archived sponsor", status: "archived" },
      { id: "newsletter_deleted", type: "newsletter", title: "Deleted", signupUrl: "https://example.org/join", deleted: true },
    ];
    const cards = exportRecordCards(records, [], now);
    expect(cards).toEqual([]);
    expect(resolveRecordCard(block("event", "event_draft"), cards)).toBeNull();
    expect(resolveRecordCard(block("sponsor", "missing"), cards)).toBeNull();
  });
});
