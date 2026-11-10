import { describe, expect, it } from "vitest";
import {
  buildBasicAuthHeader,
  buildProbeConfig,
  fetchMediaManagerShows,
  summarizeProbeResult,
} from "../scripts/probe-launch-content.mjs";

describe("buildBasicAuthHeader", () => {
  it("builds a PBS CDA HTTP Basic auth header", () => {
    expect(buildBasicAuthHeader("key", "secret")).toBe("Basic a2V5OnNlY3JldA==");
  });
});

describe("buildProbeConfig", () => {
  it("fails closed when Media Manager credentials are missing", () => {
    expect(() => buildProbeConfig({})).toThrow(
      "MEDIA_MANAGER_API_KEY and MEDIA_MANAGER_API_SECRET are required",
    );
  });

  it("uses WNJT as the default audience", () => {
    const config = buildProbeConfig({
      MEDIA_MANAGER_API_KEY: "key",
      MEDIA_MANAGER_API_SECRET: "secret",
    });

    expect(config.audience).toBe("WNJT");
    expect(config.url.searchParams.get("audience-scope")).toBe("local");
    expect(config.url.searchParams.get("audience")).toBe("WNJT");
  });

  it("treats blank optional values as unset", () => {
    const config = buildProbeConfig({
      MEDIA_MANAGER_API_KEY: "key",
      MEDIA_MANAGER_API_SECRET: "secret",
      MEDIA_MANAGER_AUDIENCE: "",
      MEDIA_MANAGER_PAGE_SIZE: "",
    });

    expect(config.audience).toBe("WNJT");
    expect(config.url.searchParams.get("page-size")).toBe("25");
  });
});

describe("summarizeProbeResult", () => {
  it("keeps the launch proof small and shareable", () => {
    expect(
      summarizeProbeResult({
        data: [
          { id: "1", attributes: { title: "State of Affairs" } },
          { id: "2", attributes: { title: "One-on-One" } },
        ],
      }),
    ).toEqual({
      ok: true,
      count: 2,
      sampleTitles: ["State of Affairs", "One-on-One"],
    });
  });
});

describe("fetchMediaManagerShows", () => {
  it("does not include a failed response body in the error", async () => {
    const fetchImpl = async () =>
      new Response("sensitive member response", { status: 401 });

    await expect(
      fetchMediaManagerShows(
        {
          authorization: "Basic redacted",
          url: new URL("https://media.services.pbs.org/api/v1/shows/"),
        },
        fetchImpl,
      ),
    ).rejects.toThrow(/^Media Manager probe failed with HTTP 401$/);
  });
});
