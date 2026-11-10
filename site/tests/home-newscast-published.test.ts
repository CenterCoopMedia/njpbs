// @vitest-environment node
import { describe, expect, it } from "vitest";
import fixture from "./fixtures/home-sources/newscast-documented-schema.json";
import { adaptLatestHomeNewscast, HOME_NEWSCAST_ASSETS_URL } from "../../packages/content-core/src/home-newscast-source";
import { createHomeNewscastPacket, readHomeNewscastPacket, readPublishedHomeNewscast,
  resolveHomeNewscastPacket } from "../../packages/content-core/src/home-newscast-published";

const cutoffAt = "2026-10-11T15:00:00Z";
const source = () => adaptLatestHomeNewscast({ status: "ready", source: "pbs_media_manager", requestUrl: HOME_NEWSCAST_ASSETS_URL,
  checkedAt: cutoffAt, complete: true, response: fixture }, cutoffAt);
describe("closed retained automatic newscast packet", () => {
  it("round-trips only public episode fields, independently of other library cards and raw provider siblings", () => {
    const original = source(), packet = createHomeNewscastPacket(original);
    expect(readHomeNewscastPacket(JSON.parse(JSON.stringify(packet)))).toEqual(packet);
    expect(resolveHomeNewscastPacket(packet, cutoffAt)).toEqual(original);
    expect(packet).not.toHaveProperty("cutoffAt");
    expect(packet).not.toHaveProperty("requestUrl");
    expect(packet.episode).not.toHaveProperty("availabilities");
    expect(packet.episode?.episodeDate).toBe("2026-10-09");
    expect(packet.episode?.href).toBe("https://watch.njpbs.org/video/nj-pbs-news-with-rob-nelson-october-9-2026-0oavxo/");
  });
  it("round-trips an undated editor title without assigning a broadcast date", () => {
    const original = source();
    original.episode!.title = "NJ PBS News with Rob Nelson";
    original.episode!.episodeDate = null;
    expect(readPublishedHomeNewscast(original).episode?.title).toBe("NJ PBS News with Rob Nelson");
    const packet = createHomeNewscastPacket(original);
    expect(resolveHomeNewscastPacket(JSON.parse(JSON.stringify(packet)), cutoffAt)).toEqual(original);
    expect(() => readPublishedHomeNewscast({ ...original,
      episode: { ...original.episode!, episodeDate: "2026-10-08" } })).toThrow();
    for (const title of ["", "two\nlines", "x".repeat(301),
      "NJ PBS News with Rob Nelson | Octber 9, 2026"]) {
      expect(() => readPublishedHomeNewscast({ ...original, episode: { ...original.episode!, title } })).toThrow();
    }
  });
  it("expires only the frozen episode at the public-window boundary without selecting another program or episode", () => {
    const packet = createHomeNewscastPacket(source());
    expect(resolveHomeNewscastPacket(packet, "2028-07-24T03:59:58Z").episode?.id).toBe(packet.episode?.id);
    expect(resolveHomeNewscastPacket(packet, "2028-07-24T03:59:59Z")).toMatchObject({ episode: null, emptyReason: "withdrawn",
      checkedAt: packet.checkedAt, liveHref: "/live/", pastNewscastsHref: packet.pastNewscastsHref });
    expect(packet.episode).not.toBeNull();
    expect(() => resolveHomeNewscastPacket(packet, "2026-10-10T15:00:00Z")).toThrow();
  });
  it("refuses extra/private fields, wrong source/program, unsafe destinations, fabricated dates and incomplete rights", () => {
    const original = source();
    const bad = [
      { ...original, authorization: "PRIVATE fixture" }, { ...original, showId: "other" },
      { ...original, liveHref: "https://example.test/" }, { ...original, checkedAt: "2026-10-12T00:00:00Z" },
      { ...original, episode: { ...original.episode!, href: "javascript:alert(1)" } },
      { ...original, episode: { ...original.episode!, episodeDate: "2026-10-08" } },
      { ...original, episode: { ...original.episode!, captioned: false } },
      { ...original, episode: { ...original.episode!, poster: { url: "https://private.example.test/art", alt: "" } } },
      { ...original, episode: { ...original.episode!, publicWindow: { ...original.episode!.publicWindow, country: "CA" } } },
      { ...original, episode: { ...original.episode!, publicWindow: { ...original.episode!.publicWindow, endsAt: cutoffAt } } },
      { ...original, episode: { ...original.episode!, raw: fixture.data[0] } },
      Object.create(original),
    ];
    for (const value of bad) expect(() => readPublishedHomeNewscast(value)).toThrow();
    const packet = createHomeNewscastPacket(original);
    expect(() => readHomeNewscastPacket({ ...packet, cutoffAt })).toThrow();
    expect(() => readHomeNewscastPacket({ ...packet, requestUrl: HOME_NEWSCAST_ASSETS_URL })).toThrow();
  });
  it("retains a truthful source-error envelope with no provider observation or episode", () => {
    const packet = createHomeNewscastPacket(adaptLatestHomeNewscast({ status: "error" }, cutoffAt));
    expect(resolveHomeNewscastPacket(packet, cutoffAt)).toMatchObject({ episode: null, checkedAt: null, emptyReason: "source_error", cutoffAt });
  });
  it("round-trips old retained episodes without adding a player and refuses unsafe new player fields", () => {
    const original = source();
    const { playerSrc: _player, ...oldEpisode } = original.episode!;
    const old = { ...original, episode: oldEpisode };
    expect(readPublishedHomeNewscast(JSON.parse(JSON.stringify(old)))).toEqual(old);
    for (const playerSrc of [null, "javascript:alert(1)", "https://player.pbs.org.evil.test/partnerplayer/3114511752/",
      "https://player.pbs.org/partnerplayer/3114511752/?tracking=private", '<iframe src="https://player.pbs.org/partnerplayer/3114511752/"></iframe>']) {
      expect(() => readPublishedHomeNewscast({ ...original, episode: { ...original.episode!, playerSrc } })).toThrow();
    }
  });
  it("retains only a bounded optional public short description across the provider and packet boundary", () => {
    // Media Manager observation, October 14, 2026, 9:28 PM EDT, October 13 asset.
    const summary = "NJ Transit disruptions, campus consent concerns and a critical Newark schools audit.";
    const response = structuredClone(fixture);
    Object.assign(response.data[0].attributes, { description_short: summary });
    const selected = adaptLatestHomeNewscast({ status: "ready", source: "pbs_media_manager", requestUrl: HOME_NEWSCAST_ASSETS_URL,
      checkedAt: cutoffAt, complete: true, response }, cutoffAt);
    expect(readHomeNewscastPacket(createHomeNewscastPacket(selected)).episode?.summary).toBe(summary);
    expect(source().episode).not.toHaveProperty("summary");
    for (const invalid of [" ", "two\nlines", "x".repeat(2001), null]) {
      Object.assign(response.data[0].attributes, { description_short: invalid });
      expect(adaptLatestHomeNewscast({ status: "ready", source: "pbs_media_manager", requestUrl: HOME_NEWSCAST_ASSETS_URL,
        checkedAt: cutoffAt, complete: true, response }, cutoffAt).episode).not.toHaveProperty("summary");
      expect(() => readPublishedHomeNewscast({ ...selected, episode: { ...selected.episode!, summary: invalid } })).toThrow();
    }
  });
});
