// @vitest-environment node
import { describe, expect, it } from "vitest";
import dates from "./fixtures/home-sources/newscast-date-observations.json";
import fixture from "./fixtures/home-sources/newscast-documented-schema.json";
import {
  adaptLatestHomeNewscast, HOME_NEWSCAST_ASSETS_URL, HOME_NEWSCAST_PROGRAM_HREF,
  HOME_NEWSCAST_SHOW_ID, newscastTitleDate,
} from "../../packages/content-core/src/home-newscast-source";

const cutoffAt = "2026-10-11T15:00:00Z";
const receipt = { status: "ready" as const, source: "pbs_media_manager" as const,
  requestUrl: HOME_NEWSCAST_ASSETS_URL, checkedAt: "2026-10-11T14:30:00Z", complete: true, response: fixture };
const latestId = "a22562ab-3442-42e7-a9e4-192c2d0bd190";

describe("automatic approved Home newscast", () => {
  it("preserves the real episode date, metadata and approved public destinations", () => {
    expect(fixture.fixtureKind).toBe("documented-schema fixture, not a live MM response");
    const result = adaptLatestHomeNewscast(receipt, cutoffAt);
    expect(result).toMatchObject({ source: "pbs_media_manager", showId: HOME_NEWSCAST_SHOW_ID,
      showTitle: "NJ PBS News with Rob Nelson", programHref: HOME_NEWSCAST_PROGRAM_HREF,
      pastNewscastsHref: HOME_NEWSCAST_PROGRAM_HREF, liveHref: "/live/", checkedAt: receipt.checkedAt, emptyReason: null });
    expect(result.episode).toEqual({ id: latestId, episodeId: "eccc7cc0-b356-4040-b597-2186f495d309",
      title: "NJ PBS News with Rob Nelson | October 9, 2026", episodeDate: "2026-10-09", premieredOn: "2026-10-09",
      sequence: 7, durationSeconds: 1606, captioned: true,
      href: "https://watch.njpbs.org/video/nj-pbs-news-with-rob-nelson-october-9-2026-0oavxo/",
      playerSrc: "https://player.pbs.org/partnerplayer/3114511752/",
      poster: { url: "https://image.pbs.org/video-assets/servqn9-asset-mezzanine-16x9-yzVeG3B.png", alt: "" },
      publicWindow: { startsAt: "2018-07-25T04:00:00Z", endsAt: "2028-07-24T03:59:59Z", country: "US", platform: "bento" },
    });
    // Public portal metadata really has an October 8 episode premiered October 9.
    const october8 = fixture.data.find(item => item.attributes.title.endsWith("October 8, 2026"))!;
    expect(adaptLatestHomeNewscast({ ...receipt, response: { ...fixture, data: [october8] } }, cutoffAt).episode)
      .toMatchObject({ episodeDate: "2026-10-08", premieredOn: "2026-10-09" });
  });

  it("keeps the dated titles from seven live PBS episodes, independent of their premiere day", () => {
    for (const row of dates.observations) {
      const asset = structuredClone(fixture.data[0]);
      asset.attributes.title = row.assetTitle;
      asset.attributes.premiered_on = row.assetPremiere;
      asset.attributes.parent_tree.attributes.title = row.episodeTitle;
      const cutoff = "2026-10-16T15:00:00Z";
      const selected = adaptLatestHomeNewscast({ ...receipt, checkedAt: cutoff,
        response: { data: [asset], links: { next: null } } }, cutoff).episode;
      expect(selected?.episodeDate).toBe(row.broadcastDate);
      expect(selected?.title).toBe(row.assetTitle);
    }
  });

  it("selects an undated show by the PBS premiere day without displaying an air date", () => {
    // #3519: editors will remove the date suffix. October 14's real PBS
    // asset/episode premiered_on is October 15, not its title's broadcast day.
    const asset = structuredClone(fixture.data[0]);
    asset.attributes.title = "NJ PBS News with Rob Nelson";
    asset.attributes.parent_tree.attributes.title = asset.attributes.title;
    asset.attributes.premiered_on = dates.observations[0].assetPremiere;
    const cutoff = "2026-10-16T15:00:00Z";
    const response = { data: [asset, ...fixture.data.slice(1)], links: { next: null } };
    const selected = adaptLatestHomeNewscast({ ...receipt, checkedAt: cutoff, response }, cutoff).episode;
    expect(selected).toMatchObject({ title: "NJ PBS News with Rob Nelson",
      episodeDate: null, premieredOn: "2026-10-15" });
    for (const premiered_on of [undefined, "2026-02-30", "2026-10-17"]) {
      const invalid = { ...asset, attributes: { ...asset.attributes, premiered_on } };
      expect(adaptLatestHomeNewscast({ ...receipt, checkedAt: cutoff,
        response: { data: [invalid], links: { next: null } } }, cutoff).episode).toBeNull();
    }
  });

  it("rejects malformed dated titles instead of treating them as intentionally undated", () => {
    for (const title of ["NJ PBS News with Rob Nelson | Octber 9, 2026",
      "NJ PBS News with Rob Nelson | February 30, 2026", "Latest newscast"]) {
      const asset = structuredClone(fixture.data[0]);
      asset.attributes.title = title;
      asset.attributes.parent_tree.attributes.title = title;
      expect(adaptLatestHomeNewscast({ ...receipt,
        response: { data: [asset], links: { next: null } } }, cutoffAt).episode).toBeNull();
    }
  });

  it("keeps the approved HTTPS player for the protocol-relative iframe shape from #3499", () => {
    const response = structuredClone(fixture);
    response.data[0].attributes.player_code = "<iframe width='512' height='288' src='//player.pbs.org/partnerplayer/3114511752/?start=0&end=0&topbar=false&endscreen=true&autoplay=false&muted=true&tracking=discard' frameborder='0' allowfullscreen></iframe>";
    expect(adaptLatestHomeNewscast({ ...receipt, response }, cutoffAt).episode).toMatchObject({
      id: latestId,
      playerSrc: "https://player.pbs.org/partnerplayer/3114511752/?start=0&end=0&topbar=false&endscreen=true&autoplay=false&muted=true",
    });
  });

  it("selects by episode date across the complete catalog, independently of response order", () => {
    expect(adaptLatestHomeNewscast({ ...receipt, response: { ...fixture, data: [...fixture.data].reverse() } }, cutoffAt).episode?.id)
      .toBe(latestId);
    const dated = structuredClone(fixture);
    dated.data[0].attributes.premiered_on = "2026-10-10";
    expect(adaptLatestHomeNewscast({ ...receipt, response: dated }, cutoffAt).episode?.episodeDate).toBe("2026-10-09");
    expect(newscastTitleDate("NJ PBS News with Rob Nelson | February 30, 2026")).toBeNull();
    expect(newscastTitleDate("NJ Spotlight News | October 9, 2026")).toBeNull();
  });

  it("normalizes the catalog's established numeric-string ordinal variant", () => {
    const response = structuredClone(fixture);
    const parent = response.data[0].attributes.parent_tree.attributes;
    (parent as unknown as { ordinal: unknown }).ordinal = "7";
    expect(adaptLatestHomeNewscast({ ...receipt, response }, cutoffAt).episode)
      .toMatchObject({ id: latestId, sequence: 7 });
    for (const ordinal of ["", "not-a-number", "7.5", null, true]) {
      (parent as unknown as { ordinal: unknown }).ordinal = ordinal;
      expect(adaptLatestHomeNewscast({ ...receipt, response: { ...response, data: [response.data[0]] } }, cutoffAt).episode)
        .toBeNull();
    }
  });

  it("preserves explicitly open bounds while rejecting missing or malformed bounds", () => {
    const response = structuredClone(fixture);
    const grant = response.data[0].attributes.availabilities.public;
    Object.assign(grant, { start: null, end: null });
    expect(adaptLatestHomeNewscast({ ...receipt, response }, cutoffAt).episode)
      .toMatchObject({ id: latestId, publicWindow: { startsAt: null, endsAt: null } });
    for (const start of [undefined, "", "not-an-instant"]) {
      Object.assign(grant, { start });
      expect(adaptLatestHomeNewscast({ ...receipt, response: { ...response, data: [response.data[0]] } }, cutoffAt).episode)
        .toBeNull();
    }
  });

  it("admits the documented All Countries grant without trusting ambiguous empty country lists", () => {
    const response = structuredClone(fixture);
    const grant = response.data[0].attributes.availabilities.public;
    Object.assign(grant, { countries: [], geo_profile: null });
    expect(adaptLatestHomeNewscast({ ...receipt, response }, cutoffAt).episode?.id).toBe(latestId);
    for (const geo_profile of [undefined, {}, { name: "Canada" }]) {
      Object.assign(grant, { geo_profile });
      expect(adaptLatestHomeNewscast({ ...receipt, response: { ...response, data: [response.data[0]] } }, cutoffAt).episode)
        .toBeNull();
    }
  });

  it("requires full-length public US/Bento rights, the approved show, real dates, captions and safe art", () => {
    const badAttributes = [
      { object_type: "clip" }, { has_captions: false }, { duration: 0 },
      { title: "Latest newscast" }, { premiered_on: "2026-02-30" },
      { premiered_on: "2026-10-12" }, { slug: "https://example.test/redirect" },
      { platforms: [{ slug: "youtube" }] },
      { availabilities: { passport: fixture.data[0].attributes.availabilities.public } },
      { availabilities: { public: { ...fixture.data[0].attributes.availabilities.public, end: cutoffAt } } },
      { availabilities: { public: { ...fixture.data[0].attributes.availabilities.public, start: "2026-10-12T00:00:00Z" } } },
      { availabilities: { public: { ...fixture.data[0].attributes.availabilities.public, countries: [{ code: "CA" }] } } },
      { images: [{ profile: "asset-mezzanine-16x9", image: "https://example.test/poster.png" }] },
    ];
    for (const attributes of badAttributes) {
      const response = { ...fixture, data: [{ ...fixture.data[0], attributes: { ...fixture.data[0].attributes, ...attributes } }] };
      expect(adaptLatestHomeNewscast({ ...receipt, response }, cutoffAt))
        .toMatchObject({ episode: null, emptyReason: "no_eligible_episode", checkedAt: receipt.checkedAt });
    }
    const wrongShow = structuredClone(fixture.data[0]);
    wrongShow.attributes.parent_tree.attributes.season.attributes.show.id = "b22562ab-3442-42e7-a9e4-192c2d0bd190";
    expect(adaptLatestHomeNewscast({ ...receipt, response: { ...fixture, data: [wrongShow] } }, cutoffAt).episode).toBeNull();
    const wrongDate = structuredClone(fixture.data[0]);
    wrongDate.attributes.parent_tree.attributes.title = "NJ PBS News with Rob Nelson | October 12, 2026";
    wrongDate.attributes.title = wrongDate.attributes.parent_tree.attributes.title;
    expect(adaptLatestHomeNewscast({ ...receipt, response: { ...fixture, data: [wrongDate] } }, cutoffAt).episode).toBeNull();
  });

  it("distinguishes unavailable transport, incomplete responses, empty sources and withdrawal", () => {
    expect(adaptLatestHomeNewscast({ status: "error" }, cutoffAt, latestId))
      .toMatchObject({ episode: null, checkedAt: null, emptyReason: "source_error" });
    for (const snapshot of [{ ...receipt, complete: false }, { ...receipt, response: {} },
      { ...receipt, response: { ...fixture, links: { next: "https://media.services.pbs.org/api/v1/assets/?page=2" } } }]) {
      expect(adaptLatestHomeNewscast(snapshot, cutoffAt, latestId))
        .toMatchObject({ episode: null, checkedAt: null, emptyReason: "source_error" });
    }
    const empty = { ...receipt, response: { ...fixture, data: [] } };
    expect(adaptLatestHomeNewscast(empty, cutoffAt).emptyReason).toBe("source_empty");
    expect(adaptLatestHomeNewscast(empty, cutoffAt, latestId).emptyReason).toBe("withdrawn");
    expect(() => adaptLatestHomeNewscast({ ...receipt, requestUrl: "https://example.test/feed" }, cutoffAt)).toThrow();
    expect(() => adaptLatestHomeNewscast({ ...receipt, checkedAt: "2026-10-12T00:00:00Z" }, cutoffAt)).toThrow();
  });

  it("rejects ambiguous assets and detaches projected public fields", () => {
    const response = { ...fixture, data: [fixture.data[0], fixture.data[0]] };
    expect(adaptLatestHomeNewscast({ ...receipt, response }, cutoffAt).episode).toBeNull();
    const result = adaptLatestHomeNewscast(receipt, cutoffAt);
    result.episode!.poster.alt = "Modified output";
    expect(adaptLatestHomeNewscast(receipt, cutoffAt).episode!.poster.alt).toBe("");
    expect(result.episode).not.toHaveProperty("availabilities");
  });
});
