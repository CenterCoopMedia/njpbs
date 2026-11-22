// @vitest-environment node
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const path = "/blog-post/harbor-restoration/";
const alias = "/njnews/old-harbor-story/";
const canonical = `https://example.org${path}`;
const published = "2017-08-14T16:00:00Z";

async function fixtureOrigin(after: boolean) {
  const server = createServer((request, response) => {
    if (request.url === path) {
      const data = after
        ? { datePublished: published, "@type": "NewsArticle" }
        : { "@type": "NewsArticle", datePublished: published };
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html>
        <title>Harbor restoration</title>
        <link href="${canonical}" rel="canonical">
        <meta name="description" content="The harbor reopened after restoration.">
        <meta property="article:published_time" content="${published}">
        <main>
          <script type="application/ld+json">${JSON.stringify(data)}</script>
          <time datetime="2017-08-14">August 14, 2017</time>
          <p>Community members visited the harbor.</p>
        </main>`);
    } else if (request.url === alias && after) {
      response.writeHead(301, { location: path }).end();
    } else {
      const gone = request.url === alias || request.url === "/posts/withdrawn/" || request.url === "/page/2/";
      response.writeHead(gone ? 410 : 404, { "x-robots-tag": "noindex" }).end();
    }
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture requires a TCP address");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

it("reports canonical metadata, a one-hop alias and unavailable routes before and after", async () => {
  const before = await fixtureOrigin(false);
  const after = await fixtureOrigin(true);
  const compare = (...paths: string[]) => run(process.execPath, [
    "--import", "tsx", "scripts/compare-archive-routes.ts", before.origin, after.origin, ...paths,
  ], { cwd: new URL("../", import.meta.url), timeout: 8_000 });

  try {
    const { stdout } = await compare(path);
    const same = JSON.parse(stdout);
    expect(same.differences).toEqual([]);
    expect(same.before).toEqual({
      status: 200,
      location: null,
      robotsHeader: null,
      metadata: {
        title: "Harbor restoration",
        canonical: [canonical],
        description: ["The harbor reopened after restoration."],
        publishedTime: [published],
        articleTimes: ["2017-08-14"],
        robots: [],
        refresh: [],
        structuredData: [{ "@type": "NewsArticle", datePublished: published }],
      },
      error: null,
    });

    const unavailable = ["/posts/missing/", "/posts/private/", "/posts/withdrawn/", "/page/2/"];
    const changed = await compare(alias, path, ...unavailable).catch((error: unknown) => error);
    expect(changed).toMatchObject({ code: 1, stderr: "" });
    if (!(changed instanceof Error) || !("stdout" in changed) || typeof changed.stdout !== "string") {
      throw new Error("Expected a route difference report");
    }
    const [aliasRow, canonicalRow, ...unavailableRows] = changed.stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(aliasRow).toMatchObject({
      path: alias,
      before: { status: 410, location: null, metadata: null },
      after: { status: 301, location: canonicalRow.path, metadata: null },
      differences: ["status", "location", "robotsHeader"],
    });
    expect(canonicalRow).toMatchObject({ path, after: { status: 200, location: null }, differences: [] });
    expect(unavailableRows).toEqual(unavailable.map((route, index) => {
      const observation = { status: index < 2 ? 404 : 410, location: null, robotsHeader: "noindex", metadata: null, error: null };
      return { path: route, before: observation, after: observation, differences: [] };
    }));
  } finally {
    await Promise.all([before.server[Symbol.asyncDispose](), after.server[Symbol.asyncDispose]()]);
  }
});
