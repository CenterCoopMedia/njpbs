import { beforeEach, describe, expect, it } from "vitest";
import { renderScheduleNowNextFrame } from "../src/lib/schedule-now-next-render";
import type { ScheduleFeedDay, ScheduleListing } from "../src/lib/schedule-feed.ts";
import { millisecondsToNextMinute, readNowNextDays, renderScheduleNowNext, resolveNowNextClock } from "../src/lib/schedule-now-next-dom.ts";

function listing(
  title: string,
  startsAt: string,
  endsAt: string,
  episodeTitle?: string,
): ScheduleListing {
  return {
    title,
    startsAt,
    endsAt,
    ...(episodeTitle ? { episodeTitle } : {}),
    seasonNumber: null,
    episodeNumber: null,
    nolaRoot: null,
    programId: null,
    programExternalId: null,
    cid: null,
    isKids: false,
    feedKind: "broadcast",
  };
}

const nature = listing(
  "Nature",
  "2026-07-10T20:00:00-04:00",
  "2026-07-10T20:30:00-04:00",
  "Wild hope",
);
const nova = listing(
  "Nova",
  "2026-07-10T20:30:00-04:00",
  "2026-07-10T21:00:00-04:00",
);
const frontline = listing(
  "Frontline",
  "2026-07-10T21:30:00-04:00",
  "2026-07-10T22:00:00-04:00",
);
const days: readonly ScheduleFeedDay[] = [
  {
    date: "2026-07-10",
    callsign: "wnjt",
    kind: "broadcast",
    feedCid: "test-feed",
    timeZone: "America/New_York",
    entries: [nature, nova, frontline],
  },
];

function mount(data: string | null = JSON.stringify(days), variant: "full" | "compact" = "full"): HTMLElement {
  document.body.innerHTML = `
    ${renderScheduleNowNextFrame(variant)}
    ${data === null ? "" : `<script type="application/json" data-now-next-data>${data}</script>`}
  `;
  return document.querySelector<HTMLElement>("[data-now-next]")!;
}

const text = (root: HTMLElement, selector: string) =>
  root.querySelector<HTMLElement>(selector)?.textContent;

describe("schedule now-next DOM adapter", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("reads only an adjacent serialized day array", () => {
    const root = mount();
    expect(readNowNextDays(root)).toEqual(days);

    expect(readNowNextDays(mount(null))).toBeNull();
    expect(readNowNextDays(mount("{"))).toBeNull();
    expect(readNowNextDays(mount('{"days":[]}'))).toBeNull();
  });

  it("fixes a valid absolute mock and clones real time for invalid overrides", () => {
    const realNow = new Date("2026-07-10T12:00:00-04:00");
    const mocked = resolveNowNextClock(
      "?mock-time=2026-07-10T20%3A15%3A00-04%3A00",
      realNow,
    );
    expect(mocked.fixed).toBe(true);
    expect(mocked.at.toISOString()).toBe("2026-07-11T00:15:00.000Z");

    for (const search of ["", "?mock-time=invalid", "?mock-time=2026-07-10T20:15:00"]) {
      const result = resolveNowNextClock(search, realNow);
      expect(result.fixed).toBe(false);
      expect(result.at).not.toBe(realNow);
      expect(result.at.getTime()).toBe(realNow.getTime());
    }
  });

  it("renders mid-program text, ET ranges, progress, and aria values", () => {
    for (const variant of ["full", "compact"] as const) {
      const root = mount(JSON.stringify(days), variant);
      expect(root.dataset.nowNextVariant).toBe(variant);
      expect(root.querySelector('a[href="/live/"]') !== null).toBe(variant === "full");
      expect(root.querySelector('a[href="/schedule/"]') !== null).toBe(true);
      expect(root.querySelector("[data-now-next-gap-link]") !== null).toBe(variant === "full");
      expect(
        renderScheduleNowNext(root, days, new Date("2026-07-10T20:15:00-04:00")),
      ).toBe(true);

      expect(text(root, "[data-now-next-current-program]")).toBe(
        "Nature — Wild hope",
      );
      expect(text(root, "[data-now-next-current-time]")).toBe(
        "8:00 p.m.–8:30 p.m. ET",
      );
      expect(text(root, "[data-now-next-up-next-program]")).toBe("Nova");
      expect(text(root, "[data-now-next-up-next-time]")).toBe(
        "8:30 p.m.–9:00 p.m. ET",
      );
      expect(text(root, "[data-now-next-elapsed]")).toBe("15 min elapsed");
      expect(text(root, "[data-now-next-remaining]")).toBe("15 min remaining");

      const progress = root.querySelector<HTMLElement>("[data-now-next-progress]")!;
      expect(progress.getAttribute("role")).toBe("progressbar");
      expect(progress.getAttribute("aria-valuemin")).toBe("0");
      expect(progress.getAttribute("aria-valuemax")).toBe("30");
      expect(progress.getAttribute("aria-valuenow")).toBe("15");
      expect(progress.getAttribute("aria-valuetext")).toBe(
        "15 minutes elapsed; 15 minutes remaining",
      );
      expect(progress.style.getPropertyValue("--now-next-progress")).toBe("50%");
      expect(root.querySelector<HTMLElement>("[data-now-next-fallback]")!.hidden).toBe(true);
      expect(root.querySelector<HTMLElement>("[data-now-next-ready]")!.hidden).toBe(false);
    }
  });

  it("hands off exactly at a listing boundary", () => {
    const root = mount();
    renderScheduleNowNext(root, days, new Date("2026-07-10T20:30:00-04:00"));

    expect(text(root, "[data-now-next-current-program]")).toBe("Nova");
    expect(text(root, "[data-now-next-up-next-program]")).toBe("Frontline");
    expect(text(root, "[data-now-next-elapsed]")).toBe("0 min elapsed");
  });

  it("shows exact gap copy, preserves up next, and reveals the gap link", () => {
    const root = mount();
    expect(
      renderScheduleNowNext(root, days, new Date("2026-07-10T21:15:00-04:00")),
    ).toBe(true);

    expect(text(root, "[data-now-next-current-program]")).toBe(
      "Current listing unavailable",
    );
    expect(text(root, "[data-now-next-up-next-program]")).toBe("Frontline");
    expect(root.querySelector<HTMLElement>("[data-now-next-gap-link]")!.hidden).toBe(false);
    expect(text(root, "[data-now-next-elapsed]")).toBe("0 min elapsed");
    expect(text(root, "[data-now-next-remaining]")).toBe("0 min remaining");
    const progress = root.querySelector<HTMLElement>("[data-now-next-progress]")!;
    expect(progress.getAttribute("aria-valuenow")).toBe("0");
    expect(progress.style.getPropertyValue("--now-next-progress")).toBe("0%");
  });

  it("fails closed to the fallback outside the baked range", () => {
    const root = mount();
    expect(
      renderScheduleNowNext(root, days, new Date("2026-07-11T20:15:00-04:00")),
    ).toBe(false);

    expect(root.querySelector<HTMLElement>("[data-now-next-fallback]")!.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>("[data-now-next-ready]")!.hidden).toBe(true);
    expect(text(root, "[data-now-next-fallback-message]")).toBe(
      "Current live program details are unavailable.",
    );
  });

  it("computes the next minute boundary without a live timer", () => {
    expect(millisecondsToNextMinute(0)).toBe(60_000);
    expect(millisecondsToNextMinute(60_000)).toBe(60_000);
    expect(millisecondsToNextMinute(60_001)).toBe(59_999);
    expect(millisecondsToNextMinute(119_999)).toBe(1);
  });
});
