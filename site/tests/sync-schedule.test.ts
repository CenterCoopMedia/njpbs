// @vitest-environment node
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildScheduleConfig,
  buildTvssUrl,
  getEtBroadcastDates,
  main,
} from "../scripts/sync-schedule.mjs";

const fixtureText = await readFile(
  new URL("./fixtures/tvss-wnjt-20260710.jsonp", import.meta.url),
  "utf8",
);
const tempDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function tempOutputPath() {
  const directory = await mkdtemp(path.join(tmpdir(), "njpbs-schedule-"));
  tempDirectories.push(directory);
  return path.join(directory, "schedule.json");
}

function response(body = fixtureText, status = 200) {
  return new Response(body, { status });
}

function validBakedData() {
  const dates = Array.from({ length: 14 }, (_, index) =>
    `2026-07-${String(10 + index).padStart(2, "0")}`,
  );
  const day = (date: string, kind: "broadcast" | "kids") => ({
    date,
    callsign: "wnjt",
    kind,
    feedCid: "4211290e-ce30-49e5-9be1-2c412c5b3278",
    timeZone: "America/New_York",
    entries: [
      {
        startsAt: `${date}T00:00:00-04:00`,
        endsAt: `${date}T00:30:00-04:00`,
        title: "Test program",
        seasonNumber: null,
        episodeNumber: null,
        nolaRoot: null,
        programId: null,
        programExternalId: null,
        cid: null,
        feedKind: kind,
        ...(kind === "kids" ? { kids: true } : {}),
        isKids: kind === "kids",
      },
    ],
  });

  return {
    source: "pbs-tvss",
    generatedAt: "2026-07-10T16:00:00.000Z",
    timeZone: "America/New_York",
    request: { station: "WNJT", dates },
    days: {
      broadcast: dates.map((date) => day(date, "broadcast")),
      kids: dates.map((date) => day(date, "kids")),
    },
  };
}

describe("getEtBroadcastDates", () => {
  it("starts from the New York date even when UTC is already tomorrow", () => {
    expect(
      getEtBroadcastDates(new Date("2026-07-11T02:30:00Z"), 3),
    ).toEqual(["2026-07-10", "2026-07-11", "2026-07-12"]);
  });
});

describe("buildTvssUrl", () => {
  it("builds the documented broadcast and kids requests", () => {
    const broadcast = buildTvssUrl("2026-07-10", "broadcast");
    const kids = buildTvssUrl("2026-07-10", "kids");

    expect(broadcast.pathname).toMatch(/\/day\/20260710\/$/);
    expect(broadcast.searchParams.get("callback")).toBe("cb");
    expect(broadcast.searchParams.get("provider")).toBe("Broadcast");
    expect(broadcast.searchParams.get("kids")).toBe("");
    expect(broadcast.searchParams.get("kidsflag")).toBe("false");
    expect(kids.searchParams.get("kidsflag")).toBe("true");
  });
});

