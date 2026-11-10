import { afterEach, describe, expect, it } from "vitest";
import { WHATS_NEW_NOTES } from "../src/data/whats-new";
import { sortWhatsNewNotes, type WhatsNewNote } from "../src/data/whats-new-order";
import { hasUnreadWhatsNew, LATEST_WHATS_NEW_ID, markWhatsNewSeen } from "../src/lib/whats-new-seen";

afterEach(() => localStorage.clear());

describe("What's new fragments", () => {
  const fragments = import.meta.glob<WhatsNewNote>("../src/data/whats-new/*.json", {
    eager: true,
    import: "default",
  });

  it("gives every file a valid note with a unique date and title id", () => {
    expect(Object.keys(fragments).length).toBeGreaterThan(0);
    const ids = new Set<string>();
    for (const [file, note] of Object.entries(fragments)) {
      expect(note, file).toEqual({
        date: expect.any(String),
        kind: expect.stringMatching(/^(new|improved|fixed)$/),
        title: expect.any(String),
        body: expect.any(String),
        prs: expect.any(Array),
        ...(note.order === undefined ? {} : { order: expect.any(Number) }),
        ...(note.requires === undefined ? {} : { requires: "video-replacement" }),
      });
      expect(note.date, file).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${note.date}T00:00:00Z`).toISOString().slice(0, 10), file).toBe(note.date);
      expect(note.title.trim().length, file).toBeGreaterThan(0);
      expect(note.body.trim().length, file).toBeGreaterThan(0);
      expect(note.prs.every(pr => Number.isInteger(pr) && pr > 0), file).toBe(true);
      if (note.order !== undefined) expect(Number.isFinite(note.order), file).toBe(true);
      const id = `${note.date} ${note.title}`;
      expect(ids.has(id), file).toBe(false);
      ids.add(id);
    }
    expect(WHATS_NEW_NOTES).toEqual(sortWhatsNewNotes(fragments, import.meta.env.VITE_VIDEO_REPLACEMENT_ENABLED === "true"));
    expect(LATEST_WHATS_NEW_ID).toBe(`${WHATS_NEW_NOTES[0].date} ${WHATS_NEW_NOTES[0].title}`);
  });

  it("sorts dates and order descending, then filenames ascending, with missing order equal to zero", () => {
    const note = (title: string, date = "2026-11-02", order?: number): WhatsNewNote => ({
      date, title, order, kind: "new", body: "A change.", prs: [],
    });
    expect(sortWhatsNewNotes({
      "z.json": note("Same day, last by name"),
      "old.json": note("Older date", "2026-11-01", 1000),
      "priority.json": note("Higher order", "2026-11-02", 2),
      "a.json": note("Same day, first by name", "2026-11-02", 0),
      "negative.json": note("Lower order", "2026-11-02", -1),
      "new.json": note("Newer date", "2026-11-03", -1000),
    }).map(note => note.title)).toEqual([
      "Newer date", "Higher order", "Same day, first by name",
      "Same day, last by name", "Lower order", "Older date",
    ]);
  });

  it("keeps an unavailable feature out of the notes and newest unread identity until activation", () => {
    const old: WhatsNewNote = { date: "2026-11-02", kind: "fixed", title: "Available change", body: "Available.", prs: [] };
    const gated: WhatsNewNote = { date: "2026-11-03", kind: "new", title: "Replace video files", body: "Keep one previous file for 14 days.", prs: [], requires: "video-replacement" };
    expect(sortWhatsNewNotes({ old, gated })).toEqual([old]);
    expect(sortWhatsNewNotes({ old, gated }, true)).toEqual([gated, old]);
  });
});

describe("What's new unread state", () => {
  it("is unread until the newest note is seen, even when a new note shares its date", () => {
    expect(`${WHATS_NEW_NOTES[0].date} ${WHATS_NEW_NOTES[0].title}`).toBe(LATEST_WHATS_NEW_ID);
    expect(hasUnreadWhatsNew("staff-1", "2026-10-15 First note")).toBe(true);
    markWhatsNewSeen("staff-1", "2026-10-15 First note");
    expect(hasUnreadWhatsNew("staff-1", "2026-10-15 First note")).toBe(false);
    expect(hasUnreadWhatsNew("staff-1", "2026-10-15 Second note")).toBe(true);
  });

  it("keeps the seen marker per account in a shared browser", () => {
    markWhatsNewSeen("staff-1", "2026-10-15 First note");
    expect(hasUnreadWhatsNew("staff-2", "2026-10-15 First note")).toBe(true);
  });

  it("hides the dot when storage throws", () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => { throw new Error("blocked"); };
    try {
      expect(hasUnreadWhatsNew("staff-1")).toBe(false);
    } finally {
      Storage.prototype.getItem = original;
    }
  });
});
