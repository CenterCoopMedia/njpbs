import { describe, expect, it } from "vitest";
import {
  applyFirstPublish,
  applyMeaningfulUpdate,
  editorialSortInstant,
  isCalendarDay,
  resolveDisplayDate,
  resolveEditorialDateSource,
  resolveEditorialDateWrite,
  resolveUpdateDisplay,
  stationCalendarDay,
  type EditorialDateRecord,
} from "../../packages/content-core/src/editorial-dates";

// Fixed instants, never a live clock. Every assertion about a day boundary or a
// daylight-saving transition has to be reproducible on a machine in any zone.
const AUG_13_1130PM_EDT = "2026-08-14T03:30:00.000Z";
const AUG_14_MORNING_EDT = "2026-08-14T13:00:00.000Z";
const SPRING_FORWARD_BEFORE = "2026-03-08T06:30:00.000Z"; // 1:30 a.m. EST
const SPRING_FORWARD_AFTER = "2026-03-08T07:30:00.000Z"; // 3:30 a.m. EDT
const FALL_BACK_FIRST = "2026-11-01T05:30:00.000Z"; // 1:30 a.m. EDT
const FALL_BACK_SECOND = "2026-11-01T06:30:00.000Z"; // 1:30 a.m. EST

function draft(fields: Partial<EditorialDateRecord> = {}): EditorialDateRecord {
  return { ...fields };
}

describe("station calendar day", () => {
  it("dates an instant by the station day, not the UTC day", () => {
    expect(stationCalendarDay(AUG_13_1130PM_EDT)).toBe("2026-08-13");
    expect(AUG_13_1130PM_EDT.slice(0, 10)).toBe("2026-08-14");
  });

  it("keeps both sides of a spring-forward transition on the same day", () => {
    expect(stationCalendarDay(SPRING_FORWARD_BEFORE)).toBe("2026-03-08");
    expect(stationCalendarDay(SPRING_FORWARD_AFTER)).toBe("2026-03-08");
  });

  it("keeps both readings of the repeated autumn hour on the same day", () => {
    expect(stationCalendarDay(FALL_BACK_FIRST)).toBe("2026-11-01");
    expect(stationCalendarDay(FALL_BACK_SECOND)).toBe("2026-11-01");
  });

  it("refuses a value that is not an absolute instant", () => {
    expect(stationCalendarDay("2026-08-13")).toBeNull();
    expect(stationCalendarDay("2026-02-30T00:00:00.000Z")).toBeNull();
    expect(stationCalendarDay(undefined)).toBeNull();
  });

  it("reads a day in another zone when one is named", () => {
    expect(stationCalendarDay(AUG_13_1130PM_EDT, "UTC")).toBe("2026-08-14");
    expect(stationCalendarDay(AUG_14_MORNING_EDT, "Asia/Tokyo")).toBe("2026-08-14");
  });
});

describe("calendar day validation", () => {
  it("accepts a real day and refuses one the calendar does not have", () => {
    expect(isCalendarDay("2026-08-13")).toBe(true);
    expect(isCalendarDay("2026-02-30")).toBe(false);
    expect(isCalendarDay("2026-8-13")).toBe(false);
    expect(isCalendarDay(20260813)).toBe(false);
  });
});

describe("editorial date source", () => {
  it("treats a record with a date but no stored source as legacy", () => {
    expect(resolveEditorialDateSource(draft({ date: "2024-01-05" }))).toBe("legacy");
  });

  it("treats a record with neither as one whose date will be derived", () => {
    expect(resolveEditorialDateSource(draft())).toBe("firstPublish");
  });

  it("prefers the stored source and refuses an unknown one", () => {
    expect(
      resolveEditorialDateSource(draft({ date: "2024-01-05", editorialDateSource: "backdated" })),
    ).toBe("backdated");
    expect(
      resolveEditorialDateSource(
        draft({ date: "2024-01-05", editorialDateSource: "whenever" as never }),
      ),
    ).toBe("legacy");
  });
});

