// @vitest-environment node
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkSpotlightRefresh } from "../scripts/check-spotlight-refresh.mjs";
import {
  buildSpotlightConfig,
  fetchSpotlightFeed,
  main,
} from "../scripts/sync-spotlight-news.mjs";

const servers: Server[] = [];

async function serve(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test server address");
  return `http://127.0.0.1:${address.port}/feed/`;
}

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
});

describe("Spotlight feed HTTP boundary", () => {
  it("preserves the text decoding of a feed with a UTF-8 byte order mark", async () => {
    const url = await serve((_request, response) =>
      response.end("\uFEFF<rss/>"),
    );

    await expect(fetchSpotlightFeed({ feedUrl: url })).resolves.toBe("<rss/>");
  });

  it("accepts a feed at the byte limit and decodes UTF-8", async () => {
    const xml = "é".repeat(1024 * 1024);
    const url = await serve((_request, response) => response.end(xml));

    await expect(fetchSpotlightFeed({ feedUrl: url })).resolves.toBe(xml);
  });

  it.each(["declared", "chunked", "compressed"])(
    "rejects an oversized %s response",
    async (kind) => {
      const bytes = Buffer.alloc(2 * 1024 * 1024 + 1, "a");
      let disconnected!: () => void;
      const closed = new Promise<void>((resolve) => {
        disconnected = resolve;
      });
      const url = await serve((_request, response) => {
        response.on("close", disconnected);
        if (kind === "declared") {
          response.setHeader("Content-Length", bytes.length);
          response.flushHeaders();
          return; // The limit must be checked before waiting for a body.
        }
        if (kind === "compressed") {
          response.setHeader("Content-Encoding", "gzip");
          response.end(gzipSync(bytes));
          return;
        }
        response.write(bytes.subarray(0, 1024 * 1024));
        response.end(bytes.subarray(1024 * 1024));
      });

      await expect(fetchSpotlightFeed({ feedUrl: url })).rejects.toThrow(
        /byte limit/i,
      );
      await closed;
    },
  );

  it("rejects redirects without contacting their destination", async () => {
    let destinationRequests = 0;
    const destination = await serve((_request, response) => {
      destinationRequests += 1;
      response.end("<rss/>");
    });
    const url = await serve((_request, response) => {
      response.writeHead(302, { Location: destination });
      response.end();
    });

    await expect(fetchSpotlightFeed({ feedUrl: url })).rejects.toThrow();
    expect(destinationRequests).toBe(0);
  });

  it("rejects an HTTP error before waiting for its unfinished body", async () => {
    const url = await serve((_request, response) => {
      response.writeHead(503);
      response.flushHeaders();
    });

    await expect(fetchSpotlightFeed({ feedUrl: url })).rejects.toMatchObject({
      status: 503,
    });
  });

  it.each([200, 503])(
    "closes a rejected HTTP %s feed through the refresh check",
    async (status) => {
      let disconnected!: () => void;
      const closed = new Promise<void>((resolve) => {
        disconnected = resolve;
      });
      const url = await serve((_request, response) => {
        response.on("close", disconnected);
        response.writeHead(status, { "Content-Length": 2 * 1024 * 1024 + 1 });
        response.flushHeaders();
      });
      const fetchImpl: typeof fetch = async (input, options) => {
        if (new URL(String(input)).hostname === "www.njspotlightnews.org") {
          return fetch(url, options);
        }
        return Response.json({});
      };

      await expect(checkSpotlightRefresh(fetchImpl)).rejects.toThrow(
        status === 200 ? /byte limit/i : /HTTP 503/,
      );
      await closed;
    },
  );

  it.each(["headers", "body"])(
    "ends a stalled %s request after sixty seconds",
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
      const result = fetchSpotlightFeed(
        buildSpotlightConfig({ SPOTLIGHT_NEWS_FEED_URL: url }),
        fetchImpl,
      ).then(
        () => "completed",
        () => "rejected",
      );
      let settled = false;
      void result.then(() => {
        settled = true;
      });
      await received;
      // The origin's recorded 10-20 second rebuild must fit within the budget.
      await vi.advanceTimersByTimeAsync(20_000);
      if (stage === "body") {
        upstreamResponse.write("<rss>");
        await headers;
      }

      await vi.advanceTimersByTimeAsync(39_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(result).resolves.toBe("rejected");
    },
  );

  it.each([false, true])(
    "preserves saved data on a rejected feed, fresh required: %s",
    async (fresh) => {
      const directory = await mkdtemp(path.join(tmpdir(), "spotlight-bounds-"));
      const output = path.join(directory, "spotlight-news.json");
      const saved = '{"cards":[{"title":"Saved headline"}]}\n';
      await writeFile(output, saved);
      const url = await serve((_request, response) =>
        response.end(Buffer.alloc(2 * 1024 * 1024 + 1)),
      );
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const result = main({
          SPOTLIGHT_NEWS_FEED_URL: url,
          SPOTLIGHT_NEWS_OUTPUT: output,
          REQUIRE_FRESH_CONTENT: fresh ? "1" : undefined,
        });
        if (fresh)
          await expect(result).rejects.toThrow(
            "scheduled refresh requires fresh Spotlight data",
          );
        else
          await expect(result).resolves.toEqual({
            cards: [],
            reusedCommittedData: true,
          });
        expect(await readFile(output, "utf8")).toBe(saved);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
