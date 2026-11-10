// @vitest-environment node

import { describe, expect, it } from "vitest";
import { shouldRefreshSchedule } from "../scripts/check-schedule-refresh.mjs";

const receipt = {
  generation: 181,
  buildBatchId: "cms-current",
  commitSha: "9022db93d66563370b4e280a35063324f9afaf0d",
};
const entry = {
  title: "NJ PBS News",
  startsAt: "2026-10-01T17:30:00-04:00",
  endsAt: "2026-10-01T18:00:00-04:00",
};
const feed = [{ date: "2026-10-01", entries: [{ ...entry, episodeTitle: "New" }] }];
const live = {
  publication: receipt,
  checkedAt: "2026-10-01T15:34:23.089Z",
  days: [{ date: "2026-10-01", callsign: "wnjt", entries: [entry] }],
};

describe("Schedule refresh check", () => {
  it("skips when title, start and end match in another time format", () => {
    expect(shouldRefreshSchedule(feed, {
      ...live,
      days: [{ ...live.days[0], entries: [{
        ...entry,
        startsAt: "2026-10-01T21:30:00Z",
        endsAt: "2026-10-01T22:00:00.000Z",
      }] }],
    }, receipt)).toBe(false);
  });

  it("queues when the feed moves a program", () => {
    expect(shouldRefreshSchedule([{ date: "2026-10-01", entries: [{
      ...entry,
      startsAt: "2026-10-01T19:00:00-04:00",
      endsAt: "2026-10-01T19:30:00-04:00",
    }] }], live, receipt)).toBe(true);
  });

  it("queues when the feed has a day the live page lacks", () => {
    expect(shouldRefreshSchedule([
      ...feed,
      { date: "2026-10-02", entries: [entry] },
    ], live, receipt)).toBe(true);
  });

  it("fails closed when the public schedule and receipt disagree", () => {
    expect(() => shouldRefreshSchedule(feed, live, {
      ...receipt,
      commitSha: "0".repeat(40),
    })).toThrow("live schedule receipt is invalid");
  });

  it("fails closed when both receipts lack a commit", () => {
    const partial = { generation: 181, buildBatchId: "cms-current" };
    expect(() => shouldRefreshSchedule(feed, { ...live, publication: partial }, partial))
      .toThrow("live schedule receipt is invalid");
  });

  it("fails closed on an invalid live entry even when another day changed", () => {
    expect(() => shouldRefreshSchedule([
      { date: "2026-10-02", entries: [entry] },
    ], {
      ...live,
      days: [{ ...live.days[0], entries: [{ ...entry, startsAt: "bad" }] }],
    }, receipt)).toThrow("live schedule receipt is invalid");
  });

  it("fails closed on a live entry without a usable time", () => {
    expect(() => shouldRefreshSchedule(feed, {
      ...live,
      days: [{ ...live.days[0], entries: [{ ...entry, endsAt: "bad" }] }],
    }, receipt)).toThrow("live schedule receipt is invalid");
  });
});