describe("display date", () => {
  it("gives an unpublished draft no date at all", () => {
    expect(resolveDisplayDate(draft())).toBeNull();
  });

  it("does not let a draft save time present as a publication date", () => {
    // The shape the old single-field editor produced on a draft: a date typed at
    // creation, nothing published. It must not read as a publication date.
    const started = draft({ date: "2026-08-01", editorialDateSource: "firstPublish" });
    expect(resolveDisplayDate(started)).toBeNull();
  });

  it("derives the day from the first publish instant in station time", () => {
    const record = draft({
      firstPublishedAt: AUG_13_1130PM_EDT,
      editorialDateSource: "firstPublish",
      date: "2026-08-13",
    });
    expect(resolveDisplayDate(record)).toBe("2026-08-13");
  });

  it("ignores a stale stored copy of a derived date", () => {
    const record = draft({
      firstPublishedAt: AUG_13_1130PM_EDT,
      editorialDateSource: "firstPublish",
      date: "1999-01-01",
    });
    expect(resolveDisplayDate(record)).toBe("2026-08-13");
  });

  it("shows the backdated day rather than the publication day", () => {
    const record = draft({
      firstPublishedAt: AUG_14_MORNING_EDT,
      editorialDateSource: "backdated",
      date: "2026-07-04",
    });
    expect(resolveDisplayDate(record)).toBe("2026-07-04");
  });

  it("keeps showing a legacy record exactly what it showed before", () => {
    const record = draft({ date: "2019-04-02", publiclyVisible: true });
    expect(resolveDisplayDate(record)).toBe("2019-04-02");
  });
});

describe("update display", () => {
  const published = {
    firstPublishedAt: AUG_13_1130PM_EDT,
    editorialDateSource: "firstPublish" as const,
    date: "2026-08-13",
  };

  it("stays off until the newsroom turns it on", () => {
    const record = draft({ ...published, meaningfulUpdatedAt: AUG_14_MORNING_EDT });
    expect(resolveUpdateDisplay(record)).toEqual({
      show: false,
      at: AUG_14_MORNING_EDT,
      date: "2026-08-14",
    });
  });

  it("shows a later meaningful update when the control is on", () => {
    const record = draft({
      ...published,
      meaningfulUpdatedAt: AUG_14_MORNING_EDT,
      showUpdatedDate: true,
    });
    expect(resolveUpdateDisplay(record)).toEqual({
      show: true,
      at: AUG_14_MORNING_EDT,
      date: "2026-08-14",
    });
  });

  it("shows nothing when the control is on but nothing meaningful happened", () => {
    const record = draft({ ...published, showUpdatedDate: true });
    expect(resolveUpdateDisplay(record)).toEqual({ show: false, at: null, date: null });
  });

  it("does not print an update dated the same day as publication", () => {
    const record = draft({
      ...published,
      showUpdatedDate: true,
      meaningfulUpdatedAt: "2026-08-13T14:00:00.000Z",
    });
    expect(resolveUpdateDisplay(record).show).toBe(false);
  });

  it("does not print an update older than a backdated display date", () => {
    const record = draft({
      firstPublishedAt: AUG_14_MORNING_EDT,
      editorialDateSource: "backdated",
      date: "2026-12-01",
      showUpdatedDate: true,
      meaningfulUpdatedAt: AUG_14_MORNING_EDT,
    });
    expect(resolveUpdateDisplay(record).show).toBe(false);
  });
});

