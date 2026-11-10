import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import recovery from "../../functions/lib/no-build-post-recovery.js";
import { publicationTarget } from "../../functions/lib/publication-target";

it("awaits the existing background tag purge acknowledgment and refuses failed purges", async () => {
  let status = 200;
  const requests: { url: string; body: unknown }[] = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    requests.push({ url: req.url!, body: JSON.parse(body) });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: status === 200 }));
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const fetchPurge = (url: string, options: RequestInit) => fetch(`http://127.0.0.1:${port}${new URL(url).pathname}`, options);
  const options = { target: publicationTarget("production"), fetchPurge,
    purgeConfig: { zoneId: "a".repeat(32), token: "synthetic-purge-token" } };
  try {
    await recovery.purgePublicHome(options);
    expect(requests).toEqual([{ url: `/client/v4/zones/${"a".repeat(32)}/purge_cache`, body: { tags: ["njpbs-post-background"] } }]);
    status = 403;
    await expect(recovery.purgePublicHome(options)).rejects.toThrow("Post purge failed");
    await expect(recovery.purgePublicHome({ ...options, purgeConfig: {} })).rejects.toThrow("Public purge configuration is unavailable");
    await recovery.purgePublicHome({ ...options, target: publicationTarget("development") });
    expect(requests).toHaveLength(2);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
