import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assetToGateInput, evaluateMediaManagerGate } from "../../site/src/lib/media-manager-gating";

const require = createRequire(import.meta.url);
const { fetchAssetAvailability } = require("../../functions/lib/pbs/media-manager-lookup");
const { fetchMembership } = require("../../functions/lib/pbs/mvault-lookup");

// Shape and availability instants from the vendored PBS Assets sample; synthetic
// URS paths make these fixtures independent of live credentials and playback.
const ASSET_ID = "c27f7ba6-5e84-4940-ae92-635f83e36a55";
const CONFIG = { stationCid: "station-cid", apiKey: "fixture-key", apiSecret: "fixture-secret" };
const NOW = new Date("2026-07-09T18:00:00Z");
const ACTIVE = { entitled: true, state: "active" };
const INACTIVE = { entitled: false, state: "inactive" };
const TIERS = ["public", "all_members", "station_members"];
const hls = (tier) => `https://urs.pbs.org/redirect/fixture-${tier}/?format=m3u8`;
function asset(availability = "public", playable = availability) {
  return {
    type: "asset", id: ASSET_ID,
    attributes: {
      title: "Private upstream metadata",
      availability_window: availability, playable_window: playable,
      availabilities: Object.fromEntries(TIERS.map((tier) => [tier, {
        start: "2018-07-25T04:00:00Z", end: "2028-07-24T03:59:59Z", updated_at: "unused",
      }])),
      videos: Object.fromEntries(TIERS.map((tier) => [tier, [
        { profile: "hls-16x9-720p", url: hls(tier), private_metadata: "unused" },
      ]])),
    },
  };
}
function response(data = [asset()], status = 200) {
  return new Response(status === 204 ? null : JSON.stringify({ data }), { status });
}
function lookup(fetchImpl, context = {}, request = {}) {
  return fetchAssetAvailability({ assetId: ASSET_ID, ...request }, { ...CONFIG, fetchImpl, ...context });
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Media Manager request trust boundary", () => {
  it.each([null, [], 42, "invalid"])("returns a finite status for malformed request input: %j", async (request) => {
    const fetchImpl = vi.fn();
    await expect(fetchAssetAvailability(request, { ...CONFIG, fetchImpl })).resolves.toEqual({ status: "error" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([null, [], 42, "invalid"])("returns a finite status for malformed server context: %j", async (context) => {
    await expect(fetchAssetAvailability({ assetId: ASSET_ID }, context)).resolves.toEqual({ status: "not-configured" });
  });

  it("uses fixed HTTPS, encoded station context, header-only Basic auth and no redirects", async () => {
    const fetchImpl = vi.fn(async () => response());
    await expect(lookup(fetchImpl, { stationCid: "station/one?membership=foreign#%" })).resolves.toMatchObject({ status: "ok" });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(`https://media.services.pbs.org/api/v1/assets/${ASSET_ID}/?localized_station=station%2Fone%3Fmembership%3Dforeign%23%25`);
    expect(options).toMatchObject({ method: "GET", redirect: "error", cache: "no-store" });
    expect(new Headers(options.headers).get("authorization")).toBe(`Basic ${Buffer.from("fixture-key:fixture-secret").toString("base64")}`);
    expect(new Headers(options.headers).get("accept")).toBe("application/vnd.api+json");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([undefined, ACTIVE])("ignores browser CIDs, credentials and entitlement fields with server entitlement %j", async (verifiedEntitlement) => {
    const fetchImpl = vi.fn(async () => response());
    await lookup(fetchImpl, { verifiedEntitlement }, {
      localized_station: "foreign", membership: "foreign", stationCid: "foreign",
      apiKey: "foreign", apiSecret: "foreign", verifiedEntitlement: ACTIVE,
      origin: "https://foreign.example.test", url: "https://foreign.example.test",
    });
    const url = new URL(fetchImpl.mock.calls[0][0]);
    expect(url.origin).toBe("https://media.services.pbs.org");
    expect([...url.searchParams]).toEqual(verifiedEntitlement
      ? [["localized_station", CONFIG.stationCid], ["membership", CONFIG.stationCid]]
      : [["localized_station", CONFIG.stationCid]]);
  });

  it.each([
    [undefined, false], [INACTIVE, false], [{ entitled: false, state: "expired" }, false],
    [ACTIVE, true], [{ entitled: true, state: "grace" }, true],
    [{ entitled: "true", state: "active" }, false], [{ entitled: true, state: "expired" }, false],
    [{ entitled: true, state: "unknown" }, false],
  ])("adds membership only for a verified streaming entitlement: %j", async (verifiedEntitlement, included) => {
    const fetchImpl = vi.fn(async () => response());
    await lookup(fetchImpl, { verifiedEntitlement });
    expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get("membership")).toBe(included ? CONFIG.stationCid : null);
  });

  it.each([
    { stationCid: "" }, { apiKey: undefined }, { apiSecret: " " }, { apiKey: "key:other" },
  ])("requires server configuration: %j", async (context) => {
    const fetchImpl = vi.fn();
    await expect(lookup(fetchImpl, context)).resolves.toEqual({ status: "not-configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([undefined, "", ".", "..", "a-slug", "//foreign.example.test", `${ASSET_ID}/edit`, `${ASSET_ID}?membership=foreign`, "%2e%2e"])("rejects a non-immutable asset identifier: %s", async (assetId) => {
    const fetchImpl = vi.fn();
    await expect(lookup(fetchImpl, {}, { assetId })).resolves.toEqual({ status: "error" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("Media Manager response boundary", () => {
  // PBS Assets: playable_window selects the video bucket for this viewer;
  // availability_window can name a different tier's scheduling bounds.
  it.each([
    ["public", "public", undefined],
    ["station_members", "public", ACTIVE],
    ["all_members", "all_members", ACTIVE],
    ["station_members", "station_members", ACTIVE],
  ])("returns only %s/%s's selected rendition bucket", async (availability, playable, verifiedEntitlement) => {
    const result = await lookup(async () => response([asset(availability, playable)]), { verifiedEntitlement });
    expect(result.status).toBe("ok");
    expect(result.asset.attributes.videos).toEqual({
      [playable]: [{ profile: "hls-16x9-720p", url: hls(playable) }],
    });
  });

  it.each([undefined, ACTIVE])("returns no rendition URLs when playback is unavailable: %j", async (verifiedEntitlement) => {
    const result = await lookup(async () => response([asset("public", "unavailable")]), { verifiedEntitlement });
    expect(result.status).toBe("ok");
    expect(result.asset.attributes.videos).toEqual({});
    expect(JSON.stringify(result)).not.toContain("https://urs.pbs.org/");
  });

  it("fails closed for an unknown playback window even when it names a video bucket", async () => {
    const source = asset("public", "premium");
    source.attributes.videos.premium = [{ profile: "hls-16x9-720p", url: hls("premium") }];
    await expect(lookup(async () => response([source]), { verifiedEntitlement: ACTIVE }))
      .resolves.toEqual({ status: "error" });
  });

  it.each([[ASSET_ID.toUpperCase(), ASSET_ID], [ASSET_ID, ASSET_ID.toUpperCase()]])(
    "matches UUID identity across request/response casing",
    async (assetId, responseId) => {
      const source = asset(); source.id = responseId;
      const fetchImpl = vi.fn(async () => response([source]));
      const result = await lookup(fetchImpl, {}, { assetId });
      expect(result.status).toBe("ok");
      expect(result.asset.id).toBe(ASSET_ID);
      expect(new URL(fetchImpl.mock.calls[0][0]).pathname).toBe(`/api/v1/assets/${ASSET_ID}/`);
    },
  );

  it.each([false, true])("accepts exactly one matching resource (single object: %s) and strips unrelated fields", async (single) => {
    const source = asset();
    const result = await lookup(async () => response(single ? source : [source]));
    expect(result.status).toBe("ok");
    expect(result.asset.id).toBe(ASSET_ID);
    const sourceInput = assetToGateInput(source);
    expect(assetToGateInput(result.asset)).toEqual({
      ...sourceInput, renditions: { public: sourceInput.renditions.public },
    });
    expect(Object.keys(result.asset)).toEqual(["type", "id", "attributes"]);
    expect(Object.keys(result.asset.attributes).sort()).toEqual(["availabilities", "availability_window", "playable_window", "videos"]);
    expect(result.asset.attributes.availabilities.public).toEqual({ start: "2018-07-25T04:00:00Z", end: "2028-07-24T03:59:59Z" });
    expect(result.asset.attributes.videos.public).toEqual([{ profile: "hls-16x9-720p", url: hls("public") }]);
    expect(JSON.stringify(result)).not.toMatch(/fixture-key|fixture-secret|Private upstream|unused/);
  });

  it.each([[[], "not-found"], [null, "not-found"], [[asset(), asset()], "error"], [42, "error"], [[null], "error"]])("handles missing or ambiguous resources: %j", async (data, status) => {
    await expect(lookup(async () => response(data))).resolves.toEqual({ status });
  });

  it.each([{}, [], null])("rejects a missing JSON:API data member: %j", async (body) => {
    await expect(lookup(async () => new Response(JSON.stringify(body)))).resolves.toEqual({ status: "error" });
  });

  it.each([
    [401, "forbidden"], [403, "forbidden"], [404, "not-found"], [429, "rate-limited"],
    [301, "error"], [302, "error"], [307, "error"], [201, "error"], [204, "error"], [500, "error"],
  ])("maps HTTP %i to %s without exposing the upstream response", async (http, status) => {
    await expect(lookup(async () => response({ secret: CONFIG.apiSecret }, http))).resolves.toEqual({ status });
  });

  it.each([
    ["wrong id", (value) => { value.id = "00000000-0000-0000-0000-000000000000"; }],
    ["wrong type", (value) => { value.type = "episode"; }],
    ["no attributes", (value) => { delete value.attributes; }],
    ["missing availability", (value) => { delete value.attributes.availability_window; }],
    ["unknown playback window", (value) => { value.attributes.playable_window = "premium"; }],
    ["unreadable videos", (value) => { value.attributes.videos = 42; }],
    ["unreadable window", (value) => { value.attributes.availabilities.public.start = 123; }],
    ["empty window", (value) => { value.attributes.availabilities.public = {}; }],
  ])("rejects %s", async (_name, change) => {
    const source = asset(); change(source);
    await expect(lookup(async () => response([source]))).resolves.toEqual({ status: "error" });
  });

  it.each(["network", "redirect refusal", "JSON", "body", "JSON:API errors"])("contains %s failures without exception or body details", async (stage) => {
    const fetchImpl = vi.fn(async () => {
      if (stage === "network" || stage === "redirect refusal") throw new Error(CONFIG.apiSecret);
      if (stage === "JSON") return new Response(CONFIG.apiSecret);
      if (stage === "JSON:API errors") return new Response(JSON.stringify({ data: [asset()], errors: [{ detail: CONFIG.apiSecret }] }));
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error(CONFIG.apiSecret)); } }));
    });
    await expect(lookup(fetchImpl)).resolves.toEqual({ status: "error" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe("transport to playback gate parity", () => {
  it("preserves the documented empty video list as an asset without HLS", async () => {
    const source = asset(); source.attributes.videos = [];
    const result = await lookup(async () => response([source]));
    expect(result.status).toBe("ok");
    const viewer = { tier: "public", entitlement: INACTIVE };
    const gate = evaluateMediaManagerGate(assetToGateInput(result.asset), viewer, NOW);
    expect(gate).toEqual({ verdict: "unavailable", reason: "no-hls-rendition", hls: null });
    expect(gate).toEqual(evaluateMediaManagerGate(assetToGateInput(source), viewer, NOW));
  });

  it("retains usable renditions when PBS also returns malformed entries", async () => {
    const source = asset();
    source.attributes.videos.public.unshift(null, { profile: "hls-16x9-1080p", url: {} }, { profile: null });
    const result = await lookup(async () => response([source]));
    expect(result.status).toBe("ok");
    const sourceInput = assetToGateInput(source);
    expect(assetToGateInput(result.asset)).toEqual({
      ...sourceInput, renditions: { public: sourceInput.renditions.public },
    });
    expect(evaluateMediaManagerGate(assetToGateInput(result.asset), { tier: "public", entitlement: INACTIVE }, NOW))
      .toEqual({ verdict: "render", reason: "playable", hls: hls("public") });
  });

  it.each([
    ["public", "public", "public", INACTIVE, "render", "playable"],
    ["station_members", "public", "station_members", ACTIVE, "render", "playable"],
    ["all_members", "all_members", "all_members", ACTIVE, "render", "playable"],
    ["station_members", "station_members", "station_members", INACTIVE, "deny", "not-entitled"],
    ["station_members", "station_members", "public", INACTIVE, "unavailable", "unreadable-availability-window"],
    ["unavailable", "unavailable", "public", INACTIVE, "unavailable", "no-availability-window"],
  ])("preserves %s/%s for a %s viewer", async (availability, playable, tier, entitlement, verdict, reason) => {
    const source = asset(availability, playable);
    const result = await lookup(async () => response([source]), { verifiedEntitlement: entitlement });
    const actual = evaluateMediaManagerGate(assetToGateInput(result.asset), { tier, entitlement }, NOW);
    expect(actual).toEqual({ verdict, reason, hls: verdict === "render" ? hls(playable) : null });
    expect(actual).toEqual(evaluateMediaManagerGate(assetToGateInput(source), { tier, entitlement }, NOW));
  });

  it.each([
    ["2018-07-25T03:59:59Z", "before-window"], ["2028-07-24T04:00:00Z", "after-window"],
  ])("preserves the published window at %s", async (now, reason) => {
    const result = await lookup(async () => response());
    expect(evaluateMediaManagerGate(assetToGateInput(result.asset), { tier: "public", entitlement: INACTIVE }, new Date(now))).toEqual({ verdict: "unavailable", reason, hls: null });
  });

  it("keeps the gate's rejection of non-URS playback URLs", async () => {
    const source = asset();
    source.attributes.videos.public[0].url = "https://media.example.test/video.m3u8";
    const result = await lookup(async () => response([source]));
    expect(evaluateMediaManagerGate(assetToGateInput(result.asset), { tier: "public", entitlement: INACTIVE }, NOW))
      .toEqual({ verdict: "unavailable", reason: "non-urs-rendition", hls: null });
  });

  it.each([[true, true], [false, false]])("uses the real MVault mapper result when has_access is %s", async (hasAccess, included) => {
    const membership = await fetchMembership({
      stationId: "mvault-station", pbsUid: "fixture-viewer", apiKey: "fixture-key", apiSecret: "fixture-secret",
      fetchImpl: async () => new Response(JSON.stringify([{
        status: "On", offer: "passport", current_state: { has_access: hasAccess,
          explanation: { status: "On", timing: "within_start_expire_dates", token_activated: true } },
      }])),
    });
    const fetchImpl = vi.fn(async () => response());
    await lookup(fetchImpl, { verifiedEntitlement: membership.entitlement });
    expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.has("membership")).toBe(included);
  });
});

describe("Media Manager deadline", () => {
  it("clears the deadline after success without retrying", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => response());
    await expect(lookup(fetchImpl)).resolves.toMatchObject({ status: "ok" });
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each(["headers", "body"])("bounds stalled %s even if fetch ignores abort", async (stage) => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(() => stage === "headers" ? new Promise(() => {})
      : Promise.resolve(new Response(new ReadableStream({ start() {} }))));
    const pending = lookup(fetchImpl, { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(49);
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ status: "timeout" });
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, -1, Infinity, 60000])("caps the deadline at eight seconds: %s", async (timeoutMs) => {
    vi.useFakeTimers();
    const pending = lookup(() => new Promise(() => {}), { timeoutMs });
    await vi.advanceTimersByTimeAsync(8000);
    await expect(pending).resolves.toEqual({ status: "timeout" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