describe("sort instant", () => {
  it.each(["backdated", "legacy"] as const)("sorts same-day %s Posts by their real first-publish time", (editorialDateSource) => {
    // Brent's October 19 Posts: ACA first, congestion tolls later.
    const earlier = editorialSortInstant({ editorialDateSource, date: "2026-10-19",
      firstPublishedAt: "2026-10-19T14:01:26.827Z" });
    const later = editorialSortInstant({ editorialDateSource, date: "2026-10-19",
      firstPublishedAt: "2026-10-19T16:20:52.363Z" });
    expect(earlier).toBe(Date.parse("2026-10-19T14:01:26.827Z"));
    expect(later).toBe(Date.parse("2026-10-19T16:20:52.363Z"));
    expect(later).toBeGreaterThan(earlier!);
  });

  it("uses the station day when the first-publish instant falls on the next UTC day", () => {
    const record = { editorialDateSource: "backdated" as const, date: "2026-08-13",
      firstPublishedAt: AUG_13_1130PM_EDT };
    expect(editorialSortInstant(record)).toBe(Date.parse(AUG_13_1130PM_EDT));
    expect(editorialSortInstant(record, "UTC")).toBe(Date.parse("2026-08-13T00:00:00.000Z"));
  });

  it("keeps both readings of the repeated autumn hour in first-publish order", () => {
    const record = { editorialDateSource: "backdated" as const, date: "2026-11-01" };
    const earlier = editorialSortInstant({ ...record, firstPublishedAt: FALL_BACK_FIRST });
    const later = editorialSortInstant({ ...record, firstPublishedAt: FALL_BACK_SECOND });
    expect(earlier).toBe(Date.parse(FALL_BACK_FIRST));
    expect(later).toBe(Date.parse(FALL_BACK_SECOND));
    expect(later).toBeGreaterThan(earlier!);
  });

  it("keeps station midnight when a backdated first-publish value is invalid", () => {
    expect(editorialSortInstant({ editorialDateSource: "backdated", date: "2026-10-19",
      firstPublishedAt: "2026-10-19" })).toBe(Date.parse("2026-10-19T04:00:00.000Z"));
  });

  it("sorts a derived record by the exact publication instant", () => {
    const record = draft({
      firstPublishedAt: AUG_14_MORNING_EDT,
      editorialDateSource: "firstPublish",
    });
    expect(editorialSortInstant(record)).toBe(Date.parse(AUG_14_MORNING_EDT));
  });

  it("sorts a backdated record by station midnight of its display day", () => {
    const record = draft({
      firstPublishedAt: AUG_14_MORNING_EDT,
      editorialDateSource: "backdated",
      date: "2026-07-04",
    });
    // Midnight on July 4 in New Jersey is 04:00 UTC, not 00:00 UTC.
    expect(editorialSortInstant(record)).toBe(Date.parse("2026-07-04T04:00:00.000Z"));
  });

  it("sorts a winter legacy record by station midnight at standard time", () => {
    const record = draft({ date: "2026-01-15", publiclyVisible: true });
    expect(editorialSortInstant(record)).toBe(Date.parse("2026-01-15T05:00:00.000Z"));
  });

  it("orders a backdated story before a same-day derived one", () => {
    const backdated = editorialSortInstant(
      draft({ editorialDateSource: "backdated", date: "2026-08-13" }),
    );
    const derived = editorialSortInstant(
      draft({ editorialDateSource: "firstPublish", firstPublishedAt: AUG_13_1130PM_EDT }),
    );
    expect(backdated).not.toBeNull();
    expect(derived).not.toBeNull();
    expect(backdated as number).toBeLessThan(derived as number);
  });

  it("gives an undated draft no sort position", () => {
    expect(editorialSortInstant(draft())).toBeNull();
  });
});

describe("first publish", () => {
  it("stamps the completion instant and derives the display day", () => {
    const stamped = applyFirstPublish(draft(), {
      at: AUG_13_1130PM_EDT,
      by: "uid-editor",
    });
    expect(stamped).toEqual({
      firstPublishedAt: AUG_13_1130PM_EDT,
      firstPublishedBy: "uid-editor",
      editorialDateSource: "firstPublish",
      date: "2026-08-13",
    });
  });

  it("stamps the instant a scheduled run actually completed, not the requested one", () => {
    // The editor asked for 9:00 a.m.; the minute scheduler landed at 9:04.
    const stamped = applyFirstPublish(draft(), {
      at: "2026-08-14T13:04:00.000Z",
      by: "scheduler",
    });
    expect(stamped.firstPublishedAt).toBe("2026-08-14T13:04:00.000Z");
  });

  it("does nothing on a republish", () => {
    const record = draft({
      firstPublishedAt: AUG_13_1130PM_EDT,
      firstPublishedBy: "uid-first",
      editorialDateSource: "firstPublish",
      date: "2026-08-13",
      publiclyVisible: true,
    });
    expect(applyFirstPublish(record, { at: AUG_14_MORNING_EDT, by: "uid-second" })).toEqual({});
  });

  it("keeps a backdated day when the record first publishes", () => {
    const record = draft({ editorialDateSource: "backdated", date: "2026-07-04" });
    expect(applyFirstPublish(record, { at: AUG_14_MORNING_EDT, by: "uid-editor" })).toEqual({
      firstPublishedAt: AUG_14_MORNING_EDT,
      firstPublishedBy: "uid-editor",
      editorialDateSource: "backdated",
    });
  });

  it("never invents a first publish time for a record that was already public", () => {
    const legacy = draft({
      date: "2019-04-02",
      publiclyVisible: true,
      published: { publishedAt: "2026-08-01T12:00:00.000Z" },
    });
    const stamped = applyFirstPublish(legacy, { at: AUG_14_MORNING_EDT, by: "uid-editor" });
    expect(stamped.firstPublishedAt).toBeUndefined();
    expect(resolveDisplayDate({ ...legacy, ...stamped })).toBe("2019-04-02");
  });

  it("refuses an instant or actor it cannot trust", () => {
    expect(() => applyFirstPublish(draft(), { at: "2026-08-14", by: "uid" })).toThrow();
    expect(() => applyFirstPublish(draft(), { at: AUG_14_MORNING_EDT, by: "  " })).toThrow();
  });
});

