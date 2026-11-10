// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { build, loadConfigFromFile } from "vite";
import { onRequest } from "../functions/_middleware";
import { fetchAdminStatus, parseAdminStatusManifest } from "../src/lib/admin-status";

const { createAdminStatusManifest } = createRequire(import.meta.url)("../../scripts/admin-status-manifest.mjs");
const { parseProductionAdminRevision } = createRequire(import.meta.url)("../../functions/lib/admin-status-revision.js");
const revision = "d805028221a24448055bf0adcce344d1921547b7";
const privateTitle = "Private milestone catalog fixture";
const manifest = createAdminStatusManifest({
  environment: "Production",
  generatedAt: "2026-08-17T18:00:00.000Z",
  repository: "CenterCoopMedia/njpbs",
  revision,
  milestones: [{
    number: 16,
    title: privateTitle,
    state: "open",
    open_issues: 7,
    closed_issues: 30,
    updated_at: "2026-08-17T17:30:00Z",
    html_url: "https://github.com/CenterCoopMedia/njpbs/milestone/16",
  }],
});
let directory: string;

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), "admin-status-privacy-"));
  const entry = path.join(directory, "entry.js");
  writeFileSync(entry, "export {};\n");
  const previous = process.env.ADMIN_STATUS_MANIFEST_BASE64;
  process.env.ADMIN_STATUS_MANIFEST_BASE64 = Buffer.from(JSON.stringify(manifest)).toString("base64");
  try {
    const loaded = await loadConfigFromFile(
      { command: "build", mode: "production" },
      path.resolve("vite.config.ts"),
    );
    const plugins = loaded?.config.plugins?.flat();
    const statusPlugin = plugins?.find(plugin => plugin && "name" in plugin && plugin.name === "admin-status-manifest");
    if (!statusPlugin) throw new Error("Admin status asset owner is absent.");
    // Build only the manifest owner with an empty entry, without the Admin application.
    await build({
      configFile: false,
      root: directory,
      publicDir: false,
      logLevel: "silent",
      plugins: [statusPlugin],
      build: { outDir: "dist", rolldownOptions: { input: entry } },
    });
  } finally {
    if (previous === undefined) delete process.env.ADMIN_STATUS_MANIFEST_BASE64;
    else process.env.ADMIN_STATUS_MANIFEST_BASE64 = previous;
  }
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

async function requestAsset(host: string, assetPath: string, method = "GET", token?: string, access = 204) {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  const request = new Request(`https://${host}${assetPath}`, { method, headers });
  const assetService = {
    async fetch(assetRequest: Request) {
      const pathname = new URL(assetRequest.url).pathname;
      try {
        const body = readFileSync(path.join(directory, "dist", pathname));
        return new Response(assetRequest.method === "HEAD" ? null : body, {
          headers: { "content-type": "application/json" },
        });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },
  };
  return onRequest({
    request,
    env: {
      ASSETS: assetService,
      STAFF_ACCESS: { validateAccess: async () => access },
    },
    next: () => assetService.fetch(request),
  });
}

describe("Admin milestone privacy at the artifact and HTTP boundaries", () => {
  it("publishes the revision receipt without any private milestone fields", async () => {
    const response = await requestAsset("admin.njpbs.org", "/admin-status.json");
    expect(response.status).toBe(200);
    const receipt = await response.json();
    expect(parseProductionAdminRevision(receipt)).toBe(revision);
    expect(receipt).toEqual({
      schemaVersion: 2,
      status: "current",
      environment: "Production",
      generatedAt: "2026-08-17T18:00:00.000Z",
      refreshAfter: "2026-08-20T18:00:00.000Z",
      build: { revision, builtAt: "2026-08-17T18:00:00.000Z" },
      milestone: null,
      milestones: null,
    });
  });

  it.each(["admin.njpbs.org", "njpbs-admin.pages.dev"])("protects the complete catalog on %s", async host => {
    for (const method of ["GET", "HEAD"]) {
      const signedOut = await requestAsset(host, "/guide-content/admin-status.json", method);
      expect(signedOut.status).toBe(401);
      expect(await signedOut.text()).not.toContain(privateTitle);
      for (const access of [401, 403, 429, 503]) {
        const denied = await requestAsset(host, "/guide-content/admin-status.json", method, "staff.token", access);
        expect(denied.status).toBe(access);
        expect(await denied.text()).not.toContain(privateTitle);
      }
      const admitted = await requestAsset(host, "/guide-content/admin-status.json", method, "staff.token");
      expect(admitted.status).toBe(200);
      expect(admitted.headers.get("cache-control")).toBe("private, no-store");
      if (method === "HEAD") expect(await admitted.text()).toBe("");
      else expect(parseAdminStatusManifest(await admitted.json())).toEqual(manifest);
    }
  });

  it("loads the complete signed-in manifest in one authenticated network request", async () => {
    let requests = 0;
    const fetcher: typeof fetch = async (input, init) => {
      requests += 1;
      const authorization = new Headers(init?.headers).get("authorization");
      const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
      return requestAsset("admin.njpbs.org", String(input), init?.method, token);
    };
    expect(await fetchAdminStatus("staff.token", fetcher)).toEqual(manifest);
    expect(requests).toBe(1);
  });

  it.each([
    "/guide-content//admin-status.json",
    "/%67uide-content/admin-status.json",
    "/guide-content%2fadmin-status.json",
    "/guide-content/%61dmin-status.json",
  ])("does not expose the catalog through the alias %s", async assetPath => {
    expect((await requestAsset("admin.njpbs.org", assetPath)).status).toBe(401);
    expect((await requestAsset("admin.njpbs.org", assetPath, "GET", "staff.token")).status).toBe(404);
  });
});
