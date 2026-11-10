// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createRequire } from "node:module";
import { createServer, type ViteDevServer } from "vite";

const { createAdminStatusManifest, encodeAdminStatusManifest } = createRequire(import.meta.url)("../../scripts/admin-status-manifest.mjs");

const adminRoot = process.cwd();
let server: ViteDevServer;
let origin: string;
let priorManifest: string | undefined;

beforeAll(async () => {
  priorManifest = process.env.ADMIN_STATUS_MANIFEST_BASE64;
  delete process.env.ADMIN_STATUS_MANIFEST_BASE64;
  server = await createServer({
    root: adminRoot,
    configFile: path.join(adminRoot, "vite.config.ts"),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Vite did not bind a test port.");
  origin = `http://127.0.0.1:${address.port}`;
}, 30_000);

afterAll(async () => {
  await server?.close();
  if (priorManifest === undefined) delete process.env.ADMIN_STATUS_MANIFEST_BASE64;
  else process.env.ADMIN_STATUS_MANIFEST_BASE64 = priorManifest;
});

describe("Admin status development asset", () => {
  it("serves the explicit unavailable contract instead of a failed SPA fallback", async () => {
    const response = await fetch(`${origin}/admin-status.json`, {
      headers: { Accept: "application/json" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      schemaVersion: 2,
      status: "unavailable",
      environment: "Local",
      build: null,
      milestone: null,
      milestones: null,
    });
  });
});


describe("Admin status development privacy", () => {
  it("does not serve private milestones without the Pages admission service", async () => {
    process.env.ADMIN_STATUS_MANIFEST_BASE64 = encodeAdminStatusManifest(createAdminStatusManifest({
      environment: "Production",
      generatedAt: "2026-08-17T18:00:00.000Z",
      repository: "CenterCoopMedia/njpbs",
      revision: "d805028221a24448055bf0adcce344d1921547b7",
      milestones: [{
        number: 16, title: "Private dev fixture", state: "open", open_issues: 7, closed_issues: 30,
        updated_at: "2026-08-17T17:30:00Z", html_url: "https://github.com/CenterCoopMedia/njpbs/milestone/16",
      }],
    }));
    try {
      for (const assetPath of ["/admin-status.json", "/guide-content/admin-status.json"]) {
        const response = await fetch(`${origin}${assetPath}`, { headers: { Authorization: "Bearer staff.token" } });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.milestone).toBeNull();
        expect(body.milestones).toBeNull();
        expect(JSON.stringify(body)).not.toContain("Private dev fixture");
        if (assetPath.startsWith("/guide-content/")) expect(body.status).toBe("unavailable");
      }
    } finally {
      delete process.env.ADMIN_STATUS_MANIFEST_BASE64;
    }
  });
});
