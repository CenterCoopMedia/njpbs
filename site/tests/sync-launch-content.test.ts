import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildSyncConfig,
  fetchShowsWithFallback,
  main,
  normalizeShowsToCards,
  readCommittedLaunchContent,
  selectLaunchCards,
} from "../scripts/sync-launch-content.mjs";

const immediateSleep = async () => {};

const fixture = {
  data: [
    {
      id: "1",
      attributes: {
        title: "Painting Community",
        slug: "painting-community",
        description_short: "Artists and communities in focus.",
        images: [{ image: "https://image.pbs.org/painting.jpg" }],
      },
    },
    {
      id: "2",
      attributes: {
        title: "NJTV News TEST",
        slug: "njtv-news-test",
      },
    },
  ],
};

const cardsFromTitles = (titles: string[]) =>
  normalizeShowsToCards({
    data: titles.map((title, index) => ({
      id: String(index),
      attributes: {
        title,
        slug: `show-${index}`,
        description_short: "A complete program description for launch cards.",
        images: [{ image: `https://image.pbs.org/show-${index}.jpg` }],
      },
    })),
  });

describe("buildSyncConfig", () => {
  it("allows a no-secret fallback build", () => {
    const config = buildSyncConfig({});

    expect(config.hasCredentials).toBe(false);
    expect(config.audience).toBe("WNJT");
    expect(config.pageSize).toBe("100");
  });

  it("builds an auth header when both credentials are present", () => {
    const config = buildSyncConfig({
      MEDIA_MANAGER_API_KEY: "key",
      MEDIA_MANAGER_API_SECRET: "secret",
    });

    expect(config.hasCredentials).toBe(true);
    expect(config.authorization).toMatch(/^Basic /);
  });

  it("fails closed when only the API key is set", () => {
    expect(() => buildSyncConfig({ MEDIA_MANAGER_API_KEY: "key" })).toThrow(
      /both .* or neither/i,
    );
  });

  it("fails closed when only the API secret is set", () => {
    expect(() =>
      buildSyncConfig({ MEDIA_MANAGER_API_SECRET: "secret" }),
    ).toThrow(/both .* or neither/i);
  });
});

describe("normalizeShowsToCards", () => {
  it("normalizes Media Manager shows into launch cards", () => {
    expect(normalizeShowsToCards(fixture)[0]).toEqual({
      source: "media-manager",
      id: "1",
      title: "Painting Community",
      description: "Artists and communities in focus.",
      href: "https://watch.njpbs.org/show/painting-community/",
      image: "https://image.pbs.org/painting.jpg",
    });
  });

  it("drops a non-https image so the homepage uses the placeholder", () => {
    const [card] = normalizeShowsToCards({
      data: [
        {
          id: "9",
          attributes: {
            title: "Insecure Art",
            slug: "insecure-art",
            image: "http://insecure.example/art.jpg",
          },
        },
      ],
    });

    expect(card.image).toBeUndefined();
  });
});

describe("selectLaunchCards", () => {
  it("filters test and legacy NJTV records", () => {
    expect(selectLaunchCards(normalizeShowsToCards(fixture))).toHaveLength(1);
  });

  it("excludes NJ Spotlight News anywhere in the title, not only at the start", () => {
    const cards = selectLaunchCards(
      cardsFromTitles(["The Change Project by NJ Spotlight News"]),
    );

    expect(cards).toHaveLength(0);
  });

  it("keeps legitimate programs that merely contain the word test", () => {
    const cards = selectLaunchCards(cardsFromTitles(["America's Test Kitchen"]));

    expect(cards.map((card: { title: string }) => card.title)).toContain(
      "America's Test Kitchen",
    );
  });

  it("drops QA stub records whose title ends in test", () => {
    const cards = selectLaunchCards(cardsFromTitles(["Pledge Special TEST"]));

    expect(cards).toHaveLength(0);
  });

  it("drops records without complete public metadata", () => {
    const cards = selectLaunchCards(
      normalizeShowsToCards({
        data: [
          {
            id: "missing",
            attributes: {
              title: "The Tragically Hip: A National Celebration",
              slug: "the-tragically-hip-a-national-celebration",
              description_short: "TBA",
              images: [{ image: "https://image.pbs.org/tragically-hip.jpg" }],
            },
          },
        ],
      }),
    );

    expect(cards).toHaveLength(0);
  });
});

