import { describe, expect, it } from "vitest";
import { normalizeEditorRecordDates } from "../src/lib/content-records";
import { recordFieldsFor } from "../../packages/content-core/src/editor-admin";
import { RECORD_KINDS } from "../src/lib/content-vocab";

describe("shared content record reads", () => {
  it("normalizes instant-backed event Timestamps without discarding their times", () => {
    const original = {
      title: "Community screening",
      startsAt: { toDate: () => new Date("2026-08-01T17:00:00.000Z") },
      endsAt: { toDate: () => new Date("2026-08-01T19:00:00.000Z") },
      createdAt: { toDate: () => new Date("2026-07-01T12:00:00.000Z") },
    };

    expect(normalizeEditorRecordDates("event", original)).toEqual({
      ...original,
      startsAt: "2026-08-01T17:00:00.000Z",
      endsAt: "2026-08-01T19:00:00.000Z",
    });
    expect(typeof original.startsAt).toBe("object");
    // createdAt is server-owned rather than an editable date descriptor, so it stays untouched.
    expect(typeof original.createdAt).toBe("object");
  });

  it.each([
    ["event", "startsAt", "2026-07-24T15:30:00.123Z"],
    ["post", "date", "2026-07-24"],
  ] as const)(
    "normalizes a callable JSON Timestamp for %s.%s",
    (kind, key, expected) => {
      const timestamp = {
        _seconds: Date.parse("2026-07-24T15:30:00.000Z") / 1_000,
        _nanoseconds: 123_000_000,
      };
      const original = { [key]: timestamp };

      expect(normalizeEditorRecordDates(kind, original)).toEqual({
        [key]: expected,
      });
      expect(original[key]).toBe(timestamp);
    },
  );

  it.each(RECORD_KINDS)(
    "normalizes inherited publishAt Timestamp values for the %s descriptor contract",
    (kind) => {
      const publishAt = {
        toDate: () => new Date("2026-07-24T15:30:00.000Z"),
      };
      const original = { publishAt };

      const normalized = normalizeEditorRecordDates(kind, original);

      expect(normalized).not.toBe(original);
      expect(normalized.publishAt).toBe("2026-07-24T15:30:00.000Z");
      expect(original.publishAt).toBe(publishAt);
    },
  );

  // No form exposes publishAt any more. A post's editorial date and the moment it goes
  // live are separate facts (#1041), and the second is a lifecycle action taken on an
  // approved record; the one descriptor that did offer the field belonged to the
  // retired Article form (#1039). Normalization still covers the inherited value,
  // because a record stored before the retirement can carry one.
  it("exposes publishAt as a form control on no record kind", () => {
    expect(
      RECORD_KINDS.filter((kind) =>
        recordFieldsFor(kind).some(
          (field) => field.key === "publishAt" && !field.path,
        ),
      ),
    ).toEqual([]);
  });

  it.each([
    ["event", "startsAt"],
    ["event", "endsAt"],
  ] as const)(
    "preserves a stored %s.%s instant string behind its descriptor date-time control",
    (kind, key) => {
      // These carry an instant, not a calendar day, so they must not sit behind a
      // `date` control: it emits YYYY-MM-DD, which the publish gate reads as unusable
      // and fails closed on (#509).
      expect(
        recordFieldsFor(kind).some(
          (field) => field.key === key && field.kind === "datetime" && !field.path,
        ),
      ).toBe(true);
      const original = { [key]: "2026-07-24T15:30:00.000Z" };

      expect(normalizeEditorRecordDates(kind, original)).toBe(original);
      expect(original[key]).toBe("2026-07-24T15:30:00.000Z");
    },
  );

  it.each(RECORD_KINDS)(
    "preserves clear, set, and absent inherited publishAt inputs for %s records",
    (kind) => {
      const cleared = { publishAt: "" };
      const set = { publishAt: "2026-07-24" };
      const absent = { title: "Legacy record" };

      expect(normalizeEditorRecordDates(kind, cleared)).toBe(cleared);
      expect(normalizeEditorRecordDates(kind, set)).toBe(set);
      expect(normalizeEditorRecordDates(kind, absent)).toBe(absent);
      expect(absent).not.toHaveProperty("publishAt");
    },
  );

  it("preserves invalid descriptor date strings for the save boundary to reject", () => {
    for (const startsAt of [
      "2026-02-31",
      "2026-02-31T00:00:00.000Z",
      "not-a-date",
    ]) {
      const record = { startsAt };
      expect(normalizeEditorRecordDates("event", record)).toBe(record);
      expect(record.startsAt).toBe(startsAt);
    }
  });

  it("normalizes a post's calendar-only date without adding an instant", () => {
    const original = {
      title: "Garden State update",
      date: { toDate: () => new Date("2026-07-24T00:00:00.000Z") },
    };

    expect(normalizeEditorRecordDates("post", original)).toEqual({
      ...original,
      date: "2026-07-24",
    });
    expect(typeof original.date).toBe("object");
  });

  it("normalizes a legacy post instant string but preserves canonical and invalid dates", () => {
    const original = {
      date: "2026-07-24T15:30:00.000Z",
      title: "Garden State update",
    };

    expect(normalizeEditorRecordDates("post", original)).toEqual({
      ...original,
      date: "2026-07-24",
    });
    expect(original.date).toBe("2026-07-24T15:30:00.000Z");

    expect(
      normalizeEditorRecordDates("post", {
        date: "2026-07-24T23:30:00-04:00",
      }),
    ).toEqual({ date: "2026-07-24" });
    expect(
      normalizeEditorRecordDates("post", {
        date: "2026-07-24 23:30:00-04:00",
      }),
    ).toEqual({ date: "2026-07-24" });

    for (const date of [
      "2026-07-24",
      "2026-02-31",
      "2026-02-31T00:00:00.000Z",
      "not-a-date",
    ]) {
      const record = { date };
      expect(normalizeEditorRecordDates("post", record)).toBe(record);
      expect(record.date).toBe(date);
    }
  });

});