describe("meaningful update", () => {
  it("records the update only when it is asked for", () => {
    expect(
      applyMeaningfulUpdate({ requested: true, at: AUG_14_MORNING_EDT, by: "uid-editor" }),
    ).toEqual({
      meaningfulUpdatedAt: AUG_14_MORNING_EDT,
      meaningfulUpdatedBy: "uid-editor",
      recordMeaningfulUpdate: false,
    });
  });

  it("leaves a typo-only save alone", () => {
    expect(
      applyMeaningfulUpdate({ requested: false, at: AUG_14_MORNING_EDT, by: "uid-editor" }),
    ).toEqual({ recordMeaningfulUpdate: false });
    expect(
      applyMeaningfulUpdate({ requested: undefined, at: AUG_14_MORNING_EDT, by: "uid-editor" }),
    ).toEqual({ recordMeaningfulUpdate: false });
  });

  it("does not carry the request into the next save", () => {
    const first = applyMeaningfulUpdate({
      requested: true,
      at: AUG_14_MORNING_EDT,
      by: "uid-editor",
    });
    expect(first.recordMeaningfulUpdate).toBe(false);
    const typoFix = applyMeaningfulUpdate({
      requested: first.recordMeaningfulUpdate,
      at: "2026-08-15T13:00:00.000Z",
      by: "uid-editor",
    });
    expect(typoFix).toEqual({ recordMeaningfulUpdate: false });
  });

  it("refuses a truthy value that is not the explicit decision", () => {
    expect(
      applyMeaningfulUpdate({ requested: "yes", at: AUG_14_MORNING_EDT, by: "uid" }),
    ).toEqual({ recordMeaningfulUpdate: false });
  });
});

describe("editorial date write", () => {
  const published: EditorialDateRecord = {
    firstPublishedAt: AUG_13_1130PM_EDT,
    firstPublishedBy: "uid-editor",
    editorialDateSource: "firstPublish",
    date: "2026-08-13",
    publiclyVisible: true,
  };

  it("changes nothing when the field is not submitted", () => {
    expect(resolveEditorialDateWrite(published, undefined)).toEqual({
      backdates: false,
      requiresPublishAuthority: false,
      fields: {},
      error: null,
    });
  });

  it("changes nothing when an ordinary save round-trips the same day", () => {
    expect(resolveEditorialDateWrite(published, "2026-08-13")).toEqual({
      backdates: false,
      requiresPublishAuthority: false,
      fields: {},
      error: null,
    });
  });

  it("treats a different day on a public post as a gated backdate", () => {
    expect(resolveEditorialDateWrite(published, "2026-07-04")).toEqual({
      backdates: true,
      requiresPublishAuthority: true,
      fields: { date: "2026-07-04", editorialDateSource: "backdated" },
      error: null,
    });
  });

  it("treats clearing a backdate as the same decision", () => {
    const backdated: EditorialDateRecord = {
      ...published,
      editorialDateSource: "backdated",
      date: "2026-07-04",
    };
    expect(resolveEditorialDateWrite(backdated, "")).toEqual({
      backdates: true,
      requiresPublishAuthority: true,
      fields: { date: "2026-08-13", editorialDateSource: "firstPublish" },
      error: null,
    });
  });

  // The unrecoverable case. A post that was already public before this contract
  // existed has a date and no publication receipt, and no publish will ever mint one
  // for it. Clearing its date would leave the record with nothing to display and no
  // way back: the next publish refuses the snapshot for want of a date.
  it("refuses to clear a public legacy date with no first-publish receipt", () => {
    const legacy: EditorialDateRecord = {
      date: "2019-04-02",
      editorialDateSource: "legacy",
      publiclyVisible: true,
    };
    expect(resolveEditorialDateWrite(legacy, "")).toEqual({
      backdates: false,
      requiresPublishAuthority: false,
      fields: {},
      error: "date cannot be cleared on a post with no recorded first-publish time",
    });
    expect(resolveDisplayDate(legacy)).toBe("2019-04-02");
  });

  it("refuses the same clear on a public backdated post that never recorded one", () => {
    const backdated: EditorialDateRecord = {
      date: "2019-04-02",
      editorialDateSource: "backdated",
      published: { publishedAt: AUG_14_MORNING_EDT },
    };
    expect(resolveEditorialDateWrite(backdated, "").error).toBe(
      "date cannot be cleared on a post with no recorded first-publish time",
    );
  });

  // A draft has not published yet, so its first publish still mints the receipt the
  // cleared date will be derived from. Nothing is lost by handing the date back.
  it("still clears a backdate on a draft that has never been public", () => {
    expect(
      resolveEditorialDateWrite({ date: "2019-04-02", editorialDateSource: "backdated" }, ""),
    ).toEqual({
      backdates: true,
      requiresPublishAuthority: false,
      fields: { date: "", editorialDateSource: "firstPublish" },
      error: null,
    });
  });

  it("leaves a blank field alone on a draft whose date is derived", () => {
    expect(resolveEditorialDateWrite({}, "")).toEqual({
      backdates: false,
      requiresPublishAuthority: false,
      fields: {},
      error: null,
    });
  });

  it("labels a legacy record on its first save under the contract", () => {
    const legacy: EditorialDateRecord = { date: "2019-04-02", publiclyVisible: true };
    expect(resolveEditorialDateWrite(legacy, "2019-04-02")).toEqual({
      backdates: false,
      requiresPublishAuthority: false,
      fields: { editorialDateSource: "legacy" },
      error: null,
    });
  });

  it("still gates editing a legacy date", () => {
    const legacy: EditorialDateRecord = { date: "2019-04-02", publiclyVisible: true };
    const write = resolveEditorialDateWrite(legacy, "2019-04-03");
    expect(write.backdates).toBe(true);
    expect(write.requiresPublishAuthority).toBe(true);
  });

  it("refuses a day the calendar does not have", () => {
    const write = resolveEditorialDateWrite(published, "2026-02-30");
    expect(write.error).toBe("date must be a valid date");
    expect(write.backdates).toBe(false);
  });

  it("refuses a non-string submission", () => {
    expect(resolveEditorialDateWrite(published, 20260813).error).toBe("date must be a string");
  });

  // A contributor drafting a piece that ran in print last week can fill the date in.
  // It is a proposal until somebody with publish authority puts the story out.
  it("does not gate a date typed on a draft nobody has seen", () => {
    expect(resolveEditorialDateWrite({}, "2026-07-04")).toEqual({
      backdates: true,
      requiresPublishAuthority: false,
      fields: { date: "2026-07-04", editorialDateSource: "backdated" },
      error: null,
    });
  });

  it("gates the same edit once the post is public", () => {
    const publicDraftEdit = resolveEditorialDateWrite(
      { date: "2026-07-04", editorialDateSource: "backdated", publiclyVisible: true },
      "2026-07-05",
    );
    expect(publicDraftEdit.requiresPublishAuthority).toBe(true);
  });
});