describe("fetchShowsWithFallback", () => {
  const config = buildSyncConfig({
    MEDIA_MANAGER_API_KEY: "key",
    MEDIA_MANAGER_API_SECRET: "secret",
  });

  it("returns the payload when the request succeeds", async () => {
    const payload = {
      data: [{ id: "1", attributes: { title: "Show", slug: "show" } }],
    };
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
    })) as unknown as typeof fetch;

    expect(await fetchShowsWithFallback(config, fetchImpl, immediateSleep)).toEqual({
      payload,
      outage: false,
    });
  });

  it("retries a transient network failure and succeeds on a later attempt", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const payload = {
      data: [{ id: "1", attributes: { title: "Show", slug: "show" } }],
    };
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(payload),
      }) as unknown as typeof fetch;

    expect(await fetchShowsWithFallback(config, fetchImpl, immediateSleep)).toEqual({
      payload,
      outage: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("reports an outage after retries on a 5xx, so the deploy still ships", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "upstream down",
    }) as unknown as typeof fetch;

    expect(await fetchShowsWithFallback(config, fetchImpl, immediateSleep)).toEqual({
      payload: { data: [] },
      outage: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it("rethrows on a 4xx auth/contract error without retrying", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "forbidden",
    }) as unknown as typeof fetch;

    await expect(
      fetchShowsWithFallback(config, fetchImpl, immediateSleep),
    ).rejects.toThrow(/HTTP 403/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("rethrows on a 200 whose data is not an array, instead of shipping the fallback", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: null }),
    })) as unknown as typeof fetch;

    await expect(
      fetchShowsWithFallback(config, fetchImpl, immediateSleep),
    ).rejects.toThrow(/unexpected shape/);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("accepts a valid empty data array, since a real empty catalog is not an error", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [] }),
    })) as unknown as typeof fetch;

    expect(await fetchShowsWithFallback(config, fetchImpl, immediateSleep)).toEqual({
      payload: { data: [] },
      outage: false,
    });
  });

  it("rethrows on an unparseable 200 body instead of masking a contract bug", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      text: async () => "<html>not json</html>",
    })) as unknown as typeof fetch;

    await expect(
      fetchShowsWithFallback(config, fetchImpl, immediateSleep),
    ).rejects.toThrow(/unparseable body/);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("reports an outage after retries when the network keeps throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new Error("ECONNRESET")) as unknown as typeof fetch;

    expect(await fetchShowsWithFallback(config, fetchImpl, immediateSleep)).toEqual({
      payload: { data: [] },
      outage: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });
});

const committedMediaManagerFile = {
  source: "media-manager",
  checkedAt: "2026-06-29T19:43:58.507Z",
  request: { audience: "WNJT", url: "https://media.services.pbs.org/api/v1/shows/" },
  cards: [
    {
      source: "media-manager",
      id: "1",
      title: "Painting Community",
      description: "Artists and communities in focus across New Jersey.",
      href: "https://watch.njpbs.org/show/painting-community/",
      image: "https://image.pbs.org/painting.jpg",
    },
  ],
};

