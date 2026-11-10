import { describe, expect, it } from "vitest";
import { watchDeliveryTypes, watchOptions } from "../src/data/watch-options";
import {
  defaultWatchDirectoryState,
  filterWatchOptions,
  parseWatchDirectoryState,
  serializeWatchDirectoryState,
  sortWatchOptions,
  uniqueWatchValues,
} from "../src/lib/watch-directory";

describe("watch directory inventory", () => {
  it("keeps the approved 28 entries in the supported delivery groups", () => {
    expect(watchOptions).toHaveLength(28);
    expect(watchDeliveryTypes.map((delivery) => delivery.id)).toEqual([
      "ota",
      "cable",
      "fiber-iptv",
      "satellite",
      "ott-live",
      "free-streaming",
      "svod",
    ]);
    expect(Object.fromEntries(watchDeliveryTypes.map(({ id }) => [
      id,
      watchOptions.filter((option) => option.delivery === id).length,
    ]))).toEqual({
      ota: 7,
      cable: 9,
      "fiber-iptv": 3,
      satellite: 4,
      "ott-live": 1,
      "free-streaming": 3,
      svod: 1,
    });
  });

  it("uses stable unique ids and complete verification metadata", () => {
    expect(new Set(watchOptions.map((option) => option.id)).size).toBe(watchOptions.length);
    for (const option of watchOptions) {
      expect(option.provider).not.toBe("");
      expect(option.area).not.toBe("");
      expect(option.channel).not.toBe("");
      expect(option.verification.source).not.toBe("");
      expect(option.verification.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (option.url) expect(new URL(option.url).protocol).toBe("https:");
    }
    expect(watchOptions.find(({ id }) => id === "streaming-njpbs-live")?.verification.sourceUrl)
      .toBe("https://njpbs.org/live/");
  });
});

describe("watch directory filtering", () => {
  it("searches provider names, aliases, areas, channels, and delivery descriptions", () => {
    const state = { ...defaultWatchDirectoryState };

    expect(filterWatchOptions(watchOptions, { ...state, query: "Comcast" })).toHaveLength(2);
    expect(filterWatchOptions(watchOptions, { ...state, query: "Westchester" })).toHaveLength(2);
    expect(filterWatchOptions(watchOptions, { ...state, query: "8113" }).map(({ id }) => id))
      .toEqual(["satellite-dish-new-york"]);
    expect(filterWatchOptions(watchOptions, { ...state, query: "direct broadcast satellite" }))
      .toHaveLength(4);
    expect(filterWatchOptions(watchOptions, { ...state, query: "Verizon New Jersey" }).map(({ id }) => id))
      .toEqual(["iptv-verizon-new-jersey"]);
    expect(filterWatchOptions(watchOptions, { ...state, query: "Xfinity 23" })).toHaveLength(2);
  });

  it("combines delivery, provider, area, and search filters", () => {
    expect(filterWatchOptions(watchOptions, {
      query: "HD",
      delivery: "fiber-iptv",
      provider: "Verizon Fios",
      area: "New Jersey",
    }).map(({ id }) => id)).toEqual(["iptv-verizon-new-jersey"]);
  });

  it("returns sorted unique values for select controls", () => {
    expect(uniqueWatchValues(watchOptions, "provider")).toContain("NJ PBS Passport");
    expect(uniqueWatchValues(watchOptions, "area")).toContain("Brass Castle");
    expect(uniqueWatchValues(watchOptions, "provider"))
      .toEqual([...uniqueWatchValues(watchOptions, "provider")].sort((a, b) =>
        a.localeCompare(b, "en-US", { numeric: true, sensitivity: "base" })
      ));
  });
});

describe("watch directory sorting and URL state", () => {
  it("sorts channel labels numerically in either direction", () => {
    const sample = watchOptions.filter(({ id }) => [
      "ota-camden-wnjs",
      "ota-trenton-wnjt",
      "cable-service-electric-sparta",
    ].includes(id));

    expect(sortWatchOptions(sample, "channel", "asc").map(({ channel }) => channel))
      .toEqual(["8", "23", "52"]);
    expect(sortWatchOptions(sample, "channel", "desc").map(({ channel }) => channel))
      .toEqual(["52", "23", "8"]);
  });

  it("round-trips supported state while preserving unrelated query parameters", () => {
    const params = serializeWatchDirectoryState({
      query: "Verizon",
      delivery: "fiber-iptv",
      provider: "Verizon Fios",
      area: "New Jersey",
      sort: "channel",
      direction: "desc",
      selectedId: "iptv-verizon-new-jersey",
    }, new URLSearchParams("campaign=fall"));

    expect(params.get("campaign")).toBe("fall");
    expect(parseWatchDirectoryState(params, watchOptions)).toEqual({
      query: "Verizon",
      delivery: "fiber-iptv",
      provider: "Verizon Fios",
      area: "New Jersey",
      sort: "channel",
      direction: "desc",
      selectedId: "iptv-verizon-new-jersey",
    });
  });

  it("fails closed to defaults for unknown filter values", () => {
    expect(parseWatchDirectoryState(
      "watch_delivery=unknown&watch_provider=Missing&watch_sort=rank&watch_dir=sideways&watch_item=nope",
      watchOptions,
    )).toEqual(defaultWatchDirectoryState);
  });
});