describe("the whole story lifecycle", () => {
  it("moves a draft through first publish, revision, typo fix, and update", () => {
    let record: EditorialDateRecord = {};

    // Draft saved twice over a week. No date is presented at any point.
    expect(resolveDisplayDate(record)).toBeNull();
    record = { ...record, ...applyMeaningfulUpdate({ requested: false, at: SPRING_FORWARD_BEFORE, by: "uid" }) };
    expect(resolveDisplayDate(record)).toBeNull();

    // Scheduled publish completes just after the clocks jump forward.
    record = {
      ...record,
      ...applyFirstPublish(record, { at: SPRING_FORWARD_AFTER, by: "uid-editor" }),
      publiclyVisible: true,
    };
    expect(resolveDisplayDate(record)).toBe("2026-03-08");
    expect(resolveUpdateDisplay(record).show).toBe(false);

    // A typo fix, then a republish. Neither moves any date.
    record = {
      ...record,
      ...applyMeaningfulUpdate({ requested: false, at: AUG_14_MORNING_EDT, by: "uid-editor" }),
      ...applyFirstPublish(record, { at: AUG_14_MORNING_EDT, by: "uid-editor" }),
    };
    expect(record.firstPublishedAt).toBe(SPRING_FORWARD_AFTER);
    expect(resolveDisplayDate(record)).toBe("2026-03-08");
    expect(resolveUpdateDisplay(record).show).toBe(false);

    // A substantive rewrite, recorded deliberately and shown on the page.
    record = {
      ...record,
      ...applyMeaningfulUpdate({ requested: true, at: AUG_14_MORNING_EDT, by: "uid-editor" }),
      showUpdatedDate: true,
    };
    expect(resolveUpdateDisplay(record)).toEqual({
      show: true,
      at: AUG_14_MORNING_EDT,
      date: "2026-08-14",
    });
    expect(record.firstPublishedAt).toBe(SPRING_FORWARD_AFTER);
    expect(resolveDisplayDate(record)).toBe("2026-03-08");
  });
});
