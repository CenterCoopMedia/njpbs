// @vitest-environment node
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import {
  createServer,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkScheduleRefresh } from "../scripts/check-schedule-refresh.mjs";
import {
  buildScheduleConfig,
  fetchTvssDay,
  main,
} from "../scripts/sync-schedule.mjs";

const fixture = await readFile(
  new URL("./fixtures/tvss-wnjt-20260710.jsonp", import.meta.url),
  "utf8",
);
const byteLimit = 2 * 1024 * 1024;
const now = new Date("2026-07-10T16:00:00Z");
const servers: Server[] = [];
const directories: string[] = [];

async function serve(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  return `http://127.0.0.1:${address.port}/`;
}

function padded(text: string, bytes: number) {
  return text + " ".repeat(bytes - Buffer.byteLength(text));
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Schedule response HTTP boundary", () => {
  it.each(["broadcast", "kids"])(
    "accepts %s JSONP at the byte limit with UTF-8 and a byte order mark",
    async (kind) => {
      const body = padded(
        "\uFEFF" + fixture.replaceAll("Gods of Tennis", "Café tennis"),
        byteLimit,
      );
      const url = await serve((_request, response) => response.end(body));
      const result = await fetchTvssDay(
        buildScheduleConfig({ SCHEDULE_FEED_BASE_URL: url }),
        "2026-07-10",
        kind,
      );

      expect(result.entries).toHaveLength(5);
      expect(result.entries[0].title).toBe("Café tennis");
      expect(result.kind).toBe(kind);
    },
  );

  it.each(["declared", "chunked", "gzip"])(
    "rejects oversized %s JSONP before parsing",
    async (encoding) => {
      const body = padded(fixture, byteLimit + 1);
      const url = await serve((_request, response) => {
        if (encoding === "gzip") {
          response.setHeader("Content-Encoding", "gzip");
          response.end(gzipSync(body));
        } else if (encoding === "chunked") {
          response.write(body.slice(0, 1024));
          response.end(body.slice(1024));
        } else response.end(body);
      });

      await expect(
        fetchTvssDay(
          buildScheduleConfig({ SCHEDULE_FEED_BASE_URL: url }),
          "2026-07-10",
          "broadcast",
        ),
      ).rejects.toThrow(/byte limit/i);
    },
  );

  it.each(["declared", "chunked", "http error"])(
    "closes an unfinished %s response without waiting for EOF",
    async (kind) => {
      let disconnected!: () => void;
      const closed = new Promise<void>((resolve) => {
        disconnected = resolve;
      });
      const url = await serve((_request, response) => {
        response.on("close", disconnected);
        if (kind === "declared") {
          response.writeHead(200, { "Content-Length": byteLimit + 1 });
          response.flushHeaders();
        } else if (kind === "chunked")
          response.write(padded(fixture, byteLimit + 1));
        else {
          response.writeHead(503);
          response.flushHeaders();
        }
      });

      await expect(
        fetchTvssDay(
          buildScheduleConfig({ SCHEDULE_FEED_BASE_URL: url }),
          "2026-07-10",
          "broadcast",
        ),
      ).rejects.toThrow(kind === "http error" ? /HTTP 503/ : /byte limit/i);
      await closed;
    },
  );

  it.each(["headers", "body"])(
    "keeps the fifteen-second total deadline for stalled %s",
    async (stage) => {
      let requestReceived!: () => void;
      const received = new Promise<void>((resolve) => {
        requestReceived = resolve;
      });
      let upstreamResponse!: ServerResponse;
      const url = await serve((_request, response) => {
        upstreamResponse = response;
        requestReceived();
      });
      let responseReceived!: () => void;
      const headers = new Promise<void>((resolve) => {
        responseReceived = resolve;
      });
      const fetchImpl: typeof fetch = async (input, options) => {
        const response = await fetch(input, options);
        responseReceived();
        return response;
      };
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const result = fetchTvssDay(
        buildScheduleConfig({ SCHEDULE_FEED_BASE_URL: url }),
        "2026-07-10",
        "broadcast",
        fetchImpl,
      ).then(
        () => "completed",
        (error: Error) => error.message,
      );
      let settled = false;
      void result.then(() => {
        settled = true;
      });
      await received;
      await vi.advanceTimersByTimeAsync(10_000);
      if (stage === "body") {
        upstreamResponse.write("cb(");
        await headers;
      }
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatch(/timed out after 15000ms/);
    },
  );

  it.each(["feed", "/_schedule-sources.json", "/_publication.json"])(
    "rejects an oversized %s through the refresh check",
    async (target) => {
      let disconnected!: () => void;
      const closed = new Promise<void>((resolve) => {
        disconnected = resolve;
      });
      const url = await serve((_request, response) => {
        response.on("close", disconnected);
        response.write(
          padded(target === "feed" ? fixture : "{}", byteLimit + 1),
        );
      });
      const fetchImpl: typeof fetch = async (input, options) => {
        const requested = new URL(String(input));
        const isFeed = requested.hostname === "jaws.pbs.org";
        if ((target === "feed" && isFeed) || requested.pathname === target)
          return fetch(url, options);
        return isFeed ? new Response(fixture) : Response.json({});
      };

      await expect(checkScheduleRefresh(fetchImpl, now)).rejects.toThrow(
        /byte limit/i,
      );
      await closed;
    },
  );

  it.each(["headers", "body"])(
    "keeps the twenty-second receipt deadline for stalled %s",
    async (stage) => {
      let requestReceived!: () => void;
      const received = new Promise<void>((resolve) => {
        requestReceived = resolve;
      });
      let upstreamResponse!: ServerResponse;
      const url = await serve((_request, response) => {
        upstreamResponse = response;
        requestReceived();
      });
      let responseReceived!: () => void;
      const headers = new Promise<void>((resolve) => {
        responseReceived = resolve;
      });
      const fetchImpl: typeof fetch = async (input, options) => {
        if (new URL(String(input)).pathname !== "/_schedule-sources.json")
          return Response.json({});
        const response = await fetch(url, options);
        responseReceived();
        return response;
      };
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      // All October dates use the approved correction, so only receipts are read.
      const result = checkScheduleRefresh(
        fetchImpl,
        new Date("2026-10-02T16:00:00Z"),
      ).then(
        () => "completed",
        (error: Error) => error.name,
      );
      let settled = false;
      void result.then(() => {
        settled = true;
      });
      await received;
      await vi.advanceTimersByTimeAsync(10_000);
      if (stage === "body") {
        upstreamResponse.write("{");
        await headers;
      }
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBe("AbortError");
    },
  );

  it.each([false, true])(
    "leaves a valid saved bake unchanged on oversized input, fresh required: %s",
    async (fresh) => {
      const directory = await mkdtemp(path.join(tmpdir(), "schedule-bounds-"));
      directories.push(directory);
      const output = path.join(directory, "schedule.json");
      let body = fixture;
      const url = await serve((_request, response) => response.end(body));
      const env = { SCHEDULE_OUTPUT: output, SCHEDULE_FEED_BASE_URL: url };
      await main(env, fetch, now);
      const saved = await readFile(output, "utf8");
      body = padded(fixture, byteLimit + 1);

      const result = main(
        { ...env, REQUIRE_FRESH_CONTENT: fresh ? "1" : undefined },
        fetch,
        new Date("2026-07-10T17:00:00Z"),
      );
      if (fresh)
        await expect(result).rejects.toThrow(
          "scheduled refresh requires fresh schedule data",
        );
      else await expect(result).resolves.toEqual({ reusedCommittedData: true });
      expect(await readFile(output, "utf8")).toBe(saved);
    },
  );

  it("fails an oversized initial bake without creating an output file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "schedule-bounds-"));
    directories.push(directory);
    const output = path.join(directory, "schedule.json");
    const url = await serve((_request, response) =>
      response.end(padded(fixture, byteLimit + 1)),
    );

    await expect(
      main(
        { SCHEDULE_OUTPUT: output, SCHEDULE_FEED_BASE_URL: url },
        fetch,
        now,
      ),
    ).rejects.toThrow(/byte limit/i);
    await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
