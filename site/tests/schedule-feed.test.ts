// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PBS_KIDS_NOLA_ROOTS,
  TVSS_WNJT_FEED_CID,
  shapeTvssScheduleDay,
  unwrapTvssJsonp,
  type ScheduleFeedKind,
} from "../src/lib/schedule-feed.ts";

const fixtureText = readFileSync(
  new URL("./fixtures/tvss-wnjt-20260710.jsonp", import.meta.url),
  "utf8",
);

const fixturePayload = () => unwrapTvssJsonp(fixtureText);

describe("unwrapTvssJsonp", () => {
  it("unwraps the named callback and returns its object payload", () => {
    const payload = unwrapTvssJsonp('cb({"headends":[]});');

    expect(payload).toEqual({ headends: [] });
  });

  it("rejects a different callback instead of evaluating arbitrary script", () => {
    expect(() => unwrapTvssJsonp('other({"headends":[]})')).toThrow(
      /callback/i,
    );
  });

  it("rejects malformed JSON inside the callback", () => {
    expect(() => unwrapTvssJsonp("cb({headends:[]})")).toThrow(/JSON/i);
  });
});

describe("shapeTvssScheduleDay", () => {
  it("selects the Broadcast WNJTDT feed by cid and maps a normal listing", () => {
    const day = shapeTvssScheduleDay(fixturePayload(), {
      date: "2026-07-10",
      kind: "broadcast",
    });

    expect(day).toMatchObject({
      date: "2026-07-10",
      callsign: "wnjt",
      kind: "broadcast",
      feedCid: TVSS_WNJT_FEED_CID,
      timeZone: "America/New_York",
    });
    expect(day.entries[0]).toEqual({
      startsAt: "2026-07-10T01:00:00-04:00",
      endsAt: "2026-07-10T02:00:00-04:00",
      title: "Gods of Tennis",
      episodeTitle: "Billie Jean King and Arthur Ashe",
      description:
        "How the golden age of tennis in the 70s and 80s changed the game forever.",
      hd: true,
      closedCaptions: true,
      seasonNumber: 1,
      episodeNumber: 1,
      airingType: "Taped",
      nolaRoot: "GOTE",
      programId: 57_904,
      programExternalId: "SH049708030000",
      cid: "9db2a277-e276-4ba5-bcf7-96931f981f38",
      kids: false,
      isKids: false,
      feedKind: "broadcast",
    });
  });

  it("preserves stable program and listing identifiers", () => {
    const day = shapeTvssScheduleDay(fixturePayload(), {
      date: "2026-07-10",
      kind: "broadcast",
    });

    expect(day.entries[0]).toMatchObject({
      programId: 57_904,
      programExternalId: "SH049708030000",
      cid: "9db2a277-e276-4ba5-bcf7-96931f981f38",
    });
  });

  function shapeFirstBroadcastListing(fields: Record<string, unknown>) {
    const payload = structuredClone(fixturePayload()) as {
      headends: Array<{
        name: string;
        feeds: Array<{
          short_name: string;
          listings: Array<Record<string, unknown>>;
        }>;
      }>;
    };
    const target = payload.headends
      .find(({ name }) => name === "Broadcast")
      ?.feeds.find(({ short_name }) => short_name === "WNJTDT")?.listings[0];
    if (!target) throw new Error("Fixture is missing the first WNJTDT listing");
    Object.assign(target, fields);
    return shapeTvssScheduleDay(payload, {
      date: "2026-07-10",
      kind: "broadcast",
    }).entries[0];
  }

  const contaminatedOnStoryFields = {
    episode_title:
      "Gun and Powder'' at Paper Mill Playhouse, Architect Edward T. Bowser, Jr. &",
    program_external_id: "SH014081970000",
    cid: "86e58e7f-f313-42cd-a105-274eb900b8df",
  } as const;

  it("omits the known cross-program On Story episode title", () => {
    const entry = shapeFirstBroadcastListing({
      title: "On Story: The Austin Film Festival Presents",
      ...contaminatedOnStoryFields,
    });

    expect(entry.title).toBe("On Story: The Austin Film Festival Presents");
    expect(entry.episodeTitle).toBeUndefined();
  });

  it.each([
    [
      "listing cid",
      { cid: "different-listing" },
      contaminatedOnStoryFields.episode_title,
    ],
    [
      "program identifier",
      { program_external_id: "SH000000000000" },
      contaminatedOnStoryFields.episode_title,
    ],
    [
      "source title",
      { episode_title: "A corrected On Story title" },
      "A corrected On Story title",
    ],
  ])(
    "keeps an On Story title when the %s differs",
    (_field, override, expected) => {
      const entry = shapeFirstBroadcastListing({
        ...contaminatedOnStoryFields,
        ...override,
      });

      expect(entry.episodeTitle).toBe(expected);
    },
  );

  // The viewer complaint this exists for (2026-08-03, forwarded via Stefanie): the
  // grid names the series and nothing else, so there is no way to tell which Nature
  // is on tonight without tuning in. TVSS carries the answer in episode_description
  // and the parser was not reading it.
  describe("episode_description", () => {
    function withListing(fields: Record<string, unknown>) {
      const payload = structuredClone(fixturePayload()) as {
        headends: Array<{
          name: string;
          feeds: Array<{
            short_name: string;
            listings: Array<Record<string, unknown>>;
          }>;
        }>;
      };
      const target = payload.headends
        .find(({ name }) => name === "Broadcast")
        ?.feeds.find(({ short_name }) => short_name === "WNJTDT")
        ?.listings[0];
      if (!target) throw new Error("Fixture is missing the first WNJTDT listing");
      Object.assign(target, fields);
      return shapeTvssScheduleDay(payload, {
        date: "2026-07-10",
        kind: "broadcast",
      }).entries[0];
    }

    it("carries an airing's own synopsis through", () => {
      expect(
        withListing({
          description: "Documentaries about animals and ecosystems.",
          episode_description:
            "Seven animal songs, from the largest lemur to the humpback whale.",
        }).episodeDescription,
      ).toBe("Seven animal songs, from the largest lemur to the humpback whale.");
    });

    // Gracenote fills the episode field with the series text for a daily interview or
    // news strip. Passing that through would print the same sentence twice under one
    // program, which reads as a rendering bug rather than as information.
    it("drops a synopsis that only repeats the series blurb", () => {
      expect(
        withListing({
          description: "Christiane Amanpour leads discussions about world issues.",
          episode_description:
            "Christiane Amanpour leads discussions about world issues.",
        }).episodeDescription,
      ).toBeUndefined();
    });

    it("treats spacing and casing differences as the same blurb", () => {
      expect(
        withListing({
          description: "Steve Adubato interviews newsmakers.",
          episode_description: "  steve adubato   interviews newsmakers. ",
        }).episodeDescription,
      ).toBeUndefined();
    });

    // Omitted rather than serialized as an empty string, matching episodeTitle, so a
    // render surface can test the field's presence instead of its emptiness.
    it("omits the field when the feed carries nothing or only whitespace", () => {
      for (const value of ["", "   "]) {
        expect("episodeDescription" in withListing({ episode_description: value })).toBe(
          false,
        );
      }
      expect("episodeDescription" in withListing({})).toBe(false);
    });

    // A program with no series blurb still gets its synopsis: the comparison is with
    // what the viewer would otherwise read, and an absent blurb is not it.
    it("keeps the synopsis when there is no series blurb to compare against", () => {
      const entry = withListing({
        description: undefined,
        episode_description: "A one-off documentary about the Pine Barrens.",
      });

      expect(entry.description).toBeUndefined();
      expect(entry.episodeDescription).toBe(
        "A one-off documentary about the Pine Barrens.",
      );
    });
  });

  it("normalizes absent program and listing identifiers to null", () => {
    const payload = structuredClone(fixturePayload()) as {
      headends: Array<{
        name: string;
        feeds: Array<{
          short_name: string;
          listings: Array<Record<string, unknown>>;
        }>;
      }>;
    };
    const target = payload.headends
      .find(({ name }) => name === "Broadcast")
      ?.feeds.find(({ short_name }) => short_name === "WNJTDT")
      ?.listings[0];
    if (!target) throw new Error("Fixture is missing the first WNJTDT listing");
    Reflect.deleteProperty(target, "program_id");
    Reflect.deleteProperty(target, "program_external_id");
    Reflect.deleteProperty(target, "cid");

    const day = shapeTvssScheduleDay(payload, {
      date: "2026-07-10",
      kind: "broadcast",
    });

    expect(day.entries[0]).toMatchObject({
      programId: null,
      programExternalId: null,
      cid: null,
    });
  });

  it.each([
    ["program_external_id", 123],
    ["cid", false],
    ["program_external_id", " "],
  ])("rejects a malformed present %s", (field, value) => {
    const payload = structuredClone(fixturePayload()) as {
      headends: Array<{
        name: string;
        feeds: Array<{
          short_name: string;
          listings: Array<Record<string, unknown>>;
        }>;
      }>;
    };
    const target = payload.headends
      .find(({ name }) => name === "Broadcast")
      ?.feeds.find(({ short_name }) => short_name === "WNJTDT")
      ?.listings[0];
    if (!target) throw new Error("Fixture is missing the first WNJTDT listing");
    target[field] = value;

    expect(() =>
      shapeTvssScheduleDay(payload, {
        date: "2026-07-10",
        kind: "broadcast",
      }),
    ).toThrow(new RegExp(`${field}.*nonblank string`, "i"));
  });

  it("falls back to WNJTDT short_name when the documented cid is absent", () => {
    const payload = structuredClone(fixturePayload()) as {
      headends: Array<{
        name: string;
        feeds: Array<{ cid: string; short_name: string }>;
      }>;
    };
    const target = payload.headends
      .find(({ name }) => name === "Broadcast")
      ?.feeds.find(({ short_name }) => short_name === "WNJTDT");
    if (!target) throw new Error("Fixture is missing the WNJTDT feed");
    target.cid = "replacement-feed-cid";

    const day = shapeTvssScheduleDay(payload, {
      date: "2026-07-10",
      kind: "broadcast",
    });

    expect(day.feedCid).toBe("replacement-feed-cid");
    expect(day.entries[0]?.title).toBe("Gods of Tennis");
  });

  it("derives the last listing end on the following broadcast date", () => {
    const day = shapeTvssScheduleDay(fixturePayload(), {
      date: "2026-07-10",
      kind: "broadcast",
    });

    expect(day.entries.at(-1)).toMatchObject({
      startsAt: "2026-07-10T23:30:00-04:00",
      endsAt: "2026-07-11T00:00:00-04:00",
      title: "BBC News",
    });
  });

  it("uses the winter New York offset without reading the host time zone", () => {
    const payload = {
      headends: [
        {
          name: "Broadcast",
          feeds: [
            {
              cid: TVSS_WNJT_FEED_CID,
              short_name: "WNJTDT",
              timezone: "America/New_York",
              listings: [
                {
                  start_time: "2000",
                  duration: 100,
                  title: "Nature",
                },
              ],
            },
          ],
        },
      ],
    };

    const day = shapeTvssScheduleDay(payload, {
      date: "2026-01-10",
      kind: "broadcast",
    });

    expect(day.entries[0]).toMatchObject({
      startsAt: "2026-01-10T20:00:00-05:00",
      endsAt: "2026-01-10T21:00:00-05:00",
    });
  });

  it("rejects a nonexistent spring-forward start instead of shifting it", () => {
    const payload = {
      headends: [
        {
          name: "Broadcast",
          feeds: [
            {
              cid: TVSS_WNJT_FEED_CID,
              short_name: "WNJTDT",
              listings: [
                { start_time: "0200", duration: 30, title: "Missing hour" },
              ],
            },
          ],
        },
      ],
    };

    expect(() =>
      shapeTvssScheduleDay(payload, {
        date: "2026-03-08",
        kind: "broadcast",
      }),
    ).toThrow(/does not exist/i);
  });

  it("uses both offsets for repeated fall-back start times in feed order", () => {
    const payload = {
      headends: [
        {
          name: "Broadcast",
          feeds: [
            {
              cid: TVSS_WNJT_FEED_CID,
              short_name: "WNJTDT",
              listings: [
                { start_time: "0130", duration: 100, title: "First 1:30" },
                { start_time: "0130", duration: 100, title: "Second 1:30" },
              ],
            },
          ],
        },
      ],
    };

    const day = shapeTvssScheduleDay(payload, {
      date: "2026-11-01",
      kind: "broadcast",
    });

    expect(day.entries).toMatchObject([
      {
        startsAt: "2026-11-01T01:30:00-04:00",
        endsAt: "2026-11-01T01:30:00-05:00",
        title: "First 1:30",
      },
      {
        startsAt: "2026-11-01T01:30:00-05:00",
        endsAt: "2026-11-01T02:30:00-05:00",
        title: "Second 1:30",
      },
    ]);
  });

  it("uses the same mapper for kids and carries the airing classification", () => {
    const kind: ScheduleFeedKind = "kids";
    const day = shapeTvssScheduleDay(fixturePayload(), {
      date: "2026-07-10",
      kind,
    });

    expect(day.kind).toBe("kids");
    expect(day.entries.map(({ kids }) => kids)).toEqual([
      false,
      true,
      false,
      true,
      false,
    ]);
    expect(day.entries.every(({ feedKind }) => feedKind === "kids")).toBe(
      true,
    );
  });

  it("marks a listing as kids when the feed boolean is true", () => {
    const day = shapeTvssScheduleDay(fixturePayload(), {
      date: "2026-07-10",
      kind: "kids",
    });
    const listing = day.entries.find(({ title }) => title === "Wild Kratts");

    expect(listing).toMatchObject({
      kids: true,
      nolaRoot: "WILK",
      isKids: true,
    });
  });

  it("honors a true boolean on any feed without an allowlisted root", () => {
    const payload = structuredClone(fixturePayload()) as {
      headends: Array<{
        name: string;
        feeds: Array<{
          short_name: string;
          listings: Array<{
            title: string;
            kids?: boolean;
            nola_root?: string;
          }>;
        }>;
      }>;
    };
    const target = payload.headends
      .find(({ name }) => name === "Broadcast")
      ?.feeds.find(({ short_name }) => short_name === "WNJTDT")
      ?.listings.find(({ title }) => title === "Gods of Tennis");
    if (!target) throw new Error("Fixture is missing Gods of Tennis");
    target.kids = true;
    target.nola_root = "GOTE";

    const day = shapeTvssScheduleDay(payload, {
      date: "2026-07-10",
      kind: "broadcast",
    });
    const listing = day.entries.find(({ title }) => title === "Gods of Tennis");

    expect(listing).toMatchObject({
      kids: true,
      nolaRoot: "GOTE",
      isKids: true,
    });
  });

  it("marks an under-flagged allowlisted NOLA root as kids", () => {
    const day = shapeTvssScheduleDay(fixturePayload(), {
      date: "2026-07-10",
      kind: "kids",
    });
    const listing = day.entries.find(
      ({ title }) => title === "Weather Hunters",
    );

    expect(PBS_KIDS_NOLA_ROOTS.has("WEHU")).toBe(true);
    expect(listing).toMatchObject({
      kids: false,
      nolaRoot: "WEHU",
      isKids: true,
    });
  });

  it("marks the Arthur Thanksgiving special as kids when TVSS under-flags it", () => {
    const listing = shapeFirstBroadcastListing({
      title: "An Arthur Thanksgiving",
      kids: false,
      nola_root: "ATHA",
    });

    expect(listing).toMatchObject({ kids: false, isKids: true });
  });

  it("marks The Day You Begin as kids when TVSS under-flags it", () => {
    const payload = structuredClone(fixturePayload()) as {
      headends: Array<{
        name: string;
        feeds: Array<{
          short_name: string;
          listings: Array<{
            title: string;
            kids?: boolean;
            nola_root?: string;
          }>;
        }>;
      }>;
    };
    const target = payload.headends
      .find(({ name }) => name === "Broadcast")
      ?.feeds.find(({ short_name }) => short_name === "WNJTDT")
      ?.listings.find(({ title }) => title === "Gods of Tennis");
    if (!target) throw new Error("Fixture is missing Gods of Tennis");
    target.title = "The Day You Begin";
    target.kids = false;
    target.nola_root = "TDYB";

    const day = shapeTvssScheduleDay(payload, {
      date: "2026-07-10",
      kind: "broadcast",
    });
    const listing = day.entries.find(
      ({ title }) => title === "The Day You Begin",
    );

    expect(PBS_KIDS_NOLA_ROOTS.has("TDYB")).toBe(true);
    expect(listing).toMatchObject({
      kids: false,
      nolaRoot: "TDYB",
      isKids: true,
    });
  });

  it("marks the Sesame Street storm special as kids when TVSS under-flags it", () => {
    const payload = structuredClone(fixturePayload()) as {
      headends: Array<{
        name: string;
        feeds: Array<{
          short_name: string;
          listings: Array<{
            title: string;
            kids?: boolean;
            nola_root?: string;
          }>;
        }>;
      }>;
    };
    const target = payload.headends
      .find(({ name }) => name === "Broadcast")
      ?.feeds.find(({ short_name }) => short_name === "WNJTDT")
      ?.listings.find(({ title }) => title === "Gods of Tennis");
    if (!target) throw new Error("Fixture is missing Gods of Tennis");
    target.title = "Storm on Sesame Street";
    target.kids = false;
    target.nola_root = "BGSS";

    const day = shapeTvssScheduleDay(payload, {
      date: "2026-08-06",
      kind: "kids",
    });
    const listing = day.entries.find(
      ({ title }) => title === "Storm on Sesame Street",
    );

    expect(PBS_KIDS_NOLA_ROOTS.has("BGSS")).toBe(true);
    expect(listing).toMatchObject({
      kids: false,
      nolaRoot: "BGSS",
      isKids: true,
    });
  });

  it("does not mark a listing as kids without either signal", () => {
    const day = shapeTvssScheduleDay(fixturePayload(), {
      date: "2026-07-10",
      kind: "kids",
    });
    const listing = day.entries.find(({ title }) => title === "Gods of Tennis");

    expect(listing).toMatchObject({
      kids: false,
      nolaRoot: "GOTE",
      isKids: false,
    });
  });

  it("keeps a valid kids response when that day has no kids airings", () => {
    const payload = structuredClone(fixturePayload()) as {
      headends: Array<{
        name: string;
        feeds: Array<{
          short_name: string;
          listings: Array<{ kids?: boolean }>;
        }>;
      }>;
    };
    const target = payload.headends
      .find(({ name }) => name === "Broadcast")
      ?.feeds.find(({ short_name }) => short_name === "WNJTDT");
    if (!target) throw new Error("Fixture is missing the WNJTDT feed");
    target.listings.forEach((listing) => {
      listing.kids = false;
    });

    const day = shapeTvssScheduleDay(payload, {
      date: "2026-07-11",
      kind: "kids",
    });

    expect(day.entries).toHaveLength(5);
    expect(day.entries.every(({ kids }) => kids === false)).toBe(true);
  });

  it("rejects an empty selected day so the bake cannot overwrite good data", () => {
    const payload = fixturePayload() as {
      headends: Array<{
        name: string;
        feeds: Array<{ short_name: string; listings: unknown[] }>;
      }>;
    };
    const target = payload.headends
      .find(({ name }) => name === "Broadcast")
      ?.feeds.find(({ short_name }) => short_name === "WNJTDT");
    if (!target) throw new Error("Fixture is missing the WNJTDT feed");
    target.listings = [];

    expect(() =>
      shapeTvssScheduleDay(payload, {
        date: "2026-07-10",
        kind: "broadcast",
      }),
    ).toThrow(/no listings/i);
  });
});