describe("readCommittedLaunchContent", () => {
  const config = buildSyncConfig({});

  it("returns the committed media-manager cards", async () => {
    const readImpl = (async () =>
      JSON.stringify(committedMediaManagerFile)) as unknown as typeof readFile;

    const committed = await readCommittedLaunchContent(config, readImpl);

    expect(committed?.cards).toHaveLength(1);
    expect(committed?.checkedAt).toBe("2026-06-29T19:43:58.507Z");
  });

  it("re-filters committed cards through today's selection rules", async () => {
    const readImpl = (async () =>
      JSON.stringify({
        ...committedMediaManagerFile,
        cards: [
          ...committedMediaManagerFile.cards,
          {
            source: "media-manager",
            id: "2",
            title: "Pledge Special TEST",
            description: "A QA stub record that must not reach the homepage.",
            href: "https://watch.njpbs.org/show/pledge-special-test/",
            image: "https://image.pbs.org/pledge.jpg",
          },
        ],
      })) as unknown as typeof readFile;

    const committed = await readCommittedLaunchContent(config, readImpl);

    expect(committed?.cards.map((card: { title: string }) => card.title)).toEqual([
      "Painting Community",
    ]);
  });

  it("returns null for a committed manual-fallback file", async () => {
    const readImpl = (async () =>
      JSON.stringify({
        ...committedMediaManagerFile,
        source: "manual-fallback",
      })) as unknown as typeof readFile;

    expect(await readCommittedLaunchContent(config, readImpl)).toBeNull();
  });

  it("returns null when the committed cards are empty", async () => {
    const readImpl = (async () =>
      JSON.stringify({ ...committedMediaManagerFile, cards: [] })) as unknown as typeof readFile;

    expect(await readCommittedLaunchContent(config, readImpl)).toBeNull();
  });

  it("returns null when the committed file is missing or unreadable", async () => {
    const readImpl = (async () => {
      throw new Error("ENOENT");
    }) as unknown as typeof readFile;

    expect(await readCommittedLaunchContent(config, readImpl)).toBeNull();
  });
});