describe("main", () => {
  it("writes fourteen broadcast and fourteen kids days after every day validates", async () => {
    const outputPath = await tempOutputPath();
    const requests: Array<{ url: string; referer: string | null }> = [];
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      requests.push({
        url: input.toString(),
        referer: new Headers(init?.headers).get("Referer"),
      });
      return response();
    }) as unknown as typeof fetch;
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await main(
      { SCHEDULE_OUTPUT: outputPath },
      fetchImpl,
      new Date("2026-07-10T16:00:00Z"),
    );
    const written = JSON.parse(await readFile(outputPath, "utf8"));

    expect(fetchImpl).toHaveBeenCalledTimes(28);
    expect(requests.every(({ referer }) => referer === "https://njpbs.org/")).toBe(
      true,
    );
    expect(written.days.broadcast).toHaveLength(14);
    expect(written.days.kids).toHaveLength(14);
    expect(written.days.broadcast[0].date).toBe("2026-07-10");
    expect(written.days.broadcast[0].sourceCheckedAt).toBe("2026-07-10T16:00:00.000Z");
    expect(written.days.kids[0].entries).toHaveLength(5);
    expect(
      written.days.kids[0].entries.filter(
        (entry: { kids: boolean }) => entry.kids,
      ),
    ).toHaveLength(2);
    expect(
      written.days.kids[0].entries.filter(
        (entry: { isKids: boolean }) => entry.isKids,
      ),
    ).toHaveLength(3);
    expect(
      written.days.kids[0].entries.find(
        (entry: { title: string }) => entry.title === "Weather Hunters",
      ),
    ).toMatchObject({ nolaRoot: "WEHU", kids: false, isKids: true });
    expect(result.reusedCommittedData).toBe(false);
  });

  it("keeps an existing bake unchanged when any request fails", async () => {
    const outputPath = await tempOutputPath();
    const previous = JSON.stringify(validBakedData());
    await writeFile(outputPath, previous, "utf8");
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await main(
      { SCHEDULE_OUTPUT: outputPath },
      fetchImpl,
      new Date("2026-07-10T16:00:00Z"),
    );

    expect(result.reusedCommittedData).toBe(true);
    expect(await readFile(outputPath, "utf8")).toBe(previous);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("fails a scheduled refresh when the schedule bake is stale", async () => {
    const outputPath = await tempOutputPath();
    const previous = JSON.stringify(validBakedData());
    await writeFile(outputPath, previous, "utf8");
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      main(
        { REQUIRE_FRESH_CONTENT: "1", SCHEDULE_OUTPUT: outputPath },
        fetchImpl,
        new Date("2026-07-10T16:00:00Z"),
      ),
    ).rejects.toThrow("scheduled refresh requires fresh schedule data");
    expect(await readFile(outputPath, "utf8")).toBe(previous);
    expect(warn).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "invalid JSONP", body: "cb(not valid JSON)" },
    { name: "empty feed", body: 'cb({"headends":[{"name":"Broadcast","feeds":[{"cid":"4211290e-ce30-49e5-9be1-2c412c5b3278","short_name":"WNJTDT","listings":[]}]}]});' },
  ])("requires fresh data instead of hiding an $name behind a prior bake", async ({ body }) => {
    const outputPath = await tempOutputPath();
    const previous = JSON.stringify(validBakedData());
    await writeFile(outputPath, previous, "utf8");
    const fetchImpl = vi.fn(async () => response(body)) as unknown as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(main({ REQUIRE_FRESH_CONTENT: "1", SCHEDULE_OUTPUT: outputPath }, fetchImpl,
      new Date("2026-07-10T16:00:00Z"))).rejects.toThrow("scheduled refresh requires fresh schedule data");
    expect(await readFile(outputPath, "utf8")).toBe(previous);
  });

  it("fails when an upstream request fails and the prior bake no longer covers today", async () => {
    const outputPath = await tempOutputPath();
    const previous = JSON.stringify(validBakedData());
    await writeFile(outputPath, previous, "utf8");
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      main(
        { SCHEDULE_OUTPUT: outputPath },
        fetchImpl,
        new Date("2026-07-24T16:00:00Z"),
      ),
    ).rejects.toThrow("ECONNRESET");
    expect(await readFile(outputPath, "utf8")).toBe(previous);
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to a fresh prior bake when an upstream payload cannot be parsed", async () => {
    const outputPath = await tempOutputPath();
    const previous = JSON.stringify(validBakedData());
    await writeFile(outputPath, previous, "utf8");
    const fetchImpl = vi.fn(async () => response("cb(not valid JSON)")) as unknown as typeof fetch;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await main(
      { SCHEDULE_OUTPUT: outputPath },
      fetchImpl,
      new Date("2026-07-10T16:00:00Z"),
    );

    expect(result.reusedCommittedData).toBe(true);
    expect(await readFile(outputPath, "utf8")).toBe(previous);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("fails when writing fresh data fails even with a valid prior bake", async () => {
    const outputPath = await tempOutputPath();
    const previous = JSON.stringify(validBakedData());
    await writeFile(outputPath, previous, "utf8");
    const fetchImpl = vi.fn(async () => response()) as unknown as typeof fetch;
    const writeImpl = vi.fn(async () => {
      throw new Error("disk full");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      main(
        { SCHEDULE_OUTPUT: outputPath },
        fetchImpl,
        new Date("2026-07-10T16:00:00Z"),
        writeImpl,
      ),
    ).rejects.toThrow("disk full");
    expect(fetchImpl).toHaveBeenCalledTimes(28);
    expect(writeImpl).toHaveBeenCalledOnce();
    expect(await readFile(outputPath, "utf8")).toBe(previous);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps an existing bake when a fetched day is empty", async () => {
    const outputPath = await tempOutputPath();
    const previous = JSON.stringify(validBakedData());
    await writeFile(outputPath, previous, "utf8");
    const emptyPayload = 'cb({"headends":[{"name":"Broadcast","feeds":[{"cid":"4211290e-ce30-49e5-9be1-2c412c5b3278","short_name":"WNJTDT","listings":[]}]}]});';
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValue(response(emptyPayload)) as unknown as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await main(
      { SCHEDULE_OUTPUT: outputPath },
      fetchImpl,
      new Date("2026-07-10T16:00:00Z"),
    );

    expect(result.reusedCommittedData).toBe(true);
    expect(await readFile(outputPath, "utf8")).toBe(previous);
  });

  it("fails when the sync fails and no valid previous bake exists", async () => {
    const outputPath = await tempOutputPath();
    const fetchImpl = vi.fn(async () => response("upstream down", 503)) as unknown as typeof fetch;
    vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      main(
        { SCHEDULE_OUTPUT: outputPath },
        fetchImpl,
        new Date("2026-07-10T16:00:00Z"),
      ),
    ).rejects.toThrow(/HTTP 503/);
  });

  it("reuses valid prior data when a response body exceeds the deadline", async () => {
    vi.useFakeTimers();
    const outputPath = await tempOutputPath();
    const previous = JSON.stringify(validBakedData());
    await writeFile(outputPath, previous, "utf8");
    let requestSignal: AbortSignal | null = null;
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    const fetchImpl = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      requestSignal = init?.signal ?? null;
      markRequestStarted();
      const signal = requestSignal;
      return new Response(new ReadableStream({
        start(controller) {
          signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
      }));
    }) as unknown as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const resultPromise = main(
      {
        SCHEDULE_OUTPUT: outputPath,
        SCHEDULE_REQUEST_TIMEOUT_MS: "25",
      },
      fetchImpl,
      new Date("2026-07-10T16:00:00Z"),
    );
    await requestStarted;
    await vi.advanceTimersByTimeAsync(25);
    const result = await resultPromise;

    const observedSignal = requestSignal as AbortSignal | null;
    expect(observedSignal?.aborted).toBe(true);
    expect(result.reusedCommittedData).toBe(true);
    expect(await readFile(outputPath, "utf8")).toBe(previous);
  });

  it.each([
    ["has fewer than fourteen kids days", (data: ReturnType<typeof validBakedData>) => data.days.kids.pop()],
    ["has a mismatched day kind", (data: ReturnType<typeof validBakedData>) => { data.days.broadcast[0].kind = "kids"; }],
    ["has a mismatched day date", (data: ReturnType<typeof validBakedData>) => { data.days.kids[0].date = "2026-07-17"; }],
    ["has no entries for a day", (data: ReturnType<typeof validBakedData>) => { data.days.broadcast[0].entries = []; }],
    ["has an invalid entry interval", (data: ReturnType<typeof validBakedData>) => { data.days.broadcast[0].entries[0].endsAt = data.days.broadcast[0].entries[0].startsAt; }],
    ["has a blank entry title", (data: ReturnType<typeof validBakedData>) => { data.days.kids[0].entries[0].title = " "; }],
    ["has a mismatched entry feed kind", (data: ReturnType<typeof validBakedData>) => { data.days.kids[0].entries[0].feedKind = "broadcast"; }],
    ["has no kids classification", (data: ReturnType<typeof validBakedData>) => { Reflect.deleteProperty(data.days.kids[0].entries[0], "kids"); }],
    ["has overlapping entries", (data: ReturnType<typeof validBakedData>) => { data.days.broadcast[0].entries.push({ ...data.days.broadcast[0].entries[0], title: "Overlap" }); }],
    ["has no NOLA root field", (data: ReturnType<typeof validBakedData>) => { Reflect.deleteProperty(data.days.broadcast[0].entries[0], "nolaRoot"); }],
    ["has no program ID field", (data: ReturnType<typeof validBakedData>) => { Reflect.deleteProperty(data.days.broadcast[0].entries[0], "programId"); }],
    ["has no external program ID field", (data: ReturnType<typeof validBakedData>) => { Reflect.deleteProperty(data.days.broadcast[0].entries[0], "programExternalId"); }],
    ["has no listing cid field", (data: ReturnType<typeof validBakedData>) => { Reflect.deleteProperty(data.days.broadcast[0].entries[0], "cid"); }],
    ["has no derived kids classification", (data: ReturnType<typeof validBakedData>) => { Reflect.deleteProperty(data.days.kids[0].entries[0], "isKids"); }],
    ["has an inconsistent derived kids classification", (data: ReturnType<typeof validBakedData>) => { data.days.kids[0].entries[0].isKids = false; }],
    ["has a non-boolean broadcast kids annotation", (data: ReturnType<typeof validBakedData>) => { Reflect.set(data.days.broadcast[0].entries[0], "kids", "true"); }],
  ])("rejects a failed sync when prior data %s", async (_label, corrupt) => {
    const outputPath = await tempOutputPath();
    const previous = validBakedData();
    corrupt(previous);
    await writeFile(outputPath, JSON.stringify(previous), "utf8");
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      main(
        { SCHEDULE_OUTPUT: outputPath },
        fetchImpl,
        new Date("2026-07-10T16:00:00Z"),
      ),
    ).rejects.toThrow("ECONNRESET");
  });
});

describe("buildScheduleConfig", () => {
  it("uses the baked-data convention and the required referer", () => {
    expect(buildScheduleConfig({})).toMatchObject({
      outputPath: "src/data/schedule.json",
      referer: "https://njpbs.org/",
      requestTimeoutMs: 15_000,
    });
  });

  it("accepts a positive integer request timeout", () => {
    expect(
      buildScheduleConfig({ SCHEDULE_REQUEST_TIMEOUT_MS: "25" }),
    ).toMatchObject({ requestTimeoutMs: 25 });
  });

  it.each(["0", "-1", "1.5", "soon", ""])(
    "rejects an invalid request timeout of %j",
    (requestTimeout) => {
      expect(() =>
        buildScheduleConfig({
          SCHEDULE_REQUEST_TIMEOUT_MS: requestTimeout,
        }),
      ).toThrow(/positive integer/);
    },
  );
});