describe("main", () => {
  it("keeps the committed launch cards through a persistent outage instead of overwriting them", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const dir = await mkdtemp(path.join(tmpdir(), "launch-content-"));
    const outputPath = path.join(dir, "launch-media-manager.json");
    const committedRaw = `${JSON.stringify(committedMediaManagerFile, null, 2)}\n`;
    await writeFile(outputPath, committedRaw, "utf8");
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new Error("fetch failed")) as unknown as typeof fetch;

    await main(
      {
        MEDIA_MANAGER_API_KEY: "key",
        MEDIA_MANAGER_API_SECRET: "secret",
        LAUNCH_CONTENT_OUTPUT: outputPath,
      },
      fetchImpl,
      immediateSleep,
    );

    // #3119 adds the separately observed public episode packet to this same
    // transport. The complete retained Show snapshot must remain unchanged.
    const written = JSON.parse(await readFile(outputPath, "utf8"));
    const { newscast, ...retained } = written;
    expect(`${JSON.stringify(retained, null, 2)}\n`).toBe(committedRaw);
    expect(newscast).toEqual({ source: "pbs_media_manager", showId: "ad1f378e-9779-4ef1-a629-40a8a6f8f8d5",
      showTitle: "NJ PBS News with Rob Nelson", programHref: "https://watch.njpbs.org/show/nj-pbs-news-with-rob-nelson/",
      pastNewscastsHref: "https://watch.njpbs.org/show/nj-pbs-news-with-rob-nelson/", liveHref: "/live/",
      checkedAt: null, episode: null, emptyReason: "source_error" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("kept 1 committed card ("));
    warn.mockRestore();
    log.mockRestore();
  });

  it("persists the re-filtered committed cards during an outage, so excluded cards do not ship", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const dir = await mkdtemp(path.join(tmpdir(), "launch-content-"));
    const outputPath = path.join(dir, "launch-media-manager.json");
    await writeFile(
      outputPath,
      JSON.stringify({
        ...committedMediaManagerFile,
        cards: [
          ...committedMediaManagerFile.cards,
          {
            source: "media-manager",
            id: "2",
            title: "Pledge Special TEST",
            description: "A QA stub record that must not reach the homepage.",
            href: "https://watch.njpbs.org/show/pledge-special-test/",
            image: "https://image.pbs.org/pledge.jpg",
          },
        ],
      }),
      "utf8",
    );
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new Error("fetch failed")) as unknown as typeof fetch;

    await main(
      {
        MEDIA_MANAGER_API_KEY: "key",
        MEDIA_MANAGER_API_SECRET: "secret",
        LAUNCH_CONTENT_OUTPUT: outputPath,
      },
      fetchImpl,
      immediateSleep,
    );

    const written = JSON.parse(await readFile(outputPath, "utf8"));
    expect(written.source).toBe("media-manager");
    expect(written.checkedAt).toBe(committedMediaManagerFile.checkedAt);
    expect(written.cards.map((card: { title: string }) => card.title)).toEqual([
      "Painting Community",
    ]);
    warn.mockRestore();
    log.mockRestore();
  });

  it("writes the manual fallback during an outage when no committed cards exist", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const dir = await mkdtemp(path.join(tmpdir(), "launch-content-"));
    const outputPath = path.join(dir, "launch-media-manager.json");
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new Error("fetch failed")) as unknown as typeof fetch;

    await main(
      {
        MEDIA_MANAGER_API_KEY: "key",
        MEDIA_MANAGER_API_SECRET: "secret",
        LAUNCH_CONTENT_OUTPUT: outputPath,
      },
      fetchImpl,
      immediateSleep,
    );

    const written = JSON.parse(await readFile(outputPath, "utf8"));
    expect(written.cards).toEqual([]);
    expect(written.source).toBe("manual-fallback");
    warn.mockRestore();
    log.mockRestore();
  });

  it("fails a scheduled refresh when Media Manager data is stale", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new Error("fetch failed")) as unknown as typeof fetch;

    await expect(
      main(
        {
          MEDIA_MANAGER_API_KEY: "key",
          MEDIA_MANAGER_API_SECRET: "secret",
          REQUIRE_FRESH_CONTENT: "1",
        },
        fetchImpl,
        immediateSleep,
      ),
    ).rejects.toThrow("scheduled refresh requires fresh Media Manager data");
    warn.mockRestore();
  });

  it("fails a scheduled refresh without Media Manager credentials", async () => {
    await expect(main({ REQUIRE_FRESH_CONTENT: "1" })).rejects.toThrow(
      "scheduled refresh requires Media Manager credentials",
    );
  });

  it("keeps a fresh normal PBS sync usable when the optional newscast endpoint fails", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "newscast-sync-boundary-"));
    const outputPath = path.join(directory, "launch.json");
    try {
      await main({ MEDIA_MANAGER_API_KEY: "fixture-key", MEDIA_MANAGER_API_SECRET: "fixture-secret",
        REQUIRE_FRESH_CONTENT: "1", LAUNCH_CONTENT_OUTPUT: outputPath }, async input =>
        new URL(String(input)).pathname.includes("/assets/") ? new Response("Unavailable", { status: 503 })
          : new Response(JSON.stringify(fixture), { status: 200 }), immediateSleep);
      const saved = JSON.parse(await readFile(outputPath, "utf8"));
      expect(saved.source).toBe("media-manager");
      expect(saved.cards.map((card: { title: string }) => card.title)).toEqual(["Painting Community"]);
      expect(saved.newscast).toMatchObject({ checkedAt: null, episode: null, emptyReason: "source_error" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("fails a scheduled refresh when Media Manager returns no usable cards", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ data: [] }),
      { status: 200 },
    )) as unknown as typeof fetch;

    await expect(main({
      MEDIA_MANAGER_API_KEY: "key",
      MEDIA_MANAGER_API_SECRET: "secret",
      REQUIRE_FRESH_CONTENT: "1",
    }, fetchImpl, immediateSleep)).rejects.toThrow(
      "scheduled refresh requires usable Media Manager data",
    );
  });
});
